# 작업 A — 워커 서버 최신화 점검·재배포 (실행 안내)

> 목적: 서버(ai-agent)의 `nas_worker.py`가 패키지 최신본과 같은지 확인하고,
> 다르면 재배포(scp → pip → 재시작 → selfcheck)까지 한다.
> HANDOVER 우선순위 1순위 작업입니다.

## 0. 결론 먼저
- 패키지 안 `nas_worker.py`(969줄, md5 `2d11b9505bab52e861b5e39cc69ce0d6`)는
  **4개 최신 기능이 전부 들어간 완전판**이며 서버에 반영돼야 할 **기준본**입니다.
  - 계약만료 알림 `check_contract_reminders`
  - 검수영상 프록시 `action_make_review_proxy`
  - 시놀로지 직접서빙 모드 `NAS_PUBLIC_BASE`
  - 강의계획서 파싱 `action_parse_syllabus` (+ `hwp5txt`)
- 서버가 사설망(Tailscale)이라 자동 점검은 **새 PC에서 아래 스크립트로** 진행하세요.

## 1. 사전 준비 (새 PC)
1. **Tailscale** 로그인 → 서버 `100.104.41.9` 가 보이는지 확인.
2. **ssh/scp** 사용 가능해야 함.
   - Windows 10/11: 기본 내장(PowerShell에서 `ssh`, `scp` 동작). bash는 **Git Bash** 또는 **WSL** 사용.
   - Mac/Linux: 기본 내장.
3. 두 스크립트(`01_check_server_worker.sh`, `02_deploy_worker.sh`)를 패키지의
   **`nas-worker/` 폴더 안**(= `nas_worker.py`와 같은 위치)에 둡니다. ← 중요

## 2. 실행
폴더에서 터미널을 열고:

```bash
# 1) 점검
bash 01_check_server_worker.sh
```

출력 맨 아래 결론을 봅니다.
- **"서버 최신 — 재배포 불필요"** → 끝. (환경값만 바꿨다면 3-B의 재시작만)
- **"재배포 필요"** → 다음:

```bash
# 2) 재배포 (서버 ~/.env 가 이미 채워져 있을 때)
bash 02_deploy_worker.sh
```

## 3. 결과 해석 / 수동 명령
점검 스크립트가 보여주는 것:
- `[1]` 로컬 vs 서버 **md5** — 같으면 코드 동일.
- `[2]` 서버 파일의 **4개 기능 시그니처** — 하나라도 FAIL이면 그 기능이 서버에 없음.
- `[3]` 서비스 `cdms-nas-worker` **active/enabled** 여부.
- `[4]` 최근 로그 15줄.

**A. 수동 점검(스크립트 대신):**
```bash
ssh agent@100.104.41.9 'md5sum ~/nas_worker.py; grep -c "def check_contract_reminders" ~/nas_worker.py'
```

**B. 환경값만 바꾸고 재시작(코드 동일할 때):**
```bash
ssh agent@100.104.41.9 'nano ~/.env && sudo systemctl restart cdms-nas-worker && journalctl -u cdms-nas-worker -f'
```

**C. 롤백(재배포 후 문제 시):** 재배포 스크립트가 `~/nas_worker.py.bak.<날짜>`를 남깁니다.
```bash
ssh agent@100.104.41.9 'cp ~/nas_worker.py.bak.<날짜> ~/nas_worker.py && sudo systemctl restart cdms-nas-worker'
```

## 4. 주의 / 비밀값
- 재배포 스크립트는 **코드만** 올립니다. 비밀값은 **서버 `~/.env`에만** 둡니다.
  필요한 값: `SUPABASE_SERVICE_ROLE_KEY`, `EMAIL_API_KEY`(Resend `re_...`), NAS 계정 등.
  (출처: HANDOVER §6)
- 최초 설치(서버에 venv·서비스 없음)라면 재배포 대신 **`setup.sh`** 사용:
  ```bash
  scp -r nas-worker agent@100.104.41.9:~/   # 폴더째 올리고
  ssh agent@100.104.41.9 'cd ~/nas-worker && cp .env.example .env && nano .env && bash setup.sh'
  ```

## 5. 설정 바꿔 쓰기 (선택)
호스트/서비스명이 다르면 환경변수로 덮어쓸 수 있습니다.
```bash
SSH_HOST=agent@<다른IP> SERVICE=cdms-nas-worker bash 01_check_server_worker.sh
```
