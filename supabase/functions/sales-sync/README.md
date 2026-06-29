# sales-sync Edge Function
'2026년도 매출 현황' 공개 CSV → CDMS programs 동기화(고객명·계약금액·계약기간·PM, 번호=seq 매칭).
사업명·과목·차시·진행률은 절대 덮어쓰지 않음.

- 배포: verify_jwt=false. CSV_URL 은 함수 내 상수(공개 링크).
- 스케줄: pg_cron 잡 'cdms-sales-sync' (매일 21:30 UTC = 06:30 KST) → pg_net 으로 이 함수 호출.
- 정본 소스는 supabase/functions/sales-sync/index.ts (Supabase 배포본과 동일).

## 신규 사업 알림 (메일 + 하이웍스 메신저)
동기화 중 **신규 사업(insert)이 생기면** CDMS 어드민(role='admin') 전원에게 알림 발송.
- 메일: Resend API. 수신자 = 어드민 users.email 전원. 발신 = NOTIFY_MAIL_FROM.
- 메신저: 하이웍스 알림발송 API `POST https://api.hiworks.com/office/v2/notify`.
  - 수신자 user_list = 어드민 users.hiworks_id (null 제외).
  - @mirimmedialab.co.kr 메일 사용자는 로컬파트가 자동으로 hiworks_id 가 됨(마이그레이션 09).
- 갱신(update)만 있을 땐 알림 없음. 사업 추가시에만 발송.

### 필요한 Edge Function 시크릿 (Supabase 대시보드 > Edge Functions > Secrets)
| 키 | 값 | 미설정 시 |
|---|---|---|
| RESEND_API_KEY | Resend API 키 | 메일 채널 skip |
| HIWORKS_NOTIFY_TOKEN | 하이웍스 오피스 토큰(해당 오피스) | 메신저 채널 skip |
| NOTIFY_MAIL_FROM | (선택) 발신 표시. 기본 `CDMS 알림 <noreply@noti.mirimmedialab.co.kr>` | 기본값 사용 |

> SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 자동 주입. 토큰류는 깃/프런트에 절대 저장 금지(시크릿만).

### 테스트
`GET /functions/v1/sales-sync?notify_test=1` → 실제 동기화 없이 알림 채널만 1회 발송(샘플 1건).
응답의 notify.email / notify.messenger 가 sent/skipped/error 를 표시.
