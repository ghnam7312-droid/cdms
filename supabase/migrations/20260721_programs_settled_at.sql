-- 사업완료(완납) 시점 기록 — 완료 2주 후 NAS 99_휴지통 자동 정리에 사용 (2026-07-21, MCP 적용 완료 — 기록용)
alter table public.programs add column if not exists settled_at timestamptz;
create or replace function public.fn_settled_at() returns trigger
language plpgsql security definer as $$
begin
  if coalesce(new.settled,false) and not coalesce(old.settled,false) then
    new.settled_at := now();
  elsif not coalesce(new.settled,false) then
    new.settled_at := null;
  end if;
  return new;
end $$;
drop trigger if exists trg_settled_at on public.programs;
create trigger trg_settled_at before update on public.programs
for each row execute function public.fn_settled_at();
update public.programs set settled_at = now() where settled and settled_at is null;
