-- 역할 '사업담당자' 추가
insert into public.roles(code,name,can_config,can_users,can_invite,can_review,is_external)
values('biz','사업담당자',true,false,true,true,false)
on conflict (code) do update set name=excluded.name, can_config=excluded.can_config,
  can_users=excluded.can_users, can_invite=excluded.can_invite, can_review=excluded.can_review, is_external=excluded.is_external;
