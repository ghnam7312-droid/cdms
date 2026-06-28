# CDMS NAS Worker

CDMS의 **제작단계 진행상태**와 **영상 길이**를 NAS에서 자동으로 채우는 서버 워커입니다.
브라우저(index.html)는 NAS 파일을 직접 읽을 수 없으므로, 사내 서버에서 이 워커가 NAS를 스캔해
Supabase에 기록하고 → CDMS 화면에 반영됩니다.

```
[CDMS 화면] --(nas_tasks 큐에 작업 등록)--> [Supabase] <--(폴링/기록)-- [이 워커] --(스캔/ffprobe)--> [NAS]
```

## 무엇을 하나

- **진행 자동표기**: 각 단계 폴더(`01_원고`, `02_촬영용`, `07_종편` …)에 해당 차시 파일이 있으면
  그 단계를 **완료(done)** 로, 셀에 **파일 수정일**과 **파일명**을 기록합니다. 파일이 사라지면 자동 해제합니다.
- **영상 길이 자동입력**: `07_종편` 폴더의 영상 파일을 **ffprobe**로 분석해 `lessons.duration_sec`에 기록합니다.
  (주차 총길이는 화면에서 자동 합산)
- **폴더 생성/이름변경**: CDMS에서 요청한 NAS 폴더 생성·이름변경 작업을 처리합니다.

## 파일명 규칙 (중요)

파일명에 **`N차시`** 가 들어 있어야 차시에 자동 연결됩니다.
- 예) `3차시_인간행동의 심리적 구조.mp4`, `03차시.mp4`, `7주차_2차시.mp4`
- 주차형(학점) 과정은 `7주차_2차시…`처럼 **주차+차시**가 함께 있으면 더 정확합니다.
- 규칙이 다르면 `nas_worker.py`의 `RE_LESSON` 정규식만 바꾸면 됩니다.

## 설치

```bash
# 1) ffmpeg(ffprobe) 설치
sudo apt-get update && sudo apt-get install -y ffmpeg     # Ubuntu/Debian

# 2) 파이썬 패키지
cd nas-worker
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# 3) 환경설정
cp .env.example .env
#   .env 를 열어 SUPABASE_SERVICE_ROLE_KEY, NAS_MODE, NAS_BASE(또는 SMB값) 입력
```

### SERVICE ROLE 키
Supabase 대시보드 → Project Settings → API → **service_role** 키를 복사해 `.env`에 넣습니다.
이 키는 RLS를 우회하므로 **서버에만** 두고, 절대 `index.html`·깃에 올리지 마세요.

## 실행

```bash
# 환경변수 로드 후 상시 실행 (큐 처리 + 주기 자동스캔)
set -a; source .env; set +a
python3 nas_worker.py

# 한 과정만 즉시 1회 스캔(테스트)
python3 nas_worker.py scan-once <project_id>
# 전체 1회 스캔
python3 nas_worker.py scan-once
```

### systemd 서비스 (상시 구동 권장)
`/etc/systemd/system/cdms-nas-worker.service`:
```ini
[Unit]
Description=CDMS NAS Worker
After=network-online.target

[Service]
WorkingDirectory=/opt/cdms/nas-worker
EnvironmentFile=/opt/cdms/nas-worker/.env
ExecStart=/opt/cdms/nas-worker/venv/bin/python3 nas_worker.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now cdms-nas-worker
journalctl -u cdms-nas-worker -f      # 로그 확인
```

### Docker (대안)
```dockerfile
FROM python:3.11-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt . && RUN pip install -r requirements.txt
COPY nas_worker.py .
CMD ["python3","nas_worker.py"]
```
`docker run --env-file .env -v /mnt/nas:/mnt/nas cdms-nas-worker`

## 동작 흐름

1. 과정에서 **📁 NAS 폴더** 생성(`mkdir_tree`) → `projects.nas_root` 저장.
2. 담당자가 NAS의 각 단계 폴더에 `N차시…` 파일 업로드.
3. 워커가 10분마다(또는 화면의 **🔄 NAS 동기화** 클릭 시 즉시) 스캔 →
   - 단계 완료/수정일/파일명 기록, `07_종편` 영상 길이 기록.
4. CDMS 진행표가 자동 갱신.

## 보안 / 주의

- `.env`(특히 service_role 키, NAS 비밀번호)는 비공개로 관리하세요.
- SMB 모드는 `NAS_MODE=smb` + SMB 값 설정 후 `pip install smbprotocol` 필요.
- `scan_progress`는 **자동표기 셀만** 되돌립니다. 사람이 수동으로 바꾼 셀(파일명 없는 done 등)은 건드리지 않습니다.
- 폴더명 변경(`rename_folder`)·NAS→CDMS 가져오기(`sync_names`)는 화면의 **🗂 NAS 폴더명** 버튼에 연결됨.
  폴더명 변경은 상위 위치를 유지하고 마지막 폴더명만 바꾸며, 경로탈출(`../`)은 자동 차단됩니다.

## 자동 이메일 (단계 완료 → 다음 담당자)

스캔 중 한 단계가 **wait→done** 으로 새로 바뀌면, 그 차시의 **다음 사용단계 담당자**에게
Resend(또는 SendGrid)로 즉시 메일을 보냅니다.

- 담당자는 CDMS 화면의 **👤 단계 담당자** 에서 과정별·단계별로 지정합니다(`stage_assignees`).
- 다음 단계는 참조시트 순서(원고→촬영→가편→스크립트→스토리보드→디자인→종편→srt→번역→학습자료)에서
  **사용 중인 단계 기준** 바로 다음입니다(꺼진 단계는 건너뜀).
- 중복 발송은 `email_notifications` 로 방지합니다(차시·완료단계 1회). 마지막 단계는 다음이 없어 발송하지 않습니다.
- 담당자가 미지정이면 발송하지 않고 로그에 `no_assignee` 로 남깁니다 → 담당자를 먼저 지정해 두세요.

`.env` 설정:
```
EMAIL_ENABLED=true
EMAIL_PROVIDER=resend            # 또는 sendgrid
EMAIL_API_KEY=re_xxx             # Resend: re_…  / SendGrid: SG.…
EMAIL_FROM=CDMS <noreply@도메인>  # 발신도메인 인증 권장
CDMS_URL=https://cdms.mirimmedialab.co.kr
```
> Resend는 발신 도메인 인증(DNS) 후 사용해야 도달률이 정상입니다. 키는 service_role 키와 함께 **서버에만** 보관하세요.
