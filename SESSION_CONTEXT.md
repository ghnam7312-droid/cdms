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
- **POC 알림 메일**: Edge Function `poc-notify`(verify_jwt=false, 배포됨·workflow 등록됨). ①daily: pg_cron `cdms-poc-daily`(00:00 UTC=09:00 KST)가 호출 → 지난 24h 의견을 어드민에게 요약 메일(이미지 cid 인라인 첨부, Resend). ②update: 프런트 pocToggle/pocEdit가 fnCall로 호출 → 상태/내용 수정 처리 후 작성자+어드민에게 변경 전→후 메일(이미지 포함). ③reply(07-06): 의견별 답변(`poc_replies` 테이블, 전체 조회/본인 등록/본인·어드민 삭제) — 프런트 pocReply가 fnCall('poc-notify',{action:'reply'})로 등록하면 의견 작성자+어드민(답변자 제외)에게 원본+답변 내용 메일. 인증: daily/test=cron_key(nas_scan_cron_key), update=사용자 JWT(작성자/어드민만). 시크릿: agent_secrets.email_api_key/email_from 재사용.
- 메뉴 권한: 초대=어드민·PM·설계자(`inv` 플래그), 사용자·권한/NAS 설정/역할데모 박스=어드민만(`window.ISADMIN`, 로그인 시 DB 역할 기준).

- **오디오 점검(2026-07-03)**: 과정 화면 "🔊 오디오 점검" 버튼 → nas_tasks에 `audio_check` 등록 → **nas-worker**(사내 서버, ffmpeg)가 종편 폴더의 차시별 최신 영상을 분석(silencedetect 무음/volumedetect 클리핑/ebur128 과대·과소 음량·구간 간 9LU 이상 급변(jump)/채널별 silencedetect로 스테레오 한쪽 무음(channel), 임계값은 워커 env AUDIO_*). (07-07) **영상 품질 점검 추가**(_analyze_video_local, 같은 audio_check 흐름에 포함): 규격(spec, 파일 전체 — 1920×1080/3000~5500kbps/29.97~30fps, env VIDEO_*) + 100% 블랙/화이트 프레임 2f(0.06초) 이상 구간(black/white, blackdetect·negate+blackdetect). 모두 warn 등급, 프런트 라벨·'파일 전체' 표시 처리. (07-07) UI 명칭 '오디오 점검'→'품질 점검'. 영상검수 모달에 **명도대비 스포이드**(🎨, EyeDropper API — 글자색/배경색 클릭 → WCAG 대비비 계산, 4.5:1 기준 통과/미달 표시, 크롬/엣지) 추가. **명도대비 자동 검사**(_analyze_contrast_local): 5초 간격 프레임 → tesseract OCR(kor+eng, conf≥60, 높이≥14px)로 텍스트 박스 → 상/하위 사분위 색으로 글자/배경 추정 → WCAG 대비 <4.5 구간을 contrast(warn) 이슈로 병합 기록. env CCA_*. ⚠ 서버 의존성: tesseract-ocr+tesseract-ocr-kor(apt), pillow(venv pip). 기준 문서 갱신됨. (07-06) CDMS로 종편 영상 업로드 완료 시 자동 점검(audioAutoCheck→nas_tasks, params.notify_user=업로더) + 문제 발견 시 워커가 업로더에게 이메일(send_email), 차시 상세에 "🔊 이 차시 오디오 점검" 버튼 추가. 기준 문서: 품질점검_기준.docx (구 오디오점검_기준.docx) → `audio_checks` 테이블 upsert(lesson_id당 1행, RLS: 조회만 허용·쓰기는 service role). 차시 상세 하단 "🔊 오디오 점검" 섹션에 문제 구간 표시, 시간 클릭 시 검수 모달 열고 해당 위치 재생. ⚠ 워커 코드 갱신 시 **사내 서버의 nas-worker 재배포 필요**. (07-07) nasN:(다른 NAS) 과정은 **차시 단위 점검만** 지원 — `_audio_check_remote`가 FileStation API로 종편 영상을 임시 다운로드해 분석(_RemoteFSLite), 결과 upsert + 문제 시 notify_user에게 메일. 과정 전체 점검 버튼은 nasN:에서 안내 오류 반환. 업로드 자동 점검(audioAutoCheck)은 lesson_id가 있어 nasN:에서도 동작.

- **업로드 백신검사(07-06)**: CDMS 업로드(소용량 save·대용량 직접 모두, 기본 NAS(1)만)는 최종 폴더가 아닌 `{단계폴더}/.cdms_scan`(검사 대기)으로 저장 → 프런트가 nas_tasks `scan_file`(path,dest,name,notify_user) 등록 → **nas-worker가 ClamAV(clamdscan/clamscan)로 검사** → 통과 시 최종 폴더로 이동(겹치면 새 이름), 감염 시 `{단계폴더}/.cdms_blocked` 격리 + 업로더·어드민 메일. ClamAV 미설치 시 fail-closed(반영 안 됨, 오류 안내). `.cdms_*` 폴더는 모든 목록/스캔(nas-proxy·nas-versions·워커)에서 제외. ⚠ 서버 사전작업: `sudo apt-get install -y clamav clamav-daemon` + 워커 재배포. (07-07) **NAS2 포함 모든 NAS 검사**: nasN: 경로는 워커가 FileStation API로 원격 처리(_scan_file_remote — nas_config 자격증명으로 로그인→다운로드→검사→이동/격리, 표준라이브러리 urllib만 사용). nas-proxy save/upload_ticket은 항상 .cdms_scan 경유, scan_path/dest는 nasN: 프리픽스 포함.
- **대용량 직접 업로드(07-06)**: 파일 모달 업로드에서 25MB 초과 파일은 nas-proxy `upload_ticket`(권한 확인 후 NAS url+sid+경로 발급, 로그아웃 안 함) → 브라우저가 FileStation Upload API로 **NAS에 직접 multipart POST**(XHR, 진행률 % 표시). NAS가 CORS 헤더를 안 줘서 응답은 못 읽으므로 완료 후 stage_files로 **파일명+크기 검증**해 성공 판정. DSM 역방향 프록시/CORS 설정 불필요(4808 규칙은 미사용 — DSM에 커스텀 헤더 저장돼 있으나 응답에 미반영, 라우터 4808 포워딩이 4801로 갈 가능성). 25MB 이하는 기존 base64 경로 유지.
- **영상소스 메뉴(07-06)**: 과정 화면 "🎞 영상소스" 버튼 + 파일 모달 탭(가상 단계 99). NAS 과정 폴더의 `소스|에셋|asset|source` 폴더를 하위 2단계까지 나열, 없으면 쓰기 권한자가 열 때 `98_소스` 자동 생성(nas-proxy stage_files의 create 파라미터). 차시 필터·파일명 차시 태깅 없음(공용). 프리미어 .prproj·효과음 등 공유 용도, CDMS 업로드는 25MB 제한 그대로.

- **POC 반영(07-08, 최보경 #8 / 박아름)**: 파일 창을 하위 폴더별 그룹 표시(📂 상대경로 헤더)로 변경, old·원본·최종 폴더도 표시(listFilesMeta의 ^old$ 제외 해제), 탐색 깊이 3단계로 확대. + 진행표 검색창(ovq — 사업·과정·고객사·PM 키워드 즉시 필터).
- **POC 반영(07-08, 박아름 #12)**: 화면 캡처를 2단계로 변경 — 📷 클릭 시 화면공유 스트림을 유지한 채 POC 창을 내리고 하단 미니바(📸 안내+[지금 캡처]/[취소]) 표시 → 사용자가 원하는 화면·팝업으로 자유 이동 후 '지금 캡처'를 누르면 그 시점 프레임으로 영역 선택. 공유중지 시 자동 복원.
- **POC 반영(07-08, 김윤옥 #13)**: ①파일 업로드 다중 선택(multiple)+드래그앤드롭(up-drop, upFiles가 순차 처리·건별 진행률·대용량/백신검사 동일 적용) ②POC 의견창을 #modal 공유에서 전용 #pocpanel(z-70)로 분리 — 다른 팝업을 닫지 않으며 영역캡처 시 POC 창만 숨겨 열린 팝업 그대로 캡처 가능.
- **POC 반영(07-07, 이은영 #9)**: 차시 상세 종편(7) 행에 "☐ 내 담당" 토글(lesson_stage.assignee 자기지정). 검수 코멘트/답글 등록 시 poc-notify `review_comment` 액션 호출 → 그 차시 종편 담당자(assignee, 본인 제외)에게 과정·차시·시점·내용 메일. 기존 실시간 토스트는 유지.
- **POC 반영(07-07, 이은영 #7)**: stage_files에서 촬영(2) 탭은 '원고'가 들어간 폴더 제외 + 촬영본/영상촬영/cap 폴더 우선 연결, 원고(1) 탭은 '촬영원고' 등 원고 포함 폴더를 통합 표시(업로드는 기본 원고 폴더, 최대 3개 폴더 병합).
- **POC 반영(07-07, 박아름)**: 단계 파일 목록(stage_files)이 파일명만으로 차시를 매칭해 디자인처럼 주차/차시 "폴더"로 정리된 단계에서 필터가 안 되던 문제 → 상대 경로(상위 폴더명 포함)로 매칭 + 하위 2단계까지 나열하도록 수정.

## 6. 새 세션에서 바로 할 수 있는 확인
- 매출 동기화: `POST /functions/v1/sales-sync`(anon apikey) → `{ok,updated,inserted}`.
- 전자결재 폴링: `GET /functions/v1/hiworks-approval-sync?debug=1` → errors에 "유효하지 않은 토큰"이면 아직 대기.
- 프런트 버전: 브라우저 콘솔에 `CDMS build ...` 로그.
