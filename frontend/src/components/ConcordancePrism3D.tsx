import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { AuditMode, Finding, GraviteFinding } from '../types';

/**
 * Prisme de concordance : les trois sources de vérité (Dit, Écrit, Réel) sont
 * les sommets d'un triangle posé sur une feuille ; chaque constat est une perle
 * placée en coordonnées barycentriques (attirée par les sources qui concordent,
 * repoussée de l'arête rompue). Les arêtes rompues du constat actif sont une
 * fissure vermillon (ShaderMaterial, bruit linéaire par morceaux).
 *
 * Décoratif : le canvas est aria-hidden, la sélection accessible passe par les
 * puces F-00x rendues par TriadTriangleViz.
 */

export interface ConcordancePrism3DProps {
  findings: Finding[];
  activeId: string | null;
  mode: AuditMode;
  onSelect: (f: Finding) => void;
  /** Appelé si WebGL échoue (création du contexte ou perte) : le parent repasse au SVG. */
  onFallback: () => void;
}

type Vertex = 'dit' | 'ecrit' | 'reel';
type Edge = 'dit-ecrit' | 'ecrit-reel' | 'dit-reel';

const SIDE = 4;
const H = (SIDE * Math.sqrt(3)) / 2;
const VERTS: Record<Vertex, THREE.Vector3> = {
  dit: new THREE.Vector3(-SIDE / 2, 0, -H / 3),
  ecrit: new THREE.Vector3(SIDE / 2, 0, -H / 3),
  reel: new THREE.Vector3(0, 0, (2 * H) / 3),
};
const EDGES: { key: Edge; a: Vertex; b: Vertex; seed: number }[] = [
  { key: 'dit-ecrit', a: 'dit', b: 'ecrit', seed: 3.1 },
  { key: 'ecrit-reel', a: 'ecrit', b: 'reel', seed: 11.7 },
  { key: 'dit-reel', a: 'dit', b: 'reel', seed: 23.9 },
];
const RADIUS: Record<GraviteFinding, number> = {
  critique: 0.17,
  haute: 0.135,
  moyenne: 0.105,
  faible: 0.082,
};
const PILLAR_H = 0.62;
const FOV = 26;
const ELEVATION = THREE.MathUtils.degToRad(50);

/* ---------- logique de rupture (identique au schéma SVG) ---------- */

export function brokenEdges(f: Finding | null): Record<Edge, boolean> {
  const c = (f?.contradiction || '').toLowerCase();
  const hasD = c.includes('dit');
  const hasE = c.includes('écrit');
  const hasR = c.includes('réel');
  const all = hasD && hasE && hasR;
  return {
    'dit-ecrit': all || (hasD && hasE && !hasR),
    'dit-reel': all || (hasD && hasR && !hasE),
    'ecrit-reel': all || (hasE && hasR && !hasD),
  };
}

function weights(f: Finding): Record<Vertex, number> {
  const w: Record<Vertex, number> = {
    dit: f.dit ? 1 : 0.42,
    ecrit: f.ecrit ? 1 : 0.42,
    reel: f.reel ? 1 : 0.42,
  };
  const br = brokenEdges(f);
  // Les deux sources en rupture s'affaiblissent : la perle quitte l'arête rompue
  // et glisse vers la source restée cohérente.
  for (const e of EDGES) {
    if (br[e.key]) {
      w[e.a] *= 0.4;
      w[e.b] *= 0.4;
    }
  }
  return w;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function layout(findings: Finding[]): Map<string, THREE.Vector3> {
  const base = new Map<string, THREE.Vector3>();
  for (const f of findings) {
    const w = weights(f);
    const sum = w.dit + w.ecrit + w.reel;
    const p = new THREE.Vector3()
      .addScaledVector(VERTS.dit, w.dit / sum)
      .addScaledVector(VERTS.ecrit, w.ecrit / sum)
      .addScaledVector(VERTS.reel, w.reel / sum)
      .multiplyScalar(0.84);
    base.set(f.id, p);
  }
  // Les constats de même profil partagent un point : on les égrène en spirale
  // dorée autour de lui (ordre stable par ID).
  const groups = new Map<string, string[]>();
  for (const f of findings) {
    const p = base.get(f.id)!;
    const key = `${p.x.toFixed(2)}:${p.z.toFixed(2)}`;
    const g = groups.get(key) ?? [];
    g.push(f.id);
    groups.set(key, g);
  }
  const out = new Map<string, THREE.Vector3>();
  for (const ids of groups.values()) {
    ids.sort();
    const n = ids.length;
    const phase = hashStr(ids[0]) * Math.PI * 2;
    ids.forEach((id, k) => {
      const p = base.get(id)!.clone();
      if (n > 1) {
        const r = 0.24 * Math.sqrt(k + 0.6);
        const a = phase + k * 2.39996;
        p.x += Math.cos(a) * r;
        p.z += Math.sin(a) * r;
      }
      out.set(id, p);
    });
  }
  return out;
}

/* ---------- couleurs lues depuis les variables CSS ---------- */

interface Rgba {
  color: THREE.Color;
  alpha: number;
}

function parseCss(value: string, fallback: string): Rgba {
  const v = value.trim() || fallback;
  const m = v.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i);
  if (m) {
    const c = new THREE.Color().setRGB(+m[1] / 255, +m[2] / 255, +m[3] / 255, THREE.SRGBColorSpace);
    return { color: c, alpha: m[4] !== undefined ? +m[4] : 1 };
  }
  const c = new THREE.Color();
  try {
    c.setStyle(v.startsWith('#') ? v.slice(0, 7) : fallback);
  } catch {
    c.setStyle(fallback);
  }
  return { color: c, alpha: 1 };
}

interface Palette {
  dit: Rgba;
  ecrit: Rgba;
  reel: Rgba;
  rupture: Rgba;
  ink: Rgba;
  inkSoft: Rgba;
  hairline: Rgba;
  paper: Rgba;
  surface: Rgba;
  dark: boolean;
}

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const g = (n: string, fb: string) => parseCss(cs.getPropertyValue(n), fb);
  return {
    dit: g('--dit', '#2350B8'),
    ecrit: g('--ecrit', '#7A3A9E'),
    reel: g('--reel', '#286E0A'),
    rupture: g('--rupture', '#B32F16'),
    ink: g('--text-primary', '#141A16'),
    inkSoft: g('--text-secondary', '#46504A'),
    hairline: g('--border-strong', 'rgba(20,26,22,0.24)'),
    paper: g('--bg-canvas', '#F2F3EF'),
    surface: g('--bg-surface', '#FBFBF8'),
    dark: document.documentElement.getAttribute('data-theme') === 'dark',
  };
}

/* ---------- shaders ---------- */

const NOISE = /* glsl */ `
  float hash1(float n) { return fract(sin(n) * 43758.5453123); }
  // Bruit de valeur à interpolation linéaire : une polyligne brisée, pas une onde.
  float jag(float x) {
    float i = floor(x);
    return mix(hash1(i), hash1(i + 1.0), fract(x));
  }
`;

const EDGE_VERT = /* glsl */ `
  ${NOISE}
  attribute float aT;
  attribute float aSide;
  uniform vec3 uA;
  uniform vec3 uB;
  uniform vec3 uPerp;
  uniform float uBroken;
  uniform float uTime;
  uniform float uSeed;
  varying float vT;
  varying float vSide;
  void main() {
    float t = aT;
    vec3 p = mix(uA, uB, t);
    float env = smoothstep(0.04, 0.16, t) * smoothstep(0.96, 0.84, t);
    float cells = 15.0;
    float crack = jag(t * cells + uSeed) - 0.5;
    // tressaillement : petite onde brisée qui glisse le long de la fissure
    float tremor = (jag(t * cells * 2.3 + uSeed * 1.7 + uTime * 2.2) - 0.5) * 0.3;
    float off = uBroken * env * (crack + tremor) * 0.2;
    float w = mix(0.016, 0.046, uBroken);
    p += uPerp * (off + aSide * w * 0.5);
    p.y += 0.004 + uBroken * 0.004;
    vT = t;
    vSide = aSide;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const EDGE_FRAG = /* glsl */ `
  ${NOISE}
  uniform vec3 uHealthy;
  uniform vec3 uRupture;
  uniform float uHealthyAlpha;
  uniform float uBroken;
  uniform float uSeed;
  uniform float uDim;
  varying float vT;
  varying float vSide;
  void main() {
    float cells = 15.0;
    float cell = floor(vT * cells);
    float f = fract(vT * cells);
    float env = step(0.12, vT) * step(vT, 0.88);
    // éclats : certaines cellules s'interrompent, la ligne est cassée
    float gap = step(0.58, hash1(cell * 7.13 + uSeed)) * step(0.7, f) * step(f, 0.92);
    if (gap * env * step(0.5, uBroken) > 0.5) discard;
    vec3 col = mix(uHealthy, uRupture, uBroken);
    float a = mix(uHealthyAlpha, 1.0, uBroken) * uDim;
    float soft = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
    gl_FragColor = vec4(col, a * mix(0.6, 1.0, soft));
    #include <colorspace_fragment>
  }
`;

const PAPER_VERT = /* glsl */ `
  varying vec2 vXZ;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vXZ = wp.xz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const PAPER_FRAG = /* glsl */ `
  uniform vec2 uD;
  uniform vec2 uE;
  uniform vec2 uR;
  uniform vec3 uPaper;
  uniform vec3 uDit;
  uniform vec3 uEcrit;
  uniform vec3 uReel;
  uniform float uTint;
  varying vec2 vXZ;
  vec3 bary(vec2 p) {
    vec2 v0 = uE - uD, v1 = uR - uD, v2 = p - uD;
    float d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1);
    float d20 = dot(v2, v0), d21 = dot(v2, v1);
    float den = d00 * d11 - d01 * d01;
    float v = (d11 * d20 - d01 * d21) / den;
    float w = (d00 * d21 - d01 * d20) / den;
    return vec3(1.0 - v - w, v, w);
  }
  void main() {
    vec3 b = bary(vXZ);
    float m = min(b.x, min(b.y, b.z));
    float aa = fwidth(m) * 1.5;
    float inside = smoothstep(-aa, aa, m);
    vec3 bc = clamp(b, 0.0, 1.0);
    vec3 tint = (bc.x * uDit + bc.y * uEcrit + bc.z * uReel) / max(bc.x + bc.y + bc.z, 1e-3);
    // iso-lignes barycentriques à un tiers : la trame de la feuille
    float iso = 0.0;
    for (int i = 0; i < 3; i++) {
      float c = b[i];
      float d = abs(c - 0.3333);
      float fw = fwidth(c);
      iso = max(iso, 1.0 - smoothstep(0.0, fw * 1.2, d));
    }
    vec3 col = mix(uPaper, tint, uTint * inside);
    col = mix(col, tint, iso * inside * 0.16);
    float r = length(vXZ - vec2(0.0, 0.25));
    float alpha = 1.0 - smoothstep(2.9, 4.2, r);
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`;

/* ---------- composant ---------- */

interface Bead {
  id: string;
  finding: Finding;
  group: THREE.Group;
  mat: THREE.MeshLambertMaterial;
  shadowMat: THREE.MeshBasicMaterial;
  hit: THREE.Mesh;
  target: THREE.Vector3;
  radius: number;
  opacity: number;
}

interface Scene3D {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  beads: Map<string, Bead>;
  beadRoot: THREE.Group;
  sphereGeo: THREE.SphereGeometry;
  shadowGeo: THREE.PlaneGeometry;
  hitGeo: THREE.SphereGeometry;
  shadowTex: THREE.Texture;
  hitMat: THREE.MeshBasicMaterial;
  edgeMats: Record<Edge, THREE.ShaderMaterial>;
  edgeTargets: Record<Edge, number>;
  paperMat: THREE.ShaderMaterial;
  pillarMats: Record<Vertex, THREE.MeshLambertMaterial>;
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  palette: Palette;
  lookTarget: THREE.Vector3;
  lookGoal: THREE.Vector3;
  dist: number;
  activeId: string | null;
  hoverId: string | null;
  snap: boolean;
  invalidate: () => void;
}

const VERTEX_LABELS: { key: Vertex; label: string }[] = [
  { key: 'dit', label: 'Dit' },
  { key: 'ecrit', label: 'Écrit' },
  { key: 'reel', label: 'Réel' },
];

function beadColor(f: Finding, p: Palette): THREE.Color {
  if (f.statut === 'non_conforme') return p.rupture.color;
  if (f.statut === 'conforme') return p.reel.color;
  return p.inkSoft.color;
}

const ConcordancePrism3D: React.FC<ConcordancePrism3DProps> = ({
  findings,
  activeId,
  mode,
  onSelect,
  onFallback,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRefs = useRef<Record<Vertex, HTMLDivElement | null>>({ dit: null, ecrit: null, reel: null });
  const tipRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene3D | null>(null);
  const findingsRef = useRef(findings);
  const onSelectRef = useRef(onSelect);
  const onFallbackRef = useRef(onFallback);
  const [hover, setHover] = useState<Finding | null>(null);
  findingsRef.current = findings;
  onSelectRef.current = onSelect;
  onFallbackRef.current = onFallback;

  /* Montage : renderer, scène statique, boucle, observateurs. */
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      onFallbackRef.current();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const reducedMq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let reduced = Boolean(reducedMq?.matches);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 60);
    const palette = readPalette();

    // Lumière mate : ciel + contre-jour doux, aucun spéculaire (Lambert).
    const hemi = new THREE.HemisphereLight(0xffffff, palette.paper.color, 2.1);
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-3, 6, 4);
    scene.add(hemi, sun);

    // Feuille
    const paperMat = new THREE.ShaderMaterial({
      vertexShader: PAPER_VERT,
      fragmentShader: PAPER_FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uD: { value: new THREE.Vector2(VERTS.dit.x, VERTS.dit.z) },
        uE: { value: new THREE.Vector2(VERTS.ecrit.x, VERTS.ecrit.z) },
        uR: { value: new THREE.Vector2(VERTS.reel.x, VERTS.reel.z) },
        uPaper: { value: new THREE.Color() },
        uDit: { value: new THREE.Color() },
        uEcrit: { value: new THREE.Color() },
        uReel: { value: new THREE.Color() },
        uTint: { value: 0.07 },
      },
    });
    const paperGeo = new THREE.PlaneGeometry(10, 10);
    const paper = new THREE.Mesh(paperGeo, paperMat);
    paper.rotation.x = -Math.PI / 2;
    paper.renderOrder = -2;
    scene.add(paper);

    // Arêtes (ruban plat, déplacé en shader)
    const SEG = 120;
    const edgeGeo = new THREE.BufferGeometry();
    {
      const pos = new Float32Array((SEG + 1) * 2 * 3);
      const aT = new Float32Array((SEG + 1) * 2);
      const aSide = new Float32Array((SEG + 1) * 2);
      const idx: number[] = [];
      for (let i = 0; i <= SEG; i++) {
        const t = i / SEG;
        aT[i * 2] = t;
        aT[i * 2 + 1] = t;
        aSide[i * 2] = -1;
        aSide[i * 2 + 1] = 1;
        if (i < SEG) {
          const a = i * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      edgeGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      edgeGeo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
      edgeGeo.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1));
      edgeGeo.setIndex(idx);
    }
    const up = new THREE.Vector3(0, 1, 0);
    const edgeMats = {} as Record<Edge, THREE.ShaderMaterial>;
    for (const e of EDGES) {
      const A = VERTS[e.a];
      const B = VERTS[e.b];
      const perp = new THREE.Vector3().subVectors(B, A).cross(up).normalize();
      const mat = new THREE.ShaderMaterial({
        vertexShader: EDGE_VERT,
        fragmentShader: EDGE_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uA: { value: A.clone() },
          uB: { value: B.clone() },
          uPerp: { value: perp },
          uBroken: { value: 0 },
          uTime: { value: 0 },
          uSeed: { value: e.seed },
          uHealthy: { value: new THREE.Color() },
          uRupture: { value: new THREE.Color() },
          uHealthyAlpha: { value: 0.5 },
          uDim: { value: 1 },
        },
      });
      const mesh = new THREE.Mesh(edgeGeo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = -1;
      scene.add(mesh);
      edgeMats[e.key] = mat;
    }

    // Piliers
    const pillarGeo = new THREE.CylinderGeometry(0.075, 0.075, PILLAR_H, 24, 1);
    pillarGeo.translate(0, PILLAR_H / 2, 0);
    const capGeo = new THREE.RingGeometry(0.16, 0.19, 48);
    capGeo.rotateX(-Math.PI / 2);
    const pillarMats = {} as Record<Vertex, THREE.MeshLambertMaterial>;
    const capMats: THREE.MeshBasicMaterial[] = [];
    for (const v of ['dit', 'ecrit', 'reel'] as Vertex[]) {
      const mat = new THREE.MeshLambertMaterial({ color: palette[v].color });
      pillarMats[v] = mat;
      const m = new THREE.Mesh(pillarGeo, mat);
      m.position.copy(VERTS[v]);
      scene.add(m);
      const capMat = new THREE.MeshBasicMaterial({ color: palette[v].color, transparent: true, opacity: 0.85, depthWrite: false });
      capMats.push(capMat);
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.copy(VERTS[v]).setY(0.006);
      scene.add(cap);
    }

    // Ombre de contact partagée
    const sc = document.createElement('canvas');
    sc.width = sc.height = 64;
    const sctx = sc.getContext('2d');
    if (sctx) {
      const grad = sctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(0,0,0,0.55)');
      grad.addColorStop(0.5, 'rgba(0,0,0,0.18)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      sctx.fillStyle = grad;
      sctx.fillRect(0, 0, 64, 64);
    }
    const shadowTex = new THREE.CanvasTexture(sc);
    const shadowGeo = new THREE.PlaneGeometry(1, 1);
    shadowGeo.rotateX(-Math.PI / 2);
    const sphereGeo = new THREE.SphereGeometry(1, 32, 20);
    const hitGeo = new THREE.SphereGeometry(1, 8, 6);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });

    const beadRoot = new THREE.Group();
    scene.add(beadRoot);

    // Anneau de sélection
    const ringGeo = new THREE.RingGeometry(1, 1.16, 64);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: palette.ink.color, transparent: true, opacity: 0, depthWrite: false });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.renderOrder = 1;
    scene.add(ring);

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const projV = new THREE.Vector3();

    let width = 1;
    let height = 1;
    let visible = true;
    let pageVisible = document.visibilityState !== 'hidden';
    let frameReq = 0;
    let looping = false;
    let last = performance.now();
    let time = 0;

    const s: Scene3D = {
      renderer,
      scene,
      camera,
      beads: new Map(),
      beadRoot,
      sphereGeo,
      shadowGeo,
      hitGeo,
      shadowTex,
      hitMat,
      edgeMats,
      edgeTargets: { 'dit-ecrit': 0, 'ecrit-reel': 0, 'dit-reel': 0 },
      paperMat,
      pillarMats,
      ring,
      ringMat,
      hemi,
      sun,
      palette,
      lookTarget: new THREE.Vector3(0, 0, 0.45),
      lookGoal: new THREE.Vector3(0, 0, 0.45),
      dist: 12,
      activeId: null,
      hoverId: null,
      snap: true,
      invalidate: () => {},
    };
    sceneRef.current = s;

    const applyPalette = () => {
      const p = readPalette();
      s.palette = p;
      paperMat.uniforms.uPaper.value.copy(p.paper.color);
      paperMat.uniforms.uDit.value.copy(p.dit.color);
      paperMat.uniforms.uEcrit.value.copy(p.ecrit.color);
      paperMat.uniforms.uReel.value.copy(p.reel.color);
      paperMat.uniforms.uTint.value = p.dark ? 0.06 : 0.07;
      hemi.groundColor.copy(p.paper.color);
      hemi.intensity = p.dark ? 1.6 : 2.1;
      sun.intensity = p.dark ? 1.1 : 1.5;
      (['dit', 'ecrit', 'reel'] as Vertex[]).forEach((v, i) => {
        pillarMats[v].color.copy(p[v].color);
        capMats[i].color.copy(p[v].color);
      });
      for (const e of EDGES) {
        edgeMats[e.key].uniforms.uRupture.value.copy(p.rupture.color);
      }
      ringMat.color.copy(p.ink.color);
      for (const b of s.beads.values()) {
        b.mat.color.copy(beadColor(b.finding, p));
        b.shadowMat.opacity = p.dark ? 0.7 : 0.45;
      }
      updateHealthy();
      s.invalidate();
    };

    const updateHealthy = () => {
      const p = s.palette;
      const active = findingsRef.current.find((f) => f.id === s.activeId);
      const clean = active?.statut === 'conforme';
      for (const e of EDGES) {
        const u = edgeMats[e.key].uniforms;
        u.uHealthy.value.copy(clean ? p.reel.color : p.ink.color);
        u.uHealthyAlpha.value = clean ? 0.75 : Math.max(0.32, p.hairline.alpha * 1.6);
      }
    };

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      width = Math.max(1, Math.round(r.width));
      height = Math.max(1, Math.round(r.height));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      // Cadrage : la feuille entière tient dans le champ, quelle que soit la largeur.
      const tv = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      const halfW = 2.75;
      const halfH = 2.45;
      s.dist = Math.max(halfH / tv, halfW / (tv * camera.aspect));
      camera.updateProjectionMatrix();
      s.invalidate();
    };

    const placeCamera = () => {
      camera.position.set(
        s.lookTarget.x,
        s.lookTarget.y + Math.sin(ELEVATION) * s.dist,
        s.lookTarget.z + Math.cos(ELEVATION) * s.dist,
      );
      camera.lookAt(s.lookTarget);
    };

    const project = (v: THREE.Vector3) => {
      projV.copy(v).project(camera);
      return { x: (projV.x * 0.5 + 0.5) * width, y: (-projV.y * 0.5 + 0.5) * height };
    };

    const updateOverlays = () => {
      for (const { key } of VERTEX_LABELS) {
        const el = labelRefs.current[key];
        if (!el) continue;
        const top = VERTS[key].clone().setY(PILLAR_H + 0.22);
        const q = project(top);
        el.style.transform = `translate3d(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      }
      const tip = tipRef.current;
      if (tip) {
        const b = s.hoverId ? s.beads.get(s.hoverId) : undefined;
        if (b) {
          const q = project(b.group.position.clone().setY(b.radius * 2 + 0.05));
          const x = Math.min(Math.max(q.x, 70), width - 70);
          tip.style.transform = `translate3d(${x.toFixed(1)}px, ${q.y.toFixed(1)}px, 0) translate(-50%, calc(-100% - 6px))`;
        }
      }
    };

    const damp = (k: number, dt: number) => (s.snap ? 1 : 1 - Math.exp(-k * dt));

    const step = (dt: number) => {
      let moving = false;
      const kPos = damp(7, dt);
      s.lookTarget.lerp(s.lookGoal, damp(3.2, dt));
      if (s.lookTarget.distanceToSquared(s.lookGoal) > 1e-6) moving = true;
      placeCamera();
      for (const b of s.beads.values()) {
        const goalOpacity = s.activeId === null || b.id === s.activeId ? 1 : b.id === s.hoverId ? 0.85 : 0.4;
        b.group.position.lerp(b.target, kPos);
        b.opacity += (goalOpacity - b.opacity) * damp(9, dt);
        b.mat.opacity = b.opacity;
        b.mat.transparent = b.opacity < 0.99;
        b.mat.depthWrite = b.opacity > 0.99;
        b.shadowMat.opacity = (s.palette.dark ? 0.7 : 0.45) * b.opacity;
        if (b.group.position.distanceToSquared(b.target) > 1e-6 || Math.abs(goalOpacity - b.opacity) > 1e-3) moving = true;
      }
      const active = s.activeId ? s.beads.get(s.activeId) : undefined;
      const ringGoal = active ? 1 : 0;
      ringMat.opacity += (ringGoal - ringMat.opacity) * damp(8, dt);
      if (active) {
        ring.position.set(active.group.position.x, 0.008, active.group.position.z);
        const rs = active.radius + 0.075;
        ring.scale.setScalar(rs);
      }
      for (const e of EDGES) {
        const u = edgeMats[e.key].uniforms;
        u.uBroken.value += (s.edgeTargets[e.key] - u.uBroken.value) * damp(5, dt);
        u.uTime.value = reduced ? 0 : time;
        if (Math.abs(s.edgeTargets[e.key] - u.uBroken.value) > 1e-3) moving = true;
      }
      return moving;
    };

    const renderNow = () => {
      updateOverlays();
      renderer.render(scene, camera);
    };

    const anyBroken = () => EDGES.some((e) => s.edgeTargets[e.key] > 0.5);

    const tick = () => {
      frameReq = 0;
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      time += dt;
      const moving = step(dt);
      s.snap = false;
      renderNow();
      // La boucle ne continue que si quelque chose bouge (transition ou fissure qui tressaille).
      if (looping && (moving || anyBroken())) {
        frameReq = requestAnimationFrame(tick);
      } else {
        looping = false;
      }
    };

    const invalidate = () => {
      if (!visible || !pageVisible) return;
      if (reduced) {
        // Une frame, état final directement.
        s.snap = true;
        step(0);
        s.snap = false;
        renderNow();
        return;
      }
      if (!looping) {
        looping = true;
        last = performance.now();
        frameReq = requestAnimationFrame(tick);
      }
    };
    s.invalidate = invalidate;

    const stopLoop = () => {
      if (frameReq) cancelAnimationFrame(frameReq);
      frameReq = 0;
      looping = false;
    };

    applyPalette();
    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    const io = new IntersectionObserver(
      (entries) => {
        visible = entries.some((en) => en.isIntersecting);
        if (visible) invalidate();
        else stopLoop();
      },
      { threshold: 0 },
    );
    io.observe(wrap);
    const onVis = () => {
      pageVisible = document.visibilityState !== 'hidden';
      if (pageVisible) invalidate();
      else stopLoop();
    };
    document.addEventListener('visibilitychange', onVis);
    const mo = new MutationObserver(applyPalette);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    const onReduced = (ev: MediaQueryListEvent) => {
      reduced = ev.matches;
      stopLoop();
      invalidate();
    };
    reducedMq?.addEventListener?.('change', onReduced);

    // Interaction : survol et tap
    const pick = (ev: PointerEvent): Bead | undefined => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(
        [...s.beads.values()].map((b) => b.hit),
        false,
      );
      const id = hits[0]?.object.userData.id as string | undefined;
      return id ? s.beads.get(id) : undefined;
    };
    const setHoverBead = (b: Bead | undefined) => {
      const id = b?.id ?? null;
      if (id === s.hoverId) return;
      s.hoverId = id;
      canvas.style.cursor = id ? 'pointer' : 'default';
      setHover(b ? b.finding : null);
      invalidate();
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerType === 'touch') return;
      setHoverBead(pick(ev));
    };
    const onLeave = () => setHoverBead(undefined);
    let downAt: { x: number; y: number } | null = null;
    const onDown = (ev: PointerEvent) => {
      downAt = { x: ev.clientX, y: ev.clientY };
    };
    const onUp = (ev: PointerEvent) => {
      if (!downAt) return;
      const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
      downAt = null;
      if (moved > 8) return;
      const b = pick(ev);
      if (b) onSelectRef.current(b.finding);
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);

    const onLost = (ev: Event) => {
      ev.preventDefault();
      stopLoop();
      onFallbackRef.current();
    };
    canvas.addEventListener('webglcontextlost', onLost);

    return () => {
      stopLoop();
      ro.disconnect();
      io.disconnect();
      mo.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      reducedMq?.removeEventListener?.('change', onReduced);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('webglcontextlost', onLost);
      for (const b of s.beads.values()) {
        b.mat.dispose();
        b.shadowMat.dispose();
      }
      s.beads.clear();
      [paperGeo, edgeGeo, pillarGeo, capGeo, shadowGeo, sphereGeo, hitGeo, ringGeo].forEach((g) => g.dispose());
      [paperMat, ...Object.values(edgeMats), ...Object.values(pillarMats), ...capMats, hitMat, ringMat].forEach((m) =>
        m.dispose(),
      );
      shadowTex.dispose();
      renderer.dispose();
      sceneRef.current = null;
    };
  }, []);

  /* Synchronisation des perles avec la liste de constats. */
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const pos = layout(findings);
    const keep = new Set(findings.map((f) => f.id));
    for (const [id, b] of s.beads) {
      if (!keep.has(id)) {
        s.beadRoot.remove(b.group);
        b.mat.dispose();
        b.shadowMat.dispose();
        s.beads.delete(id);
      }
    }
    for (const f of findings) {
      const target = pos.get(f.id)!;
      const radius = RADIUS[f.gravite] ?? RADIUS.moyenne;
      let b = s.beads.get(f.id);
      if (!b) {
        const group = new THREE.Group();
        const mat = new THREE.MeshLambertMaterial({ color: beadColor(f, s.palette) });
        const sphere = new THREE.Mesh(s.sphereGeo, mat);
        const shadowMat = new THREE.MeshBasicMaterial({
          map: s.shadowTex,
          transparent: true,
          depthWrite: false,
          opacity: 0.45,
          color: 0x000000,
        });
        const shadow = new THREE.Mesh(s.shadowGeo, shadowMat);
        shadow.position.y = 0.003;
        const hit = new THREE.Mesh(s.hitGeo, s.hitMat);
        hit.userData.id = f.id;
        group.add(sphere, shadow, hit);
        group.position.copy(target);
        s.beadRoot.add(group);
        b = { id: f.id, finding: f, group, mat, shadowMat, hit, target: target.clone(), radius, opacity: 1 };
        s.beads.set(f.id, b);
      }
      b.finding = f;
      b.target.copy(target);
      b.radius = radius;
      b.target.y = 0;
      const sphere = b.group.children[0];
      sphere.scale.setScalar(radius);
      sphere.position.y = radius;
      b.group.children[1].scale.setScalar(radius * 3.2);
      const hitR = Math.max(radius * 1.5, 0.2);
      b.hit.scale.setScalar(hitR);
      b.hit.position.y = radius;
      b.mat.color.copy(beadColor(f, s.palette));
    }
    s.invalidate();
  }, [findings]);

  /* Constat actif : arêtes rompues, anneau, glissement de caméra. */
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.activeId = activeId;
    const active = findings.find((f) => f.id === activeId) ?? null;
    const br = brokenEdges(active);
    for (const e of EDGES) s.edgeTargets[e.key] = br[e.key] ? 1 : 0;
    const clean = active?.statut === 'conforme';
    const p = s.palette;
    for (const e of EDGES) {
      const u = s.edgeMats[e.key].uniforms;
      u.uHealthy.value.copy(clean ? p.reel.color : p.ink.color);
      u.uHealthyAlpha.value = clean ? 0.75 : Math.max(0.32, p.hairline.alpha * 1.6);
    }
    const b = activeId ? s.beads.get(activeId) : undefined;
    const base = new THREE.Vector3(0, 0, 0.45);
    if (b) base.lerp(b.target, 0.14);
    s.lookGoal.copy(base);
    s.invalidate();
  }, [activeId, findings]);

  const sub: Record<Vertex, string> = {
    dit: mode === 'AVANT' ? 'N/A' : 'Entretien',
    ecrit: 'PSSI / PV',
    reel: 'Cloud GCP',
  };

  return (
    <div ref={wrapRef} className="relative w-full h-[260px] sm:h-[300px] overflow-hidden select-none">
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 w-full h-full block touch-manipulation" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {VERTEX_LABELS.map(({ key, label }) => (
          <div
            key={key}
            ref={(el) => {
              labelRefs.current[key] = el;
            }}
            className="absolute left-0 top-0 text-center leading-tight whitespace-nowrap pb-1"
            style={{ willChange: 'transform' }}
          >
            <div className="text-xs font-semibold" style={{ color: `var(--${key})` }}>
              {label}
            </div>
            <div className="text-[11px] text-sub">{sub[key]}</div>
          </div>
        ))}
        <div
          ref={tipRef}
          className={`absolute left-0 top-0 max-w-[200px] rounded-md border border-strong bg-[var(--bg-elevated)] px-2 py-1 shadow-[var(--shadow-panel)] transition-opacity duration-150 ${
            hover ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {hover && (
            <>
              <span className="font-mono text-[11px] font-semibold text-sub mr-1.5">{hover.id}</span>
              <span className="text-xs text-main">{hover.theme}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ConcordancePrism3D;
