$ErrorActionPreference='Continue'
$U='https://kowtvvrgpzgrdlnxasxw.supabase.co/functions/v1/admin-tools'
$K=@{ 'x-admin-key'='2715a48023e02d230e29e11f1ac4a848b8d79b934ed89264' }
function Send-Log($n,$t){ try{ Invoke-RestMethod -Method Post -Uri $U -Headers $K -ContentType 'application/json; charset=utf-8' -Body (@{action='log';name=$n;text=[string]$t}|ConvertTo-Json -Compress)|Out-Null }catch{} }
Send-Log 'worker_probe_log' 'probe4-started'
$L=@()
# 1) ssh config Host alias 존재 여부
$cfg = "$env:USERPROFILE\.ssh\config"
if(Test-Path $cfg){ $L += "ssh config hosts: " + ((Select-String -Path $cfg -Pattern '^\s*Host\s+(.+)' -AllMatches | ForEach-Object { $_.Matches.Groups[1].Value }) -join ', ') } else { $L += "ssh config: none" }
$L += "known_hosts:"; if(Test-Path "$env:USERPROFILE\.ssh\known_hosts"){ $L += (Get-Content "$env:USERPROFILE\.ssh\known_hosts" | ForEach-Object { ($_ -split ' ')[0] }) -join ', ' }
# 2) ssh 별칭들 직접 시도
foreach($t in @('ai-agent','agent@ai-agent','worker','nas-worker')){
  $r = (ssh -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new -o BatchMode=yes $t "echo KEYOK; hostname; whoami" 2>&1)
  $L += "ssh $t => " + (($r|ForEach-Object{[string]$_}) -join ' | ')
}
# 3) LAN 스윕 (타임아웃 500ms)
$open=@()
1..254 | ForEach-Object { $ipa="192.168.0.$_"; $c=New-Object Net.Sockets.TcpClient; try{ $ar=$c.BeginConnect($ipa,22,$null,$null); if($ar.AsyncWaitHandle.WaitOne(500) -and $c.Connected){ $open+=$ipa } }catch{}; $c.Close() }
$L += "ssh22 open(500ms): " + ($open -join ', ')
Send-Log 'worker_probe_log' (($L|ForEach-Object{[string]$_}) -join "`n")
Start-Sleep 4
