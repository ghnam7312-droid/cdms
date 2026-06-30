-- 역할별 NAS 권한(보기/읽기/쓰기/삭제). 역할 정의 표에서 어드민이 토글, 프런트가 canNas*()로 동작 게이트.
alter table roles add column if not exists nas_view boolean not null default true;
alter table roles add column if not exists nas_read boolean not null default false;
alter table roles add column if not exists nas_write boolean not null default false;
alter table roles add column if not exists nas_delete boolean not null default false;
update roles set nas_view=true;
update roles set nas_read=true where code in ('admin','pm','biz','planner','sme','reviewer','designer','video','steno','trans','dev','vendor','ext_planner','ext_designer','ext_video','ext_steno');
update roles set nas_write=true where code in ('admin','pm','biz');
update roles set nas_delete=true where code='admin';
update roles set nas_read=false where code='client';
