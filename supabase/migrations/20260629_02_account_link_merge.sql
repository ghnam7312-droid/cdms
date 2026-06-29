-- 임시 명부 user 행 ↔ 로그인 Auth 계정을 이메일 기준으로 병합/연결
create or replace function public.merge_user_into(old_id uuid, new_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  if old_id is null or new_id is null or old_id = new_id then return; end if;
  update documents      set uploaded_by=new_id where uploaded_by=old_id;
  update invites        set invited_by=new_id  where invited_by=old_id;
  update lesson_stage   set assignee=new_id    where assignee=old_id;
  update projects       set created_by=new_id  where created_by=old_id;
  update review_comments set author=new_id     where author=old_id;
  update programs       set pm_id=new_id       where pm_id=old_id;
  update programs       set created_by=new_id  where created_by=old_id;
  update programs       set hiworks_drafter_id=new_id where hiworks_drafter_id=old_id;
  update project_members pm set user_id=new_id where pm.user_id=old_id
    and not exists (select 1 from project_members p2 where p2.user_id=new_id and p2.project_id=pm.project_id);
  delete from project_members where user_id=old_id;
  update stage_assignees sa set user_id=new_id where sa.user_id=old_id
    and not exists (select 1 from stage_assignees s2 where s2.user_id=new_id and s2.project_id=sa.project_id and s2.stage_id=sa.stage_id);
  delete from stage_assignees where user_id=old_id;
  update user_roles ur set user_id=new_id where ur.user_id=old_id
    and not exists (select 1 from user_roles u2 where u2.user_id=new_id and u2.role_code=ur.role_code);
  delete from user_roles where user_id=old_id;
  delete from users where id=old_id;
end $$;

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
    update users set email=null where id=oid;  -- 유니크 충돌 방지
    insert into users(id,email,name) values(nid,em,onm)
      on conflict (id) do update set name=coalesce(users.name, excluded.name), email=excluded.email;
    perform public.merge_user_into(oid, nid);
  else
    insert into users(id,email) values(nid,em)
      on conflict (id) do update set email=excluded.email;
  end if;
end $$;
grant execute on function public.link_account_by_email() to authenticated;
