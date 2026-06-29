-- 매출 동기화 자동화: pg_net + pg_cron 으로 sales-sync Edge Function 매일 호출
create extension if not exists pg_net;
create extension if not exists pg_cron;
-- 매일 21:30 UTC(=06:30 KST) sales-sync 호출
-- select cron.schedule('cdms-sales-sync','30 21 * * *', $job$
--   select net.http_post(
--     url:='https://kowtvvrgpzgrdlnxasxw.supabase.co/functions/v1/sales-sync',
--     headers:=jsonb_build_object('Content-Type','application/json','apikey','<ANON_KEY>'),
--     body:='{}'::jsonb);
-- $job$);
