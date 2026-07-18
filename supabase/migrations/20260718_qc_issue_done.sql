-- 품질 점검 문제 항목별 "처리 완료" 체크 (2026-07-18 운영 적용 완료 — 기록용)
create table if not exists public.qc_issue_done (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null,
  file_name text not null,
  itype text not null,
  t_start integer not null default 0,
  done_by uuid,
  done_at timestamptz default now(),
  unique (lesson_id, file_name, itype, t_start)
);
alter table public.qc_issue_done enable row level security;
create policy sel_qcd on public.qc_issue_done for select to authenticated using (true);
create policy ins_qcd on public.qc_issue_done for insert to authenticated with check (true);
create policy del_qcd on public.qc_issue_done for delete to authenticated using (true);
