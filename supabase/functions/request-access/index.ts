// CDMS 로그인 온보딩: 명부(users)에 있는 이메일만 가입 허용
//  - 신규: 초대메일 발송(inviteUserByEmail) → 사용자가 링크에서 비밀번호 설정
//  - 기존: {mode:"existing"} 반환 → 프런트가 resetPasswordForEmail로 재설정메일 발송
//  - 내용전문가(sme) 초대 시: Resend로 검수 매뉴얼 안내 메일을 추가 발송(매뉴얼 첨부 + 링크)
// 시크릿: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY(기본), CDMS_SITE_URL(선택), RESEND_API_KEY(매뉴얼 메일)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const URL = Deno.env.get("SUPABASE_URL")!;
const SR  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE = (Deno.env.get("CDMS_SITE_URL") || "https://cdms.mirimmedialab.co.kr").replace(/\/+$/, "");
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const MAIL_FROM = Deno.env.get("CDMS_MAIL_FROM") || "미림미디어랩 CDMS <noreply@noti.mirimmedialab.co.kr>";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// 내용전문가 매뉴얼 안내 메일 (초대 성공/기존 사용자 재초대 모두 발송)
// 실패해도 초대 자체에는 영향을 주지 않는다.
async function sendSmeManual(to: string, name: string): Promise<boolean> {
  if (!RESEND) return false;
  const manualUrl = SITE + "/manual_sme.html";
  const nm = (name || "").trim();
  const html = `
  <div style="font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif;max-width:560px;margin:0 auto;color:#1b2130;line-height:1.8">
    <div style="background:linear-gradient(135deg,#1f6f5c,#3aa07f);color:#fff;border-radius:12px;padding:26px 24px;text-align:center">
      <div style="font-size:20px;font-weight:800">미림미디어랩 CDMS</div>
      <div style="font-size:13px;opacity:.9;margin-top:4px">내용전문가(교수자)용 검수 안내</div>
    </div>
    <p style="margin:22px 0 10px">${nm ? nm + " 님, " : ""}안녕하세요. 미림미디어랩입니다.</p>
    <p>담당 과목의 <b>영상 검수</b>를 위해 CDMS(콘텐츠 제작관리 시스템)에 초대드렸습니다.
    별도로 발송된 <b>초대 메일의 링크</b>에서 비밀번호를 만들면 바로 이용하실 수 있습니다.</p>
    <table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px">
      <tr><td style="padding:8px 10px;background:#f4f6fa;border-radius:8px 8px 0 0"><b>접속 주소</b> &nbsp;<a href="${SITE}" style="color:#4b3fbb">${SITE.replace("https://", "")}</a></td></tr>
      <tr><td style="padding:8px 10px;background:#f4f6fa"><b>사용 매뉴얼</b> &nbsp;<a href="${manualUrl}" style="color:#4b3fbb">접속부터 영상검수까지 화면별 안내</a> (이 메일에 첨부된 파일과 동일)</td></tr>
      <tr><td style="padding:8px 10px;background:#f4f6fa;border-radius:0 0 8px 8px"><b>하시는 일</b> &nbsp;영상을 보며 원하는 시점에 코멘트를 남기면, 제작진에게 자동 전달됩니다.</td></tr>
    </table>
    <p style="font-size:13px;color:#697588">첨부된 <b>CDMS_내용전문가_매뉴얼.html</b> 파일을 더블클릭하면 브라우저에서 매뉴얼이 열립니다(인쇄 → PDF 저장 가능).
    로그인이 안 되거나 궁금한 점이 있으면 이 메일에 회신하거나 담당 PM에게 연락해 주세요.</p>
  </div>`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + RESEND, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [to],
        subject: "[미림미디어랩 CDMS] 내용전문가 검수 매뉴얼 안내",
        html,
        attachments: [{ path: manualUrl, filename: "CDMS_내용전문가_매뉴얼.html" }],
      }),
    });
    return r.ok;
  } catch (_e) { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, reason: "POST only" });
  try {
    const { email, roles, name } = await req.json();
    const em = (email || "").trim().toLowerCase();
    if (!em) return json({ ok: false, reason: "no_email" });
    const isSme = Array.isArray(roles) && roles.includes("sme");
    const admin = createClient(URL, SR, { auth: { persistSession: false } });
    const { data: dir } = await admin.from("users").select("id,email").ilike("email", em).limit(1);
    if (!dir || !dir.length) return json({ ok: false, reason: "not_listed" });
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const exists = (list?.users || []).find((u) => (u.email || "").toLowerCase() === em);
    if (exists) {
      const manual_sent = isSme ? await sendSmeManual(em, name || "") : false;
      return json({ ok: true, mode: "existing", manual_sent });
    }
    const { error } = await admin.auth.admin.inviteUserByEmail(em, { redirectTo: SITE });
    if (error) return json({ ok: false, reason: "메일 발송 실패 — Supabase Auth SMTP 설정이 필요합니다. (" + error.message + ")" });
    const manual_sent = isSme ? await sendSmeManual(em, name || "") : false;
    return json({ ok: true, mode: "invited", manual_sent });
  } catch (e) {
    return json({ ok: false, reason: String(e) });
  }
});
