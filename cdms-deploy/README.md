# CDMS 외부 작업(수정·재배포) 패키지

CDMS는 **단일 파일 웹앱**입니다. `index.html` 하나만 고치고 배포하면 됩니다.
- 백엔드(Supabase) 주소·키는 `index.html` 안에 내장돼 있어 별도 서버 설정이 필요 없습니다.
- 라이브 주소: **https://cdms.mirimmedialab.co.kr** (Vercel `cdms` 프로젝트)
- 이 폴더의 `.vercel/project.json` 이 그 프로젝트에 미리 연결돼 있어, 어느 PC에서 배포해도 같은 주소로 반영됩니다.

---

## 1. 준비 (다른 PC에서 최초 1회)

1) **Node.js LTS** 설치 — https://nodejs.org (npm 포함)
2) 끝. (Vercel CLI는 배포 스크립트가 자동 설치합니다.)
3) 첫 배포 때 브라우저가 열려 **Vercel 로그인**을 요청합니다 → **ghnam7312-droid** 계정으로 로그인하세요.
   (이 계정이 cdms 프로젝트 소유자입니다.)

## 2. 수정하기

`index.html` 을 편집기(VS Code, 메모장 등)로 열어 고칩니다.
- 미리보기: `index.html` 을 브라우저로 그냥 열면 실제 Supabase 데이터와 함께 동작합니다(로컬에서 바로 확인 가능).

## 3. 배포하기

- **Windows**: `deploy.bat` 더블클릭
- **macOS/Linux**: 터미널에서 `bash deploy.sh`

→ Vercel `cdms` 프로젝트의 프로덕션으로 배포되고, 잠시 후 https://cdms.mirimmedialab.co.kr 에 반영됩니다.

## 4. 구성

```
cdms-deploy/
├─ index.html            ← CDMS 앱 (이 파일만 수정)
├─ vercel.json           ← 정적 배포 설정
├─ .vercel/project.json  ← cdms 프로젝트 연결(orgId/projectId) — 건드리지 마세요
├─ deploy.bat            ← Windows 배포
└─ deploy.sh             ← macOS/Linux 배포
```

## 5. 참고 / 보안

- `index.html` 에는 Supabase **publishable(공개) 키**(`sb_publishable_...`)만 들어 있습니다. 이 키는 클라이언트에 노출돼도 되는 공개 키이며,
  데이터 보호는 Supabase의 RLS(행 수준 보안) 정책으로 합니다. (서비스 role 키 / secret 키는 절대 이 파일에 넣지 마세요.)
- 배포 권한은 Vercel 계정(ghnam7312-droid)으로 통제됩니다. 외부 협업자에게 배포를 맡기려면
  Vercel 팀에 멤버로 초대하는 방식을 권장합니다(계정/비밀번호 공유 대신).
- 도메인(cdms.mirimmedialab.co.kr)은 cdms 프로젝트에 이미 연결돼 있어 재배포해도 그대로 유지됩니다.

## 6. 문제 해결

- `vercel: command not found` → `npm i -g vercel` 후 다시 실행.
- 로그인 후 다른 프로젝트로 배포되는 듯하면 → 이 폴더에서 실행했는지 확인(.vercel 폴더가 있어야 함).
- 배포는 됐는데 사이트가 그대로면 → 브라우저 강력 새로고침(Ctrl+F5).
