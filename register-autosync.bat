@echo off
chcp 65001 >nul
REM ── CDMS 자동동기화 작업 등록 (한 번만 더블클릭) ──────────────
REM cdms 폴더의 autosync.bat 을 5분마다 자동 실행하도록 윈도우 작업 스케줄러에 등록
set "TASKNAME=CDMS AutoSync"
set "SCRIPT=%~dp0autosync.bat"

if not exist "%SCRIPT%" (
  echo [!] autosync.bat 을 찾을 수 없습니다. 이 파일과 같은 폴더(cdms)에 autosync.bat 이 있어야 합니다.
  pause & exit /b 1
)

schtasks /Create /TN "%TASKNAME%" /TR "\"%SCRIPT%\"" /SC MINUTE /MO 5 /F
if errorlevel 1 (
  echo.
  echo [!] 등록 실패 - 이 파일을 "관리자 권한으로 실행"으로 다시 시도해 보세요.
) else (
  echo.
  echo [완료] '%TASKNAME%' 가 5분마다 자동 실행되도록 등록됐습니다.
  echo   - 동작: Claude가 만든 최신 변경을 자동으로 GitHub에 반영 → Vercel/Actions 자동배포
  echo   - 로그 확인: %~dp0autosync.log
  echo   - 지금 즉시 1회 실행: schtasks /Run /TN "%TASKNAME%"
  echo   - 해제: schtasks /Delete /TN "%TASKNAME%" /F
)
echo.
pause
