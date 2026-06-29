-- 역할 '고객사 담당자'(client) 추가 — 열람/검수만, 수정 불가, 외부
insert into public.roles(code,name,can_config,can_users,can_invite,can_review,is_external)
values('client','고객사 담당자',false,false,false,true,true)
on conflict (code) do update set name=excluded.name, can_config=excluded.can_config,
  can_users=excluded.can_users, can_invite=excluded.can_invite, can_review=excluded.can_review, is_external=excluded.is_external;
