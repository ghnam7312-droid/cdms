// 하이웍스 전자결재 기안문서 상태를 매일 폴링해 CDMS programs.approval_status 반영 (콜백 보완).
// 조회: GET /office/v2/approval/documents?approval_key=..  (Content-Type: application/json, Bearer)
// 토큰: HIWORKS_APPROVAL_TOKEN(전자결재 조회권한 필요) 우선, 없으면 HIWORKS_OFFICE_TOKEN_DRAFT.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SB = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = (Deno.env.get("HIWORKS_APPROVAL_TOKEN") || Deno.env.get("HIWORKS_OFFICE_TOKEN_DRAFT") || "").trim();
const API = (Deno.env.get("HIWORKS_API_BASE") || "https://api.hiworks.com").replace(/\/+$/,"");
const cors = { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"*" };
const json = (o: unknown, s=200)=>new Response(JSON.stringify(o), {status:s, headers:{...cors,"Content-Type":"application/json"}});
const STATE: Record<string,string> = { complete:"품의완료", progress:"기안중", rejected:"반려", cancelled:"미등록", canceled:"미등록" };
function pick(o: any){ const out:{state?:string;no?:string}={}; const walk=(x:any)=>{ if(!x||typeof x!=="object")return; for(const k of Object.keys(x)){const v=x[k],lk=k.toLowerCase(); if(!out.state&&(lk==="state"||lk==="status"||lk==="approval_state")&&typeof v==="string")out.state=v.toLowerCase(); if(!out.no&&(lk==="approval_code"||lk==="document_no"||lk==="doc_no"||lk==="approval_no")&&v)out.no=String(v); if(v&&typeof v==="object")walk(v);} }; walk(o); return out; }
async function q(key: string){
  const r = await fetch(`${API}/office/v2/approval/documents?approval_key=${encodeURIComponent(key)}`, { headers: { Authorization: TOKEN, "Content-Type":"application/json" } });
  const t = await r.text(); let j:any=null; try{ j=JSON.parse(t); }catch{ j={raw:t.slice(0,200)}; }
  return { status:r.status, j };
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!TOKEN) return json({ ok:false, error:"토큰 미설정(HIWORKS_APPROVAL_TOKEN)" }, 500);
  const debug = new URL(req.url).searchParams.get("debug")==="1";
  const sb = createClient(SB, SR);
  const { data: progs } = await sb.from("programs").select("id,seq,approval_status,hiworks_approval_key,hiworks_drafter_id").not("hiworks_approval_key","is",null).neq("approval_status","품의완료");
  let checked=0, updated=0; const errs:string[]=[]; const dbg:unknown[]=[];
  for (const p of (progs||[])) {
    checked++;
    const res = await q(p.hiworks_approval_key);
    if (debug) dbg.push({ seq:p.seq, status:res.status, j:res.j });
    if (res.j?.code === "ERR") { if(!errs.includes(res.j.message))errs.push(res.j.message); continue; }
    const info = pick(res.j);
    const st = info.state ? (STATE[info.state]||null) : null;
    if (!st) continue;
    if (st === p.approval_status && st !== "품의완료") continue;
    const patch: Record<string,unknown> = { approval_status: st };
    if (info.no) patch.approval_no = info.no;
    if (st === "미등록") patch.approval_no = null;
    if (st === "품의완료" && p.hiworks_drafter_id) patch.pm_id = p.hiworks_drafter_id;
    const { error } = await sb.from("programs").update(patch).eq("id", p.id);
    if (!error) updated++;
  }
  return json({ ok:true, checked, updated, errors:errs, ...(debug?{debug:dbg}:{}) });
});
