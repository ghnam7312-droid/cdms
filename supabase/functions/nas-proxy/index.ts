import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SR_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON   = Deno.env.get("SUPABASE_ANON_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, range",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "content-length, content-range, accept-ranges",
};
const J = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const enc = new TextEncoder();
function b64url(bytes: Uint8Array): string {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
}
async function hmacKey() {
  return await crypto.subtle.importKey("raw", enc.encode(SR_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signToken(obj: Record<string, unknown>): Promise<string> {
  const p = b64url(enc.encode(JSON.stringify(obj)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(p)));
  return p + "." + b64url(sig);
}
async function verifyToken(tok: string): Promise<Record<string, unknown> | null> {
  const [p, s] = (tok || "").split("."); if (!p || !s) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(), unb64url(s), enc.encode(p));
  if (!ok) return null;
  try { const o = JSON.parse(new TextDecoder().decode(unb64url(p))); return (o.e && Date.now() < o.e) ? o : null; } catch { return null; }
}

// ===== 멀티 NAS + 경로 제한 =====
// nas_config 여러 행 지원. NAS 1은 경로 그대로, NAS n(≥2)은 "nasN:" 접두어 경로 사용.
// allowed_prefixes(쉼표 구분, 예 "/2026")가 설정된 NAS는 그 하위 경로만 접근 허용.
async function getCfgs() {
  const sr = createClient(SB_URL, SR_KEY);
  const { data } = await sr.from("nas_config").select("*").order("id");
  return data || [];
}
const prefixFor = (id: number) => (id > 1 ? ("nas" + id + ":") : "");
function resolveRef(path: string): { id: number; p: string } {
  const m = String(path || "").match(/^nas(\d+):(.*)$/);
  return m ? { id: parseInt(m[1]), p: m[2] } : { id: 1, p: String(path || "") };
}
function allowedOf(cfg: any): string[] {
  return String(cfg?.allowed_prefixes || "").split(",").map((s: string) => s.trim()).filter(Boolean);
}
function isAllowed(cfg: any, p: string): boolean {
  const a = allowedOf(cfg);
  if (!a.length) return true;
  return a.some((x) => p === x || p.startsWith(x));
}

async function synoLogin(cfg: any): Promise<{ url: string; sid: string }> {
  const url = (cfg.url || "").replace(/\/$/, "");
  if (!url || !cfg.username) throw new Error("NAS 설정(url/계정)이 비어 있습니다. 앱의 NAS 설정에서 저장하세요.");
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
    if (f.isdir) { if (depth > 0) out.push(...await listVideos(url, sid, f.path, depth - 1)); }
    else { const i = f.name.lastIndexOf("."); const ext = (i >= 0 ? f.name.slice(i) : "").toLowerCase(); if (VIDEO_EXT.includes(ext)) out.push({ name: f.name, path: f.path }); }
  }
  return out;
}
async function userFromReq(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u?.id || null;
}

// ── 쓰기 안전장치: 존재 확인 + 새 이름 생성(덮어쓰기 금지) ──
async function nameExists(url: string, sid: string, folder: string, name: string): Promise<boolean> {
  const j = await synoList(url, sid, folder);
  const files = (j?.data?.files || []);
  return files.some((f: any) => String(f.name).normalize() === String(name).normalize());
}
async function uniqueName(url: string, sid: string, folder: string, name: string): Promise<string> {
  if (!(await nameExists(url, sid, folder, name))) return name;
  const dot = name.lastIndexOf("."); const stem = dot > 0 ? name.slice(0, dot) : name; const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 1000; i++) { const c = `${stem} (${i})${ext}`; if (!(await nameExists(url, sid, folder, c))) return c; }
  return `${stem}_${Date.now()}${ext}`;
}

// ── 차시 매칭(파일↔차시) 헬퍼 ──
const RE_L2 = /(\d+)\s*차\s*시/, RE_W2 = /(\d+)\s*주\s*차?/, RE_EW2 = /week[\s_]*0*(\d+)/i, RE_DASH2 = /(?<![0-9])0*(\d{1,2})\s*-\s*0*(\d{1,2})(?![0-9.])/;
function stripName2(n: string) { return n.replace(/\.[A-Za-z0-9]+$/, "").replace(/re\s*\d+/gi, "").replace(/v\d+(\.\d+)*/gi, "").replace(/\(\d+\)/g, ""); }
function fileMatchesLesson(name: string, lessonNo: number, weekNo: number | null, total: number): boolean {
  const mc = name.match(RE_L2);
  const base = name.replace(/\.[A-Za-z0-9]+$/, "").replace(/v\d+(\.\d+)*/gi, "");
  const mw = name.match(RE_W2), meng = base.match(RE_EW2), md = base.match(RE_DASH2);
  const w = mw ? parseInt(mw[1]) : (meng ? parseInt(meng[1]) : (md ? parseInt(md[1]) : null));
  // 주차형 과정: 파일명에 주차가 명시돼 있으면 주차가 우선 — 다른 주차 파일은 차시 번호가 같아도 제외
  if (weekNo != null && w != null && w !== weekNo) return false;
  if (mc && parseInt(mc[1]) === lessonNo) return true;
  if (weekNo != null && w === weekNo && !mc) return true;
  if (weekNo == null && w === lessonNo && !mc) return true;
  const codes = [...stripName2(name).matchAll(/(?<![0-9])(\d{4})(?![0-9])/g)].map((m) => parseInt(m[1].slice(0, 2)));
  if (codes.includes(lessonNo)) return true;
  const nums = [...stripName2(name).matchAll(/(?<![0-9])0*(\d{1,2})(?![0-9])/g)].map((m) => parseInt(m[1]));
  if (nums.includes(lessonNo)) return true;
  if (!/\d/.test(stripName2(name))) return true; // 숫자 정보가 전혀 없는 공용 파일(폰트·로고·시안 등)은 항상 표시
  if (total === 1) return true;
  return false;
}
function lessonTag(lessonNo: number, weekNo: number | null): string {
  const nn = String(lessonNo).padStart(2, "0");
  return (weekNo != null) ? `${String(weekNo).padStart(2, "0")}주차_${nn}차시` : `${nn}차시`;
}
async function lessonCtx(sr: any, lessonId: string): Promise<{ no: number; wk: number | null; total: number } | null> {
  const { data: les } = await sr.from("lessons").select("lesson_no,project_id,week:weeks(week_no)").eq("id", lessonId).single();
  if (!les) return null;
  const { count } = await sr.from("lessons").select("id", { count: "exact", head: true }).eq("project_id", (les as any).project_id);
  return { no: (les as any).lesson_no, wk: (les as any).week?.week_no ?? null, total: count || 0 };
}

// ── 단계별 파일 조회/업로드 지원 ──
const STAGE_PAT_FILES: Record<number, RegExp> = { 1: /원고/, 2: /촬영/, 3: /가편/, 4: /속기|스크립트/, 5: /스토리보드|보드|SB/i, 6: /디자인/, 7: /종편/, 9: /학습자료/, 10: /SRT|자막/i, 13: /번역/, 14: /촬영교안|교안/, 99: /소스|에셋|asset|source/i };
async function projAccess(sr: any, uid: string, prj: any): Promise<boolean> {
  const [{ data: adm }, { data: pm }, { data: jm }] = await Promise.all([
    sr.from("user_roles").select("role_code").eq("user_id", uid).eq("role_code", "admin").limit(1),
    prj.program_id ? sr.from("program_members").select("user_id").eq("program_id", prj.program_id).eq("user_id", uid).limit(1) : Promise.resolve({ data: [] }),
    sr.from("project_members").select("user_id").eq("project_id", prj.id).eq("user_id", uid).limit(1),
  ]);
  return !!((adm && adm.length) || (pm && (pm as any).length) || (jm && jm.length));
}
async function listDirsP(url: string, sid: string, path: string) {
  const j = await synoList(url, sid, path);
  return (j?.data?.files || []).filter((f: any) => f.isdir && !/#recycle|^old$|^\.cdms_/i.test(f.name));
}
async function findScanBase(url: string, sid: string, cfg: any, startP: string) {
  const stageCount = (ds: any[]) => Object.values(STAGE_PAT_FILES).filter((p) => ds.some((d: any) => p.test(d.name))).length;
  let base = startP; let dirs = await listDirsP(url, sid, base);
  for (let up = 0; up < 3 && stageCount(dirs) < 2; up++) {
    const parent = base.replace(/\/[^/]+$/, "");
    if (!parent || parent === base || !isAllowed(cfg, parent)) break;
    const pd = await listDirsP(url, sid, parent);
    if (stageCount(pd) >= 2) { base = parent; dirs = pd; break; }
    base = parent; dirs = pd;
  }
  return { base, dirs };
}
async function listFilesMeta(url: string, sid: string, folder: string, depth: number): Promise<any[]> {
  const out: any[] = [];
  const r = await fetch(`${url}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list&limit=5000&folder_path=${encodeURIComponent(JSON.stringify(folder))}&additional=%5B%22size%22%2C%22time%22%5D&_sid=${sid}`);
  const j = await r.json().catch(() => ({}));
  for (const f of ((j as any)?.data?.files || [])) {
    if (/#recycle|^\.cdms_/i.test(f.name)) continue; // old·원본·최종 등 하위 폴더도 표시
    if (f.isdir) { if (depth > 0) out.push(...await listFilesMeta(url, sid, f.path, depth - 1)); }
    else out.push({ name: f.name, path: f.path, size: f.additional?.size || 0, mtime: f.additional?.time?.mtime || 0 });
  }
  return out;
}
// 파일 경로가 이 과정 사업폴더(예: /2026_03_xxx) 하위인지
function bizRootOf(p: string): string { const segs = p.split("/").filter(Boolean); return "/" + (segs[0] || ""); }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);

  // ===== GET ?s=token  → 서명 검증 후 NAS 원본으로 302 (멀티 NAS·경로 제한) =====
  if (req.method === "GET" && u.searchParams.has("s")) {
    const payload = await verifyToken(u.searchParams.get("s")!);
    if (!payload) return J({ ok: false, error: "링크가 만료되었거나 유효하지 않습니다." }, 403);
    const ref = resolveRef(String(payload.p || ""));
    try {
      const cfgs = await getCfgs();
      const cfg = cfgs.find((c: any) => c.id === ref.id);
      if (!cfg) return J({ ok: false, error: "NAS 설정 없음(id " + ref.id + ")" }, 400);
      if (!isAllowed(cfg, ref.p)) return J({ ok: false, error: "허용되지 않은 경로입니다." }, 403);
      const sess = await synoLogin(cfg);
      const dl = `${sess.url}/webapi/entry.cgi?api=SYNO.FileStation.Download&version=2&method=download&mode=open&path=${encodeURIComponent(ref.p)}&_sid=${sess.sid}`;
      return new Response(null, { status: 302, headers: { ...CORS, "Location": dl } });
    } catch (e) {
      return J({ ok: false, error: String((e as any)?.message || e) }, 502);
    }
  }

  // ===== POST actions (모두 로그인 사용자만) =====
  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const action = body.action || "ping";
  const uid = await userFromReq(req);
  if (!uid) return J({ ok: false, error: "로그인이 필요합니다." }, 401);
  const sr = createClient(SB_URL, SR_KEY);
  const cfgs = await getCfgs();
  const cfg1 = cfgs.find((c: any) => c.id === 1) || cfgs[0];

  // 검수영상 스트리밍 URL 발급 (권한 검사 후 단기 서명)
  if (action === "stream_url") {
    const lessonId = body.lesson_id;
    if (!lessonId) return J({ ok: false, error: "lesson_id 필요" }, 400);
    const { data: les } = await sr.from("lessons").select("id,project_id,lesson_no,week:weeks(week_no)").eq("id", lessonId).single();
    if (!les) return J({ ok: false, error: "차시를 찾을 수 없음" }, 404);
    const { data: prj } = await sr.from("projects").select("id,name,program_id,nas_root").eq("id", les.project_id).single();
    if (!prj?.nas_root) return J({ ok: false, error: "이 과정에 NAS 폴더가 아직 없습니다." }, 400);
    const [{ data: adm }, { data: pm }, { data: jm }] = await Promise.all([
      sr.from("user_roles").select("role_code").eq("user_id", uid).eq("role_code", "admin").limit(1),
      prj.program_id ? sr.from("program_members").select("user_id").eq("program_id", prj.program_id).eq("user_id", uid).limit(1) : Promise.resolve({ data: [] }),
      sr.from("project_members").select("user_id").eq("project_id", prj.id).eq("user_id", uid).limit(1),
    ]);
    const allowed = (adm && adm.length) || (pm && (pm as any).length) || (jm && jm.length);
    if (!allowed) return J({ ok: false, error: "이 사업에 대한 접근 권한이 없습니다." }, 403);
    const ref = resolveRef(prj.nas_root);
    const cfg = cfgs.find((c: any) => c.id === ref.id);
    if (!cfg) return J({ ok: false, error: "NAS 설정 없음(id " + ref.id + ")" }, 400);
    if (!isAllowed(cfg, ref.p)) return J({ ok: false, error: "허용되지 않은 NAS 경로입니다(관리자 확인 필요)." }, 403);
    let sess: { url: string; sid: string } | null = null;
    try {
      sess = await synoLogin(cfg);
      const vids = await listVideos(sess.url, sess.sid, ref.p, 3);
      const lessonNo = (les as any).lesson_no as number;
      const weekNo = (les as any).week?.week_no ?? null;
      const RE_L = /(\d+)\s*차\s*시/; const RE_W = /(\d+)\s*주\s*차?/; const RE_G = /(\d+)\s*강/;
      const STOPW = ["이해", "활용", "기초", "이러닝", "과정", "이해와", "종편", "저용량", "원본"];
      const tokens = String((prj as any).name || "").replace(/[\[\]()_\-.,:·]/g, " ").split(/\s+/).filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOPW.includes(t));
      let pool = vids;
      if (tokens.length) {
        const scored = vids.map((v) => ({ v, s: tokens.reduce((a, t) => a + (v.name.includes(t) ? 1 : 0), 0) }));
        const mx = Math.max(...scored.map((x) => x.s), 0);
        if (mx > 0) pool = scored.filter((x) => x.s === mx).map((x) => x.v);
      }
      const stripName = (name: string) => name.replace(/\.[A-Za-z0-9]+$/, "").replace(/re\s*\d+/gi, "").replace(/v\d+(\.\d+)*/gi, "").replace(/\(\d+\)/g, "");
      const codesOf = (name: string) => [...stripName(name).matchAll(/(?<![0-9])(\d{4})(?![0-9])/g)].map((m) => m[1]);
      const trailNum = (name: string) => [...stripName(name).matchAll(/(?<![0-9])0*(\d{1,2})(?![0-9])/g)].map((m) => parseInt(m[1]));
      const byWeekMp4 = (arr: {name:string;path:string}[]) => {
        if (arr.length > 1 && weekNo != null) { const w = arr.find((f) => { const m = f.name.match(RE_W); return m && parseInt(m[1]) === weekNo; }); if (w) return w; }
        const revN = (n: string) => { const m = n.match(/re\s*(\d+)/i); return m ? parseInt(m[1]) : 0; };
        const sorted = arr.slice().sort((a, b) => (Number(/종편/.test(b.path)) - Number(/종편/.test(a.path))) || (revN(b.name) - revN(a.name)));
        return sorted.find((f) => /\.mp4$/i.test(f.name)) || sorted[0];
      };
      // 주차형 과정: 파일명에 다른 주차가 명시된 파일은 후보에서 제외
      if (weekNo != null) pool = pool.filter((f) => { const m = f.name.match(RE_W); return !m || parseInt(m[1]) === weekNo; });
      let cands = pool.filter((f) => { const m = f.name.match(RE_L); return m && parseInt(m[1]) === lessonNo; });
      if (!cands.length) cands = pool.filter((f) => { const m = f.name.match(RE_G); return m && parseInt(m[1]) === lessonNo; });
      if (!cands.length) cands = pool.filter((f) => { const m = f.name.match(RE_W); return m && parseInt(m[1]) === lessonNo; });
      if (!cands.length) cands = pool.filter((f) => { const bn = stripName(f.name); const m = bn.match(/week[\s_]*0*(\d+)/i) || bn.match(/(?<![0-9])0*(\d{1,2})\s*-\s*0*(\d{1,2})(?![0-9.])/); return m && parseInt(m[1]) === lessonNo; });
      if (!cands.length) {
        cands = pool.filter((f) => codesOf(f.name).some((c) => parseInt(c.slice(0, 2)) === lessonNo));
        cands.sort((a, b) => {
          const pa = Math.min(...codesOf(a.name).filter((c) => parseInt(c.slice(0, 2)) === lessonNo).map(Number));
          const pb = Math.min(...codesOf(b.name).filter((c) => parseInt(c.slice(0, 2)) === lessonNo).map(Number));
          return pa - pb;
        });
      }
      if (!cands.length) cands = pool.filter((f) => trailNum(f.name).includes(lessonNo));
      if (!cands.length && pool.length === 1) cands = pool.slice();
      const hit = cands.length ? byWeekMp4(cands) : null;
      if (!hit) {
        const names = vids.map((v) => v.name).slice(0, 12);
        return J({ ok: false, error: `이 차시(${lessonNo}차시)의 종편 영상을 NAS에서 못 찾음. 폴더 내 영상 ${vids.length}개` + (names.length ? (": " + names.join(", ")) : " (영상 파일 없음 — 폴더 경로 확인)") }, 404);
      }
      const token = await signToken({ p: prefixFor(ref.id) + hit.path, e: Date.now() + 2 * 3600 * 1000, u: uid });
      return J({ ok: true, url: `${SB_URL}/functions/v1/nas-proxy?s=${encodeURIComponent(token)}`, name: hit.name });
    } finally { if (sess) await synoLogout(sess.url, sess.sid); }
  }

  // NAS 설정 조회/저장 (어드민 전용, NAS1)
  if (action === "get_config") {
    const { data } = await sr.from("nas_config").select("url,username,base,password").eq("id", 1).single();
    return J({ ok: true, url: data?.url || "", username: data?.username || "", base: data?.base || "", has_pw: !!(data?.password) });
  }
  if (action === "save_config") {
    const { data: adm } = await sr.from("user_roles").select("role_code").eq("user_id", uid).eq("role_code", "admin").limit(1);
    if (!adm || !adm.length) return J({ ok: false, error: "NAS 설정 저장은 어드민 전용입니다." }, 403);
    const up: Record<string, unknown> = { id: 1, url: body.url || null, username: body.username || null, base: body.base || null };
    if (body.password !== undefined && body.password !== "") up.password = body.password;
    const { error } = await sr.from("nas_config").upsert(up);
    if (error) return J({ ok: false, error: error.message }, 500);
    return J({ ok: true });
  }

  // ping: 모든 NAS의 허용된 공유폴더 병합 (NAS n≥2는 nasN: 접두어)
  if (action === "ping") {
    const shares: string[] = []; const errors: string[] = [];
    for (const cfg of cfgs) {
      let sess: { url: string; sid: string } | null = null;
      try {
        sess = await synoLogin(cfg);
        const r = await fetch(`${sess.url}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list_share&_sid=${sess.sid}`);
        const sh = await r.json().catch(() => ({ success: false }));
        for (const s of (sh.data?.shares || [])) if (isAllowed(cfg, s.path)) shares.push(prefixFor(cfg.id) + s.path);
      } catch (e) { errors.push((cfg.label || ("NAS" + cfg.id)) + ": " + String((e as any)?.message || e)); }
      finally { if (sess) await synoLogout(sess.url, sess.sid); }
    }
    return J({ ok: true, base: (cfg1?.base || ""), shares, errors: errors.length ? errors : undefined });
  }

  // list: 접두어로 NAS 판별, 허용 경로만
  if (action === "list") {
    const ref = resolveRef(body.path || (cfg1?.base || ""));
    const cfg = cfgs.find((c: any) => c.id === ref.id);
    if (!cfg) return J({ ok: false, error: "NAS 설정 없음" }, 400);
    if (!ref.p) return J({ ok: false, error: "경로가 비어 있습니다." }, 400);
    if (!isAllowed(cfg, ref.p)) return J({ ok: false, error: "허용되지 않은 경로입니다(" + (allowedOf(cfg).join(", ") || "-") + " 하위만 가능)." }, 403);
    let sess: { url: string; sid: string } | null = null;
    try {
      sess = await synoLogin(cfg);
      const res = await synoList(sess.url, sess.sid, ref.p);
      return J({ ok: res.success, path: prefixFor(ref.id) + ref.p, files: (res.data?.files || []).map((f: any) => ({ name: f.name, isdir: f.isdir, path: prefixFor(ref.id) + f.path })), error: res.error });
    } catch (e) { return J({ ok: false, error: String((e as any)?.message || e) }, 500); }
    finally { if (sess) await synoLogout(sess.url, sess.sid); }
  }

  // mkdir_tree: 과정·단계 폴더 생성 (멀티 NAS). 파일 삭제/덮어쓰기 절대 안 함 — 이미 있는 폴더는 건너뜀.
  if (action === "mkdir_tree") {
    const ref = body.base ? resolveRef(String(body.base)) : { id: (cfg1?.id || 1), p: `${(cfg1?.base || "").replace(/\/$/, "")}/${body.project}` };
    const cfg = cfgs.find((c: any) => c.id === ref.id) || cfg1;
    const root = ref.p;
    if (!isAllowed(cfg, root)) return J({ ok: false, error: "허용되지 않은 경로입니다." }, 403);
    let sess: { url: string; sid: string } | null = null;
    try {
      sess = await synoLogin(cfg);
      // 루트 폴더 보장 (없을 때만 생성)
      const parentOfRoot = root.replace(/\/[^/]+$/, ""); const rootName = root.split("/").pop() || "";
      if (parentOfRoot && rootName && !(await nameExists(sess.url, sess.sid, parentOfRoot, rootName))) {
        await fetch(`${sess.url}/webapi/entry.cgi?api=SYNO.FileStation.CreateFolder&version=2&method=create&folder_path=${encodeURIComponent(JSON.stringify([parentOfRoot]))}&name=${encodeURIComponent(JSON.stringify([rootName]))}&force_parent=true&_sid=${sess.sid}`);
      }
      // 단계 하위 폴더: 이미 있으면 건너뜀(덮어쓰기·삭제 없음)
      const want = (body.folders || []); const toCreate: string[] = []; const skipped: string[] = [];
      for (const nm of want) { if (await nameExists(sess.url, sess.sid, root, nm)) skipped.push(nm); else toCreate.push(nm); }
      if (toCreate.length) {
        const parents = toCreate.map(() => root);
        await fetch(`${sess.url}/webapi/entry.cgi?api=SYNO.FileStation.CreateFolder&version=2&method=create&folder_path=${encodeURIComponent(JSON.stringify(parents))}&name=${encodeURIComponent(JSON.stringify(toCreate))}&force_parent=true&_sid=${sess.sid}`);
      }
      return J({ ok: true, root: prefixFor(ref.id) + root, created: toCreate, skipped });
    } catch (e) { return J({ ok: false, error: String((e as any)?.message || e) }, 500); }
    finally { if (sess) await synoLogout(sess.url, sess.sid); }
  }

  // save: 새 이름으로만 저장. 기존 파일 삭제·덮어쓰기 금지 — 같은 이름이면 자동으로 "(2)" 등 새 이름 부여.
  if (action === "save") {
    const ref = resolveRef(String(body.folder || ""));
    const cfg = cfgs.find((c: any) => c.id === ref.id);
    if (!cfg) return J({ ok: false, error: "NAS 설정 없음" }, 400);
    if (!ref.p || !isAllowed(cfg, ref.p)) return J({ ok: false, error: "허용되지 않은 경로입니다." }, 403);
    // 업로드는 과정 권한 + 과정 영역 내 폴더만 허용
    if (body.project_id) {
      const { data: prj } = await sr.from("projects").select("id,program_id,nas_root").eq("id", body.project_id).single();
      if (!prj?.nas_root) return J({ ok: false, error: "이 과정에 NAS 폴더가 없습니다." }, 400);
      if (!(await projAccess(sr, uid, prj))) return J({ ok: false, error: "접근 권한이 없습니다." }, 403);
      const projRef = resolveRef(prj.nas_root);
      if (ref.id !== projRef.id || !ref.p.startsWith(bizRootOf(projRef.p))) return J({ ok: false, error: "이 과정 영역 밖의 폴더입니다." }, 403);
    }
    let rawName = String(body.name || "").replace(/[\\/:*?\"<>|]/g, "_").trim();
    if (!rawName) return J({ ok: false, error: "파일명이 필요합니다." }, 400);
    // 차시 컨텍스트가 있으면, 이미 그 차시로 인식되지 않는 이름엔 차시 태그를 앞에 붙임
    if (body.lesson_id) {
      const lc = await lessonCtx(sr, body.lesson_id);
      if (lc && !fileMatchesLesson(rawName, lc.no, lc.wk, lc.total)) rawName = lessonTag(lc.no, lc.wk) + "_" + rawName;
    }
    let bytes: Uint8Array;
    try { const b64 = String(body.content || "").split(",").pop() || ""; const bin = atob(b64); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
    catch { return J({ ok: false, error: "content(base64) 파싱 실패" }, 400); }
    let sess: { url: string; sid: string } | null = null;
    try {
      sess = await synoLogin(cfg);
      const safe = await uniqueName(sess.url, sess.sid, ref.p, rawName); // 겹치면 새 이름 (최종 목적지 기준)
      // 모든 NAS: 백신 검사를 위해 .cdms_scan(검사 대기)으로 먼저 저장 → nas-worker가 검사 후 이동
      const doScan = true;
      const target = doScan ? ref.p + "/.cdms_scan" : ref.p;
      const form = new FormData();
      form.append("path", target);
      form.append("create_parents", doScan ? "true" : "false");
      form.append("overwrite", doScan ? "true" : "false"); // 최종 폴더에는 절대 덮어쓰기 금지
      form.append("file", new Blob([bytes]), safe);
      const r = await fetch(`${sess.url}/webapi/entry.cgi?api=SYNO.FileStation.Upload&version=2&method=upload&_sid=${sess.sid}`, { method: "POST", body: form });
      const res = await r.json().catch(() => ({ success: false }));
      if (!res.success) return J({ ok: false, error: "업로드 실패(code " + (res.error?.code ?? "?") + ")" }, 500);
      return J({ ok: true, name: safe, renamed: safe !== rawName, path: prefixFor(ref.id) + target + "/" + safe,
                 scan: doScan, scan_path: doScan ? prefixFor(ref.id) + target + "/" + safe : null, dest: doScan ? prefixFor(ref.id) + ref.p : null });
    } catch (e) { return J({ ok: false, error: String((e as any)?.message || e) }, 500); }
    finally { if (sess) await synoLogout(sess.url, sess.sid); }
  }

  // stage_files: 과정+단계 → NAS 단계 폴더의 파일 목록 (읽기)
  if (action === "stage_files") {
    const { data: prj } = await sr.from("projects").select("id,name,program_id,nas_root").eq("id", body.project_id).single();
    if (!prj?.nas_root) return J({ ok: false, error: "이 과정에 NAS 폴더가 아직 없습니다." }, 400);
    if (!(await projAccess(sr, uid, prj))) return J({ ok: false, error: "이 사업에 대한 접근 권한이 없습니다." }, 403);
    const pat = STAGE_PAT_FILES[body.stage_id]; if (!pat) return J({ ok: false, error: "지원하지 않는 단계입니다." }, 400);
    const ref = resolveRef(prj.nas_root); const cfg = cfgs.find((c: any) => c.id === ref.id);
    if (!cfg) return J({ ok: false, error: "NAS 설정 없음" }, 400);
    if (!isAllowed(cfg, ref.p)) return J({ ok: false, error: "허용되지 않은 경로입니다." }, 403);
    let sess: { url: string; sid: string } | null = null;
    try {
      sess = await synoLogin(cfg);
      const { base, dirs } = await findScanBase(sess.url, sess.sid, cfg, ref.p);
      let dir = dirs.find((d: any) => pat.test(d.name)) || null;
      if (body.stage_id === 2) { // 촬영: '촬영원고'·'촬영교안' 폴더가 아닌 실제 촬영본(cap) 폴더를 우선 연결
        const cand2 = dirs.filter((d: any) => (pat.test(d.name) || /cap/i.test(d.name)) && !/원고|교안/.test(d.name));
        dir = cand2.find((d: any) => /촬영본|영상촬영|cap/i.test(d.name)) || cand2[0] || dir;
      }
      if (!dir && body.stage_id === 99 && body.create) { // 영상소스(프리미어 프로젝트·효과음·에셋) 폴더 자동 생성
        await fetch(`${sess.url}/webapi/entry.cgi?api=SYNO.FileStation.CreateFolder&version=2&method=create&folder_path=${encodeURIComponent(JSON.stringify([base]))}&name=${encodeURIComponent(JSON.stringify(["98_소스"]))}&force_parent=true&_sid=${sess.sid}`);
        dir = { path: base + "/98_소스", name: "98_소스" };
      }
      if (!dir && pat.test(ref.p)) { // nas_root가 이미 그 단계 폴더 안(예: 종편 프로젝트)
        const parts = ref.p.split("/"); let acc = ""; let hit = "";
        for (const seg of parts) { if (!seg) continue; acc += "/" + seg; if (pat.test(seg)) hit = acc; }
        if (hit) dir = { path: hit, name: hit.split("/").pop() };
      }
      if (!dir) return J({ ok: true, folder: null, files: [] });
      // 원고(1) 탭에는 '촬영원고' 등 원고가 들어간 다른 폴더도 통합해서 표시 (업로드는 기본 원고 폴더로)
      const srcDirs: any[] = [dir];
      if (body.stage_id === 1) {
        for (const d of dirs) if (d.path !== dir.path && /원고/.test(d.name)) srcDirs.push(d);
      }
      let files: any[] = [];
      for (const d of srcDirs.slice(0, 3)) files = files.concat(await listFilesMeta(sess.url, sess.sid, d.path, 5)); // 깊은 하위 폴더(상위/주차/차시/용도)까지 나열
      if (body.lesson_id) {
        const lc = await lessonCtx(sr, body.lesson_id);
        // 파일명뿐 아니라 상위 폴더명(예: 3주차/1차시/디자인.png)까지 포함해 차시 매칭
        if (lc) files = files.filter((f: any) => {
          const bd = srcDirs.find((d: any) => String(f.path || "").startsWith(d.path + "/"));
          const rel = bd ? String(f.path).slice(bd.path.length + 1) : f.name;
          return fileMatchesLesson(rel, lc.no, lc.wk, lc.total);
        });
      }
      files.sort((a: any, b: any) => a.name.localeCompare(b.name, "ko"));
      return J({ ok: true, folder: prefixFor(ref.id) + dir.path, files: files.map((f: any) => ({ name: f.name, path: prefixFor(ref.id) + f.path, size: f.size, mtime: f.mtime })) });
    } catch (e) { return J({ ok: false, error: String((e as any)?.message || e) }, 500); }
    finally { if (sess) await synoLogout(sess.url, sess.sid); }
  }

  // upload_ticket: 대용량 브라우저 직접 업로드용 — 권한 확인 후 NAS 주소+세션(sid)+대상 폴더 발급
  //  (브라우저는 CORS 미지원 NAS에 no-cors 형태의 multipart POST로 올리고, 결과는 stage_files로 검증)
  if (action === "upload_ticket") {
    const { data: prj } = await sr.from("projects").select("id,name,program_id,nas_root").eq("id", body.project_id).single();
    if (!prj?.nas_root) return J({ ok: false, error: "이 과정에 NAS 폴더가 아직 없습니다." }, 400);
    if (!(await projAccess(sr, uid, prj))) return J({ ok: false, error: "접근 권한이 없습니다." }, 403);
    const ref = resolveRef(String(body.folder || "")); const projRef = resolveRef(prj.nas_root);
    const cfg = cfgs.find((c: any) => c.id === ref.id);
    if (!cfg || !ref.p || !isAllowed(cfg, ref.p)) return J({ ok: false, error: "허용되지 않은 경로입니다." }, 403);
    if (ref.id !== projRef.id || !ref.p.startsWith(bizRootOf(projRef.p))) return J({ ok: false, error: "이 과정 영역 밖입니다." }, 403);
    const sess = await synoLogin(cfg); // 로그아웃하지 않음 — 브라우저가 업로드에 사용
    // 모든 NAS: 백신 검사 대기 폴더로 업로드 → nas-worker가 검사 후 최종 폴더로 이동
    return J({ ok: true, url: sess.url, sid: sess.sid, path: ref.p + "/.cdms_scan", scan: true,
               scan_path: prefixFor(ref.id) + ref.p + "/.cdms_scan", dest: prefixFor(ref.id) + ref.p });
  }

  // file_url: 과정 영역 내 임의 파일의 단기 서명 다운로드 URL (읽기)
  if (action === "file_url") {
    const { data: prj } = await sr.from("projects").select("id,program_id,nas_root").eq("id", body.project_id).single();
    if (!prj?.nas_root) return J({ ok: false, error: "이 과정에 NAS 폴더가 없습니다." }, 400);
    if (!(await projAccess(sr, uid, prj))) return J({ ok: false, error: "접근 권한이 없습니다." }, 403);
    const ref = resolveRef(String(body.path || "")); const projRef = resolveRef(prj.nas_root);
    const cfg = cfgs.find((c: any) => c.id === ref.id);
    if (!cfg || !ref.p || !isAllowed(cfg, ref.p)) return J({ ok: false, error: "허용되지 않은 경로입니다." }, 403);
    if (ref.id !== projRef.id || !ref.p.startsWith(bizRootOf(projRef.p))) return J({ ok: false, error: "이 과정 영역 밖의 파일입니다." }, 403);
    const token = await signToken({ p: prefixFor(ref.id) + ref.p, e: Date.now() + 2 * 3600 * 1000, u: uid });
    return J({ ok: true, url: `${SB_URL}/functions/v1/nas-proxy?s=${encodeURIComponent(token)}` });
  }

  // 주의: 이 함수에는 파일/폴더 삭제·이동·덮어쓰기 액션이 의도적으로 존재하지 않는다. 알 수 없는 액션은 거부.
  return J({ ok: false, error: "unknown action" }, 400);
});
