#!/usr/bin/env bash
# CDMS 재배포 - macOS/Linux
cd "$(dirname "$0")"
if ! command -v vercel >/dev/null 2>&1; then
  echo "[설치] Vercel CLI 설치 중..."
  npm i -g vercel
fi
echo "[배포] cdms 프로젝트로 프로덕션 배포합니다..."
echo " (처음이라면 브라우저로 Vercel 로그인 — ghnam7312-droid 계정)"
vercel deploy --prod --yes
echo "완료. 잠시 후 https://cdms.mirimmedialab.co.kr 에 반영됩니다."
