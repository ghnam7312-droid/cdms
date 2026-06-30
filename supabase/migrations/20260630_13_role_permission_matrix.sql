-- 역할별 권한 배분(범위·NAS 보기/읽기/쓰기) 매트릭스 적용
-- 보기: 전체 / 읽기: 사업담당자 제외 전체 / 쓰기: 담당 폴더 보유 역할
update roles set nas_view=true;
update roles set nas_read=true;
update roles set nas_read=false where code='biz';
update roles set nas_write=false;
update roles set nas_write=true where code in
 ('admin','pm','planner','reviewer','designer','video','steno','trans','dev','vendor','ext_planner','ext_designer','ext_video','ext_steno');
-- 편집(담당 단계 st)·범위/NAS 설명 텍스트는 프런트 ROLES 상수(index.html)에 반영.
