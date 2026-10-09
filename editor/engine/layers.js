// Layer drawing: text, image, video and shape. Each layer is drawn centered on (x, y)
// in project pixels, after the animated state from anim.js is applied.

import rough from '../lib/rough.esm.js';
import { color, fontFamily } from './themes.js';
import { clamp01, ease, lerp } from './anim.js';

const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const PUNCT_RE = /[.,،!؟?:;"'«»()\-–—]/g;
const generator = rough.generator();

export const LAYER_TYPES = ['text', 'image', 'video', 'shape'];
export const SHAPES = ['rect', 'circle', 'ellipse', 'line', 'arrow', 'underline', 'highlight', 'check', 'cross'];

export const isRtl = (text) => RTL_RE.test(String(text || ''));

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0) % 100000 + 1;
}

class LRU extends Map {
  constructor(max) { super(); this.max = max; }
  put(k, v) { if (this.size > this.max) this.clear(); this.set(k, v); return v; }
}
const textCache = new LRU(600);
const roughCache = new LRU(400);
const lengthCache = new LRU(2000);

// ---------------------------------------------------------------- text

function textValue(L, t) {
  if (!L.count) return String(L.text ?? '');
  const c = L.count;
  const start = (L.start ?? 0) + (L.in?.delay ?? 0);
  const dur = c.duration ?? 1.6;
  const v = lerp(c.from ?? 0, c.to ?? 100, ease(c.ease || 'outCubic', (t - start) / dur));
  let s = v.toFixed(c.decimals ?? 0);
  if (c.separator) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, c.separator);
  if (c.arabicDigits) s = s.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);
  return (c.prefix ?? '') + s + (c.suffix ?? '');
}

function layoutText(ctx, L, env, text) {
  const th = env.theme;
  const size = L.size ?? 64;
  const weight = L.weight ?? (L.font === 'display' ? 800 : 700);
  const font = `${weight} ${size}px ${fontFamily(th, L.font || 'body')}`;
  const rtl = L.dir ? L.dir === 'rtl' : isRtl(text);
  const maxW = L.maxWidth ?? env.W * 0.84;
  const ls = L.letterSpacing ?? 0;
  const boxed = (L.align === 'left' || L.align === 'right') && L.maxWidth;
  const key = `${font}|${maxW}|${rtl}|${ls}|${boxed ? 1 : 0}|${text}`;
  const hit = textCache.get(key);
  if (hit) return hit;

  ctx.save();
  ctx.font = font;
  ctx.letterSpacing = `${ls}px`;
  const space = ctx.measureText(' ').width;
  const lines = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let cur = [], w = 0;
    for (const word of words) {
      const ww = ctx.measureText(word).width;
      const nw = cur.length ? w + space + ww : ww;
      if (cur.length && nw > maxW) {
        lines.push({ words: cur, w });
        cur = [{ t: word, w: ww }]; w = ww;
      } else {
        cur.push({ t: word, w: ww }); w = nw;
      }
    }
    lines.push({ words: cur, w });
  }
  ctx.restore();
  // Visual x of each word inside its line (right-to-left for Arabic).
  for (const line of lines) {
    let cum = 0;
    for (const word of line.words) {
      word.x = rtl ? line.w - cum - word.w : cum;
      cum += word.w + space;
    }
  }
  const lh = (L.lineHeight ?? 1.3) * size;
  // Left/right aligned text with a maxWidth anchors to that box, so columns line up.
  const bw = Math.max(1, boxed ? maxW : 0, ...lines.map((l) => l.w));
  return textCache.put(key, { lines, bw, bh: lh * lines.length, lh, font, rtl, size, ls });
}

function measureText(ctx, L, env, t) {
  const lay = layoutText(ctx, L, env, textValue(L, t));
  const pad = L.box ? boxPad(L.box) : [0, 0];
  return { w: lay.bw + pad[1] * 2, h: lay.bh + pad[0] * 2, lay };
}

const boxPad = (b) => {
  const p = b.padding ?? [18, 34];
  return Array.isArray(p) ? p : [p, p];
};

function drawText(ctx, L, s, env, m) {
  const th = env.theme;
  const lay = m.lay;
  const words = lay.lines.flatMap((l) => l.words);
  const N = words.length;
  const totalChars = words.reduce((a, w) => a + w.t.length, 0);
  const visibleChars = Math.floor(s.chars * totalChars + 1e-6);
  const hl = new Set((L.highlight || []).map((w) => String(w).replace(PUNCT_RE, '')));
  const hlStyle = L.highlightStyle || 'color';
  const hlColor = color(th, L.highlightColor, 'accent');
  const fill = color(th, L.color, 'ink');

  if (L.box) {
    const [py, px] = boxPad(L.box);
    ctx.save();
    ctx.globalAlpha *= L.box.opacity ?? 1;
    ctx.fillStyle = color(th, L.box.color, 'surface');
    ctx.beginPath();
    ctx.roundRect(-lay.bw / 2 - px, -lay.bh / 2 - py, lay.bw + px * 2, lay.bh + py * 2, L.box.radius ?? 18);
    ctx.fill();
    if (L.box.stroke) {
      ctx.strokeStyle = color(th, L.box.stroke);
      ctx.lineWidth = L.box.strokeWidth ?? 3;
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.font = lay.font;
  ctx.letterSpacing = `${lay.ls}px`;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const align = L.align || 'center';
  const a = Math.min(1, 3 / Math.max(1, N));
  let idx = 0, charsLeft = visibleChars;
  const top = -lay.bh / 2;

  lay.lines.forEach((line, li) => {
    const lx = align === 'center' ? -line.w / 2 : (align === 'right') ? lay.bw / 2 - line.w : -lay.bw / 2;
    const ly = top + lay.lh * (li + 0.5);
    for (const word of line.words) {
      const i = idx++;
      let wp = 1;
      if (s.words < 1) {
        const st = N > 1 ? (i * (1 - a)) / (N - 1) : 0;
        wp = clamp01((s.words - st) / a);
      }
      if (wp <= 0) continue;
      let txt = word.t;
      if (s.chars < 1) {
        if (charsLeft <= 0) continue;
        if (charsLeft < txt.length) txt = txt.slice(0, charsLeft);
        charsLeft -= word.t.length;
      }
      const e = ease('outCubic', wp);
      const x = lx + word.x;
      const y = ly + (1 - e) * lay.size * 0.35;
      const isHl = hl.size && hl.has(word.t.replace(PUNCT_RE, ''));
      ctx.save();
      ctx.globalAlpha *= e;
      let wordFill = fill;
      if (isHl) {
        const mp = s.words < 1 ? e : ease('outCubic', clamp01(s.inP * 1.4 - 0.2));
        if (hlStyle === 'marker') {
          const padX = lay.size * 0.07, h = lay.size * 1.08;
          const mw = (word.w + padX * 2) * mp;
          const mx = lay.rtl ? x + word.w + padX - mw : x - padX;
          ctx.save();
          ctx.fillStyle = hlColor;
          ctx.beginPath();
          ctx.roundRect(mx, y - h / 2, mw, h, lay.size * 0.12);
          ctx.fill();
          ctx.restore();
          wordFill = color(th, L.markerTextColor, 'surface');
        } else if (hlStyle === 'underline') {
          ctx.save();
          ctx.strokeStyle = hlColor;
          ctx.lineWidth = Math.max(3, lay.size * 0.09);
          ctx.lineCap = 'round';
          const uy = y + lay.size * 0.55;
          const uw = word.w * mp;
          ctx.beginPath();
          if (lay.rtl) { ctx.moveTo(x + word.w, uy); ctx.lineTo(x + word.w - uw, uy); } else { ctx.moveTo(x, uy); ctx.lineTo(x + uw, uy); }
          ctx.stroke();
          ctx.restore();
          wordFill = hlColor;
        } else {
          wordFill = hlColor;
        }
      }
      const ax = lay.rtl ? x + word.w : x;
      ctx.textAlign = lay.rtl ? 'right' : 'left';
      ctx.direction = lay.rtl ? 'rtl' : 'ltr';
      if (L.stroke) {
        ctx.strokeStyle = color(th, L.stroke.color, 'bg');
        ctx.lineWidth = L.stroke.width ?? 8;
        ctx.strokeText(txt, ax, y);
      }
      ctx.fillStyle = wordFill;
      ctx.fillText(txt, ax, y);
      ctx.restore();
    }
  });
}

// ---------------------------------------------------------------- image / video

function mediaSize(L, src, env) {
  const nw = src?.videoWidth || src?.naturalWidth || 1600;
  const nh = src?.videoHeight || src?.naturalHeight || 900;
  const ar = nw / nh;
  if (L.width && L.height) return { w: L.width, h: L.height, nw, nh };
  if (L.width) return { w: L.width, h: L.width / ar, nw, nh };
  if (L.height) return { w: L.height * ar, h: L.height, nw, nh };
  const w = Math.min(nw, env.W * 0.5);
  return { w, h: w / ar, nw, nh };
}

function shapePath(ctx, L, w, h) {
  ctx.beginPath();
  if (L.mask === 'circle') ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  else ctx.roundRect(-w / 2, -h / 2, w, h, L.radius ?? 0);
}

function drawMedia(ctx, L, s, env, m, src) {
  const th = env.theme;
  const { w, h, nw, nh } = m;
  if (!src) {
    ctx.save();
    ctx.setLineDash([14, 10]);
    ctx.strokeStyle = '#E4572E';
    ctx.lineWidth = 4;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = '#E4572E';
    ctx.font = '600 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`missing: ${L.src}`, 0, 0);
    ctx.restore();
    return;
  }
  if (L.shadow) {
    const sh = L.shadow === true ? {} : L.shadow;
    ctx.save();
    ctx.shadowColor = sh.color ?? 'rgba(0,0,0,0.28)';
    ctx.shadowBlur = (sh.blur ?? 40) * env.scale;
    ctx.shadowOffsetY = (sh.y ?? 16) * env.scale;
    ctx.fillStyle = '#000';
    shapePath(ctx, L, w, h);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  shapePath(ctx, L, w, h);
  ctx.clip();
  // Fit: cover (default) crops the source, contain letterboxes it.
  const fit = L.fit || 'cover';
  let sw = nw, sh = nh, dw = w, dh = h;
  const kb = L.kenburns;
  let k = 1, fx = 0.5, fy = 0.5;
  if (kb) {
    const o = kb === true ? {} : kb;
    k = lerp(o.from ?? 1, o.to ?? 1.15, ease(o.ease || 'inOutSine', s.life));
    fx = lerp(o.fromX ?? 0.5, o.toX ?? 0.5, ease(o.ease || 'inOutSine', s.life));
    fy = lerp(o.fromY ?? 0.5, o.toY ?? 0.5, ease(o.ease || 'inOutSine', s.life));
  }
  if (fit === 'cover') {
    const r = Math.max(w / nw, h / nh) * k;
    sw = w / r; sh = h / r;
  } else {
    const r = Math.min(w / nw, h / nh);
    dw = nw * r * k; dh = nh * r * k;
  }
  const sx = (nw - sw) * fx, sy = (nh - sh) * fy;
  if (L.filter) ctx.filter = L.filter;
  ctx.drawImage(src, Math.max(0, sx), Math.max(0, sy), Math.min(sw, nw), Math.min(sh, nh), -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
  if (L.border) {
    ctx.save();
    ctx.strokeStyle = color(th, L.border.color, 'surface');
    ctx.lineWidth = L.border.width ?? 10;
    shapePath(ctx, L, w, h);
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------- shapes

function shapeSize(L, env) {
  if (L.points && L.points.length >= 2) {
    const xs = L.points.map((p) => p[0]), ys = L.points.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    return { w: Math.max(w, 10), h: Math.max(h, 10) };
  }
  const d = { line: [400, 0], arrow: [300, 0], underline: [420, 24], check: [120, 100], cross: [100, 100], highlight: [420, 80] }[L.shape] || [300, 300];
  const w = L.width ?? d[0];
  const h = L.height ?? (L.shape === 'circle' ? w : d[1]);
  return { w, h: Math.max(h, L.shape === 'line' || L.shape === 'arrow' ? 10 : h) };
}

// Points of an open/closed outline in local (centered) coordinates.
function outline(L, w, h) {
  const pts = [];
  switch (L.shape) {
    case 'line': case 'arrow': case 'underline': {
      let raw;
      if (L.points && L.points.length >= 2) {
        const cx = (Math.min(...L.points.map((p) => p[0])) + Math.max(...L.points.map((p) => p[0]))) / 2;
        const cy = (Math.min(...L.points.map((p) => p[1])) + Math.max(...L.points.map((p) => p[1]))) / 2;
        raw = L.points.map(([x, y]) => [x - cx, y - cy]);
      } else if (L.shape === 'underline') {
        raw = [[-w / 2, h * 0.2], [0, -h * 0.2], [w / 2, h * 0.1]];
      } else {
        raw = [[-w / 2, 0], [w / 2, 0]];
      }
      if (L.direction === 'rtl') raw = raw.map(([x, y]) => [-x, y]);
      const curve = L.curve ?? (L.shape === 'underline' ? 0.15 : 0);
      if (raw.length === 2 && curve) {
        const [a, b] = raw;
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const c = [mx - dy * curve, my + dx * curve];
        for (let i = 0; i <= 32; i++) {
          const t = i / 32;
          pts.push([(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]]);
        }
      } else if (raw.length > 2) {
        // Catmull-Rom smoothing through the points.
        for (let i = 0; i < raw.length - 1; i++) {
          const p0 = raw[Math.max(0, i - 1)], p1 = raw[i], p2 = raw[i + 1], p3 = raw[Math.min(raw.length - 1, i + 2)];
          for (let j = 0; j < 16; j++) {
            const t = j / 16, t2 = t * t, t3 = t2 * t;
            pts.push([0, 1].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
          }
        }
        pts.push(raw[raw.length - 1]);
      } else pts.push(...raw);
      break;
    }
    case 'circle': case 'ellipse':
      for (let i = 0; i <= 64; i++) {
        const a = -Math.PI / 2 + (i / 64) * Math.PI * 2;
        pts.push([Math.cos(a) * w / 2, Math.sin(a) * h / 2]);
      }
      break;
    case 'check':
      pts.push([-w / 2, 0], [-w / 6, h / 2], [w / 2, -h / 2]);
      break;
    case 'cross':
      pts.push([-w / 2, -h / 2], [w / 2, h / 2]);
      break;
    default: { // rect / highlight
      const r = Math.min(L.radius ?? 0, w / 2, h / 2);
      const corner = (cx, cy, a0) => {
        for (let i = 0; i <= 8; i++) {
          const a = a0 + (i / 8) * Math.PI / 2;
          pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
        }
      };
      corner(-w / 2 + r, -h / 2 + r, Math.PI);
      corner(w / 2 - r, -h / 2 + r, -Math.PI / 2);
      corner(w / 2 - r, h / 2 - r, 0);
      corner(-w / 2 + r, h / 2 - r, Math.PI / 2);
      pts.push(pts[0]);
    }
  }
  return pts;
}

function polyLen(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

function partial(pts, p) {
  if (p >= 1) return pts;
  const target = polyLen(pts) * p;
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + seg >= target) {
      const t = (target - acc) / (seg || 1);
      out.push([lerp(pts[i - 1][0], pts[i][0], t), lerp(pts[i - 1][1], pts[i][1], t)]);
      return out;
    }
    acc += seg;
    out.push(pts[i]);
  }
  return out;
}

function arrowHead(pts, size) {
  const n = pts.length;
  if (n < 2) return [];
  const [x2, y2] = pts[n - 1];
  let k = n - 2;
  while (k > 0 && Math.hypot(pts[k][0] - x2, pts[k][1] - y2) < size * 0.5) k--;
  const ang = Math.atan2(y2 - pts[k][1], x2 - pts[k][0]);
  return [
    [[x2 + Math.cos(ang + 2.6) * size, y2 + Math.sin(ang + 2.6) * size], [x2, y2]],
    [[x2, y2], [x2 + Math.cos(ang - 2.6) * size, y2 + Math.sin(ang - 2.6) * size]],
  ];
}

let svgMeasure = null;
function pathLength(d) {
  let l = lengthCache.get(d);
  if (l != null) return l;
  if (!svgMeasure) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('style', 'position:absolute;width:0;height:0;visibility:hidden');
    svgMeasure = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.appendChild(svgMeasure);
    document.body.appendChild(svg);
  }
  svgMeasure.setAttribute('d', d);
  l = svgMeasure.getTotalLength();
  return lengthCache.put(d, l);
}

function roughPaths(L, w, h, th, pts, strokeCol, fillCol, sw) {
  const opts = {
    roughness: L.roughness ?? 1.3,
    bowing: L.bowing ?? 1,
    seed: L.seed ?? hash(String(L.id || L.shape)),
    stroke: strokeCol || 'none',
    strokeWidth: sw,
    fill: fillCol || undefined,
    fillStyle: L.fillStyle || 'hachure',
    hachureGap: L.hachureGap ?? sw * 3.5,
    fillWeight: L.fillWeight ?? sw * 0.6,
    hachureAngle: L.hachureAngle ?? -41,
  };
  const key = JSON.stringify([L.shape, w, h, pts.length, pts[0], pts[pts.length - 1], opts]);
  const hit = roughCache.get(key);
  if (hit) return hit;
  const ds = [];
  const add = (dr) => ds.push(...generator.toPaths(dr));
  switch (L.shape) {
    case 'rect': case 'highlight':
      add(L.radius ? generator.path(roundRectD(w, h, L.radius), opts) : generator.rectangle(-w / 2, -h / 2, w, h, opts));
      break;
    case 'circle': case 'ellipse': add(generator.ellipse(0, 0, w, h, opts)); break;
    default:
      add(generator.curve(pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1), { ...opts, fill: undefined }));
      if (L.shape === 'arrow') for (const seg of arrowHead(pts, L.headSize ?? Math.max(22, sw * 5))) add(generator.linearPath(seg, { ...opts, fill: undefined }));
      if (L.shape === 'cross') add(generator.line(w / 2, -h / 2, -w / 2, h / 2, opts));
  }
  const paths = ds.map((p) => ({ d: p.d, path: new Path2D(p.d), stroke: p.stroke, fill: p.fill, sw: p.strokeWidth, len: pathLength(p.d) }));
  return roughCache.put(key, paths);
}

function roundRectD(w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  const x = -w / 2, y = -h / 2;
  return `M${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x + r} Q${x},${y + h} ${x},${y + h - r} V${y + r} Q${x},${y} ${x + r},${y} Z`;
}

function drawShape(ctx, L, s, env, m) {
  const th = env.theme;
  const { w, h } = m;
  const isOpen = ['line', 'arrow', 'underline', 'check', 'cross'].includes(L.shape);
  const sw = L.strokeWidth ?? (isOpen ? 8 : 6);
  let strokeCol = L.stroke === 'none' ? null : color(th, L.stroke, L.shape === 'highlight' ? 'none' : 'accent');
  if (strokeCol === 'none') strokeCol = null;
  let fillCol = isOpen ? null : (L.fill === 'none' || L.fill == null ? (L.shape === 'highlight' ? color(th, 'accent3') : null) : color(th, L.fill));
  const useRough = L.rough ?? th.rough;
  const p = s.draw;
  const pts = outline(L, w, h);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (L.shape === 'highlight') ctx.globalAlpha *= L.fillOpacity ?? 0.45;

  if (useRough) {
    const paths = roughPaths(L, w, h, th, pts, strokeCol, fillCol, sw);
    const total = paths.reduce((a, q) => a + q.len, 0);
    let budget = total * p;
    for (const q of paths) {
      if (budget <= 0) break;
      const show = Math.min(q.len, budget);
      budget -= q.len;
      ctx.save();
      if (show < q.len) ctx.setLineDash([show, q.len + 1]);
      if (q.stroke && q.stroke !== 'none') {
        ctx.strokeStyle = q.stroke;
        ctx.lineWidth = q.sw;
        ctx.stroke(q.path);
      } else if (q.fill && q.fill !== 'none') {
        ctx.globalAlpha *= p;
        ctx.fillStyle = q.fill;
        ctx.fill(q.path);
      }
      ctx.restore();
    }
    return;
  }

  if (fillCol) {
    ctx.save();
    ctx.globalAlpha *= p;
    ctx.fillStyle = fillCol;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  if (strokeCol) {
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = sw;
    const segs = [pts];
    if (L.shape === 'cross') segs.push([[w / 2, -h / 2], [-w / 2, h / 2]]);
    const head = L.shape === 'arrow' ? arrowHead(pts, L.headSize ?? Math.max(22, sw * 4)) : [];
    const all = [...segs, ...head];
    const total = all.reduce((a, q) => a + polyLen(q), 0);
    let budget = total * p;
    for (const seg of all) {
      if (budget <= 0) break;
      const len = polyLen(seg);
      const part = partial(seg, Math.min(1, budget / (len || 1)));
      budget -= len;
      ctx.beginPath();
      part.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------- dispatcher

export function measureLayer(ctx, L, env, t) {
  switch (L.type) {
    case 'text': return measureText(ctx, L, env, t);
    case 'image': return mediaSize(L, env.assets.image(L.src), env);
    case 'video': return mediaSize(L, env.assets.video(L.src), env);
    case 'shape': return shapeSize(L, env);
    default: return { w: 100, h: 100 };
  }
}

export function drawLayer(ctx, L, s, env, t) {
  if (s.opacity <= 0.002 || s.scale <= 0.0001) return;
  ctx.save();
  ctx.globalAlpha *= clamp01(s.opacity);
  if (L.blend) ctx.globalCompositeOperation = L.blend;
  ctx.translate(s.x, s.y);
  if (s.rotate) ctx.rotate((s.rotate * Math.PI) / 180);
  if (s.scale !== 1) ctx.scale(s.scale, s.scale);
  if (L.flipX) ctx.scale(-1, 1);
  const m = measureLayer(ctx, L, env, t);
  env.hits.push({ sceneId: env.sceneId, layerId: L.id, tpl: !!L._tpl, m: ctx.getTransform(), w: m.w, h: m.h });

  if (s.blur > 0.3) ctx.filter = `blur(${(s.blur * env.scale * env.zoom).toFixed(2)}px)`;
  if (s.reveal < 1) {
    const pad = 0.15;
    const W = m.w * (1 + pad * 2), H = m.h * (1 + pad * 2);
    const rw = W * ease('linear', s.reveal);
    ctx.beginPath();
    if (s.revealDir === 'rtl') ctx.rect(W / 2 - rw, -H / 2, rw, H);
    else ctx.rect(-W / 2, -H / 2, rw, H);
    ctx.clip();
  }
  if (L.shadow && L.type !== 'image' && L.type !== 'video') {
    const sh = L.shadow === true ? {} : L.shadow;
    ctx.shadowColor = sh.color ?? 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = (sh.blur ?? 24) * env.scale;
    ctx.shadowOffsetY = (sh.y ?? 8) * env.scale;
  }
  switch (L.type) {
    case 'text': drawText(ctx, L, s, env, m); break;
    case 'image': drawMedia(ctx, L, s, env, m, env.assets.image(L.src)); break;
    case 'video': drawMedia(ctx, L, s, env, m, env.assets.video(L.src)); break;
    case 'shape': drawShape(ctx, L, s, env, m); break;
    default: break;
  }
  ctx.restore();
}
