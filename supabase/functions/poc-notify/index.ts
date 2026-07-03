// poc-notify: POC 개선의견 알림 메일
//  - daily: 매일 09:00 KST(pg_cron 00:00 UTC 호출) 최근 24시간 POC 의견을 어드민에게 요약 메일(캡처 이미지 첨부·인라인)
//  - update: 의견 수정(status/content) 처리 + 작성자·어드민에게 변경 내용 메일(이미지 포함) ※ 로그인 사용자 JWT 필요(작성자/어드민만)
//  - test: {email} 지정 주소로 다이제스트 강제 발송(cron_key 필요)
// 시크릿: agent_secrets.email_api_key(Resend), agent_secrets.email_from(선택), agent_secrets.nas_scan_cron_key(cron 인증)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SR_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CDMS_URL = (Deno.env.get("CDMS_SITE_URL") || "https://cdms.mirimmedialab.co.kr").replace(/\/+$/, "");
const EMAIL_FROM_DEFAULT = Deno.env.get("EMAIL_FROM") || "CDMS <noreply@mirimmedialab.co.kr>";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const J = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !/\.local$/i.test(e);
const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const STATUS_LABEL: Record<string, string> = { open: "접수", done: "처리완료" };

async function getSecret(sr: any, name: string): Promise<string> {
  const { data } = await sr.from("agent_secrets").select("value").eq("name", name).single();
  return (data?.value || "").trim();
}

function imgPart(dataUrl: string | null): { mime: string; b64: string } | null {
  const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl || "");
  return m ? { mime: m[1], b64: m[2] } : null;
}

async function sendResend(apiKey: string, from: string, to: string[], subject: string, html: string, attachments?: any[]): Promise<{ ok: boolean; error?: string }> {
  try {
    const body: any = { from, to, subject, html };
    if (attachments && attachments.length) body.attachments = attachments;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) CDMS-Edge/1.0" },
      body: JSON.stringify(body),
    });
    if (!r.ok) { const t = await r.text().catch(() => ""); return { ok: false, error: `HTTP ${r.status} ${t.slice(0, 200)}` }; }
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e as any)?.message || e) }; }
}

function fmtKST(iso: string): string {
  try { return new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return iso; }
}

function itemHtml(r: any, cid: string | null): string {
  return `<div style="border:1px solid #e3e6ee;border-radius:10px;padding:12px 14px;margin:10px 0">
    <div style="font-size:12px;color:#777"><b style="color:#1f3a5f">${esc(r.user_name || r.user_email || "-")}</b> · ${fmtKST(r.created_at)} · ${esc(r.page || "")} · <span style="color:${r.status === "done" ? "#2e7d32" : "#c0392b"}">${STATUS_LABEL[r.status] || esc(r.status)}</span></div>
    <div style="font-size:14px;margin-top:6px;white-space:pre-wrap">${esc(r.content)}</div>
    ${cid ? `<div style="margin-top:8px"><img src="cid:${cid}" style="max-width:560px;border:1px solid #e3e6ee;border-radius:8px" alt="캡처 이미지"></div>` : ""}
  </div>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const action = body.action || "daily";
  const sr = createClient(SB_URL, SR_KEY);

  // 어드민 이메일
  const { data: adminRows } = await sr.from("user_roles").select("user_id,users:user_id(email)").eq("role_code", "admin");
  const adminEmails: string[] = [...new Set((adminRows || []).map((r: any) => r.users?.email).filter((e: string) => e && validEmail(e)))] as string[];

  const apiKey = (await getSecret(sr, "email_api_key")) || (Deno.env.get("EMAIL_API_KEY") || "");
  const EMAIL_FROM = (await getSecret(sr, "email_from")) || EMAIL_FROM_DEFAULT;

  // ── daily / test: 어드민 다이제스트 (cron_key 인증) ──
  if (action === "daily" || action === "test") {
    const key = await getSecret(sr, "nas_scan_cron_key");
    if (!key || body.cron_key !== key) return J({ ok: false, error: "forbidden" }, 403);
    if (!apiKey) return J({ ok: false, error: "email_api_key 없음" }, 400);

    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: rows, error } = await sr.from("poc_feedback").select("*").gte("created_at", since).order("created_at");
    if (error) return J({ ok: false, error: error.message }, 500);
    if (!rows || !rows.length) {
      if (action === "daily") return J({ ok: true, sent: 0, note: "지난 24시간 신규 의견 없음" });
    }
    const to = action === "test" ? [String(body.email || "").trim()].filter(validEmail) : adminEmails;
    if (!to.length) return J({ ok: false, error: "수신자 없음(어드민 이메일 확인)" }, 400);

    const attachments: any[] = [];
    let items = "";
    (rows || []).forEach((r: any, i: number) => {
      let cid: string | null = null;
      const p = imgPart(r.image_b64);
      if (p && attachments.length < 15) {
        cid = `poc${i}`;
        attachments.push({ filename: `poc-${i + 1}.${p.mime.includes("png") ? "png" : "jpg"}`, content: p.b64, content_id: cid });
      }
      items += itemHtml(r, cid);
    });
    const html = `<div style="font-family:Apple SD Gothic Neo,Malgun Gothic,sans-serif;font-size:14px;color:#222;line-height:1.6">
      <p>안녕하세요, CDMS POC 알림입니다.</p>
      <p>지난 24시간 동안 등록된 <b>POC 개선의견 ${(rows || []).length}건</b>입니다.</p>
      ${items || "<p>신규 의견이 없습니다.</p>"}
      <p><a href="${CDMS_URL}" style="display:inline-block;background:#4b3fbb;color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px">CDMS에서 확인하기</a></p>
      <p style="color:#999;font-size:12px">이 메일은 매일 오전 9시에 어드민에게 자동 발송됩니다.</p>
    </div>`;
    const r = await sendResend(apiKey, EMAIL_FROM, to, `[CDMS] POC 개선의견 일일 요약 — ${(rows || []).length}건`, html, attachments);
    return J({ ok: r.ok, sent: r.ok ? to.length : 0, count: (rows || []).length, error: r.error });
  }

  // ── update: 의견 수정 + 변경 알림 (로그인 JWT 인증, 작성자/어드민만) ──
  if (action === "update") {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: ud } = await sr.auth.getUser(token);
    const user = ud?.user;
    if (!user) return J({ ok: false, error: "로그인이 필요합니다" }, 401);

    const id = String(body.id || "");
    const set: any = {};
    if (body.set && typeof body.set.status === "string" && ["open", "done"].includes(body.set.status)) set.status = body.set.status;
    if (body.set && typeof body.set.content === "string" && body.set.content.trim()) set.content = body.set.content.trim();
    if (!id || !Object.keys(set).length) return J({ ok: false, error: "id/set 필요" }, 400);

    const { data: old } = await sr.from("poc_feedback").select("*").eq("id", id).single();
    if (!old) return J({ ok: false, error: "의견을 찾을 수 없습니다" }, 404);

    const { data: myRoles } = await sr.from("user_roles").select("role_code").eq("user_id", user.id).eq("role_code", "admin");
    const isAdmin = !!(myRoles && myRoles.length);
    if (!isAdmin && old.user_id !== user.id) return J({ ok: false, error: "권한이 없습니다(작성자/어드민만)" }, 403);

    const { error: ue } = await sr.from("poc_feedback").update(set).eq("id", id);
    if (ue) return J({ ok: false, error: ue.message }, 500);

    // 변경자 이름
    const { data: actor } = await sr.from("users").select("name,email").eq("id", user.id).single();
    const actorName = actor?.name || user.email || "-";

    // 변경 내역 표
    let diff = "";
    if (set.status && set.status !== old.status) {
      diff += `<tr><td style="padding:4px 10px;color:#777">상태</td><td style="padding:4px 10px"><s style="color:#999">${STATUS_LABEL[old.status] || esc(old.status)}</s> → <b style="color:${set.status === "done" ? "#2e7d32" : "#c0392b"}">${STATUS_LABEL[set.status]}</b></td></tr>`;
    }
    if (set.content && set.content !== old.content) {
      diff += `<tr><td style="padding:4px 10px;color:#777;vertical-align:top">내용(수정 전)</td><td style="padding:4px 10px;color:#999;white-space:pre-wrap"><s>${esc(old.content)}</s></td></tr>
               <tr><td style="padding:4px 10px;color:#777;vertical-align:top">내용(수정 후)</td><td style="padding:4px 10px;white-space:pre-wrap"><b>${esc(set.content)}</b></td></tr>`;
    }
    if (!diff) return J({ ok: true, mailed: 0, note: "변경 사항 없음" });

    // 수신자: 작성자 + 어드민
    const rcpts = [...new Set([...(validEmail(old.user_email || "") ? [old.user_email] : []), ...adminEmails])];
    let mailErr: string | undefined;
    if (apiKey && rcpts.length) {
      const attachments: any[] = [];
      let imgTag = "";
      const p = imgPart(old.image_b64);
      if (p) { attachments.push({ filename: `poc.${p.mime.includes("png") ? "png" : "jpg"}`, content: p.b64, content_id: "poc0" }); imgTag = `<div style="margin-top:8px"><img src="cid:poc0" style="max-width:560px;border:1px solid #e3e6ee;border-radius:8px" alt="캡처 이미지"></div>`; }
      const html = `<div style="font-family:Apple SD Gothic Neo,Malgun Gothic,sans-serif;font-size:14px;color:#222;line-height:1.6">
        <p>안녕하세요, CDMS POC 알림입니다.</p>
        <p><b>${esc(old.user_name || old.user_email || "-")}</b>님이 ${fmtKST(old.created_at)}에 등록한 POC 의견이 <b>${esc(actorName)}</b>님에 의해 수정되었습니다.</p>
        <table style="border-collapse:collapse;margin:12px 0;border:1px solid #e3e6ee;border-radius:8px">${diff}</table>
        <div style="border:1px solid #e3e6ee;border-radius:10px;padding:12px 14px;margin:10px 0">
          <div style="font-size:12px;color:#777">원본 의견 · ${esc(old.page || "")}</div>
          <div style="font-size:14px;margin-top:6px;white-space:pre-wrap">${esc(set.content || old.content)}</div>
          ${imgTag}
        </div>
        <p><a href="${CDMS_URL}" style="display:inline-block;background:#4b3fbb;color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px">CDMS에서 확인하기</a></p>
      </div>`;
      const r = await sendResend(apiKey, EMAIL_FROM, rcpts, `[CDMS] POC 의견 수정 알림 — ${esc(old.user_name || "")}님 의견`, html, attachments);
      if (!r.ok) mailErr = r.error;
    }
    return J({ ok: true, mailed: mailErr ? 0 : rcpts.length, mail_error: mailErr });
  }

  return J({ ok: false, error: "unknown action" }, 400);
});
