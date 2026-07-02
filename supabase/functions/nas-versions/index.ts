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
async function getCfg() {
  const sr = createClient(SB_URL, SR_KEY);
  const { data } = await sr.from("nas_config").select("*").eq("id", 1).single();
  return data || {};
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
    if (f.isdir) { if (depth > 0 && f.name !== "#recycle") out.push(...await listVideos(url, sid, f.path, depth - 1)); }
    else { const i = f.name.lastIndexOf("."); const ext = (i >= 0 ? f.name.slice(i) : "").toLowerCase(); if (VIDEO_EXT.includes(ext)) out.push({ name: f.name, path: f.path }); }
  }
  return out;
}

// ---- nas-proxy와 동일한 차시 매칭 (모든 리비전 반환) ----
const RE_L = /(\d+)\s*차\s*시/, RE_W = /(\d+)\s*주\s*차?/, RE_G = /(\d+)\s*강/;
const STOPW = ["이해", "활용", "기초", "이러닝", "과정", "이해와", "종편", "저용량", "원본"];
const stripName = (name: string) => name.replace(/\.[A-Za-z0-9]+$/, "").replace(/re\s*\d+/gi, "").replace(/v\d+(\.\d+)*/gi, "").replace(/\(\d+\)/g, "");
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

async function loadCtx(sr: any, uid: string, lessonId: string) {
  const { data: les } = await sr.from("lessons").select("id,project_id,lesson_no,week:weeks(week_no)").eq("id", lessonId).single();
  if (!les) return { err: J({ ok: false, error: "차시를 찾을 수 없음" }, 404) };
  const { data: prj } = await sr.from("projects").select("id,name,program_id,nas_root").eq("id", les.project_id).single();
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
  const uid = await userFromReq(req);
  if (!uid) return J({ ok: false, error: "로그인이 필요합니다." }, 401);
  const sr = createClient(SB_URL, SR_KEY);
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
    let sess: { url: string; sid: string } | null = null;
    try {
      sess = await synoLogin(await getCfg());
      const vids = (await listVideos(sess.url, sess.sid, prj.nas_root, 3))
        .filter((f) => !/저용량|포팅|h\.?265|프록시|proxy/i.test(f.name));
      const lessonNo = (les as any).lesson_no as number;
      const weekNo = (les as any).week?.week_no ?? null;
      let cands = candsFor(vids, lessonNo, weekNo, prj.name);
      // 중복 제거 + 정렬: 리비전 오름차순(re 없음=0), 같은 리비전이면 old 폴더 먼저
      const seen = new Set<string>();
      cands = cands.filter((f) => { if (seen.has(f.path)) return false; seen.add(f.path); return true; });
      cands.sort((a, b) => (revOf(a.name) - revOf(b.name)) || (Number(/\/old\//i.test(b.path)) - Number(/\/old\//i.test(a.path))) || a.name.localeCompare(b.name));
      const versions = cands.map((f, i) => ({ v: i + 1, name: f.name, path: f.path, rev: revOf(f.name) }));
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
  return J({ ok: false, error: "unknown action" }, 400);
});
