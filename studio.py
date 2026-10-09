#!/usr/bin/env python3
"""Explainer Studio command line — the AI's hands.

    python studio.py serve                     start the editor at http://localhost:4100
    python studio.py new NAME                  create projects/NAME/project.json
    python studio.py catalog                   list templates, animations, transitions, themes...
    python studio.py info NAME                 print the timeline (start/end of every scene)
    python studio.py validate NAME             check a project for mistakes
    python studio.py snapshot NAME 3.5 [...]   PNG frame(s) at the given seconds
    python studio.py sheet NAME                contact sheet: one image showing every scene
    python studio.py render NAME               export MP4 (Playwright + ffmpeg)
"""
import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENGINE = ROOT / "editor" / "engine"
PROJECTS = ROOT / "projects"
EXPORTS = ROOT / "exports"


# --------------------------------------------------------------------------- catalog
# Parsed straight from the engine sources so the CLI never drifts from the renderer.

def _js(name):
    return (ENGINE / name).read_text("utf-8")


def catalog():
    anim = _js("anim.js")
    arr = lambda src, var: re.findall(r"'(\w+)'", re.search(rf"export const {var} = \[(.*?)\];", src, re.S).group(1))
    tpl_src = _js("templates.js")
    templates = {}
    for m in re.finditer(r"^  (\w+): \{ label: '([^']*)', props: \{([^}]*)\}", tpl_src, re.M):
        templates[m.group(1)] = {"label": m.group(2), "props": dict(re.findall(r"(\w+): '([^']*)'", m.group(3)))}
    trans_src = _js("transitions.js")
    alias_block = re.search(r"export const ALIASES = \{(.*?)\n\};", trans_src, re.S).group(1)
    aliases = re.findall(r"^\s+(\w+): ", alias_block, re.M)
    shaders = []
    lib = ROOT / "editor" / "lib" / "gl-transitions.json"
    for t in json.loads(lib.read_text("utf-8")):
        if not any(str(v).startswith("sampler") for v in (t.get("paramsTypes") or {}).values()):
            shaders.append({"name": t["name"], "params": t.get("defaultParams") or {}})
    themes = re.findall(r"^  (\w+): \{\n    label:", _js("themes.js"), re.M)
    return {
        "layerTypes": arr(_js("layers.js"), "LAYER_TYPES"),
        "shapes": arr(_js("layers.js"), "SHAPES"),
        "animations": arr(anim, "ANIMATIONS"),
        "loops": arr(anim, "LOOPS"),
        "easings": re.findall(r"^  (\w+): ", re.search(r"export const EASINGS = \{(.*?)\n\};", anim, re.S).group(1), re.M),
        "templates": templates,
        "themes": themes,
        "colorTokens": ["bg", "surface", "ink", "muted", "accent", "accent2", "accent3", "line"],
        "fonts": ["display", "body", "Cairo", "Tajawal"],
        "transitions": {"aliases": aliases, "shaders": shaders},
    }


# --------------------------------------------------------------------------- project io

def load_project(name):
    f = PROJECTS / name / "project.json"
    if not f.exists():
        sys.exit(f"error: {f.relative_to(ROOT)} not found")
    try:
        return json.loads(f.read_text("utf-8"))
    except json.JSONDecodeError as e:
        sys.exit(f"error: project.json is not valid JSON: {e}")


def media_path(name, src):
    if re.match(r"^(https?:|data:)", src):
        return None
    if src.startswith("media/") or src.startswith("/"):
        return ROOT / src.lstrip("/")
    return PROJECTS / name / src


def transition_known(spec, cat):
    t = spec if isinstance(spec, str) else (spec or {}).get("type")
    if not t or t in ("none", "cut"):
        return True
    names = {a.lower() for a in cat["transitions"]["aliases"]} | {s["name"].lower() for s in cat["transitions"]["shaders"]}
    return t.lower() in names


def timeline(p, cat):
    items, t = [], 0.0
    scenes = p.get("scenes") or []
    for i, sc in enumerate(scenes):
        dur = max(0.1, float(sc.get("duration") or 5))
        tin = 0.0
        if i:
            prev = items[-1]
            spec = prev["scene"].get("transition", p.get("defaultTransition"))
            ty = spec if isinstance(spec, str) else (spec or {}).get("type")
            if ty and ty not in ("none", "cut") and transition_known(spec, cat):
                d = float(spec.get("duration", 0.8)) if isinstance(spec, dict) else 0.8
                tin = min(d, prev["dur"] * 0.5, dur * 0.5)
                t -= tin
        items.append({"scene": sc, "start": t, "end": t + dur, "dur": dur, "tin": tin})
        t += dur
    return items, t


# --------------------------------------------------------------------------- commands

def cmd_new(a):
    d = PROJECTS / a.name
    if (d / "project.json").exists():
        sys.exit(f"error: project {a.name} already exists")
    d.mkdir(parents=True, exist_ok=True)
    proj = {
        "version": 1,
        "title": a.title or a.name,
        "width": 1080 if a.shorts else 1920,
        "height": 1920 if a.shorts else 1080,
        "fps": 30,
        "theme": a.theme,
        "defaultTransition": {"type": "slide", "duration": 0.7},
        "audio": [],
        "scenes": [
            {"id": "intro", "duration": 5, "template": "title",
             "props": {"kicker": "الحلقة 1", "title": a.title or "عنوان الفيديو", "subtitle": "سطر تعريفي قصير"},
             "camera": {"from": {"zoom": 1}, "to": {"zoom": 1.06}}},
            {"id": "point1", "duration": 6, "template": "list",
             "props": {"title": "أهم النقاط", "items": ["النقطة الأولى", "النقطة الثانية", "النقطة الثالثة"]}},
            {"id": "outro", "duration": 4, "template": "outro",
             "props": {"title": "شكراً للمشاهدة", "subtitle": "لا تنسى الاشتراك", "cta": "اشترك 🔔"}},
        ],
    }
    (d / "project.json").write_text(json.dumps(proj, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(f"created {(d / 'project.json').relative_to(ROOT)}")


def cmd_catalog(a):
    cat = catalog()
    if not a.full:
        cat["transitions"]["shaders"] = [s["name"] for s in cat["transitions"]["shaders"]]
    print(json.dumps(cat, ensure_ascii=False, indent=2))


def cmd_info(a):
    p = load_project(a.name)
    items, total = timeline(p, catalog())
    print(f"{p.get('title', a.name)} — {p.get('width', 1920)}x{p.get('height', 1080)} @ {p.get('fps', 30)}fps — {total:.2f}s")
    for i, it in enumerate(items):
        sc = it["scene"]
        tr = sc.get("transition", p.get("defaultTransition"))
        trs = (tr if isinstance(tr, str) else (tr or {}).get("type")) if i < len(items) - 1 else None
        n = len(sc.get("layers") or [])
        print(f"  {i + 1:>2}. {sc.get('id', '?'):<16} {it['start']:7.2f} → {it['end']:7.2f}  ({it['dur']:.2f}s)"
              f"  {sc.get('template') or 'custom':<10} layers:{n:<3} {'→ ' + trs if trs else ''}")


def validate(name, p):
    cat = catalog()
    errors, warns = [], []
    E = errors.append
    Wn = warns.append
    W, H = p.get("width", 1920), p.get("height", 1080)
    if not isinstance(W, int) or not isinstance(H, int) or W < 64 or H < 64:
        E("width/height must be integers ≥ 64")
    if not 1 <= p.get("fps", 30) <= 120:
        E("fps must be between 1 and 120")
    if p.get("theme", "psych") not in cat["themes"]:
        E(f"unknown theme '{p.get('theme')}' (use one of {cat['themes']})")
    if p.get("defaultTransition") and not transition_known(p["defaultTransition"], cat):
        E(f"unknown defaultTransition {p['defaultTransition']}")
    scenes = p.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        E("project needs a non-empty 'scenes' array")
        scenes = []
    anims = set(cat["animations"])
    seen = set()

    def check_src(where, src):
        if not src:
            E(f"{where}: missing 'src'")
            return
        mp = media_path(name, src)
        if mp is not None and not mp.exists():
            E(f"{where}: file not found: {src}")

    for i, sc in enumerate(scenes):
        sid = sc.get("id")
        where = f"scenes[{i}]" + (f" ({sid})" if sid else "")
        if not sid:
            E(f"{where}: missing 'id'")
        elif sid in seen:
            E(f"{where}: duplicate scene id '{sid}'")
        seen.add(sid)
        dur = sc.get("duration")
        if not isinstance(dur, (int, float)) or dur <= 0:
            E(f"{where}: 'duration' must be a positive number (seconds)")
            dur = 5
        tpl = sc.get("template")
        if tpl and tpl not in cat["templates"]:
            E(f"{where}: unknown template '{tpl}' (use one of {list(cat['templates'])})")
        if tpl in cat["templates"]:
            known = cat["templates"][tpl]["props"]
            for k in (sc.get("props") or {}):
                if k not in known and k != "highlight":
                    Wn(f"{where}: template '{tpl}' ignores prop '{k}' (known: {list(known)})")
            if tpl == "image":
                check_src(f"{where}.props", (sc.get("props") or {}).get("src"))
        if not tpl and not sc.get("layers"):
            Wn(f"{where}: scene has no template and no layers (it will be empty)")
        tr = sc.get("transition")
        if tr is not None and not transition_known(tr, cat):
            E(f"{where}: unknown transition {tr!r} — run `python studio.py catalog`")
        if isinstance(tr, dict) and tr.get("duration", 0.8) > dur * 0.5 + 1e-6:
            Wn(f"{where}: transition longer than half the scene; it will be shortened")
        bg = sc.get("background")
        if isinstance(bg, dict) and bg.get("type") in ("image", "video"):
            check_src(f"{where}.background", bg.get("src"))
        for s in sc.get("sfx") or []:
            check_src(f"{where}.sfx", s.get("src"))
        ids = set()
        for j, L in enumerate(sc.get("layers") or []):
            lw = f"{where}.layers[{j}]" + (f" ({L.get('id')})" if L.get("id") else "")
            if not L.get("id"):
                E(f"{lw}: missing 'id'")
            elif L["id"] in ids:
                E(f"{lw}: duplicate layer id '{L['id']}'")
            ids.add(L.get("id"))
            ty = L.get("type")
            if ty not in cat["layerTypes"]:
                E(f"{lw}: unknown type '{ty}' (use one of {cat['layerTypes']})")
            if ty == "text" and not str(L.get("text", "")).strip() and not L.get("count"):
                E(f"{lw}: text layer needs 'text'")
            if ty in ("image", "video"):
                check_src(lw, L.get("src"))
            if ty == "shape" and L.get("shape") not in cat["shapes"]:
                E(f"{lw}: unknown shape '{L.get('shape')}' (use one of {cat['shapes']})")
            for k in ("in", "out"):
                v = L.get(k)
                if v is not None and (not isinstance(v, dict) or v.get("type") not in anims):
                    E(f"{lw}: '{k}' must be {{\"type\": one of {sorted(anims)}}}")
            lp = L.get("loop")
            if isinstance(lp, dict) and lp.get("type") not in cat["loops"]:
                E(f"{lw}: unknown loop type '{lp.get('type')}'")
            st, en = L.get("start", 0), L.get("end", dur)
            if st >= en:
                E(f"{lw}: start ({st}) must be before end ({en})")
            if en > dur + 1e-6:
                Wn(f"{lw}: ends at {en}s but scene lasts {dur}s")
            x, y = L.get("x"), L.get("y")
            if ty != "shape" or not L.get("points"):
                if x is None or y is None:
                    Wn(f"{lw}: no x/y — layer is drawn at the top-left corner (0,0); center is ({W // 2},{H // 2})")
                elif not (-W * 0.1 <= x <= W * 1.1 and -H * 0.1 <= y <= H * 1.1):
                    Wn(f"{lw}: position ({x},{y}) is outside the {W}x{H} frame")
    for k, a in enumerate(p.get("audio") or []):
        check_src(f"audio[{k}]", a.get("src"))
        if a.get("role", "music") not in ("voice", "music", "sfx"):
            E(f"audio[{k}]: role must be voice, music or sfx")
    ts = p.get("transitionSfx")
    if ts:
        check_src("transitionSfx", ts if isinstance(ts, str) else ts.get("src"))
    return errors, warns


def cmd_validate(a):
    p = load_project(a.name)
    errors, warns = validate(a.name, p)
    for w in warns:
        print(f"warning: {w}")
    for e in errors:
        print(f"error: {e}")
    if errors:
        print(f"✗ {len(errors)} error(s), {len(warns)} warning(s)")
        sys.exit(1)
    print(f"✓ valid ({len(warns)} warning(s))")


# --------------------------------------------------------------------------- browser rendering

class Session:
    """Server + headless Chromium with the renderer page loaded."""

    def __init__(self, name, scale=1.0, server=None, software=False):
        self.name, self.scale, self.server_url, self.software = name, scale, server, software
        self.httpd = None

    def __enter__(self):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            sys.exit("error: Playwright is not installed — run: pip install playwright && playwright install chromium")
        if not self.server_url:
            import server as srv
            self.httpd = srv.start(0, quiet=True)
            threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
            self.server_url = f"http://127.0.0.1:{self.httpd.server_port}"
        self.pw = sync_playwright().start()
        args = ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"]
        if self.software:
            args.append("--use-angle=swiftshader")
        # Bundled Playwright Chromium first, then an explicit CHROME_PATH, then installed Chrome/Edge.
        attempts = [{}]
        if os.environ.get("CHROME_PATH"):
            attempts.insert(0, {"executable_path": os.environ["CHROME_PATH"]})
        attempts += [{"channel": "chrome"}, {"channel": "msedge"}]
        first = None
        for opts in attempts:
            try:
                self.browser = self.pw.chromium.launch(args=args, **opts)
                break
            except Exception as e:  # noqa: BLE001
                first = first or e
        else:
            self.pw.stop()
            sys.exit(f"error: could not start Chromium ({str(first).splitlines()[0]}).\n"
                     "Run: playwright install chromium   (or set CHROME_PATH to a Chrome executable)")
        self.page = self.browser.new_page(viewport={"width": 800, "height": 600})
        logs = []
        self.page.on("console", lambda m: logs.append(m.text) if m.type in ("error", "warning") else None)
        self.page.on("pageerror", lambda e: logs.append(str(e)))
        self.logs = logs
        self.page.goto(f"{self.server_url}/editor/render.html")
        self.page.wait_for_function("window.rendererReady === true")
        try:
            self.info = self.page.evaluate("([n, s]) => renderer.init(n, s)", [self.name, self.scale])
        except Exception as e:  # noqa: BLE001
            self.close()
            sys.exit(f"error: renderer failed to load project: {e}\n" + "\n".join(logs[-10:]))
        if self.info["missing"]:
            print("warning: missing media: " + ", ".join(self.info["missing"]), file=sys.stderr)
        if not self.info["webgl"]:
            print("warning: WebGL unavailable — transitions fall back to crossfade", file=sys.stderr)
        return self

    def frame(self, t, fmt="jpeg", quality=0.94):
        return base64.b64decode(self.page.evaluate("([t, f, q]) => renderer.frame(t, f, q)", [t, fmt, quality]))

    def close(self):
        try:
            self.browser.close()
            self.pw.stop()
        finally:
            if self.httpd:
                self.httpd.shutdown()

    def __exit__(self, *exc):
        self.close()


def out_path(a, default):
    p = Path(a.out) if getattr(a, "out", None) else EXPORTS / default
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def cmd_snapshot(a):
    with Session(a.name, a.scale, a.server) as s:
        for t in a.times:
            t = min(max(0.0, t), s.info["duration"])
            p = out_path(a, f"{a.name}-{t:.2f}s.png") if len(a.times) == 1 else EXPORTS / f"{a.name}-{t:.2f}s.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(s.frame(t, "png"))
            print(p.relative_to(ROOT) if p.is_relative_to(ROOT) else p)


def cmd_sheet(a):
    with Session(a.name, a.scale, a.server) as s:
        dur = s.info["duration"]
        if a.count:
            times = [dur * (i + 0.5) / a.count for i in range(a.count)]
        else:
            # One frame per scene, late enough that its animations have played in.
            times = [sc["start"] + (sc["end"] - sc["start"]) * 0.7 for sc in s.info["scenes"]]
        data = s.page.evaluate("([t, c]) => renderer.sheet(t, c)", [times, a.cols])
        p = out_path(a, f"{a.name}-sheet.png")
        p.write_bytes(base64.b64decode(data))
        print(p.relative_to(ROOT) if p.is_relative_to(ROOT) else p)


def probe(path, what="duration"):
    if what == "audio":
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
                            "-of", "csv=p=0", str(path)], capture_output=True, text=True)
        return bool(r.stdout.strip())
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return None


def audio_graph(items, total):
    """ffmpeg inputs + filter_complex mixing voice, music (ducked under voice), sfx and video audio."""
    inputs, chains, labels = [], [], {"voice": [], "music": [], "duck": [], "other": []}
    for it in items:
        path = ROOT / it["src"]
        if not path.exists():
            print(f"warning: audio file not found, skipped: {it['src']}", file=sys.stderr)
            continue
        if it["role"] == "video" and not probe(path, "audio"):
            continue
        start = max(0.0, it["start"])
        if start >= total:
            continue
        length = probe(path)
        if it.get("loop"):
            inputs += ["-stream_loop", "-1"]
            avail = total - start
        else:
            avail = (length - it["trim"]) if length else total - start
        dur = min(it["duration"] or avail, avail, total - start)
        if dur <= 0:
            continue
        idx = 1 + inputs.count("-i")
        inputs += ["-i", str(path)]
        f = [f"atrim=start={it['trim']:.3f}:duration={dur:.3f}", "asetpts=PTS-STARTPTS", f"volume={it['volume']:.3f}"]
        if it["fadeIn"]:
            f.append(f"afade=t=in:d={it['fadeIn']:.3f}")
        if it["fadeOut"]:
            f.append(f"afade=t=out:st={max(0, dur - it['fadeOut']):.3f}:d={it['fadeOut']:.3f}")
        ms = int(round(start * 1000))
        f.append(f"adelay={ms}:all=1")
        lab = f"a{len(chains)}"
        chains.append(f"[{idx}:a]{','.join(f)}[{lab}]")
        key = "voice" if it["role"] == "voice" else ("duck" if it.get("duck") and it["role"] == "music" else "other")
        labels[key].append(lab)
    if not chains:
        return [], None
    g = list(chains)
    final = []
    mix = lambda ls, out: g.append(f"{''.join(f'[{x}]' for x in ls)}amix=inputs={len(ls)}:normalize=0:dropout_transition=0[{out}]")
    if labels["voice"] and labels["duck"]:
        mix(labels["voice"], "vmix")
        g.append("[vmix]asplit=2[voice][vkey]")
        mix(labels["duck"], "mmix")
        g.append("[mmix][vkey]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[ducked]")
        final += ["voice", "ducked"]
    else:
        final += labels["voice"] + labels["duck"]
    final += labels["other"]
    mix(final, "mixed")
    g.append(f"[mixed]apad,atrim=duration={total:.3f},alimiter=limit=0.95[aout]")
    return inputs, ";".join(g)


def cmd_render(a):
    if not shutil.which("ffmpeg"):
        sys.exit("error: ffmpeg not found on PATH")
    p = load_project(a.name)
    errors, _ = validate(a.name, p)
    if errors:
        for e in errors:
            print(f"error: {e}")
        sys.exit("error: fix the project before rendering (python studio.py validate %s)" % a.name)
    out = out_path(a, f"{a.name}.mp4")
    with Session(a.name, a.scale, a.server, a.software) as s:
        info = s.info
        fps = a.fps or info["fps"]
        total = info["duration"]
        if a.start or a.end:
            t0, t1 = a.start or 0, min(a.end or total, total)
        else:
            t0, t1 = 0, total
        n = max(1, int(round((t1 - t0) * fps)))
        ainputs, agraph = audio_graph(info["audio"], total) if not a.no_audio else ([], None)
        if agraph and (t0 or t1 < total):
            agraph = agraph.replace("[aout]", "[afull]") + f";[afull]atrim=start={t0:.3f}:end={t1:.3f},asetpts=PTS-STARTPTS[aout]"
        fmt = "png" if a.png else "jpeg"
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(fps),
               "-c:v", "png" if a.png else "mjpeg", "-i", "-", *ainputs]
        if agraph:
            cmd += ["-filter_complex", agraph, "-map", "0:v", "-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]
        cmd += ["-c:v", "libx264", "-preset", a.preset, "-crf", str(a.crf), "-pix_fmt", "yuv420p",
                "-r", str(fps), "-movflags", "+faststart", "-t", f"{t1 - t0:.3f}", str(out)]
        print(f"rendering {n} frames @ {fps}fps → {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}", flush=True)
        ff = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        t_start = time.time()
        try:
            for i in range(n):
                ff.stdin.write(s.frame(t0 + i / fps, fmt, a.quality))
                if i % 10 == 0 or i == n - 1:
                    print(f"PROGRESS {i + 1}/{n}", flush=True)
        except BrokenPipeError:
            pass
        ff.stdin.close()
        code = ff.wait()
    if code != 0:
        sys.exit("error: ffmpeg failed")
    rel = out.relative_to(ROOT).as_posix() if out.is_relative_to(ROOT) else str(out)
    print(f"OUTPUT {rel}")
    print(f"done in {time.time() - t_start:.1f}s")


def cmd_serve(a):
    import server as srv
    httpd = srv.start(a.port)
    if a.open:
        import webbrowser
        webbrowser.open(f"http://localhost:{httpd.server_port}/editor/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


def main():
    ap = argparse.ArgumentParser(prog="studio.py", description="Explainer Studio CLI")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("serve", help="start the editor")
    s.add_argument("--port", type=int, default=4100)
    s.add_argument("--open", action="store_true", help="open the browser")
    s.set_defaults(fn=cmd_serve)

    s = sub.add_parser("new", help="create a project")
    s.add_argument("name")
    s.add_argument("--title")
    s.add_argument("--theme", default="psych")
    s.add_argument("--shorts", action="store_true", help="vertical 1080x1920")
    s.set_defaults(fn=cmd_new)

    s = sub.add_parser("catalog", help="list everything the engine supports")
    s.add_argument("--full", action="store_true", help="include transition parameters")
    s.set_defaults(fn=cmd_catalog)

    for nm, fn, hl in (("info", cmd_info, "print the timeline"), ("validate", cmd_validate, "check a project")):
        s = sub.add_parser(nm, help=hl)
        s.add_argument("name")
        s.set_defaults(fn=fn)

    def common(s):
        s.add_argument("name")
        s.add_argument("--scale", type=float, default=1.0, help="output scale (2 = 4K for a 1080p project)")
        s.add_argument("--server", help="use a running server instead of starting one")
        s.add_argument("--out")

    s = sub.add_parser("snapshot", help="PNG of frame(s) at given seconds")
    common(s)
    s.add_argument("times", type=float, nargs="+")
    s.set_defaults(fn=cmd_snapshot)

    s = sub.add_parser("sheet", help="contact sheet of the whole video")
    common(s)
    s.add_argument("--count", type=int, help="evenly spaced frames instead of one per scene")
    s.add_argument("--cols", type=int, default=4)
    s.set_defaults(fn=cmd_sheet)

    s = sub.add_parser("render", help="export MP4")
    common(s)
    s.add_argument("--fps", type=int)
    s.add_argument("--crf", type=int, default=18)
    s.add_argument("--preset", default="medium")
    s.add_argument("--quality", type=float, default=0.94, help="JPEG quality of intermediate frames")
    s.add_argument("--png", action="store_true", help="lossless intermediate frames (slower)")
    s.add_argument("--start", type=float, help="render only from this second")
    s.add_argument("--end", type=float, help="render only up to this second")
    s.add_argument("--no-audio", action="store_true")
    s.add_argument("--software", action="store_true", help="force software WebGL (if the GPU path misbehaves)")
    s.set_defaults(fn=cmd_render)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
