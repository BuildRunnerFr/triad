import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  RotateCcw,
  Pause,
  Play,
  ArrowUpRight,
  Maximize2,
  Minimize2,
  Flame,
  ChevronLeft,
  ChevronRight,
  X,
  Camera,
  Check,
  Box,
  Layers,
  Lock,
} from 'lucide-react';
import type { AuditorProof, Finding, ThemeMode } from '../types';
import type { ToastTone } from './ToastStack';

interface Cloud3DTopologyProps {
  findings: Finding[];
  proof: AuditorProof | null;
  theme: ThemeMode;
  onSelectFinding: (finding: Finding) => void;
  onNotify?: (title: string, detail?: string, tone?: ToastTone) => void;
}

type NodeStatus = 'critical' | 'warning' | 'compliant' | 'attacker' | 'auditor';
type HudFilter = 'ALL' | 'CRITICAL' | 'COMPLIANT';
type RenderMode = '3d' | '2d';

interface TopologyNodeSpec {
  id: string;
  label: string;
  sublabel: string;
  position: [number, number, number];
  status: NodeStatus;
  shape: 'icosahedron' | 'cylinder' | 'octahedron' | 'dodecahedron' | 'box';
  finding: Finding | null;
  attackFromInternet?: boolean;
}

interface PulseParticle {
  mesh: THREE.Mesh;
  curve: THREE.QuadraticBezierCurve3;
  progress: number;
  speed: number;
}

interface NodeVisualHandle {
  spec: TopologyNodeSpec;
  mesh: THREE.Mesh;
  meshMat: THREE.MeshStandardMaterial;
  spriteMat: THREE.SpriteMaterial;
  rings: Array<{ mat: THREE.MeshBasicMaterial; baseOpacity: number }>;
  haloMat: THREE.MeshBasicMaterial | null;
  attackTubeMat: THREE.MeshBasicMaterial | null;
  attackTubeBaseOpacity: number;
  pulseMats: THREE.MeshBasicMaterial[];
}

interface SceneFilterRegistry {
  nodes: NodeVisualHandle[];
  lateralLineMat: THREE.LineDashedMaterial | null;
  auditorLines: Array<{
    targetSpec: TopologyNodeSpec;
    mat: THREE.LineBasicMaterial;
    baseOpacity: number;
  }>;
}

interface AttackSimulationStep {
  nodeId: string;
  activeChainIds: string[];
  title: string;
}

const ATTACK_SIMULATION_STEPS: AttackSimulationStep[] = [
  {
    nodeId: 'internet',
    activeChainIds: ['internet'],
    title: 'Internet (0.0.0.0/0) — Reconnaissance externe',
  },
  {
    nodeId: 'export-radiologie',
    activeChainIds: ['internet', 'export-radiologie'],
    title: 'export-radiologie — Exfiltration IAM allUsers',
  },
  {
    nodeId: 'allow-ssh-anywhere',
    activeChainIds: ['internet', 'allow-ssh-anywhere'],
    title: 'allow-ssh-anywhere — Intrusion TCP:22 hors bastion',
  },
  {
    nodeId: 'backups-dpi',
    activeChainIds: ['internet', 'allow-ssh-anywhere', 'backups-dpi'],
    title: 'backups-dpi — Propagation latérale sans WORM',
  },
];

function createLabelSprite(
  title: string,
  subtitle: string,
  accentHex: string,
  isDark: boolean
): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 144;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const bg = isDark ? 'rgba(18, 25, 21, 0.94)' : 'rgba(251, 251, 248, 0.96)';
    const textMain = isDark ? '#EEF2EE' : '#141A16';
    const textSub = isDark ? '#A9B5AD' : '#46504A';

    const x = 24;
    const y = 18;
    const w = canvas.width - 48;
    const h = canvas.height - 36;
    const r = 12;

    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = accentHex;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x + 28, y + 38, 8, 0, Math.PI * 2);
    ctx.fillStyle = accentHex;
    ctx.fill();

    ctx.font = '600 24px "JetBrains Mono", monospace';
    ctx.fillStyle = textMain;
    ctx.fillText(title.slice(0, 26), x + 48, y + 46);

    ctx.font = '500 21px "Schibsted Grotesk", sans-serif';
    ctx.fillStyle = textSub;
    ctx.fillText(subtitle.slice(0, 34), x + 24, y + 84);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.85, 0.8, 1);
  return sprite;
}

const STATUS_HEX: Record<NodeStatus, string> = {
  attacker: '#D2452A',
  critical: '#D2452A',
  warning: '#D99A1E',
  compliant: '#86BC25',
  auditor: '#2350B8',
};

const STATUS_BADGE: Record<NodeStatus, { label: string; cls: string; dot: string }> = {
  attacker: { label: 'Externe', cls: 'badge-critical', dot: 'bg-[var(--rupture)]' },
  critical: { label: 'Critique', cls: 'badge-critical', dot: 'bg-[var(--rupture)]' },
  warning: { label: 'Partiel', cls: 'badge-warning', dot: 'bg-[var(--warning-text)]' },
  compliant: { label: 'Conforme', cls: 'badge-success', dot: 'bg-[var(--deloitte)]' },
  auditor: { label: 'Sonde lecture seule', cls: 'badge-info', dot: 'bg-[var(--dit)]' },
};

export const Cloud3DTopology: React.FC<Cloud3DTopologyProps> = ({
  findings,
  proof,
  theme,
  onSelectFinding,
  onNotify,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);

  const prefersReducedInitial =
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  // Rotation désactivée par défaut : l'écran d'analyse reste stable (activable à la demande).
  const autoRotateRef = useRef<boolean>(false);
  const reducedMotionRef = useRef<boolean>(prefersReducedInitial);
  const hudFilterRef = useRef<HudFilter>('ALL');
  const simStepRef = useRef<number | null>(null);
  const filterRegistryRef = useRef<SceneFilterRegistry | null>(null);
  const cameraTweenRef = useRef<{
    active: boolean;
    targetPos: THREE.Vector3;
    targetLookAt: THREE.Vector3;
  } | null>(null);

  const [renderMode, setRenderMode] = useState<RenderMode>('3d');
  const [autoRotate, setAutoRotate] = useState<boolean>(false);
  const [hudFilter, setHudFilter] = useState<HudFilter>('ALL');
  const [simStep, setSimStep] = useState<number | null>(null);
  const [isExpanded, setIsExpanded] = useState<boolean>(false);
  const [pngCaptured, setPngCaptured] = useState<boolean>(false);
  const [webglError, setWebglError] = useState(false);
  const [hoveredSpec, setHoveredSpec] = useState<TopologyNodeSpec | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const matchesHudFilter = useCallback(
    (status: NodeStatus, filter: HudFilter): boolean => {
      if (filter === 'ALL') return true;
      if (filter === 'CRITICAL') {
        return (
          status === 'critical' || status === 'warning' || status === 'attacker'
        );
      }
      return status === 'compliant' || status === 'auditor';
    },
    []
  );

  const applyFilterToRegistry = useCallback(
    (filter: HudFilter, activeSimStep: number | null = simStepRef.current) => {
      const reg = filterRegistryRef.current;
      if (!reg) return;

      if (activeSimStep !== null) {
        const step = ATTACK_SIMULATION_STEPS[activeSimStep];
        const chainSet = new Set(step.activeChainIds);

        for (const n of reg.nodes) {
          const isPrimary = n.spec.id === step.nodeId;
          const isInChain = chainSet.has(n.spec.id);
          const isWormContrast =
            activeSimStep === 3 && n.spec.id === 'archives-pacs';

          const baseScale = isPrimary
            ? 1.3
            : isInChain
            ? 1.08
            : isWormContrast
            ? 0.96
            : 0.84;
          n.mesh.userData.baseScale = baseScale;
          n.mesh.scale.setScalar(baseScale);

          const targetOpacity = isPrimary
            ? 1
            : isInChain
            ? 0.94
            : isWormContrast
            ? 0.55
            : 0.13;
          n.meshMat.transparent = targetOpacity < 1;
          n.meshMat.opacity = targetOpacity;
          n.meshMat.needsUpdate = true;

          n.spriteMat.opacity = isPrimary
            ? 1
            : isInChain
            ? 0.92
            : isWormContrast
            ? 0.65
            : 0.18;

          for (const r of n.rings) {
            r.mat.opacity = isWormContrast ? r.baseOpacity : 0.08;
          }

          if (n.haloMat) {
            n.haloMat.opacity = isPrimary ? 0.92 : isInChain ? 0.65 : 0.05;
          }

          if (n.attackTubeMat) {
            const beamActive =
              (activeSimStep === 1 && n.spec.id === 'export-radiologie') ||
              ((activeSimStep === 2 || activeSimStep === 3) &&
                n.spec.id === 'allow-ssh-anywhere');
            n.attackTubeMat.opacity = beamActive ? 0.96 : 0.06;
          }

          for (const pm of n.pulseMats) {
            const beamActive =
              (activeSimStep === 1 && n.spec.id === 'export-radiologie') ||
              ((activeSimStep === 2 || activeSimStep === 3) &&
                n.spec.id === 'allow-ssh-anywhere');
            pm.transparent = !beamActive;
            pm.opacity = beamActive ? 1 : 0.05;
          }
        }

        if (reg.lateralLineMat) {
          reg.lateralLineMat.transparent = true;
          reg.lateralLineMat.opacity = activeSimStep === 3 ? 1 : 0.1;
        }

        for (const al of reg.auditorLines) {
          al.mat.opacity = 0.06;
        }
        return;
      }

      for (const n of reg.nodes) {
        const active = matchesHudFilter(n.spec.status, filter);
        const baseScale = filter === 'ALL' ? 1 : active ? 1.12 : 0.85;
        n.mesh.userData.baseScale = baseScale;
        n.mesh.scale.setScalar(baseScale);

        n.meshMat.transparent = !active;
        n.meshMat.opacity = active ? 1 : 0.14;
        n.meshMat.needsUpdate = true;

        n.spriteMat.opacity = active ? 1 : 0.2;

        for (const r of n.rings) {
          r.mat.opacity = active
            ? filter === 'COMPLIANT'
              ? Math.min(1, r.baseOpacity * 1.2)
              : r.baseOpacity
            : 0.08;
        }

        if (n.haloMat) {
          n.haloMat.opacity = active ? 0.68 : 0.06;
        }

        if (n.attackTubeMat) {
          const showAttack = filter === 'ALL' || filter === 'CRITICAL';
          n.attackTubeMat.opacity = showAttack
            ? filter === 'CRITICAL'
              ? Math.min(0.95, n.attackTubeBaseOpacity * 1.25)
              : n.attackTubeBaseOpacity
            : 0.06;
        }

        for (const pm of n.pulseMats) {
          const showAttack = filter === 'ALL' || filter === 'CRITICAL';
          pm.transparent = !showAttack;
          pm.opacity = showAttack ? 1 : 0.06;
        }
      }

      if (reg.lateralLineMat) {
        const showLateral = filter === 'ALL' || filter === 'CRITICAL';
        reg.lateralLineMat.transparent = true;
        reg.lateralLineMat.opacity = showLateral ? 0.9 : 0.08;
      }

      for (const al of reg.auditorLines) {
        if (filter === 'ALL') {
          al.mat.opacity = al.baseOpacity;
        } else if (filter === 'COMPLIANT') {
          al.mat.opacity =
            al.targetSpec.status === 'compliant' ? 0.68 : 0.14;
        } else {
          al.mat.opacity = 0.08;
        }
      }
    },
    [matchesHudFilter]
  );

  useEffect(() => {
    hudFilterRef.current = hudFilter;
    simStepRef.current = simStep;
    applyFilterToRegistry(hudFilter, simStep);
  }, [hudFilter, simStep, applyFilterToRegistry]);

  useEffect(() => {
    if (!isExpanded) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && !document.querySelector('[role="dialog"]')) {
        setIsExpanded(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isExpanded]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = (ev: MediaQueryListEvent) => {
      reducedMotionRef.current = ev.matches;
      if (ev.matches) {
        setAutoRotate(false);
      }
    };
    mq.addEventListener('change', handleChange);
    return () => mq.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    autoRotateRef.current = autoRotate;
    if (controlsRef.current) {
      controlsRef.current.autoRotate = autoRotate;
    }
  }, [autoRotate]);

  const nodeSpecs = useMemo<TopologyNodeSpec[]>(() => {
    const findMatch = (keywords: string[]) =>
      findings.find((f) => {
        const hay =
          `${f.theme} ${f.reel?.ressource || ''} ${f.ecrit?.extrait || ''} ${f.exigence_nis2}`.toLowerCase();
        return keywords.some((kw) => hay.includes(kw));
      }) || null;

    const fBucket = findMatch(['radiologie', 'export-radiologie']);
    const fSsh = findMatch(['ssh', 'allow-ssh', 'pare-feu', 'firewall']);
    const fDpi = findMatch(['backups-dpi', 'dpi']);
    const fPacs = findMatch(['archives-pacs', 'pacs']);
    const fIam = findMatch(['iam', 'owner', 'editor', 'serviceaccount', 'privil']);
    const fKms = findMatch(['kms', 'rotation', 'audit log', 'journal']);

    const statusFromFinding = (
      f: Finding | null,
      fallback: NodeStatus
    ): NodeStatus => {
      if (!f) return fallback;
      if (f.statut === 'conforme') return 'compliant';
      if (f.gravite === 'critique' || f.statut === 'non_conforme') return 'critical';
      return 'warning';
    };

    const bucketStatus = statusFromFinding(fBucket, 'critical');
    const sshStatus = statusFromFinding(fSsh, 'critical');
    const dpiStatus = statusFromFinding(fDpi, 'warning');
    const pacsStatus = statusFromFinding(fPacs, 'compliant');
    const iamStatus = statusFromFinding(fIam, 'warning');
    const kmsStatus = statusFromFinding(fKms, 'compliant');

    return [
      {
        id: 'internet',
        label: 'Internet (0.0.0.0/0)',
        sublabel: 'Source externe • allUsers',
        position: [-4.4, 0.85, 0],
        status: 'attacker',
        shape: 'icosahedron',
        finding: fBucket || fSsh || findings[0] || null,
      },
      {
        id: 'export-radiologie',
        label: 'export-radiologie',
        sublabel:
          bucketStatus === 'critical'
            ? 'IAM allUsers PUBLIC'
            : 'Cloud Storage',
        position: [0.4, 1.35, -1.95],
        status: bucketStatus,
        shape: 'cylinder',
        finding: fBucket,
        attackFromInternet: bucketStatus === 'critical',
      },
      {
        id: 'allow-ssh-anywhere',
        label: 'allow-ssh-anywhere',
        sublabel:
          sshStatus === 'critical'
            ? 'TCP:22 ouvert 0.0.0.0/0'
            : 'VPC Firewall',
        position: [0.35, 1.1, 1.95],
        status: sshStatus,
        shape: 'octahedron',
        finding: fSsh,
        attackFromInternet: sshStatus === 'critical',
      },
      {
        id: 'backups-dpi',
        label: 'backups-dpi',
        sublabel:
          dpiStatus === 'compliant'
            ? 'Bucket Lock actif'
            : 'Sans verrou WORM',
        position: [3.25, 0.25, -2.1],
        status: dpiStatus,
        shape: 'cylinder',
        finding: fDpi,
        attackFromInternet: false,
      },
      {
        id: 'archives-pacs',
        label: 'archives-pacs',
        sublabel: 'WORM 365j actif ✓',
        position: [3.55, 0.35, 0.1],
        status: pacsStatus,
        shape: 'dodecahedron',
        finding: fPacs,
      },
      {
        id: 'iam-gcp',
        label: 'IAM & Comptes SA',
        sublabel: fIam
          ? fIam.statut === 'conforme'
            ? 'Moindre privilège ✓'
            : 'Privilèges / clés SA'
          : 'Art. 21 §2 (i)',
        position: [2.85, 0.15, 2.25],
        status: iamStatus,
        shape: 'box',
        finding: fIam || fBucket,
        attackFromInternet: iamStatus === 'critical',
      },
      {
        id: 'kms-logs',
        label: 'Cloud KMS & Logs',
        sublabel: fKms
          ? fKms.statut === 'conforme'
            ? 'Rotation & rétention ✓'
            : 'Rotation / logs partiels'
          : 'Art. 21 & 23',
        position: [1.55, -0.55, 0.05],
        status: kmsStatus,
        shape: 'octahedron',
        finding:
          fKms || findings.find((x) => x.exigence_nis2.includes('23')) || null,
      },
      {
        id: 'auditor-sa',
        label: 'Sonde triad-auditor',
        sublabel: proof?.objet_test
          ? `${proof.objet_test} → 403 ✓`
          : 'Lecture seule • 403 ✓',
        position: [-1.6, -1.05, 0],
        status: 'auditor',
        shape: 'dodecahedron',
        finding: null,
      },
    ];
  }, [findings, proof]);

  const focusCameraOnNode = useCallback((spec: TopologyNodeSpec) => {
    if (!cameraRef.current || !controlsRef.current) return;
    const [nx, ny, nz] = spec.position;
    const nextLookAt = new THREE.Vector3(nx * 0.72, ny * 0.45, nz * 0.72);
    const nextPos = new THREE.Vector3(
      nx * 0.65 - 1.15,
      Math.max(2.9, ny + 2.8),
      nz * 0.65 + 7.1
    );
    if (reducedMotionRef.current) {
      cameraRef.current.position.copy(nextPos);
      controlsRef.current.target.copy(nextLookAt);
      controlsRef.current.update();
    } else {
      cameraTweenRef.current = {
        active: true,
        targetPos: nextPos,
        targetLookAt: nextLookAt,
      };
    }
  }, []);

  const effectiveMode: RenderMode = webglError ? '2d' : renderMode;

  useEffect(() => {
    if (effectiveMode !== '3d') return;
    const container = mountRef.current;
    if (!container) return;

    const isDark = theme === 'dark';
    let renderer: THREE.WebGLRenderer;

    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch {
      setWebglError(true);
      setRenderMode('2d');
      return;
    }

    const width = container.clientWidth || 640;
    const height = container.clientHeight || 340;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(isDark ? 0x0c110f : 0xf2f3ef, 1);

    container.innerHTML = '';
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(isDark ? 0x0c110f : 0xf2f3ef, 0.03);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(44, width / height, 0.1, 100);
    camera.position.set(-1.1, 4.4, 9.6);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 5;
    controls.maxDistance = 16;
    controls.maxPolarAngle = Math.PI / 1.9;
    controls.target.set(0.5, 0.15, 0);
    controls.autoRotate = autoRotateRef.current;
    controls.autoRotateSpeed = 0.55;
    controlsRef.current = controls;

    const ambient = new THREE.AmbientLight(0xffffff, isDark ? 0.78 : 1.05);
    scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, isDark ? 1.25 : 0.95);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    const greenPoint = new THREE.PointLight(0x86bc25, isDark ? 0.6 : 0.22, 14);
    greenPoint.position.set(3.2, 2.2, 0.2);
    scene.add(greenPoint);

    const redPoint = new THREE.PointLight(0xd2452a, isDark ? 0.7 : 0.25, 14);
    redPoint.position.set(-3.5, 2.0, 0);
    scene.add(redPoint);

    const grid = new THREE.GridHelper(
      18,
      24,
      isDark ? 0x252d29 : 0xb3bfb7,
      isDark ? 0x161c19 : 0xdce2dc
    );
    grid.position.y = -1.55;
    scene.add(grid);

    const platformGeo = new THREE.CylinderGeometry(3.85, 4.05, 0.12, 6);
    const platformMat = new THREE.MeshStandardMaterial({
      color: isDark ? 0x121915 : 0xe6eae5,
      transparent: true,
      opacity: isDark ? 0.58 : 0.72,
      roughness: 0.4,
      metalness: 0.25,
    });
    const platform = new THREE.Mesh(platformGeo, platformMat);
    platform.position.set(2.05, -1.48, 0);
    scene.add(platform);

    const perimeterRingGeo = new THREE.RingGeometry(3.9, 3.98, 6);
    const perimeterRingMat = new THREE.MeshBasicMaterial({
      color: 0x86bc25,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.5,
    });
    const perimeterRing = new THREE.Mesh(perimeterRingGeo, perimeterRingMat);
    perimeterRing.rotation.x = -Math.PI / 2;
    perimeterRing.position.set(2.05, -1.41, 0);
    scene.add(perimeterRing);

    const pickableMeshes: THREE.Mesh[] = [];
    const meshToSpec = new Map<THREE.Object3D, TopologyNodeSpec>();
    const animatedRings: Array<{
      mesh: THREE.Mesh;
      speedX: number;
      speedY: number;
    }> = [];
    const threatHalos: THREE.Mesh[] = [];
    const pulseParticles: PulseParticle[] = [];
    const nodeVisuals: NodeVisualHandle[] = [];
    let lateralLineMatRef: THREE.LineDashedMaterial | null = null;
    const auditorLineRefs: SceneFilterRegistry['auditorLines'] = [];

    const internetSpec = nodeSpecs[0];
    const internetPos = new THREE.Vector3(...internetSpec.position);

    for (const spec of nodeSpecs) {
      const hexStr = STATUS_HEX[spec.status];
      const color = new THREE.Color(hexStr);
      const pos = new THREE.Vector3(...spec.position);

      let geo: THREE.BufferGeometry;
      if (spec.shape === 'icosahedron') {
        geo = new THREE.IcosahedronGeometry(0.56, 1);
      } else if (spec.shape === 'cylinder') {
        geo = new THREE.CylinderGeometry(0.42, 0.42, 0.68, 24);
      } else if (spec.shape === 'octahedron') {
        geo = new THREE.OctahedronGeometry(0.48, 0);
      } else if (spec.shape === 'dodecahedron') {
        geo = new THREE.DodecahedronGeometry(0.45, 0);
      } else {
        geo = new THREE.BoxGeometry(0.62, 0.62, 0.62);
      }

      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: isDark ? 0.18 : 0.04,
        roughness: 0.28,
        metalness: 0.45,
        wireframe: spec.status === 'attacker',
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      mesh.userData.baseScale = 1;
      scene.add(mesh);
      pickableMeshes.push(mesh);
      meshToSpec.set(mesh, spec);

      const sprite = createLabelSprite(spec.label, spec.sublabel, hexStr, isDark);
      sprite.position.set(pos.x, pos.y + 0.98, pos.z);
      scene.add(sprite);

      const ringHandles: Array<{
        mat: THREE.MeshBasicMaterial;
        baseOpacity: number;
      }> = [];
      let haloMatHandle: THREE.MeshBasicMaterial | null = null;
      let attackTubeMatHandle: THREE.MeshBasicMaterial | null = null;
      const attackTubeBaseOpacity = isDark ? 0.62 : 0.78;
      const pulseMatHandles: THREE.MeshBasicMaterial[] = [];

      if (spec.status === 'compliant' || spec.status === 'auditor') {
        const ring1Geo = new THREE.TorusGeometry(0.72, 0.028, 12, 48);
        const ring1Mat = new THREE.MeshBasicMaterial({
          color: 0x86bc25,
          transparent: true,
          opacity: 0.9,
        });
        const ring1 = new THREE.Mesh(ring1Geo, ring1Mat);
        ring1.position.copy(pos);
        ring1.rotation.x = Math.PI / 2.4;
        scene.add(ring1);
        animatedRings.push({ mesh: ring1, speedX: 0.01, speedY: 0.018 });
        ringHandles.push({ mat: ring1Mat, baseOpacity: 0.9 });

        const ring2Geo = new THREE.TorusGeometry(0.86, 0.018, 12, 48);
        const ring2Mat = new THREE.MeshBasicMaterial({
          color: 0x86bc25,
          transparent: true,
          opacity: 0.48,
        });
        const ring2 = new THREE.Mesh(ring2Geo, ring2Mat);
        ring2.position.copy(pos);
        ring2.rotation.y = Math.PI / 3;
        scene.add(ring2);
        animatedRings.push({ mesh: ring2, speedX: -0.014, speedY: 0.01 });
        ringHandles.push({ mat: ring2Mat, baseOpacity: 0.48 });
      }

      if (spec.status === 'critical' || spec.status === 'attacker') {
        const haloGeo = new THREE.RingGeometry(0.62, 0.78, 32);
        const haloMat = new THREE.MeshBasicMaterial({
          color: 0xd2452a,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.65,
        });
        const halo = new THREE.Mesh(haloGeo, haloMat);
        halo.position.set(pos.x, pos.y - 0.34, pos.z);
        halo.rotation.x = -Math.PI / 2;
        scene.add(halo);
        threatHalos.push(halo);
        haloMatHandle = haloMat;
      }

      if (spec.attackFromInternet && spec.id !== 'internet') {
        const mid = internetPos.clone().lerp(pos, 0.5);
        mid.y += 1.45;
        const curve = new THREE.QuadraticBezierCurve3(internetPos, mid, pos);

        const tubeGeo = new THREE.TubeGeometry(curve, 44, 0.036, 8, false);
        const tubeMat = new THREE.MeshBasicMaterial({
          color: 0xd2452a,
          transparent: true,
          opacity: attackTubeBaseOpacity,
        });
        const tube = new THREE.Mesh(tubeGeo, tubeMat);
        scene.add(tube);
        attackTubeMatHandle = tubeMat;

        for (let p = 0; p < 2; p += 1) {
          const pulseGeo = new THREE.SphereGeometry(0.095, 12, 12);
          const pulseMat = new THREE.MeshBasicMaterial({ color: 0xe8735a });
          const pulseMesh = new THREE.Mesh(pulseGeo, pulseMat);
          pulseMesh.position.copy(curve.getPointAt(p * 0.5 + 0.25));
          scene.add(pulseMesh);
          pulseMatHandles.push(pulseMat);
          pulseParticles.push({
            mesh: pulseMesh,
            curve,
            progress: p * 0.5,
            speed: 0.0065,
          });
        }
      }

      nodeVisuals.push({
        spec,
        mesh,
        meshMat: mat,
        spriteMat: sprite.material as THREE.SpriteMaterial,
        rings: ringHandles,
        haloMat: haloMatHandle,
        attackTubeMat: attackTubeMatHandle,
        attackTubeBaseOpacity,
        pulseMats: pulseMatHandles,
      });
    }

    const sshSpec = nodeSpecs.find((n) => n.id === 'allow-ssh-anywhere');
    const dpiSpec = nodeSpecs.find((n) => n.id === 'backups-dpi');
    if (sshSpec && dpiSpec && dpiSpec.status !== 'compliant') {
      const p1 = new THREE.Vector3(...sshSpec.position);
      const p2 = new THREE.Vector3(...dpiSpec.position);
      const mid = p1.clone().lerp(p2, 0.5);
      mid.y += 0.8;
      const lateralCurve = new THREE.QuadraticBezierCurve3(p1, mid, p2);
      const pts = lateralCurve.getPoints(32);
      const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
      const lineMat = new THREE.LineDashedMaterial({
        color: 0xd99a1e,
        dashSize: 0.22,
        gapSize: 0.14,
      });
      const dashedLine = new THREE.Line(lineGeo, lineMat);
      dashedLine.computeLineDistances();
      scene.add(dashedLine);
      lateralLineMatRef = lineMat;
    }

    const auditorSpec = nodeSpecs.find((n) => n.id === 'auditor-sa');
    if (auditorSpec) {
      const auditorPos = new THREE.Vector3(...auditorSpec.position);
      const baseAudOpacity = isDark ? 0.22 : 0.34;
      for (const target of nodeSpecs) {
        if (target.id === 'internet' || target.id === 'auditor-sa') continue;
        const tPos = new THREE.Vector3(...target.position);
        const lineGeo = new THREE.BufferGeometry().setFromPoints([
          auditorPos,
          tPos,
        ]);
        const lineMat = new THREE.LineBasicMaterial({
          color: 0x86bc25,
          transparent: true,
          opacity: baseAudOpacity,
        });
        scene.add(new THREE.Line(lineGeo, lineMat));
        auditorLineRefs.push({
          targetSpec: target,
          mat: lineMat,
          baseOpacity: baseAudOpacity,
        });
      }
    }

    filterRegistryRef.current = {
      nodes: nodeVisuals,
      lateralLineMat: lateralLineMatRef,
      auditorLines: auditorLineRefs,
    };
    applyFilterToRegistry(hudFilterRef.current, simStepRef.current);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hoveredMesh: THREE.Mesh | null = null;
    let downX = 0;
    let downY = 0;

    const updatePointer = (ev: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const onPointerMove = (ev: PointerEvent) => {
      updatePointer(ev);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(pickableMeshes, false);
      const hitMesh = (hits[0]?.object as THREE.Mesh | undefined) || null;

      if (hitMesh !== hoveredMesh) {
        if (hoveredMesh) {
          const prevBase = (hoveredMesh.userData.baseScale as number) || 1;
          hoveredMesh.scale.setScalar(prevBase);
        }
        hoveredMesh = hitMesh;
        if (hoveredMesh) {
          const base = (hoveredMesh.userData.baseScale as number) || 1;
          hoveredMesh.scale.setScalar(base * 1.18);
          const spec = meshToSpec.get(hoveredMesh) || null;
          setHoveredSpec(spec);
          renderer.domElement.style.cursor = 'pointer';
        } else {
          setHoveredSpec(null);
          renderer.domElement.style.cursor = 'grab';
        }
      }
    };

    const onPointerDown = (ev: PointerEvent) => {
      downX = ev.clientX;
      downY = ev.clientY;
      if (cameraTweenRef.current) {
        cameraTweenRef.current.active = false;
      }
    };

    const onWheel = () => {
      if (cameraTweenRef.current) {
        cameraTweenRef.current.active = false;
      }
    };

    const onPointerUp = (ev: PointerEvent) => {
      const dist = Math.hypot(ev.clientX - downX, ev.clientY - downY);
      if (dist > 6) return;
      updatePointer(ev);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(pickableMeshes, false);
      if (hits.length > 0) {
        const spec = meshToSpec.get(hits[0].object);
        if (spec) {
          setSelectedNodeId(spec.id);
          focusCameraOnNode(spec);
          if (spec.finding) {
            onSelectFinding(spec.finding);
          }
        }
      } else {
        setSelectedNodeId(null);
      }
    };

    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: true });

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = Math.max(280, entry.contentRect.width);
      const h = Math.max(260, entry.contentRect.height);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    let frameId = 0;
    let tick = 0;
    const animate = () => {
      frameId = window.requestAnimationFrame(animate);

      const tween = cameraTweenRef.current;
      if (tween?.active) {
        camera.position.lerp(tween.targetPos, 0.088);
        controls.target.lerp(tween.targetLookAt, 0.095);
        if (
          camera.position.distanceTo(tween.targetPos) < 0.025 &&
          controls.target.distanceTo(tween.targetLookAt) < 0.025
        ) {
          camera.position.copy(tween.targetPos);
          controls.target.copy(tween.targetLookAt);
          tween.active = false;
        }
      }

      if (!reducedMotionRef.current) {
        tick += 0.035;

        for (const item of animatedRings) {
          item.mesh.rotation.x += item.speedX;
          item.mesh.rotation.y += item.speedY;
        }

        const pulseScale = 1 + Math.sin(tick * 2.2) * 0.14;
        for (const halo of threatHalos) {
          halo.scale.setScalar(pulseScale);
        }

        for (const p of pulseParticles) {
          p.progress = (p.progress + p.speed) % 1;
          const pt = p.curve.getPointAt(p.progress);
          p.mesh.position.copy(pt);
        }
      }

      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      filterRegistryRef.current = null;
      rendererRef.current = null;
      sceneRef.current = null;
      controlsRef.current = null;
      cameraRef.current = null;
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      controls.dispose();

      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else {
            obj.material.dispose();
          }
        } else if (obj instanceof THREE.Sprite) {
          obj.material.map?.dispose();
          obj.material.dispose();
        }
      });
      renderer.dispose();
    };
  }, [
    effectiveMode,
    nodeSpecs,
    theme,
    onSelectFinding,
    applyFilterToRegistry,
    focusCameraOnNode,
  ]);

  const resetCamera = useCallback(() => {
    setSelectedNodeId(null);
    if (!cameraRef.current || !controlsRef.current) return;
    const defaultPos = new THREE.Vector3(-1.1, 4.4, 9.6);
    const defaultTarget = new THREE.Vector3(0.5, 0.15, 0);
    if (reducedMotionRef.current) {
      cameraRef.current.position.copy(defaultPos);
      controlsRef.current.target.copy(defaultTarget);
      controlsRef.current.update();
    } else {
      cameraTweenRef.current = {
        active: true,
        targetPos: defaultPos,
        targetLookAt: defaultTarget,
      };
    }
  }, []);

  const capturePngHd = useCallback(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return;

    const canvas = renderer.domElement;
    const w = canvas.clientWidth || 960;
    const h = canvas.clientHeight || 540;
    const prevRatio = renderer.getPixelRatio();
    const hdRatio = Math.max(prevRatio, 2);

    try {
      if (hdRatio !== prevRatio) {
        renderer.setPixelRatio(hdRatio);
        renderer.setSize(w, h, false);
      }
      controlsRef.current?.update();
      renderer.render(scene, camera);
      const dataUrl = renderer.domElement.toDataURL('image/png');

      if (hdRatio !== prevRatio) {
        renderer.setPixelRatio(prevRatio);
        renderer.setSize(w, h, false);
        renderer.render(scene, camera);
      }

      const filename = `Topologie_3D_GCP_NIS2_${new Date().toISOString().slice(0, 10)}.png`;
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      a.click();

      setPngCaptured(true);
      window.setTimeout(() => setPngCaptured(false), 1800);
      onNotify?.(
        'Capture PNG HD exportée',
        `${filename} (${Math.round(w * hdRatio)}×${Math.round(h * hdRatio)} px)`,
        'success'
      );
    } catch {
      onNotify?.(
        'Capture PNG indisponible',
        'Impossible d’extraire le tampon WebGL sur ce navigateur',
        'critical'
      );
    }
  }, [onNotify]);

  useEffect(() => {
    if (simStep === null) {
      if (controlsRef.current) {
        controlsRef.current.autoRotate = autoRotateRef.current;
      }
      return;
    }

    if (controlsRef.current) {
      controlsRef.current.autoRotate = false;
    }

    const stepMeta = ATTACK_SIMULATION_STEPS[simStep];
    const targetSpec = nodeSpecs.find((n) => n.id === stepMeta.nodeId);
    if (targetSpec) {
      focusCameraOnNode(targetSpec);
    }

    if (reducedMotionRef.current) return;

    const timer = window.setTimeout(() => {
      setSimStep((prev) =>
        prev === null ? null : (prev + 1) % ATTACK_SIMULATION_STEPS.length
      );
    }, 3200);

    return () => window.clearTimeout(timer);
  }, [simStep, nodeSpecs, focusCameraOnNode]);

  const toggleAttackSimulation = () => {
    if (simStep !== null) {
      setSimStep(null);
      resetCamera();
    } else {
      setSelectedNodeId(null);
      setSimStep(0);
    }
  };

  const activeSimMeta =
    simStep !== null ? ATTACK_SIMULATION_STEPS[simStep] : null;
  const activeSimSpec = useMemo(
    () =>
      activeSimMeta
        ? nodeSpecs.find((n) => n.id === activeSimMeta.nodeId) || null
        : null,
    [activeSimMeta, nodeSpecs]
  );

  const visibleSpecs = useMemo(
    () => nodeSpecs.filter((n) => matchesHudFilter(n.status, hudFilter)),
    [nodeSpecs, hudFilter, matchesHudFilter]
  );

  const selectedSpec = useMemo(
    () =>
      selectedNodeId
        ? nodeSpecs.find((n) => n.id === selectedNodeId) || null
        : null,
    [nodeSpecs, selectedNodeId]
  );

  const activeCardSpec = hoveredSpec || selectedSpec;

  const criticalCount = useMemo(
    () =>
      nodeSpecs.filter(
        (n) => n.status === 'critical' || n.status === 'warning'
      ).length,
    [nodeSpecs]
  );

  const compliantCount = useMemo(
    () =>
      nodeSpecs.filter(
        (n) => n.status === 'compliant' || n.status === 'auditor'
      ).length,
    [nodeSpecs]
  );

  const handleCanvasKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (visibleSpecs.length === 0) return;
    const curIdx = selectedNodeId
      ? visibleSpecs.findIndex((s) => s.id === selectedNodeId)
      : -1;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = visibleSpecs[(curIdx + 1) % visibleSpecs.length];
      setSelectedNodeId(next.id);
      focusCameraOnNode(next);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next =
        visibleSpecs[
          (curIdx <= 0 ? visibleSpecs.length - 1 : curIdx - 1) %
            visibleSpecs.length
        ];
      setSelectedNodeId(next.id);
      focusCameraOnNode(next);
    } else if ((e.key === 'Enter' || e.key === ' ') && selectedSpec?.finding) {
      e.preventDefault();
      onSelectFinding(selectedSpec.finding);
    } else if (e.key === 'Escape' && selectedNodeId) {
      e.stopPropagation();
      setSelectedNodeId(null);
    }
  };

  return (
    <div className="relative rounded-xl overflow-hidden border border-hairline">
      {/* Annonce lecteur d'écran WCAG */}
      <div className="sr-only" aria-live="polite">
        {activeCardSpec
          ? `${activeCardSpec.label} — ${activeCardSpec.sublabel}`
          : 'Topologie Cloud GCP interactive'}
      </div>

      {effectiveMode === '3d' ? (
        <div
          ref={mountRef}
          tabIndex={0}
          role="region"
          aria-label="Scène 3D Cloud GCP — flèches pour parcourir les actifs, Entrée pour inspecter"
          onKeyDown={handleCanvasKeyDown}
          className={`w-full transition-[height] duration-200 cursor-grab active:cursor-grabbing focus:outline-none focus:ring-2 focus:ring-[var(--deloitte)]/60 ${
            isExpanded ? 'h-[560px]' : 'h-[350px]'
          }`}
        />
      ) : (
        /* Repli 2D épuré & accessible clavier */
        <div
          role="region"
          aria-label="Topologie Cloud GCP — Vue 2D accessible"
          className="surface-panel pt-12 pb-3 px-3.5 space-y-2.5 min-h-[350px] flex flex-col justify-between"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {visibleSpecs.map((spec) => {
              const badge = STATUS_BADGE[spec.status];
              const isSel = selectedNodeId === spec.id;
              return (
                <button
                  key={spec.id}
                  type="button"
                  onClick={() => {
                    setSelectedNodeId(spec.id);
                    if (spec.finding) onSelectFinding(spec.finding);
                  }}
                  className={`text-left surface-card hover:border-strong rounded-xl px-3 py-2.5 transition flex items-center justify-between gap-2 cursor-pointer ${
                    isSel ? 'ring-1 ring-[var(--deloitte)]' : ''
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${badge.dot}`}
                    />
                    <div className="min-w-0">
                      <div className="font-mono text-xs font-bold text-main truncate">
                        {spec.label}
                      </div>
                      <div className="text-[10px] text-sub truncate">
                        {spec.sublabel}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {spec.finding && (
                      <span className="px-1.5 py-0.5 rounded bg-[var(--deloitte)] text-black font-mono text-[10px] font-extrabold">
                        {spec.finding.id}
                      </span>
                    )}
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${badge.cls}`}
                    >
                      {badge.label}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="pt-2 border-t border-hairline flex items-center justify-between gap-2 text-[10px] font-mono text-sub">
            <span className="inline-flex items-center gap-1.5 truncate">
              <Lock className="w-3 h-3 text-accent shrink-0" />
              <span>{proof?.service_account || 'triad-auditor@gcp.iam'}</span>
            </span>
            <span className="badge-success px-2 py-0.5 rounded font-bold">
              403 lecture métier ✓
            </span>
          </div>
        </div>
      )}

      {/* Contrôles flottants minimalistes — Haut gauche : Filtres + Propagation */}
      <div
        role="group"
        aria-label="Filtrer les actifs de la topologie"
        className="absolute top-2.5 left-2.5 flex flex-wrap items-center gap-1 z-10"
      >
        {(
          [
            ['ALL', `Tous (${nodeSpecs.length})`],
            ['CRITICAL', `Critiques (${criticalCount})`],
            ['COMPLIANT', `Conformes (${compliantCount})`],
          ] as const
        ).map(([key, label]) => {
          const active = simStep === null && hudFilter === key;
          const activeCls =
            key === 'CRITICAL'
              ? 'bg-[var(--rupture)] text-white border border-[var(--rupture)]'
              : 'seg-active border border-transparent';
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setSimStep(null);
                setHudFilter(key);
              }}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-extrabold transition cursor-pointer tabular-nums ${
                active
                  ? activeCls
                  : 'surface-panel/90 backdrop-blur-xs text-sub hover:text-main'
              }`}
            >
              {label}
            </button>
          );
        })}

        {effectiveMode === '3d' && (
          <button
            type="button"
            aria-pressed={simStep !== null}
            onClick={toggleAttackSimulation}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-extrabold transition cursor-pointer ${
              simStep !== null
                ? 'bg-[var(--rupture)] text-white border border-[var(--rupture)]'
                : 'badge-critical hover:opacity-90'
            }`}
            title="Animer le chemin d'attaque"
          >
            <Flame className="w-3 h-3 shrink-0" />
            <span>{simStep !== null ? 'Stop' : 'Propagation'}</span>
          </button>
        )}
      </div>

      {/* Contrôles flottants minimalistes — Haut droite : Bascule 2D/3D + Caméra */}
      <div className="absolute top-2.5 right-2.5 flex items-center gap-1 z-10">
        {effectiveMode === '3d' && (
          <>
            <button
              type="button"
              aria-pressed={autoRotate}
              aria-label="Rotation orbitale automatique"
              onClick={() => setAutoRotate((v) => !v)}
              className="p-1.5 rounded-lg surface-panel/90 backdrop-blur-xs text-sub hover:text-main transition cursor-pointer"
              title={autoRotate ? 'Pause rotation' : 'Activer rotation'}
            >
              {autoRotate ? (
                <Pause className="w-3.5 h-3.5 text-accent" />
              ) : (
                <Play className="w-3.5 h-3.5 text-accent" />
              )}
            </button>

            <button
              type="button"
              aria-label="Capturer PNG haute résolution de la scène 3D"
              onClick={capturePngHd}
              className="p-1.5 rounded-lg surface-panel/90 backdrop-blur-xs text-sub hover:text-main transition cursor-pointer"
              title="Capturer PNG HD"
            >
              {pngCaptured ? (
                <Check className="w-3.5 h-3.5 text-accent" />
              ) : (
                <Camera className="w-3.5 h-3.5 text-accent" />
              )}
            </button>

            <button
              type="button"
              aria-label="Recadrer la caméra 3D"
              onClick={resetCamera}
              className="p-1.5 rounded-lg surface-panel/90 backdrop-blur-xs text-sub hover:text-main transition cursor-pointer"
              title="Recadrer caméra"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              aria-pressed={isExpanded}
              aria-label={isExpanded ? 'Réduire la scène 3D' : 'Agrandir la scène 3D'}
              onClick={() => setIsExpanded((v) => !v)}
              className={`p-1.5 rounded-lg transition cursor-pointer ${
                isExpanded
                  ? 'seg-active'
                  : 'surface-panel/90 backdrop-blur-xs text-sub hover:text-main'
              }`}
              title={isExpanded ? 'Réduire (Échap)' : 'Plein cadre'}
            >
              {isExpanded ? (
                <Minimize2 className="w-3.5 h-3.5" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )}
            </button>
          </>
        )}
      </div>

      {/* Fiche nœud sélectionné / simulation compacte flottante (3D uniquement) */}
      {effectiveMode === '3d' && (
        <div className="absolute bottom-2.5 left-2.5 right-2.5 flex items-center justify-between gap-2 pointer-events-none">
          {activeSimMeta && simStep !== null ? (
            <div className="pointer-events-auto w-full surface-elevated edge-rose rounded-xl px-3 py-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="badge-critical font-mono text-[10px] font-extrabold px-2 py-0.5 rounded-full tabular-nums shrink-0">
                  {simStep + 1}/{ATTACK_SIMULATION_STEPS.length}
                </span>
                <span className="font-mono font-bold text-main text-xs truncate">
                  {activeSimMeta.title}
                </span>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  aria-label="Étape précédente"
                  onClick={() =>
                    setSimStep(
                      (simStep - 1 + ATTACK_SIMULATION_STEPS.length) %
                        ATTACK_SIMULATION_STEPS.length
                    )
                  }
                  className="p-1 rounded-lg surface-subtle text-sub hover:text-main cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Étape suivante"
                  onClick={() =>
                    setSimStep((simStep + 1) % ATTACK_SIMULATION_STEPS.length)
                  }
                  className="p-1 rounded-lg surface-subtle text-sub hover:text-main cursor-pointer"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
                {activeSimSpec?.finding && (
                  <button
                    type="button"
                    onClick={() => onSelectFinding(activeSimSpec.finding!)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--deloitte)] text-black text-[10px] font-extrabold font-mono cursor-pointer"
                  >
                    <span>{activeSimSpec.finding.id}</span>
                    <ArrowUpRight className="w-3 h-3" />
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Arrêter la simulation"
                  onClick={toggleAttackSimulation}
                  className="p-1 rounded-lg surface-subtle text-sub hover:text-[var(--critical-text)] cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ) : activeCardSpec ? (
            <div className="pointer-events-auto surface-elevated rounded-xl px-3 py-2 text-xs flex items-center justify-between gap-3 max-w-full sm:max-w-md">
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                    STATUS_BADGE[activeCardSpec.status].dot
                  }`}
                />
                <div className="min-w-0">
                  <div className="font-mono font-bold text-main text-[11px] truncate">
                    {activeCardSpec.label}
                  </div>
                  <div className="text-[10px] text-sub truncate">
                    {activeCardSpec.sublabel}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {activeCardSpec.finding && (
                  <button
                    type="button"
                    onClick={() => onSelectFinding(activeCardSpec.finding!)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--deloitte)] hover:bg-[var(--deloitte-hover)] text-black font-mono text-[10px] font-extrabold transition cursor-pointer"
                  >
                    <span>{activeCardSpec.finding.id}</span>
                    <ArrowUpRight className="w-3 h-3" />
                  </button>
                )}
                {selectedNodeId && (
                  <button
                    type="button"
                    aria-label="Fermer la fiche nœud"
                    onClick={() => setSelectedNodeId(null)}
                    className="p-1 rounded-lg surface-subtle text-sub hover:text-main cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="surface-panel/85 backdrop-blur-xs rounded-lg px-2.5 py-1 text-[10px] text-sub inline-flex items-center gap-2.5">
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-[var(--rupture)]" />
                <span>Exposé</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-[var(--deloitte)]" />
                <span>Conforme</span>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Cloud3DTopology;
