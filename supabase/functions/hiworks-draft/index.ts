// CDMS ↔ 하이웍스 전자결재 : 품의 기안(상신 페이지 생성)
// 하이웍스 기안 API는 contents(본문)가 필수이며, 보낸 값이 양식 본문을 대체한다.
// 따라서 빈 값 대신 사업 정보로 채운 기본 품의 본문을 보낸다.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OFFICE_TOKEN = Deno.env.get("HIWORKS_OFFICE_TOKEN_DRAFT")!;
// 양식 id 68 고정 (필요 시 환경변수 HIWORKS_FORM_ID 로 재정의 가능)
const FORM_ID      = (Deno.env.get("HIWORKS_FORM_ID") || "68").trim() || "68";
const CALLBACK_URL = Deno.env.get("HIWORKS_CALLBACK_URL")!;
const API_BASE     = (Deno.env.get("HIWORKS_API_BASE") || "https://api.hiworks.com").replace(/\/+$/, "");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const won = (n: unknown) => (n == null || n === "") ? "" : Number(n).toLocaleString("ko-KR") + "원";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return json({ error: "POST only" }, 405);
  if (!OFFICE_TOKEN || !FORM_ID || !CALLBACK_URL)
    return json({ error: "서버 시크릿 미설정(HIWORKS_OFFICE_TOKEN_DRAFT/CALLBACK_URL)" }, 500);

  try {
    const { program_id, subject, contents, pm_id } = await req.json();
    if (!program_id) return json({ error: "program_id 필요" }, 400);

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: prog } = await sb
      .from("programs").select("id,name,client,amount,contract_start,contract_end,seq").eq("id", program_id).single();
    if (!prog) return json({ error: "사업을 찾을 수 없음" }, 404);

    const subj = subject || `[품의] ${prog.name ?? ""}`;
    const period = (prog.contract_start || prog.contract_end)
      ? `${prog.contract_start ?? ""} ~ ${prog.contract_end ?? ""}` : "";
    // contents 필수: 사용자 입력이 없으면 사업 정보로 채운 기본 본문을 보낸다(빈 본문 방지).
    const defaultBody =
      `<p>1. 사업명: ${prog.name ?? ""}</p>` +
      `<p>2. 발주처: ${prog.client ?? ""}</p>` +
      (prog.amount ? `<p>3. 계약금액: ${won(prog.amount)}</p>` : "") +
      (period ? `<p>4. 계약기간: ${period}</p>` : "") +
      `<br><p>위 사업의 진행을 위하여 품의하오니 재가하여 주시기 바랍니다.</p>`;
    const payload: Record<string, unknown> = {
      form_id: FORM_ID,
      subject: subj,
      contents: (contents && String(contents).trim()) ? contents : defaultBody,
      callback_url: CALLBACK_URL,
      modify_contents_flag: "Y",
      modify_files_flag: "Y",
    };

    const res = await fetch(`${API_BASE}/office/approval/documents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OFFICE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const out = await res.json().catch(() => null);
    if (!out || out.code !== "SUC" || !out.data?.login_url)
      return json({ error: "하이웍스 기안 생성 실패", detail: out }, 502);

    const patch: Record<string, unknown> = { hiworks_approval_key: out.data.approval_key };
    if (pm_id) patch.hiworks_drafter_id = pm_id;
    await sb.from("programs").update(patch).eq("id", program_id);

    return json({ login_url: out.data.login_url, approval_key: out.data.approval_key });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
