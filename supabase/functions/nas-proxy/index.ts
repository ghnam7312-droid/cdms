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
      let cands = pool.filter((f) => { const m = f.name.match(RE_L); return m && parseInt(m[1]) === lessonNo; });
      if (!cands.length) cands = pool.filter((f) => { const m = f.name.match(RE_G); return m && parseInt(m[1]) === lessonNo; });
      if (!cands.length) cands = pool.filter((f) => { const m = f.name.match(RE_W); return m && parseInt(m[1]) === lessonNo; });
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

  // mkdir_tree: NAS1 전용 (워커 계정이 실제 쓰기 담당 — readonly 계정에선 실패할 수 있음)
  if (action === "mkdir_tree") {
    const NAS_BASE = (cfg1?.base || "").replace(/\/$/, "");
    const root = `${NAS_BASE}/${body.project}`;
    if (!isAllowed(cfg1, root)) return J({ ok: false, error: "허용되지 않은 경로입니다." }, 403);
    let sess: { url: string; sid: string } | null = null;
    try {
      sess = await synoLogin(cfg1);
      const parents = (body.folders || []).map(() => root);
      const names = body.folders || [];
      const r = await fetch(`${sess.url}/webapi/entry.cgi?api=SYNO.FileStation.CreateFolder&version=2&method=create&folder_path=${encodeURIComponent(JSON.stringify(parents))}&name=${encodeURIComponent(JSON.stringify(names))}&force_parent=true&_sid=${sess.sid}`);
      const res = await r.json().catch(() => ({ success: false }));
      return J({ ok: res.success, root, created: names, error: res.error });
    } catch (e) { return J({ ok: false, error: String((e as any)?.message || e) }, 500); }
    finally { if (sess) await synoLogout(sess.url, sess.sid); }
  }

  return J({ ok: false, error: "unknown action" }, 400);
});
