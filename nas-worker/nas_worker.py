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
from datetime import datetime, timezone

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
    if not m:
        return None
    lesson_no = int(m.group(1))
    wk = RE_WEEK.search(filename)
    if has_weeks and wk:
        week_no = int(wk.group(1))
        for l in lessons:
            if l["lesson_no"] == lesson_no and l.get("week_no") == week_no:
                return l
    # 주차 정보가 없으면 lesson_no 로만 매칭 (차시형 과정)
    cands = [l for l in lessons if l["lesson_no"] == lesson_no]
    if len(cands) == 1:
        return cands[0]
    return None


# ============================================================================
# action: scan_progress
# ============================================================================
def action_scan_progress(fs, project_id, do_duration=True):
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
            if base.startswith("~"):
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
    return action_scan_progress(fs, project_id, do_duration=True)


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
            try:
                hb = os.path.join(os.path.dirname(sys.executable), "hwp5txt")
                cmd = hb if os.path.exists(hb) else "hwp5txt"
                return subprocess.run([cmd, tmp], capture_output=True, text=True, timeout=60).stdout or ""
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
    if action == "rename_folder":
        return action_rename_folder(fs, p.get("old"), p.get("new"))
    if action == "sync_names":
        return action_sync_names(fs, pid)
    if action == "parse_syllabus":
        return action_parse_syllabus(fs, pid, p.get("path"))
    if action == "make_review_proxy":
        return action_make_review_proxy(fs, pid, p.get("lesson_id"))
    return {"ok": False, "error": "unknown action: %s" % action}


def process_queue(fs):
    rows = sb.table("nas_tasks").select("*").or_("status.is.null,status.eq.pending").order(
        "created_at").limit(10).execute().data
    for t in rows:
        log("작업 처리:", t["action"], t.get("project_id") or "")
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
