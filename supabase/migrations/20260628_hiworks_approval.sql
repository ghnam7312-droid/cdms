-- CDMS ↔ 하이웍스 전자결재 연동용 스키마
-- programs.approval_no      : 하이웍스 approval_code(문서번호) 저장에 재사용
-- programs.approval_status  : 미등록 / 기안중 / 품의완료 / 반려  (재사용)
alter table public.programs
  add column if not exists hiworks_approval_key text,
  add column if not exists hiworks_approval_id  text;

create index if not exists idx_programs_hw_approval_key
  on public.programs (hiworks_approval_key);

comment on column public.programs.hiworks_approval_key is '하이웍스 기안 연동요청 식별키(approval_key). 콜백 매칭용';
comment on column public.programs.hiworks_approval_id  is '하이웍스 문서 고유키(approval_id). 문서 상태 조회/문서뷰 링크용';
