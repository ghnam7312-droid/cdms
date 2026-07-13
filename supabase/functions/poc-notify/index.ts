// poc-notify: POC 개선의견 알림 메일
//  - daily: 매일 09:00 KST(pg_cron 00:00 UTC 호출) 최근 24시간 POC 의견을 어드민에게 요약 메일(캡처 이미지 첨부·인라인)
//  - update: 의견 수정(status/content) 처리 + 작성자·어드민에게 변경 내용 메일(이미지 포함) ※ 로그인 사용자 JWT 필요(작성자/어드민만)
//  - test: {email} 지정 주소로 다이제스트 강제 발송(cron_key 필요)
//  - usage_daily: 일일 사용현황 요약을 활성 사용자 전원에게 발송(cron_key 필요, 2026-07-24까지 · body.email 지정 시 테스트 발송)
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
// 리치텍스트(HTML) 내용을 메일용 일반 텍스트로 (태그 제거)
const plainText = (s: unknown) => String(s ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim();
const STATUS_LABEL: Record<string, string> = { open: "접수", done: "처리완료", final: "🏁 최종 완료" };

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
    <div style="font-size:12px;color:#777"><b style="color:#4b3fbb">#${r.no ?? "-"}</b> <b style="color:#1f3a5f">${esc(r.user_name || r.user_email || "-")}</b> · ${fmtKST(r.created_at)} · ${esc(r.page || "")} · <span style="color:${r.status === "done" ? "#2e7d32" : "#c0392b"}">${STATUS_LABEL[r.status] || esc(r.status)}</span></div>
    <div style="font-size:14px;margin-top:6px;white-space:pre-wrap">${esc(plainText(r.content))}</div>
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
    const { data: rows, error } = await sr.from("poc_feedback").select("*").gte("created_at", since).is("deleted_at", null).order("created_at");
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
    if (body.set && typeof body.set.status === "string" && ["open", "done", "final"].includes(body.set.status)) set.status = body.set.status;
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
      diff += `<tr><td style="padding:4px 10px;color:#777">상태</td><td style="padding:4px 10px"><s style="color:#999">${STATUS_LABEL[old.status] || esc(old.status)}</s> → <b style="color:${set.status === "open" ? "#c0392b" : "#2e7d32"}">${STATUS_LABEL[set.status]}</b></td></tr>`;
    }
    if (set.content && set.content !== old.content) {
      diff += `<tr><td style="padding:4px 10px;color:#777;vertical-align:top">내용(수정 전)</td><td style="padding:4px 10px;color:#999;white-space:pre-wrap"><s>${esc(plainText(old.content))}</s></td></tr>
               <tr><td style="padding:4px 10px;color:#777;vertical-align:top">내용(수정 후)</td><td style="padding:4px 10px;white-space:pre-wrap"><b>${esc(plainText(set.content))}</b></td></tr>`;
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
        <p><b>${esc(old.user_name || old.user_email || "-")}</b>님이 ${fmtKST(old.created_at)}에 등록한 POC 의견 <b>#${old.no ?? "-"}</b>이(가) <b>${esc(actorName)}</b>님에 의해 수정되었습니다.</p>
        <table style="border-collapse:collapse;margin:12px 0;border:1px solid #e3e6ee;border-radius:8px">${diff}</table>
        <div style="border:1px solid #e3e6ee;border-radius:10px;padding:12px 14px;margin:10px 0">
          <div style="font-size:12px;color:#777">원본 의견 · ${esc(old.page || "")}</div>
          <div style="font-size:14px;margin-top:6px;white-space:pre-wrap">${esc(plainText(set.content || old.content))}</div>
          ${imgTag}
        </div>
        <p><a href="${CDMS_URL}" style="display:inline-block;background:#4b3fbb;color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px">CDMS에서 확인하기</a></p>
      </div>`;
      const r = await sendResend(apiKey, EMAIL_FROM, rcpts, `[CDMS] POC 의견 수정 알림 — ${esc(old.user_name || "")}님 의견`, html, attachments);
      if (!r.ok) mailErr = r.error;
    }
    return J({ ok: true, mailed: mailErr ? 0 : rcpts.length, mail_error: mailErr });
  }

  // ── reply: 의견에 답변 등록 + 작성자·어드민 메일 (로그인 JWT 인증) ──
  if (action === "reply") {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: ud } = await sr.auth.getUser(token);
    const user = ud?.user;
    if (!user) return J({ ok: false, error: "로그인이 필요합니다" }, 401);

    const fid = String(body.feedback_id || "");
    const content = String(body.content || "").trim();
    if (!fid || !content) return J({ ok: false, error: "feedback_id/content 필요" }, 400);

    const { data: fb } = await sr.from("poc_feedback").select("*").eq("id", fid).single();
    if (!fb) return J({ ok: false, error: "의견을 찾을 수 없습니다" }, 404);

    const { data: actor } = await sr.from("users").select("name,email").eq("id", user.id).single();
    const actorName = actor?.name || user.email || "-";

    const { error: ie } = await sr.from("poc_replies").insert({ feedback_id: fid, user_id: user.id, user_name: actorName, content });
    if (ie) return J({ ok: false, error: ie.message }, 500);

    // 수신자: 의견 작성자 + 어드민 (답변자 본인 제외)
    const myEmail = (actor?.email || user.email || "").toLowerCase();
    const rcpts = [...new Set([...(validEmail(fb.user_email || "") ? [fb.user_email] : []), ...adminEmails])]
      .filter((e: string) => e.toLowerCase() !== myEmail);
    let mailErr: string | undefined;
    if (apiKey && rcpts.length) {
      const attachments: any[] = [];
      let imgTag = "";
      const p = imgPart(fb.image_b64);
      if (p) { attachments.push({ filename: `poc.${p.mime.includes("png") ? "png" : "jpg"}`, content: p.b64, content_id: "poc0" }); imgTag = `<div style="margin-top:8px"><img src="cid:poc0" style="max-width:560px;border:1px solid #e3e6ee;border-radius:8px" alt="캡처 이미지"></div>`; }
      const html = `<div style="font-family:Apple SD Gothic Neo,Malgun Gothic,sans-serif;font-size:14px;color:#222;line-height:1.6">
        <p>안녕하세요, CDMS POC 알림입니다.</p>
        <p><b>${esc(fb.user_name || fb.user_email || "-")}</b>님이 ${fmtKST(fb.created_at)}에 등록한 POC 의견 <b>#${fb.no ?? "-"}</b>에 <b>${esc(actorName)}</b>님이 답변했습니다.</p>
        <div style="border:1px solid #e3e6ee;border-radius:10px;padding:12px 14px;margin:10px 0;background:#fafbfd">
          <div style="font-size:12px;color:#777">원본 의견 · ${esc(fb.page || "")}</div>
          <div style="font-size:14px;margin-top:6px;white-space:pre-wrap">${esc(plainText(fb.content))}</div>
          ${imgTag}
        </div>
        <div style="border:1px solid #cfe0d5;border-radius:10px;padding:12px 14px;margin:10px 0">
          <div style="font-size:12px;color:#2e7d32">💬 ${esc(actorName)}님의 답변</div>
          <div style="font-size:14px;margin-top:6px;white-space:pre-wrap">${esc(plainText(content))}</div>
        </div>
        <p><a href="${CDMS_URL}" style="display:inline-block;background:#4b3fbb;color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px">CDMS에서 확인하기</a></p>
      </div>`;
      const r = await sendResend(apiKey, EMAIL_FROM, rcpts, `[CDMS] POC 의견 답변 — ${esc(actorName)}님`, html, attachments);
      if (!r.ok) mailErr = r.error;
    }
    return J({ ok: true, mailed: mailErr ? 0 : rcpts.length, mail_error: mailErr });
  }

  // ── review_comment: 검수 코멘트 등록 시 해당 차시 종편 담당자에게 메일 (로그인 JWT 인증) ──
  if (action === "review_comment") {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: ud } = await sr.auth.getUser(token);
    const user = ud?.user;
    if (!user) return J({ ok: false, error: "로그인이 필요합니다" }, 401);

    const lid = String(body.lesson_id || "");
    const text = String(body.comment || "").trim();
    if (!lid) return J({ ok: false, error: "lesson_id 필요" }, 400);

    const { data: les } = await sr.from("lessons").select("id,lesson_no,title,project_id,week:weeks(week_no)").eq("id", lid).single();
    if (!les) return J({ ok: false, error: "차시를 찾을 수 없습니다" }, 404);
    const { data: ls } = await sr.from("lesson_stage").select("assignee").eq("lesson_id", lid).eq("stage_id", 7).maybeSingle();
    const asg = ls?.assignee;
    if (!asg || asg === user.id) return J({ ok: true, mailed: 0, note: "종편 담당자 없음 또는 본인 코멘트" });
    const { data: u } = await sr.from("users").select("name,email").eq("id", asg).single();
    if (!u?.email || !validEmail(u.email) || !apiKey) return J({ ok: true, mailed: 0, note: "담당자 이메일 없음" });

    const { data: prj } = await sr.from("projects").select("name").eq("id", (les as any).project_id).single();
    const { data: actor } = await sr.from("users").select("name").eq("id", user.id).single();
    const actorName = actor?.name || user.email || "-";
    const wk = (les as any).week?.week_no;
    const ttl = (wk ? wk + "주차 " : "") + (les as any).lesson_no + "차시" + ((les as any).title ? " · " + (les as any).title : "");
    const ts = Math.max(0, Math.floor(Number(body.t_sec) || 0));
    const mmss = Math.floor(ts / 60) + ":" + String(ts % 60).padStart(2, "0");
    const html = `<div style="font-family:Apple SD Gothic Neo,Malgun Gothic,sans-serif;font-size:14px;color:#222;line-height:1.6">
      <p>안녕하세요, CDMS 검수 알림입니다.</p>
      <p>담당하고 계신 종편 영상에 <b>${esc(actorName)}</b>님이 검수 코멘트를 남겼습니다.</p>
      <table style="border-collapse:collapse;margin:12px 0">
        <tr><td style="padding:4px 10px;color:#777">과정</td><td style="padding:4px 10px;font-weight:700">${esc(prj?.name || "")}</td></tr>
        <tr><td style="padding:4px 10px;color:#777">차시</td><td style="padding:4px 10px">${esc(ttl)}</td></tr>
        <tr><td style="padding:4px 10px;color:#777">시점</td><td style="padding:4px 10px">${mmss}</td></tr>
      </table>
      <div style="border:1px solid #e3e6ee;border-radius:10px;padding:12px 14px;margin:10px 0;white-space:pre-wrap">${esc(plainText(text) || "(그림 피드백)")}</div>
      <p><a href="${CDMS_URL}" style="display:inline-block;background:#4b3fbb;color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px">CDMS에서 확인하기</a></p>
      <p style="color:#999;font-size:12px">해당 차시의 '영상검수'에서 코멘트 시점을 클릭하면 그 장면으로 이동합니다.</p>
    </div>`;
    const r = await sendResend(apiKey, EMAIL_FROM, [u.email], `[CDMS] 검수 코멘트 — ${prj?.name || ""} ${(wk ? wk + "주차 " : "")}${(les as any).lesson_no}차시`, html);
    return J({ ok: true, mailed: r.ok ? 1 : 0, mail_error: r.error });
  }

  // ── usage_daily: 일일 사용현황 요약을 활성(로그인 가능) 사용자 전원에게 발송 (cron_key 인증, 2026-07-24까지) ──
  if (action === "usage_daily") {
    const key = await getSecret(sr, "nas_scan_cron_key");
    if (!key || body.cron_key !== key) return J({ ok: false, error: "forbidden" }, 403);
    if (!apiKey) return J({ ok: false, error: "email_api_key 없음" }, 400);
    const todayKST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
    const UNTIL = "2026-07-24"; // POC 기간 종료일 — 이후 자동 중단(빈 응답)
    if (todayKST > UNTIL && !body.email) return J({ ok: true, sent: 0, note: `발송 기간 종료(${UNTIL}까지)` });

    // 수신자: 계정을 활성화(가입 완료)한 사용자 전원. body.email 지정 시 그 주소로만(테스트).
    let to: string[] = [];
    if (body.email) { to = [String(body.email).trim()].filter(validEmail); }
    else {
      const { data: au } = await (sr as any).auth.admin.listUsers({ page: 1, perPage: 1000 });
      to = [...new Set(((au?.users) || []).map((u: any) => String(u.email || "")).filter(validEmail))] as string[];
    }
    if (!to.length) return J({ ok: false, error: "수신자 없음" }, 400);

    const EVL: Record<string, string> = { login: "로그인", course_view: "과정 열람", review_open: "영상검수", comment: "검수 코멘트", upload: "파일 업로드", file_open: "파일 열람", poc: "POC 의견", status_change: "상태 변경" };
    const EVK = Object.keys(EVL);
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: evs, error: ee } = await sr.from("usage_events").select("user_id,user_name,event").gte("created_at", since).limit(10000);
    if (ee) return J({ ok: false, error: ee.message }, 500);
    const byU: Record<string, { name: string; ev: Record<string, number>; n: number }> = {};
    (evs || []).forEach((e: any) => {
      const k = String(e.user_id || e.user_name || "?");
      const o = byU[k] = byU[k] || { name: e.user_name || "-", ev: {}, n: 0 };
      o.ev[e.event] = (o.ev[e.event] || 0) + 1; o.n++;
    });
    const uarr = Object.values(byU).sort((a, b) => b.n - a.n);
    const tot: Record<string, number> = {}; let totN = 0;
    uarr.forEach((u) => { EVK.forEach((k) => { tot[k] = (tot[k] || 0) + (u.ev[k] || 0); }); totN += u.n; });
    const td = (v: number) => `<td style="padding:5px 8px;text-align:right;border:1px solid #e3e6ee;${v ? "" : "color:#c9ced9"}">${v || "·"}</td>`;
    const table = uarr.length ? `<table style="border-collapse:collapse;font-size:13px;margin:12px 0">
      <tr style="background:#f3f5fa"><th style="padding:5px 8px;border:1px solid #e3e6ee;text-align:left">사용자</th>${EVK.map((k) => `<th style="padding:5px 8px;border:1px solid #e3e6ee">${EVL[k]}</th>`).join("")}<th style="padding:5px 8px;border:1px solid #e3e6ee">합계</th></tr>
      ${uarr.map((u) => `<tr><td style="padding:5px 8px;border:1px solid #e3e6ee;white-space:nowrap"><b>${esc(u.name)}</b></td>${EVK.map((k) => td(u.ev[k] || 0)).join("")}<td style="padding:5px 8px;text-align:right;border:1px solid #e3e6ee;font-weight:700">${u.n}</td></tr>`).join("")}
      <tr style="background:#fafbfd"><td style="padding:5px 8px;border:1px solid #e3e6ee;color:#777">합계</td>${EVK.map((k) => td(tot[k] || 0)).join("")}<td style="padding:5px 8px;text-align:right;border:1px solid #e3e6ee;font-weight:700">${totN}</td></tr>
    </table>` : `<p style="color:#999">지난 24시간 동안 기록된 활동이 없습니다.</p>`;

    const { count: allN } = await sr.from("usage_events").select("id", { count: "exact", head: true });
    const html = `<div style="font-family:Apple SD Gothic Neo,Malgun Gothic,sans-serif;font-size:14px;color:#222;line-height:1.6">
      <p>안녕하세요, CDMS POC 사용현황 알림입니다.</p>
      <p><b>지난 24시간</b> 동안 <b>${uarr.length}명</b>이 <b>${totN}건</b>의 활동을 남겼습니다. <span style="color:#999">(POC 누적 ${allN ?? "-"}건)</span></p>
      ${table}
      <p><a href="${CDMS_URL}" style="display:inline-block;background:#4b3fbb;color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px">CDMS 바로가기</a></p>
      <p style="color:#999;font-size:12px">POC 기간(7월 24일까지) 동안 매일 오전 9시에 활성 사용자에게 자동 발송됩니다.</p>
    </div>`;
    const r = await sendResend(apiKey, EMAIL_FROM, to, `[CDMS] 사용현황 일일 요약 — ${todayKST}`, html);
    return J({ ok: r.ok, sent: r.ok ? to.length : 0, users: uarr.length, events: totN, error: r.error });
  }

  return J({ ok: false, error: "unknown action" }, 400);
});
