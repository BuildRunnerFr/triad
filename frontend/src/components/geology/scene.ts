import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { gsap } from '../../motion/gsap';
import type { Finding } from '../../types';
import { HATCH_FRAGMENT, STRATUM_FRAGMENT, STRATUM_VERTEX } from './shaders';
import { buildLayout, D, LAYERS, layerBaseBottom, T, type CoreColumn } from './model';

interface GeoPalette {
  dark: boolean;
  paper: THREE.Color;
  ink: THREE.Color;
  inkSoft: THREE.Color;
  dit: THREE.Color;
  ecrit: THREE.Color;
  reel: THREE.Color;
  rupture: THREE.Color;
  hatchBg: THREE.Color;
}

function readColor(style: CSSStyleDeclaration, name: string, fallback: string): THREE.Color {
  const v = style.getPropertyValue(name).trim();
  const c = new THREE.Color();
  c.setStyle(/^#[0-9a-f]{3,8}$/i.test(v) ? v.slice(0, 7) : fallback);
  return c;
}

export function readGeoPalette(): GeoPalette {
  const root = document.documentElement;
  const dark = root.getAttribute('data-theme') === 'dark';
  const s = getComputedStyle(root);
  const paper = readColor(s, dark ? '--bg-elevated' : '--bg-surface', dark ? '#1A231E' : '#FBFBF8');
  const ink = readColor(s, '--text-primary', dark ? '#EEF2EE' : '#141A16');
  const inkSoft = readColor(s, '--text-secondary', dark ? '#A9B5AD' : '#46504A');
  const hatchBg = readColor(s, dark ? '--bg-surface' : '--bg-canvas', dark ? '#121915' : '#F2F3EF');
  return {
    dark,
    paper,
    ink,
    inkSoft,
    dit: readColor(s, '--dit', '#2350B8'),
    ecrit: readColor(s, '--ecrit', '#7A3A9E'),
    reel: readColor(s, '--reel', '#286E0A'),
    rupture: readColor(s, '--rupture', '#B32F16'),
    hatchBg,
  };
}

// Mélange papier/teinte : Dit très désaturé, la roche-mère un peu plus dense.
const TINT_MIX = { light: [0.36, 0.36, 0.4], dark: [0.26, 0.2, 0.15] };

export interface GeologySceneOptions {
  findings: Finding[];
  reducedMotion: boolean;
  onHover: (id: string | null) => void;
  onPick: (id: string | null) => void;
  onFrame: () => void;
}

export interface GeologySceneApi {
  setTheme: () => void;
  setHover: (id: string | null) => void;
  extract: (id: string, onRisen: () => void) => void;
  retract: () => void;
  /** Projection écran (px, relatifs au conteneur) d'un point du forage. */
  project: (id: string, where: 'tip' | 'core') => { x: number; y: number } | null;
  dispose: () => void;
}

export function createGeologyScene(
  container: HTMLElement,
  opts: GeologySceneOptions
): GeologySceneApi {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.touchAction = 'pan-y';
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 200);
  const layout = buildLayout(opts.findings);
  let pal = readGeoPalette();

  // ---------- Matériaux partagés ----------
  const stratumMats = LAYERS.map(
    (_, i) =>
      new THREE.ShaderMaterial({
        vertexShader: STRATUM_VERTEX,
        fragmentShader: STRATUM_FRAGMENT,
        uniforms: {
          uPaper: { value: new THREE.Color() },
          uTint: { value: new THREE.Color() },
          uInk: { value: new THREE.Color() },
          uKind: { value: [2, 1, 0][i] },
          uTintMix: { value: 0.2 },
          uDark: { value: 0 },
        },
      })
  );
  const makeHatch = (density: number, strength: number) =>
    new THREE.ShaderMaterial({
      vertexShader: STRATUM_VERTEX,
      fragmentShader: HATCH_FRAGMENT,
      uniforms: {
        uBg: { value: new THREE.Color() },
        uLine: { value: new THREE.Color() },
        uDensity: { value: density },
        uStrength: { value: strength },
      },
    });
  const lacunaMat = makeHatch(9, 0.5);
  const gougeMat = makeHatch(14, 0.85);
  const edgeMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.42 });
  const faultMat = new THREE.MeshBasicMaterial();
  const forageMat = new THREE.MeshBasicMaterial();
  const forageHotMat = new THREE.MeshBasicMaterial();
  const traceMat = new THREE.LineDashedMaterial({ dashSize: 0.07, gapSize: 0.06, transparent: true, opacity: 0.7 });
  const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });

  const applyPalette = () => {
    const tm = pal.dark ? TINT_MIX.dark : TINT_MIX.light;
    const tints = [pal.reel, pal.ecrit, pal.dit];
    stratumMats.forEach((m, i) => {
      m.uniforms.uPaper.value.copy(pal.paper);
      m.uniforms.uTint.value.copy(tints[i]);
      m.uniforms.uInk.value.copy(pal.ink);
      m.uniforms.uTintMix.value = tm[2 - i];
      m.uniforms.uDark.value = pal.dark ? 1 : 0;
    });
    lacunaMat.uniforms.uBg.value.copy(pal.hatchBg);
    lacunaMat.uniforms.uLine.value.copy(pal.inkSoft);
    gougeMat.uniforms.uBg.value.copy(pal.hatchBg);
    gougeMat.uniforms.uLine.value.copy(pal.rupture);
    edgeMat.color.copy(pal.ink);
    faultMat.color.copy(pal.rupture);
    forageMat.color.copy(pal.inkSoft);
    forageHotMat.color.copy(pal.ink);
    traceMat.color.copy(pal.ink);
  };
  applyPalette();

  const disposables: Array<{ dispose: () => void }> = [];
  const geo = <G extends THREE.BufferGeometry>(g: G): G => {
    disposables.push(g);
    return g;
  };

  const block = new THREE.Group();
  scene.add(block);

  const addBox = (
    x0: number,
    x1: number,
    yb: number,
    yt: number,
    shift: number,
    mat: THREE.Material,
    edges = true
  ) => {
    const g = geo(new THREE.BoxGeometry(x1 - x0, yt - yb, D));
    g.translate((x0 + x1) / 2, (yb + yt) / 2, 0);
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.y = shift;
    block.add(mesh);
    if (edges) {
      const e = new THREE.LineSegments(geo(new THREE.EdgesGeometry(g)), edgeMat);
      e.position.y = shift;
      block.add(e);
    }
  };

  // ---------- Strates : runs fusionnés (même rejet, même présence) ----------
  const { columns, x0, length } = layout;
  const half = (W: number) => W / 2;
  for (let l = 0; l < 3; l++) {
    const yb = layerBaseBottom(l);
    const yt = yb + T;
    type Seg = { a: number; b: number; shift: number; present: boolean };
    const segs: Seg[] = [];
    const push = (s: Seg) => {
      const last = segs[segs.length - 1];
      if (last && Math.abs(last.shift - s.shift) < 1e-6 && last.present === s.present) last.b = s.b;
      else segs.push({ ...s });
    };
    const w = columns.length > 1 ? columns[1].x - columns[0].x : length - 1.4;
    push({ a: x0, b: columns.length ? columns[0].x - half(w) : x0 + length, shift: 0, present: true });
    columns.forEach((c) =>
      push({ a: c.x - half(w), b: c.x + half(w), shift: c.shifts[l], present: c.present[l] })
    );
    if (columns.length) push({ a: columns[columns.length - 1].x + half(w), b: x0 + length, shift: 0, present: true });
    segs.forEach((s) => addBox(s.a, s.b, yb, yt, s.shift, s.present ? stratumMats[l] : lacunaMat));
  }

  // ---------- Failles : brèches + lignes vermillon ----------
  const colW = columns.length > 1 ? columns[1].x - columns[0].x : 1.55;
  const faultStrip = (x: number, yb: number, yt: number) => {
    const t = 0.024;
    const front = new THREE.Mesh(geo(new THREE.BoxGeometry(t, yt - yb, 0.01)), faultMat);
    front.position.set(x, (yb + yt) / 2, D / 2 + 0.006);
    block.add(front);
  };
  const faultTop = (x: number, y: number) => {
    const m = new THREE.Mesh(geo(new THREE.BoxGeometry(0.024, 0.01, D)), faultMat);
    m.position.set(x, y + 0.006, 0);
    block.add(m);
  };
  columns.forEach((c) => {
    if (!c.pair.length) return;
    const a = c.x - colW / 2;
    const b = c.x + colW / 2;
    c.gaps.forEach(([g0, g1]) => addBox(a, b, g0, g1, 0, gougeMat, false));
    const yb = -1.5 * T - c.rejet / 2;
    const yt = 1.5 * T + c.rejet / 2;
    faultStrip(a, yb, yt);
    faultStrip(b, yb, yt);
    faultTop(a, 1.5 * T + Math.max(0, c.shifts[2]));
    faultTop(b, 1.5 * T + Math.max(0, c.shifts[2]));
  });

  // ---------- Forages ----------
  const surfaceY = (c: CoreColumn) => 1.5 * T + c.shifts[2];
  const TIP = 0.55;
  const forageZ = D / 2 - 0.42;
  const forageGeo = geo(new THREE.CylinderGeometry(0.035, 0.035, 1, 12));
  const collarGeo = geo(new THREE.RingGeometry(0.07, 0.11, 32));
  collarGeo.rotateX(-Math.PI / 2);
  const forages = new Map<string, { rod: THREE.Mesh; collar: THREE.Mesh; col: CoreColumn }>();
  const hitTargets: THREE.Mesh[] = [];
  columns.forEach((c) => {
    const top = surfaceY(c) + TIP;
    const bottom = -1.5 * T + c.shifts[0] + 0.05;
    const rod = new THREE.Mesh(forageGeo, forageMat);
    rod.scale.y = top - bottom;
    rod.position.set(c.x, (top + bottom) / 2, forageZ);
    block.add(rod);
    const collar = new THREE.Mesh(collarGeo, forageMat);
    collar.position.set(c.x, surfaceY(c) + 0.004, forageZ);
    block.add(collar);
    // Trace du forage projetée sur la face de coupe (tireté encre).
    const tg = geo(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(c.x, bottom, D / 2 + 0.008),
        new THREE.Vector3(c.x, surfaceY(c), D / 2 + 0.008),
      ])
    );
    const trace = new THREE.Line(tg, traceMat);
    trace.computeLineDistances();
    block.add(trace);
    const hit = new THREE.Mesh(geo(new THREE.BoxGeometry(0.62, top - bottom + 0.2, D + 0.1)), hitMat);
    hit.position.set(c.x, (top + bottom) / 2, 0);
    hit.userData.id = c.finding.id;
    block.add(hit);
    hitTargets.push(hit);
    forages.set(c.finding.id, { rod, collar, col: c });
  });

  // ---------- Carotte (3 segments) ----------
  const core = new THREE.Group();
  core.visible = false;
  scene.add(core);
  const coreGeos = LAYERS.map((_, l) => {
    const g = geo(new THREE.CylinderGeometry(0.17, 0.17, T * 0.98, 36));
    g.translate(0, layerBaseBottom(l) + T / 2, 0);
    return g;
  });
  const coreSegs = coreGeos.map((g, l) => {
    const m = new THREE.Mesh(g, stratumMats[l]);
    const e = new THREE.LineSegments(geo(new THREE.EdgesGeometry(g, 30)), edgeMat);
    m.add(e);
    core.add(m);
    return m;
  });

  // ---------- Caméra & contrôles (orbite bornée, pas de rotation auto) ----------
  const target = new THREE.Vector3(0, 0.15, 0);
  const baseAz = -0.42;
  const basePolar = 1.08;
  let fitDist = 20;
  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableDamping = false;
  controls.rotateSpeed = 0.5;
  controls.zoomSpeed = 0.6;
  controls.minAzimuthAngle = baseAz - 0.5;
  controls.maxAzimuthAngle = baseAz + 0.5;
  controls.minPolarAngle = 0.72;
  controls.maxPolarAngle = 1.32;
  controls.target.copy(target);

  const fit = () => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const needW = (length * 0.5 + 0.9) / Math.tan(hfov / 2);
    const needH = 4.4 / Math.tan(vfov / 2);
    const prev = fitDist;
    fitDist = Math.max(needW, needH) * 1.16;
    controls.minDistance = fitDist * 0.62;
    controls.maxDistance = fitDist * 1.25;
    if (!initialized) {
      const s = new THREE.Spherical(fitDist, basePolar, baseAz);
      camera.position.setFromSpherical(s).add(target);
      initialized = true;
    } else {
      const off = camera.position.clone().sub(target).multiplyScalar(fitDist / prev);
      camera.position.copy(target).add(off);
    }
    camera.updateProjectionMatrix();
    controls.update();
  };
  let initialized = false;

  // ---------- Rendu à la demande ----------
  let raf = 0;
  let visible = true;
  let dirty = true;
  let disposed = false;
  const render = () => {
    raf = 0;
    if (disposed) return;
    renderer.render(scene, camera);
    dirty = false;
    opts.onFrame();
  };
  const requestRender = () => {
    if (disposed) return;
    if (!visible || document.hidden) {
      dirty = true;
      return;
    }
    if (!raf) raf = requestAnimationFrame(render);
  };
  controls.addEventListener('change', requestRender);

  const io = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible && dirty) requestRender();
  });
  io.observe(container);
  const onVis = () => {
    if (!document.hidden && dirty) requestRender();
  };
  document.addEventListener('visibilitychange', onVis);
  const ro = new ResizeObserver(() => {
    fit();
    requestRender();
  });
  ro.observe(container);
  fit();

  // ---------- Picking ----------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pickAt = (cx: number, cy: number): string | null => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(hitTargets, false);
    return hits.length ? (hits[0].object.userData.id as string) : null;
  };
  let hoverId: string | null = null;
  let moveRaf = 0;
  let lastMove: PointerEvent | null = null;
  let downAt: { x: number; y: number } | null = null;
  const onMove = (e: PointerEvent) => {
    lastMove = e;
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      if (!lastMove || downAt) return;
      const id = pickAt(lastMove.clientX, lastMove.clientY);
      if (id !== hoverId) opts.onHover(id);
      canvas.style.cursor = id ? 'pointer' : 'grab';
    });
  };
  const onLeave = () => {
    if (hoverId) opts.onHover(null);
    canvas.style.cursor = '';
  };
  const onDown = (e: PointerEvent) => {
    downAt = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    const d = downAt;
    downAt = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    opts.onPick(pickAt(e.clientX, e.clientY));
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);

  const setHover = (id: string | null) => {
    hoverId = id;
    forages.forEach((f, key) => {
      const hot = key === id || key === extractedId;
      f.rod.material = hot ? forageHotMat : forageMat;
      f.collar.material = hot ? forageHotMat : forageMat;
      f.rod.scale.x = f.rod.scale.z = hot ? 1.7 : 1;
    });
    requestRender();
  };

  // ---------- Extraction ----------
  let extractedId: string | null = null;
  let tl: ReturnType<typeof gsap.timeline> | null = null;
  const coreZ = D / 2 + 0.3;
  const placeCore = (c: CoreColumn) => {
    core.position.set(c.x, 0, coreZ);
    coreSegs.forEach((m, l) => {
      m.position.y = c.shifts[l];
      m.material = c.present[l] ? stratumMats[l] : lacunaMat;
    });
  };
  const riseY = (c: CoreColumn) => 1.5 * T + c.rejet + 1.15;
  const extract = (id: string, onRisen: () => void) => {
    const f = forages.get(id);
    if (!f) return;
    tl?.kill();
    extractedId = id;
    const c = f.col;
    placeCore(c);
    core.visible = true;
    setHover(hoverId);
    if (opts.reducedMotion) {
      core.position.y = riseY(c);
      coreSegs.forEach((m, l) => (m.position.y = c.shifts[l] + (l - 1) * 0.1));
      requestRender();
      onRisen();
      return;
    }
    core.position.y = 0;
    tl = gsap.timeline({ onUpdate: requestRender, onComplete: requestRender });
    tl.to(core.position, { y: riseY(c), duration: 0.75, ease: 'expo.out' }, 0);
    coreSegs.forEach((m, l) => {
      tl!.to(m.position, { y: c.shifts[l] + (l - 1) * 0.1, duration: 0.5, ease: 'power3.out' }, 0.18);
    });
    tl.call(onRisen, undefined, 0.38);
  };
  const retract = () => {
    if (!extractedId) return;
    const f = forages.get(extractedId);
    extractedId = null;
    setHover(hoverId);
    tl?.kill();
    if (!f || opts.reducedMotion) {
      core.visible = false;
      requestRender();
      return;
    }
    const c = f.col;
    tl = gsap.timeline({
      onUpdate: requestRender,
      onComplete: () => {
        core.visible = false;
        requestRender();
      },
    });
    coreSegs.forEach((m, l) => tl!.to(m.position, { y: c.shifts[l], duration: 0.22, ease: 'power2.in' }, 0));
    tl.to(core.position, { y: 0, duration: 0.42, ease: 'power2.in' }, 0);
  };

  // ---------- Projection pour les étiquettes HTML ----------
  const v = new THREE.Vector3();
  const project = (id: string, where: 'tip' | 'core') => {
    const f = forages.get(id);
    if (!f) return null;
    const c = f.col;
    if (where === 'tip') v.set(c.x, surfaceY(c) + TIP + 0.1, forageZ);
    else v.set(c.x, core.position.y + 0.4, coreZ);
    v.project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * container.clientWidth,
      y: (-v.y * 0.5 + 0.5) * container.clientHeight,
    };
  };

  requestRender();

  return {
    setTheme: () => {
      pal = readGeoPalette();
      applyPalette();
      requestRender();
    },
    setHover,
    extract,
    retract,
    project,
    dispose: () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      if (moveRaf) cancelAnimationFrame(moveRaf);
      tl?.kill();
      gsap.killTweensOf(core.position);
      coreSegs.forEach((m) => gsap.killTweensOf(m.position));
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      controls.removeEventListener('change', requestRender);
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      [...stratumMats, lacunaMat, gougeMat, edgeMat, faultMat, forageMat, forageHotMat, traceMat, hitMat].forEach(
        (m) => m.dispose()
      );
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
