// 게스트 검수 공유: 토큰으로 로그인 없이 영상+코멘트 조회 (service_role, 읽기전용)
// GET /review-share?token=...
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"*" };
const json = (o: unknown, s=200)=>new Response(JSON.stringify(o), {status:s, headers:{...cors,"Content-Type":"application/json"}});
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const token = new URL(req.url).searchParams.get("token") || "";
  if (!token) return json({ ok:false, error:"토큰 없음" }, 400);
  const sb = createClient(SB, SR);
  const { data: l } = await sb.from("lessons")
    .select("id,title,lesson_no,review_path,review_ver").eq("share_token", token).maybeSingle();
  if (!l) return json({ ok:false, error:"유효하지 않은 링크" }, 404);
  let video: string|null = null;
  if (l.review_path) {
    if (/^https?:\/\//.test(l.review_path)) video = l.review_path;
    else { const { data: su } = await sb.storage.from("review").createSignedUrl(l.review_path, 3600); video = su?.signedUrl || null; }
  }
  const { data: cs } = await sb.from("review_comments")
    .select("id,t_sec,t_end,author_name,body,created_at,thumb,parent_id,resolved")
    .eq("lesson_id", l.id).order("created_at");
  return json({ ok:true, title:l.title, lesson_no:l.lesson_no, version:l.review_ver, video, comments: cs||[] });
});
