// Explainer Studio engine: turns a project.json into frames.
// render(t) is a pure function of the project and the time, so the preview,
// snapshots and the final MP4 export all produce identical pixels.

import { getTheme, color } from './themes.js';
import { layerState, isActive, ease, lerp, mulberry32 } from './anim.js';
import { drawLayer } from './layers.js';
import { sceneLayers } from './templates.js';
import { Transitioner, loadTransitionLibrary, resolveTransition } from './transitions.js';

const FONT_FILES = [
  ['Cairo', 400], ['Cairo', 700], ['Cairo', 800],
  ['Tajawal', 400], ['Tajawal', 700], ['Tajawal', 800],
];

// ---------------------------------------------------------------- assets

class Assets {
  constructor(resolve, mode) {
    this.resolve = resolve;
    this.mode = mode;
    this.images = new Map();
    this.videos = new Map();
    this.missing = new Set();
  }

  async loadImage(src) {
    if (!src || this.images.has(src)) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    this.images.set(src, null);
    try {
      img.src = this.resolve(src);
      await img.decode();
      this.images.set(src, img);
      this.missing.delete(src);
    } catch {
      this.missing.add(src);
    }
  }

  async loadVideo(src) {
    if (!src || this.videos.has(src)) return;
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    this.videos.set(src, null);
    try {
      await new Promise((res, rej) => {
        v.onloadeddata = res;
        v.onerror = () => rej(new Error('video error'));
        v.src = this.resolve(src);
      });
      this.videos.set(src, v);
      this.missing.delete(src);
    } catch {
      this.missing.add(src);
    }
  }

  image(src) { return this.images.get(src) || null; }
  video(src) { return this.videos.get(src) || null; }
}

function seekVideo(v, time) {
  return new Promise((res) => {
    if (Math.abs(v.currentTime - time) < 0.001 && v.readyState >= 2) return res();
    const done = () => { v.removeEventListener('seeked', done); res(); };
    v.addEventListener('seeked', done);
    v.currentTime = time;
    setTimeout(done, 3000);
  });
}

// ---------------------------------------------------------------- engine

export class Engine {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.mode = opts.mode || 'preview';
    // Export reads every frame back, which is far faster from a CPU-backed canvas
    // than from a GPU one (especially when the GPU is emulated in headless Chrome).
    this.ctxOpts = this.mode === 'render' ? { willReadFrequently: true } : {};
    this.ctx = canvas.getContext('2d', this.ctxOpts);
    this.scale = opts.scale || 1;
    this.base = opts.base || '/';
    this.trans = new Transitioner();
    this.bufA = document.createElement('canvas');
    this.bufB = document.createElement('canvas');
    this.hits = [];
    this.layerCache = new WeakMap();
    this.grain = null;
    this.playing = false;
  }

  static async loadFonts() {
    await document.fonts.ready;
    await Promise.all(FONT_FILES.map(([f, w]) =>
      Promise.all([document.fonts.load(`${w} 40px "${f}"`, 'أبجد'), document.fonts.load(`${w} 40px "${f}"`, 'Abc')]).catch(() => {})));
  }

  async load(project, { name } = {}) {
    this.name = name;
    await Promise.all([Engine.loadFonts(), loadTransitionLibrary()]);
    this.setProject(project);
    await this.preload();
  }

  setProject(project) {
    this.project = project;
    this.theme = getTheme(project);
    this.W = project.width || 1920;
    this.H = project.height || 1080;
    this.fps = project.fps || 30;
    this.layerCache = new WeakMap();
    this.resize(this.scale);
    this._timeline = null;
  }

  invalidate() {
    this.layerCache = new WeakMap();
    this._timeline = null;
    this.theme = getTheme(this.project);
  }

  resize(scale) {
    this.scale = scale;
    const w = Math.round(this.W * scale), h = Math.round(this.H * scale);
    for (const c of [this.canvas, this.bufA, this.bufB]) {
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
  }

  resolve(src) {
    if (/^(https?:|data:|blob:)/.test(src)) return src;
    if (src.startsWith('/')) return src;
    if (src.startsWith('media/')) return `${this.base}${src}`;
    return `${this.base}projects/${this.name}/${src}`;
  }

  // Path relative to the studio root, used by the exporter to find audio files.
  fsPath(src) {
    if (src.startsWith('media/') || src.startsWith('/')) return src.replace(/^\//, '');
    return `projects/${this.name}/${src}`;
  }

  get assets() {
    if (!this._assets) this._assets = new Assets((s) => this.resolve(s), this.mode);
    return this._assets;
  }

  async preload() {
    const jobs = [];
    const bgs = [this.theme.background];
    for (const sc of this.project.scenes || []) {
      if (sc.background) bgs.push(sc.background);
      for (const L of this.layersOf(sc)) {
        if (L.type === 'image' && L.src) jobs.push(this.assets.loadImage(L.src));
        if (L.type === 'video' && L.src) jobs.push(this.assets.loadVideo(L.src));
      }
    }
    for (const bg of bgs) {
      if (bg && bg.type === 'image') jobs.push(this.assets.loadImage(bg.src));
      if (bg && bg.type === 'video') jobs.push(this.assets.loadVideo(bg.src));
    }
    await Promise.all(jobs);
  }

  layersOf(scene) {
    let l = this.layerCache.get(scene);
    if (!l) {
      l = sceneLayers(scene, this.project, this.theme).map(withDefaults);
      this.layerCache.set(scene, l);
    }
    return l;
  }

  // Scenes play back to back; a transition overlaps the end of a scene with the start of the next.
  timeline() {
    if (this._timeline) return this._timeline;
    const scenes = this.project.scenes || [];
    const items = [];
    let t = 0;
    scenes.forEach((sc, i) => {
      const dur = Math.max(0.1, Number(sc.duration) || 5);
      const prev = items[i - 1];
      let tin = 0, resolved = null, spec = null;
      if (prev) {
        spec = prev.scene.transition ?? this.project.defaultTransition;
        resolved = resolveTransition(spec);
        if (resolved) {
          tin = Math.min(Number(spec.duration ?? 0.8), prev.dur * 0.5, dur * 0.5);
          t -= tin;
        }
      }
      items.push({ scene: sc, index: i, start: t, end: t + dur, dur, tin, resolved, spec });
      t += dur;
    });
    this._timeline = { items, duration: t };
    return this._timeline;
  }

  get duration() { return this.timeline().duration; }

  activeAt(t) {
    return this.timeline().items.filter((it) => t >= it.start && t < it.end);
  }

  // Make sure videos show the right frame at time t (exact seeking in render mode).
  async prepare(t) {
    const jobs = [];
    for (const it of this.activeAt(t)) {
      const lt = t - it.start;
      for (const L of this.layersOf(it.scene)) {
        if (L.type !== 'video' || !isActive(L, lt, it.dur)) continue;
        const v = this.assets.video(L.src);
        if (v) jobs.push(seekVideo(v, this.videoTime(L, lt, v)));
      }
      const bg = it.scene.background;
      if (bg && bg.type === 'video') {
        const v = this.assets.video(bg.src);
        if (v) jobs.push(seekVideo(v, (bg.trim ?? 0) + (lt % Math.max(0.1, v.duration || 1e9))));
      }
    }
    await Promise.all(jobs);
  }

  videoTime(L, lt, v) {
    const local = (lt - (L.start ?? 0)) * (L.speed ?? 1) + (L.trim ?? 0);
    const d = v.duration || 1e9;
    return L.repeat ? local % d : Math.min(local, d - 0.05);
  }

  // Keep <video> elements roughly in sync during interactive playback.
  syncVideos(t, playing) {
    const active = new Set();
    for (const it of this.activeAt(t)) {
      const lt = t - it.start;
      for (const L of this.layersOf(it.scene)) {
        if (L.type !== 'video' || !isActive(L, lt, it.dur)) continue;
        const v = this.assets.video(L.src);
        if (!v) continue;
        active.add(v);
        const want = this.videoTime(L, lt, v);
        if (!playing) { if (Math.abs(v.currentTime - want) > 0.04) v.currentTime = want; v.pause(); }
        else {
          v.playbackRate = L.speed ?? 1;
          if (Math.abs(v.currentTime - want) > 0.3) v.currentTime = want;
          if (v.paused) v.play().catch(() => {});
        }
      }
    }
    for (const v of this.assets.videos.values()) if (v && !active.has(v) && !v.paused) v.pause();
  }

  // ------------------------------------------------------------ drawing

  render(t) {
    const ctx = this.ctx;
    const tl = this.timeline();
    t = Math.max(0, Math.min(t, tl.duration - 1e-4));
    this.hits = [];
    this.frame = Math.round(t * this.fps);
    const act = this.activeAt(t);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (act.length === 1) {
      this.drawScene(ctx, act[0], t - act[0].start);
    } else if (act.length >= 2) {
      const [a, b] = act.slice(-2);
      const ca = this.bufA.getContext('2d', this.ctxOpts), cb = this.bufB.getContext('2d', this.ctxOpts);
      this.drawScene(ca, a, t - a.start);
      this.drawScene(cb, b, t - b.start);
      const p = ease(b.spec?.ease || 'inOutSine', (t - b.start) / Math.max(1e-6, b.tin));
      const out = this.trans.render(this.bufA, this.bufB, p, b.resolved);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (out) ctx.drawImage(out, 0, 0);
      else {
        ctx.drawImage(this.bufA, 0, 0);
        ctx.globalAlpha = p;
        ctx.drawImage(this.bufB, 0, 0);
        ctx.globalAlpha = 1;
      }
    }
    this.drawFx(ctx);
  }

  drawScene(ctx, it, lt, opts = {}) {
    const sc = it.scene;
    const s = opts.scale ?? this.scale;
    ctx.save();
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    const cam = this.camera(sc, lt, it.dur);
    this.drawBackground(ctx, sc.background || this.theme.background, lt, it.dur, cam);
    ctx.translate(this.W / 2, this.H / 2);
    ctx.scale(cam.zoom, cam.zoom);
    if (cam.rotate) ctx.rotate((cam.rotate * Math.PI) / 180);
    ctx.translate(-this.W / 2 - cam.x, -this.H / 2 - cam.y);
    const env = {
      theme: this.theme, assets: this.assets, W: this.W, H: this.H, scale: s, zoom: cam.zoom,
      hits: opts.hits === false ? [] : this.hits, sceneId: sc.id,
    };
    for (const L of this.layersOf(sc)) {
      if (!isActive(L, lt, it.dur)) continue;
      drawLayer(ctx, L, layerState(L, lt, it.dur), env, lt);
    }
    ctx.restore();
  }

  // camera: { from: {zoom,x,y,rotate}, to: {...}, ease } or keyframes [{t, zoom, x, y, rotate}]
  camera(sc, lt, dur) {
    const c = sc.camera;
    const out = { zoom: 1, x: 0, y: 0, rotate: 0 };
    if (!c) return out;
    if (Array.isArray(c)) {
      for (const k of ['zoom', 'x', 'y', 'rotate']) {
        const ks = c.filter((f) => f[k] != null);
        if (!ks.length) continue;
        if (lt <= ks[0].t) out[k] = ks[0][k];
        else if (lt >= ks[ks.length - 1].t) out[k] = ks[ks.length - 1][k];
        else for (let i = 0; i < ks.length - 1; i++) {
          if (lt >= ks[i].t && lt <= ks[i + 1].t) {
            out[k] = lerp(ks[i][k], ks[i + 1][k], ease(ks[i + 1].ease || 'inOutCubic', (lt - ks[i].t) / (ks[i + 1].t - ks[i].t)));
          }
        }
      }
      return out;
    }
    const p = ease(c.ease || 'inOutSine', lt / dur);
    const f = { ...out, ...(c.from || {}) }, to = { ...f, ...(c.to || {}) };
    for (const k of ['zoom', 'x', 'y', 'rotate']) out[k] = lerp(f[k], to[k], p);
    return out;
  }

  drawBackground(ctx, bg, lt, dur, cam) {
    const W = this.W, H = this.H, th = this.theme;
    if (typeof bg === 'string') bg = bg === 'theme' ? th.background : { type: 'solid', color: bg };
    ctx.save();
    switch (bg.type) {
      case 'linear': case 'gradient': {
        const a = ((bg.angle ?? 135) * Math.PI) / 180;
        const r = Math.hypot(W, H) / 2;
        const g = ctx.createLinearGradient(W / 2 - Math.cos(a) * r, H / 2 - Math.sin(a) * r, W / 2 + Math.cos(a) * r, H / 2 + Math.sin(a) * r);
        (bg.colors || ['bg', 'surface']).forEach((c, i, arr) => g.addColorStop(i / Math.max(1, arr.length - 1), color(th, c)));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        break;
      }
      case 'radial': {
        const g = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H / 2, Math.hypot(W, H) * 0.6);
        (bg.colors || ['surface', 'bg']).forEach((c, i, arr) => g.addColorStop(i / Math.max(1, arr.length - 1), color(th, c)));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        break;
      }
      case 'pattern': {
        ctx.fillStyle = color(th, bg.bg, 'bg');
        ctx.fillRect(0, 0, W, H);
        // The pattern is rendered once into a tile and repeated (much faster than drawing every dot).
        const sz = bg.size ?? 40;
        const ox = (-(cam.x * 0.3) % sz + sz) % sz, oy = (-(cam.y * 0.3) % sz + sz) % sz;
        const pat = ctx.createPattern(this.patternTile(bg, sz), 'repeat');
        pat.setTransform(new DOMMatrix().scale(1 / this.scale));
        ctx.translate(ox - sz / 2, oy - sz / 2);
        ctx.fillStyle = pat;
        ctx.fillRect(-sz, -sz, W + sz * 2, H + sz * 2);
        break;
      }
      case 'image': case 'video': {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        const src = bg.type === 'image' ? this.assets.image(bg.src) : this.assets.video(bg.src);
        if (src) {
          const nw = src.naturalWidth || src.videoWidth, nh = src.naturalHeight || src.videoHeight;
          const kb = bg.kenburns === false ? null : (bg.kenburns || { from: 1.02, to: 1.12 });
          const k = kb ? lerp(kb.from ?? 1, kb.to ?? 1.12, ease('inOutSine', lt / dur)) : 1;
          const r = Math.max(W / nw, H / nh) * k * cam.zoom;
          const dw = nw * r, dh = nh * r;
          if (bg.blur) ctx.filter = `blur(${bg.blur * this.scale}px)`;
          ctx.drawImage(src, (W - dw) / 2 - cam.x * 0.5, (H - dh) / 2 - cam.y * 0.5, dw, dh);
          ctx.filter = 'none';
        }
        if (bg.dim) { ctx.fillStyle = `rgba(0,0,0,${bg.dim})`; ctx.fillRect(0, 0, W, H); }
        if (bg.tint) { ctx.globalAlpha = bg.tintOpacity ?? 0.35; ctx.fillStyle = color(th, bg.tint); ctx.fillRect(0, 0, W, H); }
        break;
      }
      default:
        ctx.fillStyle = color(th, bg.color, 'bg');
        ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  patternTile(bg, sz) {
    const th = this.theme;
    const key = JSON.stringify([bg, sz, this.scale, th.colors]);
    this._tiles = this._tiles || new Map();
    if (this._tiles.has(key)) return this._tiles.get(key);
    const k = this.scale;
    const c = document.createElement('canvas');
    c.width = c.height = Math.max(1, Math.round(sz * k));
    const x = c.getContext('2d');
    x.scale(c.width / sz, c.height / sz);
    x.fillStyle = x.strokeStyle = color(th, bg.color, 'line');
    x.lineWidth = bg.lineWidth ?? 2;
    if (bg.pattern === 'grid' || bg.pattern === 'lines') {
      x.beginPath();
      x.moveTo(0, sz / 2); x.lineTo(sz, sz / 2);
      if (bg.pattern === 'grid') { x.moveTo(sz / 2, 0); x.lineTo(sz / 2, sz); }
      x.stroke();
    } else {
      x.beginPath(); x.arc(sz / 2, sz / 2, bg.dot ?? 3, 0, Math.PI * 2); x.fill();
    }
    if (this._tiles.size > 30) this._tiles.clear();
    this._tiles.set(key, c);
    return c;
  }

  drawFx(ctx) {
    const fx = this.theme.fx || {};
    const w = this.canvas.width, h = this.canvas.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (fx.vignette) {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.6);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${fx.vignette})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    if (fx.grain) {
      if (!this.grain) this.grain = makeGrain();
      const tile = this.grain[this.frame % this.grain.length];
      const pat = ctx.createPattern(tile, 'repeat');
      ctx.globalAlpha = fx.grain;
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  }

  // Small still of one scene, used for scene thumbnails in the editor.
  renderSceneThumb(target, sceneIndex, at = 0.6) {
    const it = this.timeline().items[sceneIndex];
    if (!it) return;
    const ctx = target.getContext('2d');
    const s = target.width / this.W;
    ctx.clearRect(0, 0, target.width, target.height);
    this.drawScene(ctx, it, Math.min(it.dur - 0.01, it.dur * at), { scale: s, hits: false });
  }

  hitTest(px, py) {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      const p = h.m.inverse().transformPoint(new DOMPoint(px, py));
      if (Math.abs(p.x) <= h.w / 2 + 6 && Math.abs(p.y) <= h.h / 2 + 6) return h;
    }
    return null;
  }

  // Everything the exporter needs to mix the soundtrack with ffmpeg.
  audioPlan() {
    const out = [];
    const tl = this.timeline();
    for (const a of this.project.audio || []) {
      if (!a.src || a.mute) continue;
      out.push({
        src: this.fsPath(a.src), start: a.start ?? 0, trim: a.trim ?? 0, duration: a.duration ?? null,
        volume: a.volume ?? 1, fadeIn: a.fadeIn ?? 0, fadeOut: a.fadeOut ?? 0, role: a.role || 'music',
        duck: a.duck ?? (a.role === 'music' || !a.role), loop: !!a.loop,
      });
    }
    for (const it of tl.items) {
      for (const s of it.scene.sfx || []) {
        out.push({ src: this.fsPath(s.src), start: it.start + (s.at ?? 0), trim: s.trim ?? 0, duration: s.duration ?? null, volume: s.volume ?? 1, fadeIn: 0, fadeOut: 0, role: 'sfx', duck: false });
      }
      const tsfx = this.project.transitionSfx;
      if (tsfx && it.tin > 0) {
        const o = typeof tsfx === 'string' ? { src: tsfx } : tsfx;
        out.push({ src: this.fsPath(o.src), start: Math.max(0, it.start + it.tin / 2 - (o.offset ?? 0.25)), trim: 0, duration: null, volume: o.volume ?? 0.6, fadeIn: 0, fadeOut: 0, role: 'sfx', duck: false });
      }
      for (const L of this.layersOf(it.scene)) {
        if (L.type !== 'video' || L.muted || (L.volume ?? 1) <= 0) continue;
        const end = L.end ?? it.dur;
        out.push({ src: this.fsPath(L.src), start: it.start + (L.start ?? 0), trim: L.trim ?? 0, duration: end - (L.start ?? 0), volume: L.volume ?? 1, fadeIn: 0.05, fadeOut: 0.1, role: 'video', duck: false });
      }
    }
    return out;
  }
}

// Shapes defined by points are positioned at the center of their points unless x/y are given.
function withDefaults(L) {
  if (L.type === 'shape' && L.points && L.points.length >= 2 && (L.x == null || L.y == null)) {
    const xs = L.points.map((p) => p[0]), ys = L.points.map((p) => p[1]);
    return { ...L, x: L.x ?? (Math.min(...xs) + Math.max(...xs)) / 2, y: L.y ?? (Math.min(...ys) + Math.max(...ys)) / 2 };
  }
  return L;
}

function makeGrain() {
  const tiles = [];
  for (let k = 0; k < 6; k++) {
    const c = document.createElement('canvas');
    c.width = c.height = 220;
    const x = c.getContext('2d');
    const img = x.createImageData(220, 220);
    const rnd = mulberry32(1234 + k * 977);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 128 + (rnd() - 0.5) * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    tiles.push(c);
  }
  return tiles;
}
