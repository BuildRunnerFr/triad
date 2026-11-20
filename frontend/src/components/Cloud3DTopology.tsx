import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  RotateCcw,
  ArrowUpRight,
  Maximize2,
  Minimize2,
  Flame,
  ChevronLeft,
  ChevronRight,
  X,
  Camera,
  Check,
  Lock,
} from 'lucide-react';
import type { AuditorProof, Finding, ThemeMode } from '../types';
import type { ToastTone } from './ToastStack';
import {
  buildLinks,
  createTopologyScene,
  DEFAULT_CAMERA_POS,
  DEFAULT_CAMERA_TARGET,
  type NodeStatus,
  type NodeVisualState,
  type SceneNodeSpec,
  type TopologySceneApi,
  type TopologyVisualState,
} from './topology/scene';

interface Cloud3DTopologyProps {
  findings: Finding[];
  proof: AuditorProof | null;
  theme: ThemeMode;
  onSelectFinding: (finding: Finding) => void;
  onNotify?: (title: string, detail?: string, tone?: ToastTone) => void;
  /** Vue plein focus (Investigation) : scène haute au lieu du format carte. */
  tall?: boolean;
}

type HudFilter = 'ALL' | 'CRITICAL' | 'COMPLIANT';
type RenderMode = '3d' | '2d';

interface TopologyNodeSpec extends SceneNodeSpec {
  finding: Finding | null;
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
  tall = false,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<TopologySceneApi | null>(null);

  const prefersReducedInitial =
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  const reducedMotionRef = useRef<boolean>(prefersReducedInitial);
  const hudFilterRef = useRef<HudFilter>('ALL');
  const simStepRef = useRef<number | null>(null);

  const [renderMode, setRenderMode] = useState<RenderMode>('3d');
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

  const linkSpecs = useMemo(() => buildLinks(nodeSpecs), [nodeSpecs]);

  /** Calcule l'état visuel (filtre ou étape de propagation) et l'applique à la scène. */
  const applyFilterToRegistry = useCallback(
    (filter: HudFilter, activeSimStep: number | null = simStepRef.current) => {
      const api = apiRef.current;
      if (!api) return;
      const state: TopologyVisualState = { nodes: {}, links: {} };

      if (activeSimStep !== null) {
        const step = ATTACK_SIMULATION_STEPS[activeSimStep];
        const chainSet = new Set(step.activeChainIds);
        for (const n of nodeSpecs) {
          const isPrimary = n.id === step.nodeId;
          const isInChain = chainSet.has(n.id);
          const isWormContrast = activeSimStep === 3 && n.id === 'archives-pacs';
          const s: NodeVisualState = {
            scale: isPrimary ? 1.3 : isInChain ? 1.08 : isWormContrast ? 0.96 : 0.84,
            opacity: isPrimary ? 1 : isInChain ? 0.94 : isWormContrast ? 0.55 : 0.13,
            label: isPrimary ? 1 : isInChain ? 0.92 : isWormContrast ? 0.65 : 0.18,
            accent: isPrimary || isInChain || isWormContrast ? 1 : 0.1,
          };
          state.nodes[n.id] = s;
        }
        for (const l of linkSpecs) {
          if (l.kind === 'attack') {
            const beamActive =
              (activeSimStep === 1 && l.to === 'export-radiologie') ||
              ((activeSimStep === 2 || activeSimStep === 3) &&
                l.to === 'allow-ssh-anywhere');
            state.links[l.id] = beamActive ? 1.25 : 0.08;
          } else if (l.kind === 'lateral') {
            state.links[l.id] = activeSimStep === 3 ? 1.5 : 0.15;
          } else {
            state.links[l.id] = 0.25;
          }
        }
        api.applyState(state);
        return;
      }

      for (const n of nodeSpecs) {
        const active = matchesHudFilter(n.status, filter);
        state.nodes[n.id] = {
          scale: filter === 'ALL' ? 1 : active ? 1.12 : 0.85,
          opacity: active ? 1 : 0.14,
          label: active ? 1 : 0.2,
          accent: active ? 1 : 0.08,
        };
      }
      for (const l of linkSpecs) {
        const showAttack = filter === 'ALL' || filter === 'CRITICAL';
        if (l.kind === 'attack') {
          state.links[l.id] = showAttack ? (filter === 'CRITICAL' ? 1.2 : 1) : 0.08;
        } else if (l.kind === 'lateral') {
          state.links[l.id] = showAttack ? 1 : 0.1;
        } else {
          const target = nodeSpecs.find((s) => s.id === l.from);
          state.links[l.id] =
            filter === 'ALL'
              ? 1
              : filter === 'COMPLIANT'
              ? target?.status === 'compliant'
                ? 2.6
                : 0.5
              : 0.3;
        }
      }
      api.applyState(state);
    },
    [matchesHudFilter, nodeSpecs, linkSpecs]
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
      apiRef.current?.setReducedMotion(ev.matches);
    };
    mq.addEventListener('change', handleChange);
    return () => mq.removeEventListener('change', handleChange);
  }, []);

  const focusCameraOnNode = useCallback((spec: TopologyNodeSpec) => {
    const api = apiRef.current;
    if (!api) return;
    const [nx, ny, nz] = spec.position;
    const nextLookAt = new THREE.Vector3(nx * 0.72, ny * 0.45, nz * 0.72);
    const nextPos = new THREE.Vector3(
      nx * 0.65 - 1.15,
      Math.max(2.9, ny + 2.8),
      nz * 0.65 + 7.1
    );
    api.flyTo(nextPos, nextLookAt);
  }, []);

  const effectiveMode: RenderMode = webglError ? '2d' : renderMode;

  // Les callbacks vivent dans des refs : la scène n'est reconstruite que si
  // les ressources changent (pas au changement de thème ni de sélection).
  const onSelectFindingRef = useRef(onSelectFinding);
  const focusRef = useRef(focusCameraOnNode);
  const applyRef = useRef(applyFilterToRegistry);
  useEffect(() => {
    onSelectFindingRef.current = onSelectFinding;
    focusRef.current = focusCameraOnNode;
    applyRef.current = applyFilterToRegistry;
  });

  useEffect(() => {
    if (effectiveMode !== '3d') return;
    const container = mountRef.current;
    if (!container) return;

    const specById = new Map(nodeSpecs.map((s) => [s.id, s]));
    let api: TopologySceneApi;
    try {
      api = createTopologyScene(
        container,
        nodeSpecs,
        {
          onHover: (id) => setHoveredSpec(id ? specById.get(id) || null : null),
          onClick: (id) => {
            const spec = id ? specById.get(id) : undefined;
            if (spec) {
              setSelectedNodeId(spec.id);
              focusRef.current(spec);
              if (spec.finding) onSelectFindingRef.current(spec.finding);
            } else {
              setSelectedNodeId(null);
            }
          },
          onDoubleClick: (id) => {
            const spec = id ? specById.get(id) : undefined;
            if (spec) {
              focusRef.current(spec);
            } else {
              setSelectedNodeId(null);
              apiRef.current?.flyTo(DEFAULT_CAMERA_POS, DEFAULT_CAMERA_TARGET);
            }
          },
        },
        { reducedMotion: reducedMotionRef.current }
      );
    } catch {
      setWebglError(true);
      setRenderMode('2d');
      return;
    }
    apiRef.current = api;
    applyRef.current(hudFilterRef.current, simStepRef.current);

    return () => {
      apiRef.current = null;
      api.dispose();
    };
  }, [effectiveMode, nodeSpecs]);

  // Changement de thème : relecture des variables CSS une fois le DOM à jour.
  useEffect(() => {
    const id = window.requestAnimationFrame(() => apiRef.current?.refreshPalette());
    return () => window.cancelAnimationFrame(id);
  }, [theme]);

  useEffect(() => {
    apiRef.current?.setSelected(selectedNodeId);
  }, [selectedNodeId]);

  const resetCamera = useCallback(() => {
    setSelectedNodeId(null);
    apiRef.current?.flyTo(DEFAULT_CAMERA_POS, DEFAULT_CAMERA_TARGET);
  }, []);

  const capturePngHd = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const { renderer, scene, camera } = api;

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
      api.renderNow();
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
    if (simStep === null) return;

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
            isExpanded ? 'h-[560px]' : tall ? 'h-[min(68vh,640px)]' : 'h-[350px]'
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
                      <span className="px-1.5 py-0.5 rounded surface-subtle border border-hairline text-main font-mono text-[10px] font-extrabold">
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
            <span className="badge-success px-2 py-0.5 rounded font-semibold" title="La sonde lit la configuration, jamais les données (accès métier refusé, HTTP 403)">
              Lecture seule vérifiée
            </span>
          </div>
        </div>
      )}

      {/* Contrôles flottants minimalistes — Haut gauche : Filtres + Propagation */}
      <div
        role="group"
        aria-label="Filtrer les actifs de la topologie"
        className="absolute top-2.5 left-2.5 right-36 sm:right-auto flex flex-wrap items-center gap-1 z-10"
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
              ? 'badge-critical'
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
              className={`min-h-[28px] px-2.5 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer tabular-nums ${
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
                ? 'badge-critical'
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
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg surface-subtle border border-hairline text-main font-mono text-[10px] font-extrabold transition cursor-pointer"
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
                <span className="w-2 h-2 rounded-full bg-[var(--reel)]" />
                <span>Conforme</span>
              </span>
              <span className="inline-flex items-center gap-1" title="La sonde balaie la configuration en lecture seule, sans jamais lire les données">
                <span className="w-3 h-px bg-[var(--reel)]" />
                <span>Balayage en lecture seule</span>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Cloud3DTopology;