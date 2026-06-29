// CDMS ↔ 하이웍스 전자결재 : 상태 수신 콜백
// 하이웍스가 결재 상태 변경 시 GET 으로 호출:
//   {CALLBACK_URL}?office_id=..&approval_key=..&approval_id=..&approval_code=..&state=..
// approval_key 로 programs 를 찾아 상태를 갱신한다.
// ⚠️ 배포 시 public(인증 우회) 필요:  supabase functions deploy hiworks-callback --no-verify-jwt
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// (선택) 우리 오피스 id 화이트리스트. 비우면 검증 안 함.
const ALLOW_OFFICE  = (Deno.env.get("HIWORKS_OFFICE_ID") || "").trim();

// 하이웍스 state -> CDMS approval_status
// 하이웍스 공식: complete=승인, progress=진행중, rejected=반려, cancelled=기안취소
const STATE_MAP: Record<string, string> = {
  complete:  "품의완료",
  progress:  "기안중",
  rejected:  "반려",
  cancelled: "미등록",
  canceled:  "미등록",   // 철자 변형 대비
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const q = url.searchParams;
  const office_id     = q.get("office_id") || "";
  const approval_key  = q.get("approval_key") || "";
  const approval_id   = q.get("approval_id") || "";
  const approval_code = q.get("approval_code") || "";
  const state         = (q.get("state") || "").toLowerCase();

  if (!approval_key) return new Response("missing approval_key", { status: 400 });
  if (ALLOW_OFFICE && office_id && office_id !== ALLOW_OFFICE)
    return new Response("office not allowed", { status: 403 });

  const status = STATE_MAP[state] || "기안중";
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // 대상 사업 조회(기안자 확인용)
  const { data: rows, error: selErr } = await sb
    .from("programs").select("id,hiworks_drafter_id").eq("hiworks_approval_key", approval_key);
  if (selErr) return new Response("db error: " + selErr.message, { status: 500 });
  if (!rows || !rows.length) return new Response("no program for approval_key", { status: 404 });

  const patch: Record<string, unknown> = { approval_status: status };
  if (approval_id)   patch.hiworks_approval_id = approval_id;
  if (approval_code) patch.approval_no = approval_code;          // 실제 문서번호를 품의번호로
  if (status === "미등록") patch.approval_no = null;   // 기안취소 시 문서번호 비움
  // 품의완료 시에만 기안자를 PM으로 기록
  if (status === "품의완료" && rows[0].hiworks_drafter_id) patch.pm_id = rows[0].hiworks_drafter_id;

  const { error } = await sb.from("programs").update(patch).eq("hiworks_approval_key", approval_key);
  if (error) return new Response("db error: " + error.message, { status: 500 });
  return new Response("OK", { status: 200 });   // 하이웍스는 2xx 기대
});
