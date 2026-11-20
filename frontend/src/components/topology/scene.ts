import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { readTopologyPalette, type TopologyPalette } from './palette';
import { createLabel, LABEL_SPRITE_H } from './labels';
import {
  createContactShadowMaterial,
  createFlowPointsMaterial,
  createLeakWaveMaterial,
  createLinkMaterial,
  createPlatformTopMaterial,
  createScanPlaneMaterial,
} from './materials';

/* ------------------------------------------------------------------ */
/* Types partagés avec le composant                                    */
/* ------------------------------------------------------------------ */

export type NodeStatus = 'critical' | 'warning' | 'compliant' | 'attacker' | 'auditor';

export interface SceneNodeSpec {
  id: string;
  label: string;
  sublabel: string;
  position: [number, number, number];
  status: NodeStatus;
  shape: 'icosahedron' | 'cylinder' | 'octahedron' | 'dodecahedron' | 'box';
  attackFromInternet?: boolean;
}

export type LinkKind = 'attack' | 'lateral' | 'audit';

export interface LinkSpec {
  id: string;
  kind: LinkKind;
  /** Sens du flux de particules : de `from` vers `to`. */
  from: string;
  to: string;
  /** Mène à une exposition publique : vermillon. Sinon : encre. */
  exposure: boolean;
}

export interface NodeVisualState {
  opacity: number;
  scale: number;
  label: number;
  /** Onde de fuite, anneau conforme, trait vertical. */
  accent: number;
}

export interface TopologyVisualState {
  nodes: Record<string, NodeVisualState>;
  /** Facteur multiplicatif de l'opacité de base de chaque lien. */
  links: Record<string, number>;
}

export interface TopologySceneCallbacks {
  onHover: (id: string | null) => void;
  onClick: (id: string | null) => void;
  onDoubleClick: (id: string | null) => void;
}

export interface TopologySceneApi {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  applyState: (state: TopologyVisualState) => void;
  setSelected: (id: string | null) => void;
  setReducedMotion: (reduced: boolean) => void;
  refreshPalette: () => void;
  /** Déplace la caméra (amortie, ou instantanée en mouvement réduit). */
  flyTo: (position: THREE.Vector3, target: THREE.Vector3) => void;
  cancelFlight: () => void;
  invalidate: () => void;
  renderNow: () => void;
  dispose: () => void;
}

export const DEFAULT_CAMERA_POS = new THREE.Vector3(-1.1, 4.4, 9.6);
export const DEFAULT_CAMERA_TARGET = new THREE.Vector3(0.5, 0.15, 0);

/** Recul de la caméra pour que la plateforme tienne en largeur sur les cadres étroits (mobile). */
const homePositionFor = (aspect: number): THREE.Vector3 => {
  const fit = aspect >= 1.5 ? 1 : Math.min(2.2, 1.3 / Math.max(aspect, 0.4));
  return DEFAULT_CAMERA_POS.clone().sub(DEFAULT_CAMERA_TARGET).multiplyScalar(fit).add(DEFAULT_CAMERA_TARGET);
};
/** En dessous de cette largeur, seules les étiquettes critiques restent affichées au repos. */
const COMPACT_LABEL_WIDTH = 560;

/* ------------------------------------------------------------------ */
/* Géométrie de la scène                                               */
/* ------------------------------------------------------------------ */

const PLATFORM_CENTER = new THREE.Vector2(2.05, 0);
const PLATFORM_R_TOP = 3.85;
const PLATFORM_R_BOTTOM = 4.05;
const PLATFORM_THICK = 0.12;
const PLATFORM_Y = -1.48;
const FLOOR_Y = PLATFORM_Y + PLATFORM_THICK / 2;

const SCAN_PERIOD = 8;
const SCAN_SWEEP = 4.6;
const SCAN_X_MIN = PLATFORM_CENTER.x - PLATFORM_R_TOP - 0.15;
const SCAN_X_MAX = PLATFORM_CENTER.x + PLATFORM_R_TOP + 0.15;
const SCAN_HEIGHT = 3.1;
const STATIC_SCAN_PROGRESS = 0.62;

export function buildLinks(specs: SceneNodeSpec[]): LinkSpec[] {
  const links: LinkSpec[] = [];
  const byId = new Map(specs.map((s) => [s.id, s]));
  const internet = byId.get('internet');
  if (internet) {
    for (const s of specs) {
      if (s.id !== 'internet' && s.attackFromInternet) {
        links.push({ id: `attack:${s.id}`, kind: 'attack', from: 'internet', to: s.id, exposure: true });
      }
    }
  }
  const ssh = byId.get('allow-ssh-anywhere');
  const dpi = byId.get('backups-dpi');
  if (ssh && dpi && dpi.status !== 'compliant') {
    links.push({
      id: 'lateral',
      kind: 'lateral',
      from: ssh.id,
      to: dpi.id,
      exposure: ssh.status === 'critical',
    });
  }
  const auditor = byId.get('auditor-sa');
  if (auditor) {
    for (const s of specs) {
      if (s.id === 'internet' || s.id === auditor.id) continue;
      // La sonde lit la configuration : le flux remonte de la ressource vers elle.
      links.push({ id: `audit:${s.id}`, kind: 'audit', from: s.id, to: auditor.id, exposure: false });
    }
  }
  return links;
}

function statusColor(p: TopologyPalette, s: NodeStatus): THREE.Color {
  if (s === 'critical' || s === 'attacker') return p.rupture;
  if (s === 'warning') return p.warning;
  if (s === 'compliant') return p.reel;
  return p.dit;
}

function statusCss(p: TopologyPalette, s: NodeStatus): string {
  if (s === 'critical' || s === 'attacker') return p.css.rupture;
  if (s === 'warning') return p.css.warning;
  if (s === 'compliant') return p.css.reel;
  return p.css.dit;
}

function geometryFor(shape: SceneNodeSpec['shape']): THREE.BufferGeometry {
  switch (shape) {
    case 'icosahedron':
      return new THREE.IcosahedronGeometry(0.56, 1);
    case 'cylinder':
      return new THREE.CylinderGeometry(0.42, 0.42, 0.62, 40);
    case 'octahedron':
      return new THREE.OctahedronGeometry(0.48, 0);
    case 'dodecahedron':
      return new THREE.DodecahedronGeometry(0.45, 0);
    default:
      return new THREE.BoxGeometry(0.6, 0.6, 0.6);
  }
}

function insidePlatform(x: number, z: number): boolean {
  const px = x - PLATFORM_CENTER.x;
  const pz = z - PLATFORM_CENTER.y;
  const apothem = PLATFORM_R_TOP * Math.cos(Math.PI / 6);
  for (let k = 0; k < 6; k += 1) {
    const a = ((30 + 60 * k) * Math.PI) / 180;
    if (px * Math.sin(a) + pz * Math.cos(a) > apothem - 0.1) return false;
  }
  return true;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

interface NodeHandle {
  spec: SceneNodeSpec;
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  outlineMat: THREE.MeshBasicMaterial;
  label: THREE.Sprite;
  labelMat: THREE.SpriteMaterial;
  labelBaseY: number;
  redrawLabel: (p: TopologyPalette) => void;
  shadowMat: THREE.ShaderMaterial | null;
  shadowBase: number;
  waveMat: THREE.ShaderMaterial | null;
  ringMat: THREE.MeshBasicMaterial | null;
  leaderMat: THREE.LineBasicMaterial | null;
  state: NodeVisualState;
  currentScale: number;
  hoverMix: number;
  rim: number;
}

interface LinkHandle {
  spec: LinkSpec;
  curve: THREE.QuadraticBezierCurve3;
  mat: THREE.ShaderMaterial;
  baseOpacity: number;
  factor: number;
  particleStart: number;
  particleCount: number;
  speed: number;
}

export function createTopologyScene(
  container: HTMLElement,
  specs: SceneNodeSpec[],
  callbacks: TopologySceneCallbacks,
  options: { reducedMotion: boolean }
): TopologySceneApi {
  let palette = readTopologyPalette(container);
  let reduced = options.reducedMotion;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(pixelRatio);
  const width = container.clientWidth || 640;
  const height = container.clientHeight || 340;
  renderer.setSize(width, height);
  renderer.setClearColor(palette.canvas, 1);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.cursor = 'grab';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
  camera.position.copy(homePositionFor(width / height));
  let compact = width < COMPACT_LABEL_WIDTH;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(DEFAULT_CAMERA_TARGET);
  controls.enableDamping = !reduced;
  controls.dampingFactor = 0.075;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 0.8;
  controls.enablePan = false;
  controls.autoRotate = false;
  controls.minDistance = 5;
  const fitMaxDistance = (aspect: number) =>
    Math.max(15, homePositionFor(aspect).distanceTo(DEFAULT_CAMERA_TARGET) * 1.2);
  controls.maxDistance = fitMaxDistance(width / height);
  controls.minPolarAngle = 0.32;
  controls.maxPolarAngle = 1.28;
  controls.minAzimuthAngle = -1.25;
  controls.maxAzimuthAngle = 0.95;
  controls.update();

  /* Lumières : neutres et douces (pas de projecteurs colorés). */
  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1);
  key.position.set(4, 9, 6);
  scene.add(key);

  /* Plateforme : feuille de papier hexagonale, grille gravée. */
  const platformGeo = new THREE.CylinderGeometry(
    PLATFORM_R_TOP,
    PLATFORM_R_BOTTOM,
    PLATFORM_THICK,
    6
  );
  const platformTop = createPlatformTopMaterial({ center: PLATFORM_CENTER, radius: PLATFORM_R_TOP });
  const platformSide = new THREE.MeshBasicMaterial({ color: palette.paperSide });
  const platform = new THREE.Mesh(platformGeo, [platformSide, platformTop, platformSide]);
  platform.position.set(PLATFORM_CENTER.x, PLATFORM_Y, PLATFORM_CENTER.y);
  scene.add(platform);

  const groundShadowMat = createContactShadowMaterial(0.16);
  const groundShadow = new THREE.Mesh(new THREE.CircleGeometry(4.9, 64), groundShadowMat);
  groundShadow.rotation.x = -Math.PI / 2;
  groundShadow.position.set(PLATFORM_CENTER.x + 0.25, PLATFORM_Y - PLATFORM_THICK / 2 - 0.02, PLATFORM_CENTER.y + 0.2);
  groundShadow.renderOrder = -1;
  scene.add(groundShadow);

  /* Rideau de balayage. */
  const scanMat = createScanPlaneMaterial({
    center: PLATFORM_CENTER,
    radius: PLATFORM_R_TOP,
    floorY: FLOOR_Y,
    height: SCAN_HEIGHT,
  });
  const scanPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(PLATFORM_R_TOP * 2 + 0.4, SCAN_HEIGHT),
    scanMat
  );
  scanPlane.rotation.y = Math.PI / 2;
  scanPlane.position.set(SCAN_X_MIN, FLOOR_Y + SCAN_HEIGHT / 2, PLATFORM_CENTER.y);
  scanPlane.renderOrder = 2;
  scene.add(scanPlane);

  /* Nœuds. */
  const nodes: NodeHandle[] = [];
  const byId = new Map<string, NodeHandle>();
  const pickables: THREE.Mesh[] = [];
  const outlineGeoScale = 1.13;

  for (const spec of specs) {
    const pos = new THREE.Vector3(...spec.position);
    const geo = geometryFor(spec.shape);
    const color = statusColor(palette, spec.status);
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.66,
      metalness: 0,
      flatShading: spec.shape !== 'cylinder',
      wireframe: spec.status === 'attacker',
      emissive: color.clone(),
      emissiveIntensity: 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    mesh.renderOrder = 1;
    scene.add(mesh);
    pickables.push(mesh);

    const outlineMat = new THREE.MeshBasicMaterial({
      color: palette.reel,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const outline = new THREE.Mesh(geo, outlineMat);
    outline.scale.setScalar(outlineGeoScale);
    outline.visible = false;
    mesh.add(outline);
    mesh.userData.outline = outline;

    const exposed = spec.status === 'critical';
    const labelBaseY = pos.y + (exposed ? 1.42 : 0.98);
    const label = createLabel(
      (p) => ({
        title: spec.label,
        subtitle: spec.sublabel,
        accent: statusCss(p, spec.status),
        strong: exposed || spec.status === 'attacker',
      }),
      palette
    );
    label.sprite.position.set(pos.x, labelBaseY, pos.z);
    scene.add(label.sprite);

    const onPlatform = insidePlatform(pos.x, pos.z);
    const heightAbove = pos.y - FLOOR_Y;

    let shadowMat: THREE.ShaderMaterial | null = null;
    let shadowBase = 0;
    if (onPlatform) {
      shadowBase = 0.5 / (1 + heightAbove * 0.55);
      shadowMat = createContactShadowMaterial(shadowBase);
      const r = 0.62 + heightAbove * 0.16;
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(r, 40), shadowMat);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.set(pos.x + 0.06, FLOOR_Y + 0.003, pos.z + 0.05);
      scene.add(shadow);
    }

    let waveMat: THREE.ShaderMaterial | null = null;
    let leaderMat: THREE.LineBasicMaterial | null = null;
    if (exposed && onPlatform) {
      waveMat = createLeakWaveMaterial(nodes.length * 0.37);
      const wave = new THREE.Mesh(new THREE.CircleGeometry(1.3, 64), waveMat);
      wave.rotation.x = -Math.PI / 2;
      wave.position.set(pos.x, FLOOR_Y + 0.006, pos.z);
      wave.renderOrder = 1;
      scene.add(wave);
    }
    if (exposed) {
      leaderMat = new THREE.LineBasicMaterial({
        color: palette.rupture,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
      });
      const bottomOfCard = labelBaseY - LABEL_SPRITE_H * 0.34;
      const leaderGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(pos.x, onPlatform ? FLOOR_Y + 0.01 : pos.y - 0.6, pos.z),
        new THREE.Vector3(pos.x, bottomOfCard, pos.z),
      ]);
      const leader = new THREE.Line(leaderGeo, leaderMat);
      leader.renderOrder = 3;
      scene.add(leader);
    }

    let ringMat: THREE.MeshBasicMaterial | null = null;
    if ((spec.status === 'compliant' || spec.status === 'auditor') && onPlatform) {
      ringMat = new THREE.MeshBasicMaterial({
        color: palette.reel,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.6, 0.625, 72), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(pos.x, FLOOR_Y + 0.005, pos.z);
      scene.add(ring);
    }

    const handle: NodeHandle = {
      spec,
      mesh,
      mat,
      outlineMat,
      label: label.sprite,
      labelMat: label.sprite.material,
      labelBaseY,
      redrawLabel: label.redraw,
      shadowMat,
      shadowBase,
      waveMat,
      ringMat,
      leaderMat,
      state: { opacity: 1, scale: 1, label: 1, accent: 1 },
      currentScale: 1,
      hoverMix: 0,
      rim: 0,
    };
    nodes.push(handle);
    byId.set(spec.id, handle);
  }

  /* Liens courbes + particules. */
  const linkSpecs = buildLinks(specs);
  const links: LinkHandle[] = [];
  let particleTotal = 0;
  for (const ls of linkSpecs) {
    const a = byId.get(ls.from);
    const b = byId.get(ls.to);
    if (!a || !b) continue;
    const p0 = a.mesh.position.clone();
    const p2 = b.mesh.position.clone();
    const mid = p0.clone().lerp(p2, 0.5);
    mid.y += ls.kind === 'attack' ? 1.45 : ls.kind === 'lateral' ? 0.85 : 0.45;
    const curve = new THREE.QuadraticBezierCurve3(p0, mid, p2);
    const radius = ls.kind === 'attack' ? 0.017 : ls.kind === 'lateral' ? 0.013 : 0.008;
    const mat = createLinkMaterial(ls.kind === 'lateral');
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 56, radius, 6, false), mat);
    tube.renderOrder = 1;
    scene.add(tube);
    const count = ls.kind === 'attack' ? 6 : ls.kind === 'lateral' ? 4 : 3;
    links.push({
      spec: ls,
      curve,
      mat,
      baseOpacity: 0,
      factor: 1,
      particleStart: particleTotal,
      particleCount: count,
      speed: ls.kind === 'attack' ? 0.26 : ls.kind === 'lateral' ? 0.2 : 0.14,
    });
    particleTotal += count;
  }

  const pPos = new Float32Array(particleTotal * 3);
  const pColor = new Float32Array(particleTotal * 3);
  const pAlpha = new Float32Array(particleTotal);
  const pSize = new Float32Array(particleTotal);
  const pPhase = new Float32Array(particleTotal);
  for (const l of links) {
    for (let i = 0; i < l.particleCount; i += 1) {
      const idx = l.particleStart + i;
      pPhase[idx] = i / l.particleCount + (l.spec.kind === 'audit' ? (idx % 5) * 0.07 : 0);
      pSize[idx] = l.spec.kind === 'attack' ? 6.5 : l.spec.kind === 'lateral' ? 5.5 : 4.2;
    }
  }
  const flowGeo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pPos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  const alphaAttr = new THREE.BufferAttribute(pAlpha, 1);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  const colorAttr = new THREE.BufferAttribute(pColor, 3);
  flowGeo.setAttribute('position', posAttr);
  flowGeo.setAttribute('aColor', colorAttr);
  flowGeo.setAttribute('aAlpha', alphaAttr);
  flowGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1));
  const flowMat = createFlowPointsMaterial(pixelRatio);
  const flowPoints = new THREE.Points(flowGeo, flowMat);
  flowPoints.frustumCulled = false;
  flowPoints.renderOrder = 4;
  scene.add(flowPoints);

  /* ---------------------------------------------------------------- */
  /* Palette                                                           */
  /* ---------------------------------------------------------------- */

  const applyPalette = () => {
    const p = palette;
    renderer.setClearColor(p.canvas, 1);
    hemi.color.set(0xffffff);
    hemi.groundColor.copy(p.paperSide);
    hemi.intensity = p.isDark ? 1.35 : 2.1;
    key.intensity = p.isDark ? 1.45 : 1.35;

    platformTop.uniforms.uPaper.value.copy(p.paper);
    platformTop.uniforms.uInk.value.copy(p.ink);
    platformTop.uniforms.uReel.value.copy(p.reel);
    platformTop.uniforms.uGridStrength.value = p.isDark ? 0.55 : 1;
    platformSide.color.copy(p.paperSide);
    groundShadowMat.uniforms.uStrength.value = p.isDark ? 0.45 : 0.1;
    scanMat.uniforms.uColor.value.copy(p.reel);
    scanMat.uniforms.uStrength.value = p.isDark ? 0.2 : 0.26;

    for (const n of nodes) {
      const c = statusColor(p, n.spec.status);
      n.mat.color.copy(c);
      n.mat.emissive.copy(c);
      if (n.shadowMat) {
        n.shadowMat.uniforms.uStrength.value = n.shadowBase * (p.isDark ? 1.25 : 0.7);
      }
      n.waveMat?.uniforms.uColor.value.copy(p.rupture);
      n.ringMat?.color.copy(p.reel);
      n.leaderMat?.color.copy(p.rupture);
    }
    for (const l of links) {
      const c = l.spec.exposure || l.spec.kind !== 'audit' ? p.rupture : p.ink;
      l.mat.uniforms.uColor.value.copy(c);
      l.baseOpacity =
        l.spec.kind === 'attack'
          ? p.isDark ? 0.7 : 0.78
          : l.spec.kind === 'lateral'
          ? 0.62
          : p.isDark ? 0.24 : 0.2;
      for (let i = 0; i < l.particleCount; i += 1) {
        const idx = (l.particleStart + i) * 3;
        pColor[idx] = c.r;
        pColor[idx + 1] = c.g;
        pColor[idx + 2] = c.b;
      }
    }
    colorAttr.needsUpdate = true;
    applyLinkOpacities();
  };

  const applyLinkOpacities = () => {
    for (const l of links) {
      l.mat.uniforms.uOpacity.value = Math.min(0.95, l.baseOpacity * l.factor);
    }
  };

  /* ---------------------------------------------------------------- */
  /* État visuel (filtres / simulation)                                */
  /* ---------------------------------------------------------------- */

  let hoveredId: string | null = null;
  let selectedId: string | null = null;

  const applyNodeMaterial = (n: NodeHandle) => {
    const o = n.state.opacity;
    const transparent = o < 0.999;
    if (n.mat.transparent !== transparent) {
      n.mat.transparent = transparent;
      n.mat.depthWrite = !transparent;
      n.mat.needsUpdate = true;
    }
    n.mat.opacity = o;
    if (n.shadowMat) n.shadowMat.uniforms.uOpacity.value = Math.max(0.15, o);
    if (n.waveMat) n.waveMat.uniforms.uOpacity.value = n.state.accent;
    if (n.ringMat) n.ringMat.opacity = 0.6 * n.state.accent;
    if (n.leaderMat) n.leaderMat.opacity = 0.7 * n.state.accent;
  };

  const applyState = (state: TopologyVisualState) => {
    for (const n of nodes) {
      const s = state.nodes[n.spec.id];
      if (s) n.state = { ...s };
      applyNodeMaterial(n);
      if (reduced) n.currentScale = n.state.scale;
    }
    for (const l of links) {
      l.factor = state.links[l.spec.id] ?? 1;
    }
    applyLinkOpacities();
    invalidate();
  };

  /* ---------------------------------------------------------------- */
  /* Boucle                                                            */
  /* ---------------------------------------------------------------- */

  let elapsed = 0;
  let rafId = 0;
  let lastNow = 0;
  let onScreen = true;
  let pageVisible = typeof document === 'undefined' ? true : !document.hidden;
  let disposed = false;
  let flight: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;

  const shouldRun = () => !reduced && onScreen && pageVisible && !disposed;

  const updateScan = () => {
    let progress: number;
    let alpha: number;
    if (reduced) {
      progress = STATIC_SCAN_PROGRESS;
      alpha = 0.85;
    } else {
      const phase = elapsed % SCAN_PERIOD;
      progress = phase / SCAN_SWEEP;
      alpha = progress <= 1 ? smooth(0, 0.07, progress) * (1 - smooth(0.9, 1, progress)) : 0;
      progress = Math.min(1, progress);
    }
    // La trace au sol persiste un peu après l'extinction du rideau.
    const x = SCAN_X_MIN + (SCAN_X_MAX - SCAN_X_MIN) * progress;
    scanPlane.position.x = x;
    scanPlane.visible = alpha > 0.002;
    scanMat.uniforms.uAlpha.value = alpha;
    platformTop.uniforms.uScanX.value = x;
    platformTop.uniforms.uScanAlpha.value = alpha;

    for (const n of nodes) {
      const d = x - n.mesh.position.x;
      const front = smooth(-0.45, 0, d);
      const decay = d > 0 ? Math.exp(-d / 0.55) : 1;
      n.rim = front * decay * alpha * (insidePlatform(n.mesh.position.x, n.mesh.position.z) ? 1 : 0);
    }
  };

  const updateParticles = () => {
    const tmp = new THREE.Vector3();
    for (const l of links) {
      const linkAlpha = Math.min(1, l.factor) * (l.spec.kind === 'audit' ? 0.8 : 1);
      for (let i = 0; i < l.particleCount; i += 1) {
        const idx = l.particleStart + i;
        const t = reduced ? (pPhase[idx] + 0.5 / l.particleCount) % 1 : (pPhase[idx] + elapsed * l.speed) % 1;
        l.curve.getPointAt(t, tmp);
        pPos[idx * 3] = tmp.x;
        pPos[idx * 3 + 1] = tmp.y;
        pPos[idx * 3 + 2] = tmp.z;
        pAlpha[idx] = linkAlpha * smooth(0, 0.1, t) * (1 - smooth(0.88, 1, t));
      }
    }
    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
  };

  const updateNodes = (dt: number) => {
    const k = reduced ? 1 : 1 - Math.exp(-dt * 12);
    const anyLabelFocus = hoveredId !== null;
    for (const n of nodes) {
      const isHover = n.spec.id === hoveredId;
      const isSel = n.spec.id === selectedId;
      const targetHover = isHover ? 1 : 0;
      n.hoverMix += (targetHover - n.hoverMix) * k;
      const targetScale = n.state.scale * (1 + 0.12 * n.hoverMix + (isSel ? 0.05 : 0));
      n.currentScale += (targetScale - n.currentScale) * k;
      n.mesh.scale.setScalar(n.currentScale);

      const outline = n.mesh.userData.outline as THREE.Mesh;
      const focus = Math.max(n.hoverMix, isSel ? 1 : 0);
      if (focus > 0.02) {
        n.outlineMat.color.copy(palette.ink);
        n.outlineMat.opacity = 0.8 * focus * Math.max(0.3, n.state.opacity);
      } else {
        n.outlineMat.color.copy(palette.reel);
        n.outlineMat.opacity = 0.9 * n.rim * Math.max(0.25, n.state.opacity);
      }
      outline.visible = n.outlineMat.opacity > 0.01 && n.spec.status !== 'attacker';
      n.mat.emissiveIntensity = (palette.isDark ? 0.1 : 0.02) + 0.16 * n.hoverMix + 0.12 * n.rim;

      const quietInCompact =
        compact && !isHover && !isSel && n.spec.status !== 'critical' && n.spec.status !== 'attacker';
      const labelFocus = quietInCompact ? 0 : anyLabelFocus ? (isHover ? 1 : 0.55) : 1;
      n.labelMat.opacity = n.state.label * labelFocus;
      const ls = 1 + 0.06 * n.hoverMix;
      const lb = compact ? 1.4 : 1;
      n.label.scale.set(2.85 * ls * lb, LABEL_SPRITE_H * ls * lb, 1);

      if (n.waveMat && !reduced) n.waveMat.uniforms.uTime.value += dt;
    }
  };

  const updateFlight = (dt: number) => {
    if (!flight) return;
    const k = 1 - Math.exp(-dt * 5);
    camera.position.lerp(flight.pos, k);
    controls.target.lerp(flight.target, k);
    if (
      camera.position.distanceTo(flight.pos) < 0.01 &&
      controls.target.distanceTo(flight.target) < 0.01
    ) {
      camera.position.copy(flight.pos);
      controls.target.copy(flight.target);
      flight = null;
    }
  };

  const renderFrame = (dt: number) => {
    if (!reduced) elapsed += dt;
    updateFlight(dt);
    updateScan();
    updateParticles();
    updateNodes(dt);
    controls.update();
    renderer.render(scene, camera);
  };

  const frame = (now: number) => {
    rafId = 0;
    if (disposed) return;
    const dt = lastNow ? Math.min(0.05, (now - lastNow) / 1000) : 1 / 60;
    lastNow = now;
    renderFrame(dt);
    if (shouldRun() || flight) {
      rafId = window.requestAnimationFrame(frame);
    } else {
      lastNow = 0;
    }
  };

  function invalidate() {
    if (disposed || rafId) return;
    rafId = window.requestAnimationFrame(frame);
  }

  const renderNow = () => {
    controls.update();
    renderer.render(scene, camera);
  };

  /* ---------------------------------------------------------------- */
  /* Interaction                                                       */
  /* ---------------------------------------------------------------- */

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downX = 0;
  let downY = 0;

  const pick = (ev: PointerEvent | MouseEvent): string | null => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(pickables, false)[0];
    if (!hit) return null;
    return nodes.find((n) => n.mesh === hit.object)?.spec.id ?? null;
  };

  const onPointerMove = (ev: PointerEvent) => {
    if (ev.pointerType !== 'mouse' && ev.buttons) return;
    const id = pick(ev);
    if (id !== hoveredId) {
      hoveredId = id;
      renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
      callbacks.onHover(id);
      invalidate();
    }
  };
  const onPointerLeave = () => {
    if (hoveredId !== null) {
      hoveredId = null;
      renderer.domElement.style.cursor = 'grab';
      callbacks.onHover(null);
      invalidate();
    }
  };
  const onPointerDown = (ev: PointerEvent) => {
    downX = ev.clientX;
    downY = ev.clientY;
    flight = null;
  };
  const onPointerUp = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 6) return;
    callbacks.onClick(pick(ev));
  };
  const onDblClick = (ev: MouseEvent) => {
    callbacks.onDoubleClick(pick(ev));
  };
  const onWheel = () => {
    flight = null;
  };
  const onControlsChange = () => {
    if (!rafId) invalidate();
  };

  const canvas = renderer.domElement;
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('wheel', onWheel, { passive: true });
  controls.addEventListener('change', onControlsChange);

  const resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    const w = Math.max(280, entry.contentRect.width);
    const h = Math.max(260, entry.contentRect.height);
    const wasHome = camera.position.distanceTo(homePositionFor(camera.aspect)) < 0.05;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    compact = w < COMPACT_LABEL_WIDTH;
    controls.maxDistance = fitMaxDistance(camera.aspect);
    if (wasHome && !flight) camera.position.copy(homePositionFor(camera.aspect));
    renderer.setSize(w, h);
    invalidate();
  });
  resizeObserver.observe(container);

  const io =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(
          (entries) => {
            onScreen = entries.some((e) => e.isIntersecting);
            if (onScreen) invalidate();
          },
          { threshold: 0.01 }
        )
      : null;
  io?.observe(container);

  const onVisibility = () => {
    pageVisible = !document.hidden;
    if (pageVisible) invalidate();
  };
  document.addEventListener('visibilitychange', onVisibility);

  /* Thème : on relit les variables CSS quand data-theme change. */
  const refreshPalette = () => {
    if (disposed) return;
    palette = readTopologyPalette(container);
    applyPalette();
    for (const n of nodes) n.redrawLabel(palette);
    invalidate();
  };
  const themeObserver = new MutationObserver(() => {
    // Laisse le navigateur recalculer les styles avant la lecture.
    window.requestAnimationFrame(refreshPalette);
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class'],
  });

  // Les polices web peuvent arriver après le premier dessin des étiquettes.
  document.fonts?.ready.then(() => {
    if (!disposed) refreshPalette();
  });

  applyPalette();
  invalidate();

  return {
    renderer,
    scene,
    camera,
    controls,
    applyState,
    setSelected: (id) => {
      selectedId = id;
      invalidate();
    },
    setReducedMotion: (r) => {
      reduced = r;
      controls.enableDamping = !r;
      invalidate();
    },
    refreshPalette,
    flyTo: (requested, target) => {
      const pos = requested === DEFAULT_CAMERA_POS ? homePositionFor(camera.aspect) : requested;
      if (reduced) {
        flight = null;
        camera.position.copy(pos);
        controls.target.copy(target);
        controls.update();
      } else {
        flight = { pos: pos.clone(), target: target.clone() };
      }
      invalidate();
    },
    cancelFlight: () => {
      flight = null;
    },
    invalidate,
    renderNow,
    dispose: () => {
      disposed = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      rafId = 0;
      resizeObserver.disconnect();
      io?.disconnect();
      themeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('wheel', onWheel);
      controls.removeEventListener('change', onControlsChange);
      controls.dispose();

      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      scene.traverse((obj) => {
        const o = obj as THREE.Mesh;
        if (o.geometry) geometries.add(o.geometry);
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => materials.add(m));
        }
      });
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => {
        const map = (m as THREE.SpriteMaterial).map;
        if (map) map.dispose();
        m.dispose();
      });
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
