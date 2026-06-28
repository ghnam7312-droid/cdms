@echo off
chcp 65001 >nul
REM CDMS 재배포 - Windows
cd /d "%~dp0"

where vercel >nul 2>nul
if errorlevel 1 (
  echo [설치] Vercel CLI 설치 중...
  call npm i -g vercel
)

echo.
echo [배포] cdms 프로젝트로 프로덕션 배포합니다...
echo  (처음이라면 브라우저가 열려 Vercel 로그인을 요청합니다. ghnam7312-droid 계정으로 로그인)
echo.
vercel deploy --prod --yes

echo.
echo 완료. 잠시 후 https://cdms.mirimmedialab.co.kr 에 반영됩니다.
pause
