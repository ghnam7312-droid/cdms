# CDMS ↔ 하이웍스 연동 안내

하이웍스 **Open API(REST)** 로 (1) 직원정보(조직도)와 (2) 전자결재(지출결의) 를 가져옵니다.
하이웍스 전용 커넥터(MCP)는 없어 공식 API로 직접 연동합니다.

## 0. 무엇이 되고, 무엇이 제약인가
- ✅ **직원정보(조직도)**: 전 직원 이름·이메일·부서를 가져와 CDMS `users`에 동기화 → **PM 이메일 문제(작업 C) 해결**. 제휴 승인 불필요.
- ⚠️ **전자결재**: 공개 API가 제공하는 건 **지출결의(회계) 데이터**입니다(`spending_report`). 품의서 자체의 결재상태(품의완료/미등록)와는 **다른 문서**라, 사업명→`approval_status` 자동반영은 매칭 정확도 확인 후 적용을 권장합니다. 품의서 결재상태까지 필요하면 가비아 **제휴 문의**(partner API)가 필요할 수 있습니다.

## 1. 인증: Office Token 발급 (관리자)
하이웍스 **[오피스 관리 > 오피스 API]** 에서 `officeToken` 발급.
- OAuth(Access Token)는 **신규 발급 중단(deprecated)** → 사용 불가.
- officeToken은 오피스 전체 권한 → 비밀번호처럼 취급. 서버 `.env`에만 보관.
- 지출결의 조회는 scope **`office.accounting`** 필요. 권한이 막혀 있으면 가비아 제휴 문의.

## 2. 사용하는 엔드포인트 (확인 완료)
| 용도 | 메서드 · 경로 |
|---|---|
| 조직도 전체 | `GET https://api.hiworks.com/hrm/v2/organizations` |
| 사용자 목록 | `GET https://api.hiworks.com/hrm/v2/users` |
| 지출결의 조회 | `GET https://api.hiworks.com/open/office/accounting/spending_report?fixed_date=YYYYMM&approval_status=C` |

공통 헤더: `Authorization: Bearer {officeToken}` · `Content-Type: application/json`
한도: 오피스당 **1,000건/일** (일 1회 동기화엔 충분).

## 3. .env 추가 항목 (워커 서버 .env에)
오피스(지점)가 여러 개면 **콤마로 나열**하면 모든 오피스 조직도를 합쳐서 가져옵니다.
라벨(상암/강서401호 등)은 로그 표시용이며 생략 가능합니다.
```
# ===== 하이웍스 연동 =====
# [오피스 관리 > 오피스 API]의 오피스 토큰들. 라벨=토큰, 콤마 구분.
HIWORKS_OFFICE_TOKEN=상암=0763...,강서401호=d76e...,강서406호=3a1f...,대구=ad7a...
# 조직도 email이 비어 올 때 mail_id@도메인 으로 보정 (회사 메일 도메인)
HIWORKS_MAIL_DOMAIN=mirimmedialab.co.kr
HIWORKS_API_BASE=https://api.hiworks.com
# (이미 워커 .env에 있는 값 재사용)
SUPABASE_URL=https://kowtvvrgpzgrdlnxasxw.supabase.co
SUPABASE_SERVICE_ROLE_KEY=여기에_service_role_키
```
> ⚠️ officeToken·service_role 키는 **서버 .env에만**. 깃/프런트/문서/채팅에 넣지 마세요.
> 토큰이 외부에 노출됐다면 [오피스 관리 > 오피스 API]에서 **재발급**(기존 다른 연동에 영향 주는지 확인 후).

## 4. 실행 (서버에서, 워커 venv 사용 권장)
```bash
# 0) 연결·권한 점검
python3 hiworks_sync.py selfcheck

# 1) 직원정보 → CDMS users 이메일
python3 hiworks_sync.py org                 # 미리보기(변경 안 함)
python3 hiworks_sync.py org --apply         # 실제 반영(임시 @mirim.local 만 채움)
python3 hiworks_sync.py org --apply --insert  # CDMS에 없는 직원도 추가
python3 hiworks_sync.py org --apply --force   # 실제 이메일도 덮어쓰기

# 2) 전자결재(지출결의) 조회 + 사업 매칭 프리뷰
python3 hiworks_sync.py spending --month 202606            # 해당월 전체
python3 hiworks_sync.py spending --month 202606 --status C # 결재완료만
```
표준 라이브러리만 써서 추가 설치 없이 `python3`로 바로 실행됩니다.

## 5. 동작 방식 (직원정보 동기화)
1. 조직도(`/hrm/v2/organizations`)를 받아 중첩 부서를 평탄화 → 직원 목록(이름·mail_id·email·부서).
2. 이메일 = `email`이 있으면 그대로, 비어 있으면 `mail_id@HIWORKS_MAIL_DOMAIN`.
3. CDMS `users`를 **이름으로 매칭**.
   - 임시값(`@mirim.local`)이거나 빈 값이면 → 새 이메일로 **업데이트**.
   - 실제 이메일이 이미 있으면 → 기본은 건너뜀(`--force`로 덮어쓰기).
   - CDMS에 없는 이름은 건너뜀(`--insert`로 신규 추가).
4. `--apply` 없이는 **변경 미리보기만** 출력. 안전 확인 후 `--apply`.

## 6. 정기 실행(선택)
워커 서버 cron 예시(매일 06:30 직원정보 동기화):
```
30 6 * * *  cd /home/agent && ./venv/bin/python3 hiworks_sync.py org --apply >> ~/hiworks.log 2>&1
```

## 7. 전자결재 품의 매칭 → 자동반영 (구현됨)
지출결의(spending_report)를 CDMS `programs`의 발주처/사업명과 매칭해 `approval_status`를 갱신합니다.

### 매칭 방식 (점수제)
- **발주처 일치**(programs.client ↔ 지출결의 거래처/적요): +3
- **사업명 키워드 일치**(대괄호·연도·일반어 제거 후 토큰이 적요/거래처에 포함): 1개당 +1
- `--min-score`(기본 **4** = 발주처+키워드1) 이상이면 매칭 인정.
  - `--min-score 3` = 발주처만 일치해도 인정(같은 발주처 사업이 여러 건이면 함께 매칭될 수 있어 주의).

### 실행
```bash
# 1) 미리보기(변경 없음): 매칭표 + 변경안 출력
python3 hiworks_sync.py spending --month 202606

# 2) 실제 반영: 매칭된 사업을 '품의완료'로 갱신 (기본 결재완료 status=C만 대상)
python3 hiworks_sync.py spending --month 202606 --apply

# 3) 자동 환원까지: 매칭 사라진 자동기입 건을 '미등록'으로 되돌림
python3 hiworks_sync.py spending --month 202606 --apply --downgrade

# 옵션
#   --min-score 3   (발주처만 매칭, 모호 매칭 늘 수 있음)
#   --year 2026
#   --force-pm      (기존 담당자도 기안자로 덮어쓰기 / 기본은 빈 담당자만 채움)
#   --no-pm         (담당자 기록 생략, 품의상태만 반영)
```

### 담당자(PM) 자동 기록
매칭된 사업은 해당 지출결의의 **기안자(register_name)**를 이름으로 CDMS `users`와 매칭해 **담당자(`pm_id`)**로 기록합니다.
- 기본은 **담당자가 비어 있는 사업만** 채웁니다(기존 담당자 보호). 덮어쓰려면 `--force-pm`.
- 기안자 이름이 CDMS `users`에 없으면 미반영으로 표시 → 먼저 `org --apply --insert`로 직원 동기화 권장.
- 담당자 기록을 원치 않으면 `--no-pm`.

### 안전장치 (중요)
- **기본은 미리보기**(dry-run). `--apply`를 줘야 DB에 씁니다.
- **수기 입력한 실제 품의서 번호는 절대 건드리지 않습니다.** 워커가 자동 기입한 건은 `approval_no`에 `HW지출결의:` 접두사를 붙여 구분하며, `--downgrade`도 이 표식이 붙은 건만 환원합니다.
- 빈 `approval_no`에만 `HW지출결의:{문서코드}`를 채워 UI 배지(품의완료)가 반영되게 합니다.
- ⚠️ 지출결의(회계)는 '품의서' 결재상태와 **다른 문서**입니다. `--apply` 전에 반드시 미리보기로 매칭 정확도를 확인하세요. 품의서 결재상태(결재선/문서함) 자체가 필요하면 가비아 제휴 문의 후 partner API 범위를 받아 확장합니다.

### 정기 실행(선택, 매월 1회 예시)
```
0 7 1 * *  cd /home/agent && ./venv/bin/python3 hiworks_sync.py spending --month $(date +\%Y\%m) --apply >> ~/hiworks.log 2>&1
```
