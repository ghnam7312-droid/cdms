-- 품의 독촉 단계 경고(D+15/D+30) 발송 기록 (2026-07-18 운영 적용 완료 — 기록용)
alter table public.approval_reminders
  add column if not exists m15_sent_at timestamptz,
  add column if not exists m30_sent_at timestamptz;
