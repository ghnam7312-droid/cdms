// 하이웍스 전자결재 기안문서 상태를 매일 폴링해 CDMS programs.approval_status 반영 (콜백 보완).
// 조회: GET {API}/approval/v2/documents/{approval_id}  (Authorization: Bearer officeToken)
//   ※ 공식 문서(Postman) 기준 올바른 엔드포인트. approval_id는 기안 콜백에서 저장됨(hiworks-callback).
// 토큰: HIWORKS_APPROVAL_TOKEN 우선, 없으면 HIWORKS_OFFICE_TOKEN_DRAFT (기안용 오피스 토큰과 동일 사용 가능).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAW = (Deno.env.get("HIWORKS_APPROVAL_TOKEN") || Deno.env.get("HIWORKS_OFFICE_TOKEN_DRAFT") || "").trim();
const TOKEN = RAW ? (/^bearer\s/i.test(RAW) ? RAW : "Bearer " + RAW) : "";
const API = (Deno.env.get("HIWORKS_API_BASE") || "https://api.hiworks.com").replace(/\/+$/, "");
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const STATE: Record<string, string> = { complete: "품의완료", progress: "기안중", rejected: "반려", cancelled: "미등록", canceled: "미등록", deleted: "미등록" };

async function q(approvalId: string) {
  const r = await fetch(`${API}/approval/v2/documents/${encodeURIComponent(approvalId)}`, {
    headers: { Authorization: TOKEN, "Content-Type": "application/json" },
  });
  const t = await r.text();
  let j: any = null;
  try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 200) }; }
  return { status: r.status, j };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!TOKEN) return json({ ok: false, error: "토큰 미설정(HIWORKS_APPROVAL_TOKEN)" }, 500);
  const debug = new URL(req.url).searchParams.get("debug") === "1";
  const sb = createClient(SB, SR);
  const { data: progs } = await sb.from("programs")
    .select("id,seq,approval_status,hiworks_approval_key,hiworks_approval_id,hiworks_drafter_id")
    .not("hiworks_approval_key", "is", null)
    .neq("approval_status", "품의완료");
  let checked = 0, updated = 0, noId = 0;
  const errs: string[] = []; const dbg: unknown[] = [];
  for (const p of (progs || [])) {
    if (!p.hiworks_approval_id) { noId++; if (debug) dbg.push({ seq: p.seq, skip: "approval_id 없음(콜백 미수신)" }); continue; }
    checked++;
    const res = await q(String(p.hiworks_approval_id));
    if (debug) dbg.push({ seq: p.seq, status: res.status, j: res.j });
    const raw = res.j?.data?.attributes?.state ?? res.j?.data?.state ?? res.j?.state;
    if (typeof raw !== "string") {
      const msg = res.j?.message || res.j?.error || ("HTTP " + res.status);
      if (!errs.includes(msg)) errs.push(String(msg));
      continue;
    }
    const st = STATE[raw.toLowerCase()] || null;
    if (!st) continue;
    if (st === p.approval_status && st !== "품의완료") continue;
    const patch: Record<string, unknown> = { approval_status: st };
    if (st === "미등록") patch.approval_no = null;
    if (st === "품의완료" && p.hiworks_drafter_id) patch.pm_id = p.hiworks_drafter_id;
    const { error } = await sb.from("programs").update(patch).eq("id", p.id);
    if (!error) updated++;
  }
  return json({ ok: true, checked, updated, skipped_no_id: noId, errors: errs, ...(debug ? { debug: dbg } : {}) });
});
