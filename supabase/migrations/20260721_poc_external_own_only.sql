-- 외부 역할(고객사·외주·내용전문가 등)은 본인이 접수한 불편사항만 열람.
-- 내부 역할(admin,pm,biz,planner,designer,video)은 전체 열람 유지. (2026-07-21, MCP 적용 완료 — 기록용)
drop policy if exists sel_poc on public.poc_feedback;
create policy sel_poc on public.poc_feedback for select to authenticated using (
  user_id = auth.uid()
  or exists (select 1 from public.user_roles ur
             where ur.user_id = auth.uid()
               and ur.role_code in ('admin','pm','biz','planner','designer','video'))
);
drop policy if exists sel_pocr on public.poc_replies;
create policy sel_pocr on public.poc_replies for select to authenticated using (
  user_id = auth.uid()
  or exists (select 1 from public.poc_feedback f
             where f.id = poc_replies.feedback_id and f.user_id = auth.uid())
  or exists (select 1 from public.user_roles ur
             where ur.user_id = auth.uid()
               and ur.role_code in ('admin','pm','biz','planner','designer','video'))
);
