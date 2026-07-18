-- 사업 정보(사업처 담당자·교수자·계약/개발 특이사항) — 학교명 클릭 시 표시, admin/PM/사업담당자/설계자 편집
-- (2026-07-18 운영 DB 적용 완료 — 기록용)
alter table public.programs
  add column if not exists client_contact  text,
  add column if not exists instructor_info text,
  add column if not exists contract_note   text,
  add column if not exists dev_note        text,
  add column if not exists info_updated_by uuid,
  add column if not exists info_updated_at timestamptz;
comment on column public.programs.client_contact  is '사업처 담당자 정보(이름·직위·연락처·이메일 등)';
comment on column public.programs.instructor_info is '교수자 정보';
comment on column public.programs.contract_note   is '계약 특이사항';
comment on column public.programs.dev_note        is '개발 특이사항';
