-- 사업(program) 단위 멤버십 + 초대 시 대기 배정 + 로그인 시 자동 적용
create table if not exists public.program_members(
  program_id uuid not null references public.programs(id) on delete cascade,
  user_id    uuid not null references public.users(id)    on delete cascade,
  role_code  text not null references public.roles(code),
  primary key(program_id, user_id, role_code)
);
create table if not exists public.pending_access(
  email      text not null,
  program_id uuid not null references public.programs(id) on delete cascade,
  role_code  text not null references public.roles(code),
  primary key(email, program_id, role_code)
);

create or replace function public.link_account_by_email()
returns void language plpgsql security definer set search_path=public as $$
declare em text; nid uuid; oid uuid; onm text;
begin
  nid := auth.uid();
  if nid is null then return; end if;
  em := lower(coalesce(auth.jwt()->>'email',''));
  if em = '' then return; end if;
  select id, name into oid, onm from users where lower(email)=em and id<>nid limit 1;
  if oid is not null then
    update users set email=null where id=oid;
    insert into users(id,email,name) values(nid,em,onm)
      on conflict (id) do update set name=coalesce(users.name, excluded.name), email=excluded.email;
    perform public.merge_user_into(oid, nid);
  else
    insert into users(id,email) values(nid,em)
      on conflict (id) do update set email=excluded.email;
  end if;
  insert into program_members(program_id,user_id,role_code)
    select pa.program_id, nid, pa.role_code from pending_access pa where lower(pa.email)=em
    on conflict do nothing;
  insert into user_roles(user_id,role_code)
    select distinct nid, pa.role_code from pending_access pa where lower(pa.email)=em
    on conflict do nothing;
  delete from pending_access where lower(email)=em;
end $$;
grant execute on function public.link_account_by_email() to authenticated;
