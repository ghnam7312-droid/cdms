-- 하이웍스 메신저 알림 수신용: 사용자별 하이웍스 로그인ID
-- 회사메일(@mirimmedialab.co.kr) 사용자는 메일 로컬파트로 자동 백필.
-- gmail 등 외부메일 어드민(예: 남기환)은 수동으로 hiworks_id 설정 필요.
alter table users add column if not exists hiworks_id text;

update users set hiworks_id = split_part(email,'@',1)
 where hiworks_id is null and email ilike '%@mirimmedialab.co.kr';

-- 남기환 하이웍스ID 수동 설정 예시(실제 로그인ID로 교체):
-- update users set hiworks_id = '<남기환_하이웍스ID>' where email = 'ghnam7312@gmail.com';
