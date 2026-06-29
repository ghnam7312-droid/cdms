#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CDMS 매출 동기화 (서버 워커 cron 용)
 - '2026년도 매출 현황' 구글시트의 '2026년' 탭을 '웹에 게시(CSV)' 링크로 읽어
 - 고객명·계약금액·계약기간·PM명을 CDMS programs 에 동기화한다(번호=seq 매칭).
 - 없는 번호는 신규 생성. 사업명·과목·차시·진행률은 건드리지 않는다.
의존성: 표준 라이브러리만. cron 예: 매일 06:30
환경변수(.env):
  SALES_CSV_URL              구글시트 '2026년' 탭 '웹에 게시' CSV 링크
  SUPABASE_URL               https://kowtvvrgpzgrdlnxasxw.supabase.co
  SUPABASE_SERVICE_ROLE_KEY  service_role 키
  SALES_CREATED_BY           (선택) 신규 사업 created_by uuid(기본=어드민)
"""
import os, sys, csv, io, re, json, urllib.request, urllib.parse

def load_env():
    here=os.path.dirname(os.path.abspath(__file__))
    for p in (os.path.join(here,".env"), os.path.join(os.getcwd(),".env")):
        if os.path.exists(p):
            for line in open(p,encoding="utf-8"):
                line=line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k,v=line.split("=",1); os.environ.setdefault(k.strip(),v.strip())
load_env()
CSV_URL=os.environ.get("SALES_CSV_URL","")
SB=os.environ.get("SUPABASE_URL","").rstrip("/")
KEY=os.environ.get("SUPABASE_SERVICE_ROLE_KEY","")
ADMIN=os.environ.get("SALES_CREATED_BY","51610d59-8b8a-4497-aabe-0fcc997baf28")
TITLES=("책임","선임","팀장","파트장","파트","실장","대리","사원","수석","연구원","매니저")

def die(m): print("X "+m); sys.exit(1)
def http(method,url,body=None):
    data=json.dumps(body).encode() if body is not None else None
    h={"apikey":KEY,"Authorization":"Bearer "+KEY,"Content-Type":"application/json"}
    req=urllib.request.Request(url,data=data,headers=h,method=method)
    with urllib.request.urlopen(req,timeout=30) as r:
        t=r.read().decode("utf-8"); return r.status,(json.loads(t) if t.strip() else None)

def clean_amount(s):
    d=re.sub(r"[^0-9]","",s or "")
    return int(d) if d else None
def parse_period(s):
    s=(s or "").strip()
    m=re.findall(r"(\d{4})\.(\d{1,2})\.(\d{1,2})",s)
    def fmt(t): return f"{int(t[0]):04d}-{int(t[1]):02d}-{int(t[2]):02d}"
    if "~" in s:
        a,b=s.split("~",1)
        st=re.findall(r"(\d{4})\.(\d{1,2})\.(\d{1,2})",a)
        en=re.findall(r"(\d{4})\.(\d{1,2})\.(\d{1,2})",b)
        return (fmt(st[0]) if st else None, fmt(en[0]) if en else None)
    return (None,None)
def pm_name(s):
    s=(s or "").strip()
    if not s: return None
    parts=s.split()
    if len(parts)>=2 and parts[-1] in TITLES: return " ".join(parts[:-1])
    return parts[0] if parts else None

def main():
    if not CSV_URL: die("SALES_CSV_URL 미설정 (시트 '웹에 게시' CSV 링크)")
    if not (SB and KEY): die("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정")
    raw=urllib.request.urlopen(CSV_URL,timeout=30).read().decode("utf-8")
    rows=list(csv.reader(io.StringIO(raw)))
    # 헤더 행 찾기
    hidx=None
    for i,r in enumerate(rows):
        if any("계약자" in c for c in r) and any("계약명" in c for c in r): hidx=i; break
    if hidx is None: die("헤더(계약자/계약명) 행을 못 찾음")
    hdr=[c.strip() for c in rows[hidx]]
    def col(name):
        for j,c in enumerate(hdr):
            if name in c: return j
        return -1
    ci={k:col(k) for k in ("번호","계약자","계약명","계약금액","계약기간","PM")}
    # 'PM'은 '담당 PM'
    if ci["PM"]==-1: ci["PM"]=col("담당")
    # 기존 사업/사용자 로드
    _,progs=http("GET",f"{SB}/rest/v1/programs?select=id,seq&year=eq.2026")
    seqmap={p["seq"]:p["id"] for p in (progs or []) if p.get("seq") is not None}
    _,users=http("GET",f"{SB}/rest/v1/users?select=id,name")
    umap={(u.get("name") or "").strip():u["id"] for u in (users or [])}
    upd=ins=0; nopm=set()
    for r in rows[hidx+1:]:
        if ci["번호"]>=len(r): continue
        sv=(r[ci["번호"]] or "").strip()
        if not re.fullmatch(r"\d{1,3}",sv): continue
        seq=int(sv)
        client=(r[ci["계약자"]].strip() if ci["계약자"]<len(r) else "")
        cname =(r[ci["계약명"]].strip() if ci["계약명"]<len(r) else "")
        amount=clean_amount(r[ci["계약금액"]] if ci["계약금액"]<len(r) else "")
        cs,ce =parse_period(r[ci["계약기간"]] if ci["계약기간"]<len(r) else "")
        pmn   =pm_name(r[ci["PM"]] if ci["PM"]>=0 and ci["PM"]<len(r) else "")
        pmid  =umap.get(pmn) if pmn else None
        if pmn and not pmid: nopm.add(pmn)
        patch={"client":client,"amount":amount,"contract_start":cs,"contract_end":ce}
        if pmid: patch["pm_id"]=pmid
        if seq in seqmap:
            st,_=http("PATCH",f"{SB}/rest/v1/programs?id=eq.{seqmap[seq]}",patch)
            if st in (200,204): upd+=1
        else:
            row={"seq":seq,"year":2026,"name":cname or client,"org_type":"대학",
                 "approval_status":"미등록","created_by":ADMIN,**patch}
            st,_=http("POST",f"{SB}/rest/v1/programs",row)
            if st in (200,201,204): ins+=1; seqmap[seq]=True
    print(f"매출 동기화 완료: 갱신 {upd} · 신규 {ins}" + (f" · PM매칭실패 {sorted(nopm)}" if nopm else ""))

if __name__=="__main__":
    main()
