// Animation math: easings, enter/exit presets, looping motion and keyframes.
// Everything here is a pure function of time so every frame is reproducible.

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;

const c1 = 1.70158, c3 = c1 + 1, c2 = c1 * 1.525;
const bounceOut = (t) => {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};

export const EASINGS = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inQuart: (t) => t * t * t * t,
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  inOutQuart: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - Math.pow(-2 * t + 2, 4) / 2),
  inExpo: (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutExpo: (t) => (t === 0 || t === 1 ? t : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
  inSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  outSine: (t) => Math.sin((t * Math.PI) / 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  inBack: (t) => c3 * t * t * t - c1 * t * t,
  outBack: (t) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
  inOutBack: (t) => (t < 0.5
    ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
    : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2),
  outElastic: (t) => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  outBounce: bounceOut,
};

export function ease(name, t) {
  return (EASINGS[name] || EASINGS.outCubic)(clamp01(t));
}

// Default easing per preset when the layer does not specify one.
const IN_EASE = { pop: 'outBack', drop: 'outBounce', spin: 'outBack', words: 'linear', typewriter: 'linear' };

export const ANIMATIONS = [
  'none', 'fade', 'fadeUp', 'fadeDown', 'fadeLeft', 'fadeRight',
  'slideLeft', 'slideRight', 'slideUp', 'slideDown',
  'zoomIn', 'zoomOut', 'pop', 'blurIn', 'reveal', 'revealRtl',
  'draw', 'typewriter', 'words', 'spin', 'drop',
];
export const LOOPS = ['none', 'float', 'pulse', 'shake', 'spin', 'sway'];

// Apply one preset. `dir` is +1 for enter and -1 for exit; `p` runs 0 -> 1 towards "fully visible".
function applyPreset(s, type, p, dir, a) {
  const d = a.distance ?? 70;
  const far = a.distance ?? 520;
  switch (type) {
    case 'fade': s.opacity *= p; break;
    case 'fadeUp': s.opacity *= p; s.y += dir * (1 - p) * d; break;
    case 'fadeDown': s.opacity *= p; s.y -= dir * (1 - p) * d; break;
    case 'fadeLeft': s.opacity *= p; s.x += dir * (1 - p) * d; break;
    case 'fadeRight': s.opacity *= p; s.x -= dir * (1 - p) * d; break;
    case 'slideLeft': s.opacity *= clamp01(p * 3); s.x += dir * (1 - p) * far; break;
    case 'slideRight': s.opacity *= clamp01(p * 3); s.x -= dir * (1 - p) * far; break;
    case 'slideUp': s.opacity *= clamp01(p * 3); s.y += dir * (1 - p) * far; break;
    case 'slideDown': s.opacity *= clamp01(p * 3); s.y -= dir * (1 - p) * far; break;
    case 'zoomIn': s.opacity *= p; s.scale *= 0.5 + 0.5 * p; break;
    case 'zoomOut': s.opacity *= p; s.scale *= 1.6 - 0.6 * p; break;
    case 'pop': s.opacity *= clamp01(p * 4); s.scale *= Math.max(0, p); break;
    case 'blurIn': s.opacity *= p; s.blur += (1 - p) * 26; break;
    case 'reveal': s.reveal = Math.min(s.reveal, p); s.revealDir = 'ltr'; break;
    case 'revealRtl': s.reveal = Math.min(s.reveal, p); s.revealDir = 'rtl'; break;
    case 'draw': s.draw = Math.min(s.draw, p); break;
    case 'typewriter':
      if (dir > 0) s.chars = Math.min(s.chars, p); else s.opacity *= p;
      break;
    case 'words':
      if (dir > 0) s.words = Math.min(s.words, p); else s.opacity *= p;
      break;
    case 'spin': s.opacity *= clamp01(p * 2); s.rotate += dir * (1 - p) * -180; s.scale *= 0.3 + 0.7 * p; break;
    case 'drop': s.opacity *= clamp01(p * 3); s.y -= dir * (1 - p) * 320; break;
    default: break;
  }
}

function applyLoop(s, loop, t) {
  if (!loop || !loop.type || loop.type === 'none') return;
  const sp = loop.speed ?? 1;
  const w = Math.sin(t * sp * Math.PI * 2);
  switch (loop.type) {
    case 'float': s.y += w * (loop.amount ?? 10); break;
    case 'pulse': s.scale *= 1 + ((w + 1) / 2) * (loop.amount ?? 0.05); break;
    case 'shake': s.x += Math.sin(t * sp * 70) * (loop.amount ?? 5); break;
    case 'spin': s.rotate += t * sp * 360 * (loop.amount ?? 0.1); break;
    case 'sway': s.rotate += w * (loop.amount ?? 3); break;
    default: break;
  }
}

const KF_PROPS = ['x', 'y', 'scale', 'rotate', 'opacity', 'blur'];

// keyframes: [{ t: sceneSeconds, x, y, scale, rotate, opacity, ease }]
function applyKeyframes(s, kfs, t) {
  for (const prop of KF_PROPS) {
    const ks = kfs.filter((k) => k[prop] != null);
    if (!ks.length) continue;
    if (t <= ks[0].t) { s[prop] = ks[0][prop]; continue; }
    const last = ks[ks.length - 1];
    if (t >= last.t) { s[prop] = last[prop]; continue; }
    for (let i = 0; i < ks.length - 1; i++) {
      const a = ks[i], b = ks[i + 1];
      if (t >= a.t && t <= b.t) {
        const p = ease(b.ease || 'inOutCubic', (t - a.t) / Math.max(1e-6, b.t - a.t));
        s[prop] = lerp(a[prop], b[prop], p);
        break;
      }
    }
  }
}

// Compute the animated state of a layer at scene time `t`.
export function layerState(L, t, sceneDuration) {
  const s = {
    x: L.x ?? 0, y: L.y ?? 0, scale: L.scale ?? 1, rotate: L.rotate ?? 0,
    opacity: L.opacity ?? 1, blur: L.blur ?? 0,
    reveal: 1, revealDir: 'ltr', draw: 1, chars: 1, words: 1, inP: 1, life: 0,
  };
  const start = L.start ?? 0;
  const end = L.end ?? sceneDuration;
  s.life = clamp01((t - start) / Math.max(1e-6, end - start));
  if (L.keyframes && L.keyframes.length) applyKeyframes(s, L.keyframes, t);

  const a = L.in;
  if (a && a.type && a.type !== 'none') {
    const dur = a.duration ?? 0.7;
    const raw = (t - start - (a.delay ?? 0)) / Math.max(1e-6, dur);
    const p = ease(a.ease || IN_EASE[a.type] || 'outCubic', raw);
    s.inP = clamp01(raw);
    applyPreset(s, a.type, p, 1, a);
  }
  const o = L.out;
  if (o && o.type && o.type !== 'none') {
    const dur = o.duration ?? 0.5;
    const raw = (end - t) / Math.max(1e-6, dur);
    const p = ease(o.ease || 'outCubic', raw);
    applyPreset(s, o.type, p, -1, o);
  }
  applyLoop(s, L.loop, t - start);
  return s;
}

export function isActive(L, t, sceneDuration) {
  const start = L.start ?? 0;
  const end = L.end ?? sceneDuration;
  return !L.hidden && t >= start && t < end + 1e-6;
}

// Deterministic PRNG used for grain and anything pseudo-random.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
