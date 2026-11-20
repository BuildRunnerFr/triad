import React, { useEffect, useRef } from 'react';

/**
 * Relevé topographique de la vérité.
 *
 * Champ de courbes de niveau (encre sur papier) rendu par un unique fragment shader
 * WebGL brut. Chaque constat non conforme creuse un « puits » dans le relief :
 * position déterministe dérivée de son identifiant, profondeur selon sa gravité.
 * Purement décoratif (aria-hidden) : l'information reste portée par le texte du Cockpit.
 */

export interface ContourWell {
  id: string;
  /** Profondeur relative 0..1 (gravité). */
  depth: number;
  /** Puits critique : un point vermillon marque son fond. */
  critical: boolean;
}

interface TruthContourFieldProps {
  wells: ContourWell[];
  className?: string;
  style?: React.CSSProperties;
}

const MAX_WELLS = 24;
/** Période de la respiration du relief (s). */
const BREATH_PERIOD = 36;

const FRAG_BODY = /* glsl */ `
uniform vec2 u_res;
uniform float u_dpr;
uniform float u_time;
uniform vec3 u_mouse;      // xy : position en px (repère gl), z : intensité du survol 0..1
uniform vec3 u_ink;
uniform float u_inkAlpha;
uniform vec3 u_rupture;
uniform vec4 u_wells[${MAX_WELLS}]; // xy : position uv, z : profondeur, w : critique (1/0)
uniform float u_count;

const float TAU = 6.28318530718;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = rot * p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  float aspect = u_res.x / u_res.y;
  vec2 p = (frag / u_res - 0.5) * vec2(aspect, 1.0);

  // Respiration : la dérive du bruit décrit un cercle lent (boucle parfaite, période ≥ 20 s).
  float phase = u_time * TAU / ${BREATH_PERIOD.toFixed(1)};
  vec2 drift = vec2(cos(phase), sin(phase)) * 0.22;
  float breath = 1.0 + 0.06 * sin(phase * 2.0);

  float h = fbm(p * 1.35 + drift) * 0.9;
  for (int i = 0; i < ${MAX_WELLS}; i++) {
    if (float(i) >= u_count) break;
    vec4 w = u_wells[i];
    vec2 c = (w.xy - 0.5) * vec2(aspect, 1.0);
    float r = 0.07 + 0.11 * w.z;
    vec2 d = p - c;
    h -= w.z * 0.55 * breath * exp(-dot(d, d) / (r * r));
  }

  // Loupe de géomètre : les isolignes se resserrent autour du curseur.
  vec2 dm = (frag - u_mouse.xy) / u_res.y;
  float lens = u_mouse.z * exp(-dot(dm, dm) / 0.035);
  float levels = 11.0 * (1.0 + 0.85 * lens);

  float v = h * levels;
  float fw = max(fwidth(v), 1e-4);
  float dist = abs(fract(v - 0.5) - 0.5) / fw;   // distance à l'isoligne, en px écran
  float idx = floor(v + 0.5);
  float master = 1.0 - step(0.5, abs(mod(idx, 5.0)));
  float halfWidth = mix(0.5, 0.95, master) * u_dpr;
  float line = 1.0 - smoothstep(halfWidth - 0.5, halfWidth + 0.75, dist);
  float alpha = line * u_inkAlpha * mix(0.75, 1.45, master);

  // Fond des puits critiques : un point vermillon minuscule.
  float dotA = 0.0;
  for (int i = 0; i < ${MAX_WELLS}; i++) {
    if (float(i) >= u_count) break;
    vec4 w = u_wells[i];
    float dpx = length(frag - w.xy * u_res);
    float rr = 1.6 * u_dpr;
    dotA = max(dotA, w.w * (1.0 - smoothstep(rr - 0.75, rr + 0.75, dpx)));
  }

  vec3 col = mix(u_ink, u_rupture, dotA);
  float a = max(alpha, dotA * 0.9);
  FRAG_OUT = vec4(col * a, a);
}
`;

const VERT_WEBGL1 = `attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const VERT_WEBGL2 = `#version 300 es
in vec2 a_pos; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAG_HEAD_WEBGL1 = `#extension GL_OES_standard_derivatives : enable
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#define FRAG_OUT gl_FragColor
`;
const FRAG_HEAD_WEBGL2 = `#version 300 es
precision highp float;
out vec4 fragColor;
#define FRAG_OUT fragColor
`;

/** FNV-1a 32 bits puis mélange : position stable d'un constat d'une session à l'autre. */
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function unitPair(id: string): [number, number] {
  let s = hashId(id);
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return [next(), next()];
}

interface InkColors {
  ink: [number, number, number];
  inkAlpha: number;
  rupture: [number, number, number];
}

function parseRgb(value: string): [number, number, number, number] | null {
  const m = value.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return [parts[0] / 255, parts[1] / 255, parts[2] / 255, parts.length > 3 ? parts[3] : 1];
}

function readColors(probe: HTMLElement): InkColors {
  probe.style.color = 'var(--border-strong)';
  const border = parseRgb(getComputedStyle(probe).color) ?? [0.08, 0.1, 0.09, 0.24];
  probe.style.color = 'var(--rupture)';
  const rupture = parseRgb(getComputedStyle(probe).color) ?? [0.7, 0.18, 0.09, 1];
  return {
    ink: [border[0], border[1], border[2]],
    inkAlpha: Math.min(0.4, Math.max(0.12, border[3] * 0.85)),
    rupture: [rupture[0], rupture[1], rupture[2]],
  };
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    console.warn('[TruthContourField]', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

const TruthContourField: React.FC<TruthContourFieldProps> = ({ wells, className, style }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wellsRef = useRef(wells);
  const wellsDirty = useRef(true);
  const requestFrameRef = useRef<() => void>(() => {});

  useEffect(() => {
    wellsRef.current = wells;
    wellsDirty.current = true;
    requestFrameRef.current();
  }, [wells]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = reduceQuery.matches;

    const attrs: WebGLContextAttributes = {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    };
    let gl: WebGLRenderingContext | null = null;
    let isWebGL2 = false;
    try {
      gl = canvas.getContext('webgl2', attrs) as WebGLRenderingContext | null;
      isWebGL2 = Boolean(gl);
      if (!gl) {
        gl = canvas.getContext('webgl', attrs) as WebGLRenderingContext | null;
        if (gl && !gl.getExtension('OES_standard_derivatives')) gl = null;
      }
    } catch {
      gl = null;
    }
    if (!gl) {
      wrap.style.display = 'none';
      return;
    }
    const ctx = gl;

    const probe = document.createElement('span');
    probe.style.display = 'none';
    wrap.appendChild(probe);

    let program: WebGLProgram | null = null;
    let buffer: WebGLBuffer | null = null;
    let shaders: WebGLShader[] = [];
    let loc: Record<string, WebGLUniformLocation | null> = {};
    let colors = readColors(probe);
    const wellData = new Float32Array(MAX_WELLS * 4);
    let wellCount = 0;

    const buildWells = () => {
      const list = wellsRef.current.slice(0, MAX_WELLS);
      wellData.fill(0);
      list.forEach((w, i) => {
        const [u, v] = unitPair(w.id);
        // Le relief se creuse surtout côté droit, loin du chiffre et du titre.
        wellData[i * 4] = 0.3 + u * 0.64;
        wellData[i * 4 + 1] = 0.16 + v * 0.7;
        wellData[i * 4 + 2] = Math.max(0, Math.min(1, w.depth));
        wellData[i * 4 + 3] = w.critical ? 1 : 0;
      });
      wellCount = list.length;
      wellsDirty.current = false;
    };

    const init = (): boolean => {
      const vs = compile(ctx, ctx.VERTEX_SHADER, isWebGL2 ? VERT_WEBGL2 : VERT_WEBGL1);
      const fs = compile(
        ctx,
        ctx.FRAGMENT_SHADER,
        (isWebGL2 ? FRAG_HEAD_WEBGL2 : FRAG_HEAD_WEBGL1) + FRAG_BODY
      );
      if (!vs || !fs) return false;
      const prog = ctx.createProgram();
      if (!prog) return false;
      ctx.attachShader(prog, vs);
      ctx.attachShader(prog, fs);
      ctx.bindAttribLocation(prog, 0, 'a_pos');
      ctx.linkProgram(prog);
      if (!ctx.getProgramParameter(prog, ctx.LINK_STATUS)) return false;
      program = prog;
      shaders = [vs, fs];
      buffer = ctx.createBuffer();
      ctx.bindBuffer(ctx.ARRAY_BUFFER, buffer);
      // Un seul triangle couvre tout l'écran (pas de diagonale de quad).
      ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), ctx.STATIC_DRAW);
      ctx.enableVertexAttribArray(0);
      ctx.vertexAttribPointer(0, 2, ctx.FLOAT, false, 0, 0);
      ctx.useProgram(prog);
      loc = {};
      for (const name of ['u_res', 'u_dpr', 'u_time', 'u_mouse', 'u_ink', 'u_inkAlpha', 'u_rupture', 'u_wells', 'u_count']) {
        loc[name] = ctx.getUniformLocation(prog, name);
      }
      ctx.disable(ctx.DEPTH_TEST);
      ctx.clearColor(0, 0, 0, 0);
      wellsDirty.current = true;
      return true;
    };

    const release = () => {
      if (ctx.isContextLost()) return;
      if (buffer) ctx.deleteBuffer(buffer);
      if (program) ctx.deleteProgram(program);
      shaders.forEach((s) => ctx.deleteShader(s));
      buffer = null;
      program = null;
      shaders = [];
    };

    if (!init()) {
      release();
      probe.remove();
      wrap.style.display = 'none';
      return;
    }

    // --- Taille (DPR plafonné à 2) ---
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      requestFrame();
    };

    // --- Survol (loupe) ---
    const zone = wrap.parentElement ?? wrap;
    const mouse = { x: 0, y: 0, target: 0, value: 0 };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || reduced) return;
      const rect = canvas.getBoundingClientRect();
      mouse.x = (e.clientX - rect.left) * dpr;
      mouse.y = (rect.bottom - e.clientY) * dpr;
      mouse.target = 1;
      requestFrame();
    };
    const onLeave = () => {
      mouse.target = 0;
      requestFrame();
    };
    zone.addEventListener('pointermove', onMove, { passive: true });
    zone.addEventListener('pointerleave', onLeave);

    // --- Boucle ---
    let raf = 0;
    let visible = true;
    let lastNow = performance.now();
    let elapsed = 0;
    let lastDraw = 0;
    // En mouvement réduit : une frame figée, à un instant choisi pour sa composition.
    const STATIC_TIME = BREATH_PERIOD * 0.2;

    const draw = () => {
      if (!program || ctx.isContextLost()) return;
      if (wellsDirty.current) buildWells();
      ctx.viewport(0, 0, canvas.width, canvas.height);
      ctx.clear(ctx.COLOR_BUFFER_BIT);
      ctx.uniform2f(loc.u_res, canvas.width, canvas.height);
      ctx.uniform1f(loc.u_dpr, dpr);
      ctx.uniform1f(loc.u_time, reduced ? STATIC_TIME : elapsed);
      ctx.uniform3f(loc.u_mouse, mouse.x, mouse.y, reduced ? 0 : mouse.value);
      ctx.uniform3f(loc.u_ink, colors.ink[0], colors.ink[1], colors.ink[2]);
      ctx.uniform1f(loc.u_inkAlpha, colors.inkAlpha);
      ctx.uniform3f(loc.u_rupture, colors.rupture[0], colors.rupture[1], colors.rupture[2]);
      ctx.uniform4fv(loc.u_wells, wellData);
      ctx.uniform1f(loc.u_count, wellCount);
      ctx.drawArrays(ctx.TRIANGLES, 0, 3);
    };

    const tick = (now: number) => {
      raf = 0;
      const dt = Math.min(0.1, (now - lastNow) / 1000);
      lastNow = now;
      elapsed += dt;
      // Approche exponentielle de la loupe (indépendante du débit d'images).
      mouse.value += (mouse.target - mouse.value) * (1 - Math.exp(-dt * 7));
      const settling = Math.abs(mouse.target - mouse.value) > 0.002;
      // Dérive très lente : 30 i/s suffisent ; la loupe en cours d'animation passe à pleine cadence.
      if (settling || mouse.target > 0 || now - lastDraw >= 33) {
        draw();
        lastDraw = now;
      }
      schedule();
    };

    const schedule = () => {
      if (raf || reduced || !visible || document.hidden) return;
      raf = requestAnimationFrame(tick);
    };

    function requestFrame() {
      if (reduced || !visible || document.hidden) {
        draw();
        return;
      }
      lastNow = performance.now();
      schedule();
    }
    requestFrameRef.current = requestFrame;

    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const io = new IntersectionObserver(
      (entries) => {
        visible = entries[entries.length - 1]?.isIntersecting ?? true;
        if (visible) requestFrame();
        else stop();
      },
      { rootMargin: '80px' }
    );
    io.observe(wrap);

    const onVisibility = () => {
      if (document.hidden) stop();
      else requestFrame();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const onReduce = () => {
      reduced = reduceQuery.matches;
      if (reduced) {
        stop();
        mouse.value = 0;
        mouse.target = 0;
        draw();
      } else requestFrame();
    };
    reduceQuery.addEventListener('change', onReduce);

    // Thème : data-theme sur <html> ou sur un ancêtre.
    const refreshColors = () => {
      colors = readColors(probe);
      draw();
    };
    const mo = new MutationObserver(refreshColors);
    const themed = new Set<Element>([document.documentElement]);
    for (let el: Element | null = wrap.parentElement; el; el = el.parentElement) {
      if (el.hasAttribute('data-theme')) themed.add(el);
    }
    themed.forEach((el) => mo.observe(el, { attributes: true, attributeFilter: ['data-theme'] }));

    const onLost = (e: Event) => {
      e.preventDefault();
      stop();
      program = null;
      buffer = null;
      shaders = [];
    };
    const onRestored = () => {
      if (init()) requestFrame();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    resize();
    draw();

    return () => {
      stop();
      requestFrameRef.current = () => {};
      ro.disconnect();
      io.disconnect();
      mo.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      reduceQuery.removeEventListener('change', onReduce);
      zone.removeEventListener('pointermove', onMove);
      zone.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      release();
      ctx.getExtension('WEBGL_lose_context')?.loseContext();
      probe.remove();
    };
  }, []);

  return (
    <div ref={wrapRef} aria-hidden="true" className={className} style={style}>
      <canvas ref={canvasRef} className="block w-full h-full pointer-events-none" />
    </div>
  );
};

export default TruthContourField;
