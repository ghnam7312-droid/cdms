# sales-sync Edge Function
'2026년도 매출 현황' 공개 CSV → CDMS programs 동기화(고객명·계약금액·계약기간·PM, 번호=seq 매칭).
- 배포: verify_jwt=false. CSV_URL 은 함수 내 상수(공개 링크).
- 스케줄: pg_cron 잡 'cdms-sales-sync' (매일 21:30 UTC = 06:30 KST) → pg_net 으로 이 함수 호출.
- 실제 함수 소스는 Supabase에 배포된 버전이 정본(대시보드 Edge Functions에서 확인).
