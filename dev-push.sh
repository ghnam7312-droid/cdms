#!/usr/bin/env bash
# 개발 후 한 번에 올리기:  ./dev-push.sh "커밋 메시지"
# → GitHub main push → ① Vercel 프런트 자동배포 ② GitHub Actions가 Supabase 함수 자동배포
set -e
msg="${1:-update}"
git add -A
git commit -m "$msg" || { echo "변경 없음"; exit 0; }
git push origin main
echo "✅ push 완료 — Vercel/Supabase 자동배포 진행. (저장소 Actions 탭에서 확인)"
