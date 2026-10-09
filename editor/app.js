// Explainer Studio editor UI.
// The project.json on disk is the single source of truth: every mouse edit is written back
// to it, and any change made to it from outside (an AI agent, a code editor) is pulled in live.

import { Engine } from './engine/core.js';
import { THEMES } from './engine/themes.js';
import { ANIMATIONS, LOOPS, EASINGS } from './engine/anim.js';
import { TEMPLATES } from './engine/templates.js';
import { SHAPES } from './engine/layers.js';
import { ALIASES, Transitioner, resolveTransition, transitionNames } from './engine/transitions.js';

// ------------------------------------------------------------------ helpers

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;
const fmt = (t) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};
const debounce = (fn, ms) => { let id; return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); }; };

function getPath(o, path) {
  return path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
}
function setPath(o, path, v) {
  const ks = path.split('.');
  let cur = o;
  for (let i = 0; i < ks.length - 1; i++) {
    if (cur[ks[i]] == null || typeof cur[ks[i]] !== 'object') cur[ks[i]] = {};
    cur = cur[ks[i]];
  }
  const last = ks[ks.length - 1];
  if (v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v))) delete cur[last];
  else cur[last] = v;
  // Drop objects left empty (e.g. "in": {}) so project.json stays tidy.
  for (let i = ks.length - 2; i >= 0; i--) {
    const node = getPath(o, ks.slice(0, i + 1).join('.'));
    if (!node || typeof node !== 'object' || Array.isArray(node) || Object.keys(node).length) break;
    const parent = i === 0 ? o : getPath(o, ks.slice(0, i).join('.'));
    delete parent[ks[i]];
  }
}

function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 2600);
}

// ------------------------------------------------------------------ state

const S = {
  name: null,
  project: null,
  t: 0,
  playing: false,
  loop: false,
  sel: { scene: null, layer: null },
  history: [],
  future: [],
  saved: '',
  quality: 0.5,
  pps: 60, // timeline pixels per second
};
const canvas = $('#canvas');
let engine = null;
let events = null;

const scene = (id = S.sel.scene) => S.project?.scenes?.find((s) => s.id === id) || null;
const sceneIndex = (id = S.sel.scene) => S.project.scenes.findIndex((s) => s.id === id);
const timelineItem = (id = S.sel.scene) => engine.timeline().items.find((it) => it.scene.id === id);
const effLayer = (sc, id) => (sc ? engine.layersOf(sc).find((l) => l.id === id) : null);
const rawLayer = (sc, id) => sc?.layers?.find((l) => l.id === id) || null;

// ------------------------------------------------------------------ persistence

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

const saveNow = async () => {
  const json = JSON.stringify(S.project);
  if (json === S.saved) return;
  S.saved = json;
  try {
    await api(`/api/project/${encodeURIComponent(S.name)}`, { method: 'PUT', body: json, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    toast(`فشل الحفظ: ${e.message}`, 'err');
  }
};
const save = debounce(saveNow, 250);

// Apply a change to the project. `fn` mutates S.project in place.
function commit(fn, { history = true, skipInspector = false, preload = false } = {}) {
  if (history) {
    S.history.push(JSON.stringify(S.project));
    if (S.history.length > 150) S.history.shift();
    S.future = [];
  }
  fn(S.project);
  engine.invalidate();
  save();
  if (preload) engine.preload().then(draw);
  refresh({ skipInspector });
}

function undo() {
  if (!S.history.length) return;
  S.future.push(JSON.stringify(S.project));
  replaceProject(JSON.parse(S.history.pop()));
  save();
}
function redo() {
  if (!S.future.length) return;
  S.history.push(JSON.stringify(S.project));
  replaceProject(JSON.parse(S.future.pop()));
  save();
}

function replaceProject(p) {
  S.project = p;
  engine.setProject(p);
  engine.resize(S.quality);
  if (!scene()) S.sel.scene = p.scenes?.[0]?.id ?? null;
  if (S.sel.layer && !effLayer(scene(), S.sel.layer)) S.sel.layer = null;
  engine.preload().then(() => { draw(); renderThumbs(); });
  layoutStage();
  refresh();
}

async function openProject(name) {
  S.name = name;
  history.replaceState(null, '', `?project=${encodeURIComponent(name)}`);
  const p = await api(`/api/project/${encodeURIComponent(name)}`);
  S.saved = JSON.stringify(p);
  S.history = [];
  S.future = [];
  S.t = 0;
  S.sel = { scene: p.scenes?.[0]?.id ?? null, layer: null };
  if (!engine) {
    engine = new Engine(canvas, { mode: 'preview', scale: S.quality });
    await engine.load(p, { name });
  } else {
    engine.name = name;
    engine.setProject(p);
    await engine.preload();
  }
  S.project = p;
  engine.resize(S.quality);
  connectEvents();
  layoutStage();
  refresh();
  renderMedia();
  renderThumbs();
}

// Live link with project.json on disk.
function connectEvents() {
  if (events) events.close();
  events = new EventSource(`/api/events?project=${encodeURIComponent(S.name)}`);
  events.addEventListener('change', async () => {
    const txt = await fetch(`/api/project/${encodeURIComponent(S.name)}`).then((r) => r.text());
    let p;
    try { p = JSON.parse(txt); } catch { toast('project.json فيه خطأ JSON — بانتظار التصحيح', 'err'); return; }
    const json = JSON.stringify(p);
    if (json === S.saved || json === JSON.stringify(S.project)) return;
    S.saved = json;
    S.history.push(JSON.stringify(S.project));
    replaceProject(p);
    renderMedia();
    const b = $('#liveBadge');
    b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
    toast('⚡ تحديث من الكود', 'ai');
  });
  events.addEventListener('render', (e) => onRenderEvent(JSON.parse(e.data)));
  events.onopen = () => { $('#liveBadge').classList.remove('off'); $('#liveText').textContent = 'مربوط بالكود'; };
  events.onerror = () => { $('#liveBadge').classList.add('off'); $('#liveText').textContent = 'غير متصل'; };
}

// ------------------------------------------------------------------ drawing & playback

function draw() {
  if (!engine) return;
  engine.syncVideos(S.t, S.playing);
  engine.render(S.t);
  drawOverlay();
  $('#timecode').textContent = `${fmt(S.t)} / ${fmt(engine.duration)}`;
  const ph = $('#playhead');
  if (ph) {
    ph.style.left = `${S.t * S.pps}px`;
    // Keep the playhead in view while playing or seeking.
    const sc = $('#tlScroll'), x = S.t * S.pps;
    if (!S.dragging && (x < sc.scrollLeft + 20 || x > sc.scrollLeft + sc.clientWidth - 40)) sc.scrollLeft = Math.max(0, x - sc.clientWidth * 0.3);
  }
}

function seek(t) {
  S.t = Math.max(0, Math.min(t, engine.duration));
  if (S.playing) syncAudio(true);
  // Follow the playhead into the scene under it.
  const act = engine.activeAt(S.t);
  const cur = act.find((a) => a.scene.id === S.sel.scene);
  if (!cur && act.length && !S.dragging) {
    S.sel = { scene: act[act.length - 1].scene.id, layer: null };
    refresh({ thumbs: false });
  }
  draw();
}

let lastTs = 0;
function tick(ts) {
  if (!S.playing) return;
  const dt = lastTs ? (ts - lastTs) / 1000 : 0;
  lastTs = ts;
  let t = S.t + dt;
  if (t >= engine.duration) {
    if (S.loop) { t = 0; syncAudio(true); } else { t = engine.duration; pause(); }
  }
  S.t = t;
  const act = engine.activeAt(t);
  if (act.length && !act.some((a) => a.scene.id === S.sel.scene)) {
    S.sel = { scene: act[act.length - 1].scene.id, layer: null };
    refresh({ thumbs: false });
  }
  draw();
  syncAudio(false);
  requestAnimationFrame(tick);
}

function play() {
  if (S.t >= engine.duration - 0.01) S.t = 0;
  S.playing = true;
  lastTs = 0;
  $('#playBtn').textContent = '❚❚';
  syncAudio(true);
  requestAnimationFrame(tick);
}
function pause() {
  S.playing = false;
  $('#playBtn').textContent = '▶';
  for (const a of audioEls.values()) a.el.pause();
  engine.syncVideos(S.t, false);
}

// Preview soundtrack: one <audio> per clip, nudged back in sync when it drifts.
const audioEls = new Map();
function syncAudio(force) {
  const plan = engine.audioPlan();
  const keys = new Set();
  plan.forEach((a, i) => {
    const key = `${i}|${a.src}`;
    keys.add(key);
    let rec = audioEls.get(key);
    if (!rec) { rec = { el: new Audio(`/${a.src}`) }; rec.el.preload = 'auto'; audioEls.set(key, rec); }
    const el = rec.el;
    const local = S.t - a.start;
    const len = a.duration ?? (el.duration ? el.duration - a.trim : Infinity);
    const inside = local >= 0 && local < len;
    el.volume = Math.max(0, Math.min(1, a.volume));
    if (!S.playing || !inside) { if (!el.paused) el.pause(); return; }
    const want = a.trim + (a.loop && el.duration ? local % el.duration : local);
    if (force || Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
    if (el.paused) el.play().catch(() => {});
  });
  for (const [k, rec] of audioEls) if (!keys.has(k)) { rec.el.pause(); audioEls.delete(k); }
}

// ------------------------------------------------------------------ stage layout & overlay

function layoutStage() {
  if (!engine) return;
  const st = $('#stage');
  const aw = st.clientWidth - 44, ah = st.clientHeight - 44;
  const ar = engine.W / engine.H;
  let w = aw, hh = aw / ar;
  if (hh > ah) { hh = ah; w = ah * ar; }
  const inner = $('#stageInner');
  inner.style.width = `${Math.floor(w)}px`;
  inner.style.height = `${Math.floor(hh)}px`;
  draw();
}

function cssPerPx() { return canvas.clientWidth / canvas.width; }

function hitCorners(hit) {
  const k = cssPerPx();
  const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const p = hit.m.transformPoint(new DOMPoint((sx * hit.w) / 2, (sy * hit.h) / 2));
    return [p.x * k, p.y * k];
  });
  return pts;
}

function drawOverlay() {
  const svg = $('#overlay');
  svg.innerHTML = '';
  if (!S.sel.layer) return;
  const hit = engine.hits.find((x) => x.layerId === S.sel.layer && x.sceneId === S.sel.scene);
  if (!hit) return;
  const pts = hitCorners(hit);
  const ns = 'http://www.w3.org/2000/svg';
  const poly = document.createElementNS(ns, 'polygon');
  poly.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
  poly.setAttribute('class', `sel${hit.tpl ? ' tpl' : ''}`);
  svg.append(poly);
  pts.forEach((p, i) => {
    const c = document.createElementNS(ns, 'rect');
    c.setAttribute('x', p[0] - 5); c.setAttribute('y', p[1] - 5);
    c.setAttribute('width', 10); c.setAttribute('height', 10);
    c.setAttribute('class', 'handle');
    c.dataset.handle = `corner${i}`;
    svg.append(c);
  });
  const top = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
  const ctr = [(pts[0][0] + pts[2][0]) / 2, (pts[0][1] + pts[2][1]) / 2];
  const len = Math.hypot(top[0] - ctr[0], top[1] - ctr[1]) || 1;
  const rp = [top[0] + ((top[0] - ctr[0]) / len) * 26, top[1] + ((top[1] - ctr[1]) / len) * 26];
  const line = document.createElementNS(ns, 'line');
  line.setAttribute('x1', top[0]); line.setAttribute('y1', top[1]); line.setAttribute('x2', rp[0]); line.setAttribute('y2', rp[1]);
  line.setAttribute('stroke', '#7c5cff');
  svg.append(line);
  const r = document.createElementNS(ns, 'circle');
  r.setAttribute('cx', rp[0]); r.setAttribute('cy', rp[1]); r.setAttribute('r', 6);
  r.setAttribute('class', 'rot');
  r.dataset.handle = 'rotate';
  svg.append(r);
}

// Write layer props; template layers are edited through scene.overrides so the template stays intact.
function patchLayer(sc, id, patch) {
  const raw = rawLayer(sc, id);
  for (const [k, v] of Object.entries(patch)) {
    if (raw) setPath(raw, k, v);
    else {
      sc.overrides = sc.overrides || {};
      sc.overrides[id] = sc.overrides[id] || {};
      setPath(sc.overrides[id], k, v);
      if (!Object.keys(sc.overrides[id]).length) delete sc.overrides[id];
      if (!Object.keys(sc.overrides).length) delete sc.overrides;
    }
  }
}

function initStage() {
  const svg = $('#overlay');
  svg.addEventListener('pointerdown', (e) => {
    if (!engine) return;
    const rect = canvas.getBoundingClientRect();
    const k = canvas.width / rect.width;
    const px = (e.clientX - rect.left) * k, py = (e.clientY - rect.top) * k;
    const handle = e.target.dataset?.handle;
    let hit = null;
    if (handle) hit = engine.hits.find((x) => x.layerId === S.sel.layer && x.sceneId === S.sel.scene);
    else hit = engine.hitTest(px, py);
    if (!hit) {
      S.sel.layer = null;
      refresh({ thumbs: false });
      draw();
      return;
    }
    if (S.playing) pause();
    if (hit.sceneId !== S.sel.scene || hit.layerId !== S.sel.layer) {
      S.sel = { scene: hit.sceneId, layer: hit.layerId };
      refresh({ thumbs: false });
      draw();
    }
    const sc = scene(hit.sceneId);
    const L = effLayer(sc, hit.layerId);
    if (!L || L.locked) return;
    const it = timelineItem(hit.sceneId);
    const zoom = engine.camera(sc, S.t - it.start, it.dur).zoom;
    const cx = hit.m.e, cy = hit.m.f;
    const start = {
      px, py, x: L.x ?? 0, y: L.y ?? 0, rotate: L.rotate ?? 0, size: L.size ?? 64,
      width: L.width ?? hit.w, height: L.height ?? hit.h, scale: L.scale ?? 1,
      ang: Math.atan2(py - cy, px - cx), dist: Math.hypot(px - cx, py - cy) || 1,
    };
    const before = JSON.stringify(S.project);
    let moved = false;
    S.dragging = true;
    svg.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const qx = (ev.clientX - rect.left) * k, qy = (ev.clientY - rect.top) * k;
      const patch = {};
      if (!handle) {
        const f = engine.scale * zoom;
        let nx = start.x + (qx - start.px) / f, ny = start.y + (qy - start.py) / f;
        // Snap to the frame's center lines.
        if (!ev.altKey) {
          if (Math.abs(nx - engine.W / 2) < 12 / f * engine.scale) nx = engine.W / 2;
          if (Math.abs(ny - engine.H / 2) < 12 / f * engine.scale) ny = engine.H / 2;
        }
        patch.x = round(nx, 1); patch.y = round(ny, 1);
      } else if (handle === 'rotate') {
        let a = start.rotate + ((Math.atan2(qy - cy, qx - cx) - start.ang) * 180) / Math.PI;
        if (ev.shiftKey) a = Math.round(a / 15) * 15;
        patch.rotate = round(a, 1);
      } else {
        const f = Math.max(0.05, Math.hypot(qx - cx, qy - cy) / start.dist);
        if (L.type === 'text') patch.size = round(start.size * f, 1);
        else if (L.type === 'shape' && L.points) patch.scale = round(start.scale * f, 3);
        else { patch.width = round(start.width * f, 1); patch.height = round(start.height * f, 1); }
      }
      moved = true;
      patchLayer(sc, hit.layerId, patch);
      engine.invalidate();
      draw();
    };
    const onUp = () => {
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerup', onUp);
      S.dragging = false;
      if (moved) {
        S.history.push(before);
        S.future = [];
        save();
        refresh({ thumbs: true });
      }
    };
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
  });
  svg.addEventListener('dblclick', () => {
    const ta = $('#inspector textarea');
    if (ta) { ta.focus(); ta.select(); }
  });
  new ResizeObserver(layoutStage).observe($('#stage'));
}

// ------------------------------------------------------------------ left panel

function refresh({ skipInspector = false, thumbs = true } = {}) {
  if (!S.project) return;
  renderProjectSelect();
  renderScenes();
  renderLayers();
  renderTimeline();
  if (!skipInspector) renderInspector();
  renderJson();
  renderTransitionsActive();
  if (thumbs) renderThumbsSoon();
  $('#undoBtn').disabled = !S.history.length;
  $('#redoBtn').disabled = !S.future.length;
  draw();
}

let projects = [];
async function loadProjectList() {
  projects = await api('/api/projects');
}
function renderProjectSelect() {
  const sel = $('#projectSelect');
  const want = projects.map((p) => p.name).join('|');
  if (sel.dataset.names !== want) {
    sel.innerHTML = '';
    for (const p of projects) sel.append(h('option', { value: p.name }, `${p.title} (${p.name})`));
    sel.dataset.names = want;
  }
  sel.value = S.name;
}

function renderScenes() {
  const list = $('#sceneList');
  list.innerHTML = '';
  const tl = engine.timeline();
  S.project.scenes.forEach((sc, i) => {
    const it = tl.items[i];
    const card = h('div', { class: `scene-card${sc.id === S.sel.scene ? ' active' : ''}`, onclick: () => selectScene(sc.id, true) },
      h('canvas', { width: 224, height: Math.round((224 * engine.H) / engine.W), 'data-thumb': i }),
      h('div', { class: 'meta' },
        h('div', { class: 'name' }, sc.id),
        h('div', { class: 'sub' }, `${TEMPLATES[sc.template]?.label || 'مخصص'} · ${round(sc.duration ?? 5, 1)}ث`),
        h('div', { class: 'sub' }, `${fmt(it.start)}`),
        h('div', { class: 'tools' },
          h('button', { title: 'لفوق', onclick: (e) => { e.stopPropagation(); moveScene(i, -1); } }, '↑'),
          h('button', { title: 'لتحت', onclick: (e) => { e.stopPropagation(); moveScene(i, 1); } }, '↓'),
          h('button', { title: 'نسخ', onclick: (e) => { e.stopPropagation(); duplicateScene(i); } }, '⧉'),
          h('button', { class: 'danger', title: 'حذف', onclick: (e) => { e.stopPropagation(); deleteScene(i); } }, '✕'))),
      h('span', { class: 'badge' }, i + 1));
    list.append(card);
  });
  list.append(h('button', { class: 'add-scene', onclick: () => switchLeft('add') }, '＋ مشهد جديد'));
}

const renderThumbsSoon = debounce(() => renderThumbs(), 350);
function renderThumbs() {
  if (!engine) return;
  for (const c of $$('canvas[data-thumb]')) engine.renderSceneThumb(c, Number(c.dataset.thumb));
}

function selectScene(id, seekTo) {
  S.sel = { scene: id, layer: null };
  if (seekTo) {
    const it = timelineItem(id);
    S.t = it.start + Math.min(it.dur * 0.6, it.tin + 1.5);
  }
  refresh({ thumbs: false });
}

const uid = (base, taken) => {
  let i = 1;
  while (taken.has(`${base}${i}`)) i++;
  return `${base}${i}`;
};

function moveScene(i, d) {
  const j = i + d;
  if (j < 0 || j >= S.project.scenes.length) return;
  commit((p) => { const [s] = p.scenes.splice(i, 1); p.scenes.splice(j, 0, s); });
}
function duplicateScene(i) {
  commit((p) => {
    const c = clone(p.scenes[i]);
    c.id = uid(`${p.scenes[i].id.replace(/-?\d+$/, '')}-`, new Set(p.scenes.map((s) => s.id)));
    p.scenes.splice(i + 1, 0, c);
    S.sel = { scene: c.id, layer: null };
  });
}
function deleteScene(i) {
  if (S.project.scenes.length <= 1) return toast('لازم يضل مشهد واحد على الأقل', 'err');
  commit((p) => {
    p.scenes.splice(i, 1);
    S.sel = { scene: p.scenes[Math.min(i, p.scenes.length - 1)].id, layer: null };
  });
}

const TYPE_ICON = { text: 'T', image: '🖼', video: '🎬', shape: '◯' };
function renderLayers() {
  const list = $('#layerList');
  list.innerHTML = '';
  const sc = scene();
  if (!sc) return;
  const layers = engine.layersOf(sc);
  if (!layers.length) list.append(h('div', { class: 'hint' }, 'ما في طبقات. ضيف من تبويب "إضافة".'));
  [...layers].reverse().forEach((L) => {
    const label = L.type === 'text' ? (L.text || L.id) : L.type === 'shape' ? `${L.shape}` : (L.src || L.id);
    list.append(h('div', {
      class: `layer-item${L.id === S.sel.layer ? ' active' : ''}${L.hidden ? ' off' : ''}`,
      onclick: () => { S.sel.layer = L.id; refresh({ thumbs: false }); },
    },
    h('span', { class: 'ico' }, TYPE_ICON[L.type] || '?'),
    h('span', { class: 'lname' }, String(label).slice(0, 40)),
    L._tpl ? h('span', { class: 'tag' }, 'قالب') : null,
    h('button', {
      class: 'eye', title: 'إخفاء/إظهار',
      onclick: (e) => { e.stopPropagation(); commit(() => patchLayer(sc, L.id, { hidden: L.hidden ? undefined : true })); },
    }, L.hidden ? '◌' : '◉')));
  });
}

// Defaults for new scenes made from templates.
const TEMPLATE_DEFAULTS = {
  title: { kicker: 'علم النفس', title: 'عنوان الفيديو', subtitle: 'سطر تعريفي قصير' },
  chapter: { number: '01', title: 'عنوان الفصل', subtitle: '' },
  list: { title: 'أهم النقاط', items: ['النقطة الأولى', 'النقطة الثانية', 'النقطة الثالثة'] },
  statement: { text: 'جملة قوية بتلخص الفكرة', highlight: ['قوية'] },
  quote: { text: 'اقتباس ملهم بيلخص الفكرة', author: 'المصدر' },
  compare: { leftTitle: 'الأول', left: ['ميزة', 'ميزة'], rightTitle: 'الثاني', right: ['عيب', 'عيب'] },
  image: { src: '', caption: 'تعليق على الصورة' },
  stat: { value: 75, suffix: '%', label: 'وصف الرقم' },
  outro: { title: 'شكراً للمشاهدة', subtitle: 'لا تنسى الاشتراك', cta: 'اشترك 🔔' },
};
const TEMPLATE_ICON = { title: '🅰', chapter: '#', list: '☰', statement: '❝', quote: '“', compare: '⇄', image: '🖼', stat: '%', outro: '★' };

function renderAddPanel() {
  const tg = $('#templateGrid');
  tg.innerHTML = '';
  for (const [k, t] of Object.entries(TEMPLATES)) {
    tg.append(h('button', { class: 'tile', onclick: () => addScene(k) }, h('span', { class: 'big' }, TEMPLATE_ICON[k] || '▣'), t.label, h('small', {}, k)));
  }
  tg.append(h('button', { class: 'tile', onclick: () => addScene(null) }, h('span', { class: 'big' }, '▢'), 'مشهد فاضي', h('small', {}, 'custom')));
  const lg = $('#layerGrid');
  lg.innerHTML = '';
  const items = [
    ['T', 'عنوان', () => ({ type: 'text', text: 'عنوان جديد', font: 'display', size: 96, color: 'ink', in: { type: 'words', duration: 0.8 } })],
    ['t', 'نص', () => ({ type: 'text', text: 'نص جديد', font: 'body', size: 54, weight: 700, color: 'ink', in: { type: 'fadeUp' } })],
    ['▭', 'نص بخلفية', () => ({ type: 'text', text: 'ملاحظة', font: 'body', size: 50, weight: 700, color: 'surface', box: { color: 'accent', radius: 16 }, in: { type: 'pop' } })],
    ['🔢', 'عداد رقم', () => ({ type: 'text', text: '', font: 'display', size: 180, color: 'accent', count: { from: 0, to: 100, suffix: '%' }, in: { type: 'zoomIn' } })],
    ['➜', 'سهم', () => ({ type: 'shape', shape: 'arrow', width: 320, stroke: 'ink', strokeWidth: 7, rough: true, in: { type: 'draw', duration: 0.6 } })],
    ['◯', 'دائرة', () => ({ type: 'shape', shape: 'ellipse', width: 360, height: 260, stroke: 'accent', strokeWidth: 7, rough: true, in: { type: 'draw', duration: 0.8 } })],
    ['▢', 'مستطيل', () => ({ type: 'shape', shape: 'rect', width: 500, height: 300, radius: 24, stroke: 'ink', strokeWidth: 6, in: { type: 'draw', duration: 0.8 } })],
    ['﹏', 'خط تحت', () => ({ type: 'shape', shape: 'underline', width: 420, stroke: 'accent', strokeWidth: 9, rough: true, in: { type: 'draw', duration: 0.6 } })],
    ['▬', 'هايلايت', () => ({ type: 'shape', shape: 'highlight', width: 420, height: 80, fill: 'accent3', in: { type: 'reveal', duration: 0.5 } })],
    ['✓', 'صح', () => ({ type: 'shape', shape: 'check', width: 120, height: 100, stroke: 'accent2', strokeWidth: 12, rough: true, in: { type: 'draw', duration: 0.4 } })],
    ['✕', 'خطأ', () => ({ type: 'shape', shape: 'cross', width: 100, height: 100, stroke: 'accent', strokeWidth: 12, rough: true, in: { type: 'draw', duration: 0.4 } })],
  ];
  for (const [ic, label, make] of items) {
    lg.append(h('button', { class: 'tile', onclick: () => addLayer(make()) }, h('span', { class: 'big' }, ic), label));
  }
}

function addScene(template) {
  commit((p) => {
    const i = sceneIndex();
    const id = uid(template ? `${template}-` : 'scene-', new Set(p.scenes.map((s) => s.id)));
    const sc = { id, duration: template === 'list' || template === 'compare' ? 7 : 5 };
    if (template) { sc.template = template; sc.props = clone(TEMPLATE_DEFAULTS[template] || {}); } else sc.layers = [];
    p.scenes.splice(i + 1, 0, sc);
    S.sel = { scene: id, layer: null };
  });
  const it = timelineItem();
  S.t = it.start + Math.min(it.dur * 0.6, 2);
  switchLeft('scenes');
  draw();
}

function addLayer(layer) {
  const sc = scene();
  if (!sc) return;
  const taken = new Set(engine.layersOf(sc).map((l) => l.id));
  const id = uid(layer.type === 'shape' ? layer.shape : layer.type, taken);
  const it = timelineItem();
  const lt = Math.max(0, Math.min(S.t - it.start, it.dur - 0.5));
  commit(() => {
    sc.layers = sc.layers || [];
    sc.layers.push({ id, x: engine.W / 2, y: engine.H / 2, start: round(lt, 2), ...layer });
    S.sel.layer = id;
  }, { preload: layer.type === 'image' || layer.type === 'video' });
}

// ------------------------------------------------------------------ media

let media = [];
async function renderMedia() {
  try { media = await api(`/api/media?project=${encodeURIComponent(S.name)}`); } catch { media = []; }
  const g = $('#mediaGrid');
  g.innerHTML = '';
  if (!media.length) g.append(h('div', { class: 'hint', style: { gridColumn: '1/-1' } }, 'حط ملفاتك بمجلد media/ أو ارفعها من هون.'));
  for (const m of media) {
    const thumb = m.kind === 'image' ? h('div', { class: 'thumb', style: { backgroundImage: `url("${m.url}")` } })
      : m.kind === 'video' ? h('video', { src: `${m.url}#t=0.5`, muted: true, preload: 'metadata' })
        : h('div', { class: 'thumb' }, '♪');
    const actions = m.kind === 'audio'
      ? h('div', { class: 'actions' },
        h('button', { onclick: (e) => { e.stopPropagation(); addAudio(m.src, 'voice'); } }, 'تعليق'),
        h('button', { onclick: (e) => { e.stopPropagation(); addAudio(m.src, 'music'); } }, 'موسيقى'),
        h('button', { onclick: (e) => { e.stopPropagation(); addAudio(m.src, 'sfx'); } }, 'مؤثر'))
      : h('div', { class: 'actions' },
        h('button', { onclick: (e) => { e.stopPropagation(); addMediaLayer(m); } }, 'طبقة'),
        h('button', { onclick: (e) => { e.stopPropagation(); setBackground(m); } }, 'خلفية'));
    g.append(h('div', { class: 'media-item', title: m.src, onclick: () => (m.kind === 'audio' ? addAudio(m.src, 'music') : addMediaLayer(m)) },
      thumb, h('div', { class: 'mname' }, m.name), actions));
  }
}

function addMediaLayer(m) {
  const w = engine.W * 0.5;
  addLayer({ type: m.kind, src: m.src, width: round(w), radius: 20, shadow: true, in: { type: 'zoomIn', duration: 0.6 }, ...(m.kind === 'image' ? { kenburns: { from: 1, to: 1.1 } } : {}) });
}
function setBackground(m) {
  const sc = scene();
  commit(() => { sc.background = { type: m.kind, src: m.src, dim: 0.25 }; }, { preload: true });
}
function addAudio(src, role) {
  commit((p) => {
    p.audio = p.audio || [];
    const item = { src, role, start: role === 'music' ? 0 : round(S.t, 2), volume: role === 'music' ? 0.35 : 1 };
    if (role === 'music') { item.loop = true; item.fadeOut = 2; }
    p.audio.push(item);
  });
  toast(role === 'voice' ? 'انضاف تعليق صوتي' : role === 'music' ? 'انضافت موسيقى (بتوطى تلقائياً تحت التعليق)' : 'انضاف مؤثر صوتي');
}

async function uploadFiles(files) {
  for (const f of files) {
    try {
      const r = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
      if (!r.ok) throw new Error((await r.json()).error);
      toast(`✓ ${f.name}`);
    } catch (e) {
      toast(`فشل رفع ${f.name}: ${e.message}`, 'err');
    }
  }
  renderMedia();
}

// ------------------------------------------------------------------ transitions panel

let previewTrans = null;
const transCanvases = [];
function demoCard(label, bg, fg) {
  const c = document.createElement('canvas');
  c.width = 192; c.height = 108;
  const x = c.getContext('2d');
  x.fillStyle = bg; x.fillRect(0, 0, 192, 108);
  x.fillStyle = fg; x.font = '800 44px Cairo'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(label, 96, 56);
  return c;
}
let cardA, cardB;
function renderTransitionsPanel() {
  const grid = $('#transGrid');
  const q = $('#transSearch').value.trim().toLowerCase();
  grid.innerHTML = '';
  transCanvases.length = 0;
  const names = transitionNames();
  const all = [
    { name: 'cut', alias: true },
    ...names.aliases.filter((a) => a !== 'cut').map((a) => ({ name: a, alias: true })),
    ...names.shaders.map((n) => ({ name: n, alias: false })),
  ].filter((t) => !q || t.name.toLowerCase().includes(q));
  for (const t of all) {
    const cv = h('canvas', { width: 192, height: 108 });
    const el = h('div', { class: `trans-item${t.alias ? ' alias' : ''}`, 'data-name': t.name, title: t.name, onclick: () => applyTransition(t.name) },
      cv, h('div', {}, t.name));
    let raf = 0;
    el.addEventListener('mouseenter', () => {
      const t0 = performance.now();
      const step = (now) => {
        const p = ((now - t0) / 1200) % 1.4;
        paintTransition(cv, t.name, Math.min(1, p));
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    });
    el.addEventListener('mouseleave', () => { cancelAnimationFrame(raf); paintTransition(cv, t.name, 0.5); });
    grid.append(el);
    transCanvases.push([cv, t.name]);
  }
  paintVisibleTransitions();
  renderTransitionsActive();
}
function paintTransition(cv, name, p) {
  if (!previewTrans) previewTrans = new Transitioner();
  if (!cardA) { cardA = demoCard('A', '#E4572E', '#fff'); cardB = demoCard('B', '#2B2A33', '#F6EFE6'); }
  const ctx = cv.getContext('2d');
  const res = resolveTransition({ type: name });
  const out = res ? previewTrans.render(cardA, cardB, p, res) : null;
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (out) ctx.drawImage(out, 0, 0);
  else ctx.drawImage(p < 0.5 ? cardA : cardB, 0, 0);
}
function paintVisibleTransitions() {
  let i = 0;
  const batch = () => {
    for (let n = 0; n < 12 && i < transCanvases.length; n++, i++) paintTransition(transCanvases[i][0], transCanvases[i][1], 0.5);
    if (i < transCanvases.length) requestAnimationFrame(batch);
  };
  requestAnimationFrame(batch);
}
function renderTransitionsActive() {
  const sc = scene();
  const cur = sc ? (typeof sc.transition === 'string' ? sc.transition : sc.transition?.type) : null;
  for (const el of $$('.trans-item')) el.classList.toggle('active', !!cur && el.dataset.name.toLowerCase() === cur.toLowerCase());
}
function applyTransition(name) {
  const sc = scene();
  if (!sc) return;
  const i = sceneIndex();
  if (i === S.project.scenes.length - 1) toast('هاد آخر مشهد — الانتقال بيتطبق لما تضيف مشهد بعده');
  commit(() => {
    if (name === 'cut') sc.transition = { type: 'cut' };
    else sc.transition = { type: name, duration: sc.transition?.duration ?? 0.8 };
  });
  const next = engine.timeline().items[i + 1];
  if (next) { S.t = next.start + next.tin * 0.45; draw(); }
}

// ------------------------------------------------------------------ inspector

const COLOR_TOKENS = ['ink', 'muted', 'accent', 'accent2', 'accent3', 'bg', 'surface', 'line'];

function field(label, ctl, cls = '') {
  return h('div', { class: `field ${cls}` }, h('label', {}, label), h('div', { class: 'ctl' }, ctl));
}

// Build a control bound to `get()`/`set(v)`.
function control(kind, get, set, opts = {}) {
  const v = get();
  switch (kind) {
    case 'textarea': {
      const el = h('textarea', { rows: opts.rows || 3, dir: 'auto' });
      el.value = v ?? '';
      el.addEventListener('input', () => set(el.value, true));
      el.addEventListener('change', () => set(el.value));
      return el;
    }
    case 'list': {
      const el = h('textarea', { rows: opts.rows || 4, dir: 'auto', placeholder: 'سطر لكل عنصر' });
      el.value = (v || []).join('\n');
      const val = () => el.value.split('\n').map((s) => s.trim()).filter(Boolean);
      el.addEventListener('input', () => set(val(), true));
      el.addEventListener('change', () => set(val()));
      return el;
    }
    case 'number': {
      const el = h('input', { type: 'number', step: opts.step ?? 1, placeholder: opts.placeholder ?? '' });
      el.value = typeof v === 'number' ? round(v, 3) : (v ?? '');
      el.addEventListener('input', () => set(el.value === '' ? undefined : Number(el.value), true));
      el.addEventListener('change', () => set(el.value === '' ? undefined : Number(el.value)));
      return el;
    }
    case 'range': {
      const el = h('input', { type: 'range', min: opts.min ?? 0, max: opts.max ?? 1, step: opts.step ?? 0.01 });
      el.value = v ?? opts.default ?? 1;
      el.addEventListener('input', () => set(Number(el.value), true));
      el.addEventListener('change', () => set(Number(el.value)));
      return el;
    }
    case 'checkbox': {
      const el = h('input', { type: 'checkbox' });
      el.checked = !!v;
      el.addEventListener('change', () => set(el.checked ? (opts.on ?? true) : undefined));
      return el;
    }
    case 'select': {
      const el = h('select', {}, (opts.options || []).map((o) => {
        const [val, lab] = Array.isArray(o) ? o : [o, o];
        return h('option', { value: val }, lab);
      }));
      el.value = v ?? opts.default ?? '';
      el.addEventListener('change', () => set(el.value === '' ? undefined : (opts.numeric ? Number(el.value) : el.value)));
      return el;
    }
    case 'color': {
      const txt = h('input', { type: 'text', list: 'colorTokens', placeholder: opts.placeholder || 'ink', dir: 'ltr' });
      txt.value = v ?? '';
      const resolved = (c) => engine.theme.colors[c] || (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#000000');
      const sw = h('input', { type: 'color' });
      sw.value = resolved(v ?? opts.placeholder);
      txt.addEventListener('change', () => { set(txt.value.trim() || undefined); sw.value = resolved(txt.value.trim()); });
      sw.addEventListener('input', () => { txt.value = sw.value; set(sw.value, true); });
      sw.addEventListener('change', () => set(sw.value));
      return [txt, sw];
    }
    case 'media': {
      const el = h('select', {}, h('option', { value: '' }, '— اختر ملف —'),
        media.filter((m) => !opts.kind || m.kind === opts.kind).map((m) => h('option', { value: m.src }, m.src)));
      if (v && !media.some((m) => m.src === v)) el.append(h('option', { value: v }, v));
      el.value = v ?? '';
      el.addEventListener('change', () => set(el.value || undefined));
      return el;
    }
    default: {
      const el = h('input', { type: 'text', dir: 'auto' });
      el.value = v ?? '';
      el.addEventListener('input', () => set(el.value, true));
      el.addEventListener('change', () => set(el.value));
      return el;
    }
  }
}

// Live edits ("input") update without a history entry; "change" records one.
let liveBefore = null;
function makeSetter(apply) {
  return (v, live) => {
    if (live) {
      if (!liveBefore) liveBefore = JSON.stringify(S.project);
      apply(v);
      engine.invalidate();
      save();
      draw();
      return;
    }
    if (liveBefore) { S.history.push(liveBefore); S.future = []; liveBefore = null; apply(v); engine.invalidate(); save(); refresh({ skipInspector: true }); return; }
    commit(() => apply(v), { skipInspector: true });
  };
}

function layerFields(L) {
  const common = [
    ['group', 'الموضع'],
    ['pair', [['x', 'X', 'number'], ['y', 'Y', 'number']]],
    ['scale', 'تكبير', 'number', { step: 0.05, placeholder: '1' }],
    ['rotate', 'دوران°', 'number', { placeholder: '0' }],
    ['opacity', 'الشفافية', 'range', { default: 1 }],
    ['group', 'التوقيت (ثواني داخل المشهد)'],
    ['pair', [['start', 'من', 'number', { step: 0.1, placeholder: '0' }], ['end', 'لـ', 'number', { step: 0.1, placeholder: 'آخر' }]]],
    ['group', 'الحركة'],
    ['in.type', 'دخول', 'select', { options: ANIMATIONS.map((a) => (a === 'none' ? ['', 'بدون'] : a)) }],
    ['pair', [['in.duration', 'مدة', 'number', { step: 0.1, placeholder: '0.7' }], ['in.delay', 'تأخير', 'number', { step: 0.1, placeholder: '0' }]]],
    ['in.ease', 'Easing', 'select', { options: [['', 'تلقائي'], ...Object.keys(EASINGS)] }],
    ['out.type', 'خروج', 'select', { options: ANIMATIONS.map((a) => (a === 'none' ? ['', 'بدون'] : a)) }],
    ['out.duration', 'مدة الخروج', 'number', { step: 0.1, placeholder: '0.5' }],
    ['loop.type', 'حركة مستمرة', 'select', { options: LOOPS.map((a) => (a === 'none' ? ['', 'بدون'] : a)) }],
    ['loop.amount', 'قوتها', 'number', { step: 0.01 }],
  ];
  const specific = {
    text: [
      ['group', 'النص'],
      ['text', 'النص', 'textarea'],
      ['font', 'الخط', 'select', { options: [['', 'body'], 'display', 'Cairo', 'Tajawal'] }],
      ['pair', [['size', 'حجم', 'number', { placeholder: '64' }], ['weight', 'وزن', 'select', { options: [['', 'auto'], '400', '500', '700', '800'], numeric: true }]]],
      ['color', 'اللون', 'color', { placeholder: 'ink' }],
      ['align', 'المحاذاة', 'select', { options: [['', 'وسط'], ['right', 'يمين'], ['left', 'يسار']] }],
      ['maxWidth', 'أقصى عرض', 'number'],
      ['lineHeight', 'تباعد الأسطر', 'number', { step: 0.05, placeholder: '1.3' }],
      ['highlight', 'كلمات مميزة', 'list', { rows: 2 }],
      ['highlightStyle', 'ستايل التمييز', 'select', { options: [['', 'تلقائي'], ['color', 'لون'], ['marker', 'ماركر'], ['underline', 'خط تحت']] }],
      ['highlightColor', 'لون التمييز', 'color', { placeholder: 'accent' }],
      ['box.color', 'خلفية النص', 'color', { placeholder: '' }],
      ['box.radius', 'تدوير الخلفية', 'number'],
      ['stroke.color', 'إطار الحروف', 'color', { placeholder: '' }],
      ['stroke.width', 'سماكة الإطار', 'number'],
    ],
    image: [
      ['group', 'الصورة'],
      ['src', 'الملف', 'media', { kind: 'image' }],
      ['pair', [['width', 'W', 'number'], ['height', 'H', 'number']]],
      ['fit', 'الملاءمة', 'select', { options: [['', 'cover'], 'contain'] }],
      ['radius', 'تدوير الزوايا', 'number'],
      ['mask', 'قناع', 'select', { options: [['', 'بدون'], ['circle', 'دائرة']] }],
      ['kenburns', 'زوم بطيء', 'checkbox', { on: { from: 1, to: 1.12 } }],
      ['shadow', 'ظل', 'checkbox'],
      ['border.color', 'إطار', 'color', { placeholder: '' }],
      ['border.width', 'سماكة الإطار', 'number'],
      ['filter', 'فلتر CSS', 'text'],
    ],
    shape: [
      ['group', 'الشكل'],
      ['shape', 'النوع', 'select', { options: SHAPES }],
      ['pair', [['width', 'W', 'number'], ['height', 'H', 'number']]],
      ['stroke', 'لون الخط', 'color', { placeholder: 'accent' }],
      ['strokeWidth', 'سماكة الخط', 'number'],
      ['fill', 'التعبئة', 'color', { placeholder: '' }],
      ['rough', 'رسم يدوي', 'checkbox'],
      ['roughness', 'خشونة الرسم', 'number', { step: 0.1, placeholder: '1.3' }],
      ['curve', 'انحناء', 'number', { step: 0.05 }],
      ['radius', 'تدوير الزوايا', 'number'],
    ],
  };
  specific.video = [
    ...specific.image.filter(([k]) => k !== 'kenburns' && k !== 'src').map((f) => (f[0] === 'group' ? ['group', 'الفيديو'] : f)),
    ['src', 'الملف', 'media', { kind: 'video' }],
    ['trim', 'يبدأ من ث', 'number', { step: 0.1 }],
    ['speed', 'السرعة', 'number', { step: 0.1, placeholder: '1' }],
    ['volume', 'الصوت', 'range', { default: 1 }],
    ['muted', 'كتم الصوت', 'checkbox'],
    ['repeat', 'تكرار', 'checkbox'],
  ];
  return [...(specific[L.type] || []), ...common];
}

function buildFields(container, defs, get, set) {
  for (const d of defs) {
    if (d[0] === 'group') { container.append(h('div', { class: 'gtitle' }, d[1])); continue; }
    if (d[0] === 'pair') {
      const row = h('div', { class: 'pair' });
      for (const [path, label, kind, opts] of d[1]) row.append(field(label, control(kind, () => get(path), (v, live) => set(path, v, live), opts || {})));
      container.append(row);
      continue;
    }
    const [path, label, kind, opts] = d;
    container.append(field(label, control(kind, () => get(path), (v, live) => set(path, v, live), opts || {}), kind === 'textarea' || kind === 'list' ? 'wide' : ''));
  }
}

function renderInspector() {
  const box = $('#inspector');
  box.innerHTML = '';
  const sc = scene();
  if (!sc) return;
  if (S.sel.layer) {
    const L = effLayer(sc, S.sel.layer);
    if (!L) { S.sel.layer = null; return renderInspector(); }
    box.append(h('div', { class: 'insp-head' },
      h('span', { class: 'title' }, `${TYPE_ICON[L.type] || ''} ${L.id}`),
      L._tpl ? h('span', { class: 'chip tpl', title: 'تعديلاتك بتنحفظ بـ overrides' }, 'من القالب') : h('span', { class: 'chip' }, L.type)));
    const grp = h('div', { class: 'group' });
    buildFields(grp, layerFields(L), (p) => getPath(effLayer(sc, L.id) || {}, p),
      (p, v, live) => makeSetter((val) => patchLayer(sc, L.id, { [p]: val }))(v, live));
    box.append(grp);
    const raw = rawLayer(sc, L.id);
    box.append(h('div', { class: 'insp-actions' },
      raw ? h('button', { onclick: () => duplicateLayer(sc, L.id) }, '⧉ نسخ') : null,
      raw ? h('button', { onclick: () => reorderLayer(sc, L.id, 1) }, '⬆ لقدام') : null,
      raw ? h('button', { onclick: () => reorderLayer(sc, L.id, -1) }, '⬇ لورا') : null,
      L._tpl && sc.overrides?.[L.id] ? h('button', { onclick: () => commit(() => { delete sc.overrides[L.id]; if (!Object.keys(sc.overrides).length) delete sc.overrides; }) }, '↺ رجّع الأصل') : null,
      h('button', { class: 'danger', onclick: () => deleteLayer(sc, L.id) }, raw ? '✕ حذف' : '✕ إخفاء')));
    return;
  }
  // Scene inspector
  box.append(h('div', { class: 'insp-head' }, h('span', { class: 'title' }, `🎬 ${sc.id}`), h('span', { class: 'chip' }, TEMPLATES[sc.template]?.label || 'مخصص')));
  const g = h('div', { class: 'group' });
  const sget = (p) => getPath(sc, p);
  const sset = (p, v, live) => makeSetter((val) => {
    if (p === 'id') {
      const nv = String(val || '').trim().replace(/\s+/g, '-');
      if (!nv || S.project.scenes.some((s) => s !== sc && s.id === nv)) return;
      sc.id = nv; S.sel.scene = nv; return;
    }
    if (p === '_camera') { if (val === 'custom') return; if (CAMERAS[val]) sc.camera = clone(CAMERAS[val]); else delete sc.camera; return; }
    setPath(sc, p, val);
  })(v, live);
  const tnames = transitionNames();
  const defs = [
    ['group', 'المشهد'],
    ['id', 'الاسم (id)', 'text'],
    ['duration', 'المدة (ث)', 'number', { step: 0.1 }],
    ['transition.type', 'الانتقال للتالي', 'select', { options: [['', `افتراضي (${S.project.defaultTransition?.type || 'cut'})`], ...tnames.aliases, ...tnames.shaders] }],
    ['transition.duration', 'مدة الانتقال', 'number', { step: 0.1, placeholder: '0.8' }],
    ['_camera', 'حركة الكاميرا', 'select', { options: [['', 'ثابتة'], ['zoomIn', 'زوم لجوا'], ['zoomOut', 'زوم لبرا'], ['panLeft', 'تحريك يسار'], ['panRight', 'تحريك يمين'], ['custom', 'مخصصة (JSON)']] }],
  ];
  buildFields(g, defs, (p) => (p === '_camera' ? cameraName(sc.camera) : sget(p)), sset);
  // background
  const bg = sc.background;
  const bgKind = !bg ? '' : typeof bg === 'string' ? 'solid' : bg.type;
  g.append(field('الخلفية', control('select', () => bgKind, makeSetter((v) => {
    if (!v) delete sc.background;
    else if (v === 'solid') sc.background = { type: 'solid', color: 'bg' };
    else if (v === 'gradient') sc.background = { type: 'gradient', colors: ['bg', 'surface'], angle: 135 };
    else if (v === 'radial') sc.background = { type: 'radial', colors: ['surface', 'bg'] };
    else if (v === 'pattern') sc.background = { type: 'pattern', pattern: 'grid', size: 50 };
    else if (v === 'image') sc.background = { type: 'image', src: '', dim: 0.25 };
  }), { options: [['', 'من الثيم'], ['solid', 'لون'], ['gradient', 'تدرج'], ['radial', 'تدرج دائري'], ['pattern', 'نقش'], ['image', 'صورة']] })));
  if (bgKind === 'solid') buildFields(g, [['background.color', 'لون الخلفية', 'color']], sget, sset);
  if (bgKind === 'pattern') buildFields(g, [['background.pattern', 'النقش', 'select', { options: ['dots', 'grid', 'lines'] }], ['background.color', 'لون النقش', 'color', { placeholder: 'line' }], ['background.size', 'المسافة', 'number']], sget, sset);
  if (bgKind === 'image') buildFields(g, [['background.src', 'الصورة', 'media', { kind: 'image' }], ['background.dim', 'تعتيم', 'range', { default: 0 }], ['background.blur', 'Blur', 'number']], sget, sset);
  box.append(g);

  if (sc.template && TEMPLATES[sc.template]) {
    const tg = h('div', { class: 'group' }, h('div', { class: 'gtitle' }, `محتوى القالب: ${TEMPLATES[sc.template].label}`));
    const tdefs = Object.entries(TEMPLATES[sc.template].props).map(([k, ty]) => {
      const kind = ty === 'string[]' ? 'list' : ty === 'number' ? 'number' : ty === 'boolean' ? 'checkbox' : (k === 'src' ? 'media' : (['text', 'title', 'subtitle'].includes(k) ? 'textarea' : 'text'));
      return [`props.${k}`, k, kind, kind === 'media' ? { kind: 'image' } : { rows: 2 }];
    });
    if (['title', 'statement'].includes(sc.template)) tdefs.push(['props.highlight', 'highlight', 'list', { rows: 2 }]);
    buildFields(tg, tdefs, sget, sset);
    box.append(tg);
  }
  const ng = h('div', { class: 'group' }, h('div', { class: 'gtitle' }, 'سكربت / ملاحظات المشهد'));
  buildFields(ng, [['notes', '', 'textarea', { rows: 3 }]], sget, sset);
  box.append(ng);

  // Project settings
  const pg = h('div', { class: 'group' }, h('div', { class: 'gtitle' }, 'إعدادات الفيديو'));
  const pget = (p) => (p === '_size' ? `${S.project.width}x${S.project.height}` : getPath(S.project, p));
  const pset = (p, v, live) => makeSetter((val) => {
    if (p === '_size') { const [w, hh] = String(val).split('x').map(Number); S.project.width = w; S.project.height = hh; return; }
    setPath(S.project, p, val);
  })(v, live);
  buildFields(pg, [
    ['title', 'العنوان', 'text'],
    ['theme', 'الثيم', 'select', { options: Object.entries(THEMES).map(([k, t]) => [k, t.label]) }],
    ['_size', 'المقاس', 'select', { options: [['1920x1080', 'يوتيوب 16:9 (1080p)'], ['1080x1920', 'Shorts 9:16'], ['1080x1080', 'مربع 1:1'], ['2560x1440', '1440p']] }],
    ['fps', 'FPS', 'select', { options: [24, 25, 30, 60], numeric: true }],
    ['defaultTransition.type', 'انتقال افتراضي', 'select', { options: [['', 'بدون'], ...tnames.aliases, ...tnames.shaders] }],
    ['defaultTransition.duration', 'مدته', 'number', { step: 0.1 }],
    ['transitionSfx', 'صوت الانتقال', 'media', { kind: 'audio' }],
  ], pget, (p, v, live) => { pset(p, v, live); if (p === '_size' && !live) setTimeout(() => { engine.setProject(S.project); engine.resize(S.quality); layoutStage(); refresh(); }, 0); });
  box.append(pg);

  const ag = h('div', { class: 'group' }, h('div', { class: 'gtitle' }, 'الصوت'));
  (S.project.audio || []).forEach((a, i) => {
    ag.append(h('div', { class: 'audio-row' },
      h('span', { class: 'an', title: a.src }, a.src.split('/').pop()),
      control('select', () => a.role || 'music', makeSetter((v) => { a.role = v; }), { options: [['voice', 'تعليق'], ['music', 'موسيقى'], ['sfx', 'مؤثر']] }),
      control('number', () => a.volume ?? 1, makeSetter((v) => { a.volume = v; }), { step: 0.05 }),
      h('button', { class: 'danger', onclick: () => commit((p) => p.audio.splice(i, 1)) }, '✕')));
  });
  if (!(S.project.audio || []).length) ag.append(h('div', { class: 'hint' }, 'ضيف صوت من تبويب الملفات.'));
  box.append(ag);
}

const CAMERAS = {
  zoomIn: { from: { zoom: 1 }, to: { zoom: 1.12 } },
  zoomOut: { from: { zoom: 1.12 }, to: { zoom: 1 } },
  panLeft: { from: { zoom: 1.1, x: 60 }, to: { zoom: 1.1, x: -60 } },
  panRight: { from: { zoom: 1.1, x: -60 }, to: { zoom: 1.1, x: 60 } },
};
function cameraName(c) {
  if (!c) return '';
  const j = JSON.stringify(c);
  return Object.keys(CAMERAS).find((k) => JSON.stringify(CAMERAS[k]) === j) || 'custom';
}

function duplicateLayer(sc, id) {
  const raw = rawLayer(sc, id);
  const taken = new Set(engine.layersOf(sc).map((l) => l.id));
  commit(() => {
    const c = clone(raw);
    c.id = uid(`${id.replace(/\d+$/, '')}`, taken);
    if (c.x != null) c.x += 30;
    if (c.y != null) c.y += 30;
    if (c.points) c.points = c.points.map(([x, y]) => [x + 30, y + 30]);
    sc.layers.push(c);
    S.sel.layer = c.id;
  });
}
function reorderLayer(sc, id, d) {
  const i = sc.layers.findIndex((l) => l.id === id);
  const j = i + d;
  if (j < 0 || j >= sc.layers.length) return;
  commit(() => { const [l] = sc.layers.splice(i, 1); sc.layers.splice(j, 0, l); });
}
function deleteLayer(sc, id) {
  commit(() => {
    if (rawLayer(sc, id)) sc.layers = sc.layers.filter((l) => l.id !== id);
    else patchLayer(sc, id, { hidden: true });
    S.sel.layer = null;
  });
}

// ------------------------------------------------------------------ JSON pane (code view of the selection)

function renderJson() {
  if ($('#jsonPane').classList.contains('hidden')) return;
  const ta = $('#jsonText');
  if (document.activeElement === ta) return;
  const sc = scene();
  let obj, hint;
  if (S.sel.layer && rawLayer(sc, S.sel.layer)) { obj = rawLayer(sc, S.sel.layer); hint = `scenes › ${sc.id} › layers › ${S.sel.layer}`; }
  else if (S.sel.layer) { obj = sc.overrides?.[S.sel.layer] || {}; hint = `scenes › ${sc.id} › overrides › ${S.sel.layer} (طبقة قالب)`; }
  else if (sc) { obj = sc; hint = `scenes › ${sc.id}`; }
  ta.value = JSON.stringify(obj, null, 2);
  $('#jsonHint').textContent = hint;
  $('#jsonError').textContent = '';
}
function applyJson() {
  let v;
  try { v = JSON.parse($('#jsonText').value); } catch (e) { $('#jsonError').textContent = e.message; return; }
  const sc = scene();
  commit(() => {
    if (S.sel.layer && rawLayer(sc, S.sel.layer)) {
      const i = sc.layers.findIndex((l) => l.id === S.sel.layer);
      sc.layers[i] = v;
      S.sel.layer = v.id;
    } else if (S.sel.layer) {
      sc.overrides = sc.overrides || {};
      sc.overrides[S.sel.layer] = v;
    } else {
      const i = sceneIndex();
      S.project.scenes[i] = v;
      S.sel.scene = v.id;
    }
  }, { preload: true });
  toast('✓ انطبق');
}

// ------------------------------------------------------------------ timeline

function renderTimeline() {
  const content = $('#tlContent');
  const labels = $('#tlLabels');
  content.innerHTML = '';
  labels.innerHTML = '';
  const tl = engine.timeline();
  const pps = S.pps;
  const width = Math.max(tl.duration * pps + 200, $('#tlScroll').clientWidth);
  content.style.width = `${width}px`;

  // ruler
  const ruler = h('div', { class: 'tl-ruler' });
  const step = pps > 120 ? 0.5 : pps > 50 ? 1 : pps > 20 ? 2 : 5;
  for (let t = 0; t <= tl.duration + step; t += step) {
    ruler.append(h('div', { class: 'tick', style: { left: `${t * pps}px` } }, Number.isInteger(t) ? fmt(t).replace(/\.00$/, '') : ''));
  }
  content.append(ruler);
  const scrub = (e) => {
    const r = content.getBoundingClientRect();
    seek((e.clientX - r.left) / pps);
  };
  ruler.addEventListener('pointerdown', (e) => {
    ruler.setPointerCapture(e.pointerId);
    scrub(e);
    const mv = (ev) => scrub(ev);
    ruler.addEventListener('pointermove', mv);
    ruler.addEventListener('pointerup', () => ruler.removeEventListener('pointermove', mv), { once: true });
  });

  const addRow = (label, cls = '') => {
    labels.append(h('div', { class: `tl-label ${cls}` }, label));
    const row = h('div', { class: 'tl-row' });
    content.append(row);
    return row;
  };

  // scenes row
  const srow = addRow('المشاهد', 'sel');
  tl.items.forEach((it, i) => {
    const clip = h('div', {
      class: `clip scene${it.scene.id === S.sel.scene ? ' active' : ''}`,
      style: { left: `${it.start * pps}px`, width: `${it.dur * pps - 2}px` },
      title: `${it.scene.id} — ${round(it.dur, 2)}ث`,
    }, `${i + 1}. ${it.scene.id}`);
    clip.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('edge')) return;
      S.sel = { scene: it.scene.id, layer: null };
      seek(Math.max(it.start, (e.clientX - content.getBoundingClientRect().left) / pps));
      refresh({ thumbs: false });
    });
    const edge = h('div', { class: 'edge r', title: 'اسحب لتغيير المدة' });
    dragEdge(edge, it.dur, (v) => { it.scene.duration = Math.max(0.5, round(v, 2)); });
    clip.append(edge);
    srow.append(clip);
    if (it.tin > 0) srow.append(h('div', { class: 'trans-mark', style: { left: `${it.start * pps}px`, width: `${it.tin * pps}px` }, title: it.spec?.type }));
  });

  // layers of the selected scene
  const sc = scene();
  const it = timelineItem();
  if (sc && it) {
    for (const L of [...engine.layersOf(sc)].reverse()) {
      const label = L.type === 'text' ? (L.text || L.id) : L.id;
      const row = addRow(String(label).slice(0, 18), L.id === S.sel.layer ? 'sel' : '');
      const st = L.start ?? 0, en = Math.min(L.end ?? it.dur, it.dur);
      const clip = h('div', {
        class: `clip layer ${L.type}${L.id === S.sel.layer ? ' active' : ''}${L._tpl ? ' tpl' : ''}`,
        style: { left: `${(it.start + st) * pps}px`, width: `${Math.max(6, (en - st) * pps - 2)}px` },
        title: `${L.id}: ${round(st, 2)} → ${round(en, 2)}`,
      }, L.id);
      const el = h('div', { class: 'edge l' }), er = h('div', { class: 'edge r' });
      clip.append(el, er);
      clip.addEventListener('pointerdown', (e) => {
        if (e.target.classList.contains('edge')) return;
        S.sel.layer = L.id;
        refresh({ thumbs: false });
        const x0 = e.clientX;
        const before = JSON.stringify(S.project);
        let moved = false;
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        const mv = (ev) => {
          const d = round((ev.clientX - x0) / pps, 2);
          const ns = Math.max(0, Math.min(it.dur - (en - st), st + d));
          patchLayer(sc, L.id, { start: round(ns, 2), end: L.end != null ? round(ns + (en - st), 2) : undefined });
          moved = true;
          engine.invalidate();
          target.style.left = `${(it.start + ns) * pps}px`;
          draw();
        };
        target.addEventListener('pointermove', mv);
        target.addEventListener('pointerup', () => {
          target.removeEventListener('pointermove', mv);
          if (moved) { S.history.push(before); S.future = []; save(); refresh(); }
        }, { once: true });
      });
      dragEdge(el, st, (v) => patchLayer(sc, L.id, { start: Math.max(0, Math.min(round(v, 2), en - 0.1)) }), -1);
      dragEdge(er, en, (v) => patchLayer(sc, L.id, { end: Math.min(it.dur, Math.max(round(v, 2), st + 0.1)) }));
      row.append(clip);
    }
  }

  // audio
  const plan = engine.audioPlan().filter((a) => a.role !== 'video');
  if (plan.length) {
    const arow = addRow('الصوت');
    plan.forEach((a) => {
      const w = (a.duration ?? Math.max(1, tl.duration - a.start)) * pps;
      arow.append(h('div', { class: 'clip audio', style: { left: `${a.start * pps}px`, width: `${Math.max(8, w - 2)}px` }, title: a.src }, `♪ ${a.src.split('/').pop()}`));
    });
  }

  content.append(h('div', { class: 'playhead', id: 'playhead', style: { left: `${S.t * pps}px` } }));
}

// Drag a clip edge horizontally; `apply(newValue)` receives seconds.
function dragEdge(edge, startVal, apply) {
  edge.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const x0 = e.clientX;
    const before = JSON.stringify(S.project);
    edge.setPointerCapture(e.pointerId);
    let moved = false;
    const mv = (ev) => {
      apply(startVal + (ev.clientX - x0) / S.pps);
      moved = true;
      engine.invalidate();
      draw();
    };
    edge.addEventListener('pointermove', mv);
    edge.addEventListener('pointerup', () => {
      edge.removeEventListener('pointermove', mv);
      if (moved) { S.history.push(before); S.future = []; save(); refresh(); }
    }, { once: true });
  });
}

// ------------------------------------------------------------------ export

function openExport() {
  const card = $('#modalCard');
  card.innerHTML = '';
  const scaleSel = h('select', {}, h('option', { value: '1' }, `${engine.W}×${engine.H} (أصلي)`), h('option', { value: '2' }, `${engine.W * 2}×${engine.H * 2} (4K)`), h('option', { value: '0.6667' }, `${Math.round(engine.W * 0.6667)}×${Math.round(engine.H * 0.6667)} (سريع)`));
  const fpsSel = h('select', {}, [24, 25, 30, 60].map((f) => h('option', { value: f }, f)));
  fpsSel.value = String(engine.fps);
  card.append(
    h('h3', {}, '⬇ تصدير الفيديو MP4'),
    h('div', { class: 'hint' }, `المدة ${fmt(engine.duration)} — التصدير بيصير على جهازك عن طريق Playwright + ffmpeg، والنتيجة مطابقة للمعاينة فريم بفريم.`),
    field('الدقة', scaleSel), field('FPS', fpsSel),
    h('div', { class: 'progress hidden', id: 'expProg' }, h('div')),
    h('div', { class: 'hint', id: 'expStatus' }),
    h('div', { id: 'expResult' }),
    h('div', { class: 'row', style: { marginTop: '12px' } },
      h('button', { class: 'primary', id: 'expGo', onclick: async () => {
        await saveNow();
        try {
          await api(`/api/render/${encodeURIComponent(S.name)}`, { method: 'POST', body: JSON.stringify({ scale: Number(scaleSel.value), fps: Number(fpsSel.value) }), headers: { 'Content-Type': 'application/json' } });
          $('#expGo').disabled = true;
          $('#expProg').classList.remove('hidden');
          $('#expStatus').textContent = 'بلّش التصدير…';
        } catch (e) { $('#expStatus').textContent = e.message; }
      } }, 'ابدأ التصدير'),
      h('button', { onclick: () => $('#modal').classList.add('hidden') }, 'إغلاق')),
  );
  $('#modal').classList.remove('hidden');
}

function onRenderEvent(r) {
  if (r.project !== S.name) return;
  const bar = $('#expProg > div');
  if (!bar) return;
  if (r.status === 'running') {
    $('#expProg').classList.remove('hidden');
    const p = r.total ? r.frame / r.total : 0;
    bar.style.width = `${(p * 100).toFixed(1)}%`;
    const el = (Date.now() / 1000 - r.started);
    const eta = p > 0.02 ? el / p - el : 0;
    $('#expStatus').textContent = `${r.frame} / ${r.total} فريم${eta ? ` — باقي تقريباً ${Math.ceil(eta)}ث` : ''}`;
    if ($('#expGo')) $('#expGo').disabled = true;
  } else if (r.status === 'done' && r.file) {
    bar.style.width = '100%';
    $('#expStatus').textContent = '✓ خلص التصدير';
    const url = `/${r.file}?v=${Date.now()}`;
    $('#expResult').innerHTML = '';
    $('#expResult').append(h('video', { src: url, controls: true }), h('div', { class: 'row', style: { marginTop: '8px' } }, h('a', { href: url, download: r.file.split('/').pop() }, h('button', { class: 'primary' }, '⬇ تنزيل الفيديو')), h('span', { class: 'hint' }, r.file)));
    if ($('#expGo')) $('#expGo').disabled = false;
  } else if (r.status === 'error') {
    $('#expStatus').textContent = `✗ فشل التصدير: ${r.error || ''}`;
    if ($('#expGo')) $('#expGo').disabled = false;
  }
}

// ------------------------------------------------------------------ chrome & shortcuts

function switchLeft(tab) {
  for (const b of $$('#leftTabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const s of $$('.left .tab-body')) s.classList.toggle('hidden', s.dataset.body !== tab);
  if (tab === 'transitions' && !$('#transGrid').children.length) renderTransitionsPanel();
  if (tab === 'scenes') renderThumbsSoon();
}

function initChrome() {
  for (const b of $$('#leftTabs button')) b.addEventListener('click', () => switchLeft(b.dataset.tab));
  for (const b of $$('#rightTabs button')) b.addEventListener('click', () => {
    for (const x of $$('#rightTabs button')) x.classList.toggle('active', x === b);
    $('#inspector').classList.toggle('hidden', b.dataset.tab !== 'props');
    $('#jsonPane').classList.toggle('hidden', b.dataset.tab !== 'json');
    renderJson();
  });
  $('#jsonApply').addEventListener('click', applyJson);
  $('#playBtn').addEventListener('click', () => (S.playing ? pause() : play()));
  $('#toStart').addEventListener('click', () => seek(0));
  $('#toEnd').addEventListener('click', () => seek(engine.duration));
  $('#loopChk').addEventListener('change', (e) => { S.loop = e.target.checked; });
  $('#qualitySel').addEventListener('change', (e) => { S.quality = Number(e.target.value); engine.resize(S.quality); draw(); });
  $('#zoomRange').addEventListener('input', (e) => { S.pps = Number(e.target.value); renderTimeline(); });
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#exportBtn').addEventListener('click', openExport);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });
  $('#projectSelect').addEventListener('change', (e) => openProject(e.target.value));
  $('#newProject').addEventListener('click', async () => {
    const name = prompt('اسم المشروع (حروف وأرقام وشرطات):', 'new-video');
    if (!name) return;
    try {
      await api('/api/projects', { method: 'POST', body: JSON.stringify({ name }), headers: { 'Content-Type': 'application/json' } });
      await loadProjectList();
      openProject(name);
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#transSearch').addEventListener('input', debounce(renderTransitionsPanel, 150));
  $('#uploadInput').addEventListener('change', (e) => uploadFiles([...e.target.files]));
  const up = $('.upload');
  const media = $('[data-body="media"]');
  media.addEventListener('dragover', (e) => { e.preventDefault(); up.classList.add('drag'); });
  media.addEventListener('dragleave', () => up.classList.remove('drag'));
  media.addEventListener('drop', (e) => { e.preventDefault(); up.classList.remove('drag'); uploadFiles([...e.dataTransfer.files]); });
  document.body.append(h('datalist', { id: 'colorTokens' }, COLOR_TOKENS.map((c) => h('option', { value: c }))));

  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') { e.preventDefault(); S.playing ? pause() : play(); }
    else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); const sc = scene(); if (S.sel.layer && rawLayer(sc, S.sel.layer)) duplicateLayer(sc, S.sel.layer); }
    else if (e.key === 'ArrowRight' && !S.sel.layer) seek(S.t + (e.shiftKey ? 1 : 1 / engine.fps));
    else if (e.key === 'ArrowLeft' && !S.sel.layer) seek(S.t - (e.shiftKey ? 1 : 1 / engine.fps));
    else if (e.key.startsWith('Arrow') && S.sel.layer) {
      e.preventDefault();
      const sc = scene(); const L = effLayer(sc, S.sel.layer);
      const d = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
      const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
      commit(() => patchLayer(sc, L.id, { x: (L.x ?? 0) + dx, y: (L.y ?? 0) + dy }));
    }
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'End') seek(engine.duration);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel.layer) deleteLayer(scene(), S.sel.layer);
    else if (e.key === 'Escape') { S.sel.layer = null; refresh({ thumbs: false }); }
  });
}

// ------------------------------------------------------------------ bridge for AI agents driving the browser

window.studio = {
  /** The live project object (read-only view; use the methods below to change it). */
  getProject: () => clone(S.project),
  /** Replace the whole project. */
  setProject: (p) => commit((cur) => { Object.keys(cur).forEach((k) => delete cur[k]); Object.assign(cur, clone(p)); }, { preload: true }),
  /** Set a value by path, e.g. update('scenes.intro.duration', 6) or update('scenes.intro.layers.title.size', 120). Scene/layer segments may be ids. */
  update(path, value) {
    commit((p) => {
      const ks = path.split('.');
      let cur = p;
      for (let i = 0; i < ks.length - 1; i++) {
        let next = cur[ks[i]];
        if (Array.isArray(cur) && next === undefined) next = cur.find((x) => x?.id === ks[i]);
        cur = next;
        if (cur == null) throw new Error(`path not found: ${ks.slice(0, i + 1).join('.')}`);
      }
      const last = ks[ks.length - 1];
      if (Array.isArray(cur) && !(last in cur)) { const j = cur.findIndex((x) => x?.id === last); cur[j] = value; } else cur[last] = value;
    }, { preload: true });
  },
  patchLayer: (sceneId, layerId, patch) => commit(() => patchLayer(scene(sceneId), layerId, patch), { preload: true }),
  addLayer: (sceneId, layer) => commit(() => { const sc = scene(sceneId); sc.layers = sc.layers || []; sc.layers.push(layer); }, { preload: true }),
  removeLayer: (sceneId, layerId) => deleteLayer(scene(sceneId), layerId),
  addScene: (sc, index) => commit((p) => p.scenes.splice(index ?? p.scenes.length, 0, sc), { preload: true }),
  removeScene: (sceneId) => deleteScene(sceneIndex(sceneId)),
  select: (sceneId, layerId = null) => { S.sel = { scene: sceneId, layer: layerId }; refresh({ thumbs: false }); },
  seek: (t) => seek(t),
  play, pause,
  get time() { return S.t; },
  get duration() { return engine.duration; },
  timeline: () => engine.timeline().items.map((it) => ({ id: it.scene.id, start: it.start, end: it.end })),
  snapshot: (t) => { if (t != null) seek(t); return canvas.toDataURL('image/png'); },
  undo, redo,
  save: saveNow,
};

// ------------------------------------------------------------------ boot

(async function boot() {
  initChrome();
  initStage();
  renderAddPanel();
  await loadProjectList();
  const want = new URLSearchParams(location.search).get('project');
  let name = projects.find((p) => p.name === want)?.name || projects[0]?.name;
  if (!name) {
    await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'my-first-video' }), headers: { 'Content-Type': 'application/json' } });
    await loadProjectList();
    name = 'my-first-video';
  }
  await openProject(name);
})().catch((e) => { console.error(e); toast(`خطأ: ${e.message}`, 'err'); });
