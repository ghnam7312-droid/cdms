// CDMS 매출 동기화: '2026년도 매출 현황' 공개 CSV → programs (고객명·금액·기간·PM)
// pg_cron 이 매일 호출. 번호=seq 매칭, 없으면 신규. 사업명·과목·차시는 미변경.
// 신규 사업(insert) 발생 시 어드민에게 메일(Resend)+하이웍스 메신저(/office/v2/notify) 알림.
// 시크릿 미설정 시 해당 채널만 graceful skip. ?notify_test=1 로 알림 채널만 단독 테스트.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const HIWORKS_TOKEN = Deno.env.get("HIWORKS_NOTIFY_TOKEN") || "";
const MAIL_FROM = Deno.env.get("NOTIFY_MAIL_FROM") || "CDMS 알림 <noreply@noti.mirimmedialab.co.kr>";
const CDMS_URL = "https://cdms.mirimmedialab.co.kr";
const LOGO = "https://mirimmedialab.co.kr/img/inc/logo.png";
const ADMIN = "51610d59-8b8a-4497-aabe-0fcc997baf28";
const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTFnJShfiQ4KxPa3TNkgIdfXcEtDdarf149im9TIMU131sWQ5_5dGjRtAnWAoamtT-SS649ws-JGi7-/pub?gid=545055052&single=true&output=csv";
const TITLES = ["책임","선임","팀장","파트장","파트","실장","대리","사원","수석","연구원","매니저"];
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const won = (n: number|null) => n == null ? "" : n.toLocaleString("ko-KR") + "원";

function parseCSV(t: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < t.length; i++) { const ch = t[i];
    if (q) { if (ch === '"') { if (t[i+1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else { if (ch === '"') q = true; else if (ch === ',') { row.push(cur); cur = ""; } else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ""; } else if (ch === '\r') {} else cur += ch; } }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const amt = (s: string) => { const d = (s||"").replace(/[^0-9]/g, ""); return d ? parseInt(d) : null; };
function period(s: string): [string|null,string|null] {
  s = (s||"").trim();
  const f = (m: RegExpMatchArray) => `${m[1]}-${String(+m[2]).padStart(2,"0")}-${String(+m[3]).padStart(2,"0")}`;
  if (s.includes("~")) { const [a,b] = s.split("~"); const ma = a.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/); const mb = b.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/); return [ma?f(ma):null, mb?f(mb):null]; }
  return [null, null];
}
function pmName(s: string): string|null {
  s = (s||"").trim(); if (!s) return null; const p = s.split(/\s+/);
  if (p.length >= 2 && TITLES.includes(p[p.length-1])) return p.slice(0,-1).join(" ");
  return p[0] || null;
}

type NewProg = { seq: number; name: string; client: string; amount: number|null; pm: string|null };

async function sendEmail(to: string[], subject: string, html: string) {
  if (!RESEND_KEY || !to.length) return "skipped";
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: MAIL_FROM, to, subject, html }) });
  return r.ok ? "sent" : ("error:" + r.status + ":" + (await r.text()).slice(0,120));
}
async function sendHiworks(userList: string[], message: string) {
  if (!HIWORKS_TOKEN || !userList.length) return "skipped";
  const r = await fetch("https://api.hiworks.com/office/v2/notify", { method: "POST", headers: { "Authorization": `Bearer ${HIWORKS_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ user_list: userList, message, link: CDMS_URL, mlink: CDMS_URL, solution_name: "CDMS 매출 동기화", solution_image_url: LOGO, solution_default_url: CDMS_URL }) });
  return r.ok ? "sent" : ("error:" + r.status + ":" + (await r.text()).slice(0,120));
}
function emailHtml(progs: NewProg[]): string {
  const rows = progs.map(p => `<tr><td style="padding:10px 14px;border-bottom:1px solid #eef0f4;font-size:15px;color:#1f2430"><b>${p.seq}. ${p.name}</b><br><span style=\"color:#5a6473;font-size:13px\">${p.client||""}${p.amount?" · "+won(p.amount):""}${p.pm?" · PM "+p.pm:""}</span></td></tr>`).join("");
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:32px 0;font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:94%;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,.08)"><tr><td bgcolor="#8E54E9" style="background:linear-gradient(120deg,#8E54E9 0%,#C054A0 55%,#F0653F 100%);padding:28px 36px" align="left"><img src="${LOGO}" alt="미림미디어랩" height="44" style="height:44px;display:block"></td></tr><tr><td style="padding:32px 36px 12px"><h2 style="margin:0 0 8px;color:#1f2430;font-size:22px">신규 사업 ${progs.length}건 추가</h2><p style="margin:0 0 18px;color:#5a6473;font-size:15px">매출 현황 시트 동기화로 CDMS에 새 사업이 등록되었습니다.</p><table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eef0f4;border-radius:10px;overflow:hidden">${rows}</table></td></tr><tr><td style="padding:6px 36px 30px"><a href="${CDMS_URL}" style="display:inline-block;background:#F0653F;border-radius:10px;padding:13px 28px;color:#fff;text-decoration:none;font-weight:700;font-size:15px">CDMS에서 확인하기</a></td></tr><tr><td style="background:#1f3a5f;padding:18px 36px;color:#aebfd4;font-size:12px;line-height:1.7">미림미디어랩(주) CDMS · 매출 동기화 자동 알림</td></tr></table></td></tr></table>`;
}

async function notifyAdmins(sb: any, progs: NewProg[]) {
  const { data: admins } = await sb.from("users").select("email,hiworks_id,user_roles!inner(role_code)").eq("user_roles.role_code", "admin");
  const emails = [...new Set((admins||[]).map((a: any) => a.email).filter((e: string) => e && e.includes("@")))] as string[];
  const ids = [...new Set((admins||[]).map((a: any) => a.hiworks_id).filter(Boolean))] as string[];
  const lines = progs.map(p => `• ${p.seq}. ${p.name}${p.client?" ("+p.client+")":""}${p.amount?" "+won(p.amount):""}`).join("\n");
  const msg = `[CDMS] 신규 사업 ${progs.length}건이 매출시트에서 추가되었습니다.\n${lines}`;
  const [email, messenger] = await Promise.all([
    sendEmail(emails, `[CDMS] 신규 사업 ${progs.length}건 추가`, emailHtml(progs)),
    sendHiworks(ids, msg),
  ]);
  return { email, messenger, email_to: emails.length, hiworks_to: ids.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(SB, SR);
    const url = new URL(req.url);
    if (url.searchParams.get("notify_test") === "1") {
      const sample: NewProg[] = [{ seq: 99, name: "테스트 사업(알림 확인용)", client: "테스트고객", amount: 12345000, pm: null }];
      return json({ ok: true, test: true, notify: await notifyAdmins(sb, sample) });
    }
    const raw = await (await fetch(CSV_URL)).text();
    const rows = parseCSV(raw);
    let h = -1;
    for (let i = 0; i < rows.length; i++) { const r = rows[i].map(c=>c.trim()); if (r.some(c=>c.includes("계약자")) && r.some(c=>c.includes("계약명"))) { h = i; break; } }
    if (h < 0) return json({ error: "header not found" }, 500);
    const hdr = rows[h].map(c=>c.trim());
    const col = (n: string) => hdr.findIndex(c => c.includes(n));
    const C = { no: col("번호"), client: col("계약자"), name: col("계약명"), amount: col("계약금액"), period: col("계약기간"), unpaid: col("미수금"), pm: (col("담당 PM")>=0?col("담당 PM"):col("PM")) };
    const { data: progs } = await sb.from("programs").select("id,seq").eq("year", 2026);
    const seqmap: Record<number,string> = {}; (progs||[]).forEach((p: any) => { if (p.seq != null) seqmap[p.seq] = p.id; });
    const { data: users } = await sb.from("users").select("id,name");
    const umap: Record<string,string> = {}; (users||[]).forEach((u: any) => { if (u.name) umap[u.name.trim()] = u.id; });
    let upd = 0, ins = 0; const nopm: string[] = []; const newProgs: NewProg[] = [];
    for (let i = h+1; i < rows.length; i++) {
      const r = rows[i]; const sv = (r[C.no]||"").trim();
      if (!/^\d{1,3}$/.test(sv)) continue;
      const seq = parseInt(sv);
      const client = (r[C.client]||"").trim();
      const name = (r[C.name]||"").trim();
      if (!client && !name) continue;
      const amount = amt(r[C.amount]||"");
      const [cs, ce] = period(r[C.period]||"");
      const pmn = pmName(r[C.pm]||"");
      const pmid = pmn ? umap[pmn] : null; if (pmn && !pmid && !nopm.includes(pmn)) nopm.push(pmn);
      const unpaid = amt(r[C.unpaid]||"");
      const patch: Record<string,unknown> = { client, amount, contract_start: cs, contract_end: ce, settled: (!unpaid && !!amount && !!ce) };
      if (pmid) patch.pm_id = pmid;
      if (seqmap[seq]) { const { error } = await sb.from("programs").update(patch).eq("id", seqmap[seq]); if (!error) upd++; }
      else { const { data, error } = await sb.from("programs").insert({ seq, year: 2026, name: name||client, org_type: "대학", approval_status: "미등록", created_by: ADMIN, ...patch }).select("id").single(); if (!error && data) { ins++; seqmap[seq] = data.id; newProgs.push({ seq, name: name||client, client, amount, pm: pmn }); } }
    }
    let notify: unknown = null;
    if (newProgs.length) notify = await notifyAdmins(sb, newProgs);
    return json({ ok: true, updated: upd, inserted: ins, pm_unmatched: nopm, notify });
  } catch (e) { return json({ error: String(e) }, 500); }
});
