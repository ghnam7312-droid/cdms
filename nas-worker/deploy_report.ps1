# CDMS 워커 최신화 + 결과 로그 업로드 (AI가 원격 확인용)
$ErrorActionPreference='Continue'
$log = "$env:TEMP\cdms_worker_deploy.log"
"=== deploy start $(Get-Date) ===" | Out-File $log -Encoding utf8
Set-Location "$PSScriptRoot"
$bash = 'C:\Program Files\Git\bin\bash.exe'
if (-not (Test-Path $bash)) { $bash = 'bash' }
& $bash ./02_deploy_worker.sh *>> $log
"=== deploy end $(Get-Date) exit=$LASTEXITCODE ===" | Out-File $log -Append -Encoding utf8
try {
  $text = Get-Content $log -Raw
  $body = @{ action='log'; name='worker_deploy_log'; text=$text } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri 'https://kowtvvrgpzgrdlnxasxw.supabase.co/functions/v1/admin-tools' -Headers @{ 'x-admin-key'='2715a48023e02d230e29e11f1ac4a848b8d79b934ed89264' } -ContentType 'application/json; charset=utf-8' -Body $body | Out-Null
  Write-Host '로그 업로드 완료'
} catch { Write-Host "로그 업로드 실패: $_" }
