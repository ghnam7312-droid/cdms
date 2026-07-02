# 서버 접근 경로 진단 (Tailscale/LAN)
$ErrorActionPreference='Continue'
$U='https://kowtvvrgpzgrdlnxasxw.supabase.co/functions/v1/admin-tools'
$H=@{ 'x-admin-key'='2715a48023e02d230e29e11f1ac4a848b8d79b934ed89264' }
$L=@()
$L += "tailscale cmd: " + [bool](Get-Command tailscale -ErrorAction SilentlyContinue)
$L += "tailscale svc: " + ((Get-Service Tailscale -ErrorAction SilentlyContinue).Status)
foreach($h in @('ai-agent','ai-agent.local','100.104.41.9')){
  try{ $r=Test-NetConnection -ComputerName $h -Port 22 -WarningAction SilentlyContinue
       $L += "$h : ping=$($r.PingSucceeded) ssh22=$($r.TcpTestSucceeded) ip=$($r.RemoteAddress)" }
  catch{ $L += "$h : ERR $_" }
}
$L += "--- arp 100.x ---"
$L += (arp -a | Select-String '100\.104') 2>&1
$L += "--- ipconfig ---"
$L += (ipconfig | Select-String 'IPv4') 2>&1
try{ Invoke-RestMethod -Method Post -Uri $U -Headers $H -ContentType 'application/json; charset=utf-8' -Body (@{action='log';name='worker_probe_log';text=(($L|ForEach-Object{[string]$_}) -join "`n")}|ConvertTo-Json -Compress)|Out-Null }catch{}
Start-Sleep 4
