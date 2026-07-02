@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================
echo   CDMS 배포 (add + commit + push)
echo ============================
set /p msg=커밋 메시지 입력(엔터=update): 
if "%msg%"=="" set msg=update
git add -A
git commit -m "%msg%"
git pull --rebase origin main
git push origin main
echo.
echo 완료 — Vercel/Supabase 자동배포 진행. (저장소 Actions 탭에서 확인)
echo 화면이 안 바뀌면 브라우저에서 Ctrl+F5.
pause
