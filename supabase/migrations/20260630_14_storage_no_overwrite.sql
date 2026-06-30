-- 스토리지 덮어쓰기(UPDATE) 차단: 기존 'web anon all'(ALL) 정책을 SELECT/INSERT/DELETE 로 분리, UPDATE 제외.
-- service_role(워커)은 RLS 우회 → 워커는 코드에서 upsert=false 로 별도 차단.
-- ⚠️ storage.move(이름변경=UPDATE)를 쓰는 기능이 있으면 막히니 사용 여부 확인 후 적용.
drop policy if exists "web anon all" on storage.objects;
create policy "web storage select" on storage.objects for select to anon, authenticated using (true);
create policy "web storage insert" on storage.objects for insert to anon, authenticated with check (true);
create policy "web storage delete" on storage.objects for delete to anon, authenticated using (true);
