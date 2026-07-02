// 품의 본문 → 단계별 담당자 자동배치. POST { program_id, apply?:bool }
// 토큰: agent_secrets.hiworks_approval_token. 인증: Authorization: <officeToken> (Bearer 없음).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const API = (Deno.env.get("HIWORKS_API_BASE") || "https://api.hiworks.com").replace(/\/+$/, "");
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const STAGE_KEYS: { id: number; re: RegExp }[] = [
  { id: 1, re: /원고|집필|기획|스크립트작가|대본/ },
  { id: 2, re: /촬영|카메라|촬영감독/ },
  { id: 3, re: /가편|편집(?!.*종편)/ },
  { id: 5, re: /스토리보드|스토보|보드|SB/i },
  { id: 6, re: /디자인|삽화|그래픽/ },
  { id: 7, re: /종편|종합편집|본편집/ },
  { id: 4, re: /속기/ },
  { id: 8, re: /검수|QA|품질/ },
  { id: 9, re: /학습자료/ },
  { id: 10, re: /자막|SRT|자막제작/i },
  { id: 11, re: /성우|내레이션|음성|더빙/ },
  { id: 13, re: /번역/ },
];
function gatherText(o: any): string {
  const out: string[] = [];
  const walk = (x: any) => { if (x == null) return; if (typeof x === "string") { out.push(x); return; } if (typeof x === "number") return; if (Array.isArray(x)) { x.forEach(walk); return; } if (typeof x === "object") for (const k of Object.keys(x)) walk(x[k]); };
  walk(o); return out.join("\n");
}
const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
async function userFromReq(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || ""; if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: ANON, Authorization: auth } });
  if (!r.ok) return null; const u = await r.json().catch(() => null); return u?.id || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return J({ ok: false, error: "POST only" }, 405);
  const uid = await userFromReq(req);
  if (!uid) return J({ ok: false, error: "로그인 필요" }, 401);
  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const { program_id, apply } = body;
  if (!program_id) return J({ ok: false, error: "program_id 필요" }, 400);
  const sb = createClient(SB, SR);
  const { data: adm } = await sb.from("user_roles").select("role_code").eq("user_id", uid).eq("role_code", "admin").limit(1);
  if (!adm || !adm.length) return J({ ok: false, error: "어드민 전용입니다." }, 403);
  const { data: prog } = await sb.from("programs").select("id,name,hiworks_approval_key,approval_status").eq("id", program_id).single();
  if (!prog) return J({ ok: false, error: "사업을 찾을 수 없음" }, 404);
  if (!prog.hiworks_approval_key) return J({ ok: false, error: "이 사업에 품의(하이웍스) 키가 없습니다. 먼저 품의를 기안하세요." }, 400);
  const { data: krow } = await sb.from("agent_secrets").select("value").eq("name", "hiworks_approval_token").single();
  const TOKEN = (krow?.value || Deno.env.get("HIWORKS_APPROVAL_TOKEN") || Deno.env.get("HIWORKS_OFFICE_TOKEN_DRAFT") || "").trim();
  if (!TOKEN) return J({ ok: false, error: "하이웍스 조회 토큰 미설정" }, 500);
  const r = await fetch(`${API}/office/v2/approval/documents?approval_key=${encodeURIComponent(prog.hiworks_approval_key)}`, { headers: { Authorization: TOKEN, "Content-Type": "application/json" } });
  const raw = await r.text(); let doc: any = null; try { doc = JSON.parse(raw); } catch { doc = { raw }; }
  if (doc?.code === "ERR") return J({ ok: false, error: "하이웍스 조회 오류: " + doc.message, hint: "완료된 품의(미등록·취소 아님)인지 확인", need_token: /토큰/.test(doc.message || "") }, 502);
  const text = stripTags(gatherText(doc));
  const { data: users } = await sb.from("users").select("id,name").not("name", "is", null);
  const named = (users || []).filter((u: any) => (u.name || "").length >= 2);
  const hits: Record<number, { user_id: string; name: string; ev: string }[]> = {};
  for (const u of named) {
    let idx = text.indexOf(u.name);
    while (idx >= 0) {
      const win = text.slice(Math.max(0, idx - 60), idx + u.name.length + 60);
      for (const sk of STAGE_KEYS) if (sk.re.test(win)) { (hits[sk.id] = hits[sk.id] || []); if (!hits[sk.id].some((h) => h.user_id === u.id)) hits[sk.id].push({ user_id: u.id, name: u.name, ev: win.replace(/\s+/g, " ").trim().slice(0, 80) }); }
      idx = text.indexOf(u.name, idx + u.name.length);
    }
  }
  const { data: stages } = await sb.from("stages").select("id,name");
  const sName: Record<number, string> = {}; (stages || []).forEach((s: any) => sName[s.id] = s.name);
  const preview = Object.keys(hits).map((k) => ({ stage_id: +k, stage: sName[+k], people: hits[+k] }));
  if (!apply) return J({ ok: true, applied: false, program: prog.name, preview, text_sample: text.replace(/\s+/g, " ").trim().slice(0, 1200) });
  const { data: projs } = await sb.from("projects").select("id").eq("program_id", program_id);
  const rows: any[] = [];
  for (const p of (projs || [])) for (const k of Object.keys(hits)) { const first = hits[+k][0]; if (first) rows.push({ project_id: p.id, stage_id: +k, user_id: first.user_id }); }
  let applied = 0;
  if (rows.length) { const { error } = await sb.from("stage_assignees").upsert(rows, { onConflict: "project_id,stage_id" }); if (error) return J({ ok: false, error: "적용 실패: " + error.message, preview }, 500); applied = rows.length; }
  return J({ ok: true, applied: true, rows: applied, projects: (projs || []).length, preview });
});
