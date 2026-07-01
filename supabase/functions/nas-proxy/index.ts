import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SR_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON   = Deno.env.get("SUPABASE_ANON_KEY")!;
const LENGTH_STAGE_ID = 7; // 종편
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

async function getCfg() {
  const sr = createClient(SB_URL, SR_KEY);
  const { data } = await sr.from("nas_config").select("*").eq("id", 1).single();
  return data || {};
}
async function userFromReq(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u?.id || null;
}

// ---- Synology FileStation ----
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);

  // ===== GET ?s=token  → 서명 검증 후 NAS 원본 Range 스트리밍 =====
  if (req.method === "GET" && u.searchParams.has("s")) {
    const payload = await verifyToken(u.searchParams.get("s")!);
    if (!payload) return J({ ok: false, error: "링크가 만료되었거나 유효하지 않습니다." }, 403);
    const path = String(payload.p || "");
    let sess: { url: string; sid: string } | null = null;
    try {
      sess = await synoLogin(await getCfg());
      const dl = `${sess.url}/webapi/entry.cgi?api=SYNO.FileStation.Download&version=2&method=download&mode=open&path=${encodeURIComponent(path)}&_sid=${sess.sid}`;
      const range = req.headers.get("range");
      const up = await fetch(dl, { headers: range ? { Range: range } : {} });
      const h: Record<string, string> = { ...CORS, "Content-Type": "video/mp4", "Accept-Ranges": "bytes" };
      const cr = up.headers.get("content-range"); if (cr) h["Content-Range"] = cr;
      const cl = up.headers.get("content-length"); if (cl) h["Content-Length"] = cl;
      return new Response(up.body, { status: up.status, headers: h });
    } catch (e) {
      return J({ ok: false, error: String((e as any)?.message || e) }, 502);
    } finally {
      if (sess) await synoLogout(sess.url, sess.sid);
    }
  }

  // ===== POST actions (모두 로그인 사용자만) =====
  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const action = body.action || "ping";
  const uid = await userFromReq(req);
  if (!uid) return J({ ok: false, error: "로그인이 필요합니다." }, 401);
  const sr = createClient(SB_URL, SR_KEY);

  // 검수영상 스트리밍 URL 발급 (권한 검사 후 단기 서명)
  if (action === "stream_url") {
    const lessonId = body.lesson_id;
    if (!lessonId) return J({ ok: false, error: "lesson_id 필요" }, 400);
    const { data: les } = await sr.from("lessons").select("id,project_id").eq("id", lessonId).single();
    if (!les) return J({ ok: false, error: "차시를 찾을 수 없음" }, 404);
    const { data: prj } = await sr.from("projects").select("id,program_id,nas_root").eq("id", les.project_id).single();
    if (!prj?.nas_root) return J({ ok: false, error: "이 과정에 NAS 폴더가 아직 없습니다." }, 400);
    // 권한: 어드민 or 사업멤버 or 과목멤버
    const [{ data: adm }, { data: pm }, { data: jm }] = await Promise.all([
      sr.from("user_roles").select("role_code").eq("user_id", uid).eq("role_code", "admin").limit(1),
      prj.program_id ? sr.from("program_members").select("user_id").eq("program_id", prj.program_id).eq("user_id", uid).limit(1) : Promise.resolve({ data: [] }),
      sr.from("project_members").select("user_id").eq("project_id", prj.id).eq("user_id", uid).limit(1),
    ]);
    const allowed = (adm && adm.length) || (pm && (pm as any).length) || (jm && jm.length);
    if (!allowed) return J({ ok: false, error: "이 사업에 대한 접근 권한이 없습니다." }, 403);
    // 종편 파일 경로 (worker 스캔값 lesson_stage.file_name 사용)
    const { data: stg } = await sr.from("stages").select("nas_folder").eq("id", LENGTH_STAGE_ID).single();
    const folder = (stg?.nas_folder) || "07_종편";
    const { data: ls } = await sr.from("lesson_stage").select("file_name").eq("lesson_id", lessonId).eq("stage_id", LENGTH_STAGE_ID).single();
    if (!ls?.file_name) return J({ ok: false, error: "종편 영상이 아직 스캔되지 않았습니다. 먼저 'NAS 동기화'를 실행하세요." }, 404);
    const sep = prj.nas_root.includes("\\") ? "\\" : "/";
    const path = [prj.nas_root, folder, ls.file_name].join(sep);
    const token = await signToken({ p: path, e: Date.now() + 2 * 3600 * 1000, u: uid });
    return J({ ok: true, url: `${SB_URL}/functions/v1/nas-proxy?s=${encodeURIComponent(token)}`, name: ls.file_name });
  }

  // 기존 관리 액션 (NAS 설정 확인/폴더) — 로그인 사용자만
  const cfg = await getCfg();
  if (!cfg.url || !cfg.username) return J({ ok: false, error: "NAS 설정이 비어 있습니다. 앱의 NAS 설정에서 URL/계정/비번을 저장하세요." }, 400);
  let sess: { url: string; sid: string } | null = null;
  try {
    sess = await synoLogin(cfg);
    const NAS_BASE = (cfg.base || "").replace(/\/$/, "");
    const syno = async (path: string) => { const r = await fetch(`${sess!.url}${path}`); const t = await r.text(); try { return JSON.parse(t); } catch { return { success: false, raw: t.slice(0, 300) }; } };
    if (action === "ping") {
      const sh = await syno(`/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list_share&_sid=${sess.sid}`);
      return J({ ok: true, base: NAS_BASE, shares: (sh.data?.shares || []).map((s: any) => s.path) });
    }
    if (action === "list") {
      const path = body.path || NAS_BASE;
      const res = await syno(`/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list&folder_path=${encodeURIComponent(JSON.stringify(path))}&_sid=${sess.sid}`);
      return J({ ok: res.success, path, files: (res.data?.files || []).map((f: any) => ({ name: f.name, isdir: f.isdir, path: f.path })), error: res.error });
    }
    if (action === "mkdir_tree") {
      const root = `${NAS_BASE}/${body.project}`;
      const parents = (body.folders || []).map(() => root);
      const names = body.folders || [];
      const res = await syno(`/webapi/entry.cgi?api=SYNO.FileStation.CreateFolder&version=2&method=create&folder_path=${encodeURIComponent(JSON.stringify(parents))}&name=${encodeURIComponent(JSON.stringify(names))}&force_parent=true&_sid=${sess.sid}`);
      return J({ ok: res.success, root, created: names, error: res.error });
    }
    return J({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return J({ ok: false, error: String((e as any)?.message || e) }, 500);
  } finally {
    if (sess) await synoLogout(sess.url, sess.sid);
  }
});
