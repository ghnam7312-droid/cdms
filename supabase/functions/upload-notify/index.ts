// upload-notify: CDMS 업로드 파일의 검사(scan_file)가 끝나면 올린 사람에게 결과 메일 발송.
//  pg_cron이 1분마다 호출 → notified_at 이 비어있는 done/error scan_file 작업을 처리.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SR_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const J = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const CDMS_URL = (Deno.env.get("CDMS_SITE_URL") || "https://cdms.mirimmedialab.co.kr").replace(/\/+$/, "");
const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !/\.local$/i.test(e);

async function getSecret(sr: any, name: string): Promise<string> {
  const { data } = await sr.from("agent_secrets").select("value").eq("name", name).single();
  return (data?.value || "").trim();
}
async function sendResend(apiKey: string, from: string, to: string[], subject: string, html: string) {
  try {
    const r = await fetch("https://api.resend.com/emails", { method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Mozilla/5.0 CDMS-Edge/1.0" },
      body: JSON.stringify({ from, to, subject, html }) });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} ${(await r.text().catch(()=> "")).slice(0,160)}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e as any)?.message || e) }; }
}
const wrap = (inner: string) => `<div style="font-family:Apple SD Gothic Neo,Malgun Gothic,sans-serif;font-size:14px;color:#222;line-height:1.7">${inner}<p style="margin-top:16px"><a href="${CDMS_URL}" style="display:inline-block;background:#4b3fbb;color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px">CDMS 열기</a></p></div>`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const sr = createClient(SB_URL, SR_KEY);
  const key = await getSecret(sr, "nas_scan_cron_key");
  if (!key || body.cron_key !== key) return J({ ok: false, error: "forbidden" }, 403);

  const apiKey = (await getSecret(sr, "email_api_key")) || (Deno.env.get("EMAIL_API_KEY") || "");
  const from = (await getSecret(sr, "email_from")) || "CDMS <noreply@noti.mirimmedialab.co.kr>";
  if (!apiKey) return J({ ok: false, error: "email_api_key 없음" }, 400);

  // 최근 6시간 내, 아직 알림 안 보낸 done/error scan_file 작업
  const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const { data: tasks } = await sr.from("nas_tasks")
    .select("id,status,result,params,project_id,created_by")
    .eq("action", "scan_file").is("notified_at", null).in("status", ["done", "error"])
    .gte("created_at", since).limit(50);

  const results: any[] = [];
  for (const t of (tasks || [])) {
    const p = (t as any).params || {}; const res = (t as any).result || {};
    const name = p.name || "(파일)";
    const uid = p.notify_user || (t as any).created_by;
    // 프로젝트명
    let projName = "";
    if ((t as any).project_id) { const { data: pr } = await sr.from("projects").select("name").eq("id", (t as any).project_id).single(); projName = pr?.name || ""; }
    // 수신자 이메일
    let email = "";
    if (uid) { const { data: u } = await sr.from("users").select("email").eq("id", uid).single(); email = u?.email || ""; }

    let doSend = false, subject = "", html = "";
    if ((t as any).status === "done" && res.clean === true) {
      doSend = true; subject = `[CDMS] ✓ 업로드 완료 — ${name}`;
      html = wrap(`<p><b>업로드하신 파일의 검사가 완료되어 NAS에 반영되었습니다.</b></p>
        <table style="border-collapse:collapse;margin:10px 0">
          <tr><td style="padding:3px 10px;color:#777">파일</td><td style="padding:3px 10px;font-weight:700">${name}</td></tr>
          ${projName ? `<tr><td style="padding:3px 10px;color:#777">과정</td><td style="padding:3px 10px">${projName}</td></tr>` : ""}
          <tr><td style="padding:3px 10px;color:#777">상태</td><td style="padding:3px 10px;color:#1d6e4a">✓ 검사 통과 · 저장 완료</td></tr>
        </table>`);
    } else if ((t as any).status === "error") {
      doSend = true; subject = `[CDMS] ⚠ 업로드 처리 실패 — ${name}`;
      const err = res.error || "알 수 없는 오류";
      html = wrap(`<p><b>업로드하신 파일이 NAS 작업 폴더에 반영되지 못했습니다.</b></p>
        <table style="border-collapse:collapse;margin:10px 0">
          <tr><td style="padding:3px 10px;color:#777">파일</td><td style="padding:3px 10px;font-weight:700">${name}</td></tr>
          ${projName ? `<tr><td style="padding:3px 10px;color:#777">과정</td><td style="padding:3px 10px">${projName}</td></tr>` : ""}
          <tr><td style="padding:3px 10px;color:#777">사유</td><td style="padding:3px 10px;color:#c0392b">${String(err).slice(0,200)}</td></tr>
        </table>
        <p>같은 파일을 다시 업로드해 주세요. 반복되면 관리자에게 알려주세요.</p>`);
    }
    // 바이러스 탐지(done+clean=false)는 워커가 이미 통보 → 여기선 발송 생략, 기록만
    let sent = false, error: string | undefined;
    if (doSend && validEmail(email)) { const r = await sendResend(apiKey, from, [email], subject, html); sent = r.ok; error = r.error; }
    await sr.from("nas_tasks").update({ notified_at: new Date().toISOString() }).eq("id", (t as any).id);
    results.push({ name, to: email || "(없음)", sent, skipped: doSend ? undefined : "virus/other", error });
  }
  return J({ ok: true, processed: results.length, results });
});
