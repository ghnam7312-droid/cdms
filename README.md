# CDMS — 미림미디어랩 콘텐츠 제작관리 시스템

콘텐츠(영상강의) 제작 진행을 사업·과정·차시·제작단계 단위로 관리하는 시스템.

- **프런트**: `cdms-deploy/index.html` (단일파일 앱) → Vercel `cdms` 프로젝트로 배포 → https://cdms.mirimmedialab.co.kr
- **백엔드**: Supabase (프로젝트 ref `kowtvvrgpzgrdlnxasxw`) — DB·스토리지·인증
- **워커**: `nas-worker/nas_worker.py` (서버 systemd `cdms-nas-worker`) — NAS 스캔·영상길이·강의계획서 파싱·자동이메일·계약만료 알림
- **연동**: `nas-worker/hiworks_sync.py` — 하이웍스 조직도→직원 이메일 동기화, 지출결의 조회

> ⚠️ 비밀키(service_role·Resend·NAS 비밀번호·하이웍스 officeToken)는 **저장소에 없습니다**.
> 각 환경의 `.env`(서버 전용)에만 둡니다. `.gitignore`가 `.env`를 제외합니다.

## 폴더 구성
```
cdms-deploy/        프런트 배포 패키지(Vercel)
  index.html          CDMS 앱 본체(이 파일만 수정)
  vercel.json         정적배포 설정
  .vercel/project.json  cdms 프로젝트 연결(ids, 비밀 아님)
  deploy.bat / deploy.sh
nas-worker/         서버 워커 + 연동 스크립트
  nas_worker.py       워커 본체
  hiworks_sync.py     하이웍스 연동(조직도·지출결의)
  requirements.txt    파이썬 의존성
  .env.example        환경설정 템플릿(복사 → .env)
  setup.sh            systemd 설치
  01_check_server_worker.sh / 02_deploy_worker.sh  서버 점검·재배포
docs_하이웍스연동_안내.md   하이웍스 연동 상세 안내
HANDOVER.md         전체 인수인계(접속정보·완료/미완료·이어가는 법)
```

## 다른 PC에서 이어가기 (Quickstart)
1. **클론**: `git clone <이 저장소 URL>` → 폴더 진입.
2. **프런트 수정·배포**
   - `cdms-deploy/index.html` 편집.
   - 배포: `cd cdms-deploy && vercel deploy --prod`(Vercel 로그인 또는 토큰) 또는 `deploy.bat`.
3. **워커/연동 (서버에서)**
   - 서버 `~/.env`(또는 `/home/agent/.env`)에 비밀값 채움 (`.env.example` 참고).
   - 점검: `bash nas-worker/01_check_server_worker.sh`
   - 재배포: `bash nas-worker/02_deploy_worker.sh`
   - 하이웍스: `python3 nas-worker/hiworks_sync.py selfcheck` → `org --apply` (자세히는 `docs_하이웍스연동_안내.md`)
4. **DB**: Supabase 대시보드(SQL) 또는 MCP/CLI로 `kowtvvrgpzgrdlnxasxw` 접속.

## 필요한 비밀값 (각자 보관처에서, 서버 .env에만)
| 비밀값 | 용도 | 출처 |
|---|---|---|
| Supabase service_role | 워커·연동 | Supabase > Settings > API |
| Resend API 키 | 자동 메일 | resend.com > API Keys |
| NAS 계정/비번 | 마운트·서빙 | 시놀로지 |
| 하이웍스 officeToken | 직원/전자결재 | 오피스 관리 > 오피스 API |

상세 현황·미완료 작업은 `HANDOVER.md` 참고.
