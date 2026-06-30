// CDMS ↔ 하이웍스 전자결재 : 품의 기안(상신 페이지 생성)
// 양식 N68 (프로젝트 품의서). 하이웍스는 contents가 본문을 대체하므로,
// N68 표 서식을 본문으로 직접 구성해 사업 데이터를 채워 보낸다.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OFFICE_TOKEN = Deno.env.get("HIWORKS_OFFICE_TOKEN_DRAFT")!;
// 양식 id N68 고정 (필요 시 HIWORKS_FORM_ID 로 재정의)
const FORM_ID      = (Deno.env.get("HIWORKS_FORM_ID") || "N68").trim() || "N68";
const CALLBACK_URL = Deno.env.get("HIWORKS_CALLBACK_URL")!;
const API_BASE     = (Deno.env.get("HIWORKS_API_BASE") || "https://api.hiworks.com").replace(/\/+$/, "");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const esc = (s: unknown) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const won = (n: unknown) => (n == null || n === "") ? "" : Number(n).toLocaleString("ko-KR") + "원";

function n68Body(prog: any): string {
  const period = (prog.contract_start || prog.contract_end)
    ? `${prog.contract_start ?? ""} ~ ${prog.contract_end ?? ""}` : "";
  const c = "background:#f2f2f2;font-weight:bold;width:130px";
  const td = "border:1px solid #999;padding:6px";
  return (
    `<table style="border-collapse:collapse;width:100%">` +
    `<tr><td style="${td};${c}">프로젝트명</td><td style="${td}">${esc(prog.name)}</td></tr>` +
    `<tr><td style="${td};${c}">주요 내용</td><td style="${td}"><br><br></td></tr>` +
    `<tr><td style="${td};${c}">계약기간</td><td style="${td}">${esc(period)}</td></tr>` +
    `<tr><td style="${td};${c}">매출액(VAT제외)</td><td style="${td}">${esc(won(prog.amount))}</td></tr>` +
    `<tr><td style="${td};${c}">개발방식</td><td style="${td}"></td></tr>` +
    `</table>` +
    `<p style="font-weight:bold;margin-top:10px">외주경비</p>` +
    `<table style="border-collapse:collapse;width:100%">` +
    `<tr style="background:#f2f2f2;font-weight:bold"><td style="${td}">구분</td><td style="${td}">단위</td><td style="${td}">단가</td><td style="${td}">금액</td><td style="${td}">비고</td></tr>` +
    `<tr><td style="${td}"><br></td><td style="${td}"></td><td style="${td}"></td><td style="${td}"></td><td style="${td}"></td></tr>` +
    `</table>`
  );
}

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
    const payload: Record<string, unknown> = {
      form_id: FORM_ID,
      subject: subj,
      contents: (contents && String(contents).trim()) ? contents : n68Body(prog),
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
