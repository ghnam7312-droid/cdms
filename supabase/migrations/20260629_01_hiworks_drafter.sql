-- 하이웍스 기안자 보관(품의완료 콜백 시 PM 승격)
alter table public.programs add column if not exists hiworks_drafter_id uuid;
comment on column public.programs.hiworks_drafter_id is '하이웍스 기안자(기안 시점 기록). 품의완료 콜백 시 pm_id로 승격';
