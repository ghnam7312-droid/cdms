-- 과정 노출을 초대 범위 기준으로 강화 (2026-07-18 운영 적용 완료 — 기록용)
--  · 과정 단위 초대(project_members: 내용전문가·외주 설계자/디자이너 등) → 그 과정만 보임
--  · 사업 단위 초대(program_members: 고객사 담당자·외주사 등) → 그 사업의 과정 전체 보임
--  · 사업 PM(programs.pm_id)·어드민 → 기존대로 / 초대 없는 사용자는 아무것도 안 보임
create or replace function public.app_see_proj(projid uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select public.app_is_admin()
   or exists(select 1 from project_members pm where pm.project_id=projid and pm.user_id=auth.uid())
   or exists(select 1 from projects p join programs g on g.id=p.program_id
             where p.id=projid and g.pm_id=auth.uid())
   or exists(select 1 from projects p join program_members m on m.program_id=p.program_id
             where p.id=projid and m.user_id=auth.uid())
   or exists(select 1 from projects p where p.id=projid and p.created_by=auth.uid());
$$;
drop policy if exists sel_projects on public.projects;
create policy sel_projects on public.projects for select
  using (public.app_is_admin() or public.app_see_proj(id));
