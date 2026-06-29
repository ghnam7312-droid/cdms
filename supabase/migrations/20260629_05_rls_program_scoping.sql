-- RLS: 사업(program) 가시성 기준 접근제어
-- 어드민=전체, 그 외=배정된 사업(program_members)과 그 하위만. anon=차단.
-- 헬퍼는 SECURITY DEFINER (RLS 재귀 회피). 참조 테이블(users/roles/stages 등)은 전체 허용 유지.
create or replace function public.app_is_admin() returns boolean
 language sql security definer stable set search_path=public as $$
  select exists(select 1 from user_roles where user_id=auth.uid() and role_code='admin'); $$;
create or replace function public.app_see_prog(pid uuid) returns boolean
 language sql security definer stable set search_path=public as $$
  select public.app_is_admin() or exists(select 1 from program_members where program_id=pid and user_id=auth.uid()); $$;
create or replace function public.app_see_proj(projid uuid) returns boolean
 language sql security definer stable set search_path=public as $$
  select public.app_is_admin() or exists(select 1 from projects p join program_members m on m.program_id=p.program_id where p.id=projid and m.user_id=auth.uid()); $$;
create or replace function public.app_see_lesson(lessonid uuid) returns boolean
 language sql security definer stable set search_path=public as $$
  select public.app_is_admin() or exists(select 1 from lessons l join projects p on p.id=l.project_id join program_members m on m.program_id=p.program_id where l.id=lessonid and m.user_id=auth.uid()); $$;
grant execute on function public.app_is_admin(), public.app_see_prog(uuid), public.app_see_proj(uuid), public.app_see_lesson(uuid) to authenticated, anon;

-- programs
drop policy if exists "programs all" on public.programs;
create policy sel_programs on public.programs for select to authenticated using (public.app_see_prog(id));
create policy ins_programs on public.programs for insert to authenticated with check (true);
create policy upd_programs on public.programs for update to authenticated using (public.app_see_prog(id)) with check (true);
create policy del_programs on public.programs for delete to authenticated using (public.app_see_prog(id));
-- projects
drop policy if exists "p_auth_all" on public.projects;
create policy sel_projects on public.projects for select to authenticated using (public.app_is_admin() or (program_id is not null and public.app_see_prog(program_id)));
create policy ins_projects on public.projects for insert to authenticated with check (true);
create policy upd_projects on public.projects for update to authenticated using (public.app_is_admin() or (program_id is not null and public.app_see_prog(program_id))) with check (true);
create policy del_projects on public.projects for delete to authenticated using (public.app_is_admin() or (program_id is not null and public.app_see_prog(program_id)));
-- lessons
drop policy if exists "p_auth_all" on public.lessons;
create policy sel_lessons on public.lessons for select to authenticated using (public.app_see_proj(project_id));
create policy ins_lessons on public.lessons for insert to authenticated with check (true);
create policy upd_lessons on public.lessons for update to authenticated using (public.app_see_proj(project_id)) with check (true);
create policy del_lessons on public.lessons for delete to authenticated using (public.app_see_proj(project_id));
-- lesson_stage
drop policy if exists "p_auth_all" on public.lesson_stage;
create policy sel_ls on public.lesson_stage for select to authenticated using (public.app_see_lesson(lesson_id));
create policy ins_ls on public.lesson_stage for insert to authenticated with check (true);
create policy upd_ls on public.lesson_stage for update to authenticated using (public.app_see_lesson(lesson_id)) with check (true);
create policy del_ls on public.lesson_stage for delete to authenticated using (public.app_see_lesson(lesson_id));
-- weeks / documents / stage_assignees / project_stages (project_id 기준)
drop policy if exists "p_auth_all" on public.weeks;
create policy sel_weeks on public.weeks for select to authenticated using (public.app_see_proj(project_id));
create policy ins_weeks on public.weeks for insert to authenticated with check (true);
create policy upd_weeks on public.weeks for update to authenticated using (public.app_see_proj(project_id)) with check (true);
create policy del_weeks on public.weeks for delete to authenticated using (public.app_see_proj(project_id));
drop policy if exists "p_auth_all" on public.documents;
create policy sel_docs on public.documents for select to authenticated using (public.app_see_proj(project_id));
create policy ins_docs on public.documents for insert to authenticated with check (true);
create policy upd_docs on public.documents for update to authenticated using (public.app_see_proj(project_id)) with check (true);
create policy del_docs on public.documents for delete to authenticated using (public.app_see_proj(project_id));
drop policy if exists "p_auth_all" on public.stage_assignees;
create policy sel_sa on public.stage_assignees for select to authenticated using (public.app_see_proj(project_id));
create policy ins_sa on public.stage_assignees for insert to authenticated with check (true);
create policy upd_sa on public.stage_assignees for update to authenticated using (public.app_see_proj(project_id)) with check (true);
create policy del_sa on public.stage_assignees for delete to authenticated using (public.app_see_proj(project_id));
drop policy if exists "p_auth_all" on public.project_stages;
create policy sel_ps on public.project_stages for select to authenticated using (public.app_see_proj(project_id));
create policy ins_ps on public.project_stages for insert to authenticated with check (true);
create policy upd_ps on public.project_stages for update to authenticated using (public.app_see_proj(project_id)) with check (true);
create policy del_ps on public.project_stages for delete to authenticated using (public.app_see_proj(project_id));
-- project_members
drop policy if exists "p_auth_all" on public.project_members;
create policy sel_pjm on public.project_members for select to authenticated using (public.app_see_proj(project_id) or user_id=auth.uid());
create policy ins_pjm on public.project_members for insert to authenticated with check (true);
create policy upd_pjm on public.project_members for update to authenticated using (public.app_see_proj(project_id)) with check (true);
create policy del_pjm on public.project_members for delete to authenticated using (public.app_see_proj(project_id));
-- review_comments / reviews (lesson_id 기준)
drop policy if exists "p_auth_all" on public.review_comments;
create policy sel_rc on public.review_comments for select to authenticated using (public.app_see_lesson(lesson_id));
create policy ins_rc on public.review_comments for insert to authenticated with check (true);
create policy upd_rc on public.review_comments for update to authenticated using (public.app_see_lesson(lesson_id)) with check (true);
create policy del_rc on public.review_comments for delete to authenticated using (public.app_see_lesson(lesson_id));
drop policy if exists "p_auth_all" on public.reviews;
create policy sel_rv on public.reviews for select to authenticated using (public.app_see_lesson(lesson_id));
create policy ins_rv on public.reviews for insert to authenticated with check (true);
create policy upd_rv on public.reviews for update to authenticated using (public.app_see_lesson(lesson_id)) with check (true);
create policy del_rv on public.reviews for delete to authenticated using (public.app_see_lesson(lesson_id));
-- program_members (program_id 기준)
drop policy if exists "pm all" on public.program_members;
create policy sel_pgm on public.program_members for select to authenticated using (public.app_see_prog(program_id) or user_id=auth.uid());
create policy ins_pgm on public.program_members for insert to authenticated with check (true);
create policy upd_pgm on public.program_members for update to authenticated using (public.app_see_prog(program_id)) with check (true);
create policy del_pgm on public.program_members for delete to authenticated using (public.app_see_prog(program_id));
-- pending_access
alter table public.pending_access enable row level security;
drop policy if exists pa_all on public.pending_access;
create policy pa_all on public.pending_access for all to authenticated using (true) with check (true);
