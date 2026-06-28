#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CDMS ↔ 하이웍스(Hiworks) 연동
  1) 직원정보(조직도) → CDMS users 이메일 동기화 (이름 매칭)
  2) 전자결재(지출결의/회계) 조회 → 사업 매칭 프리뷰

인증: 하이웍스 Office Token (오피스 관리 > 오피스 API 에서 발급)
의존성: 표준 라이브러리(urllib)만 사용. 별도 설치 불필요.

사용:
  python3 hiworks_sync.py selfcheck
  python3 hiworks_sync.py org                 # 변경 미리보기(dry-run)
  python3 hiworks_sync.py org --apply         # 실제 이메일 반영
  python3 hiworks_sync.py org --apply --insert  # CDMS에 없는 직원은 신규 추가
  python3 hiworks_sync.py org --apply --force   # 임시값이 아니어도 덮어쓰기
  python3 hiworks_sync.py spending --month 202606 [--status C]

환경변수(.env 또는 OS 환경):
  HIWORKS_OFFICE_TOKEN   필수. 하이웍스 office token.
                         오피스(지점)가 여러 개면 콤마로 나열, 라벨도 지정 가능:
                           HIWORKS_OFFICE_TOKEN=상암=0763...,강서401호=d76e...,대구=ad7a...
                         (라벨 생략하고 토큰만 콤마로 나열해도 됨)
  HIWORKS_MAIL_DOMAIN    조직도 email이 비었을 때 mail_id@도메인 으로 보정 (예: mirimmedialab.co.kr)
  HIWORKS_API_BASE       기본 https://api.hiworks.com
  SUPABASE_URL           예) https://kowtvvrgpzgrdlnxasxw.supabase.co
  SUPABASE_SERVICE_ROLE_KEY  서버 전용 service_role 키
"""
import os, sys, json, argparse, re, urllib.request, urllib.error, urllib.parse

# ---------- .env 로더 (간단) ----------
def load_env():
    here = os.path.dirname(os.path.abspath(__file__))
    for path in (os.path.join(here, ".env"), os.path.join(os.getcwd(), ".env")):
        if os.path.exists(path):
            for line in open(path, encoding="utf-8"):
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
load_env()

API_BASE   = os.environ.get("HIWORKS_API_BASE", "https://api.hiworks.com").rstrip("/")
MAIL_DOMAIN= os.environ.get("HIWORKS_MAIL_DOMAIN", "")

def parse_tokens():
    """HIWORKS_OFFICE_TOKEN 을 [(label, token), ...] 로 파싱. 콤마 구분, 'label=token' 선택."""
    raw = os.environ.get("HIWORKS_OFFICE_TOKEN", "")
    out = []
    for i, part in enumerate([p.strip() for p in raw.split(",") if p.strip()]):
        if "=" in part:
            label, tok = part.split("=", 1)
            out.append((label.strip(), tok.strip()))
        else:
            out.append(("office%d" % (i + 1), part))
    return out

TOKENS = parse_tokens()
SB_URL     = os.environ.get("SUPABASE_URL", "").rstrip("/")
SB_KEY     = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

def die(msg, code=1):
    print("✗ " + msg); sys.exit(code)

# ---------- HTTP ----------
def http(method, url, headers=None, body=None):
    data = None
    h = {"Content-Type": "application/json"}
    if headers: h.update(headers)
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8")
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "ignore")
        try: parsed = json.loads(raw)
        except Exception: parsed = raw
        return e.code, parsed

def hw_get(path, params=None, token=None):
    if not token: die("office token 없음 (HIWORKS_OFFICE_TOKEN 확인)")
    url = API_BASE + path
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "")})
    return http("GET", url, {"Authorization": "Bearer " + token})

def fetch_all_employees():
    """모든 오피스 토큰의 조직도를 합쳐 직원 목록(이름 기준 dedupe) 반환."""
    merged = {}
    for label, tok in TOKENS:
        st, body = hw_get("/hrm/v2/organizations", token=tok)
        if st != 200 or not isinstance(body, dict):
            print("  ! [%s] 조직도 조회 실패 %s: %s" % (label, st, str(body)[:160]))
            continue
        emps = flatten_org(body)
        for e in emps:
            e["office"] = label
            if e["name"] and e["name"] not in merged:
                merged[e["name"]] = e
        print("  · [%s] 직원 %d명" % (label, len(emps)))
    return merged

def sb(method, path, params=None, body=None, prefer=None):
    if not (SB_URL and SB_KEY): die("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정")
    url = SB_URL + "/rest/v1/" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    h = {"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY}
    if prefer: h["Prefer"] = prefer
    return http(method, url, h, body)

# ---------- 조직도 평탄화 ----------
def flatten_org(node, dept=""):
    """organizations 응답(중첩 node)을 직원 리스트로 평탄화."""
    out = []
    name = node.get("name", "")
    cur_dept = name if not dept else dept + " > " + name
    for e in (node.get("entries") or []):
        out.append({
            "name": (e.get("name") or "").strip(),
            "mail_id": (e.get("mail_id") or "").strip(),
            "email": (e.get("email") or "").strip(),
            "phone": (e.get("phone") or "").strip(),
            "cell": (e.get("cell") or "").strip(),
            "dept": cur_dept,
            "user_no": str(e.get("user_no") or ""),
            "is_admin": e.get("is_admin", "N"),
        })
    for child in (node.get("nodes") or []):
        out.extend(flatten_org(child, cur_dept))
    return out

def resolve_email(emp):
    if emp["email"]:
        return emp["email"]
    if emp["mail_id"] and MAIL_DOMAIN:
        return emp["mail_id"] + "@" + MAIL_DOMAIN
    return ""

# ---------- selfcheck ----------
def cmd_selfcheck(args):
    print("== CDMS ↔ 하이웍스 자가진단 ==")
    ok = True
    print("API_BASE       :", API_BASE)
    print("OFFICE_TOKEN   :", ("%d개: %s" % (len(TOKENS), ", ".join(l for l, _ in TOKENS))) if TOKENS else "✗ 없음")
    ok &= bool(TOKENS)
    print("MAIL_DOMAIN    :", MAIL_DOMAIN or "(미설정 — email 비면 보정 불가)")
    print("SUPABASE       :", "설정됨" if (SB_URL and SB_KEY) else "✗ 없음"); ok &= bool(SB_URL and SB_KEY)
    print("-" * 40)
    for label, tok in TOKENS:
        st, body = hw_get("/hrm/v2/organizations", token=tok)
        if st == 200 and isinstance(body, dict):
            emps = flatten_org(body)
            with_mail = sum(1 for e in emps if resolve_email(e))
            print("[하이웍스:%s] 조직도 OK — 직원 %d명, 이메일확보 %d" % (label, len(emps), with_mail))
        else:
            print("[하이웍스:%s] 조직도 실패 %s: %s" % (label, st, str(body)[:200])); ok = False
    st3, body3 = sb("GET", "users", {"select": "id,name,email", "limit": "1"})
    print("[Supabase] users 접근 :", st3, "OK" if st3 == 200 else str(body3)[:200])
    ok &= (st3 == 200)
    print("-" * 40)
    print("결과:", "PASS ✅" if ok else "FAIL ❌")
    sys.exit(0 if ok else 1)

# ---------- 직원정보(조직도) 동기화 ----------
PLACEHOLDER_SUFFIX = "@mirim.local"

def cmd_org(args):
    print("오피스 토큰 %d개에서 조직도 수집:" % len(TOKENS))
    emp_by_name = fetch_all_employees()
    if not emp_by_name:
        die("조직도를 가져오지 못했습니다. 토큰/네트워크 확인.")

    st, users = sb("GET", "users", {"select": "id,name,email"})
    if st != 200 or not isinstance(users, list):
        die("CDMS users 조회 실패 (%s): %s" % (st, str(users)[:300]))
    users_by_name = {}
    for u in users:
        users_by_name.setdefault((u.get("name") or "").strip(), u)

    updates, inserts, skips = [], [], []
    for name, emp in emp_by_name.items():
        new_email = resolve_email(emp)
        if not new_email:
            skips.append((name, "하이웍스 이메일 없음(MAIL_DOMAIN 설정 필요)")); continue
        u = users_by_name.get(name)
        if u:
            cur = (u.get("email") or "").strip()
            is_placeholder = (not cur) or cur.endswith(PLACEHOLDER_SUFFIX)
            if cur.lower() == new_email.lower():
                skips.append((name, "이미 동일")); continue
            if is_placeholder or args.force:
                updates.append((u["id"], name, cur or "(빈값)", new_email))
            else:
                skips.append((name, "실제 이메일 존재(%s) — --force 시 덮어씀" % cur))
        elif args.insert:
            inserts.append((name, new_email, emp["dept"]))
        else:
            skips.append((name, "CDMS에 없음 — --insert 시 추가"))

    print("== 조직도 동기화 %s ==" % ("(APPLY)" if args.apply else "(미리보기/dry-run)"))
    print("하이웍스 직원:", len(emp_by_name), "| CDMS 사용자:", len(users))
    print("-" * 60)
    print("[업데이트 %d건]" % len(updates))
    for _id, name, old, new in updates:
        print("  %s : %s → %s" % (name, old, new))
    if args.insert:
        print("[신규추가 %d건]" % len(inserts))
        for name, email, dept in inserts:
            print("  + %s <%s> (%s)" % (name, email, dept))
    print("[건너뜀 %d건]" % len(skips))
    for name, why in skips[:40]:
        print("  · %s — %s" % (name, why))
    if len(skips) > 40:
        print("  ... 외 %d건" % (len(skips) - 40))

    if not args.apply:
        print("\n(미리보기입니다. 실제 반영하려면 --apply 추가)")
        return
    done = 0
    for _id, name, old, new in updates:
        st, _ = sb("PATCH", "users", {"id": "eq." + _id}, {"email": new}, prefer="return=minimal")
        if st in (200, 204): done += 1
        else: print("  ! 업데이트 실패:", name, st)
    if args.insert and inserts:
        import uuid; rows = [{"id": str(uuid.uuid4()), "name": n, "email": e} for n, e, _ in inserts]
        st, _ = sb("POST", "users", None, rows, prefer="return=minimal")
        print("신규추가:", "OK" if st in (200, 201, 204) else "실패 %s" % st)
    print("\n✅ 이메일 업데이트 %d건 반영 완료." % done)

# ---------- 사업↔지출결의 매칭 ----------
# 매칭에서 무시할 일반어(사업명에 흔히 들어가 변별력이 낮은 단어)
STOPWORDS = {
    "용역","개발","제작","콘텐츠","컨텐츠","온라인","교육","과정","사업","강의","영상",
    "운영","개선","위탁","프로그램","학습자료","서비스","촬영","자막","외주","교과",
    "교과목","부문","추가","사례","입문","업데이트","위탁개발","개발운영",
    "년도","차년도","학년도","이러닝",
}
HW_PREFIX = "HW지출결의:"   # 워커가 자동 기입한 approval_no 표식(수기 품의번호와 구분)

def _norm(s):
    return re.sub(r"\s+", "", (s or "")).lower()

def program_keywords(name):
    """사업명에서 매칭용 키워드 추출(대괄호·연도·n차·일반어 제거)."""
    n = name or ""
    n = re.sub(r"[\[\]\(\)「」『』·,:;\"'/]+", " ", n)
    n = re.sub(r"20\d{2}\s*학?년?도?", " ", n)   # 2026년/2026학년도 등
    n = re.sub(r"\d+\s*차", " ", n)                       # n차
    toks = []
    for t in re.split(r"\s+", n):
        t = t.strip()
        if len(t) >= 2 and t not in STOPWORDS:
            toks.append(t)
    return toks

def match_program(prog, rows):
    """프로그램 1건과 지출결의 rows 매칭.
       점수: 발주처(client)↔거래처/적요 일치 +3, 사업명 키워드 1개당 +1.
       반환: (best_score, hits)  hits=[(score, row, reasons), ...] 내림차순."""
    nclient = _norm(prog.get("client"))
    kws = [(_norm(k), k) for k in program_keywords(prog.get("name") or "")]
    hits = []
    for d in rows:
        cust = _norm(d.get("customer_name"))
        hay = _norm(d.get("brief")) + " " + cust
        score, reasons = 0, []
        if nclient and len(nclient) >= 3 and (nclient in cust or nclient in hay):
            score += 3; reasons.append("발주처일치")
        for nk, k in kws:
            if nk and nk in hay:
                score += 1; reasons.append(k)
        if score > 0:
            hits.append((score, d, reasons))
    hits.sort(key=lambda x: -x[0])
    return (hits[0][0] if hits else 0), hits

# ---------- 전자결재(지출결의) 조회 ----------
def cmd_spending(args):
    # --apply 시 기본적으로 결재완료(C)만 대상으로 (안전)
    status = args.status or ("C" if args.apply else "")
    params = {"fixed_date": args.month, "type": args.type or None,
              "approval_status": status or None}
    rows = []
    for label, tok in TOKENS:
        st, body = hw_get("/open/office/accounting/spending_report", params, token=tok)
        if st != 200 or not isinstance(body, dict):
            print("  ! [%s] 지출결의 조회 실패 %s: %s (scope office.accounting/제휴 필요할 수 있음)"
                  % (label, st, str(body)[:160]))
            continue
        part = body.get("data") or []
        for d in part: d["_office"] = label
        rows.extend(part)
        print("  · [%s] %d건" % (label, len(part)))
    print("== 지출결의 %s%s (총 %d건) ==" % (
        args.month, (" status=%s" % status) if status else "", len(rows)))
    for d in rows:
        print("  [%s] %s | %s | %s원 | 부서:%s | 적요:%s | 거래처:%s" % (
            d.get("document_code",""), d.get("register_name",""),
            d.get("account_name",""), d.get("price",""),
            d.get("department_name",""), (d.get("brief","") or "")[:24],
            d.get("customer_name","")))

    # CDMS 사업 목록
    st, progs = sb("GET", "programs",
                   {"select": "id,seq,name,client,approval_no,approval_status",
                    "year": "eq.%d" % args.year, "order": "seq.asc"})
    if st != 200 or not isinstance(progs, list):
        die("programs 조회 실패 (%s): %s" % (st, str(progs)[:300]))
    if not rows:
        print("\n(지출결의 0건 — 매칭/반영할 내용 없음. 토큰/scope/월 확인)")
        return

    print("-" * 72)
    print("[사업·발주처 매칭  (min-score=%d, year=%d)]" % (args.min_score, args.year))
    matched = []   # (prog, top_hit)
    unmatched = []
    for p in progs:
        best, hits = match_program(p, rows)
        if best >= args.min_score and hits:
            top = hits[0]
            matched.append((p, top))
            print("  ✔ #%s '%s' ↔ [%s] (점수 %d: %s)" % (
                p.get("seq"), (p.get("name") or "")[:24], top[1].get("document_code",""),
                top[0], ",".join(top[2][:4])))
        else:
            unmatched.append(p)
            print("  · #%s '%s' — 매칭없음 (현재 %s)" % (
                p.get("seq"), (p.get("name") or "")[:24], p.get("approval_status")))

    # 변경안 계산
    to_complete, to_revert = [], []
    for p, top in matched:
        cur_no = p.get("approval_no") or ""
        # 이미 품의완료 + 실제(수기) 품의번호가 있으면 건드리지 않음
        already = (p.get("approval_status") == "품의완료" and cur_no and not cur_no.startswith(HW_PREFIX))
        if not already:
            to_complete.append((p, top[1].get("document_code","")))
    if args.downgrade:
        for p in unmatched:
            cur_no = p.get("approval_no") or ""
            # HW가 자동 기입한 건만 환원(수기 품의번호는 절대 건드리지 않음)
            if p.get("approval_status") == "품의완료" and cur_no.startswith(HW_PREFIX):
                to_revert.append(p)

    print("-" * 72)
    print("[변경안] 품의완료 처리 %d건%s" % (
        len(to_complete), (" / 미등록 환원 %d건" % len(to_revert)) if args.downgrade else ""))
    for p, doc in to_complete:
        cur_no = p.get("approval_no") or ""
        tail = " (기존 품의번호 유지)" if (cur_no and not cur_no.startswith(HW_PREFIX)) else " → %s%s" % (HW_PREFIX, doc)
        print("   + #%s '%s' : %s → 품의완료%s" % (
            p.get("seq"), (p.get("name") or "")[:20], p.get("approval_status"), tail))
    for p in to_revert:
        print("   - #%s '%s' : 품의완료 → 미등록(HW마커 제거)" % (
            p.get("seq"), (p.get("name") or "")[:20]))

    if not args.apply:
        print("\n(미리보기입니다. 실제 반영: --apply / 자동 환원까지: --apply --downgrade)")
        print("※ 지출결의는 '품의서' 결재상태와 다른 문서입니다. 매칭 정확도를 먼저 확인하세요.")
        print("※ 같은 발주처의 사업이 여러 건이면 동일 지출결의에 함께 매칭될 수 있습니다.")
        return

    done = 0
    for p, doc in to_complete:
        patch = {"approval_status": "품의완료"}
        cur_no = p.get("approval_no") or ""
        if not cur_no:   # 비어있을 때만 HW 표식 기입(실제 품의번호 보호)
            patch["approval_no"] = HW_PREFIX + doc
        st, _ = sb("PATCH", "programs", {"id": "eq." + p["id"]}, patch, prefer="return=minimal")
        if st in (200, 204): done += 1
        else: print("  ! 실패 #%s %s" % (p.get("seq"), st))
    rev = 0
    for p in to_revert:
        st, _ = sb("PATCH", "programs", {"id": "eq." + p["id"]},
                   {"approval_status": "미등록", "approval_no": None}, prefer="return=minimal")
        if st in (200, 204): rev += 1
        else: print("  ! 환원 실패 #%s %s" % (p.get("seq"), st))
    print("\n✅ 품의완료 %d건 반영%s 완료." % (
        done, (", 미등록 환원 %d건" % rev) if args.downgrade else ""))

# ---------- main ----------
def main():
    ap = argparse.ArgumentParser(description="CDMS ↔ 하이웍스 연동")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("selfcheck")
    p_org = sub.add_parser("org")
    p_org.add_argument("--apply", action="store_true", help="실제 반영")
    p_org.add_argument("--insert", action="store_true", help="CDMS에 없는 직원 신규추가")
    p_org.add_argument("--force", action="store_true", help="실제 이메일도 덮어쓰기")
    p_sp = sub.add_parser("spending")
    p_sp.add_argument("--month", required=True, help="기준월 YYYYMM")
    p_sp.add_argument("--type", default="", help="P(개인)/C(법인), 전체는 생략")
    p_sp.add_argument("--status", default="", help="P(결재중)/C(결재완료), 전체는 생략(--apply 시 기본 C)")
    p_sp.add_argument("--year", type=int, default=2026, help="대상 사업 연도(기본 2026)")
    p_sp.add_argument("--apply", action="store_true", help="매칭 결과를 programs.approval_status에 실제 반영")
    p_sp.add_argument("--downgrade", action="store_true", help="매칭 안 된 사업 중 워커가 자동기입(HW표식)한 건만 미등록으로 환원")
    p_sp.add_argument("--min-score", type=int, default=4, dest="min_score",
                      help="매칭 인정 최소 점수(기본 4=발주처+키워드1). 3=발주처만(모호 매칭 늘 수 있음)")
    args = ap.parse_args()
    if args.cmd == "selfcheck": cmd_selfcheck(args)
    elif args.cmd == "org": cmd_org(args)
    elif args.cmd == "spending": cmd_spending(args)
    else: ap.print_help()

if __name__ == "__main__":
    main()
