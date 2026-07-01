# CDMS 인수인계 / 작업 현황 (다른 PC에서 이어가기)

> 미림미디어랩 콘텐츠 제작관리(CDMS). 이 문서 하나로 현재 상태·접속정보·완료/미완료·이어가는 법을 파악할 수 있습니다.
> ⚠️ 비밀키(서비스키·비밀번호)는 보안상 이 문서에 넣지 않았습니다. "필요한 비밀값" 항목에서 어디서 구하는지 안내합니다.

---

## 0. 최신 업데이트 (2026-06-30) — 이 부분부터 보세요

### ★ 배포가 자동입니다 (가장 중요)
push 한 번이면 프런트·백엔드가 함께 배포됩니다(토큰 재입력 불필요).
- **프런트(cdms-deploy)**: Vercel↔GitHub 연동. Root Directory=`cdms-deploy`, 브랜치 `main`. push → 자동 배포.
- **Supabase Edge Functions**: GitHub Actions `.github/workflows/deploy-supabase.yml`. `supabase/functions/**` 변경을 push하면 5개 함수(hiworks-draft·hiworks-callback·request-access·sales-sync·nas-proxy) 자동 배포.
- **DB 마이그레이션**: 자동 아님(안전). GitHub → Actions → 'Deploy Supabase' → **Run workflow**에서 `run_migrations` 체크 시 `supabase db push` 실행.
- 필요한 GitHub Actions 시크릿(이미 등록): `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`. Supabase 함수 시크릿(RESEND/HIWORKS 등)은 Supabase에 저장 — 새 PC에서 재입력 불필요.
- ⚠️ 함수는 **리포 소스가 정본**입니다. 대시보드/MCP로 직접 배포하지 말고 리포 파일을 고쳐 push 하세요(안 그러면 다음 Actions 실행 때 되돌아갑니다).
- 프로젝트: Vercel `cdms`, **Root Directory = `cdms-deploy`**, Production 브랜치 `main`.
- 다른 PC 작업: `git clone` → `cdms-deploy/index.html` 수정 → `git commit` → `git push` → 1~2분 후 https://cdms.mirimmedialab.co.kr 반영.
- 로컬에 Vercel 로그인/CLI 필요 없음. 빌드 없음(정적 단일 파일).

### 디자인·UX
- 미림미디어랩 **브랜드 퍼플** 테마(#9B5ED3 계열), 사이드바 그라데이션, 로그인 화면 퍼플.
- **우측 상단 로고**(클릭 = 홈/전체 진행표).
- 금액 표기 콤마+원(예: 6,100만원 / 1.05억원). 사이드바 부제목·상단 연도문구 정리.
- **브라우저 뒤로/앞으로**로 전체진행표↔과정별진행표 이동(History API).
- 사용자 관리 모달: 이름·이메일 검색 + 역할 필터, 폭 확대, '담당' 칸 제거, 역할 정의 표(구분·범위·앱권한·NAS 권한, 가운데 정렬).
- 새 사업 만들기: '학교(대학)' 입력 제거 → **사업▸과목 직접 구조**.

### 매출 동기화 알림
- 신규 사업 추가 시 어드민에게 **메일(Resend)+하이웍스 메신저(/office/v2/notify)** 자동 알림. 시크릿: `RESEND_API_KEY`, `HIWORKS_NOTIFY_TOKEN`(Edge Function Secrets).
- **미수금 0(빈칸)+실계약** 사업은 '✓ 사업완료' 배지 자동 표시(sales-sync가 settled 설정).

### 역할·권한 (DB roles + 프런트 ROLES)
- 역할 추가: 사업담당자/고객사 담당자/외주설계자·외주디자이너·외주영상담당자·외주속기.
- **권한 매트릭스 적용**: 역할별 범위·편집단계(st)·NAS(보기/읽기/쓰기). NAS 삭제는 미사용(제거).
- **보기 범위(RVIEW)**: 과정 보드/상세에서 역할의 담당 폴더 단계 컬럼만 표시(진행률 집계는 전체 유지).
- 사용자 관리·초대: 어드민 전용(사용자 관리), 초대=어드민·PM.

### 추가된 마이그레이션 (supabase/migrations/)
`10_program_settled` · `11_roles_external` · `12_roles_nas_perms` · `13_role_permission_matrix`.
새 PC/새 환경에서 DB 복제 시 09까지에 더해 10~13도 적용.

---

## 0. 최신 업데이트 (2026-06-29) — 이 부분부터 보세요
이후 작업이 많이 추가됐습니다. 아래는 **3~8장보다 우선하는 현재 상태**입니다.

### 추가된 백엔드 — Supabase Edge Functions (대시보드 Functions 탭, 모두 라이브)
| 함수 | 역할 | verify_jwt |
|---|---|---|
| `hiworks-draft` | CDMS→하이웍스 전자결재 **기안 생성**(N68 양식, contents 공백 처리) | true |
| `hiworks-callback` | 결재 콜백 — **품의완료 시 PM 확정**(hiworks_drafter_id→pm_id) | false |
| `request-access` | 담당자 **셀프 가입/초대** 허용목록 검증 + inviteUserByEmail | false |
| `sales-sync` | **매출시트 CSV→사업 동기화** + **신규 사업 시 어드민 알림(메일+하이웍스 메신저)** | false |

### 자동 매출 동기화 + 알림 (완전 무인)
- `sales-sync`가 **pg_cron `cdms-sales-sync`** 로 매일 **06:30 KST(21:30 UTC)** 자동 실행. CSV 공개링크 파싱→번호=seq로 사업 갱신/신규.
- **사업명·과목·차시·진행률은 절대 미변경**. 고객명·계약금액·계약기간·PM만 반영.
- **신규 사업(insert) 발생 시에만** 어드민(role=admin) 전원에게 알림:
  - 메일(Resend) — 어드민 `users.email` 전원
  - 하이웍스 메신저(`POST /office/v2/notify`) — 어드민 `users.hiworks_id`(null 제외)
- 테스트: `GET /functions/v1/sales-sync?notify_test=1` (실제 동기화 없이 알림만 1회).
- 관련 마이그레이션: `20260629_08_sales_sync_cron.sql`, `20260629_09_users_hiworks_id.sql`.

### 로그인 / 권한 (RLS)
- **로그인 ID = 이메일**. 기존 직원은 하이웍스 이메일로, 최초 접속 시 **본인이 비밀번호 설정**(Supabase Auth + Resend SMTP). 초대메일/재설정메일은 한글 템플릿(`email_invite_ko.html`, `email_reset_ko.html`).
- **역할**: admin/pm/planner/sme/reviewer/designer/video/steno/trans/dev/vendor/**biz(사업담당자)**/**client(고객사 담당자)**.
- **담당자 초대**: 사업명(여러 개)+과목+역할 지정. 초대된 사람은 **배정된 사업/과목/역할 범위만** 열람·수정.
- **RLS**(마이그레이션 03~07): admin=전체, 그 외=배정된 사업/과목만. `app_is_admin/app_see_prog/app_see_proj/app_see_lesson` 함수 기반. 검증 완료.
- 어드민 **사용자 관리 UI**(조회/수정/역할/추가/삭제), **PM 변경** 버튼(어드민).

### 데이터
- 2026 사업 **1~20**(seq20 관세국경 포함, 관세법 18차시·FTA특례법 15차시 추가). 매출시트 26행과 정합.

### Edge Function 시크릿 (Supabase 대시보드 > Edge Functions > Secrets) — 설정 완료
`RESEND_API_KEY`, `HIWORKS_NOTIFY_TOKEN` (+ 선택 `NOTIFY_MAIL_FROM`). 워커 `.env`와 별개. 값은 깃/문서에 없음.

### 남은 한 가지
- 남기환(어드민)은 gmail이라 `hiworks_id`가 비어 메신저 미수신(메일은 받음). 하이웍스 로그인ID를 `users.hiworks_id`에 넣으면 메신저도 수신.


---

## 1. 시스템 구조 (한눈에)

```
[브라우저] ── https://cdms.mirimmedialab.co.kr ──> [Vercel: index.html 단일파일 앱]
                                                        │  (anon/publishable 키 내장)
                                                        ▼
                                              [Supabase] DB · 스토리지 · 인증
                                                        ▲
                        nas_tasks 큐 / 기록  │           │ service_role 키
                                             ▼           │
[ai-agent 서버] ── nas_worker.py (systemd) ──┘   읽기: [시놀로지 NAS]  발송: [Resend 메일]
```

- **프런트**: `index.html` 단일파일. Vercel `cdms` 프로젝트로 배포 → `cdms.mirimmedialab.co.kr`.
- **백엔드**: Supabase(프로젝트 `kowtvvrgpzgrdlnxasxw`). 테이블·스토리지·로그인.
- **워커**: ai-agent 리눅스 서버에서 `nas_worker.py`를 systemd(`cdms-nas-worker`)로 상시 구동. NAS 스캔·이메일·강의계획서 파싱·검수영상·계약만료 알림 담당.
- **NAS**: 시놀로지(192.168.0.48). 콘텐츠 원본 보관.
- **메일**: Resend(인증 도메인 `noti.mirimmedialab.co.kr`).

---

## 2. 자원 / 접속 정보

| 항목 | 값 |
|---|---|
| 라이브 주소 | https://cdms.mirimmedialab.co.kr |
| Vercel 프로젝트 | `cdms` (projectId `prj_hV2VLrCA0AIxIBk4pj2jmPguOEaD`, team `team_RNvh8Ly5KcPrhlj5ukvsq03q` = ghnam7312-droid) |
| Vercel 배포 계정 | ghnam7312-droid (브라우저 로그인) |
| Supabase 프로젝트 | ref `kowtvvrgpzgrdlnxasxw` · URL `https://kowtvvrgpzgrdlnxasxw.supabase.co` |
| Supabase 공개키 | `index.html`에 내장된 `sb_publishable_...` (노출돼도 되는 키, RLS로 보호) |
| 워커 서버 | ai-agent (Tailscale IP `100.104.41.9`, SSH 계정 `agent`) · 경로 `~/nas_worker.py`, `~/venv`, `~/.env` · 서비스 `cdms-nas-worker` |
| NAS | 시놀로지 192.168.0.48 · DSM `https://mirimlab.myds.me:4801` · SFTP/SSH 4848 · 계정 `cdms_user` · 공유 `cdms` |
| NAS 마운트(워커) | `/mnt/kepco` = `//192.168.0.48/2026_04_한국환경보전원` (읽기전용, 계정 mirim_readonly) |
| 메일 | Resend · 인증도메인 `noti.mirimmedialab.co.kr` · 발신 `noreply@noti.mirimmedialab.co.kr` |

---

## 3. ✅ 완료된 것 (한 것) — 모두 라이브 반영됨

### 프런트(index.html) — 배포 완료
- **첫 화면: 연도별 전체 진행표** — 연도 선택 → 사업(계약)별 접힘/펼침(아코디언). 사업 줄에 **연번(001…)·발주처·PM·과정수·사업금액·완료기간·품의여부 배지**. 연번 **내림차순** 정렬(작은 번호 아래).
- **과정별 진행표** — 주차/차시·차시명·**영상길이·총길이·형식** + 제작단계 컬럼(원고·촬영·가편·스크립트·스토리보드·디자인·종편·srt·번역·학습자료). 각 셀 = **담당자+파일수정일/상태**.
- **어드민 사업 삭제(🗑)**, 사업 안에서 **과정 추가/삭제**.
- **차시명·영상길이 입력**, **단계 담당자 지정**(자동이메일 대상).
- **강의계획서 업로드 + 📥 차시 자동생성**(워커 파싱).
- **NAS 동기화 / 🗂 폴더명 관리** 버튼.
- **🎬 영상검수** — 영상 플레이어 + 타임스탬프 코멘트 + 완료체크 + 버전(이미지블 유사).

### Supabase 백엔드 — 적용 완료
- 컬럼 보강: `lessons`(duration_sec, format, file_mtime, file_name, review_path, review_ver), `lesson_stage`(file_mtime, file_name), `programs`(year, seq, amount, contract_start/end, contract_period, approval_no, approval_status).
- 테이블 신설: `stage_assignees`, `email_notifications`, `reminders`, `review_comments`, 스토리지 버킷 `review`. `stages`에 `번역(13)` 추가.
- FK **CASCADE** — 사업/과정 삭제 시 하위 차시·기록 자동 정리.
- **2026 사업 1~19 + 과정** 데이터 생성(구글시트 기반, 진행율·PM·금액·기간·품의번호 반영).

### NAS 워커(nas_worker.py) — 코드 완성(서버 반영은 "해야 할 것" 참고)
- **자동스캔**: 단계 폴더 파일유무·수정일 → 진행상태 / `07_종편` ffprobe → 영상길이. 10분 주기 + UI 즉시.
- **폴더**: 생성(mkdir_tree)·이름변경(rename_folder)·구조읽기(sync_names).
- **강의계획서 파싱**: HWP/HWPX/PDF/Word/PPT/Excel → 주차·차시 자동생성.
- **자동이메일**: 단계 완료 → 다음 단계 담당자(Resend). 중복방지.
- **계약만료 알림**: 완료일 30·14·7일 전 → PM(또는 폴백 메일). 하루 1회.
- **검수영상**: 종편 → 480p 프록시 → Supabase 업로드(현재) / 또는 시놀로지 직접 URL 모드(`NAS_PUBLIC_BASE` 설정 시).

### 검증 완료
- Resend 인증도메인으로 **실제 메일 발송 성공** 확인.
- NAS 스캔·매칭·영상길이·폴더명변경 **실데이터/단위테스트** 통과.

---

## 4. 🔲 해야 할 것 (남은 작업)

### A. 서버 워커 최신화 (가장 먼저 확인)
최근 추가분(**계약만료 알림 · 검수영상 프록시 · 시놀로지 모드 · 강의계획서 파싱**)이 서버에 반영됐는지 확인.
- `nas_worker.py` 최신본을 서버에 **재전송(scp)** → `~/venv/bin/pip install -q -r requirements.txt`(파싱 라이브러리) → `sudo systemctl restart cdms-nas-worker`.
- requirements: `pdfplumber python-docx python-pptx openpyxl pyhwp` (이미 requirements.txt에 포함).

### B. 영상검수 — 시놀로지 호스팅 마무리 (진행 중)
- DSM에서 **Web Station**으로 검수영상 폴더를 **HTTPS 공개 서빙** → 베이스 URL 확보.
- 워커 `.env`에 `NAS_PUBLIC_ROOT`, `NAS_PUBLIC_BASE` 입력 → 재시작.
- 종편이 **mp4(H.264)** 여야 임베드 재생. (아니면 Supabase 480p 프록시 모드 유지)
- ※ 현재는 Supabase 프록시로도 동작함. 단 무료 저장 1GB 한계.

### C. PM·담당자 실제 이메일
- 현재 PM 계정 이메일이 임시값(`@mirim.local`) → 알림이 폴백 주소로 감. **실제 이메일**을 `users` 테이블에 입력 필요(또는 PM 이메일 수정 UI 추가).

### D. 미구현 기능
- **달력(촬영·주요 일정 + 단계 마감일) + 1일전 담당자 알림** — 미착수.
- **영상별 형식** — 형식 칸은 이미 있음. 추가 표기 요청 시 보완.
- **하이웍스 전자결재 연동(Phase 2)** — ✅ 코드 구현됨: `hiworks_sync.py spending --apply`(발주처+사업명 점수 매칭 → `approval_status` 자동반영, 수기 품의번호 보호). 남은 것: 서버에서 실토큰으로 미리보기→정확도 확인 후 `--apply`. 품의서 결재상태 자체가 필요하면 가비아 제휴 API 필요. 상세 `docs_하이웍스연동_안내.md` 7장.

### E. 운영 데이터
- NAS↔과정 연결은 현재 **한국환경보전원(/mnt/kepco)** 만. 다른 사업 NAS도 마운트·연결 필요.
- 폴더명 CDMS→NAS 변경은 마운트가 **읽기전용**이라 미동작 → 쓰기 권한 계정(`cdms_user`) 활용한 쓰기 마운트 추가 시 동작.
- 데모 잔여물(HUSS 2026 등) 정리는 어드민 🗑로 가능.

---

## 5. 다른 PC에서 이어가는 법

### 5-1. 프런트 수정·배포
1. `cdms-deploy/` 폴더 확보. `index.html`을 편집기로 수정.
2. 배포: `deploy.bat` 더블클릭(맥/리눅스 `bash deploy.sh`) → 브라우저로 **Vercel 로그인(ghnam7312-droid)**.
   - 또는 Vercel **액세스 토큰**으로 API 배포(빠름). 토큰: https://vercel.com/account/tokens 에서 발급 → 1회용 권장.
3. 미리보기: `index.html`을 브라우저로 그냥 열어도 실DB로 동작.

### 5-2. 워커(서버) 작업
1. `nas-worker/` 폴더를 ai-agent 서버에 전송(scp). (Tailscale `agent@100.104.41.9`)
2. 최초: ffmpeg 설치, `python3 -m venv venv && ./venv/bin/pip install -r requirements.txt`, `.env` 작성(아래 비밀값), `bash setup.sh`(systemd 등록).
3. 자가진단: `./venv/bin/python3 nas_worker.py selfcheck` → ffprobe·Supabase·NAS·이메일 PASS 확인.
4. 수정 반영: nas_worker.py 재scp → `sudo systemctl restart cdms-nas-worker`. 로그: `journalctl -u cdms-nas-worker -f`.

### 5-3. DB 작업
- Supabase 대시보드(SQL 편집기) 또는 MCP/CLI로 `kowtvvrgpzgrdlnxasxw` 접속.

---

## 6. 필요한 비밀값 (이 문서엔 미포함 — 각자 보관처에서)

| 비밀값 | 어디에 쓰나 | 어디서 구하나 |
|---|---|---|
| Vercel 로그인/토큰 | 프런트 배포 | ghnam7312-droid 계정 / vercel.com/account/tokens |
| Supabase **service_role** 키 | 워커 `.env` (서버 전용) | Supabase → Settings → API → service_role |
| Resend API 키 | 워커 `.env` | resend.com → API Keys |
| Resend API 키 | **Edge Function 시크릿**(매출 알림 메일) | resend.com → API Keys |
| 하이웍스 officeToken | **Edge Function 시크릿** `HIWORKS_NOTIFY_TOKEN`(메신저) + 워커 `.env`(조직/지출) | 하이웍스 오피스관리 > 오피스 API |
| NAS 계정/비번 | 마운트·서빙 | 시놀로지 `cdms_user` / mirim_readonly |

> ⚠️ service_role·Resend·NAS 비밀번호는 **서버 `.env`에만** 두고, 절대 `index.html`·깃·문서에 넣지 마세요. 공개키(sb_publishable)만 프런트에 내장.

---

## 7. 파일 구성

```
cdms-deploy/          ← 프런트 배포 패키지(Vercel)
  index.html            CDMS 앱(이 파일만 수정)
  vercel.json           정적배포 설정
  .vercel/project.json  cdms 프로젝트 연결
  deploy.bat / deploy.sh  배포 스크립트
  README.md
nas-worker/           ← 서버 워커
  nas_worker.py         워커 본체(스캔·이메일·파싱·검수·알림)
  requirements.txt      파이썬 의존성
  .env.example          환경설정 템플릿(복사→.env)
  setup.sh              턴키 설치(systemd)
  Dockerfile / docker-compose.yml  도커 대안
  README_worker.md      워커 설명
HANDOVER.md           ← 이 문서
```

---

## 8. 마지막 작업 지점 (이어서 할 것 우선순위)
1. **워커 최신본 서버 반영**(A) — 안 했으면 가장 먼저.
2. **시놀로지 Web Station 서빙 → NAS_PUBLIC_BASE 확정**(B) — 영상검수 임베드 완성.
3. **PM 실제 이메일 입력**(C) — 알림 정상 발송.
4. **달력 + 1일전 알림**(D) 신규 구현.
5. **하이웍스 전자결재 연동**(D, Phase 2) — 코드 완료. 서버에서 `spending` 미리보기로 매칭 확인 후 `--apply`.
