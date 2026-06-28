#!/usr/bin/env bash
# =====================================================================
# CDMS 워커 서버 최신화 점검 (작업 A - 1단계)
# 새 PC에서 실행. 서버(ai-agent)의 nas_worker.py가 패키지 최신본과
# 같은지 md5 + 기능 시그니처로 대조하고, 서비스 상태/로그를 보여줍니다.
#
# 사용:  bash 01_check_server_worker.sh
#   (이 스크립트를 nas-worker/ 폴더 안에 두고 실행하세요.
#    nas_worker.py 와 같은 폴더에 있어야 합니다.)
# 사전조건: Tailscale 연결됨, ssh 사용 가능, agent 계정 접속 가능
# =====================================================================
set -u

# ---- 설정 (필요시 수정) ----
SSH_HOST="${SSH_HOST:-agent@100.104.41.9}"
REMOTE_PY="${REMOTE_PY:-~/nas_worker.py}"
SERVICE="${SERVICE:-cdms-nas-worker}"
SSH_OPTS="${SSH_OPTS:--o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new}"

# 스크립트 위치 기준으로 로컬 기준본 찾기
HERE="$(cd "$(dirname "$0")" && pwd)"
LOCAL_PY="$HERE/nas_worker.py"

# 기준본 기대 md5 (이 패키지의 nas_worker.py)
EXPECT_MD5="2d11b9505bab52e861b5e39cc69ce0d6"

# 반드시 서버에 있어야 할 4개 최신 기능 시그니처 (grep 패턴)
FEAT_NAME=( "계약만료 알림" "검수영상 프록시" "시놀로지 직접서빙 모드" "강의계획서 파싱" )
FEAT_PAT=( "def check_contract_reminders" "def action_make_review_proxy" "NAS_PUBLIC_BASE" "def action_parse_syllabus" )

c_g="\033[32m"; c_r="\033[31m"; c_y="\033[33m"; c_0="\033[0m"
pass(){ echo -e "  ${c_g}PASS${c_0}  $1"; }
fail(){ echo -e "  ${c_r}FAIL${c_0}  $1"; }
warn(){ echo -e "  ${c_y}WARN${c_0}  $1"; }

echo "=================================================="
echo " CDMS 워커 서버 점검  →  $SSH_HOST"
echo "=================================================="

# 0) 로컬 기준본 확인
if [ ! -f "$LOCAL_PY" ]; then
  echo -e "${c_r}로컬 nas_worker.py 를 찾을 수 없습니다: $LOCAL_PY${c_0}"
  echo "이 스크립트를 nas-worker/ 폴더 안에서 실행하세요."; exit 1
fi
if command -v md5sum >/dev/null 2>&1; then LOCAL_MD5=$(md5sum "$LOCAL_PY" | awk '{print $1}')
else LOCAL_MD5=$(md5 -q "$LOCAL_PY"); fi
echo ""
echo "[0] 로컬 기준본"
echo "    파일 : $LOCAL_PY"
echo "    md5  : $LOCAL_MD5"
[ "$LOCAL_MD5" = "$EXPECT_MD5" ] && pass "패키지 원본과 일치" || warn "패키지 원본 md5와 다름(로컬을 수정했다면 정상)"

# 1) SSH 연결 + 원격 md5
echo ""
echo "[1] 서버 연결 / 원격 파일 md5"
REMOTE_MD5=$(ssh $SSH_OPTS "$SSH_HOST" "md5sum $REMOTE_PY 2>/dev/null | awk '{print \$1}'" 2>/dev/null)
if [ -z "$REMOTE_MD5" ]; then
  fail "서버 접속 실패 또는 $REMOTE_PY 없음 (Tailscale/SSH 확인)"
  echo "    수동 확인: ssh $SSH_HOST 'ls -l $REMOTE_PY'"
  exit 2
fi
echo "    원격 md5 : $REMOTE_MD5"
if [ "$REMOTE_MD5" = "$LOCAL_MD5" ]; then
  pass "서버 파일이 로컬 기준본과 동일 → 코드 최신"
  SAME=1
else
  fail "서버 파일이 로컬과 다름 → 재배포 필요 (02_deploy_worker.sh)"
  SAME=0
fi

# 2) 기능별 시그니처 (md5가 달라도 어떤 기능이 빠졌는지 파악)
echo ""
echo "[2] 서버 파일 기능 시그니처 (4개 최신 기능)"
MISSING=0
for i in "${!FEAT_PAT[@]}"; do
  cnt=$(ssh $SSH_OPTS "$SSH_HOST" "grep -c -- \"${FEAT_PAT[$i]}\" $REMOTE_PY 2>/dev/null" 2>/dev/null)
  cnt=${cnt:-0}
  if [ "$cnt" -ge 1 ] 2>/dev/null; then pass "${FEAT_NAME[$i]}  (matches=$cnt)"
  else fail "${FEAT_NAME[$i]}  → 서버에 없음"; MISSING=$((MISSING+1)); fi
done

# 3) systemd 상태
echo ""
echo "[3] 서비스 상태 ($SERVICE)"
ssh $SSH_OPTS "$SSH_HOST" "systemctl is-active $SERVICE 2>/dev/null" | sed 's/^/    is-active: /'
ssh $SSH_OPTS "$SSH_HOST" "systemctl is-enabled $SERVICE 2>/dev/null" | sed 's/^/    is-enabled: /'

# 4) 최근 로그 15줄
echo ""
echo "[4] 최근 로그 (15줄)"
ssh $SSH_OPTS "$SSH_HOST" "journalctl -u $SERVICE -n 15 --no-pager 2>/dev/null" | sed 's/^/    /'

# 5) 결론
echo ""
echo "=================================================="
if [ "${SAME:-0}" = "1" ] && [ "$MISSING" -eq 0 ]; then
  echo -e " 결론: ${c_g}서버 최신 — 재배포 불필요${c_0}"
  echo " (env 변경/재시작만 필요하면 ssh 로 직접 restart)"
else
  echo -e " 결론: ${c_r}재배포 필요${c_0}  →  bash 02_deploy_worker.sh"
fi
echo "=================================================="
