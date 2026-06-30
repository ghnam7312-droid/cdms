-- 사업완료(완납) 플래그: 매출시트 미수금=0(빈칸)이고 실계약(금액>0·계약종료일 존재)일 때 sales-sync가 true 설정
alter table programs add column if not exists settled boolean not null default false;
