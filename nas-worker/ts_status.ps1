$ErrorActionPreference='Continue'
$U='https://kowtvvrgpzgrdlnxasxw.supabase.co/functions/v1/admin-tools'
$K=@{ 'x-admin-key'='2715a48023e02d230e29e11f1ac4a848b8d79b934ed89264' }
function Send-Log($n,$t){ try{ Invoke-RestMethod -Method Post -Uri $U -Headers $K -ContentType 'application/json; charset=utf-8' -Body (@{action='log';name=$n;text=[string]$t}|ConvertTo-Json -Compress)|Out-Null }catch{} }
$L=@()
$ts='C:\Program Files\Tailscale\tailscale.exe'
if(-not (Test-Path $ts)){ $ts='tailscale' }
$L += "== tailscale status =="
$L += (& $ts status 2>&1 | ForEach-Object { [string]$_ })
$L += "== ping 100.104.41.9 =="
$L += (& $ts ping --c 2 100.104.41.9 2>&1 | ForEach-Object { [string]$_ })
Send-Log 'worker_probe_log' (($L|ForEach-Object{[string]$_}) -join "`n")
Start-Sleep 4
