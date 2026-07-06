# CDMS — 새 세션 이어가기 컨텍스트 (SESSION_CONTEXT)

> 새로운 대화(세션)에서 이 프로젝트를 이어받는 사람/AI가 **가장 먼저 읽는 파일**.
> 상세 기능·이력은 `HANDOVER.md`(특히 "0. 최신 업데이트")에 있음. 이 파일은 "지금 상태 + 조작에 필요한 값 + 남은 일"만 요약.

## 1. 무엇인가
미림미디어랩 **콘텐츠 제작관리 시스템(CDMS)**. 단일파일 프런트(`cdms-deploy/index.html`, 바닐라 JS + Supabase JS) + Supabase(DB/Auth/Edge Functions) + 시놀로지 NAS + 하이웍스(전자결재/조직) 연동.

## 2. 자원/좌표 (조작에 필요한 값)
- **GitHub**: `https://github.com/ghnam7312-droid/cdms` (public), 브랜치 `main`. push하면 자동배포.
- **라이브**: https://cdms.mirimmedialab.co.kr
- **Vercel**: 프로젝트 `cdms`, team `team_RNvh8Ly5KcPrhlj5ukvsq03q`(ghnam7312-droids-projects), **Root Directory=`cdms-deploy`**, Production 브랜치 `main`. (프런트 자동배포)
- **Supabase**: project ref **`kowtvvrgpzgrdlnxasxw`**, URL `https://kowtvvrgpzgrdlnxasxw.supabase.co`. 프런트 공개키는 index.html의 `sb_publishable_...`.
- **Edge Functions**(6): `hiworks-draft`(verify_jwt=true), `hiworks-callback`(false), `request-access`(false), `sales-sync`(false), `nas-proxy`(false), `hiworks-approval-sync`(false).
- **pg_cron**: `cdms-sales-sync`(매일 21:30 UTC=06:30 KST), `cdms-approval-sync`(21:00 UTC=06:00 KST).

## 3. 배포 방법 (중요)
- 프런트: `cdms-deploy/index.html` 수정 → git push → **Vercel 자동배포**. (index.html은 no-store 헤더라 캐시 안 됨)
- Supabase 함수: `supabase/functions/**` 수정 → git push → **GitHub Actions `deploy-supabase.yml`** 자동배포.
  - ⚠️ 단, `hiworks-approval-sync`는 workflow 목록에 **아직 미등록**(과거 토큰에 workflow 권한 없어 제외). Supabase에 직접 배포돼 동작 중. workflow 권한 토큰 확보 시 `deploy-supabase.yml`에 `supabase functions deploy hiworks-approval-sync --project-ref $PROJECT_REF` 한 줄 추가.
- DB 마이그레이션: 자동 아님. GitHub → Actions → "Deploy Supabase" → Run workflow(run_migrations 체크). 또는 Supabase SQL 편집기.
- 함수는 **리포 소스가 정본**. 대시보드/직접배포로만 바꾸면 Actions가 되돌리니 리포 파일을 고쳐 push할 것.

## 4. 시크릿/자격증명 (값은 클라우드에만, 깃 금지)
- Supabase Edge Function Secrets: `RESEND_API_KEY`, `HIWORKS_NOTIFY_TOKEN`, `HIWORKS_OFFICE_TOKEN_DRAFT`, `HIWORKS_FORM_ID`(N68), `HIWORKS_CALLBACK_URL`, `HIWORKS_APPROVAL_TOKEN`(대기), `SUPABASE_*`(자동).
- GitHub Actions Secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`.
- NAS 접속(URL/계정/비번)은 DB `nas_config`(id=1) — nas-proxy가 service-role로만 읽음. 앱의 "🔌 NAS 설정"에서 저장.

## 5. 지금 남은 일 / 알려진 이슈
1. **전자결재 매일 폴링(대기)**: `hiworks-approval-sync`는 완성·스케줄됨. 그러나 하이웍스 `GET /office/v2/approval/documents?approval_key=..`(Bearer, Content-Type json)가 **오피스 토큰을 "유효하지 않은 토큰"으로 거부**(서로 다른 오피스 토큰 2개 모두). → **가비아 제휴/올바른 인증 방식 확인 필요**. 확인되면 `HIWORKS_APPROVAL_TOKEN` 시크릿만 넣으면 자동 가동(`?debug=1`로 확인). 그 전엔 **콜백(실시간) + 프런트 "✔ 완료처리" 버튼**으로 완료 반영.
2. **hiworks-approval-sync를 Actions workflow에 편입**(위 3번 ⚠️).
3. **검수 썸네일**: NAS 스트리밍 영상은 교차출처라 캔버스 캡처가 막혀 썸네일이 안 뜰 수 있음(그리기·구간·답글은 정상).
4. **NAS 스트리밍 전제**: 과정에 `nas_root` 지정(🗂 NAS 폴더명 > ③ 탐색기), 종편 원본이 mp4(H.264), nas_config 채워짐.

## 5.5 POC (2026-07-03~)
- **POC 개선의견 기능**: 로그인 후 우측 하단 "📝 POC 의견" 플로팅 버튼 → 텍스트 + 화면 영역캡처(getDisplayMedia, 드래그로 영역 선택) 등록. DB `poc_feedback`(RLS: 전체 조회/본인 등록/본인·어드민 수정·삭제, 이미지 base64 저장). 어드민은 목록에서 ✔ 처리완료 토글, 본인·어드민 ✏ 내용 수정.
- **POC 알림 메일**: Edge Function `poc-notify`(verify_jwt=false, 배포됨·workflow 등록됨). ①daily: pg_cron `cdms-poc-daily`(00:00 UTC=09:00 KST)가 호출 → 지난 24h 의견을 어드민에게 요약 메일(이미지 cid 인라인 첨부, Resend). ②update: 프런트 pocToggle/pocEdit가 fnCall로 호출 → 상태/내용 수정 처리 후 작성자+어드민에게 변경 전→후 메일(이미지 포함). 인증: daily/test=cron_key(nas_scan_cron_key), update=사용자 JWT(작성자/어드민만). 시크릿: agent_secrets.email_api_key/email_from 재사용.
- 메뉴 권한: 초대=어드민·PM·설계자(`inv` 플래그), 사용자·권한/NAS 설정/역할데모 박스=어드민만(`window.ISADMIN`, 로그인 시 DB 역할 기준).

- **오디오 점검(2026-07-03)**: 과정 화면 "🔊 오디오 점검" 버튼 → nas_tasks에 `audio_check` 등록 → **nas-worker**(사내 서버, ffmpeg)가 종편 폴더의 차시별 최신 영상을 분석(silencedetect 무음/volumedetect 클리핑/ebur128 과대·과소 음량, 임계값은 워커 env AUDIO_*) → `audio_checks` 테이블 upsert(lesson_id당 1행, RLS: 조회만 허용·쓰기는 service role). 차시 상세 하단 "🔊 오디오 점검" 섹션에 문제 구간 표시, 시간 클릭 시 검수 모달 열고 해당 위치 재생. ⚠ 워커 코드가 갱신되어 **사내 서버의 nas-worker 재배포 필요**(nas-worker/02_deploy_worker.sh 또는 docker compose up -d --build). nasN: 프리픽스 과정(다른 NAS)은 워커가 접근 불가라 미지원.

## 6. 새 세션에서 바로 할 수 있는 확인
- 매출 동기화: `POST /functions/v1/sales-sync`(anon apikey) → `{ok,updated,inserted}`.
- 전자결재 폴링: `GET /functions/v1/hiworks-approval-sync?debug=1` → errors에 "유효하지 않은 토큰"이면 아직 대기.
- 프런트 버전: 브라우저 콘솔에 `CDMS build ...` 로그.
