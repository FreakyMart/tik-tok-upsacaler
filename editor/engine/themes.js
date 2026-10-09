// Themes define the visual language of a video: colors, fonts, background and finishing fx.
// Layers reference colors by token ("ink", "accent", ...) so a whole video can be restyled
// by changing `project.theme` alone.

export const THEMES = {
  psych: {
    label: 'Psych (ورق دافئ)',
    colors: {
      bg: '#F6EFE6', surface: '#FFFFFF', ink: '#2B2A33', muted: '#7D7686',
      accent: '#E4572E', accent2: '#3E8E7E', accent3: '#F2B134', line: '#E6D9C6',
    },
    fonts: { display: 'Cairo', body: 'Tajawal' },
    background: { type: 'pattern', pattern: 'dots', bg: '#F6EFE6', color: '#E3D5C1', size: 38 },
    fx: { grain: 0.05, vignette: 0.16 },
    rough: true,
  },
  midnight: {
    label: 'Midnight (ليلي)',
    colors: {
      bg: '#0E1325', surface: '#1A2140', ink: '#F1F3FF', muted: '#8D96C2',
      accent: '#FFB547', accent2: '#5CE1E6', accent3: '#FF6B9A', line: '#2A335C',
    },
    fonts: { display: 'Cairo', body: 'Tajawal' },
    background: { type: 'radial', colors: ['#1C2550', '#0B0F1F'] },
    fx: { grain: 0.06, vignette: 0.35 },
    rough: false,
  },
  clean: {
    label: 'Clean (أبيض)',
    colors: {
      bg: '#FFFFFF', surface: '#F3F4F6', ink: '#111827', muted: '#6B7280',
      accent: '#2563EB', accent2: '#F59E0B', accent3: '#10B981', line: '#E5E7EB',
    },
    fonts: { display: 'Cairo', body: 'Tajawal' },
    background: { type: 'solid', color: '#FFFFFF' },
    fx: { grain: 0, vignette: 0 },
    rough: false,
  },
  chalk: {
    label: 'Chalkboard (سبورة)',
    colors: {
      bg: '#1F3A33', surface: '#27463E', ink: '#F4F1E8', muted: '#A9C2B8',
      accent: '#FFD166', accent2: '#EF8A8A', accent3: '#8FD3FE', line: '#2F5248',
    },
    fonts: { display: 'Cairo', body: 'Tajawal' },
    background: { type: 'radial', colors: ['#28493F', '#17302A'] },
    fx: { grain: 0.09, vignette: 0.3 },
    rough: true,
  },
};

export function getTheme(project) {
  const base = THEMES[project.theme] || THEMES.psych;
  const o = project.themeOverrides || {};
  return {
    ...base,
    ...o,
    colors: { ...base.colors, ...(o.colors || {}) },
    fonts: { ...base.fonts, ...(o.fonts || {}) },
    fx: { ...base.fx, ...(o.fx || {}), ...(project.fx || {}) },
    background: o.background || base.background,
  };
}

// Resolve a color token ("accent") or pass a literal color through.
export function color(theme, c, fallback = 'ink') {
  if (c == null || c === '') c = fallback;
  return theme.colors[c] || c;
}

export function fontFamily(theme, f) {
  const fam = theme.fonts[f || 'body'] || f || theme.fonts.body;
  return `"${fam}", "Cairo", "Tajawal", sans-serif`;
}
