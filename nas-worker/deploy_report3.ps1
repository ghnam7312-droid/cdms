# CDMS 워커 최신화 (자체완결형: GitHub raw에서 파일 수신 → ssh/scp 배포 → 로그 업로드)
$ErrorActionPreference='Continue'
$U='https://kowtvvrgpzgrdlnxasxw.supabase.co/functions/v1/admin-tools'
$H=@{ 'x-admin-key'='2715a48023e02d230e29e11f1ac4a848b8d79b934ed89264' }
function Send-Log($name,$text){
  try{ Invoke-RestMethod -Method Post -Uri $U -Headers $H -ContentType 'application/json; charset=utf-8' -Body (@{action='log';name=$name;text=[string]$text}|ConvertTo-Json -Compress) | Out-Null }catch{}
}
Send-Log 'worker_deploy_log' ("started "+(Get-Date))
$L=@()
try{
  $t="$env:TEMP\cdmsw"; New-Item -ItemType Directory -Force -Path $t | Out-Null
  $raw='https://raw.githubusercontent.com/ghnam7312-droid/cdms/main/nas-worker'
  Invoke-WebRequest -Uri "$raw/nas_worker.py" -OutFile "$t\nas_worker.py" -UseBasicParsing
  Invoke-WebRequest -Uri "$raw/requirements.txt" -OutFile "$t\requirements.txt" -UseBasicParsing
  $L += "download OK: "+(Get-Item "$t\nas_worker.py").Length+" bytes"
  $sshOpt=@('-o','ConnectTimeout=10','-o','StrictHostKeyChecking=accept-new','-o','BatchMode=yes')
  $host9='agent@ai-agent'
  $L += "== backup =="
  $L += (ssh @sshOpt $host9 "cp ~/nas_worker.py ~/nas_worker.py.bak.`$(date +%Y%m%d_%H%M%S) 2>/dev/null; echo backup-done") 2>&1
  $L += "== scp =="
  $L += (scp @sshOpt "$t\nas_worker.py" "$t\requirements.txt" "${host9}:~/") 2>&1
  $L += "== pip =="
  $L += (ssh @sshOpt $host9 "~/venv/bin/pip install -q -r ~/requirements.txt && echo pip-OK") 2>&1
  $L += "== restart =="
  $L += (ssh @sshOpt $host9 "sudo systemctl restart cdms-nas-worker && sleep 2 && systemctl is-active cdms-nas-worker") 2>&1
  $L += "== verify =="
  $L += (ssh @sshOpt $host9 "grep -c 'hwp5html' ~/nas_worker.py; grep -c 'nas\\d+:' ~/nas_worker.py; md5sum ~/nas_worker.py") 2>&1
  $L += "== recent log =="
  $L += (ssh @sshOpt $host9 "journalctl -u cdms-nas-worker -n 10 --no-pager 2>/dev/null | tail -10") 2>&1
}catch{ $L += "EXCEPTION: $_" }
Send-Log 'worker_deploy_log' (($L | ForEach-Object { [string]$_ }) -join "`n")
Start-Sleep 6
