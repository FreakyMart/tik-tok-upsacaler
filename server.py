#!/usr/bin/env python3
"""Explainer Studio local server (Python standard library only).

Serves the editor, media and projects, saves edits made in the browser, and pushes
live updates to the editor whenever a project.json changes on disk, so edits made
by an AI agent (or by hand in a code editor) appear instantly.

    python server.py            # http://localhost:4100
"""
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
PROJECTS = ROOT / "projects"
MEDIA = ROOT / "media"
EXPORTS = ROOT / "exports"
NAME_RE = re.compile(r"^[\w\-؀-ۿ]+$")
MEDIA_EXT = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image", ".svg": "image",
    ".mp4": "video", ".webm": "video", ".mov": "video", ".m4v": "video",
    ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".ogg": "audio", ".aac": "audio",
}
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("font/woff2", ".woff2")

RENDER = {"status": "idle", "project": None, "frame": 0, "total": 0, "file": None, "error": None, "started": 0}
RENDER_LOCK = threading.Lock()


def project_file(name):
    if not NAME_RE.match(name or ""):
        return None
    return PROJECTS / name / "project.json"


def list_media(project=None):
    out = []
    roots = [(MEDIA, "media/")]
    if project and NAME_RE.match(project):
        roots.append((PROJECTS / project, ""))
    for base, prefix in roots:
        if not base.exists():
            continue
        for p in sorted(base.rglob("*")):
            kind = MEDIA_EXT.get(p.suffix.lower())
            if kind and p.is_file():
                rel = p.relative_to(base).as_posix()
                out.append({"src": prefix + rel, "url": "/" + p.relative_to(ROOT).as_posix(), "kind": kind,
                            "name": p.name, "size": p.stat().st_size})
    return out


def run_render(name, port, args):
    """Run `studio.py render` in a subprocess and track its progress."""
    cmd = [sys.executable, str(ROOT / "studio.py"), "render", name, "--server", f"http://127.0.0.1:{port}", *args]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=ROOT)
        log = []
        for line in proc.stdout:
            line = line.strip()
            m = re.match(r"PROGRESS (\d+)/(\d+)", line)
            if m:
                RENDER.update(frame=int(m.group(1)), total=int(m.group(2)))
            elif line.startswith("OUTPUT "):
                RENDER["file"] = line[7:]
            elif line:
                log.append(line)
        proc.wait()
        if proc.returncode == 0:
            RENDER.update(status="done")
        else:
            RENDER.update(status="error", error="\n".join(log[-15:]))
    except Exception as e:  # noqa: BLE001
        RENDER.update(status="error", error=str(e))


class Handler(SimpleHTTPRequestHandler):
    server_version = "ExplainerStudio/1.0"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        if os.environ.get("STUDIO_VERBOSE"):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # -------------------------------------------------------------- helpers
    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    # -------------------------------------------------------------- routes
    def do_GET(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        q = parse_qs(url.query)
        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/editor/")
            self.end_headers()
            return
        if path == "/api/projects":
            items = []
            for f in sorted(PROJECTS.glob("*/project.json")):
                try:
                    title = json.loads(f.read_text("utf-8")).get("title", f.parent.name)
                except Exception:  # noqa: BLE001
                    title = f.parent.name
                items.append({"name": f.parent.name, "title": title, "mtime": f.stat().st_mtime})
            return self.send_json(items)
        if path.startswith("/api/project/"):
            f = project_file(path.split("/")[3])
            if not f or not f.exists():
                return self.send_json({"error": "not found"}, 404)
            body = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/media":
            return self.send_json(list_media((q.get("project") or [None])[0]))
        if path == "/api/render":
            return self.send_json(RENDER)
        if path == "/api/events":
            return self.events((q.get("project") or [""])[0])
        if path.startswith("/media/") or path.startswith("/projects/") or path.startswith("/exports/"):
            return self.send_ranged(path)
        return super().do_GET()

    def do_PUT(self):
        path = unquote(urlparse(self.path).path)
        if path.startswith("/api/project/"):
            f = project_file(path.split("/")[3])
            if not f:
                return self.send_json({"error": "bad name"}, 400)
            try:
                data = json.loads(self.read_body())
            except ValueError as e:
                return self.send_json({"error": f"invalid JSON: {e}"}, 400)
            f.parent.mkdir(parents=True, exist_ok=True)
            tmp = f.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")
            os.replace(tmp, f)
            return self.send_json({"ok": True, "mtime": f.stat().st_mtime})
        self.send_error(404)

    def do_POST(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        q = parse_qs(url.query)
        if path == "/api/upload":
            name = Path((q.get("name") or ["file"])[0]).name
            if Path(name).suffix.lower() not in MEDIA_EXT:
                return self.send_json({"error": "unsupported file type"}, 400)
            MEDIA.mkdir(exist_ok=True)
            dest = MEDIA / name
            i = 1
            while dest.exists():
                dest = MEDIA / f"{Path(name).stem}-{i}{Path(name).suffix}"
                i += 1
            dest.write_bytes(self.read_body())
            return self.send_json({"src": f"media/{dest.name}"})
        if path == "/api/projects":
            data = json.loads(self.read_body() or b"{}")
            name = data.get("name", "")
            f = project_file(name)
            if not f:
                return self.send_json({"error": "bad name"}, 400)
            if f.exists():
                return self.send_json({"error": "exists"}, 409)
            subprocess.run([sys.executable, str(ROOT / "studio.py"), "new", name], cwd=ROOT, check=False)
            return self.send_json({"ok": True, "name": name})
        if path.startswith("/api/render/"):
            name = path.split("/")[3]
            if not project_file(name):
                return self.send_json({"error": "bad name"}, 400)
            with RENDER_LOCK:
                if RENDER["status"] == "running":
                    return self.send_json({"error": "a render is already running"}, 409)
                opts = json.loads(self.read_body() or b"{}")
                args = []
                if opts.get("scale"):
                    args += ["--scale", str(opts["scale"])]
                if opts.get("fps"):
                    args += ["--fps", str(opts["fps"])]
                RENDER.update(status="running", project=name, frame=0, total=0, file=None, error=None, started=time.time())
                threading.Thread(target=run_render, args=(name, self.server.server_port, args), daemon=True).start()
            return self.send_json({"ok": True})
        self.send_error(404)

    # -------------------------------------------------------------- live updates
    def events(self, name):
        """Server-sent events: `change` when project.json changes, `render` for export progress."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        f = project_file(name)
        last_m = f.stat().st_mtime if f and f.exists() else 0
        last_r = None
        last_beat = time.time()
        try:
            while True:
                msgs = []
                if f and f.exists():
                    m = f.stat().st_mtime
                    if m != last_m:
                        last_m = m
                        msgs.append(("change", {"mtime": m}))
                r = json.dumps(RENDER)
                if r != last_r:
                    last_r = r
                    msgs.append(("render", RENDER))
                if time.time() - last_beat > 15:
                    self.wfile.write(b": ping\n\n")
                    last_beat = time.time()
                for ev, data in msgs:
                    self.wfile.write(f"event: {ev}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode())
                self.wfile.flush()
                time.sleep(0.2)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def send_ranged(self, path):
        """Static files with HTTP Range support (needed for video seeking)."""
        fp = (ROOT / path.lstrip("/")).resolve()
        if ROOT not in fp.parents or not fp.is_file():
            return self.send_error(404)
        size = fp.stat().st_size
        ctype = mimetypes.guess_type(fp.name)[0] or "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        status = HTTPStatus.OK
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                else:
                    start = max(0, size - int(m.group(2)))
                end = min(end, size - 1)
                status = HTTPStatus.PARTIAL_CONTENT
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with open(fp, "rb") as fh:
                fh.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = fh.read(min(1 << 16, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def start(port=4100, quiet=False):
    for d in (PROJECTS, MEDIA, EXPORTS):
        d.mkdir(exist_ok=True)
    httpd = Server(("127.0.0.1", port), Handler)
    if not quiet:
        print(f"Explainer Studio → http://localhost:{httpd.server_port}/editor/")
        if not shutil.which("ffmpeg"):
            print("warning: ffmpeg not found on PATH — MP4 export will not work")
    return httpd


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Explainer Studio server")
    ap.add_argument("--port", type=int, default=4100)
    a = ap.parse_args()
    srv = start(a.port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
