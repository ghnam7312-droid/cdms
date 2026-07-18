-- NAS 파일 매칭용 별칭 — 과정명 변경 시 이전 이름을 자동 보존 (2026-07-18 운영 적용 완료 — 기록용)
alter table public.projects add column if not exists nas_alias text;
comment on column public.projects.nas_alias is 'NAS 파일 매칭용 별칭(과정명 변경 전 이름 자동 보존)';
