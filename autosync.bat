@echo off
chcp 65001 >nul
REM ── CDMS 자동 동기화 (작업 스케줄러가 주기 실행) ──────────────
REM Claude가 만든 최신 cdms_sync.bundle 을 자동 적용하고 GitHub에 push → Vercel/Actions 자동배포
cd /d "%~dp0"
set "LOG=%~dp0autosync.log"
echo [%date% %time%] --- autosync 시작 >> "%LOG%"

REM 1) 원격 최신 반영
git pull origin main >> "%LOG%" 2>&1

REM 2) Claude가 만든 최신 번들 찾기(%APPDATA%\Claude 우선, 다음 다운로드)
set "BUNDLE="
for /f "delims=" %%F in ('dir /b /s /o-d "%APPDATA%\Claude\*cdms_sync.bundle" 2^>nul') do if not defined BUNDLE set "BUNDLE=%%F"
if not defined BUNDLE for /f "delims=" %%F in ('dir /b /s /o-d "%USERPROFILE%\Downloads\*cdms_sync.bundle" 2^>nul') do if not defined BUNDLE set "BUNDLE=%%F"

if defined BUNDLE (
  echo [%date% %time%] 번들 적용: %BUNDLE% >> "%LOG%"
  git pull "%BUNDLE%" main >> "%LOG%" 2>&1
) else (
  echo [%date% %time%] 번들 없음(변경 없거나 아직 미생성) >> "%LOG%"
)

REM 3) 로컬 커밋을 원격에 push (변경 없으면 조용히 통과)
git push origin main >> "%LOG%" 2>&1
echo [%date% %time%] --- autosync 끝 >> "%LOG%"
exit /b 0
