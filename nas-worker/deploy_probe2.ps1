$ErrorActionPreference='Continue'
$U='https://kowtvvrgpzgrdlnxasxw.supabase.co/functions/v1/admin-tools'
$K=@{ 'x-admin-key'='2715a48023e02d230e29e11f1ac4a848b8d79b934ed89264' }
function Send-Log($name,$text){
  try{ Invoke-RestMethod -Method Post -Uri $U -Headers $K -ContentType 'application/json; charset=utf-8' -Body (@{action='log';name=$name;text=[string]$text}|ConvertTo-Json -Compress) | Out-Null }catch{}
}
Send-Log 'worker_probe_log' ("probe-started "+(Get-Date))
$L=@()
try{
  $L += "tailscale: " + [bool](Get-Command tailscale -ErrorAction SilentlyContinue)
  try{ $svc = Get-Service -Name 'Tailscale' -ErrorAction SilentlyContinue; $L += "tailscale svc: $($svc.Status)" }catch{ $L += "svc err" }
  foreach($hn in @('100.104.41.9','ai-agent')){
    try{
      $ok = (New-Object Net.Sockets.TcpClient)
      $ar = $ok.BeginConnect($hn,22,$null,$null)
      $done = $ar.AsyncWaitHandle.WaitOne(4000)
      $L += "$hn ssh22: " + $done
      $ok.Close()
    }catch{ $L += "$hn err: $($_.Exception.Message)" }
  }
  $L += "--- ipv4 ---"
  $L += (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress }) -join ", "
}catch{ $L += "EXCEPTION: $_" }
Send-Log 'worker_probe_log' (($L | ForEach-Object { [string]$_ }) -join "`n")
Start-Sleep 4
