-- 외주 직무 역할 4종 추가(외부)
insert into roles (code,name,can_config,can_users,can_invite,can_review,is_external) values
 ('ext_planner','외주설계자',false,false,false,true,true),
 ('ext_designer','외주디자이너',false,false,false,false,true),
 ('ext_video','외주영상담당자',false,false,false,false,true),
 ('ext_steno','외주속기',false,false,false,false,true)
on conflict (code) do nothing;
