// Scene transitions powered by the open gl-transitions collection (125 GLSL shaders).
// Friendly aliases map simple names to a shader + params so the AI can write "slide" or "glitch".

let LIB = null;

export async function loadTransitionLibrary(base = new URL('../lib/', import.meta.url)) {
  if (LIB) return LIB;
  const list = await fetch(new URL('gl-transitions.json', base)).then((r) => r.json());
  LIB = {};
  for (const t of list) {
    // Shaders that need extra texture inputs are left out.
    if (Object.values(t.paramsTypes || {}).some((v) => v.startsWith('sampler'))) continue;
    LIB[t.name.toLowerCase()] = t;
  }
  return LIB;
}

export const ALIASES = {
  cut: null,
  fade: { name: 'fade' },
  dissolve: { name: 'dissolve' },
  fadeblack: { name: 'fadecolor', params: { color: [0, 0, 0], colorPhase: 0.4 } },
  fadewhite: { name: 'fadecolor', params: { color: [1, 1, 1], colorPhase: 0.4 } },
  zoom: { name: 'CrossZoom', params: { strength: 0.3 } },
  zoomin: { name: 'SimpleZoom' },
  zoomout: { name: 'SimpleZoomOut' },
  slide: { name: 'directional', params: { direction: [-1, 0] } },
  slideleft: { name: 'directional', params: { direction: [-1, 0] } },
  slideright: { name: 'directional', params: { direction: [1, 0] } },
  slideup: { name: 'directional', params: { direction: [0, 1] } },
  slidedown: { name: 'directional', params: { direction: [0, -1] } },
  push: { name: 'directional-easing', params: { direction: [-1, 0] } },
  wipe: { name: 'wipeLeft' },
  wipeleft: { name: 'wipeLeft' },
  wiperight: { name: 'wipeRight' },
  wipeup: { name: 'wipeUp' },
  wipedown: { name: 'wipeDown' },
  warp: { name: 'directionalwarp', params: { direction: [-1, 1] } },
  glitch: { name: 'GlitchMemories' },
  glitch2: { name: 'GlitchDisplace' },
  datamosh: { name: 'StripDatamoshGlitch' },
  blur: { name: 'LinearBlur', params: { intensity: 0.1 } },
  circle: { name: 'circleopen', params: { smoothness: 0.2, opening: true } },
  circleclose: { name: 'circleopen', params: { smoothness: 0.2, opening: false } },
  burn: { name: 'burn' },
  filmburn: { name: 'FilmBurn' },
  ink: { name: 'luminance_melt' },
  pixel: { name: 'pixelize' },
  ripple: { name: 'ripple' },
  swirl: { name: 'Swirl' },
  cube: { name: 'cube' },
  flip: { name: 'SimpleFlip' },
  page: { name: 'InvertedPageCurl' },
  doorway: { name: 'doorway' },
  morph: { name: 'morph' },
  dreamy: { name: 'Dreamy' },
  tv: { name: 'old_tv_lost_signal' },
  static: { name: 'static_wipe' },
  blinds: { name: 'windowblinds' },
  squares: { name: 'squareswire' },
  hexagon: { name: 'hexagonalize' },
  heart: { name: 'heart' },
  radial: { name: 'Radial' },
  wind: { name: 'wind' },
  mosaic: { name: 'Mosaic' },
  overexposure: { name: 'Overexposure' },
  whip: { name: 'tangentMotionBlur' },
};

export function resolveTransition(spec) {
  if (!spec || !LIB) return null;
  const type = typeof spec === 'string' ? spec : spec.type;
  if (!type || type === 'none' || type === 'cut') return null;
  const alias = ALIASES[type.toLowerCase()];
  const name = alias ? alias.name : type;
  const def = LIB[name.toLowerCase()];
  if (!def) return null;
  return {
    def,
    params: { ...def.defaultParams, ...(alias?.params || {}), ...((typeof spec === 'object' && spec.params) || {}) },
  };
}

export function transitionNames() {
  return { aliases: Object.keys(ALIASES), shaders: LIB ? Object.values(LIB).map((t) => t.name) : [] };
}

const VERT = `attribute vec2 _p; varying vec2 _uv;
void main(){ gl_Position = vec4(_p, 0.0, 1.0); _uv = vec2(0.5, 0.5) * (_p + vec2(1.0, 1.0)); }`;

const fragFor = (glsl) => `precision highp float;
varying vec2 _uv;
uniform sampler2D from, to;
uniform float progress, ratio;
vec4 getFromColor(vec2 uv){ return texture2D(from, uv); }
vec4 getToColor(vec2 uv){ return texture2D(to, uv); }
${glsl}
void main(){ gl_FragColor = transition(_uv); }`;

export class Transitioner {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    this.programs = new Map();
    if (!this.gl) return;
    const gl = this.gl;
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    this.texFrom = this._tex();
    this.texTo = this._tex();
  }

  _tex() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _program(def) {
    if (this.programs.has(def.name)) return this.programs.get(def.name);
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    let prog = null;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fragFor(def.glsl)));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) {
      console.warn(`transition ${def.name} failed to compile`, e);
      prog = null;
    }
    this.programs.set(def.name, prog);
    return prog;
  }

  // Blend two canvases. Returns a canvas to draw, or null when WebGL is unavailable.
  render(fromCanvas, toCanvas, progress, resolved) {
    const gl = this.gl;
    if (!gl || !resolved) return null;
    const prog = this._program(resolved.def);
    if (!prog) return null;
    const w = fromCanvas.width, h = fromCanvas.height;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texFrom);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fromCanvas);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texTo);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, toCanvas);
    gl.uniform1i(gl.getUniformLocation(prog, 'from'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'to'), 1);
    gl.uniform1f(gl.getUniformLocation(prog, 'progress'), progress);
    gl.uniform1f(gl.getUniformLocation(prog, 'ratio'), w / h);
    const types = resolved.def.paramsTypes || {};
    for (const [k, v] of Object.entries(resolved.params)) {
      const loc = gl.getUniformLocation(prog, k);
      if (!loc) continue;
      const ty = types[k];
      if (ty === 'float') gl.uniform1f(loc, v);
      else if (ty === 'int' || ty === 'bool') gl.uniform1i(loc, Number(v));
      else if (ty === 'vec2') gl.uniform2fv(loc, v);
      else if (ty === 'vec3') gl.uniform3fv(loc, v);
      else if (ty === 'vec4') gl.uniform4fv(loc, v);
      else if (ty === 'ivec2') gl.uniform2iv(loc, v);
    }
    const loc = gl.getAttribLocation(prog, '_p');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return this.canvas;
  }
}
