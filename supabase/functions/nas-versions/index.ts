// nas-versions: NAS 파일명 리비전(_reN, old/)을 차시의 버전 목록으로 인식
//  - versions {lesson_id}          → [{v,name,path,rev}] + lessons.review_ver 동기화
//  - stream   {lesson_id, path}    → 해당 리비전 파일의 서명 스트리밍 URL(nas-proxy GET ?s= 재사용)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SR_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON   = Deno.env.get("SUPABASE_ANON_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const J = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const enc = new TextEncoder();
function b64url(bytes: Uint8Array): string {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmacKey() {
  return await crypto.subtle.importKey("raw", enc.encode(SR_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signToken(obj: Record<string, unknown>): Promise<string> {
  const p = b64url(enc.encode(JSON.stringify(obj)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(p)));
  return p + "." + b64url(sig);
}
async function userFromReq(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u?.id || null;
}
const prefixFor = (id: number) => (id > 1 ? ("nas" + id + ":") : "");
function resolveRef(path: string): { id: number; p: string } {
  const m = String(path || "").match(/^nas(\d+):(.*)$/);
  return m ? { id: parseInt(m[1]), p: m[2] } : { id: 1, p: String(path || "") };
}
function isAllowed(cfg: any, p: string): boolean {
  const a = String(cfg?.allowed_prefixes || "").split(",").map((s: string) => s.trim()).filter(Boolean);
  if (!a.length) return true;
  return a.some((x: string) => p === x || p.startsWith(x));
}
async function getCfgById(id: number) {
  const sr = createClient(SB_URL, SR_KEY);
  const { data } = await sr.from("nas_config").select("*").eq("id", id).single();
  return data || null;
}
async function synoLogin(cfg: any): Promise<{ url: string; sid: string }> {
  const url = (cfg.url || "").replace(/\/$/, "");
  if (!url || !cfg.username) throw new Error("NAS 설정이 비어 있습니다.");
  const u = encodeURIComponent(cfg.username), p = encodeURIComponent(cfg.password || "");
  const r = await fetch(`${url}/webapi/auth.cgi?api=SYNO.API.Auth&version=6&method=login&account=${u}&passwd=${p}&session=FileStation&format=sid`);
  const j = await r.json().catch(() => ({ success: false }));
  if (!j.success) throw new Error("NAS 로그인 실패 (code " + (j.error?.code ?? "?") + ")");
  return { url, sid: j.data.sid as string };
}
async function synoLogout(url: string, sid: string) {
  try { await fetch(`${url}/webapi/auth.cgi?api=SYNO.API.Auth&version=6&method=logout&session=FileStation&_sid=${sid}`); } catch { /* */ }
}
const VIDEO_EXT = [".mp4", ".mov", ".m4v", ".mkv", ".avi", ".wmv", ".webm"];
async function synoList(url: string, sid: string, path: string) {
  const r = await fetch(`${url}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list&folder_path=${encodeURIComponent(JSON.stringify(path))}&_sid=${sid}`);
  return await r.json().catch(() => ({ success: false }));
}
async function listVideos(url: string, sid: string, folder: string, depth: number): Promise<{ name: string; path: string }[]> {
  const out: { name: string; path: string }[] = [];
  const j = await synoList(url, sid, folder);
  for (const f of (j?.data?.files || [])) {
    if (f.isdir) { if (depth > 0 && f.name !== "#recycle" && !/^\.cdms_/i.test(f.name)) out.push(...await listVideos(url, sid, f.path, depth - 1)); }
    else { const i = f.name.lastIndexOf("."); const ext = (i >= 0 ? f.name.slice(i) : "").toLowerCase(); if (VIDEO_EXT.includes(ext)) out.push({ name: f.name, path: f.path }); }
  }
  return out;
}

async function listFilesT(url: string, sid: string, folder: string, depth: number): Promise<{ name: string; path: string; crtime: number; mtime: number }[]> {
  const out: { name: string; path: string; crtime: number; mtime: number }[] = [];
  const r = await fetch(`${url}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list&folder_path=${encodeURIComponent(JSON.stringify(folder))}&additional=%5B%22time%22%5D&_sid=${sid}`);
  const j = await r.json().catch(() => ({ success: false }));
  for (const f of (j?.data?.files || [])) {
    if (/#recycle|^old$|^\.cdms_/i.test(f.name)) continue;
    if (f.isdir) { if (depth > 0 && !/^old$/i.test(f.name)) out.push(...await listFilesT(url, sid, f.path, depth - 1)); }
    else out.push({ name: f.name, path: f.path, crtime: f.additional?.time?.crtime || 0, mtime: f.additional?.time?.mtime || 0 });
  }
  return out;
}
const dlUrl = (url: string, sid: string, path: string) => `${url}/webapi/entry.cgi?api=SYNO.FileStation.Download&version=2&method=download&mode=open&path=${encodeURIComponent(path)}&_sid=${sid}`;
async function readRange(u: string, start: number, len: number) {
  const r = await fetch(u, { headers: { Range: `bytes=${start}-${start + len - 1}` } });
  if (!r.ok && r.status !== 206) { try { await r.body?.cancel(); } catch { /* */ } return null; }
  let total: number | null = null;
  const cr = r.headers.get("content-range");
  if (cr && cr.includes("/")) total = parseInt(cr.split("/")[1]) || null;
  if (r.status === 200) { const cl = parseInt(r.headers.get("content-length") || "0"); if (cl) total = cl; }
  const reader = r.body!.getReader();
  const chunks: Uint8Array[] = []; let got = 0;
  while (got < len) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; if (r.status === 200 && got >= len) break; }
  try { await reader.cancel(); } catch { /* */ }
  const buf = new Uint8Array(Math.min(got, len));
  let o = 0; for (const c of chunks) { const take = Math.min(c.length, buf.length - o); if (take <= 0) break; buf.set(c.subarray(0, take), o); o += take; }
  if (r.status === 200 && start > 0) return null;
  return { buf, total };
}
const u32 = (b: Uint8Array, i: number) => (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0;
const u64b = (b: Uint8Array, i: number) => u32(b, i) * 4294967296 + u32(b, i + 4);
const fourcc = (b: Uint8Array, i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
function mvhdIn(buf: Uint8Array): number | null {
  for (let i = 0; i + 36 < buf.length; i++) {
    if (buf[i] === 0x6d && buf[i + 1] === 0x76 && buf[i + 2] === 0x68 && buf[i + 3] === 0x64) {
      const ver = buf[i + 4];
      if (ver === 0) { const ts = u32(buf, i + 16), du = u32(buf, i + 20); if (ts > 0 && du > 0) return Math.round(du / ts); }
      else if (ver === 1) { const ts = u32(buf, i + 24), du = u64b(buf, i + 28); if (ts > 0 && du > 0) return Math.round(du / ts); }
    }
  }
  return null;
}
async function mp4Duration(u: string): Promise<number | null> {
  try {
    const head = await readRange(u, 0, 262144);
    if (!head || head.buf.length < 16) return null;
    const d0 = mvhdIn(head.buf); if (d0 != null) return d0;
    let off = 0; const total = head.total;
    for (let it = 0; it < 12; it++) {
      let hdr: Uint8Array;
      if (off + 16 <= head.buf.length) hdr = head.buf.subarray(off, off + 16);
      else { const r = await readRange(u, off, 16); if (!r || r.buf.length < 8) return null; hdr = r.buf; }
      let size = u32(hdr, 0); const type = fourcc(hdr, 4);
      if (size === 1) size = u64b(hdr, 8);
      if (type === "moov") { const r = await readRange(u, off, Math.min(size, 524288)); return r ? mvhdIn(r.buf) : null; }
      if (!size || size < 8) return null;
      off += size;
      if (total && off >= total) return null;
    }
    return null;
  } catch { return null; }
}

// ---- nas-proxy와 동일한 차시 매칭 (모든 리비전 반환) ----
const RE_L = /(\d+)\s*차\s*시/, RE_W = /(\d+)\s*주\s*차?/, RE_G = /(\d+)\s*강/;
const RE_EW = /week[\s_]*0*(\d+)/i, RE_DASH = /(?<![0-9])0*(\d{1,2})\s*-\s*0*(\d{1,2})(?![0-9.])/;
const STOPW = ["이해", "활용", "기초", "이러닝", "과정", "이해와", "종편", "저용량", "원본"];
const stripName = (name: string) => name.replace(/\.[A-Za-z0-9]+$/, "").replace(/(?<![A-Za-z])re\s*\d+/gi, "").replace(/v\d+(\.\d+)*/gi, "").replace(/\(\d+\)/g, "");
const revOf = (n: string) => { const m = n.match(/re\s*(\d+)/i); return m ? parseInt(m[1]) : 0; };
function candsFor(vids: { name: string; path: string }[], lessonNo: number, weekNo: number | null, projName: string) {
  const tokens = String(projName || "").replace(/[\[\]()_\-.,:·]/g, " ").split(/\s+/).filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOPW.includes(t));
  let pool = vids;
  if (tokens.length) {
    const scored = vids.map((v) => ({ v, s: tokens.reduce((a, t) => a + (v.name.includes(t) ? 1 : 0), 0) }));
    const mx = Math.max(...scored.map((x) => x.s), 0);
    if (mx > 0) pool = scored.filter((x) => x.s === mx).map((x) => x.v);
  }
  const codesOf = (name: string) => [...stripName(name).matchAll(/(?<![0-9])(\d{4})(?![0-9])/g)].map((m) => m[1]);
  const trailNum = (name: string) => [...stripName(name).matchAll(/(?<![0-9])0*(\d{1,2})(?![0-9])/g)].map((m) => parseInt(m[1]));
  let cands = pool.filter((f) => { const m = f.name.match(RE_L); return m && parseInt(m[1]) === lessonNo; });
  if (!cands.length) cands = pool.filter((f) => { const m = f.name.match(RE_G); return m && parseInt(m[1]) === lessonNo; });
  if (!cands.length) cands = pool.filter((f) => { const m = f.name.match(RE_W); return m && parseInt(m[1]) === lessonNo; });
  if (!cands.length) cands = pool.filter((f) => { const bn = stripName(f.name); const m = bn.match(RE_EW) || bn.match(RE_DASH); return m && parseInt(m[1]) === lessonNo; });
  if (!cands.length) {
    cands = pool.filter((f) => codesOf(f.name).some((c) => parseInt(c.slice(0, 2)) === lessonNo));
    if (cands.length) {
      const pa = (n: string) => Math.min(...codesOf(n).filter((c) => parseInt(c.slice(0, 2)) === lessonNo).map(Number));
      const mn = Math.min(...cands.map((f) => pa(f.name)));
      cands = cands.filter((f) => pa(f.name) === mn); // 같은 차시의 파트1만 (파트≠버전)
    }
  }
  if (!cands.length) cands = pool.filter((f) => trailNum(f.name).includes(lessonNo));
  if (!cands.length && pool.length === 1) cands = pool.slice();
  return cands;
}

const SCAN_BUDGET_MS = 110000;
async function scanProject(sr: any, prj: any, doRevert = false): Promise<{ marked: number; revised: number; reverted: number }> {
    const ref = resolveRef(prj.nas_root);
    const cfg = await getCfgById(ref.id);
    if (!cfg) throw new Error("NAS 설정 없음");
    if (!isAllowed(cfg, ref.p)) throw new Error("허용되지 않은 NAS 경로");
    const STAGE_PAT: Record<number, RegExp> = { 1: /원고(?!.*교안)/, 2: /촬영(?!.*교안)/, 3: /가편/, 4: /속기|스크립트/, 5: /스토리보드|보드|SB/i, 6: /디자인/, 7: /종편/, 8: /검수/, 9: /학습자료/, 10: /SRT|자막/i, 11: /음성/, 13: /번역/, 14: /촬영교안|교안/ };
    const REV_PAT = /수정|재편집|(?<![A-Za-z])re\s*\d|_re(?![A-Za-z])|v\d+\.\d+/i;
    const { data: pst } = await sr.from("project_stages").select("stage_id").eq("project_id", prj.id).eq("enabled", true);
    const enabled = new Set((pst || []).map((r: any) => r.stage_id));
    const { data: lessons } = await sr.from("lessons").select("id,lesson_no,review_status,week:weeks(week_no)").eq("project_id", prj.id);
    // (2026-07-18) 삭제 반영: 수동 동기화(doRevert) 시, 폴더를 실제로 훑었는데 파일이 없는 자동표기 셀은 wait로 비움
    const lidAll = (lessons || []).map((l: any) => l.id);
    const { data: curLS } = lidAll.length ? await sr.from("lesson_stage").select("lesson_id,stage_id,file_name").in("lesson_id", lidAll) : { data: [] as any[] };
    const scannedStages = new Set<number>(); const matchedKeys = new Set<string>();
    const hasWeeks = (lessons || []).some((l: any) => l.week && l.week.week_no != null);
    const matchLesson = (name: string, path: string): any => {
      const codes = [...name.replace(/\.[A-Za-z0-9]+$/, "").matchAll(/(?<![0-9])(\d{4})(?![0-9])/g)].map((m) => parseInt(m[1].slice(0, 2)));
      const mw = name.match(RE_W); const mc = name.match(RE_L);
      const base = name.replace(/\.[A-Za-z0-9]+$/, "").replace(/v\d+(\.\d+)*/gi, "");
      const mEng = base.match(RE_EW); const mDash = base.match(RE_DASH);
      const wNo = mw ? parseInt(mw[1]) : (mEng ? parseInt(mEng[1]) : (mDash ? parseInt(mDash[1]) : null));
      const ls = lessons || [];
      if (wNo != null && mc) {
        const c = parseInt(mc[1]);
        if (hasWeeks) { const hit = ls.find((l: any) => l.week?.week_no === wNo && l.lesson_no === c); if (hit) return hit; }
        const hit2 = ls.find((l: any) => l.lesson_no === wNo); if (hit2) return hit2; // 차시형: 주차=차시번호(클립=차시)
      }
      if (wNo != null && !mc) { const hit = ls.find((l: any) => l.lesson_no === wNo); if (hit && !hasWeeks) return hit; }
      if (mc) { const hit = ls.find((l: any) => l.lesson_no === parseInt(mc[1])); if (hit) return hit; }
      for (const l of ls) {
        if (codes.includes((l as any).lesson_no)) return l;
        if (new RegExp("/0*" + (l as any).lesson_no + "\\s*차\\s*시(/|$)").test(path)) return l;
      }
      // 폴백: 파일명 밑줄/구분 사이 1~2자리 번호(_01_ 등)를 차시번호로 (버전 vN.N 제거 후, 마지막 번호 우선)
      const nums = [...name.replace(/\.[A-Za-z0-9]+$/, "").replace(/v\d+(\.\d+)*/gi, "").matchAll(/(?<![0-9])0*(\d{1,2})(?![0-9])/g)].map((m) => parseInt(m[1]));
      for (let k = nums.length - 1; k >= 0; k--) { const hit = ls.find((l: any) => (l as any).lesson_no === nums[k]); if (hit) return hit; }
      // 단일 차시 과정: 파일명에 번호가 없어도 그 차시로 매칭
      if (ls.length === 1) return ls[0];
      return null;
    };
    let sess: { url: string; sid: string } | null = null;
    try {
      sess = await synoLogin(cfg);
      const listDirs = async (path: string) => {
        const rl = await fetch(`${sess!.url}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list&folder_path=${encodeURIComponent(JSON.stringify(path))}&_sid=${sess!.sid}`).then((r) => r.json()).catch(() => ({}));
        return ((rl as any)?.data?.files || []).filter((f: any) => f.isdir && !/#recycle|^old$|^\.cdms_/i.test(f.name));
      };
      const stageDirCount = (ds: any[]) => Object.values(STAGE_PAT).filter((pat) => ds.some((d: any) => pat.test(d.name))).length;
      let scanBase = ref.p; let dirs = await listDirs(scanBase);
      for (let up = 0; up < 3 && stageDirCount(dirs) < 2; up++) {
        const parent = scanBase.replace(/\/[^/]+$/, "");
        if (!parent || parent === scanBase || !isAllowed(cfg, parent)) break;
        const pd = await listDirs(parent);
        if (stageDirCount(pd) >= 2) { scanBase = parent; dirs = pd; break; }
        scanBase = parent; dirs = pd;
      }
      // 과정명 토큰 (상위 공용 폴더 스캔 시 다른 과정 파일 배제용)
      const matchName = String(prj.name || "") + " " + String((prj as any).nas_alias || ""); // 과정명+별칭(개명 전 이름)
      const tks = matchName.replace(/[\[\]()_\-.,:·]/g, " ").split(/\s+/).filter((t: string) => t.length >= 2 && !/^\d+$/.test(t) && !STOPW.includes(t));
      let marked = 0, revised = 0;
      for (const [sidNum, pat] of Object.entries(STAGE_PAT)) {
        const stageId = parseInt(sidNum);
        if (!enabled.has(stageId)) continue;
        if (stageId === 7) continue; // 종편은 아래 통합 블록(최종영상=길이=상태 단일 소스)에서 처리
        const dir = dirs.find((d: any) => pat.test(d.name));
        if (!dir) continue;
        scannedStages.add(stageId);
        let files = (await listFilesT(sess.url, sess.sid, dir.path, 2)).filter((f) => !/^~\$|\.db$|\.tmp$/i.test(f.name));
        if (tks.length) {
          const scored = files.map((f) => ({ f, sc: tks.reduce((a: number, t: string) => a + (f.name.includes(t) || f.path.includes(t) ? 1 : 0), 0) }));
          const mx = Math.max(...scored.map((x) => x.sc), 0);
          if (mx > 0) files = scored.filter((x) => x.sc === mx).map((x) => x.f);
        }
        const byLesson = new Map<string, { name: string; path: string; crtime: number; rev: boolean }[]>();
        for (const f of files) {
          const l = matchLesson(f.name, f.path);
          if (!l) continue;
          const a = byLesson.get((l as any).id) || [];
          a.push({ name: f.name, path: f.path, crtime: f.crtime || f.mtime || 0, rev: REV_PAT.test(f.name) });
          byLesson.set((l as any).id, a);
          matchedKeys.add((l as any).id + "|" + stageId);
        }
        if (byLesson.size) { // 새 단계(예: 촬영교안)처럼 lesson_stage 행이 아직 없으면 먼저 생성 (있으면 무시)
          const seed = [...byLesson.keys()].map((lid) => ({ lesson_id: lid, stage_id: stageId, status: "wait" }));
          await sr.from("lesson_stage").upsert(seed, { onConflict: "lesson_id,stage_id", ignoreDuplicates: true });
        }
        for (const [lid, arr] of byLesson) {
          arr.sort((a, b) => a.crtime - b.crtime);
          const first = arr[0]; const last = arr[arr.length - 1];
          const revArr = arr.filter((x) => x.rev);
          let newStatus = "done";
          if (stageId === 5) newStatus = "review";
          const upd: Record<string, unknown> = { status: newStatus, file_name: last.name, file_mtime: first.crtime ? new Date(first.crtime * 1000).toISOString() : null, revised_at: null, revised_name: null };
          if (revArr.length) {
            const rl = revArr[revArr.length - 1];
            if (rl.crtime > first.crtime + 3600 || arr.some((x) => !x.rev)) { upd.revised_at = new Date(rl.crtime * 1000).toISOString(); upd.revised_name = rl.name; revised++; }
          }
          let q = sr.from("lesson_stage").update(upd).eq("lesson_id", lid).eq("stage_id", stageId);
          if (stageId === 5 && newStatus !== "done") q = q.neq("status", "done");
          const { error } = await q;
          if (!error) marked++;
        }
      }
      // ── 종편(7) 통합: "최종영상 존재 ⟺ 영상길이 ⟺ 종편단계 상태"를 단일 소스로 정합 ──
      if (enabled.has(7)) {
        const dir7 = dirs.find((d: any) => STAGE_PAT[7].test(d.name));
        let src: { name: string; path: string; crtime: number; mtime: number }[] = [];
        if (dir7) {
          src = await listFilesT(sess.url, sess.sid, dir7.path, 2);
        } else {
          // 종편 폴더가 없으면(예: DGIST·영남대 단일폴더 과정) 이 과정 폴더(ref.p)만 스캔 — 사업 전체를 훑지 않도록
          const rootDirs = await listDirs(ref.p);
          const otherStageDirs = rootDirs.filter((d: any) => Object.entries(STAGE_PAT).some(([sid, pat]: any) => sid !== "7" && (pat as RegExp).test(d.name))).map((d: any) => d.path);
          src = (await listFilesT(sess.url, sess.sid, ref.p, 3)).filter((f) => !otherStageDirs.some((sf: string) => f.path.startsWith(sf + "/")));
        }
        let f7 = src.filter((f) => /\.(mp4|mov|m4v)$/i.test(f.name) && !/^~\$|\.db$|\.tmp$|저용량|포팅|h\.?265|프록시|proxy|intro|인트로|아웃트로|샘플|제안|가편/i.test(f.name));
        if (tks.length) { const sc = f7.map((f) => ({ f, s: tks.reduce((a: number, t: string) => a + (f.name.includes(t) || f.path.includes(t) ? 1 : 0), 0) })); const mx = Math.max(...sc.map((x) => x.s), 0); if (mx > 0) f7 = sc.filter((x) => x.s === mx).map((x) => x.f); }
        scannedStages.add(7);
        const grp = new Map<string, { name: string; path: string; crtime: number; rev: boolean }[]>();
        for (const f of f7) { const l = matchLesson(f.name, f.path); if (!l) continue; const lid = (l as any).id; const a = grp.get(lid) || []; a.push({ name: f.name, path: f.path, crtime: f.crtime || f.mtime || 0, rev: REV_PAT.test(f.name) }); grp.set(lid, a); matchedKeys.add(lid + "|7"); }
        const { data: curLes } = await sr.from("lessons").select("id,duration_sec,review_status,duration_files").eq("project_id", prj.id);
        const durMap: Record<string, number | null> = {}; const rsMap: Record<string, string> = {}; const dfMap: Record<string, number | null> = {};
        (curLes || []).forEach((x: any) => { durMap[x.id] = x.duration_sec; rsMap[x.id] = x.review_status || "진행중"; dfMap[x.id] = x.duration_files; });
        for (const [lid, arr] of grp) {
          arr.sort((a, b) => a.crtime - b.crtime);
          const first = arr[0]; const last = arr[arr.length - 1];
          // 중복 제거: 같은 기본 이름(리비전·(수정)·최종 표기 제거)은 최신 1개만 — 학교공유 등 사본 폴더·수정본 중복 합산 방지
          const baseKey = (n: string) => stripName(n).replace(/\(수정\)|\s*수정본?|\s*최종/gi, "").replace(/\s+/g, "").toLowerCase();
          const bm = new Map<string, { name: string; path: string; crtime: number; rev: boolean }>();
          for (const x of arr) { const k = baseKey(x.name); const c = bm.get(k); if (!c || x.crtime > c.crtime) bm.set(k, x); }
          const uniq = [...bm.values()];
          // 길이 계산: 비어 있을 때 + 자동 측정 이력(duration_files)이 있고 파트 수가 달라졌을 때 재계산
          //  (파트 추가 후에도 예전 합계가 남던 문제 수정 — 디지스트 데이터사이언스 4차시, 2026-07-15)
          //  ※ duration_files가 null인데 길이가 있으면 수동 입력으로 간주하고 보존
          if (!durMap[lid] || (dfMap[lid] != null && dfMap[lid] !== uniq.length)) {
            let tot = 0, ok = false;
            for (const x of uniq.slice(0, 12)) { const d = await mp4Duration(dlUrl(sess.url, sess.sid, x.path)); if (d && d > 0 && d < 36000) { tot += d; ok = true; } }
            if (ok) await sr.from("lessons").update({ duration_sec: tot, duration_files: uniq.length }).eq("id", lid);
          }
          const rs = rsMap[lid] || "진행중";
          const newStatus = rs === "완료" ? "done" : (rs === "피드백필요" ? "fix" : "review");
          const revArr = arr.filter((x) => x.rev);
          const upd: Record<string, unknown> = { status: newStatus, file_name: last.name, file_mtime: first.crtime ? new Date(first.crtime * 1000).toISOString() : null, revised_at: null, revised_name: null };
          if (revArr.length) { const rl = revArr[revArr.length - 1]; if (rl.crtime > first.crtime + 3600 || arr.some((x) => !x.rev)) { upd.revised_at = new Date(rl.crtime * 1000).toISOString(); upd.revised_name = rl.name; revised++; } }
          let q = sr.from("lesson_stage").update(upd).eq("lesson_id", lid).eq("stage_id", 7);
          if (newStatus !== "done") q = q.neq("status", "done");
          const { error } = await q; if (!error) marked++;
        }
        // 루틴 스캔은 채우기 전용(monotonic): 종편 미매칭 차시의 상태/길이를 지우지 않음.
        // (NAS 목록 간헐 실패로 인한 status flip-flop 방지. 영상 삭제로 인한 정리는 수동 재동기화로 처리)
      }
      let reverted = 0;
      if (doRevert) {
        for (const r of (curLS || [])) {
          if (!r.file_name) continue;                                    // 수동 표기 셀 보호(자동표기만 비움)
          if (!scannedStages.has(r.stage_id)) continue;                  // 이번에 실제 훑은 단계만
          if (matchedKeys.has(r.lesson_id + "|" + r.stage_id)) continue; // 파일이 있으면 유지
          const { error } = await sr.from("lesson_stage").update({ status: "wait", file_name: null, file_mtime: null, revised_at: null, revised_name: null, updated_at: new Date().toISOString() }).eq("lesson_id", r.lesson_id).eq("stage_id", r.stage_id);
          if (!error) reverted++;
        }
      }
      return { marked, revised, reverted };
    } finally {
      if (sess) await synoLogout(sess.url, sess.sid);
    }
}

async function loadCtx(sr: any, uid: string, lessonId: string) {
  const { data: les } = await sr.from("lessons").select("id,project_id,lesson_no,week:weeks(week_no)").eq("id", lessonId).single();
  if (!les) return { err: J({ ok: false, error: "차시를 찾을 수 없음" }, 404) };
  const { data: prj } = await sr.from("projects").select("id,name,nas_alias,program_id,nas_root").eq("id", les.project_id).single();
  if (!prj?.nas_root) return { err: J({ ok: false, error: "이 과정에 NAS 폴더가 아직 없습니다." }, 400) };
  const [{ data: adm }, { data: pm }, { data: jm }] = await Promise.all([
    sr.from("user_roles").select("role_code").eq("user_id", uid).eq("role_code", "admin").limit(1),
    prj.program_id ? sr.from("program_members").select("user_id").eq("program_id", prj.program_id).eq("user_id", uid).limit(1) : Promise.resolve({ data: [] }),
    sr.from("project_members").select("user_id").eq("project_id", prj.id).eq("user_id", uid).limit(1),
  ]);
  const allowed = (adm && adm.length) || (pm && (pm as any).length) || (jm && jm.length);
  if (!allowed) return { err: J({ ok: false, error: "이 사업에 대한 접근 권한이 없습니다." }, 403) };
  return { les, prj };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const action = body.action || "versions";
  if (action === "scan_all") {
    const sr0 = createClient(SB_URL, SR_KEY);
    const { data: k } = await sr0.from("agent_secrets").select("value").eq("name", "nas_scan_cron_key").single();
    if (!k || !body.cron_key || body.cron_key !== k.value) return J({ ok: false, error: "forbidden" }, 403);
    // 동시 실행 방지 락: 다른 scan_all이 150초 내 실행 중이면 건너뜀 (status flip-flop 방지)
    const nowMs = Date.now();
    const { data: lk } = await sr0.from("agent_secrets").select("value").eq("name", "scan_all_lock").single();
    if (lk && lk.value && (nowMs - parseInt(lk.value || "0")) < 150000) return J({ ok: true, skipped: "another scan_all running" });
    await sr0.from("agent_secrets").upsert({ name: "scan_all_lock", value: String(nowMs) }, { onConflict: "name" });
    try {
      const { data: prjs } = await sr0.from("projects").select("id,name,nas_alias,nas_root").not("nas_root", "is", null).neq("nas_root", "").order("nas_scanned_at", { ascending: true, nullsFirst: true }).limit(25);
      const t0 = Date.now(); const results: any[] = [];
      for (const prj of (prjs || [])) {
        if (Date.now() - t0 > SCAN_BUDGET_MS) break;
        try { const r = await scanProject(sr0, prj); results.push({ p: prj.name, ...r }); }
        catch (e) { results.push({ p: prj.name, error: String((e as any)?.message || e) }); }
        await sr0.from("projects").update({ nas_scanned_at: new Date().toISOString() }).eq("id", prj.id);
      }
      return J({ ok: true, scanned: results.length, results });
    } finally {
      await sr0.from("agent_secrets").upsert({ name: "scan_all_lock", value: "0" }, { onConflict: "name" });
    }
  }

  const uid = await userFromReq(req);
  if (!uid) return J({ ok: false, error: "로그인이 필요합니다." }, 401);
  const sr = createClient(SB_URL, SR_KEY);

  if (action === "scan") {
    const { data: prj } = await sr.from("projects").select("id,name,nas_alias,program_id,nas_root").eq("id", body.project_id).single();
    if (!prj?.nas_root) return J({ ok: false, error: "이 과정에 NAS 폴더가 아직 없습니다." }, 400);
    const [{ data: adm }, { data: pm }, { data: jm }] = await Promise.all([
      sr.from("user_roles").select("role_code").eq("user_id", uid).eq("role_code", "admin").limit(1),
      prj.program_id ? sr.from("program_members").select("user_id").eq("program_id", prj.program_id).eq("user_id", uid).limit(1) : Promise.resolve({ data: [] }),
      sr.from("project_members").select("user_id").eq("project_id", prj.id).eq("user_id", uid).limit(1),
    ]);
    if (!((adm && adm.length) || (pm && (pm as any).length) || (jm && jm.length))) return J({ ok: false, error: "접근 권한이 없습니다." }, 403);
    try {
      const r = await scanProject(sr, prj, true);
      await sr.from("projects").update({ nas_scanned_at: new Date().toISOString() }).eq("id", prj.id);
      return J({ ok: true, project: prj.name, ...r });
    } catch (e) { return J({ ok: false, error: String((e as any)?.message || e) }, 500); }
  }

  const ctx = await loadCtx(sr, uid, body.lesson_id);
  if ((ctx as any).err) return (ctx as any).err;
  const { les, prj } = ctx as any;

  if (action === "stream") {
    const path = String(body.path || "");
    if (!path || !(path === prj.nas_root || path.startsWith(prj.nas_root + "/")))
      return J({ ok: false, error: "이 과정 폴더 밖의 파일은 재생할 수 없습니다." }, 403);
    const token = await signToken({ p: path, e: Date.now() + 2 * 3600 * 1000, u: uid });
    return J({ ok: true, url: `${SB_URL}/functions/v1/nas-proxy?s=${encodeURIComponent(token)}` });
  }

  if (action === "versions") {
    const ref = resolveRef(prj.nas_root);
    const cfg = await getCfgById(ref.id);
    if (!cfg) return J({ ok: false, error: "NAS 설정 없음(id " + ref.id + ")" }, 400);
    if (!isAllowed(cfg, ref.p)) return J({ ok: false, error: "허용되지 않은 NAS 경로입니다." }, 403);
    let sess: { url: string; sid: string } | null = null;
    try {
      sess = await synoLogin(cfg);
      const vids = (await listVideos(sess.url, sess.sid, ref.p, 3))
        .filter((f) => !/저용량|포팅|h\.?265|프록시|proxy/i.test(f.name));
      const lessonNo = (les as any).lesson_no as number;
      const weekNo = (les as any).week?.week_no ?? null;
      let cands = candsFor(vids, lessonNo, weekNo, String(prj.name || "") + " " + String((prj as any).nas_alias || ""));
      const seen = new Set<string>();
      cands = cands.filter((f) => { if (seen.has(f.path)) return false; seen.add(f.path); return true; });
      cands.sort((a, b) => (revOf(a.name) - revOf(b.name)) || (Number(/\/old\//i.test(b.path)) - Number(/\/old\//i.test(a.path))) || a.name.localeCompare(b.name));
      const versions = cands.map((f, i) => ({ v: i + 1, name: f.name, path: prefixFor(ref.id) + f.path, rev: revOf(f.name) }));
      if (versions.length) {
        const { data: cur } = await sr.from("lessons").select("review_ver").eq("id", les.id).single();
        if ((cur?.review_ver || 1) !== versions.length)
          await sr.from("lessons").update({ review_ver: versions.length }).eq("id", les.id);
      }
      return J({ ok: true, versions });
    } catch (e) {
      return J({ ok: false, error: String((e as any)?.message || e) }, 500);
    } finally {
      if (sess) await synoLogout(sess.url, sess.sid);
    }
  }
  if (action === "clips") {
    const ref = resolveRef(prj.nas_root);
    const cfg = await getCfgById(ref.id);
    if (!cfg) return J({ ok: false, error: "NAS 설정 없음(id " + ref.id + ")" }, 400);
    if (!isAllowed(cfg, ref.p)) return J({ ok: false, error: "허용되지 않은 NAS 경로입니다." }, 403);
    let sess: { url: string; sid: string } | null = null;
    try {
      sess = await synoLogin(cfg);
      const vidsAll = await listVideos(sess.url, sess.sid, ref.p, 3);
      const vids = vidsAll.filter((f) => !/저용량|포팅|h\.?265|프록시|proxy|intro|인트로|아웃트로|샘플|제안영상|속도조절/i.test(f.name) && !/\/old\//i.test(f.path));
      const lessonNo = (les as any).lesson_no as number;
      const tokens = (String(prj.name || "") + " " + String((prj as any).nas_alias || "")).replace(/[\[\]()_\-.,:·]/g, " ").split(/\s+/).filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOPW.includes(t));
      let pool = vids;
      if (tokens.length) {
        const scored = vids.map((v) => ({ v, s: tokens.reduce((a, t) => a + (v.name.includes(t) ? 1 : 0), 0) }));
        const mx = Math.max(...scored.map((x) => x.s), 0);
        if (mx > 0) pool = scored.filter((x) => x.s === mx).map((x) => x.v);
      }
      const codesOf2 = (name: string) => [...stripName(name).matchAll(/(?<![0-9])(\d{4})(?![0-9])/g)].map((m) => m[1]);
      const modOf = (n: string) => { const m = n.match(/수정\)?\s*(\d{4})/); return m ? m[1] : ""; };
      const pickBest = (arr: { name: string; path: string }[]) => arr.slice().sort((a, b) =>
        (Number(/종편/.test(b.path)) - Number(/종편/.test(a.path))) || (revOf(b.name) - revOf(a.name)) || modOf(b.name).localeCompare(modOf(a.name)) || a.name.localeCompare(b.name))[0];
      const parts = new Map<number, { name: string; path: string }[]>();
      const add = (p: number, f: { name: string; path: string }) => { const a = parts.get(p) || []; a.push(f); parts.set(p, a); };
      for (const f of pool) { const c = codesOf2(f.name).find((c) => parseInt(c.slice(0, 2)) === lessonNo); if (c) add(parseInt(c.slice(2)), f); }
      if (!parts.size) for (const f of pool) {
        const bn = f.name.replace(/\.[A-Za-z0-9]+$/, "").replace(/v\d+(\.\d+)*/gi, "");
        const mw = f.name.match(RE_W) || bn.match(RE_EW); const md = bn.match(RE_DASH);
        const w = mw ? parseInt(mw[1]) : (md ? parseInt(md[1]) : null);
        if (w === lessonNo) { const mc = f.name.match(RE_L); add(mc ? parseInt(mc[1]) : (md ? parseInt(md[2]) : 1), f); }
      }
      if (!parts.size) {
        const inFolder = (f: { path: string }) => new RegExp("/0*" + lessonNo + "\\s*차\\s*시(/|$)").test(f.path);
        const matched = pool.filter((f) => { const m = f.name.match(RE_L); return (m && parseInt(m[1]) === lessonNo) || inFolder(f); });
        matched.sort((a, b) => a.name.localeCompare(b.name, "ko"));
        let i = 1;
        for (const f of matched) { const m = f.name.match(/(?<!\d)\d{1,2}_(\d{1,2})(?!\d)/); add(m ? parseInt(m[1]) : (100 + i), f); i++; }
      }
      let clips = [...parts.entries()].map(([pt, arr]) => ({ part: pt, f: pickBest(arr) })).sort((a, b) => a.part - b.part).slice(0, 12);
      if (!clips.length) { const cands = candsFor(vids, lessonNo, (les as any).week?.week_no ?? null, String(prj.name || "") + " " + String((prj as any).nas_alias || "")); if (cands.length) clips = [{ part: 1, f: pickBest(cands) }]; }
      const out: any[] = [];
      for (const c of clips) {
        const dur = /\.(mp4|mov|m4v)$/i.test(c.f.name) ? await mp4Duration(dlUrl(sess.url, sess.sid, c.f.path)) : null;
        const token = await signToken({ p: prefixFor(ref.id) + c.f.path, e: Date.now() + 2 * 3600 * 1000, u: uid });
        out.push({ part: c.part, name: c.f.name, dur, url: `${SB_URL}/functions/v1/nas-proxy?s=${encodeURIComponent(token)}` });
      }
      return J({ ok: true, clips: out });
    } catch (e) {
      return J({ ok: false, error: String((e as any)?.message || e) }, 500);
    } finally {
      if (sess) await synoLogout(sess.url, sess.sid);
    }
  }
  return J({ ok: false, error: "unknown action" }, 400);
});
