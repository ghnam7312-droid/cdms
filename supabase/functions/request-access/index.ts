// CDMS 로그인 온보딩: 명부(users)에 있는 이메일만 가입 허용
//  - 신규: 초대메일 발송(inviteUserByEmail) → 사용자가 링크에서 비밀번호 설정
//  - 기존: {mode:"existing"} 반환 → 프런트가 resetPasswordForEmail로 재설정메일 발송
// 시크릿: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY(기본), CDMS_SITE_URL(선택)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const URL = Deno.env.get("SUPABASE_URL")!;
const SR  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE = (Deno.env.get("CDMS_SITE_URL") || "https://cdms.mirimmedialab.co.kr").replace(/\/+$/, "");
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, reason: "POST only" }, 405);
  try {
    const { email } = await req.json();
    const em = (email || "").trim().toLowerCase();
    if (!em) return json({ ok: false, reason: "no_email" }, 400);
    const admin = createClient(URL, SR, { auth: { persistSession: false } });
    // 명부(allowlist) 확인
    const { data: dir } = await admin.from("users").select("id,email").ilike("email", em).limit(1);
    if (!dir || !dir.length) return json({ ok: false, reason: "not_listed" });
    // 기존 Auth 사용자 여부
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const exists = (list?.users || []).find((u) => (u.email || "").toLowerCase() === em);
    if (exists) return json({ ok: true, mode: "existing" });
    const { error } = await admin.auth.admin.inviteUserByEmail(em, { redirectTo: SITE });
    if (error) return json({ ok: false, reason: error.message }, 500);
    return json({ ok: true, mode: "invited" });
  } catch (e) {
    return json({ ok: false, reason: String(e) }, 500);
  }
});
