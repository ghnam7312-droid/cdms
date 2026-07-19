# CDMS — 새 세션 이어가기 컨텍스트 (SESSION_CONTEXT)

> 새로운 대화(세션)에서 이 프로젝트를 이어받는 사람/AI가 **가장 먼저 읽는 파일**.
> 상세 기능·이력은 `HANDOVER.md` 참조. 이 파일은 "지금 상태 + 조작에 필요한 값 + 남은 일"만 요약.

## 0. 지금 상태 스냅샷 (2026-07-19 아침)
- **프런트 빌드**: `2026-07-18z8 (badges-mgmt-only)` — main 커밋 = 운영 반영 완료(Vercel 자동배포).
- **워커(nas_worker.py)**: `QC_VER = v6-flatbg` 서버(ai-agent, systemd `cdms-nas-worker`) 반영 완료.
- **엣지 함수**: nas-proxy(폴더 ZIP·base 반환), nas-versions(수동 동기화 삭제 반영·nas_alias 매칭), approval-reminder(D+15/D+30 경고) — 모두 Actions로 배포 완료.
- **품질 검사 일괄 실행(7/18 밤)**: 8개 과정 51차시 등록 → 39건 완료, 실패 12건 중 2건(일시 NAS 오류) 재시도 등록됨(결과 확인 필요), **환경보건교육 9건 + 컴퓨터비전 6차시는 워커 차시 매칭 실패(미해결)**.
- **테스트 계정 6종**(비번 `Cdms1234!`): qa-client/qa-vendor(DGIST 사업 초대), qa-sme/qa-extplan(파이썬 과정), qa-extdsgn(데이터사이언스 과정), qa-noinvite(미초대) @cdms-test.kr — 접근범위 API 검증 완료. 테스트 끝나면 삭제 예정.

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

## 5. 지금 남은 일 / 알려진 이슈 (2026-07-19)
1. **환경보건교육 9차시 + 컴퓨터비전 6차시 품질검사 매칭 실패** — "종편 폴더에서 차시에 매칭되는 영상을 찾지 못했습니다". Edge(nas-versions)는 매칭해 길이를 채웠는데 워커(_audio_check_remote)의 매칭 규칙이 이 과정 파일명 구조와 안 맞음. 워커 매칭 로직을 Edge와 동일화 필요.
2. **재시도 2건 확인** — 컴퓨터비전 5차시·파이썬 1차시 audio_check 재등록(7/19 아침). nas_tasks에서 done 여부 확인.
3. **008(장애인개발원)·009(국가데이터처 개선 44과정) 품질검사 미실행** — 009는 약 105시간 분량(≈21시간 소요)이라 야간 분할 실행 권장.
4. 검수 썸네일: NAS 스트리밍 영상은 교차출처라 캔버스 캡처가 막힐 수 있음(그리기·구간·답글은 정상).
5. QA 테스트 계정(qa-*@cdms-test.kr) 테스트 종료 후 삭제.

## 6. 2026-07-18 변경 로그 (빌드태그 순, 모두 운영 반영)
- **a~b**: PSD·이미지 👁 미리보기(previews 버킷, SHA-256 캐시) + 🖼 폴더 썸네일 그리드
- **c**: 폴더째 이동(하위 구조 유지, nas-proxy file_move 5분 대기)
- **d~f**: ✏ 과정,차시명 수정 버튼(과정명·주차명·차시명만, planner 포함 / 영상길이·형식 제외)
- **g**: 폴더 ZIP 다운로드(FileStation 즉석 압축, 폴더당 1개)
- **h**: ℹ 사업 정보(학교명 클릭 — 하이웍스 기본정보 + 사업처담당자·교수자·계약/개발 특이사항, 편집: admin/pm/biz/planner, DB: programs.client_contact 등 6컬럼)
- **i~j**: 검수 코멘트 멀티라인(Enter 줄바꿈·Ctrl+Enter 등록·답글 [등록] 버튼, 수정 팝업)
- **k**: 수동 NAS 동기화 시 삭제 반영(자동표기 셀 wait 초기화, 크론은 채우기 전용)
- **l**: 진행표 셀 툴팁(매칭 NAS 파일명·생성일 안내)
- **m, w**: 검수 마커·말풍선 코멘트 구간 밖 자동 숨김(0.4s 독립 감시 타이머)
- **n**: 품질 이슈 기준별 색상(빨강=오디오심각/주황=음량/노랑=급변/보라=규격/파랑=명도비/회색=블랙·화이트)
- **o**: 명도비 문제 프레임 캡처(previews/qc, 빨간 박스) + 목록 썸네일
- **p~q**: 기준별 필터 칩 + 항목별 ✓ 처리 완료 체크(qc_issue_done 테이블, 재점검에도 유지)
- **r**: 검수 화면 품질 이슈 바(유형 선택 + ◀이전/다음▶ 순차 확인 + ✓완료 숨김)
- **s**: 명도대비 스포이드 바 숨김(코드 유지, 매뉴얼에서도 제거)
- **t**: 품질 점검 감시 10분→60분 + 종료 시 강제 갱신("진행 중" 잔류 방지)
- **u**: 단계 폴더 없을 때 [📁 단계 폴더 만들기] 버튼(nas-proxy가 base 반환)
- **v**: 과정명 변경 시 이전 이름 자동 별칭 보존(projects.nas_alias, nas-versions 매칭 반영; "AI 최적화 이론과 응용"에 소급 적용)
- **x~z**: QC 이동표시에 핵심 수치, "명도비" 명칭, 상세 문구 축약(qcDetailShort)
- **z2~z3**: POC·매뉴얼 버튼 좌측 하단 가로 배치
- **z4**: 진도 지연 판정 10→5%p
- **z5~z6**: 홈 요약 카드 관리 역할+내부 디자이너·영상담당자만
- **z7**: 외부 역할 POC 버튼 → "💬 CDMS 불편 사항 접수"
- **z8**: 외부 역할에게 사업 상태 배지(품의·진도지연 등) 숨김
- **DB/RLS**: app_see_proj·sel_projects 초대 범위 기반(과정 초대=그 과정만, 사업 초대=사업 전체) / approval_reminders D+15·D+30 단계 경고(2일 반복 폐지, 매일 09:00 크론)
- **워커 QC 기준**: v3-shots(캡처) → v4-textonly(문자구성·대비하한1.25·신뢰도82) → v5-glyphcolor(글자 획 색 5% 측정) → **v6-flatbg(단색 배경 위 학습 텍스트만 — 이미지 속 장식 텍스트 제외)**

## 7. 이 세션에서 확립된 작업 절차 (반드시 따를 것)
1. 편집: `/tmp/cdms`에 git clone 후 `git fetch origin main && git reset --hard origin/main` → **python 패치(assert count==1)** 로 수정. 마운트 폴더 파일은 stale할 수 있어 신뢰 금지.
2. 검증: index.html은 인라인 스크립트를 .mjs로 추출해 `node --check`, worker는 `python3 ast.parse`, 엣지는 typescript transpileModule.
3. 커밋: 수정본을 outputs/cdms_patch/에 복사 → GitHub 웹 업로드(파일 업로드 → 커밋 메시지 **JS로 value 주입**(첫 타이핑 유실 quirk) → Commit changes JS 클릭) → `curl -s https://cdms.mirimmedialab.co.kr | grep CDMS_BUILD`로 반영 확인. **빌드태그(CDMS_BUILD)를 반드시 올릴 것.**
4. 워커 배포: 커밋 후 사용자가 서버에서 `curl -fsSL https://raw.githubusercontent.com/ghnam7312-droid/cdms/main/nas-worker/nas_worker.py -o nas_worker.py && sudo systemctl restart cdms-nas-worker` (점검 작업 진행 중엔 재시작 금지).
5. DB: MCP apply_migration으로 운영 적용 + 같은 SQL을 `supabase/migrations/`에 기록용 커밋.
6. 품질검사 실행: nasN: 과정은 **차시 단위**(params.lesson_id)로만 nas_tasks 등록 가능. 처리 속도 ≈ 영상 길이의 20%.
