// Scene templates: high-level building blocks for explainer videos.
// A template turns `scene.props` into regular layers laid out on the theme's grid,
// so the AI writes intent ("a list with 3 items") and the engine handles the craft.
// Every generated layer has a stable id; `scene.overrides[id]` tweaks any of them.

import { isRtl } from './layers.js';

export const TEMPLATES = {
  title: { label: 'عنوان رئيسي', props: { kicker: 'string', title: 'string', subtitle: 'string' } },
  chapter: { label: 'بداية فصل', props: { number: 'string', title: 'string', subtitle: 'string' } },
  list: { label: 'قائمة نقاط', props: { title: 'string', items: 'string[]' } },
  statement: { label: 'جملة قوية', props: { text: 'string', highlight: 'string[]' } },
  quote: { label: 'اقتباس', props: { text: 'string', author: 'string' } },
  compare: { label: 'مقارنة', props: { leftTitle: 'string', left: 'string[]', rightTitle: 'string', right: 'string[]' } },
  image: { label: 'صورة مع تعليق', props: { src: 'string', caption: 'string', full: 'boolean' } },
  stat: { label: 'رقم / إحصائية', props: { value: 'number', prefix: 'string', suffix: 'string', label: 'string' } },
  outro: { label: 'خاتمة', props: { title: 'string', subtitle: 'string', cta: 'string' } },
};

function stagger(n, dur, first = 0.5, tail = 1.2) {
  const span = Math.max(0.3, dur - first - tail);
  const step = n > 1 ? Math.min(1.1, span / (n - 1)) : 0;
  return (i) => first + i * step;
}

export function expandTemplate(scene, project, theme) {
  const W = project.width || 1920, H = project.height || 1080;
  const k = Math.min(W, H) / 1080;
  const portrait = H > W;
  const p = scene.props || {};
  const dur = scene.duration || 5;
  const R = theme.rough;
  const L = [];
  const add = (layer) => L.push({ _tpl: true, ...layer });
  const rtlOf = (...txt) => txt.some((t) => isRtl(t));

  switch (scene.template) {
    case 'title': {
      let y = H * 0.5;
      if (p.kicker) add({ id: 'kicker', type: 'text', text: p.kicker, font: 'body', size: 40 * k, weight: 700, color: 'surface', box: { color: 'accent', radius: 40 * k, padding: [10 * k, 30 * k] }, x: W / 2, y: y - 190 * k, in: { type: 'pop', duration: 0.6 } });
      add({ id: 'title', type: 'text', text: p.title || 'العنوان', font: 'display', size: (portrait ? 110 : 128) * k, color: 'ink', maxWidth: W * 0.82, lineHeight: 1.2, x: W / 2, y: y - 20 * k, highlight: p.highlight, highlightStyle: 'color', in: { type: 'words', duration: 1.1, delay: 0.25 } });
      add({ id: 'underline', type: 'shape', shape: 'underline', width: Math.min(W * 0.5, 700 * k), height: 26 * k, stroke: 'accent', strokeWidth: 10 * k, rough: R, x: W / 2, y: y + 100 * k, direction: rtlOf(p.title) ? 'rtl' : 'ltr', in: { type: 'draw', duration: 0.8, delay: 1.1, ease: 'inOutCubic' } });
      if (p.subtitle) add({ id: 'subtitle', type: 'text', text: p.subtitle, font: 'body', size: 50 * k, weight: 500, color: 'muted', maxWidth: W * 0.7, x: W / 2, y: y + 190 * k, in: { type: 'fadeUp', duration: 0.8, delay: 1.4 } });
      break;
    }
    case 'chapter': {
      const rtl = rtlOf(p.title);
      add({ id: 'number', type: 'text', text: p.number || '01', font: 'display', size: 230 * k, weight: 800, color: 'accent', x: W / 2, y: H * 0.36, in: { type: 'pop', duration: 0.7 } });
      add({ id: 'circle', type: 'shape', shape: 'ellipse', width: 400 * k, height: 300 * k, stroke: 'ink', strokeWidth: 6 * k, rough: true, roughness: 1.8, x: W / 2, y: H * 0.36, in: { type: 'draw', duration: 0.9, delay: 0.3, ease: 'inOutCubic' } });
      add({ id: 'title', type: 'text', text: p.title || 'الفصل', font: 'display', size: 100 * k, color: 'ink', maxWidth: W * 0.8, x: W / 2, y: H * 0.64, in: { type: rtl ? 'revealRtl' : 'reveal', duration: 0.8, delay: 0.6, ease: 'inOutCubic' } });
      if (p.subtitle) add({ id: 'subtitle', type: 'text', text: p.subtitle, font: 'body', size: 46 * k, weight: 500, color: 'muted', maxWidth: W * 0.7, x: W / 2, y: H * 0.64 + 110 * k, in: { type: 'fadeUp', delay: 1.1 } });
      break;
    }
    case 'list': {
      const items = p.items || [];
      const rtl = rtlOf(p.title, ...items);
      const at = stagger(items.length, dur, 0.9);
      add({ id: 'title', type: 'text', text: p.title || '', font: 'display', size: 84 * k, color: 'ink', maxWidth: W * 0.84, x: W / 2, y: H * 0.17, in: { type: 'fadeDown', duration: 0.7 } });
      add({ id: 'titleLine', type: 'shape', shape: 'underline', width: 260 * k, height: 18 * k, stroke: 'accent', strokeWidth: 8 * k, rough: R, x: W / 2, y: H * 0.17 + 72 * k, direction: rtl ? 'rtl' : 'ltr', in: { type: 'draw', duration: 0.6, delay: 0.4 } });
      const top = H * 0.33, gap = Math.min(150 * k, (H * 0.6) / Math.max(1, items.length));
      const colW = Math.min(W * 0.72, 1300 * k);
      const edge = rtl ? W / 2 + colW / 2 : W / 2 - colW / 2;
      const sign = rtl ? -1 : 1;
      const accents = ['accent', 'accent2', 'accent3'];
      items.forEach((txt, i) => {
        const y = top + gap * (i + 0.5);
        const c = accents[i % 3];
        add({ id: `bullet${i + 1}`, type: 'shape', shape: 'circle', width: 64 * k, stroke: c, fill: c, fillStyle: 'solid', strokeWidth: 4 * k, rough: R, x: edge + sign * 32 * k, y, in: { type: 'pop', delay: at(i), duration: 0.5 } });
        add({ id: `num${i + 1}`, type: 'text', text: String(i + 1), font: 'display', size: 36 * k, color: 'surface', x: edge + sign * 32 * k, y: y + 2 * k, in: { type: 'pop', delay: at(i) + 0.1, duration: 0.5 } });
        add({ id: `item${i + 1}`, type: 'text', text: txt, font: 'body', size: 54 * k, weight: 700, color: 'ink', align: rtl ? 'right' : 'left', maxWidth: colW - 110 * k, x: edge + sign * (90 * k + (colW - 110 * k) / 2), y, in: { type: rtl ? 'fadeLeft' : 'fadeRight', delay: at(i) + 0.1, duration: 0.6 } });
      });
      break;
    }
    case 'statement': {
      add({ id: 'text', type: 'text', text: p.text || '', font: 'display', size: (portrait ? 96 : 104) * k, color: 'ink', maxWidth: W * 0.8, lineHeight: 1.35, x: W / 2, y: H / 2, highlight: p.highlight, highlightStyle: 'marker', highlightColor: 'accent', in: { type: 'words', duration: Math.min(2.2, dur * 0.45), delay: 0.2 } });
      break;
    }
    case 'quote': {
      const rtl = rtlOf(p.text);
      add({ id: 'mark', type: 'text', text: rtl ? '”' : '“', font: 'display', size: 420 * k, color: 'accent', opacity: 0.35, x: rtl ? W * 0.82 : W * 0.18, y: H * 0.32, in: { type: 'pop', duration: 0.6 } });
      add({ id: 'text', type: 'text', text: p.text || '', font: 'display', size: 74 * k, color: 'ink', maxWidth: W * 0.7, lineHeight: 1.45, x: W / 2, y: H * 0.47, in: { type: 'words', duration: Math.min(2.4, dur * 0.5), delay: 0.3 } });
      if (p.author) add({ id: 'author', type: 'text', text: `— ${p.author}`, font: 'body', size: 44 * k, weight: 500, color: 'muted', x: W / 2, y: H * 0.75, in: { type: 'fadeUp', delay: Math.min(2.8, dur * 0.6) } });
      break;
    }
    case 'compare': {
      const rtl = rtlOf(p.leftTitle, p.rightTitle, ...(p.left || []));
      const cols = [
        { key: 'a', title: p.leftTitle, items: p.left || [], c: 'accent2', mark: 'check' },
        { key: 'b', title: p.rightTitle, items: p.right || [], c: 'accent', mark: 'cross' },
      ];
      add({ id: 'divider', type: 'shape', shape: 'line', points: [[W / 2, H * 0.15], [W / 2, H * 0.88]], stroke: 'line', strokeWidth: 6 * k, rough: R, in: { type: 'draw', duration: 0.8 } });
      cols.forEach((col, ci) => {
        const cx = (rtl ? ci === 0 : ci === 1) ? W * 0.75 : W * 0.25;
        add({ id: `${col.key}Title`, type: 'text', text: col.title || '', font: 'display', size: 64 * k, color: 'surface', box: { color: col.c, radius: 22 * k, padding: [12 * k, 36 * k] }, x: cx, y: H * 0.22, in: { type: 'pop', delay: 0.3 + ci * 0.4 } });
        const at = stagger(col.items.length, dur, 1 + ci * 0.4, 1.4);
        col.items.forEach((txt, i) => {
          const y = H * 0.4 + i * Math.min(130 * k, (H * 0.48) / Math.max(1, col.items.length));
          const mx = cx + (rtl ? 1 : -1) * W * 0.17;
          add({ id: `${col.key}Mark${i + 1}`, type: 'shape', shape: col.mark, width: 44 * k, height: 40 * k, stroke: col.c, strokeWidth: 9 * k, rough: R, x: mx, y, in: { type: 'draw', delay: at(i), duration: 0.4 } });
          add({ id: `${col.key}Item${i + 1}`, type: 'text', text: txt, font: 'body', size: 46 * k, weight: 700, color: 'ink', align: rtl ? 'right' : 'left', maxWidth: W * 0.3, x: mx + (rtl ? -1 : 1) * (W * 0.15 + 40 * k), y, in: { type: 'fadeUp', delay: at(i) + 0.1 } });
        });
      });
      break;
    }
    case 'image': {
      if (p.full) {
        add({ id: 'image', type: 'image', src: p.src, width: W, height: H, x: W / 2, y: H / 2, kenburns: { from: 1.02, to: 1.14 }, in: { type: 'fade', duration: 0.5 } });
        add({ id: 'shade', type: 'shape', shape: 'rect', width: W, height: H * 0.4, fill: '#000000', fillOpacity: 1, opacity: 0.45, rough: false, stroke: 'none', x: W / 2, y: H * 0.8 });
        if (p.caption) add({ id: 'caption', type: 'text', text: p.caption, font: 'display', size: 70 * k, color: '#FFFFFF', maxWidth: W * 0.8, x: W / 2, y: H * 0.82, in: { type: 'words', delay: 0.4, duration: 1 } });
      } else {
        const hasCap = !!p.caption;
        add({ id: 'image', type: 'image', src: p.src, width: W * 0.7, height: H * (hasCap ? 0.62 : 0.76), radius: 28 * k, shadow: true, border: { color: 'surface', width: 12 * k }, x: W / 2, y: H * (hasCap ? 0.42 : 0.5), kenburns: { from: 1, to: 1.12 }, in: { type: 'zoomIn', duration: 0.8 } });
        if (hasCap) add({ id: 'caption', type: 'text', text: p.caption, font: 'body', size: 52 * k, weight: 700, color: 'ink', maxWidth: W * 0.7, x: W / 2, y: H * 0.85, box: { color: 'surface', radius: 18 * k, padding: [14 * k, 34 * k] }, in: { type: 'fadeUp', delay: 0.5 } });
      }
      break;
    }
    case 'stat': {
      add({ id: 'value', type: 'text', text: '', font: 'display', size: 260 * k, color: 'accent', x: W / 2, y: H * 0.42, count: { from: 0, to: Number(p.value ?? 0), prefix: p.prefix || '', suffix: p.suffix || '', duration: 1.6 }, in: { type: 'zoomIn', duration: 0.6 } });
      add({ id: 'label', type: 'text', text: p.label || '', font: 'body', size: 58 * k, weight: 700, color: 'ink', maxWidth: W * 0.7, x: W / 2, y: H * 0.68, in: { type: 'fadeUp', delay: 0.8 } });
      add({ id: 'underline', type: 'shape', shape: 'underline', width: 360 * k, height: 22 * k, stroke: 'accent2', strokeWidth: 9 * k, rough: R, x: W / 2, y: H * 0.56, direction: rtlOf(p.label) ? 'rtl' : 'ltr', in: { type: 'draw', delay: 1.3, duration: 0.6 } });
      break;
    }
    case 'outro': {
      add({ id: 'title', type: 'text', text: p.title || 'شكراً للمشاهدة', font: 'display', size: 120 * k, color: 'ink', maxWidth: W * 0.8, x: W / 2, y: H * 0.38, in: { type: 'words', duration: 0.9 } });
      if (p.subtitle) add({ id: 'subtitle', type: 'text', text: p.subtitle, font: 'body', size: 50 * k, weight: 500, color: 'muted', maxWidth: W * 0.7, x: W / 2, y: H * 0.52, in: { type: 'fadeUp', delay: 0.6 } });
      add({ id: 'cta', type: 'text', text: p.cta || 'اشترك 🔔', font: 'display', size: 60 * k, color: 'surface', box: { color: 'accent', radius: 50 * k, padding: [18 * k, 60 * k] }, x: W / 2, y: H * 0.7, in: { type: 'pop', delay: 1 }, loop: { type: 'pulse', amount: 0.06, speed: 0.8 } });
      break;
    }
    default: break;
  }
  return L;
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])
      ? deepMerge(a[k], v) : v;
  }
  return out;
}

// All layers of a scene: template layers (with overrides) followed by custom layers.
export function sceneLayers(scene, project, theme) {
  const base = scene.template ? expandTemplate(scene, project, theme) : [];
  const ov = scene.overrides || {};
  const tpl = base.map((l) => (ov[l.id] ? deepMerge(l, ov[l.id]) : l)).filter((l) => !(ov[l.id] && ov[l.id].hidden));
  return [...tpl, ...(scene.layers || [])];
}
