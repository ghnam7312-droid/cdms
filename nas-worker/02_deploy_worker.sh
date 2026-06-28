#!/usr/bin/env bash
# =====================================================================
# CDMS 워커 재배포 (작업 A - 2단계)
# 최신 nas_worker.py + requirements.txt 를 서버에 올리고, 의존성 설치,
# 서비스 재시작, selfcheck 까지 수행합니다.
#
# 사용:  bash 02_deploy_worker.sh
#   (nas-worker/ 폴더 안에서 실행. nas_worker.py / requirements.txt 와 같은 폴더)
# 사전조건: Tailscale 연결됨, ssh/scp 가능, 서버에 ~/.env 이미 존재(비밀값 채워둔 상태)
#           최초 설치라면 setup.sh 를 먼저 쓰세요(README 참고).
# =====================================================================
set -euo pipefail

SSH_HOST="${SSH_HOST:-agent@100.104.41.9}"
SERVICE="${SERVICE:-cdms-nas-worker}"
REMOTE_HOME="${REMOTE_HOME:-~}"
VENV="${VENV:-~/venv}"
SSH_OPTS="${SSH_OPTS:--o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new}"

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

for f in nas_worker.py requirements.txt; do
  [ -f "$f" ] || { echo "필수 파일 없음: $HERE/$f (nas-worker 폴더에서 실행하세요)"; exit 1; }
done

echo "== [1/5] 백업 (서버의 현재 nas_worker.py) =="
ssh $SSH_OPTS "$SSH_HOST" "[ -f ~/nas_worker.py ] && cp ~/nas_worker.py ~/nas_worker.py.bak.\$(date +%Y%m%d_%H%M%S) && echo '  백업됨' || echo '  기존 파일 없음(신규)'"

echo "== [2/5] 전송 (scp) =="
scp $SSH_OPTS nas_worker.py requirements.txt "$SSH_HOST:$REMOTE_HOME/"
echo "  완료"

echo "== [3/5] 의존성 설치 (파싱 라이브러리 등) =="
ssh $SSH_OPTS "$SSH_HOST" "$VENV/bin/pip install -q -r ~/requirements.txt && echo '  pip OK'"

echo "== [4/5] 서비스 재시작 =="
ssh $SSH_OPTS "$SSH_HOST" "sudo systemctl restart $SERVICE && sleep 2 && systemctl is-active $SERVICE" | sed 's/^/  /'

echo "== [5/5] 자가진단 (selfcheck) =="
# 서비스가 파일을 잡고 있으므로 일회성 selfcheck 는 별도 프로세스로 실행
ssh $SSH_OPTS "$SSH_HOST" "cd ~ && $VENV/bin/python3 nas_worker.py selfcheck" | sed 's/^/  /' || echo "  (selfcheck 비정상 — 아래 로그 확인)"

echo ""
echo "== 최근 로그 20줄 =="
ssh $SSH_OPTS "$SSH_HOST" "journalctl -u $SERVICE -n 20 --no-pager" | sed 's/^/  /'

echo ""
echo "재배포 완료. 문제 시 롤백:"
echo "  ssh $SSH_HOST 'cp ~/nas_worker.py.bak.<날짜> ~/nas_worker.py && sudo systemctl restart $SERVICE'"
