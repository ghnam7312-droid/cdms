# CDMS — 새 세션 이어가기 컨텍스트 (SESSION_CONTEXT)

> 새로운 대화(세션)에서 이 프로젝트를 이어받는 사람/AI가 **가장 먼저 읽는 파일**.
> 상세 기능·이력은 `HANDOVER.md`(특히 "0. 최신 업데이트")에 있음. 이 파일은 "지금 상태 + 조작에 필요한 값 + 남은 일"만 요약.

## 0. 지금 상태 스냅샷 (2026-07-14)
- **프런트 빌드**: `2026-07-14a (lesson-switch,multi-dl)` — 07-10b 폴더 트리부터 07-14a까지의 프런트 변경은 **push 대기 중**일 수 있음(사용자가 GitHub Desktop으로 Commit→Push). push만 하면 Vercel 자동배포.
- **엣지 함수**: nas-proxy v41, poc-notify v14 — MCP로 **직접 배포 완료**(리포 소스와 동일). push 시 Actions가 같은 코드를 재배포해도 무해.
- **DB 최근 마이그레이션**: poc_feedback.deleted_at(휴지통, DELETE 정책 제거) · poc_feedback.done_at(리마인더).
- **pg_cron**: 기존 5개 + `cdms-usage-daily`(jobid 6, 사용현황 메일, 7/24까지 함수 내 날짜 가드) + `cdms-poc-remind`(jobid 8, done 후 미완료 확인 메일). 모두 00:00 UTC=09:00 KST.
- **nas-worker**: 변경 없음(재배포 불필요).
- POC 대응 이력·세부는 아래 "변경 로그" 참조. #28 유실 건은 복원 불가 확정(임소희 재등록 요청 예정).

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
1. **전자결재 매일 폴링(07-08 해결)**: 원인은 잘못된 엔드포인트였음. 공식 문서(Postman) 기준 `GET https://api.hiworks.com/approval/v2/documents/{approval_id}`(Bearer 오피스토큰)로 수정·배포 — 기존 기안용 오피스 토큰 그대로 동작, 별도 토큰 불필요. approval_id는 기안 콜백(hiworks-callback)이 저장. 콜백을 못 받은 과거 3건(미등록 상태)은 approval_id가 없어 skip되며, **새로 기안하는 건부터 매일 06:00 자동 반영**. 검증: `?debug=1`.
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

- **사업완료 진도지연 제외(07-15d)**: ✓ 사업완료(settled=완납) 사업은 진도 지연 배지·요약 카드의 지연 카운트에서 제외(pace 판정 skip). + #18 충남대 품의완료 수동 반영(콜백 미수신 건). 미등록 6건(seq 19·21·23·25·26·27)은 콜백 소급 불가 — 하이웍스에서 완료 확인되면 수동 반영 필요. 오늘 기안분(#29)은 콜백 정상 수신·자동 반영 확인. 빌드 2026-07-15d (settled-no-delay).
- **업로드 이력 테이블(07-15c)**: `upload_logs`(project_id/lesson_id/week_no/lesson_no/stage_id/file_name/path/uploader/uploader_name/created_at, RLS: 로그인 조회·본인 insert만, 수정·삭제 정책 없음). 프런트 scanAfterUpload의 **검사 통과(clean) 시점**에 자동 insert — 실제 NAS 반영 확정 건만 기록. 차시 컨텍스트 없이 올리면 lesson 관련 컬럼 null. 조회 UI는 아직 없음(SQL/추후 KPI 연동). 빌드 2026-07-15c (upload-log).
- **품의 취소 안내(07-15b, 오두원 #39)**: 기안 팝업(draftApproval)이 닫히면 1.2초 간격으로 감지 → 2.5초 대기(콜백 반영) 후 programs.approval_status 조회 — 기안중/품의완료면 조용히 진행표 갱신, 아니면 "품의가 완료되지 않았습니다. 빠른 시간 내에 다시 품의해 주세요." alert. 30분 후 감시 중단. 빌드 2026-07-15b (draft-cancel-msg).
- **전체 선택 + 파일 이동(07-15a, POC)**: ① 파일 목록 하단 "전체 선택" 체크박스(dlSelAll — 모든 파일·폴더 체크 토글). ② nas-proxy에 `file_move` 액션 신설 — 과정 영역 내 한정, 대상 폴더 자동 생성(중간 폴더 포함), **덮어쓰기 금지**(겹치면 원본을 "(2)" 등으로 개명 후 이동), .cdms_ 폴더 금지, CopyMove 완료 폴링(120초). 프런트 "📁→ 선택 이동" 버튼(canNasWrite 전용) — 체크한 파일들을 prompt로 입력한 상대 폴더(예: 특강자료, 원본/5주차)로 순차 이동 후 목록 갱신. 파일 보호 원칙 갱신: 삭제·덮어쓰기는 여전히 불가, 이동만 제한적 허용. nas-proxy v43 직접 배포 + 리포 반영. 빌드 2026-07-15a (select-all,file-move).
- **폴더 단위 다운로드(07-14b, POC)**: 폴더 트리의 각 폴더 요약줄에 ☑ 체크박스 — 켜면 하위 폴더 포함 전체 파일 .fsel과 하위 폴더 체크박스가 동기 선택(dlFolderSel)되어 "⬇ 선택 다운로드"로 한 번에 순차 다운로드. 빌드 2026-07-14b (folder-dl).
- **파일 팝업 차시 전환 + 다중 다운로드(07-14, POC)**: ① 파일 팝업 헤더에 차시 드롭다운(전체/각 차시, 제목 14자 표시) — fileLessonSwitch가 curFileLesson 교체 후 현재 탭 리로드. ② 각 파일 행에 ☑ 체크박스 + 목록 하단 "⬇ 선택 다운로드 (n)" 버튼 — dlSelected가 file_url 발급 후 앵커 클릭을 700ms 간격 순차 실행(다운로드 모드 중계라 파일명 보존, 크롬 '여러 파일 다운로드 허용' 1회 확인 필요). 빌드 2026-07-14a (lesson-switch,multi-dl).
- **POC 확인 요청 리마인더(07-14)**: 처리완료(done) 후 다음날까지 최종 완료(final)가 안 된 의견 → 작성자에게 매일 09:00 KST 확인 요청 메일(작성자별 1통 묶음, 내용 300자 요약, "이상 없으면 최종 완료 / 미흡하면 답글" 안내). 구현: poc_feedback.done_at 컬럼(+기존 done 건 now()로 백필 → 07-15부터 발송), poc-notify update 액션이 done→기록·open→초기화, 새 remind 액션(cron_key, done_at < 오늘 KST 0시 대상), pg_cron `cdms-poc-remind`(jobid 8, 00:00 UTC). poc-notify v14 직접 배포 + 리포 반영. 호출 검증 완료(현재 대기 건 없음 응답).
- **차시 매칭 파트번호 오인 수정(07-14, 임소희 — 딥러닝 촬영교안)**: "[SB] 딥러닝_06-1.pptx" 같은 "NN-K(차시-파트)" 파일명의 파트 번호(-1/-2/-3)가 숫자 폴백(nums)에 걸려 1·2·3차시 팝업에 다른 차시 파일이 표시되던 문제. fileMatchesLesson에 차시형(weekNo null) 확정 규칙 추가: 파일명에 NN-K·주차 표기가 있으면 NN으로 확정하고 폴백 진행 안 함(`if(weekNo==null&&!mc&&w!=null)return false;`). 노드 스텁으로 버그 재현·수정 검증. nas-proxy v41 직접 배포 + 리포 반영. (주차형 과정 로직은 변경 없음)
- **POC 창 닫기 버튼 상단 고정(07-13)**: 스크롤을 맨 위로 올려야 ✕가 보이던 문제 — #pocpanel 헤더(.dh)를 position:sticky;top:0으로 고정(스크롤 위치와 무관하게 항상 표시). 빌드 2026-07-13c (poc-close-sticky).
- **다운로드 파일명 보존(07-13, 임소희 #27)**: 파일 다운로드가 entry.cgi로 저장되던 문제 — nas-proxy GET(?s=)이 NAS로 302하던 것을, file_url 토큰에 d:1·n(원본 파일명)을 넣고 d:1이면 **스트림 중계 + Content-Disposition: attachment; filename*=UTF-8''(원본명)** 으로 변경. 영상 스트리밍(stream_url, d 없음)은 기존 302(mode=open) 유지 — 검수 재생 영향 없음. nas-proxy v37 직접 배포 + 리포 반영.
- **POC 의견 휴지통(07-13)**: #28(임소희, 07-13 15:28 등록) 완전 삭제로 유실된 사건 계기. poc_feedback에 deleted_at 추가, RLS DELETE 정책(del_poc) 제거 → 하드 삭제 불가. 프런트 삭제=deleted_at 기록(휴지통 이동 안내), 어드민에게 "🗑 휴지통" 토글(삭제된 의견 목록+↩ 복원). 일일 요약 메일은 deleted_at null만 포함(poc-notify — push 시 자동 배포). 빌드 2026-07-13b (poc-trash). #28 자체는 백업 시점 문제로 복원 불가 가능성 높음(사용자가 대시보드 Backups 시각 확인 예정 — 07-13 15:28 이후 백업이 있으면 새 프로젝트 복원으로 한 행만 추출).
- **NAS2 업로드 실패 수정(07-13, 김윤옥 컴퓨터비전 09차시 SB)**: 증상 "검사 실패: 검사 대상 파일을 찾지 못했습니다". 원인: NAS2 해당 단계 폴더에 `.cdms_scan`이 없었고, 브라우저 직접 업로드(FileStation Upload)의 create_parents가 숨김(점) 폴더를 만들지 못해 업로드 자체가 실패(응답은 no-cors라 프런트가 감지 못함). 검증: pg_net으로 NAS2 API 직접 조회 — .cdms_scan 부재(408) 확인, CreateFolder API는 정상(폴더 생성됨), 최종 폴더의 09-1/2/3은 사용자가 파일스테이션으로 수동 업로드한 것(crtime 10:38/11:14 = CDMS 시도 실패 직후). 수정: nas-proxy save·upload_ticket에서 `.cdms_scan`을 서버가 미리 CreateFolder(v35 직접 배포+리포 반영), 프런트 scanAfterUpload가 '찾지 못했' 오류를 "업로드가 NAS에 도달하지 못함 — 재업로드" 안내로 표시. 빌드 2026-07-13a (nas2-upload-fix). ※ 수동 업로드된 09-1/2/3은 백신검사 미경유(NAS 직접 업로드와 동일 취급).
- **버전 비교 동기화 버그 수정(07-11)**: 한쪽을 정지해도 반대쪽(오디오)이 계속 재생되던 문제 — cmpBind의 450ms 시간 가드가 재생/이동 직후의 정지 이벤트를 무시한 것이 원인. 상태 기반 미러링으로 교체(반대쪽이 이미 같은 재생 상태면 무시, 시간차 0.3초 초과 시에만 시크 → 에코 루프 없음, 정지·재생은 항상 전달). 빌드 2026-07-11a (cmp-sync-fix).
- **사용현황 일일 메일(07-11)**: poc-notify에 `usage_daily` 액션 추가 — 지난 24시간 usage_events를 사용자×이벤트(8종) 표로 집계해 **활성(가입 완료) 사용자 전원**(auth.users 기준, .local 제외)에게 발송. **2026-07-24까지**만 발송(KST 날짜 가드, 이후 자동 skip — cron job은 종료 후 `select cron.unschedule('cdms-usage-daily');`로 정리 가능). pg_cron `cdms-usage-daily`(jobid 6, 00:00 UTC=09:00 KST). 테스트: body에 `email` 지정 시 그 주소로만(cron_key 필요). 07-11 테스트 발송 성공(5명 82건). 함수는 MCP로 직접 배포됨(v11) + 리포 소스 동일 — push 시 Actions 재배포 무해.
- **POC 반영(07-10b)**: 파일 창 폴더 목록을 **계층형 트리**로 변경 — 기존 "원본/4주차/4-2/분류완료" 식 전체 경로 나열 대신, 최상위 폴더(원본·최종 등)만 접힌 상태로 표시하고 클릭 시 하위 폴더가 한 단계씩 펼쳐짐(중첩 details, 깊이별 들여쓰기 14px, 폴더별 누적 파일 수 표시). 최상위 폴더가 1개뿐이면 자동 펼침. ✏이름변경·🗑삭제 버튼은 각 폴더 요약줄에 그대로(전체 상대경로로 동작). loadStageFiles의 _tree/_rTree. 빌드 2026-07-10b (folder-tree).
- **POC 반영(07-10)**: 파일 창 **폴더 관리** — 📁+ 새 폴더(하위 경로 "a/b" 지원), 폴더 그룹 헤더 ✏이름변경·🗑삭제. nas-proxy folder_create/rename/delete(과정 영역 내, 쓰기 권한). **삭제는 빈 폴더만**(파일 보호 원칙 유지, 파일 삭제·이동 액션은 여전히 없음). + POC 의견 🖼 이미지 첨부(외부 레퍼런스, 1600px 리사이즈). + 전 과정(68) 마지막 차시에 '홍보영상' 차시 추가(주차형은 마지막 주차, 중복 방지).
- **POC 반영(07-09)**: 검수 코멘트 **✏수정·🗑삭제**(작성자/어드민, 답글 삭제 포함, 답글 있는 코멘트 삭제 시 함께 삭제) + 강의계획서 다운로드 **한글 파일명 깨짐 수정**(blob+a[download] 방식).
- **POC 반영(07-09, 임소희 #17)**: 새 제작 단계 **촬영교안(id 14, NAS 폴더 05-1_촬영교안)** 추가 — stages 행 삽입, 프런트 REF_ORDER(5 다음)/REF_LABEL/RVIEW(스토리보드 보는 역할들+영상팀)/파일탭 order 반영, nas-proxy STAGE_PAT_FILES(14:/촬영교안|교안/, 촬영(2)은 교안 제외), nas-versions STAGE_PAT(14 추가, 1·2에 교안 negative lookahead). 각 과정에서 ⚙ 단계 설정으로 활성화 후 폴더 생성 필요. (07-09 후속) nas-versions 진행 표기가 update-only라 새 단계는 lesson_stage 행이 없어 날짜 미표시 → 스캔 시 seed upsert(ignoreDuplicates) 후 갱신하도록 수정.
- **POC 반영(07-08, 최보경 #8 / 박아름)**: 파일 창을 하위 폴더별 그룹 표시(📂 상대경로 헤더)로 변경, old·원본·최종 폴더도 표시(listFilesMeta의 ^old$ 제외 해제), 탐색 깊이 3단계로 확대. + 진행표 검색창(ovq — 사업·과정·고객사·PM 키워드 즉시 필터).
- **POC 반영(07-08, 박아름 #12)**: 화면 캡처를 2단계로 변경 — 📷 클릭 시 화면공유 스트림을 유지한 채 POC 창을 내리고 하단 미니바(📸 안내+[지금 캡처]/[취소]) 표시 → 사용자가 원하는 화면·팝업으로 자유 이동 후 '지금 캡처'를 누르면 그 시점 프레임으로 영역 선택. 공유중지 시 자동 복원.
- **POC 반영(07-08, 김윤옥 #13)**: ①파일 업로드 다중 선택(multiple)+드래그앤드롭(up-drop, upFiles가 순차 처리·건별 진행률·대용량/백신검사 동일 적용) ②POC 의견창을 #modal 공유에서 전용 #pocpanel(z-70)로 분리 — 다른 팝업을 닫지 않으며 영역캡처 시 POC 창만 숨겨 열린 팝업 그대로 캡처 가능.
- **POC 반영(07-07, 이은영 #9)**: 차시 상세 종편(7) 행에 "☐ 내 담당" 토글(lesson_stage.assignee 자기지정). 검수 코멘트/답글 등록 시 poc-notify `review_comment` 액션 호출 → 그 차시 종편 담당자(assignee, 본인 제외)에게 과정·차시·시점·내용 메일. 기존 실시간 토스트는 유지.
- **POC 반영(07-07, 이은영 #7)**: stage_files에서 촬영(2) 탭은 '원고'가 들어간 폴더 제외 + 촬영본/영상촬영/cap 폴더 우선 연결, 원고(1) 탭은 '촬영원고' 등 원고 포함 폴더를 통합 표시(업로드는 기본 원고 폴더, 최대 3개 폴더 병합).
- **POC 반영(07-08, 박아름 #4 후속)**: stage_files 탐색 깊이 5로 확대(디자인처럼 상위/주차/차시/용도 4단계+ 구조 대응), fileMatchesLesson에 "숫자 정보 없는 공용 파일(폰트·로고)은 항상 표시" 규칙 추가.
- **POC 반영(07-07, 박아름)**: 단계 파일 목록(stage_files)이 파일명만으로 차시를 매칭해 디자인처럼 주차/차시 "폴더"로 정리된 단계에서 필터가 안 되던 문제 → 상대 경로(상위 폴더명 포함)로 매칭 + 하위 2단계까지 나열하도록 수정.

- **사용 KPI(07-08)**: `usage_events` 테이블(RLS: 본인 insert/전체 select) + 프런트 logEv()가 login·course_view·review_open·comment·upload·poc·status_change 이벤트 기록. 어드민 사이드바 "📊 사용 현황"(openKpi) — DAU/WAU/등록자/주간 활성률 카드, 14일 일별 활성 막대, 주간 기능 사용량, 사용자별 활동표(활성=7일 내 활동). 데이터는 배포 시점부터 수집.

## 6. 새 세션에서 바로 할 수 있는 확인
- 매출 동기화: `POST /functions/v1/sales-sync`(anon apikey) → `{ok,updated,inserted}`.
- 전자결재 폴링: `GET /functions/v1/hiworks-approval-sync?debug=1` → errors에 "유효하지 않은 토큰"이면 아직 대기.
- 프런트 버전: 브라우저 콘솔에 `CDMS build ...` 로그.
