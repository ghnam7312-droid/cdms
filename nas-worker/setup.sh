#!/usr/bin/env bash
# CDMS NAS Worker 턴키 설치 (Ubuntu/Debian 서버)
# 사용법:  bash setup.sh        ← 한 번 실행하면 .env 생성 후 멈춤 → .env 채우고 다시 실행
set -e
cd "$(dirname "$0")"
DIR="$(pwd)"

echo "[1/5] ffmpeg(ffprobe) 설치 확인"
if ! command -v ffprobe >/dev/null 2>&1; then
  sudo apt-get update -y && sudo apt-get install -y ffmpeg
fi

echo "[2/5] 파이썬 가상환경 + 패키지"
python3 -m venv venv
./venv/bin/pip install -q -U pip
./venv/bin/pip install -q -r requirements.txt

echo "[3/5] .env 확인"
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "  >> .env 파일을 만들었습니다. 아래 값을 채운 뒤 'bash setup.sh' 를 다시 실행하세요:"
  echo "     - SUPABASE_SERVICE_ROLE_KEY (Supabase > Settings > API > service_role)"
  echo "     - NAS_MODE / NAS_BASE (마운트 경로) 또는 SMB 값"
  echo "     - EMAIL_API_KEY / EMAIL_FROM (Resend)"
  echo "  파일 위치: $DIR/.env"
  exit 0
fi

echo "[4/5] 연결 자가진단 (Supabase + NAS + ffprobe + 이메일키)"
set -a; . ./.env; set +a
./venv/bin/python3 nas_worker.py selfcheck || {
  echo "  자가진단 실패 — 위 메시지를 확인하고 .env 를 수정하세요."; exit 1; }

echo "[5/5] systemd 서비스 등록 + 시작"
sudo tee /etc/systemd/system/cdms-nas-worker.service >/dev/null <<UNIT
[Unit]
Description=CDMS NAS Worker
After=network-online.target

[Service]
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
ExecStart=$DIR/venv/bin/python3 $DIR/nas_worker.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now cdms-nas-worker

echo ""
echo "완료! 워커가 상시 구동됩니다."
echo "  로그 보기:   journalctl -u cdms-nas-worker -f"
echo "  상태:       systemctl status cdms-nas-worker"
echo "  1회 수동스캔: ./venv/bin/python3 nas_worker.py scan-once <project_id>"
