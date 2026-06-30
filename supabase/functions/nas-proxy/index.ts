import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const J = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function getCfg() {
  const sr = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data } = await sr.from('nas_config').select('*').eq('id', 1).single();
  return data || {};
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const action = body.action || 'ping';

  const cfg = await getCfg();
  const NAS_URL = (cfg.url || '').replace(/\/$/, '');
  const NAS_USER = cfg.username || '';
  const NAS_PASS = cfg.password || '';
  const NAS_BASE = (cfg.base || '').replace(/\/$/, '');
  if (!NAS_URL || !NAS_USER) return J({ ok: false, error: 'NAS 설정이 비어 있습니다. 앱의 NAS 설정에서 URL/계정/비번을 저장하세요.' }, 400);

  const syno = async (path: string) => {
    const r = await fetch(`${NAS_URL}${path}`);
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { success: false, raw: t.slice(0, 300) }; }
  };
  const login = async () => {
    const u = encodeURIComponent(NAS_USER), p = encodeURIComponent(NAS_PASS);
    const res = await syno(`/webapi/auth.cgi?api=SYNO.API.Auth&version=6&method=login&account=${u}&passwd=${p}&session=FileStation&format=sid`);
    if (!res.success) throw new Error('NAS 로그인 실패 (code ' + (res.error?.code ?? '?') + '). 계정/비번/2단계인증 확인');
    return res.data.sid as string;
  };

  let sid = '';
  try {
    sid = await login();
    if (action === 'ping') {
      const sh = await syno(`/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list_share&_sid=${sid}`);
      return J({ ok: true, base: NAS_BASE, shares: (sh.data?.shares || []).map((s: any) => s.path) });
    }
    if (action === 'list') {
      const path = body.path || NAS_BASE;
      const res = await syno(`/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list&folder_path=${encodeURIComponent(JSON.stringify(path))}&_sid=${sid}`);
      return J({ ok: res.success, path, files: (res.data?.files || []).map((f: any) => ({ name: f.name, isdir: f.isdir, path: f.path })), error: res.error });
    }
    if (action === 'mkdir_tree') {
      const root = `${NAS_BASE}/${body.project}`;
      const parents = (body.folders || []).map(() => root);
      const names = body.folders || [];
      const res = await syno(`/webapi/entry.cgi?api=SYNO.FileStation.CreateFolder&version=2&method=create&folder_path=${encodeURIComponent(JSON.stringify(parents))}&name=${encodeURIComponent(JSON.stringify(names))}&force_parent=true&_sid=${sid}`);
      return J({ ok: res.success, root, created: names, error: res.error });
    }
    return J({ ok: false, error: 'unknown action' }, 400);
  } catch (e) {
    return J({ ok: false, error: String((e as any)?.message || e) }, 500);
  } finally {
    if (sid) { try { await syno(`/webapi/auth.cgi?api=SYNO.API.Auth&version=6&method=logout&session=FileStation&_sid=${sid}`); } catch { /* */ } }
  }
});
