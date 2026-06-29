// CDMS ↔ 하이웍스 전자결재 : 품의 기안(상신 페이지 생성)
// 프런트에서 호출:  sb.functions.invoke('hiworks-draft', { body:{ program_id, pm_id } })
//   -> 하이웍스 POST /office/approval/documents (officeToken+form_id)
//   -> 응답 approval_key 저장, login_url(팝업) 반환
// 필요한 시크릿(supabase secrets set):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (기본 제공)
//   HIWORKS_OFFICE_TOKEN_DRAFT  기안할 오피스의 officeToken (단일)
//   HIWORKS_FORM_ID             품의서 양식 고유 아이디(form_id)
//   HIWORKS_CALLBACK_URL        배포된 hiworks-callback 함수의 공개 URL
//   HIWORKS_API_BASE            (선택) 기본 https://api.hiworks.com
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OFFICE_TOKEN = Deno.env.get("HIWORKS_OFFICE_TOKEN_DRAFT")!;
const FORM_ID      = Deno.env.get("HIWORKS_FORM_ID")!;
const CALLBACK_URL = Deno.env.get("HIWORKS_CALLBACK_URL")!;
const API_BASE     = (Deno.env.get("HIWORKS_API_BASE") || "https://api.hiworks.com").replace(/\/+$/, "");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return json({ error: "POST only" }, 405);
  if (!OFFICE_TOKEN || !FORM_ID || !CALLBACK_URL)
    return json({ error: "서버 시크릿 미설정(HIWORKS_OFFICE_TOKEN_DRAFT/FORM_ID/CALLBACK_URL)" }, 500);

  try {
    const { program_id, subject, contents, pm_id } = await req.json();
    if (!program_id) return json({ error: "program_id 필요" }, 400);

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: prog } = await sb
      .from("programs").select("id,name,client,amount,seq").eq("id", program_id).single();
    if (!prog) return json({ error: "사업을 찾을 수 없음" }, 404);

    const subj = subject || `[품의] ${prog.name ?? ""}`;
    // contents 를 보내지 않으면 N68 양식의 본문 템플릿이 그대로 사용된다.
    const payload: Record<string, unknown> = {
      form_id: FORM_ID,
      subject: subj,
      callback_url: CALLBACK_URL,
      modify_contents_flag: "Y",
      modify_files_flag: "Y",
    };
    if (contents) payload.contents = contents; // 명시적으로 넘어온 경우에만 본문 덮어쓰기

    const res = await fetch(`${API_BASE}/office/approval/documents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OFFICE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const out = await res.json().catch(() => null);
    if (!out || out.code !== "SUC" || !out.data?.login_url)
      return json({ error: "하이웍스 기안 생성 실패", detail: out }, 502);

    const patch: Record<string, unknown> = {
      hiworks_approval_key: out.data.approval_key,
    };
    if (pm_id) patch.hiworks_drafter_id = pm_id; // 기안자만 기록(품의완료 시 PM 승격). 상태/PM은 지금 안 바꿈
    await sb.from("programs").update(patch).eq("id", program_id);

    return json({ login_url: out.data.login_url, approval_key: out.data.approval_key });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
