-- 과목(project) 단위 배정: 대기배정 테이블 + RLS 헬퍼에 project_members 반영 + 로그인 자동적용
create table if not exists public.pending_proj_access(
  email text not null,
  project_id uuid not null references public.projects(id) on delete cascade,
  role_code text not null references public.roles(code),
  primary key(email, project_id, role_code)
);
alter table public.pending_proj_access enable row level security;
drop policy if exists ppa_all on public.pending_proj_access;
create policy ppa_all on public.pending_proj_access for all to authenticated using (true) with check (true);

create or replace function public.app_see_proj(projid uuid) returns boolean
 language sql security definer stable set search_path=public as $$
  select public.app_is_admin()
   or exists(select 1 from project_members pm where pm.project_id=projid and pm.user_id=auth.uid())
   or exists(select 1 from projects p join program_members m on m.program_id=p.program_id where p.id=projid and m.user_id=auth.uid()); $$;
create or replace function public.app_see_prog(pid uuid) returns boolean
 language sql security definer stable set search_path=public as $$
  select public.app_is_admin()
   or exists(select 1 from program_members where program_id=pid and user_id=auth.uid())
   or exists(select 1 from project_members pm join projects p on p.id=pm.project_id where p.program_id=pid and pm.user_id=auth.uid()); $$;
create or replace function public.app_see_lesson(lessonid uuid) returns boolean
 language sql security definer stable set search_path=public as $$
  select public.app_is_admin() or exists(select 1 from lessons l where l.id=lessonid and public.app_see_proj(l.project_id)); $$;

create or replace function public.link_account_by_email()
returns void language plpgsql security definer set search_path=public as $$
declare em text; nid uuid; oid uuid; onm text;
begin
  nid := auth.uid(); if nid is null then return; end if;
  em := lower(coalesce(auth.jwt()->>'email','')); if em='' then return; end if;
  select id, name into oid, onm from users where lower(email)=em and id<>nid limit 1;
  if oid is not null then
    update users set email=null where id=oid;
    insert into users(id,email,name) values(nid,em,onm) on conflict (id) do update set name=coalesce(users.name, excluded.name), email=excluded.email;
    perform public.merge_user_into(oid, nid);
  else
    insert into users(id,email) values(nid,em) on conflict (id) do update set email=excluded.email;
  end if;
  insert into program_members(program_id,user_id,role_code) select pa.program_id, nid, pa.role_code from pending_access pa where lower(pa.email)=em on conflict do nothing;
  insert into project_members(project_id,user_id) select distinct ppa.project_id, nid from pending_proj_access ppa where lower(ppa.email)=em on conflict do nothing;
  insert into user_roles(user_id,role_code) select distinct nid, rc from (select role_code rc from pending_access where lower(email)=em union select role_code rc from pending_proj_access where lower(email)=em) t on conflict do nothing;
  delete from pending_access where lower(email)=em;
  delete from pending_proj_access where lower(email)=em;
end $$;
grant execute on function public.link_account_by_email() to authenticated;
