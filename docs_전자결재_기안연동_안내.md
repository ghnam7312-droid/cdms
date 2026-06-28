# CDMS ↔ 하이웍스 전자결재(품의) 기안 연동 안내

지출결의(회계) 매칭이 아니라, **진짜 전자결재 결재상태**를 가져오는 정석 연동입니다.
하이웍스 공개 API에는 "결재함 전체 조회"가 없고, **API로 기안한 문서만** 상태를 조회/수신할 수 있으므로,
앞으로 품의를 **CDMS에서 기안**하는 방식으로 동작합니다.

## 1. 전체 흐름

```
[CDMS 사업카드 "🖊 기안"]
      │  sb.functions.invoke('hiworks-draft', {program_id, pm_id})
      ▼
[Edge Function hiworks-draft]  POST https://api.hiworks.com/office/approval/documents
      │   (officeToken + form_id + callback_url)
      │   ← 응답 {approval_key, login_url}
      │   programs.hiworks_approval_key 저장, approval_status='기안중', pm_id=기안자
      ▼
[하이웍스 결재 팝업 login_url]  ← 사용자가 새 창에서 상신/결재 진행
      │
      │  결재 상태가 바뀔 때마다 하이웍스가 GET 호출
      ▼
[Edge Function hiworks-callback]  ?approval_key=..&approval_code=..&state=..
      │   approval_key로 사업 매칭
      │   state→approval_status(complete=품의완료/rejected=반려/canceled=미등록),
      │   approval_code→approval_no(문서번호)
      ▼
[CDMS programs]  품의 상태 자동 반영 (배지: 미등록/기안중/품의완료/반려)
```

확인된 API 명세:
- 기안: `POST https://api.hiworks.com/office/approval/documents`
  필수 body: `form_id, subject, contents, callback_url, modify_contents_flag, modify_files_flag`
  응답: `{ code:"SUC", data:{ approval_key, login_url } }`
- 콜백(GET): `?office_id&approval_key&approval_id&approval_code&state`
  state 값: `progress`(기안)·`complete`(완료)·`rejected`(반려)·`canceled`(취소)
- 상태조회(보강): `GET https://api.hiworks.com/approval/v2/documents/{approval_id}` → `attributes.state`

## 2. 이 저장소에 추가된 것

```
supabase/
  migrations/20260628_hiworks_approval.sql   programs 컬럼 추가(hiworks_approval_key, hiworks_approval_id)
  functions/hiworks-draft/index.ts           기안(상신페이지 생성) — officeToken 보관
  functions/hiworks-callback/index.ts        상태 수신 콜백(공개)
cdms-deploy/index.html                       사업카드 '🖊 기안' 버튼 + draftApproval() + 배지 상태표시
```

> 아직 **배포는 하지 않았습니다**(코드만). 아래 순서대로 배포하세요.

## 3. 사전 준비 — form_id(품의서 양식 ID) 발급

1. 오피스 로그인 → **오피스 관리 > 환경설정 > API 관리**에서 애플리케이션(연동) 승인.
2. **전자결재 관리자 설정 > 양식함 관리**에서 연동에 사용할 **품의서 양식**의 "연동 사용"을 켜면 **양식 ID(form_id)**가 부여됩니다.
3. 이 form_id 를 아래 시크릿 `HIWORKS_FORM_ID` 로 사용합니다.
   (자세히는 하이웍스 개발자센터 문서의 form_id "발급 방법" 참고.)

## 4. 배포

### 4-1. DB 마이그레이션
Supabase SQL 편집기에서 `supabase/migrations/20260628_hiworks_approval.sql` 실행
(또는 CLI: `supabase db push`).

### 4-2. Edge Function 시크릿 설정 (서버 전용, 비공개)
```
supabase secrets set \
  HIWORKS_OFFICE_TOKEN_DRAFT="기안할 오피스의 officeToken" \
  HIWORKS_FORM_ID="품의서 양식 ID" \
  HIWORKS_CALLBACK_URL="https://<프로젝트>.supabase.co/functions/v1/hiworks-callback" \
  HIWORKS_OFFICE_ID="우리 office_id (선택, 콜백 검증용)"
# SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 기본 제공됨
```
> ⚠️ officeToken·service_role 은 절대 깃/프런트/문서/채팅에 넣지 마세요. 시크릿으로만.

### 4-3. 함수 배포
```
supabase functions deploy hiworks-draft                       # 로그인 사용자 호출(anon 키)
supabase functions deploy hiworks-callback --no-verify-jwt    # 하이웍스가 외부에서 호출(공개)
```
`HIWORKS_CALLBACK_URL` 은 배포된 hiworks-callback 의 URL 과 일치해야 합니다.

### 4-4. 프런트 배포
`cdms-deploy/index.html` 을 평소처럼 Vercel 배포(`deploy.bat`/`vercel deploy --prod`).

## 5. 사용

- 진행표 사업 줄의 품의 배지 옆 **🖊**(미등록·반려 상태에서 PM·어드민에게 노출) 클릭 → 하이웍스 결재 팝업 → 상신.
- 상신/결재가 진행되면 콜백으로 **자동 반영**: 미등록 → 기안중 → 품의완료(또는 반려). 문서번호도 자동 기록.
- 기안한 사람(PM)이 `pm_id`(담당자)로 함께 기록됩니다.

## 6. 한계 / 참고

- **기존에 하이웍스 웹에서 사람이 직접 올린 품의서**는 CDMS가 문서번호를 모르므로 이 방식으로 소급 동기화되지 않습니다. (그 건들은 ① 수기 입력 유지, 또는 ② 지출결의 매칭(hiworks_sync.py), 또는 ③ 가비아 제휴 API)
- 기안 화면은 **팝업(login_url)** 으로 열려 사용자가 상신을 마무리하는 반자동 방식입니다(완전 무인 상신은 불가).
- 콜백이 누락될 경우를 대비해 워커가 `GET /approval/v2/documents/{approval_id}` 로 주기 폴링하도록 보강할 수 있습니다(후속).
