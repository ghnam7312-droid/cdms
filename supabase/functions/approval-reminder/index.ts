// approval-reminder: PM은 지정됐으나 품의(전자결재)가 안 된 사업을,
//   PM + 어드민에게 2일마다 이메일로 독촉. (pg_cron이 매일 호출 → 사업별 2일 간격 가드)
//  actions: run(기본, 발송) / preview(대상만) / test({email}, 강제 1통)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SR_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const J = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const INTERVAL_DAYS = 2;
const CDMS_URL = (Deno.env.get("CDMS_SITE_URL") || "https://cdms.mirimmedialab.co.kr").replace(/\/+$/, "");
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") || "CDMS <noreply@mirimmedialab.co.kr>";
const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !/\.local$/i.test(e);

async function getSecret(sr: any, name: string): Promise<string> {
  const { data } = await sr.from("agent_secrets").select("value").eq("name", name).single();
  return (data?.value || "").trim();
}

async function sendResend(apiKey: string, to: string[], subject: string, html: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) CDMS-Edge/1.0",
      },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
    });
    if (!r.ok) { const t = await r.text().catch(() => ""); return { ok: false, error: `HTTP ${r.status} ${t.slice(0, 200)}` }; }
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e as any)?.message || e) }; }
}

function bodyHtml(progName: string, pmName: string): string {
  return `<div style="font-family:Apple SD Gothic Neo,Malgun Gothic,sans-serif;font-size:14px;color:#222;line-height:1.6">
    <p>안녕하세요, CDMS 알림입니다.</p>
    <p>아래 사업은 <b>PM이 지정되었으나 아직 품의(전자결재)가 진행되지 않았습니다.</b><br>
       담당 PM과 관리자께서는 품의를 진행해 주시기 바랍니다.</p>
    <table style="border-collapse:collapse;margin:12px 0">
      <tr><td style="padding:4px 10px;color:#777">사업명</td><td style="padding:4px 10px;font-weight:700">${progName}</td></tr>
      <tr><td style="padding:4px 10px;color:#777">담당 PM</td><td style="padding:4px 10px">${pmName || "-"}</td></tr>
      <tr><td style="padding:4px 10px;color:#777">상태</td><td style="padding:4px 10px;color:#c0392b">품의 미완료</td></tr>
    </table>
    <p><a href="${CDMS_URL}" style="display:inline-block;background:#4b3fbb;color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px">CDMS에서 품의 진행하기</a></p>
    <p style="color:#999;font-size:12px">이 메일은 품의가 완료될 때까지 ${INTERVAL_DAYS}일마다 발송됩니다.</p>
  </div>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const action = body.action || "run";
  const sr = createClient(SB_URL, SR_KEY);

  // 인증: nas_scan_cron_key 재사용
  const key = await getSecret(sr, "nas_scan_cron_key");
  if (!key || body.cron_key !== key) return J({ ok: false, error: "forbidden" }, 403);

  // 대상: PM 지정 + 품의 미완료 + 미완결(settled != true)  (programs.pm_id에 FK가 없어 임베드 대신 별도 조회)
  const { data: progs } = await sr.from("programs")
    .select("id,name,approval_status,settled,pm_id")
    .not("pm_id", "is", null)
    .order("name");
  const eligible = (progs || []).filter((p: any) => p.settled !== true && (p.approval_status || "") !== "품의완료");
  const pmIds = [...new Set(eligible.map((p: any) => p.pm_id).filter(Boolean))];
  const { data: pmUsers } = pmIds.length ? await sr.from("users").select("id,name,email").in("id", pmIds) : { data: [] };
  const umap: Record<string, any> = {}; (pmUsers || []).forEach((u: any) => umap[u.id] = u);
  const pmOf = (p: any) => umap[p.pm_id] || {};

  // 어드민 이메일
  const { data: adminRows } = await sr.from("user_roles").select("user_id,users:user_id(email)").eq("role_code", "admin");
  const adminEmails = (adminRows || []).map((r: any) => r.users?.email).filter((e: string) => e && validEmail(e));

  if (action === "preview") {
    return J({ ok: true, count: eligible.length, admins: adminEmails, programs: eligible.map((p: any) => ({ name: p.name, pm: pmOf(p).name, pm_email: pmOf(p).email, status: p.approval_status })) });
  }

  const apiKey = (await getSecret(sr, "email_api_key")) || (Deno.env.get("EMAIL_API_KEY") || "");
  if (!apiKey) return J({ ok: false, error: "이메일 API 키(agent_secrets.email_api_key 또는 EMAIL_API_KEY)가 없습니다." }, 400);

  // test: 강제로 1통
  if (action === "test") {
    const to = String(body.email || "").trim();
    if (!validEmail(to)) return J({ ok: false, error: "유효한 email 필요" }, 400);
    const r = await sendResend(apiKey, [to], "[CDMS] 품의 진행 요청 (테스트)", bodyHtml("(테스트 사업)", "(PM)"));
    return J({ ok: r.ok, error: r.error });
  }

  // 발송 기록 로드
  const { data: rem } = await sr.from("approval_reminders").select("program_id,last_sent_at");
  const lastMap: Record<string, string | null> = {};
  (rem || []).forEach((x: any) => lastMap[x.program_id] = x.last_sent_at);
  const cutoff = Date.now() - INTERVAL_DAYS * 24 * 3600 * 1000;

  const results: any[] = [];
  for (const p of eligible) {
    const last = lastMap[(p as any).id];
    if (last && new Date(last).getTime() > cutoff) { results.push({ p: (p as any).name, skipped: "간격내" }); continue; }
    const pmEmail = pmOf(p).email;
    const rcpts = Array.from(new Set([...(validEmail(pmEmail || "") ? [pmEmail] : []), ...adminEmails]));
    if (!rcpts.length) { results.push({ p: (p as any).name, skipped: "수신자없음" }); continue; }
    const r = await sendResend(apiKey, rcpts, `[CDMS] 품의 진행 요청 — ${(p as any).name}`, bodyHtml((p as any).name, pmOf(p).name || ""));
    if (r.ok) {
      await sr.from("approval_reminders").upsert(
        { program_id: (p as any).id, last_sent_at: new Date().toISOString(), send_count: 1 },
        { onConflict: "program_id" });
      results.push({ p: (p as any).name, sent_to: rcpts });
    } else {
      results.push({ p: (p as any).name, error: r.error });
    }
  }
  return J({ ok: true, eligible: eligible.length, results });
});
