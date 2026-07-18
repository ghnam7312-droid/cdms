#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CDMS NAS Worker
================
미림미디어랩 CDMS의 NAS 연동 워커.
- Supabase의 nas_tasks 큐를 폴링하여 작업을 처리하고,
- 주기적으로 전체 과정 폴더를 스캔하여 제작단계 진행상태(파일 유무·수정일)와
  종편 영상길이(ffprobe)를 자동으로 채운다.

처리 action:
  ping            : 연결 확인 / 공유폴더 목록
  mkdir_tree      : 과정 폴더 + 단계 하위폴더 생성 (params: project, folders)
  scan_progress   : 과정 단계폴더 스캔 → lesson_stage(status,file_mtime,file_name) 갱신
                    + 종편 파일 ffprobe → lessons.duration_sec 갱신
  probe_durations : 종편 영상길이만 다시 추출
  rename_folder   : NAS 폴더명 변경 (params: old, new)  [CDMS→NAS]
  sync_names      : NAS 폴더명을 읽어 CDMS에 반영           [NAS→CDMS] (기초 구현)

⚠️ 이 워커는 Supabase SERVICE ROLE 키를 사용한다. 절대 브라우저/프런트(index.html)에
   넣지 말 것. 서버(.env)에만 보관한다.
"""
import os, re, sys, time, json, tempfile, subprocess, traceback
from datetime import datetime, timezone, timedelta

try:
    from supabase import create_client, Client
except ImportError:
    print("supabase 패키지가 필요합니다:  pip install supabase", file=sys.stderr)
    raise

# ----------------------------------------------------------------------------
# 설정 (.env / 환경변수)
# ----------------------------------------------------------------------------
SB_URL   = os.environ.get("SUPABASE_URL", "https://kowtvvrgpzgrdlnxasxw.supabase.co")
SB_KEY   = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")            # 필수 (service_role)
NAS_MODE = os.environ.get("NAS_MODE", "mount").lower()           # mount | smb

# mount 모드: NAS가 서버에 마운트된 경로
NAS_BASE = os.environ.get("NAS_BASE", "/mnt/nas")

# smb 모드: nas_config 테이블 값을 기본으로 쓰되 환경변수로 덮어쓸 수 있음
SMB_HOST = os.environ.get("NAS_SMB_HOST", "")
SMB_USER = os.environ.get("NAS_SMB_USER", "")
SMB_PASS = os.environ.get("NAS_SMB_PASS", "")
SMB_SHARE= os.environ.get("NAS_SMB_SHARE", "")

# 길이 추출 기준 단계 (종편=7). 폴백 없음(사용자 선택: 종편 기준)
LENGTH_STAGE_ID = int(os.environ.get("LENGTH_STAGE_ID", "7"))
# 영상 확장자
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".avi", ".m4v", ".wmv", ".mpg", ".mpeg", ".mts"}
# 자동 스캔 주기(초). 0 이면 큐 작업만 처리(주기 스캔 끔)
SCAN_INTERVAL = int(os.environ.get("SCAN_INTERVAL", "600"))
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "3"))

# 자동 이메일 (단계 완료 → 다음 담당자)
EMAIL_ENABLED  = os.environ.get("EMAIL_ENABLED", "true").lower() == "true"
EMAIL_PROVIDER = os.environ.get("EMAIL_PROVIDER", "resend").lower()   # resend | sendgrid | smtp
EMAIL_API_KEY  = os.environ.get("EMAIL_API_KEY", "")
EMAIL_FROM     = os.environ.get("EMAIL_FROM", "CDMS <noreply@mirimmedialab.co.kr>")
CDMS_URL       = os.environ.get("CDMS_URL", "https://cdms.mirimmedialab.co.kr")
# SMTP (EMAIL_PROVIDER=smtp 일 때 — 예: 하이웍스 smtps.hiworks.com:465 SSL)
SMTP_HOST      = os.environ.get("SMTP_HOST", "smtps.hiworks.com")
SMTP_PORT      = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER      = os.environ.get("SMTP_USER", "")
SMTP_PASS      = os.environ.get("SMTP_PASS", "")
# 알림 메일 폴백 수신자(PM 이메일이 임시/미설정일 때)
REMIND_EMAIL   = os.environ.get("REMIND_EMAIL", "ghnam7312@gmail.com")
# 영상검수: 시놀로지 등으로 NAS 영상을 외부 HTTPS 직접 서빙하는 경우.
#  NAS_PUBLIC_BASE 가 설정되면 Supabase 업로드 대신 공개 URL을 검수영상으로 사용한다.
#  예) NAS_PUBLIC_ROOT=/mnt  (Web Station 문서루트가 /mnt 에 매핑)
#      NAS_PUBLIC_BASE=https://nas.mirimmedialab.co.kr/files  (그 루트의 공개 베이스)
NAS_PUBLIC_BASE = os.environ.get("NAS_PUBLIC_BASE", "")
NAS_PUBLIC_ROOT = os.environ.get("NAS_PUBLIC_ROOT", NAS_BASE)

# 참조시트 기준 단계 순서/라벨 (프런트와 동일) — "다음 단계" 계산용
REF_ORDER = [1, 2, 3, 4, 5, 6, 7, 10, 13, 9]
REF_LABEL = {1: "원고", 2: "촬영", 3: "가편", 4: "스크립트", 5: "스토리보드",
             6: "디자인", 7: "종편", 10: "srt", 13: "번역", 9: "학습자료",
             8: "검수", 11: "음성", 12: "HTML", 0: "문서"}


def stage_key(sid):
    return REF_ORDER.index(sid) if sid in REF_ORDER else 100 + sid

if not SB_KEY:
    print("환경변수 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.", file=sys.stderr)
    sys.exit(1)

sb: Client = create_client(SB_URL, SB_KEY)

# 차시 번호 추출:  "3차시", "03차시", "3 차시"  →  3
RE_LESSON = re.compile(r"(\d+)\s*차\s*시")
# 주차 번호(있으면 함께 매칭):  "7주차"
RE_WEEK   = re.compile(r"(\d+)\s*주\s*차")


def log(*a):
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def _from_addr(s):
    m = re.search(r"<([^>]+)>", s or "")
    return m.group(1) if m else (s or "")


def _send_smtp(to_email, subject, html):
    """SMTP(SSL) 발송 — 하이웍스 등 기존 메일서버용."""
    import smtplib, ssl
    from email.mime.text import MIMEText
    from email.utils import formataddr, parseaddr
    if not (SMTP_USER and SMTP_PASS):
        return (False, "SMTP_USER/SMTP_PASS 없음")
    name, addr = parseaddr(EMAIL_FROM)
    from_addr = addr or SMTP_USER
    msg = MIMEText(html, "html", "utf-8")
    msg["Subject"] = subject
    msg["From"] = formataddr((name or "CDMS", from_addr))
    msg["To"] = to_email
    try:
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ctx, timeout=20) as s:
            s.login(SMTP_USER, SMTP_PASS)
            s.sendmail(from_addr, [to_email], msg.as_string())
        return (True, None)
    except Exception as e:
        return (False, str(e)[:200])


def send_email(to_email, subject, html):
    """Resend / SendGrid HTTP API 또는 SMTP 로 메일 발송. (True, None) 또는 (False, error)."""
    if not (EMAIL_ENABLED and to_email):
        return (False, "email 비활성/수신자없음")
    if EMAIL_PROVIDER == "smtp":
        return _send_smtp(to_email, subject, html)
    import urllib.request, urllib.error
    if not EMAIL_API_KEY:
        return (False, "EMAIL_API_KEY 없음")
    try:
        if EMAIL_PROVIDER == "sendgrid":
            url = "https://api.sendgrid.com/v3/mail/send"
            payload = {"personalizations": [{"to": [{"email": to_email}]}],
                       "from": {"email": _from_addr(EMAIL_FROM)},
                       "subject": subject,
                       "content": [{"type": "text/html", "value": html}]}
        else:  # resend
            url = "https://api.resend.com/emails"
            payload = {"from": EMAIL_FROM, "to": [to_email],
                       "subject": subject, "html": html}
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": "Bearer %s" % EMAIL_API_KEY,
                     "Content-Type": "application/json",
                     "Accept": "application/json",
                     # Cloudflare가 기본 python-urllib UA를 봇(1010)으로 차단하므로 일반 UA 지정
                     "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) CDMS-NAS-Worker/1.0"})
        urllib.request.urlopen(req, timeout=20).read()
        return (True, None)
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode()[:200]
        except Exception:
            body = ""
        return (False, "HTTP %s %s" % (e.code, body))
    except Exception as e:
        return (False, str(e))


# ============================================================================
# 파일시스템 추상화 (mount / smb)
# ============================================================================
class MountFS:
    """NAS가 로컬에 마운트된 경우. 일반 파일시스템 사용."""
    def __init__(self, base):
        self.base = base

    def _abs(self, path):
        if not path:
            return self.base
        if os.path.isabs(path):
            return path
        return os.path.join(self.base, path)

    def exists(self, path):
        return os.path.exists(self._abs(path))

    def listfiles(self, path):
        p = self._abs(path)
        if not os.path.isdir(p):
            return []
        out = []
        for name in os.listdir(p):
            fp = os.path.join(p, name)
            if os.path.isfile(fp):
                out.append((name, os.path.getmtime(fp)))
        return out

    def walkfiles(self, path):
        """단계 폴더를 하위폴더까지 훑어 (단계폴더 기준 상대경로, mtime) 목록 반환."""
        base = self._abs(path)
        if not os.path.isdir(base):
            return []
        out = []
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for f in files:
                if f.startswith(".") or f == "Thumbs.db":
                    continue
                fp = os.path.join(root, f)
                try:
                    mt = os.path.getmtime(fp)
                except OSError:
                    continue
                out.append((os.path.relpath(fp, base).replace("\\", "/"), mt))
        return out

    def listdirs(self, path):
        p = self._abs(path)
        if not os.path.isdir(p):
            return []
        return [n for n in os.listdir(p) if os.path.isdir(os.path.join(p, n))]

    def makedirs(self, path):
        os.makedirs(self._abs(path), exist_ok=True)

    def rename(self, old, new):
        os.rename(self._abs(old), self._abs(new))

    def local_copy(self, path):
        """ffprobe용 로컬 경로. 마운트 모드는 그대로 반환."""
        return self._abs(path), False  # (경로, 임시파일여부)

    def shares(self):
        try:
            return [os.path.join(self.base, n) for n in os.listdir(self.base)]
        except Exception as e:
            return ["(목록 실패: %s)" % e]


class SmbFS:
    """SMB 직접 접속. smbprotocol(smbclient) 사용."""
    def __init__(self, host, user, pw, share):
        import smbclient
        self.smbclient = smbclient
        self.host = host
        self.share = share
        smbclient.ClientConfig(username=user, password=pw)
        self._user = user
        self._pw = pw

    def _unc(self, path):
        if path and path.startswith("\\\\"):   # 이미 전체 UNC 경로면 그대로
            return path.replace("/", "\\")
        path = (path or "").replace("/", "\\").lstrip("\\")
        base = r"\\%s\%s" % (self.host, self.share)
        return base + ("\\" + path if path else "")

    def exists(self, path):
        try:
            self.smbclient.stat(self._unc(path)); return True
        except Exception:
            return False

    def listfiles(self, path):
        out = []
        try:
            for e in self.smbclient.scandir(self._unc(path)):
                if e.is_file():
                    out.append((e.name, e.stat().st_mtime))
        except Exception:
            pass
        return out

    def walkfiles(self, path):
        out = []
        def rec(rel):
            sub = path + ("/" + rel if rel else "")
            try:
                entries = list(self.smbclient.scandir(self._unc(sub)))
            except Exception:
                return
            for e in entries:
                nm = e.name
                if nm.startswith(".") or nm == "Thumbs.db":
                    continue
                childrel = (rel + "/" + nm) if rel else nm
                try:
                    if e.is_dir():
                        rec(childrel)
                    elif e.is_file():
                        out.append((childrel, e.stat().st_mtime))
                except Exception:
                    continue
        rec("")
        return out

    def listdirs(self, path):
        out = []
        try:
            for e in self.smbclient.scandir(self._unc(path)):
                if e.is_dir():
                    out.append(e.name)
        except Exception:
            pass
        return out

    def makedirs(self, path):
        parts, cur = path.replace("\\", "/").strip("/").split("/"), ""
        for p in parts:
            cur = (cur + "/" + p) if cur else p
            try:
                self.smbclient.mkdir(self._unc(cur))
            except Exception:
                pass

    def rename(self, old, new):
        self.smbclient.rename(self._unc(old), self._unc(new))

    def local_copy(self, path):
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(path)[1])
        with self.smbclient.open_file(self._unc(path), mode="rb") as f:
            tmp.write(f.read())
        tmp.close()
        return tmp.name, True

    def shares(self):
        return [r"\\%s\%s" % (self.host, self.share)]


def build_fs():
    if NAS_MODE == "smb":
        host, user, pw, share = SMB_HOST, SMB_USER, SMB_PASS, SMB_SHARE
        # 비어 있으면 nas_config에서 보충
        if not (host and user and share):
            try:
                cfg = sb.table("nas_config").select("*").limit(1).execute().data
                if cfg:
                    c = cfg[0]
                    host = host or (c.get("url") or "").replace("smb://", "").strip("/")
                    user = user or c.get("username") or ""
                    pw   = pw   or c.get("password") or ""
                    share= share or c.get("base") or ""
            except Exception as e:
                log("nas_config 읽기 실패:", e)
        return SmbFS(host, user, pw, share)
    return MountFS(NAS_BASE)


# ============================================================================
# ffprobe
# ============================================================================
def ffprobe_seconds(fs, remote_path):
    local, is_tmp = fs.local_copy(remote_path)
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nokey=1", local],
            capture_output=True, text=True, timeout=120)
        val = (out.stdout or "").strip()
        return int(round(float(val))) if val else None
    except Exception as e:
        log("ffprobe 실패:", remote_path, e)
        return None
    finally:
        if is_tmp:
            try: os.unlink(local)
            except Exception: pass


# ============================================================================
# 데이터 로딩
# ============================================================================
def load_project_bundle(project_id):
    proj = sb.table("projects").select("*").eq("id", project_id).limit(1).execute().data
    if not proj:
        return None
    proj = proj[0]
    stages = {s["id"]: s for s in sb.table("stages").select("*").execute().data}
    pstages = sb.table("project_stages").select("*").eq("project_id", project_id).eq("enabled", True).execute().data
    enabled = [stages[p["stage_id"]] for p in pstages if p["stage_id"] in stages]
    lessons = sb.table("lessons").select("id,lesson_no,week_id").eq("project_id", project_id).execute().data
    weeks = {w["id"]: w["week_no"] for w in sb.table("weeks").select("id,week_no").eq("project_id", project_id).execute().data}
    for l in lessons:
        l["week_no"] = weeks.get(l.get("week_id"))
    lesson_ids = [l["id"] for l in lessons] or ["00000000-0000-0000-0000-000000000000"]
    ls = sb.table("lesson_stage").select("lesson_id,stage_id,status,file_name").in_(
        "lesson_id", lesson_ids).execute().data
    cur = {(r["lesson_id"], r["stage_id"]): r for r in ls}
    # 단계별 담당자 + 사용자 + 기존 발송로그(중복방지)
    assignees = {a["stage_id"]: a["user_id"]
                 for a in sb.table("stage_assignees").select("stage_id,user_id").eq("project_id", project_id).execute().data}
    users = {u["id"]: u for u in sb.table("users").select("id,name,email").execute().data}
    notified = set()
    for r in sb.table("email_notifications").select("lesson_id,completed_stage_id").in_("lesson_id", lesson_ids).execute().data:
        notified.add((r["lesson_id"], r["completed_stage_id"]))
    return {"proj": proj, "enabled": enabled, "lessons": lessons, "ls": cur,
            "assignees": assignees, "users": users, "notified": notified}


def match_lesson(filename, lessons, has_weeks):
    m = RE_LESSON.search(filename)
    wk = RE_WEEK.search(filename)
    lesson_no = int(m.group(1)) if m else None
    week_no = int(wk.group(1)) if wk else None
    if has_weeks and wk and m:
        for l in lessons:
            if l["lesson_no"] == lesson_no and l.get("week_no") == week_no:
                return l
    if (not has_weeks) and week_no is not None:
        # 차시형 과정: 파일명의 "N주차"가 CDMS 차시 번호, 파일명의 "N차시"는 파트 번호
        #  (예: 데이터사이언스_01주차 2차시.mp4 = 1차시의 2번째 파트) — Edge(nas-versions matchLesson)와 동일 규칙 (2026-07-17)
        cands = [l for l in lessons if l["lesson_no"] == week_no]
        if len(cands) == 1:
            return cands[0]
    if lesson_no is None:
        return None
    cands = [l for l in lessons if l["lesson_no"] == lesson_no]
    if len(cands) == 1:
        return cands[0]
    return None


# ============================================================================
# action: scan_progress
# ============================================================================
def action_scan_progress(fs, project_id, do_duration=False):
    # (2026-07-15) do_duration 기본 False: 영상 길이는 Edge(nas-versions)가 파트 "합산"으로 계산·관리.
    # 워커의 단일 파일(최근 1개) 길이 덮어쓰기는 다중 파트 차시의 합계를 훼손하므로 비활성화.
    b = load_project_bundle(project_id)
    if not b:
        return {"ok": False, "error": "project not found"}
    proj, enabled, lessons, cur = b["proj"], b["enabled"], b["lessons"], b["ls"]
    assignees, users, notified = b["assignees"], b["users"], b["notified"]
    root = proj.get("nas_root")
    if not root:
        return {"ok": False, "error": "nas_root 미설정 — 먼저 NAS 폴더생성(mkdir_tree)을 실행하세요"}
    if re.match(r"^nas\d+:", root):
        return {"ok": True, "skipped": True, "note": "다른 NAS(nasN:) 과정 — Edge(nas-versions) 스캔이 담당"}
    has_weeks = any(l.get("week_no") for l in lessons)
    now = datetime.now(timezone.utc).isoformat()

    found = {}   # (lesson_id, stage_id) -> (mtime, name)
    durations = {}  # lesson_id -> remote path

    for s in enabled:
        folder = "%s/%s" % (root, s["nas_folder"])
        if not fs.exists(folder):
            continue
        for rel, mtime in fs.walkfiles(folder):
            base = rel.rsplit("/", 1)[-1]
            if base.startswith("~") or ".cdms_" in rel:
                continue
            # 파일명 또는 상위 차시폴더명(예: 07_종편/2차시/영상.mp4)으로 매칭
            l = match_lesson(rel, lessons, has_weeks)
            if not l:
                continue
            key = (l["id"], s["id"])
            if key not in found or mtime > found[key][0]:
                found[key] = (mtime, base)
            # 길이: 종편(LENGTH_STAGE_ID) 영상파일 — 같은 차시에 여럿이면 가장 최근
            if do_duration and s["id"] == LENGTH_STAGE_ID and os.path.splitext(base)[1].lower() in VIDEO_EXT:
                if l["id"] not in durations or mtime >= durations[l["id"]][0]:
                    durations[l["id"]] = (mtime, "%s/%s" % (folder, rel))

    upserts, reverts, updated_dur = [], [], 0

    # 1) 파일 발견 → done + 수정일 + 파일명
    for (lesson_id, stage_id), (mtime, name) in found.items():
        iso = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
        upserts.append({"lesson_id": lesson_id, "stage_id": stage_id, "status": "done",
                        "file_mtime": iso, "file_name": name, "updated_at": now})

    # 2) 이전에 자동표기(file_name 있음)였으나 지금 파일이 사라진 경우 → wait 로 되돌림
    for (lesson_id, stage_id), row in cur.items():
        if (lesson_id, stage_id) in found:
            continue
        if row.get("file_name"):  # 자동으로 채워졌던 셀
            reverts.append({"lesson_id": lesson_id, "stage_id": stage_id, "status": "wait",
                            "file_mtime": None, "file_name": None, "updated_at": now})

    # (2026-07) 진행 표기/되돌림은 Edge(nas-versions scan)가 파일 "생성일"·수정본·검수사이클 기준으로 담당.
    # 워커는 영상길이(ffprobe)와 완료 이메일만 수행 — lesson_stage에 쓰지 않음(충돌 방지).
    upserts_disabled, reverts_disabled = upserts, reverts

    # 3) 종편 영상길이
    if do_duration and durations:
        for lesson_id, (mt, path) in durations.items():
            sec = ffprobe_seconds(fs, path)
            if sec:
                sb.table("lessons").update({"duration_sec": sec}).eq("id", lesson_id).execute()
                updated_dur += 1

    # 4) 자동 이메일: 이번 스캔에서 새로 완료(wait→done)된 단계 → 다음 사용단계 담당자에게 알림
    emailed = notify_next(proj, enabled, lessons, cur, found, assignees, users, notified) if EMAIL_ENABLED else 0

    return {"ok": True, "project": proj["name"], "marked": 0, "found": len(upserts),
            "reverted": 0, "durations": updated_dur, "emailed": emailed}


def notify_next(proj, enabled, lessons, cur, found, assignees, users, notified):
    order = sorted(enabled, key=lambda s: stage_key(s["id"]))
    ids = [s["id"] for s in order]
    lmap = {l["id"]: l for l in lessons}
    sent = 0
    for (lesson_id, stage_id), (mtime, name) in found.items():
        prev = cur.get((lesson_id, stage_id))
        if prev and prev.get("status") == "done":
            continue                                   # 이미 완료였음 → 알림 안함
        if (lesson_id, stage_id) in notified:
            continue                                   # 이미 발송 기록 있음
        if stage_id not in ids:
            continue
        i = ids.index(stage_id)
        nxt = order[i + 1] if i + 1 < len(order) else None
        if not nxt:
            continue                                   # 마지막 단계 → 다음 없음
        au = assignees.get(nxt["id"])
        user = users.get(au) if au else None
        to = (user or {}).get("email")
        lesson = lmap.get(lesson_id)
        lno = lesson.get("lesson_no") if lesson else "?"
        done_label = REF_LABEL.get(stage_id, str(stage_id))
        next_label = REF_LABEL.get(nxt["id"], str(nxt["id"]))
        subject = "[CDMS] %s · %s차시 — '%s' 차례입니다" % (proj["name"], lno, next_label)
        html = ("<div style='font-family:sans-serif;font-size:14px;color:#1c2430'>"
                "<p>안녕하세요%s,</p>"
                "<p><b>%s</b> %s차시의 <b>%s</b> 단계가 완료되어 <b>%s</b> 단계를 진행할 차례입니다.</p>"
                "<p>제작 현황: <a href='%s'>%s</a></p>"
                "<p style='color:#8a94a6;font-size:12px'>— CDMS 자동알림</p></div>") % (
                (" " + user["name"] if user and user.get("name") else ""),
                proj["name"], lno, done_label, next_label, CDMS_URL, CDMS_URL)
        if to:
            ok, err = send_email(to, subject, html)
            status = "sent" if ok else "error"
        else:
            ok, err, status = False, "다음 단계(%s) 담당자 미지정" % next_label, "no_assignee"
        try:
            sb.table("email_notifications").upsert({
                "lesson_id": lesson_id, "completed_stage_id": stage_id, "next_stage_id": nxt["id"],
                "to_email": to, "to_user": au, "subject": subject,
                "status": status, "error": err}, on_conflict="lesson_id,completed_stage_id").execute()
        except Exception as e:
            log("email_notifications 기록 실패:", e)
        if ok:
            sent += 1
        else:
            log("이메일 미발송:", proj["name"], lno, next_label, "-", err)
    return sent


def action_probe_durations(fs, project_id):
    # 길이 계산은 Edge(nas-versions scan)가 담당 — 여기서는 진행 표기 스캔만 수행
    return action_scan_progress(fs, project_id, do_duration=False)


# ============================================================================
# action: audio_check — 종편 영상 오디오 품질 점검 (무음/클리핑/과대·과소 음량)
#   결과는 audio_checks 테이블(lesson_id당 1행 upsert)에 기록 → CDMS 차시 상세에 표시
# ============================================================================
AUDIO_SILENCE_DB  = float(os.environ.get("AUDIO_SILENCE_DB", "-45"))   # 무음 판정 임계(dB)
AUDIO_SILENCE_MIN = float(os.environ.get("AUDIO_SILENCE_MIN", "2.0"))  # 무음 최소 길이(초)
AUDIO_LOUD_M      = float(os.environ.get("AUDIO_LOUD_M", "-9"))        # 과대 음량(Momentary LUFS)
AUDIO_QUIET_M     = float(os.environ.get("AUDIO_QUIET_M", "-33"))      # 과소 음량(Momentary LUFS)
AUDIO_JUMP_LU     = float(os.environ.get("AUDIO_JUMP_LU", "15"))       # 구간 간 음량 급변 임계(LU) — 9→15 완화(2026-07-17, 오탐 감소)
AUDIO_CH_MIN      = float(os.environ.get("AUDIO_CH_MIN", "3.0"))       # 한쪽 채널 무음 최소 길이(초)
# 영상 품질 기준
VIDEO_W        = int(os.environ.get("VIDEO_W", "1920"))
VIDEO_H        = int(os.environ.get("VIDEO_H", "1080"))
VIDEO_KBPS_MIN = int(os.environ.get("VIDEO_KBPS_MIN", "3000"))
VIDEO_KBPS_MAX = int(os.environ.get("VIDEO_KBPS_MAX", "5500"))
VIDEO_FPS_MIN  = float(os.environ.get("VIDEO_FPS_MIN", "29.97"))
VIDEO_FPS_MAX  = float(os.environ.get("VIDEO_FPS_MAX", "30.0"))
VIDEO_BW_MIN   = float(os.environ.get("VIDEO_BW_MIN", "0.06"))         # 블랙/화이트 최소 지속(초) ≈ 2프레임@30fps
# 명도대비(웹접근성) 자동 검사
CCA_ENABLED  = os.environ.get("CCA_ENABLED", "true").lower() == "true"
CCA_INTERVAL = float(os.environ.get("CCA_INTERVAL", "5"))   # 프레임 샘플 간격(초)
CCA_RATIO    = float(os.environ.get("CCA_RATIO", "4.5"))    # 기준 대비(WCAG AA)
CCA_MIN_H    = int(os.environ.get("CCA_MIN_H", "20"))       # 검사할 최소 글자 높이(px) — 14→20 완화(2026-07-17)
CCA_MIN_CONF = int(os.environ.get("CCA_MIN_CONF", "82"))    # OCR 신뢰도 하한 — 75→82 (장식·워터마크·이미지 오탐 감소, 2026-07-18)
CCA_BG_STD   = float(os.environ.get("CCA_BG_STD", "12"))    # 배경 균일도(밝기 표준편차) 상한 — 슬라이드·자막은 단색 배경, 이미지 속 장식 텍스트 배제

QC_VER = "v6-flatbg"  # 품질 점검 기준 버전 (v6: 단색 배경 위 학습 텍스트만 검사 — 이미지·모션그래픽 속 장식 텍스트 제외)


def _wcag_ratio(rgb1, rgb2):
    def lum(rgb):
        c = [v / 255.0 for v in rgb]
        c = [v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4 for v in c]
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    l1, l2 = lum(rgb1), lum(rgb2)
    return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)


def _analyze_contrast_local(local):
    """프레임 샘플 → OCR(tesseract)로 텍스트 영역 검출 → 글자/배경색 추정 → WCAG 대비 미달 구간 반환"""
    import shutil
    if not CCA_ENABLED:
        return []
    if not shutil.which("tesseract"):
        log("명도대비: tesseract 미설치 — 건너뜀 (sudo apt-get install -y tesseract-ocr tesseract-ocr-kor)")
        return []
    try:
        from PIL import Image
    except ImportError:
        log("명도대비: pillow 미설치 — 건너뜀 (pip install pillow)")
        return []
    langs = "kor+eng"
    try:
        o0 = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, timeout=30)
        if "kor" not in (o0.stdout or ""):
            langs = "eng"
    except Exception:
        langs = "eng"
    tmpd = tempfile.mkdtemp(prefix="cdms_cca_")
    issues = []
    try:
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", local, "-an",
                        "-vf", "fps=1/%g" % CCA_INTERVAL, os.path.join(tmpd, "f%05d.png")],
                       capture_output=True, timeout=3600)
        fails = []  # (t, (ratio, fg, bg, txt))
        for fn in sorted(os.listdir(tmpd)):
            try:
                idx = int(fn[1:6])
            except Exception:
                continue
            t = (idx - 1) * CCA_INTERVAL
            fp = os.path.join(tmpd, fn)
            o = subprocess.run(["tesseract", fp, "stdout", "-l", langs, "--psm", "11", "tsv"],
                               capture_output=True, text=True, timeout=120)
            img = None
            worst = None
            for ln in (o.stdout or "").splitlines()[1:]:
                cols = ln.split("\t")
                if len(cols) < 12:
                    continue
                try:
                    conf = float(cols[10]); txt = cols[11].strip()
                    x, y, w0, h0 = int(cols[6]), int(cols[7]), int(cols[8]), int(cols[9])
                except Exception:
                    continue
                if conf < CCA_MIN_CONF or len(txt) < 2 or h0 < CCA_MIN_H or w0 < CCA_MIN_H:
                    continue
                # 학습 텍스트만 대상: 실제 문자 구성 검사 — 한글 2자↑ 또는 영문·숫자 3자↑ (옷 주름·장식 요소의 OCR 헛인식 배제)
                core = re.sub(r"[^0-9A-Za-z가-힣]", "", txt)
                hangul = re.sub(r"[^가-힣]", "", core)
                if not (len(hangul) >= 2 or len(core) >= 3):
                    continue
                if img is None:
                    img = Image.open(fp).convert("RGB")
                pad = max(2, h0 // 4)
                box = img.crop((max(0, x - pad), max(0, y - pad),
                                min(img.width, x + w0 + pad), min(img.height, y + h0 + pad)))
                px = list(box.getdata())
                if len(px) < 50:
                    continue
                lums = sorted((0.2126 * r + 0.7152 * g + 0.0722 * b, (r, g, b)) for r, g, b in px)
                n = len(lums)
                q = max(1, n // 4)
                q5 = max(1, n // 20)
                avg = lambda ps: tuple(sum(c[i] for c in ps) / len(ps) for i in range(3))
                # 배경 균일도: 학습 텍스트(슬라이드·자막)는 단색 배경 — 어두운/밝은 쪽 중 한쪽은 균일해야 함.
                #  양쪽 모두 얼룩덜룩하면 이미지·모션그래픽 속 부수적 텍스트(WCAG 제외 대상)로 보고 건너뜀 (2026-07-18)
                def _std(vs):
                    m = sum(vs) / len(vs)
                    return (sum((v - m) ** 2 for v in vs) / len(vs)) ** 0.5
                sd_dark = _std([l for l, _ in lums[:q]])
                sd_bright = _std([l for l, _ in lums[-q:]])
                if min(sd_dark, sd_bright) > CCA_BG_STD:
                    continue
                dark25, bright25 = avg([p for _, p in lums[:q]]), avg([p for _, p in lums[-q:]])
                dark5, bright5 = avg([p for _, p in lums[:q5]]), avg([p for _, p in lums[-q5:]])
                # 실제 글자 획 색(극단 5%) 기준 — 가는 글자에서 배경 픽셀이 섞여 대비가 과소측정되던 문제 수정 (2026-07-18)
                #  어두운 글자/밝은 배경, 밝은 글자/어두운 배경 양방향 중 큰 값 채택
                ratio = max(_wcag_ratio(dark5, bright25), _wcag_ratio(dark25, bright5))
                # 대비 1.25:1 미만은 글자/배경이 사실상 같은 색 = OCR이 글자를 읽었을 수 없는 영역(이미지 질감 오인) → 제외
                if ratio < 1.25:
                    continue
                if worst is None or ratio < worst[0]:
                    worst = (ratio, txt, (x, y, w0, h0), fp)
            if worst and worst[0] < CCA_RATIO:
                fails.append((t, worst))
        i = 0
        while i < len(fails):  # 연속 실패 프레임 병합
            j = i
            while j + 1 < len(fails) and fails[j + 1][0] - fails[j][0] <= CCA_INTERVAL * 1.5:
                j += 1
            wr = min(fails[k][1][0] for k in range(i, j + 1))
            d = {"type": "contrast", "start": round(fails[i][0], 1),
                 "end": round(fails[j][0] + CCA_INTERVAL, 1),
                 "detail": "명도대비 %.2f:1 — 기준 %.1f:1 미달 (자막/텍스트 가독성)" % (wr, CCA_RATIO)}
            # 문제 프레임 캡처: 구간 내 대비가 가장 낮은 프레임에 문제 영역 박스 표시 → previews/qc 업로드
            try:
                import hashlib
                from PIL import ImageDraw
                k0 = min(range(i, j + 1), key=lambda k: fails[k][1][0])
                w0i = fails[k0][1]
                bb0 = w0i[2] if len(w0i) > 2 else None
                fp0 = w0i[3] if len(w0i) > 3 else None
                if fp0 and os.path.exists(fp0):
                    im0 = Image.open(fp0).convert("RGB")
                    if bb0:
                        dr = ImageDraw.Draw(im0)
                        x0, y0, w1, h1 = bb0
                        for off in range(3):
                            dr.rectangle([max(0, x0 - 6 - off), max(0, y0 - 6 - off),
                                          min(im0.width - 1, x0 + w1 + 6 + off), min(im0.height - 1, y0 + h1 + 6 + off)],
                                         outline=(255, 59, 48))
                    im0.thumbnail((960, 960))
                    ob = tempfile.NamedTemporaryFile(prefix="cdms_qc_", suffix=".jpg", delete=False)
                    obp = ob.name
                    ob.close()
                    im0.save(obp, "JPEG", quality=80)
                    with open(obp, "rb") as fj:
                        dat = fj.read()
                    try:
                        os.unlink(obp)
                    except Exception:
                        pass
                    key0 = hashlib.sha256(dat).hexdigest()[:24]
                    dest0 = "qc/%s.jpg" % key0
                    try:
                        sb.storage.from_("previews").upload(dest0, dat, {"content-type": "image/jpeg", "upsert": "true"})
                    except Exception as e2:
                        es2 = str(e2).lower()
                        if "exist" not in es2 and "duplicate" not in es2:
                            raise
                    d["shot"] = "%s/storage/v1/object/public/previews/%s" % (SB_URL, dest0)
            except Exception as e1:
                log("명도대비 프레임 캡처 실패:", e1)
            issues.append(d)
            i = j + 1
    except Exception as e:
        log("명도대비 분석 실패:", e)
    finally:
        shutil.rmtree(tmpd, ignore_errors=True)
    return issues


def _analyze_video_local(local):
    """영상 품질 점검: 규격(해상도/비트레이트/프레임레이트) + 블랙/화이트 프레임 구간"""
    issues, stats = [], {}
    # 1) 규격 (ffprobe)
    po = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                         "-show_entries", "stream=width,height,avg_frame_rate,bit_rate",
                         "-show_entries", "format=bit_rate", "-of", "json", local],
                        capture_output=True, text=True, timeout=120)
    j = json.loads(po.stdout or "{}")
    st0 = (j.get("streams") or [{}])[0]
    w, h = st0.get("width"), st0.get("height")
    afr = st0.get("avg_frame_rate") or "0/1"
    try:
        num, den = afr.split("/")
        fps = (float(num) / float(den)) if float(den) else 0.0
    except Exception:
        fps = 0.0
    br = st0.get("bit_rate") or (j.get("format") or {}).get("bit_rate") or 0
    try:
        kbps = int(int(br) / 1000)
    except Exception:
        kbps = 0
    stats["video"] = {"w": w, "h": h, "fps": round(fps, 2), "kbps": kbps}
    if w and h and (int(w), int(h)) != (VIDEO_W, VIDEO_H):
        issues.append({"type": "spec", "start": 0, "end": 0,
                       "detail": "프레임 사이즈 {}×{} — 기준 {}×{}".format(w, h, VIDEO_W, VIDEO_H)})
    if kbps and not (VIDEO_KBPS_MIN <= kbps <= VIDEO_KBPS_MAX):
        issues.append({"type": "spec", "start": 0, "end": 0,
                       "detail": "비트전송률 {:,}kbps — 기준 {:,}~{:,}kbps".format(kbps, VIDEO_KBPS_MIN, VIDEO_KBPS_MAX)})
    if fps and not (VIDEO_FPS_MIN - 0.01 <= fps <= VIDEO_FPS_MAX + 0.01):
        issues.append({"type": "spec", "start": 0, "end": 0,
                       "detail": "프레임레이트 %.2ffps — 기준 %g~%gfps" % (fps, VIDEO_FPS_MIN, VIDEO_FPS_MAX)})
    # 2) 100% 블랙/화이트 프레임 (2프레임 이상 연속)
    bd = "blackdetect=d=%g:pic_th=0.98:pix_th=0.05" % VIDEO_BW_MIN
    def detect(filters):
        out = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", local, "-an",
                              "-vf", filters, "-f", "null", "-"],
                             capture_output=True, text=True, timeout=3600)
        segs = []
        for mm in re.finditer(r"black_start:\s*(-?\d+\.?\d*)\s+black_end:\s*(-?\d+\.?\d*)", out.stderr or ""):
            segs.append((float(mm.group(1)), float(mm.group(2))))
        return segs
    for a, b2 in detect(bd):
        issues.append({"type": "black", "start": round(a, 2), "end": round(b2, 2),
                       "detail": "%.2f초 블랙(검은 화면) 프레임" % (b2 - a)})
    for a, b2 in detect("negate," + bd):
        issues.append({"type": "white", "start": round(a, 2), "end": round(b2, 2),
                       "detail": "%.2f초 화이트(흰 화면) 프레임" % (b2 - a)})
    return issues, stats


def _analyze_audio(fs, remote_path):
    """ffmpeg 1회 실행(silencedetect+ebur128+volumedetect) → (issues, stats)"""
    local, is_tmp = fs.local_copy(remote_path)
    try:
        af = "silencedetect=noise=%gdB:d=%g,ebur128=metadata=0,volumedetect" % (AUDIO_SILENCE_DB, AUDIO_SILENCE_MIN)
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", local, "-vn", "-map", "0:a:0?",
             "-af", af, "-f", "null", "-"],
            capture_output=True, text=True, timeout=1800)
        err = out.stderr or ""
        issues, stats = [], {}
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.?\d*)", err)
        dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else None
        stats["duration"] = dur
        if "does not contain any stream" in err or "matches no streams" in err:
            issues.append({"type": "no_audio", "start": 0, "end": dur or 0, "detail": "오디오 트랙 없음"})
            return issues, stats
        # 무음 구간
        starts = [float(x) for x in re.findall(r"silence_start:\s*(-?\d+\.?\d*)", err)]
        ends = [(float(a), float(b)) for a, b in
                re.findall(r"silence_end:\s*(-?\d+\.?\d*)\s*\|\s*silence_duration:\s*(-?\d+\.?\d*)", err)]
        for i, st in enumerate(starts):
            if i < len(ends):
                en, d = ends[i]
            else:  # 파일 끝까지 무음
                en = dur or st
                d = en - st
            issues.append({"type": "silence", "start": round(max(0, st), 1), "end": round(en, 1),
                           "detail": "%.1f초 무음" % d})
        # 전체 볼륨 / 클리핑
        m = re.search(r"mean_volume:\s*(-?\d+\.?\d*)\s*dB", err)
        if m: stats["mean"] = float(m.group(1))
        m = re.search(r"max_volume:\s*(-?\d+\.?\d*)\s*dB", err)
        if m: stats["max"] = float(m.group(1))
        if stats.get("max") is not None and stats["max"] >= -0.1:
            issues.append({"type": "clip", "start": 0, "end": round(dur or 0, 1),
                           "detail": "최대 볼륨 %.1fdB — 클리핑(음 깨짐) 의심" % stats["max"]})
        # 구간 라우드니스(ebur128 Momentary) → 과대/과소
        frames3 = [(float(t), float(m2), float(s2)) for t, m2, s2 in
                   re.findall(r"t:\s*(-?\d+\.?\d*)\s+TARGET:.*?M:\s*(-?\d+\.?\d*)\s+S:\s*(-?\d+\.?\d*)", err)]
        frames = [(t, m2) for t, m2, s2 in frames3]
        def runs(flag_fn, min_len):
            segs, s0, last = [], None, None
            for t, mv in frames:
                if flag_fn(mv):
                    if s0 is None: s0 = t
                    last = t
                else:
                    if s0 is not None and last is not None and last - s0 >= min_len:
                        segs.append((s0, last))
                    s0 = None
            if s0 is not None and last is not None and last - s0 >= min_len:
                segs.append((s0, last))
            return segs
        sil = [(i["start"], i["end"]) for i in issues if i["type"] == "silence"]
        def in_sil(a, b):
            return any(not (b < s or a > e) for s, e in sil)
        for a, b in runs(lambda v: v >= AUDIO_LOUD_M, 1.0):
            issues.append({"type": "loud", "start": round(a, 1), "end": round(b, 1),
                           "detail": "음량 과대 — 순간 라우드니스 %g LUFS 이상" % AUDIO_LOUD_M})
        for a, b in runs(lambda v: -70 < v <= AUDIO_QUIET_M, 3.0):
            if not in_sil(a, b):
                issues.append({"type": "quiet", "start": round(a, 1), "end": round(b, 1),
                               "detail": "음량 과소 — 대사가 잘 안 들릴 수 있음"})
        # 구간 간 음량 급변 (Short-term 라우드니스가 3초 전 대비 AUDIO_JUMP_LU 이상 차이)
        svals = [(t, s2) for t, m2, s2 in frames3 if s2 > -70]
        marks = []
        for i in range(30, len(svals)):
            t1, s1 = svals[i]
            t0, s0 = svals[i - 30]
            if t1 - t0 <= 4.0 and abs(s1 - s0) >= AUDIO_JUMP_LU:
                marks.append((t1, s1 - s0))
        i = 0
        while i < len(marks):
            j = i
            while j + 1 < len(marks) and marks[j + 1][0] - marks[j][0] <= 2.0:
                j += 1
            a, b = marks[i][0], marks[j][0]
            mx = max(abs(d) for _, d in marks[i:j + 1])
            if not in_sil(max(0, a - 3), b):
                issues.append({"type": "jump", "start": round(max(0, a - 3), 1), "end": round(b, 1),
                               "detail": "음량 급변 — 구간 간 %.0f LU 차이" % mx})
            i = j + 1
        # 스테레오 한쪽 채널 무음 (채널별 silencedetect 후 한쪽만 무음인 구간)
        ch = 0
        try:
            po = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0",
                                 "-show_entries", "stream=channels", "-of", "default=nw=1:nokey=1", local],
                                capture_output=True, text=True, timeout=60)
            ch = int((po.stdout or "0").strip() or 0)
        except Exception:
            ch = 0
        if ch >= 2:
            def ch_sil(cidx):
                o = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", local, "-vn", "-map", "0:a:0",
                                    "-af", "pan=mono|c0=c%d,silencedetect=noise=-50dB:d=%g" % (cidx, AUDIO_CH_MIN),
                                    "-f", "null", "-"], capture_output=True, text=True, timeout=1800)
                e2 = o.stderr or ""
                ss = [float(x) for x in re.findall(r"silence_start:\s*(-?\d+\.?\d*)", e2)]
                ee = [float(a) for a, b in
                      re.findall(r"silence_end:\s*(-?\d+\.?\d*)\s*\|\s*silence_duration:\s*(-?\d+\.?\d*)", e2)]
                segs = []
                for k, s0 in enumerate(ss):
                    e0 = ee[k] if k < len(ee) else (dur or s0)
                    segs.append((max(0, s0), e0))
                return segs

            def sub_ivals(a_list, b_list):
                out = []
                for a0, a1 in a_list:
                    cur = [(a0, a1)]
                    for b0, b1 in b_list:
                        nxt = []
                        for c0, c1 in cur:
                            if b1 <= c0 or b0 >= c1:
                                nxt.append((c0, c1)); continue
                            if b0 > c0: nxt.append((c0, b0))
                            if b1 < c1: nxt.append((b1, c1))
                        cur = nxt
                    out.extend(cur)
                return [(x, y) for x, y in out if y - x >= AUDIO_CH_MIN]

            L, R = ch_sil(0), ch_sil(1)
            for a, b in sub_ivals(L, R):
                issues.append({"type": "channel", "start": round(a, 1), "end": round(b, 1),
                               "detail": "왼쪽(L) 채널 무음 — 오른쪽만 출력"})
            for a, b in sub_ivals(R, L):
                issues.append({"type": "channel", "start": round(a, 1), "end": round(b, 1),
                               "detail": "오른쪽(R) 채널 무음 — 왼쪽만 출력"})
        # ── 영상 품질 점검 (규격 + 블랙/화이트 프레임) ──
        try:
            vissues, vstats = _analyze_video_local(local)
            issues.extend(vissues)
            stats.update(vstats)
        except Exception as e:
            log("영상 품질 점검 실패:", e)
        try:
            issues.extend(_analyze_contrast_local(local))
        except Exception as e:
            log("명도대비 점검 실패:", e)
        issues.sort(key=lambda x: x["start"])
        return issues, stats
    finally:
        if is_tmp:
            try: os.unlink(local)
            except Exception: pass


def _qc_basekey(nm):
    """품질 점검용 파일 기본키 — 리비전·(수정)·버전 표기를 제거해 같은 파트의 사본/수정본을 묶는다"""
    s = re.sub(r"\.[A-Za-z0-9]+$", "", nm or "")
    s = re.sub(r"(?i)re\s*\d+|v\d+(\.\d+)*|\(\d+\)|\(수정\)|수정본?|최종", "", s)
    return re.sub(r"\s+", "", s).lower()


def action_audio_check(fs, project_id, lesson_id=None, notify_user=None):
    b = load_project_bundle(project_id)
    if not b:
        return {"ok": False, "error": "project not found"}
    proj, enabled, lessons = b["proj"], b["enabled"], b["lessons"]
    root = proj.get("nas_root")
    if not root:
        return {"ok": False, "error": "nas_root 미설정 — 먼저 NAS 폴더 지정이 필요합니다"}
    mroot = re.match(r"^nas(\d+):(.*)$", root)
    if mroot:  # 다른 NAS: 차시 단위만 원격 점검(영상 다운로드 후 분석)
        if not lesson_id:
            return {"ok": False, "error": "다른 NAS(nasN:) 과정은 차시 단위 점검만 지원합니다 — 차시 상세의 '🔊 이 차시 품질 점검' 버튼을 사용하세요"}
        return _audio_check_remote(int(mroot.group(1)), mroot.group(2), b, lesson_id, notify_user)
    has_weeks = any(l.get("week_no") for l in lessons)
    st = next((s for s in enabled if s["id"] == LENGTH_STAGE_ID), None)
    folder = "%s/%s" % (root, st["nas_folder"]) if st else None
    targets = {}  # lesson_id -> {basekey: (mtime, path, name)} — 차시 내 "모든" 종편 파트(사본·수정본은 최신 1개)
    if folder and fs.exists(folder):
        for rel, mtime in fs.walkfiles(folder):
            base = rel.rsplit("/", 1)[-1]
            if ".cdms_" in rel:
                continue
            if base.startswith("~") or os.path.splitext(base)[1].lower() not in VIDEO_EXT:
                continue
            l = match_lesson(rel, lessons, has_weeks)
            if not l:
                continue
            if lesson_id and l["id"] != lesson_id:
                continue
            grp = targets.setdefault(l["id"], {})
            k = _qc_basekey(base)
            if k not in grp or mtime >= grp[k][0]:
                grp[k] = (mtime, "%s/%s" % (folder, rel), base)
    if not targets:
        return {"ok": False, "error": "종편 폴더에서 차시에 매칭되는 영상을 찾지 못했습니다"}
    checked, problems = 0, 0
    now = datetime.now(timezone.utc).isoformat()
    for lid, grp in targets.items():
        names = []
        exist = {}
        try:  # 증분 점검: 파일이 안 바뀌고 기준도 같으면 재분석 생략
            exist = {r0["file_name"]: r0 for r0 in (sb.table("audio_checks").select("file_name,file_mtime,qc_ver,status").eq("lesson_id", lid).execute().data or [])}
        except Exception:
            pass
        for (mt, path, name) in sorted(grp.values(), key=lambda x: x[2]):
            e0 = exist.get(name)
            if e0 and e0.get("file_mtime") == int(mt or 0) and e0.get("qc_ver") == QC_VER and e0.get("status") in ("ok", "warn", "bad"):
                names.append(name)
                checked += 1
                log("품질 점검(생략—변경 없음):", name)
                continue
            row = {"lesson_id": lid, "project_id": project_id, "file_name": name, "file_path": path,
                   "file_mtime": int(mt or 0), "qc_ver": QC_VER, "checked_at": now}
            try:
                issues, stats = _analyze_audio(fs, path)
                bad = any(i["type"] in ("silence", "clip", "no_audio", "channel") for i in issues)
                warn = any(i["type"] in ("loud", "quiet", "jump", "spec", "black", "white", "contrast") for i in issues)
                row.update({"duration_sec": stats.get("duration"), "mean_volume": stats.get("mean"),
                            "max_volume": stats.get("max"), "issues": issues,
                            "status": "bad" if bad else ("warn" if warn else "ok"), "error": None})
                problems += len(issues)
                checked += 1
            except Exception as e:
                row.update({"status": "error", "error": str(e), "issues": []})
            sb.table("audio_checks").upsert(row, on_conflict="lesson_id,file_name").execute()
            names.append(name)
            log("품질 점검:", name, row.get("status"))
        # 이번 점검 대상에 없는 파일의 예전 결과 정리(파일 교체·이름 변경 대응)
        try:
            old = sb.table("audio_checks").select("id,file_name").eq("lesson_id", lid).execute().data or []
            for o in old:
                if o.get("file_name") not in names:
                    sb.table("audio_checks").delete().eq("id", o["id"]).execute()
        except Exception:
            pass

    # 업로드 담당자 이메일 알림 (문제 발견 시)
    emailed = 0
    if notify_user and problems > 0 and EMAIL_ENABLED:
        try:
            u = sb.table("users").select("name,email").eq("id", notify_user).execute().data
            email = u and u[0].get("email")
            if email:
                TYPE_KR = {"silence": "무음", "clip": "클리핑", "loud": "과대음량", "quiet": "과소음량",
                           "no_audio": "오디오 없음", "jump": "음량 급변", "channel": "채널 무음"}
                lmap = {l["id"]: l for l in lessons}
                def mmss(v):
                    v = int(float(v or 0)); return "%d:%02d" % (v // 60, v % 60)
                res = sb.table("audio_checks").select("*").in_("lesson_id", list(targets.keys())).execute().data
                blocks = []
                for r0 in (res or []):
                    iss = r0.get("issues") or []
                    if not iss:
                        continue
                    l0 = lmap.get(r0["lesson_id"]) or {}
                    items = "".join(
                        "<li>%s ~ %s — <b>%s</b> · %s</li>" %
                        (mmss(i.get("start")), mmss(i.get("end")),
                         TYPE_KR.get(i.get("type"), i.get("type")), i.get("detail") or "")
                        for i in iss)
                    blocks.append("<p style='margin:12px 0 4px'><b>%s차시</b> %s · 파일: %s</p><ul style='margin:4px 0'>%s</ul>"
                                  % (l0.get("lesson_no", ""), l0.get("title") or "", r0.get("file_name") or "", items))
                if blocks:
                    html = ("<div style=\"font-family:Apple SD Gothic Neo,Malgun Gothic,sans-serif;font-size:14px;color:#222;line-height:1.6\">"
                            "<p>안녕하세요, CDMS 오디오 점검 알림입니다.</p>"
                            "<p>업로드하신 <b>%s</b> 종편 영상에서 <b>품질 문제 %d건</b>이 발견되었습니다.</p>" % (proj["name"], problems)
                            + "".join(blocks) +
                            "<p><a href=\"%s\" style=\"display:inline-block;background:#4b3fbb;color:#fff;text-decoration:none;padding:8px 16px;border-radius:8px\">CDMS에서 확인하기</a></p>" % CDMS_URL +
                            "<p style=\"color:#999;font-size:12px\">CDMS에서 해당 차시를 클릭하면 '🔊 품질 점검' 섹션에 문제 구간이 표시되며, 시간을 클릭하면 그 위치부터 재생됩니다.</p></div>")
                    send_email(email, "[CDMS] 품질 점검 결과 — %s 문제 %d건" % (proj["name"], problems), html)
                    emailed = 1
        except Exception as e:
            log("오디오 알림 메일 실패:", e)
    return {"ok": True, "checked": checked, "problems": problems, "emailed": emailed}


# ============================================================================
# action: scan_file — CDMS 업로드 파일 백신 검사(ClamAV) 후 최종 폴더로 이동
#   업로드는 .cdms_scan(검사 대기)에 저장됨 → 통과: dest로 이동 / 감염: .cdms_blocked 격리 + 메일
#   ClamAV 미설치 시 실패(fail-closed): 파일은 최종 폴더에 반영되지 않음
# ============================================================================
def _clam_run(localpath):
    """ClamAV 실행 → (rc, 탐지명, 오류문자열). 미설치 시 rc=None"""
    import shutil
    scanner = shutil.which("clamdscan") or shutil.which("clamscan")
    if not scanner:
        return None, "", "서버에 ClamAV가 없습니다. sudo apt-get install -y clamav clamav-daemon 후 재시도"
    args = [scanner, "--no-summary"]
    if scanner.endswith("clamdscan"):
        args.append("--fdpass")
    out = subprocess.run(args + [localpath], capture_output=True, text=True, timeout=3600)
    sig = ""
    for ln in (out.stdout or "").splitlines():
        if ": " in ln and not ln.rstrip().endswith("OK"):
            sig = ln.split(": ", 1)[1].strip()
            break
    return out.returncode, sig, (out.stderr or "")[:200]


def _blocked_email(name, sig, qpath, notify):
    if not EMAIL_ENABLED:
        return
    try:
        emails = []
        if notify:
            u = sb.table("users").select("email").eq("id", notify).execute().data
            if u and u[0].get("email"): emails.append(u[0]["email"])
        ad = sb.table("user_roles").select("user_id,users:user_id(email)").eq("role_code", "admin").execute().data
        for a in (ad or []):
            e = (a.get("users") or {}).get("email")
            if e: emails.append(e)
        html = ("<div style='font-family:Malgun Gothic,sans-serif;font-size:14px;line-height:1.6'>"
                "<p>CDMS로 업로드된 파일에서 <b>악성코드가 탐지되어 차단</b>되었습니다.</p>"
                "<p>파일: <b>%s</b><br>탐지명: %s<br>격리 위치: %s</p>"
                "<p>이 파일은 NAS 작업 폴더에 반영되지 않았습니다. 업로드한 PC의 백신 점검을 권장합니다.</p></div>"
                % (name, sig or "-", qpath))
        for em in sorted(set(emails)):
            send_email(em, "[CDMS] ⛔ 업로드 차단 — 악성코드 탐지: %s" % name, html)
    except Exception as e:
        log("차단 메일 실패:", e)


# ── 원격 NAS(nasN:) FileStation API 헬퍼 — NAS2 등 마운트 안 된 NAS의 검사용 ──
def _syno_api(base, path_, params, timeout=120):
    import urllib.request, urllib.parse
    url = base + path_ + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


def _syno_login2(cfg):
    base = (cfg.get("url") or "").rstrip("/")
    j = _syno_api(base, "/webapi/auth.cgi", {"api": "SYNO.API.Auth", "version": "6", "method": "login",
                                             "account": cfg.get("username") or "", "passwd": cfg.get("password") or "",
                                             "session": "FileStation", "format": "sid"})
    if not j.get("success"):
        raise RuntimeError("NAS 로그인 실패 code=%s" % ((j.get("error") or {}).get("code")))
    return base, j["data"]["sid"]


def _syno_ls(base, sid, folder):
    j = _syno_api(base, "/webapi/entry.cgi", {"api": "SYNO.FileStation.List", "version": "2", "method": "list",
                                              "folder_path": json.dumps(folder), "_sid": sid})
    return ((j.get("data") or {}).get("files")) or []


def _syno_download(base, sid, path, dst):
    import urllib.request, urllib.parse
    url = base + "/webapi/entry.cgi?" + urllib.parse.urlencode(
        {"api": "SYNO.FileStation.Download", "version": "2", "method": "download", "mode": "open",
         "path": path, "_sid": sid})
    with urllib.request.urlopen(url, timeout=3600) as r, open(dst, "wb") as f:
        while True:
            b = r.read(1024 * 1024)
            if not b: break
            f.write(b)


def _syno_move(base, sid, src, dest_folder):
    j = _syno_api(base, "/webapi/entry.cgi", {"api": "SYNO.FileStation.CopyMove", "version": "3", "method": "start",
                                              "path": json.dumps([src]), "dest_folder_path": json.dumps(dest_folder),
                                              "remove_src": "true", "_sid": sid})
    if not j.get("success"):
        raise RuntimeError("이동 시작 실패 code=%s" % ((j.get("error") or {}).get("code")))
    tid = j["data"]["taskid"]
    for _ in range(180):
        s = _syno_api(base, "/webapi/entry.cgi", {"api": "SYNO.FileStation.CopyMove", "version": "3",
                                                  "method": "status", "taskid": json.dumps(tid), "_sid": sid})
        if (s.get("data") or {}).get("finished"):
            return True
        time.sleep(1)
    raise RuntimeError("이동 시간 초과")


def _syno_rename(base, sid, path, newname):
    j = _syno_api(base, "/webapi/entry.cgi", {"api": "SYNO.FileStation.Rename", "version": "2", "method": "rename",
                                              "path": json.dumps([path]), "name": json.dumps([newname]), "_sid": sid})
    if not j.get("success"):
        raise RuntimeError("이름변경 실패 code=%s" % ((j.get("error") or {}).get("code")))


def _syno_mkdir(base, sid, parent, name):
    try:
        _syno_api(base, "/webapi/entry.cgi", {"api": "SYNO.FileStation.CreateFolder", "version": "2", "method": "create",
                                              "folder_path": json.dumps([parent]), "name": json.dumps([name]),
                                              "force_parent": "true", "_sid": sid})
    except Exception:
        pass


def _scan_file_remote(nid, path, dest, name, notify):
    rows = sb.table("nas_config").select("*").eq("id", nid).execute().data
    if not rows:
        return {"ok": False, "error": "nas_config(id=%s) 없음" % nid}
    base, sid = _syno_login2(rows[0])
    try:
        folder = path.rsplit("/", 1)[0]
        found = False
        for _ in range(20):
            if any(f.get("name") == name for f in _syno_ls(base, sid, folder)):
                found = True
                break
            time.sleep(3)
        if not found:
            return {"ok": False, "error": "검사 대상 파일을 찾지 못했습니다: nas%s:%s" % (nid, path)}
        tf = tempfile.NamedTemporaryFile(prefix="cdms_scan_", delete=False)
        tmp = tf.name
        tf.close()
        try:
            _syno_download(base, sid, path, tmp)
            rc, sig, err = _clam_run(tmp)
        finally:
            try: os.unlink(tmp)
            except Exception: pass
        if rc is None:
            return {"ok": False, "error": err}
        if rc == 0:
            names = {f.get("name") for f in _syno_ls(base, sid, dest)}
            b0, e0 = os.path.splitext(name)
            fname, n = name, 1
            while fname in names:
                n += 1
                fname = "%s(%d)%s" % (b0, n, e0)
            path2 = path
            if fname != name:
                _syno_rename(base, sid, path, fname)
                path2 = folder + "/" + fname
            _syno_move(base, sid, path2, dest)
            log("백신검사 통과(nas%s):" % nid, dest + "/" + fname)
            return {"ok": True, "clean": True, "moved": "nas%s:%s/%s" % (nid, dest, fname)}
        if rc == 1:
            stage = folder.rsplit("/", 1)[0]
            _syno_mkdir(base, sid, stage, ".cdms_blocked")
            qpath = "nas%s:%s/.cdms_blocked/%s" % (nid, stage, name)
            try: _syno_move(base, sid, path, stage + "/.cdms_blocked")
            except Exception: qpath = "nas%s:%s" % (nid, path)
            log("악성코드 차단(nas%s):" % nid, name, sig)
            _blocked_email(name, sig, qpath, notify)
            return {"ok": True, "clean": False, "virus": sig or "malware", "quarantine": qpath}
        return {"ok": False, "error": "검사 오류(rc=%s): %s" % (rc, err)}
    finally:
        try:
            _syno_api(base, "/webapi/auth.cgi", {"api": "SYNO.API.Auth", "version": "6", "method": "logout",
                                                 "session": "FileStation", "_sid": sid})
        except Exception:
            pass


class _RemoteFSLite:
    """원격 NAS 파일을 임시 다운로드해 fs.local_copy처럼 제공 (오디오 분석용)"""
    def __init__(self, base, sid):
        self.base, self.sid = base, sid
    def local_copy(self, path):
        tf = tempfile.NamedTemporaryFile(prefix="cdms_aud_", delete=False)
        tmp = tf.name
        tf.close()
        _syno_download(self.base, self.sid, path, tmp)
        return tmp, True


def _syno_walk(base, sid, folder, depth):
    out = []
    j = _syno_api(base, "/webapi/entry.cgi", {"api": "SYNO.FileStation.List", "version": "2", "method": "list",
                                              "folder_path": json.dumps(folder), "additional": json.dumps(["time"]),
                                              "_sid": sid})
    for f in ((j.get("data") or {}).get("files")) or []:
        nm = f.get("name") or ""
        if nm.startswith(".cdms_") or "#recycle" in nm.lower() or nm.lower() == "old":
            continue
        if f.get("isdir"):
            if depth > 0:
                out.extend(_syno_walk(base, sid, f["path"], depth - 1))
        else:
            mt = ((f.get("additional") or {}).get("time") or {}).get("mtime") or 0
            out.append((nm, f["path"], mt))
    return out


def _audio_check_remote(nid, root, bundle, lesson_id, notify):
    """다른 NAS(nasN:) 과정의 차시 단위 오디오 점검 — 영상을 내려받아 분석"""
    rows = sb.table("nas_config").select("*").eq("id", nid).execute().data
    if not rows:
        return {"ok": False, "error": "nas_config(id=%s) 없음" % nid}
    proj, enabled, lessons = bundle["proj"], bundle["enabled"], bundle["lessons"]
    has_weeks = any(l.get("week_no") for l in lessons)
    base, sid = _syno_login2(rows[0])
    try:
        dirs = [f for f in _syno_ls(base, sid, root) if f.get("isdir")]
        if not dirs:  # 폴더 자체가 없거나(408) 하위 폴더가 없음 — 경로 오류를 명확히 안내
            return {"ok": False, "error": "NAS에서 과정 폴더를 열 수 없습니다 — 과정의 NAS 폴더 경로를 확인하세요: nas%d:%s" % (nid, root)}
        st = next((s for s in enabled if s["id"] == LENGTH_STAGE_ID), None)
        want = (st.get("nas_folder") if st else "") or "종편"
        d7 = next((d for d in dirs if want in (d.get("name") or "") or "종편" in (d.get("name") or "")), None)
        if not d7:
            return {"ok": False, "error": "종편 폴더를 찾지 못했습니다"}
        matches = {}  # basekey -> (mtime, path, name) — 차시 내 모든 파트(사본·수정본은 최신 1개)
        for nm, pth, mt in _syno_walk(base, sid, d7["path"], 2):
            if os.path.splitext(nm)[1].lower() not in VIDEO_EXT:
                continue
            l = match_lesson(nm, lessons, has_weeks)
            if not l or l["id"] != lesson_id:
                continue
            k = _qc_basekey(nm)
            if k not in matches or mt >= matches[k][0]:
                matches[k] = (mt, pth, nm)
        if not matches:
            return {"ok": False, "error": "이 차시에 매칭되는 종편 영상을 찾지 못했습니다"}
        now = datetime.now(timezone.utc).isoformat()
        names, issues2 = [], []
        exist = {}
        try:  # 증분 점검: 파일이 안 바뀌고 기준도 같으면 재분석 생략 (원격은 다운로드 비용이 커서 효과 큼)
            exist = {r0["file_name"]: r0 for r0 in (sb.table("audio_checks").select("file_name,file_mtime,qc_ver,status").eq("lesson_id", lesson_id).execute().data or [])}
        except Exception:
            pass
        for (mt, pth, nm) in sorted(matches.values(), key=lambda x: x[2]):
            e0 = exist.get(nm)
            if e0 and e0.get("file_mtime") == int(mt or 0) and e0.get("qc_ver") == QC_VER and e0.get("status") in ("ok", "warn", "bad"):
                names.append(nm)
                log("품질 점검(생략—변경 없음, nas%s):" % nid, nm)
                continue
            row = {"lesson_id": lesson_id, "project_id": proj["id"], "file_name": nm,
                   "file_path": "nas%d:%s" % (nid, pth), "file_mtime": int(mt or 0), "qc_ver": QC_VER, "checked_at": now}
            try:
                issues, stats = _analyze_audio(_RemoteFSLite(base, sid), pth)
                bad = any(i["type"] in ("silence", "clip", "no_audio", "channel") for i in issues)
                warn = any(i["type"] in ("loud", "quiet", "jump", "spec", "black", "white", "contrast") for i in issues)
                row.update({"duration_sec": stats.get("duration"), "mean_volume": stats.get("mean"),
                            "max_volume": stats.get("max"), "issues": issues,
                            "status": "bad" if bad else ("warn" if warn else "ok"), "error": None})
                issues2.extend([dict(i, _file=nm) for i in issues])
            except Exception as e:
                row.update({"status": "error", "error": str(e), "issues": []})
            sb.table("audio_checks").upsert(row, on_conflict="lesson_id,file_name").execute()
            names.append(nm)
            log("품질 점검(nas%s):" % nid, nm, row.get("status"))
        try:  # 이번 점검 대상에 없는 파일의 예전 결과 정리
            old = sb.table("audio_checks").select("id,file_name").eq("lesson_id", lesson_id).execute().data or []
            for o in old:
                if o.get("file_name") not in names:
                    sb.table("audio_checks").delete().eq("id", o["id"]).execute()
        except Exception:
            pass
        nm = ", ".join(names)
        if notify and issues2 and EMAIL_ENABLED:
            try:
                u = sb.table("users").select("email").eq("id", notify).execute().data
                email = u and u[0].get("email")
                if email:
                    TYPE_KR = {"silence": "무음", "clip": "클리핑", "loud": "과대음량", "quiet": "과소음량",
                               "no_audio": "오디오 없음", "jump": "음량 급변", "channel": "채널 무음"}
                    def mmss(v):
                        v = int(float(v or 0)); return "%d:%02d" % (v // 60, v % 60)
                    items = "".join("<li>[%s] %s ~ %s — <b>%s</b> · %s</li>" %
                                    (i.get("_file") or "", mmss(i.get("start")), mmss(i.get("end")),
                                     TYPE_KR.get(i.get("type"), i.get("type")), i.get("detail") or "")
                                    for i in issues2)
                    html = ("<div style=\"font-family:Malgun Gothic,sans-serif;font-size:14px;line-height:1.6\">"
                            "<p>업로드하신 <b>%s</b> 종편 영상에서 <b>품질 문제 %d건</b>이 발견되었습니다.</p>"
                            "<p>파일: %s</p><ul>%s</ul>"
                            "<p>CDMS에서 해당 차시를 클릭하면 '🔊 품질 점검' 섹션에 문제 구간이 표시됩니다.</p></div>"
                            % (proj["name"], len(issues2), nm, items))
                    send_email(email, "[CDMS] 품질 점검 결과 — %s 문제 %d건" % (proj["name"], len(issues2)), html)
            except Exception as e:
                log("오디오 알림 메일 실패:", e)
        return {"ok": True, "checked": len(names), "problems": len(issues2)}
    finally:
        try:
            _syno_api(base, "/webapi/auth.cgi", {"api": "SYNO.API.Auth", "version": "6", "method": "logout",
                                                 "session": "FileStation", "_sid": sid})
        except Exception:
            pass


def action_scan_file(fs, params):
    import shutil
    p = params or {}
    path = p.get("path") or ""
    dest = p.get("dest") or ""
    name = p.get("name") or path.rsplit("/", 1)[-1]
    notify = p.get("notify_user")
    if not path or not dest:
        return {"ok": False, "error": "path/dest 필요"}
    m = re.match(r"^nas(\d+):(.*)$", path)
    if m:  # 다른 NAS(nasN:) — FileStation API로 원격 검사
        return _scan_file_remote(int(m.group(1)), m.group(2), re.sub(r"^nas\d+:", "", dest), name, notify)
    ok_exist = False
    for _ in range(20):  # 업로드 직후 파일 안착 대기 (최대 ~60초)
        if fs.exists(path):
            ok_exist = True
            break
        time.sleep(3)
    if not ok_exist:
        return {"ok": False, "error": "검사 대상 파일을 찾지 못했습니다: %s" % path}
    scanner = shutil.which("clamdscan") or shutil.which("clamscan")
    if not scanner:
        return {"ok": False, "error": "서버에 ClamAV가 없습니다. ai-agent에서: sudo apt-get install -y clamav clamav-daemon 후 재시도"}
    local, is_tmp = fs.local_copy(path)
    rc, sig, errtxt = 2, "", ""
    try:
        args = [scanner, "--no-summary"]
        if scanner.endswith("clamdscan"):
            args.append("--fdpass")
        out = subprocess.run(args + [local], capture_output=True, text=True, timeout=3600)
        rc = out.returncode
        errtxt = (out.stderr or "")[:200]
        for ln in (out.stdout or "").splitlines():
            if ": " in ln and not ln.rstrip().endswith("OK"):
                sig = ln.split(": ", 1)[1].strip()
                break
    finally:
        if is_tmp:
            try: os.unlink(local)
            except Exception: pass
    if rc == 0:  # 정상 → 최종 폴더로 이동 (겹치면 새 이름)
        base, ext = os.path.splitext(name)
        target = dest.rstrip("/") + "/" + name
        n = 1
        while fs.exists(target):
            n += 1
            target = dest.rstrip("/") + "/" + base + ("(%d)" % n) + ext
        fs.rename(path, target)
        log("백신검사 통과:", target)
        return {"ok": True, "clean": True, "moved": target}
    if rc == 1:  # 악성코드 → 격리 + 메일
        qdir = path.rsplit("/", 1)[0].rsplit("/", 1)[0] + "/.cdms_blocked"
        try: fs.makedirs(qdir)
        except Exception: pass
        qpath = qdir + "/" + name
        try: fs.rename(path, qpath)
        except Exception: qpath = path
        log("악성코드 차단:", name, sig)
        if EMAIL_ENABLED:
            try:
                emails = []
                if notify:
                    u = sb.table("users").select("email").eq("id", notify).execute().data
                    if u and u[0].get("email"): emails.append(u[0]["email"])
                ad = sb.table("user_roles").select("user_id,users:user_id(email)").eq("role_code", "admin").execute().data
                for a in (ad or []):
                    e = (a.get("users") or {}).get("email")
                    if e: emails.append(e)
                html = ("<div style='font-family:Malgun Gothic,sans-serif;font-size:14px;line-height:1.6'>"
                        "<p>CDMS로 업로드된 파일에서 <b>악성코드가 탐지되어 차단</b>되었습니다.</p>"
                        "<p>파일: <b>%s</b><br>탐지명: %s<br>격리 위치: %s</p>"
                        "<p>이 파일은 NAS 작업 폴더에 반영되지 않았습니다. 업로드한 PC의 백신 점검을 권장합니다.</p></div>"
                        % (name, sig or "-", qpath))
                for em in sorted(set(emails)):
                    send_email(em, "[CDMS] ⛔ 업로드 차단 — 악성코드 탐지: %s" % name, html)
            except Exception as e:
                log("차단 메일 실패:", e)
        return {"ok": True, "clean": False, "virus": sig or "malware", "quarantine": qpath}
    return {"ok": False, "error": "검사 오류(rc=%s): %s" % (rc, errtxt)}


# ============================================================================
# action: mkdir_tree / rename / sync_names / ping
# ============================================================================
def safe_name(s):
    return re.sub(r'[\\/:*?"<>|]+', "_", (s or "").strip()) or "untitled"


def action_mkdir_tree(fs, project, folders):
    root = project if (project or "").startswith("/") else safe_name(project)
    fs.makedirs(root)
    for f in folders or []:
        fs.makedirs("%s/%s" % (root, f))
    abs_root = root if os.path.isabs(root) else (
        os.path.join(NAS_BASE, root) if NAS_MODE == "mount" else r"\\%s\%s\%s" % (SMB_HOST, SMB_SHARE, root))
    return {"ok": True, "root": abs_root}


def action_rename_folder(fs, old, new):
    # new 가 절대경로면 그대로 사용, 아니면 old 의 부모 위치를 유지하고 마지막 segment만 교체
    if new and (new.startswith("/") or new.startswith("\\")):
        new_path = new
    else:
        nm = safe_name(new)
        sep = "\\" if (old and "\\" in old) else "/"
        parent = old[:old.rfind(sep)] if (old and sep in old) else ""
        new_path = (parent + sep + nm) if parent else nm
    if new_path != old and fs.exists(new_path):
        return {"ok": False, "error": "대상이 이미 존재해 덮어쓰지 않았습니다: " + new_path}
    fs.rename(old, new_path)
    return {"ok": True, "old": old, "new": new_path}


def action_sync_names(fs, project_id):
    """NAS의 과정 루트 하위 단계폴더명을 읽어 반환(검토용). 실제 반영은 신중히."""
    b = load_project_bundle(project_id)
    if not b:
        return {"ok": False, "error": "project not found"}
    root = b["proj"].get("nas_root")
    if not root or not fs.exists(root):
        return {"ok": False, "error": "nas_root 없음"}
    return {"ok": True, "folders": fs.listdirs(root)}


def action_ping(fs):
    return {"ok": True, "shares": fs.shares()}


# ============================================================================
# 강의계획서 파싱 (주차·차시 자동 추출/생성)
# ============================================================================
RE_WK = re.compile(r"(\d+)\s*주\s*차")
RE_LS = re.compile(r"(\d+)\s*차\s*시")


def _syllabus_text(path, data):
    """업로드된 강의계획서 바이트 → 텍스트 (형식별)."""
    import tempfile, subprocess, zipfile
    ext = os.path.splitext(path)[1].lower()
    with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tf:
        tf.write(data); tmp = tf.name
    try:
        if ext == ".hwp":
            # hwp5txt는 표 내용을 "<표>"로 건너뛰므로 hwp5html로 표(tr/td)까지 추출
            try:
                import re as _re, html as _html
                hb = os.path.join(os.path.dirname(sys.executable), "hwp5html")
                cmd = hb if os.path.exists(hb) else "hwp5html"
                out = subprocess.run([cmd, "--html", tmp], capture_output=True, timeout=120).stdout.decode("utf-8", "ignore")
                lines = []
                for tr in _re.findall(r"<tr[^>]*>([\s\S]*?)</tr>", out):
                    cells = [_re.sub(r"\s+", " ", _html.unescape(_re.sub(r"<[^>]+>", " ", td))).strip()
                             for td in _re.findall(r"<td[^>]*>([\s\S]*?)</td>", tr)]
                    cells = [c for c in cells if c]
                    if not cells:
                        continue
                    lines.append("\t".join(cells))
                    # 표 형식(첫 셀=숫자, 다음 셀=제목)을 차시 패턴 문장으로도 합성 → _parse_syllabus가 인식
                    if len(cells) >= 2 and _re.fullmatch(r"\d{1,2}", cells[0]):
                        title = cells[2] if (cells[1] in ("주제", "차시명", "주차명") and len(cells) >= 3) else cells[1]
                        if title and not _re.fullmatch(r"[\d\s.%]+", title):
                            lines.append("%s차시 %s" % (cells[0], title))
                # 본문 텍스트도 병행 추출(표 밖 차시 표기 대응)
                txt = _re.sub(r"<[^>]+>", " ", _re.sub(r"</p>", "\n", out))
                lines.append(_html.unescape(txt))
                return "\n".join(lines)
            except Exception:
                return ""
        if ext == ".hwpx":
            out = []
            with zipfile.ZipFile(tmp) as z:
                for n in z.namelist():
                    if n.startswith("Contents/") and n.endswith(".xml"):
                        out.append(re.sub(r"<[^>]+>", " ", z.read(n).decode("utf-8", "ignore")))
            return "\n".join(out)
        if ext == ".pdf":
            import pdfplumber
            with pdfplumber.open(tmp) as pdf:
                return "\n".join((pg.extract_text() or "") for pg in pdf.pages)
        if ext == ".docx":
            import docx
            d = docx.Document(tmp); parts = [p.text for p in d.paragraphs]
            for t in d.tables:
                for row in t.rows:
                    parts.append("\t".join(c.text for c in row.cells))
            return "\n".join(parts)
        if ext == ".pptx":
            from pptx import Presentation
            prs = Presentation(tmp); parts = []
            for s in prs.slides:
                for sh in s.shapes:
                    if sh.has_text_frame:
                        for para in sh.text_frame.paragraphs:
                            parts.append("".join(r.text for r in para.runs))
                    if getattr(sh, "has_table", False):
                        for row in sh.table.rows:
                            parts.append("\t".join(c.text for c in row.cells))
            return "\n".join(parts)
        if ext in (".xlsx", ".xls"):
            import openpyxl
            wb = openpyxl.load_workbook(tmp, read_only=True, data_only=True); parts = []
            for ws in wb.worksheets:
                for row in ws.iter_rows(values_only=True):
                    parts.append("\t".join("" if c is None else str(c) for c in row))
            return "\n".join(parts)
        if ext == ".csv":
            return data.decode("utf-8", "ignore")
        return data.decode("utf-8", "ignore")
    finally:
        try: os.unlink(tmp)
        except Exception: pass


def _parse_syllabus(text):
    lines = [re.sub(r"[ \t]+", " ", l).strip() for l in text.splitlines()]
    lines = [l for l in lines if l]
    weeks = {}; flat = []; cur = None
    strip = " :·.)·\t-"
    for ln in lines:
        wm = RE_WK.search(ln); lm = RE_LS.search(ln)
        if wm and not lm:
            wn = int(wm.group(1)); nm = RE_WK.sub("", ln).strip(strip)
            weeks.setdefault(wn, {"name": nm or None, "lessons": {}}); cur = wn; continue
        if lm:
            no = int(lm.group(1)); title = ln[lm.end():].strip(strip)
            if not title:
                title = RE_LS.sub("", ln).strip(strip)
            wmi = RE_WK.search(ln)
            if wmi:
                cur = int(wmi.group(1)); weeks.setdefault(cur, {"name": None, "lessons": {}})
            if cur is not None and weeks:
                weeks[cur]["lessons"][no] = title
            else:
                flat.append(title)
    return weeks, flat


def action_parse_syllabus(fs, project_id, path):
    if not (project_id and path):
        return {"ok": False, "error": "project_id/파일경로 없음"}
    try:
        data = sb.storage.from_("plans").download(path)
    except Exception as e:
        return {"ok": False, "error": "스토리지 다운로드 실패: " + str(e)[:120]}
    text = _syllabus_text(path, data)
    if not text or len(text.strip()) < 5:
        return {"ok": False, "error": "텍스트 추출 실패(형식 미지원/빈 파일). HWP는 hwp5txt(pyhwp) 필요."}
    weeks, flat = _parse_syllabus(text)
    pst = sb.table("project_stages").select("stage_id").eq("project_id", project_id).eq("enabled", True).execute().data
    stage_ids = [r["stage_id"] for r in pst] or [1, 2, 3, 5, 7, 9]
    # 기존 주차/차시 삭제 후 재생성
    sb.table("lessons").delete().eq("project_id", project_id).execute()
    sb.table("weeks").delete().eq("project_id", project_id).execute()
    n = 0
    if weeks:
        for wn in sorted(weeks):
            wid = sb.table("weeks").insert({"project_id": project_id, "week_no": wn, "name": weeks[wn]["name"]}).execute().data[0]["id"]
            lessons = weeks[wn]["lessons"] or {1: None}
            for no in sorted(lessons):
                lid = sb.table("lessons").insert({"project_id": project_id, "week_id": wid, "lesson_no": no, "title": lessons[no]}).execute().data[0]["id"]
                sb.table("lesson_stage").insert([{"lesson_id": lid, "stage_id": s, "status": "wait"} for s in stage_ids]).execute()
                n += 1
        sb.table("projects").update({"course_type": "credit", "unit_label": "주차"}).eq("id", project_id).execute()
        return {"ok": True, "type": "주차형", "weeks": len(weeks), "lessons": n}
    if not flat:
        return {"ok": False, "error": "주차/차시 구조를 찾지 못했습니다(파일 내용 확인)."}
    for i, t in enumerate(flat, 1):
        lid = sb.table("lessons").insert({"project_id": project_id, "lesson_no": i, "title": t}).execute().data[0]["id"]
        sb.table("lesson_stage").insert([{"lesson_id": lid, "stage_id": s, "status": "wait"} for s in stage_ids]).execute()
        n += 1
    sb.table("projects").update({"course_type": "lesson", "unit_label": "차시"}).eq("id", project_id).execute()
    return {"ok": True, "type": "차시형", "lessons": n}


# ============================================================================
# 영상검수: 종편 영상을 480p 프록시로 변환 → Supabase 스토리지 업로드
# ============================================================================
def action_make_review_proxy(fs, project_id, lesson_id):
    import tempfile, subprocess
    if not (project_id and lesson_id):
        return {"ok": False, "error": "project_id/lesson_id 없음"}
    b = load_project_bundle(project_id)
    if not b:
        return {"ok": False, "error": "project not found"}
    proj, lessons, enabled = b["proj"], b["lessons"], b["enabled"]
    root = proj.get("nas_root")
    if not root:
        return {"ok": False, "error": "nas_root 미설정"}
    lesson = next((l for l in lessons if l["id"] == lesson_id), None)
    if not lesson:
        return {"ok": False, "error": "lesson 없음"}
    has_weeks = any(l.get("week_no") for l in lessons)
    st = next((s for s in enabled if s["id"] == LENGTH_STAGE_ID), None)
    folder = "%s/%s" % (root, (st or {}).get("nas_folder", "07_종편"))
    target = None
    for rel, mt in fs.walkfiles(folder):
        if os.path.splitext(rel)[1].lower() not in VIDEO_EXT:
            continue
        l = match_lesson(rel, lessons, has_weeks)
        if l and l["id"] == lesson_id:
            target = "%s/%s" % (folder, rel)
            break
    if not target:
        return {"ok": False, "error": "이 차시의 종편 영상을 NAS에서 찾지 못했습니다."}
    # 시놀로지/외부 HTTPS 직접 서빙 모드 (변환·업로드 없이 공개 URL만 기록)
    if NAS_PUBLIC_BASE:
        import urllib.parse
        absf = fs._abs(target) if hasattr(fs, "_abs") else target
        try:
            relpub = os.path.relpath(absf, NAS_PUBLIC_ROOT)
        except Exception:
            relpub = target
        url = NAS_PUBLIC_BASE.rstrip("/") + "/" + urllib.parse.quote(relpub.replace("\\", "/"))
        cur = sb.table("lessons").select("review_ver").eq("id", lesson_id).execute().data
        ver = ((cur[0].get("review_ver") if cur else 0) or 0) + 1
        sb.table("lessons").update({"review_path": url, "review_ver": ver}).eq("id", lesson_id).execute()
        return {"ok": True, "url": url, "version": ver, "mode": "synology"}
    local, is_tmp = fs.local_copy(target)
    out = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4").name
    try:
        r = subprocess.run(["ffmpeg", "-y", "-i", local, "-vf", "scale=-2:480",
                            "-c:v", "libx264", "-crf", "30", "-preset", "veryfast",
                            "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out],
                           capture_output=True, timeout=900)
        if r.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
            return {"ok": False, "error": "ffmpeg 변환 실패"}
        cur = sb.table("lessons").select("review_ver").eq("id", lesson_id).execute().data
        ver = ((cur[0].get("review_ver") if cur else 0) or 0) + 1
        path = "%s/v%d.mp4" % (lesson_id, ver)
        with open(out, "rb") as f:
            data = f.read()
        try:
            sb.storage.from_("review").upload(path, data, {"content-type": "video/mp4", "upsert": "false"})  # 덮어쓰기 금지
        except Exception as e:
            return {"ok": False, "error": "업로드 실패: " + str(e)[:140]}
        sb.table("lessons").update({"review_path": path, "review_ver": ver}).eq("id", lesson_id).execute()
        return {"ok": True, "path": path, "version": ver, "size_mb": round(len(data) / 1e6, 1)}
    finally:
        for p in (out,):
            try: os.unlink(p)
            except Exception: pass
        if is_tmp:
            try: os.unlink(local)
            except Exception: pass


# ============================================================================
# 큐 처리
# ============================================================================
def action_make_preview(fs, project_id, path):
    """PSD·이미지 미리보기 생성 — 다운로드 없이 브라우저에서 확인 (previews 버킷에 JPG 캐시).

    PSD는 파일에 내장된 병합 이미지(composite)를 Pillow로 읽어 1600px JPG로 변환한다.
    포토샵 저장 시 '호환성 최대화'가 꺼진 PSD는 병합 이미지가 없어 실패할 수 있다.
    """
    import hashlib
    try:
        from PIL import Image
    except Exception:
        return {"ok": False, "error": "서버에 Pillow가 없습니다 (pip install pillow)"}
    path = str(path or "")
    if not path:
        return {"ok": False, "error": "path 필요"}
    ext = os.path.splitext(path)[1].lower()
    if ext not in (".psd", ".psb", ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tif", ".tiff"):
        return {"ok": False, "error": "미리보기 미지원 형식: %s" % ext}
    key = hashlib.sha256(path.encode("utf-8")).hexdigest()  # 프런트와 동일 규칙(SubtleCrypto SHA-256)
    dest = "psd/%s.jpg" % key
    pub = "%s/storage/v1/object/public/previews/%s" % (SB_URL, dest)
    try:  # 캐시 — 같은 경로는 재생성하지 않음
        ex = sb.storage.from_("previews").list("psd", {"search": key})
        if any((it.get("name") == "%s.jpg" % key) for it in (ex or [])):
            return {"ok": True, "url": pub, "cached": True}
    except Exception:
        pass
    m = re.match(r"^nas(\d+):(.*)$", path)
    local, is_tmp = None, False
    try:
        if m:  # 다른 NAS(nasN:) — FileStation API로 내려받아 변환
            rows = sb.table("nas_config").select("*").eq("id", int(m.group(1))).execute().data
            if not rows:
                return {"ok": False, "error": "nas_config(id=%s) 없음" % m.group(1)}
            base, sid = _syno_login2(rows[0])
            tf = tempfile.NamedTemporaryFile(prefix="cdms_pv_", delete=False)
            local, is_tmp = tf.name, True
            tf.close()
            _syno_download(base, sid, m.group(2), local)
        else:
            local, is_tmp = fs.local_copy(path)
        im = Image.open(local)
        im.load()
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        im.thumbnail((1600, 1600))
        out = tempfile.NamedTemporaryFile(prefix="cdms_pv_out_", suffix=".jpg", delete=False)
        outp = out.name
        out.close()
        im.save(outp, "JPEG", quality=82)
        with open(outp, "rb") as fjpg:
            data = fjpg.read()
        try:
            os.unlink(outp)
        except Exception:
            pass
    except Exception as e:
        return {"ok": False, "error": "이미지 해석 실패 — 포토샵 '호환성 최대화' 없이 저장된 PSD일 수 있습니다: %s" % e}
    finally:
        if is_tmp and local:
            try:
                os.unlink(local)
            except Exception:
                pass
    try:
        sb.storage.from_("previews").upload(dest, data, {"content-type": "image/jpeg", "upsert": "true"})
    except Exception as e:
        es = str(e).lower()
        if "exist" not in es and "duplicate" not in es:
            return {"ok": False, "error": "미리보기 업로드 실패: %s" % e}
    return {"ok": True, "url": pub}


def dispatch(fs, task):
    action = task["action"]
    p = task.get("params") or {}
    pid = task.get("project_id") or p.get("project_id")
    if action == "ping":
        return action_ping(fs)
    if action == "mkdir_tree":
        return action_mkdir_tree(fs, p.get("project"), p.get("folders"))
    if action == "scan_progress":
        return action_scan_progress(fs, pid)
    if action == "probe_durations":
        return action_probe_durations(fs, pid)
    if action == "audio_check":
        return action_audio_check(fs, pid, p.get("lesson_id"), p.get("notify_user"))
    if action == "scan_file":
        return action_scan_file(fs, p)
    if action == "rename_folder":
        return action_rename_folder(fs, p.get("old"), p.get("new"))
    if action == "sync_names":
        return action_sync_names(fs, pid)
    if action == "parse_syllabus":
        return action_parse_syllabus(fs, pid, p.get("path"))
    if action == "make_review_proxy":
        return action_make_review_proxy(fs, pid, p.get("lesson_id"))
    if action == "make_preview":
        return action_make_preview(fs, pid, p.get("path"))
    return {"ok": False, "error": "unknown action: %s" % action}


def process_queue(fs):
    stale = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()
    rows = sb.table("nas_tasks").select("*").or_(
        "status.is.null,status.eq.pending,and(status.eq.running,updated_at.lt.%s)" % stale).order(
        "created_at").limit(10).execute().data
    for t in rows:
        log("작업 처리:", t["action"], t.get("project_id") or "")
        try:  # 처리 시작 표시 — 프런트에서 대기/진행 구분, 중단 시 3시간 후 자동 재시도
            sb.table("nas_tasks").update({"status": "running", "updated_at": datetime.now(timezone.utc).isoformat()}).eq("id", t["id"]).execute()
        except Exception:
            pass
        try:
            res = dispatch(fs, t)
        except Exception as e:
            res = {"ok": False, "error": str(e)}
            traceback.print_exc()
        status = "done" if res.get("ok") else "error"
        sb.table("nas_tasks").update(
            {"status": status, "result": res,
             "updated_at": datetime.now(timezone.utc).isoformat()}).eq("id", t["id"]).execute()


def auto_scan(fs):
    projs = sb.table("projects").select("id,name,nas_root").execute().data
    for p in projs:
        if not p.get("nas_root"):
            continue
        try:
            r = action_scan_progress(fs, p["id"])
            log("자동스캔:", p["name"], r)
        except Exception as e:
            log("자동스캔 실패:", p["name"], e)


def check_contract_reminders():
    """계약 완료일 30/14/7일 전 → PM(또는 폴백 관리자)에게 안내메일. 하루 1회."""
    if not EMAIL_ENABLED:
        return 0
    from datetime import date
    today = date.today()
    try:
        progs = sb.table("programs").select("id,name,contract_end,pm_id").not_.is_("contract_end", "null").execute().data
    except Exception as e:
        log("계약만료 점검 실패:", e); return 0
    users = {u["id"]: u for u in sb.table("users").select("id,name,email").execute().data}
    done = set((r["ref"], r["label"]) for r in sb.table("reminders").select("ref,label").eq("kind", "contract_expiry").execute().data)
    sent = 0
    for p in progs:
        try:
            ce = datetime.fromisoformat(str(p["contract_end"])).date()
        except Exception:
            continue
        days = (ce - today).days
        for th, label in ((30, "d30"), (14, "d14"), (7, "d7")):
            if days != th or (p["id"], label) in done:
                continue
            u = users.get(p.get("pm_id")) if p.get("pm_id") else None
            to = (u or {}).get("email") or ""
            if (not to) or ("mirim.local" in to) or ("mirimcms.local" in to):
                to = REMIND_EMAIL
            subj = "[CDMS] 계약 만료 D-%d · %s" % (th, p["name"])
            html = ("<div style='font-family:sans-serif;font-size:14px'><p><b>%s</b> 사업의 계약 완료일이 "
                    "<b>%s</b> 입니다 (D-%d).</p><p>진행 현황: <a href='%s'>%s</a></p>"
                    "<p style='color:#888;font-size:12px'>— CDMS 자동알림</p></div>") % (
                    p["name"], ce.isoformat(), th, CDMS_URL, CDMS_URL)
            ok, err = send_email(to, subj, html)
            try:
                sb.table("reminders").insert({"kind": "contract_expiry", "ref": p["id"], "label": label,
                                              "to_email": to, "status": "sent" if ok else "error", "error": err}).execute()
            except Exception as e:
                log("reminders 기록 실패:", e)
            if ok:
                sent += 1
            else:
                log("계약만료 메일 실패:", p["name"], to, err)
    return sent


def selfcheck():
    """설치 시 연결 자가진단. 모두 통과하면 exit 0, 하나라도 실패하면 exit 1."""
    import shutil
    ok = True
    # 1) ffprobe
    if shutil.which("ffprobe"):
        print("  [PASS] ffprobe 설치됨")
    else:
        print("  [FAIL] ffprobe 없음 — sudo apt-get install -y ffmpeg"); ok = False
    # 2) Supabase (service_role)
    try:
        n = sb.table("stages").select("id", count="exact").limit(1).execute()
        print("  [PASS] Supabase 연결 OK (stages 접근)")
    except Exception as e:
        print("  [FAIL] Supabase 연결 실패:", str(e)[:160]); ok = False
    # 3) NAS
    try:
        fs = build_fs()
        if NAS_MODE == "smb":
            sh = fs.shares()
            print("  [PASS] NAS(SMB) 접근 OK:", (sh[0] if sh else ""))
        else:
            if os.path.isdir(NAS_BASE):
                print("  [PASS] NAS 마운트 경로 OK:", NAS_BASE)
            else:
                print("  [FAIL] NAS_BASE 경로 없음:", NAS_BASE, "(마운트 확인)"); ok = False
    except Exception as e:
        print("  [FAIL] NAS 접근 실패:", str(e)[:160]); ok = False
    # 4) 이메일
    if EMAIL_ENABLED:
        if EMAIL_PROVIDER == "smtp":
            if SMTP_USER and SMTP_PASS:
                print("  [PASS] 이메일 SMTP 설정됨 (%s:%d, %s)" % (SMTP_HOST, SMTP_PORT, SMTP_USER))
            else:
                print("  [WARN] EMAIL_PROVIDER=smtp 인데 SMTP_USER/SMTP_PASS 비어있음 — 메일 미발송")
        elif EMAIL_API_KEY:
            print("  [PASS] 이메일 키 설정됨 (provider=%s)" % EMAIL_PROVIDER)
        else:
            print("  [WARN] EMAIL_ENABLED=true 인데 EMAIL_API_KEY 비어있음 — 메일 미발송")
    else:
        print("  [INFO] 이메일 비활성(EMAIL_ENABLED=false)")
    return ok


def main():
    log("CDMS NAS Worker 시작 — mode=%s base=%s 종편단계=%d" % (NAS_MODE, NAS_BASE, LENGTH_STAGE_ID))
    fs = build_fs()
    last_scan = 0
    last_remind = None
    while True:
        try:
            process_queue(fs)
            if SCAN_INTERVAL > 0 and (time.time() - last_scan) >= SCAN_INTERVAL:
                auto_scan(fs)
                last_scan = time.time()
            today = datetime.now().strftime("%Y-%m-%d")
            if last_remind != today:
                n = check_contract_reminders()
                if n:
                    log("계약만료 알림 발송:", n)
                last_remind = today
        except Exception as e:
            log("루프 오류:", e)
            traceback.print_exc()
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "selfcheck":
        print("== CDMS NAS Worker 자가진단 ==")
        sys.exit(0 if selfcheck() else 1)
    elif cmd == "scan-once":
        fs = build_fs()
        target = sys.argv[2] if len(sys.argv) > 2 else None
        if target:
            print(json.dumps(action_scan_progress(fs, target), ensure_ascii=False, indent=2))
        else:
            auto_scan(fs)
    else:
        main()
