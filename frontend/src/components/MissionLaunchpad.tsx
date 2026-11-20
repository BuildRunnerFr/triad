import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Building2,
  Play,
  Upload,
  Download,
  FileText,
  ShieldCheck,
  ShieldAlert,
  ScanSearch,
  Scale,
  LockKeyhole,
  Sparkles,
  CheckCircle2,
  ArrowRight,
  FolderOpen,
  AlertOctagon,
  GitCompareArrows,
  Layers,
  Plus,
  Trash2,
  Clock,
  Loader2,
  ChevronDown,
  X,
} from 'lucide-react';
import type { AuditMode, SanitizedDocument, SessionSummary } from '../types';
import { DEFAULT_SESSION_ID } from '../api';
import {
  formatAgentTimingMs,
  hasAgentTimings,
  sumAgentTimingsMs,
} from '../utils/auditMetrics';

interface MissionLaunchpadProps {
  mode: AuditMode;
  clientName?: string | null;
  activeSessionId: string;
  sessions: SessionSummary[];
  timingsMs?: Record<string, number> | null;
  docs: SanitizedDocument[];
  modesReady?: Record<AuditMode, boolean>;
  onSelectSession: (sessionId: string) => void;
  onCreateNewSession: () => void;
  onDeleteSession?: (sessionId: string) => void;
  onExportSession?: (sessionId: string) => Promise<boolean>;
  onImportSession?: (
    file: File
  ) => Promise<{ ok: boolean; status?: number; detail?: string }>;
  onModeChange: (mode: AuditMode) => void;
  onLoadDemo: () => void;
  onUploadFiles: (files: FileList) => void;
  onRunAudit: () => void;
  onRunBothModes: () => void;
  onOpenCockpit: () => void;
  onOpenComparator: () => void;
  onSelectDoc: (doc: SanitizedDocument) => void;
  findingsCount?: number;
  arbitratedCount?: number;
  validated?: boolean;
  onOpenInvestigation?: () => void;
  onOpenDeliverables?: () => void;
}

const AGENT_PIPELINE_PREVIEW = [
  {
    step: '01',
    agentKey: 'Douanier',
    name: 'Douanier',
    role: 'Masque les données personnelles, isole les pièces suspectes',
    icon: ShieldCheck,
    badgeCls: 'badge-warning',
  },
  {
    step: '02',
    agentKey: 'AnalysteConformite',
    name: 'Analyste conformité',
    role: 'Croise NIS2 et configuration GCP',
    icon: ScanSearch,
    badgeCls: 'badge-info',
  },
  {
    step: '03',
    agentKey: 'ContreAuditeur',
    name: 'Contre-auditeur',
    role: 'Vérifie chaque citation mot à mot',
    icon: Scale,
    badgeCls: 'badge-violet',
  },
  {
    step: '04',
    agentKey: 'GardeDuCorps',
    name: 'Garde du corps',
    role: 'Scelle le registre et verrouille les livrables',
    icon: LockKeyhole,
    badgeCls: 'badge-success',
  },
] as const;

function formatSessionOptionLabel(
  s: SessionSummary,
  isCurrent: boolean
): string {
  const isDefault = s.session_id === DEFAULT_SESSION_ID;
  const baseTitle = isDefault
    ? 'default — Démo Valmont'
    : `${s.session_id}${s.client ? ` — ${s.client}` : ''}`;

  const readyParts: string[] = [];
  if (s.modes_ready?.AVANT) readyParts.push('AVANT ✓');
  if (s.modes_ready?.APRES) readyParts.push('APRÈS ✓');

  const statusSuffix =
    readyParts.length > 0
      ? ` [${readyParts.join(' · ')}]`
      : isCurrent && !isDefault
      ? ' [Active]'
      : '';

  return `${baseTitle}${statusSuffix}`;
}

export const MissionLaunchpad: React.FC<MissionLaunchpadProps> = ({
  mode,
  clientName,
  activeSessionId,
  sessions,
  timingsMs,
  docs,
  modesReady,
  onSelectSession,
  onCreateNewSession,
  onDeleteSession,
  onExportSession,
  onImportSession,
  onModeChange,
  onLoadDemo,
  onUploadFiles,
  onRunAudit,
  onRunBothModes,
  onOpenCockpit,
  onOpenComparator,
  onSelectDoc,
  findingsCount = 0,
  arbitratedCount = 0,
  validated = false,
  onOpenInvestigation,
  onOpenDeliverables,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sessionImportInputRef = useRef<HTMLInputElement | null>(null);
  const [isExportingSession, setIsExportingSession] = useState(false);
  const [isImportingSession, setIsImportingSession] = useState(false);
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [importErrorBanner, setImportErrorBanner] = useState<{
    status?: number;
    detail: string;
  } | null>(null);

  useEffect(() => {
    setImportErrorBanner(null);
  }, [activeSessionId]);

  const handleTriggerExportSession = async () => {
    if (!onExportSession || isExportingSession) return;
    setIsExportingSession(true);
    try {
      await onExportSession(activeSessionId);
    } finally {
      setIsExportingSession(false);
    }
  };

  const handleSessionSnapshotSelected = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !onImportSession || isImportingSession) return;
    setIsImportingSession(true);
    setImportErrorBanner(null);
    try {
      const res = await onImportSession(file);
      if (!res.ok && res.status !== 429) {
        setImportErrorBanner({
          status: res.status,
          detail:
            res.detail ||
            'Import refusé : intégrité cryptographique SHA-256 invalide.',
        });
      }
    } finally {
      setIsImportingSession(false);
    }
  };

  const currentReady = Boolean(modesReady?.[mode]);
  const bothReady = Boolean(modesReady?.AVANT && modesReady?.APRES);
  const isDefaultSession = activeSessionId === DEFAULT_SESSION_ID;

  const availableSessions = useMemo<SessionSummary[]>(() => {
    const byId = new Map<string, SessionSummary>();

    byId.set(DEFAULT_SESSION_ID, {
      session_id: DEFAULT_SESSION_ID,
      client: 'Centre Hospitalier de Valmont',
      modes_ready: isDefaultSession ? modesReady : undefined,
    });

    for (const s of sessions) {
      const existing = byId.get(s.session_id);
      byId.set(s.session_id, {
        ...existing,
        ...s,
        modes_ready:
          s.session_id === activeSessionId
            ? {
                AVANT: Boolean(s.modes_ready?.AVANT || modesReady?.AVANT),
                APRES: Boolean(s.modes_ready?.APRES || modesReady?.APRES),
              }
            : s.modes_ready,
      });
    }

    if (!byId.has(activeSessionId)) {
      byId.set(activeSessionId, {
        session_id: activeSessionId,
        client: clientName || null,
        modes_ready: modesReady,
      });
    }

    const list = Array.from(byId.values());
    list.sort((a, b) => {
      if (a.session_id === DEFAULT_SESSION_ID) return -1;
      if (b.session_id === DEFAULT_SESSION_ID) return 1;
      if (a.session_id === activeSessionId) return -1;
      if (b.session_id === activeSessionId) return 1;
      return (b.updated_at || '').localeCompare(a.updated_at || '');
    });
    return list;
  }, [sessions, activeSessionId, isDefaultSession, modesReady, clientName]);

  const showTimings = hasAgentTimings(timingsMs);
  const totalPipelineMs = sumAgentTimingsMs(timingsMs);

  const sessionLabel = isDefaultSession ? 'Démo Valmont' : activeSessionId;
  const quarantined = docs.filter((d) => d.statut === 'quarantaine').length;
  const phaseLabel = mode === 'APRES' ? 'APRÈS' : 'AVANT';

  const steps = [
    {
      key: 'dossier',
      title: 'Constituer le dossier',
      done: docs.length > 0,
      meta:
        docs.length > 0
          ? `${docs.length} pièce${docs.length > 1 ? 's' : ''}${quarantined > 0 ? ` · ${quarantined} en quarantaine` : ''}`
          : 'Aucune pièce chargée',
      action: docs.length > 0 ? null : { label: 'Charger la démo Valmont', onClick: onLoadDemo },
    },
    {
      key: 'audit',
      title: `Lancer l'audit ${phaseLabel}`,
      done: currentReady,
      meta: currentReady
        ? `Synthèse ${phaseLabel} disponible${showTimings && totalPipelineMs !== null ? ` · ${formatAgentTimingMs(totalPipelineMs)}` : ''}`
        : '4 agents, sondes en lecture seule',
      action: currentReady
        ? { label: 'Voir le cockpit', onClick: onOpenCockpit }
        : { label: `Auditer (${phaseLabel})`, onClick: onRunAudit },
    },
    {
      key: 'arbitrage',
      title: 'Arbitrer les constats',
      done: arbitratedCount > 0,
      meta:
        findingsCount > 0
          ? `${arbitratedCount} / ${findingsCount} constats arbitrés`
          : 'Après l’audit',
      action: onOpenInvestigation ? { label: 'Ouvrir l’investigation', onClick: onOpenInvestigation } : null,
    },
    {
      key: 'signature',
      title: 'Signer et débloquer',
      done: validated,
      meta: validated ? 'Livrables déverrouillés' : '12 livrables verrouillés',
      action: onOpenDeliverables ? { label: 'Revoir et signer', onClick: onOpenDeliverables } : null,
    },
  ];
  const nextStepIndex = steps.findIndex((s) => !s.done);

  const PHASES = [
    {
      key: 'AVANT' as const,
      title: 'Phase AVANT',
      lede: 'Pré-audit documentaire, avant les entretiens',
      lanes: ['ecrit', 'reel'] as const,
      outcome: 'Trame d’entretien DSI',
    },
    {
      key: 'APRES' as const,
      title: 'Phase APRÈS',
      lede: 'Confrontation après entretiens contradictoires',
      lanes: ['dit', 'ecrit', 'reel'] as const,
      outcome: 'Contradictions et livrables',
    },
  ];
  const LANE_LABEL = { dit: 'Dit', ecrit: 'Écrit', reel: 'Réel' } as const;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-8"
    >
      {/* EN-TÊTE DE MISSION : le client d'abord, la session au second plan */}
      <section aria-labelledby="mission-title" className="pt-1 pb-6 border-b border-hairline">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="min-w-0">
            <p className="text-sm text-sub">Mission NIS2 · entité essentielle, secteur santé</p>
            <h2
              id="mission-title"
              className="mt-1 text-[1.9rem] sm:text-[2.4rem] leading-[1.1] font-semibold tracking-[-0.025em] text-main"
            >
              {clientName || 'Centre Hospitalier de Valmont'}
            </h2>
            <p className="mt-2 text-sm text-sub">
              Directive NIS2, articles 21 et 23 · Sondes Google Cloud en lecture seule
            </p>
          </div>

          {/* Session : repliée, outils de gestion à la demande */}
          <details className="group relative">
            <summary className="list-none inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-hairline hover:border-strong text-xs text-sub cursor-pointer select-none [&::-webkit-details-marker]:hidden">
              <Layers className="w-3.5 h-3.5" />
              <span>
                Session : <span className="font-semibold text-main">{sessionLabel}</span>
              </span>
              {availableSessions.length > 1 && (
                <span className="tabular-nums">· {availableSessions.length} espaces</span>
              )}
              <ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180" />
            </summary>
            <div className="absolute right-0 z-20 mt-2 w-[min(22rem,calc(100vw-2rem))] surface-elevated rounded-xl p-3 space-y-3">
              <label className="block text-xs text-sub" htmlFor="triad-session-select">
                Session d&apos;audit enregistrée
              </label>
              <select
                id="triad-session-select"
                value={activeSessionId}
                onChange={(e) => onSelectSession(e.target.value)}
                className="w-full min-h-[36px] rounded-lg surface-card px-2.5 py-1 text-xs font-semibold text-main cursor-pointer"
              >
                {availableSessions.map((sess) => (
                  <option key={sess.session_id} value={sess.session_id}>
                    {formatSessionOptionLabel(sess, sess.session_id === activeSessionId)}
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={onCreateNewSession}
                  className="col-span-2 inline-flex items-center justify-center gap-1.5 min-h-[36px] px-3 rounded-lg border border-strong text-xs font-semibold text-main hover:bg-[var(--bg-hover)] transition cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Nouvelle session
                </button>
                {onExportSession && (
                  <button
                    type="button"
                    disabled={isExportingSession}
                    onClick={handleTriggerExportSession}
                    className="inline-flex items-center justify-center gap-1.5 min-h-[36px] px-3 rounded-lg border border-hairline text-xs font-semibold text-sub hover:text-main disabled:opacity-50 transition cursor-pointer"
                  >
                    {isExportingSession ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                    Exporter (.json)
                  </button>
                )}
                {onImportSession && (
                  <>
                    <input
                      ref={sessionImportInputRef}
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      aria-label="Importer un snapshot de session JSON"
                      onChange={handleSessionSnapshotSelected}
                    />
                    <button
                      type="button"
                      disabled={isImportingSession}
                      onClick={() => sessionImportInputRef.current?.click()}
                      className="inline-flex items-center justify-center gap-1.5 min-h-[36px] px-3 rounded-lg border border-hairline text-xs font-semibold text-sub hover:text-main disabled:opacity-50 transition cursor-pointer"
                    >
                      {isImportingSession ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                      Importer
                    </button>
                  </>
                )}
                {!isDefaultSession && onDeleteSession && (
                  <button
                    type="button"
                    onClick={() => onDeleteSession(activeSessionId)}
                    className="col-span-2 inline-flex items-center justify-center gap-1.5 min-h-[36px] px-3 rounded-lg text-xs font-semibold text-[var(--critical-text)] hover:bg-[var(--critical-bg)] transition cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Supprimer cette session
                  </button>
                )}
              </div>
            </div>
          </details>
        </div>

        {importErrorBanner && (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-[var(--critical-border)] bg-[var(--critical-bg)] px-3.5 py-2 flex items-start justify-between gap-3"
          >
            <p className="text-xs text-main">
              <span className="font-bold text-[var(--critical-text)]">
                Import refusé{importErrorBanner.status ? ` (HTTP ${importErrorBanner.status})` : ''} :{' '}
              </span>
              {importErrorBanner.detail}
            </p>
            <button
              type="button"
              onClick={() => setImportErrorBanner(null)}
              aria-label="Fermer l'alerte"
              className="p-1 rounded text-sub hover:text-main cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </section>

      {/* DÉROULÉ DE MISSION : la prochaine étape porte la seule action principale */}
      <section aria-labelledby="steps-title">
        <h3 id="steps-title" className="sr-only">Déroulé de la mission</h3>
        <ol className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 surface-panel rounded-2xl overflow-hidden divide-y sm:divide-y-0 divide-[var(--border-subtle)]">
          {steps.map((step, idx) => {
            const isNext = idx === nextStepIndex;
            return (
              <li
                key={step.key}
                aria-current={isNext ? 'step' : undefined}
                className={`p-5 flex flex-col gap-3 sm:border-r border-hairline last:border-r-0 sm:[&:nth-child(2)]:max-xl:border-r-0 sm:[&:nth-child(-n+2)]:max-xl:border-b ${
                  isNext ? 'bg-[var(--bg-elevated)]' : ''
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className={`w-7 h-7 rounded-full inline-flex items-center justify-center text-xs font-bold tabular-nums ${
                      step.done
                        ? 'bg-[var(--reel-soft)] text-[var(--accent-text)]'
                        : isNext
                        ? 'bg-[var(--text-primary)] text-[var(--bg-surface)]'
                        : 'border border-strong text-sub'
                    }`}
                  >
                    {step.done ? <CheckCircle2 className="w-4 h-4" /> : idx + 1}
                  </span>
                  <span className={`text-sm font-semibold ${step.done || isNext ? 'text-main' : 'text-sub'}`}>
                    {step.title}
                  </span>
                </div>
                <p className="text-xs text-sub tabular-nums">{step.meta}</p>
                {step.action && (step.done || isNext) && (
                  <button
                    type="button"
                    onClick={step.action.onClick}
                    className={`mt-auto self-start inline-flex items-center gap-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                      isNext
                        ? 'px-3.5 py-2 bg-[var(--deloitte)] hover:bg-[var(--deloitte-hover)] text-[#0B100D]'
                        : 'py-1 text-[var(--accent-text)] hover:underline underline-offset-4'
                    }`}
                  >
                    {isNext && step.key === 'audit' && <Play className="w-3.5 h-3.5 fill-current" />}
                    {step.action.label}
                    {!isNext && <ArrowRight className="w-3.5 h-3.5" />}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* PHASES : deux faces nettes, et la méthode des 4 agents */}
        <section aria-labelledby="phases-title" className="xl:col-span-7 surface-panel rounded-2xl p-5 sm:p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id="phases-title" className="text-base font-semibold text-main">
              Phases d&apos;audit
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              {bothReady && (
                <button
                  type="button"
                  onClick={onOpenComparator}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-hairline hover:border-strong text-xs font-semibold text-main transition cursor-pointer"
                >
                  <GitCompareArrows className="w-3.5 h-3.5" />
                  Comparer AVANT / APRÈS
                </button>
              )}
              <button
                type="button"
                onClick={onRunBothModes}
                title="Exécuter AVANT puis APRÈS et ouvrir le comparateur"
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-hairline hover:border-strong text-xs font-semibold text-main transition cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                Auditer AVANT puis APRÈS
              </button>
            </div>
          </div>

          <div role="radiogroup" aria-label="Phase d'audit active" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {PHASES.map((ph) => {
              const active = mode === ph.key;
              const ready = Boolean(modesReady?.[ph.key]);
              return (
                <button
                  key={ph.key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onModeChange(ph.key)}
                  className={`text-left p-4 rounded-xl border transition cursor-pointer ${
                    active
                      ? 'border-[var(--text-primary)] bg-[var(--bg-elevated)] shadow-[inset_0_0_0_1px_var(--text-primary)]'
                      : 'border-hairline hover:border-strong'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-main">{ph.title}</span>
                    <span className={`text-xs font-semibold ${ready ? 'text-[var(--accent-text)]' : 'text-sub'}`}>
                      {ready ? 'Synthèse prête' : 'À lancer'}
                    </span>
                  </div>
                  <p className="text-xs text-sub mt-1">{ph.lede}</p>
                  <div className="mt-3 flex items-center gap-1.5 text-xs text-main">
                    {ph.lanes.map((lane, i) => (
                      <React.Fragment key={lane}>
                        {i > 0 && <span className="text-sub">×</span>}
                        <span className="inline-flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full" style={{ background: `var(--${lane})` }} aria-hidden="true" />
                          {LANE_LABEL[lane]}
                        </span>
                      </React.Fragment>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-sub">Produit : {ph.outcome.charAt(0).toLowerCase() + ph.outcome.slice(1)}</p>
                </button>
              );
            })}
          </div>

          {/* La méthode : 4 agents en chaîne, chacun à moindre privilège */}
          <div className="pt-4 border-t border-hairline">
            <div className="flex items-baseline justify-between gap-2">
              <h4 className="text-sm font-semibold text-main">La chaîne des 4 agents</h4>
              {showTimings && totalPipelineMs !== null && (
                <span className="text-xs text-sub tabular-nums">
                  Dernière exécution : {formatAgentTimingMs(totalPipelineMs)}
                </span>
              )}
            </div>
            <ol className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-4">
              {AGENT_PIPELINE_PREVIEW.map((ag, i) => {
                const Icon = ag.icon;
                const agentMs =
                  timingsMs && typeof timingsMs[ag.agentKey] === 'number' ? timingsMs[ag.agentKey] : null;
                return (
                  <li key={ag.step} className="relative">
                    <div className="flex items-center gap-2">
                      <span className="w-8 h-8 rounded-lg border border-hairline bg-[var(--bg-elevated)] inline-flex items-center justify-center text-main shrink-0">
                        <Icon className="w-4 h-4" />
                      </span>
                      {i < AGENT_PIPELINE_PREVIEW.length - 1 && (
                        <span aria-hidden="true" className="hidden sm:block flex-1 h-px bg-[var(--border-strong)]" />
                      )}
                    </div>
                    <p className="mt-2 text-xs font-semibold text-main">{ag.name}</p>
                    <p className="text-[11px] text-sub leading-snug">{ag.role}</p>
                    {agentMs !== null && (
                      <p className="text-[11px] text-sub tabular-nums mt-0.5">{formatAgentTimingMs(agentMs)}</p>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        {/* PIÈCES DU DOSSIER : une ligne par pièce, pilier en couleur */}
        <section aria-labelledby="docs-title" className="xl:col-span-5 surface-panel rounded-2xl overflow-hidden">
          <header className="px-5 pt-5 pb-3 flex items-center justify-between gap-2">
            <h3 id="docs-title" className="text-base font-semibold text-main">
              Pièces du dossier <span className="text-sub font-normal tabular-nums">({docs.length})</span>
            </h3>
            <button
              type="button"
              onClick={onLoadDemo}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-hairline hover:border-strong text-xs font-semibold text-main transition cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Démo Valmont
            </button>
          </header>

          {docs.length === 0 ? (
            <p className="px-5 pb-2 text-sm text-sub">
              Déposez les pièces de la mission (PSSI, procès-verbaux, contrats, notes d&apos;entretien) ou chargez la
              démo pour commencer.
            </p>
          ) : (
            <ul className="border-y border-hairline divide-y divide-[var(--border-subtle)] max-h-[320px] overflow-y-auto">
              {docs.map((doc) => {
                const isQuar = doc.statut === 'quarantaine';
                const lower = doc.nom_fichier.toLowerCase();
                const isDit = lower.includes('entretien');
                const isThirdParty = lower.includes('fournisseur');
                const pillar = isQuar
                  ? { label: 'Quarantaine', color: 'var(--rupture)' }
                  : isDit
                  ? { label: 'Dit', color: 'var(--dit)' }
                  : isThirdParty
                  ? { label: 'Tiers', color: 'var(--warning-text)' }
                  : { label: 'Écrit', color: 'var(--ecrit)' };
                const clickable = Boolean(doc.contenu_masque);
                return (
                  <li key={doc.nom_fichier}>
                    <button
                      type="button"
                      disabled={!clickable}
                      onClick={() => clickable && onSelectDoc(doc)}
                      className="w-full px-5 py-3 flex items-center justify-between gap-3 text-left hover:bg-[var(--bg-hover)] disabled:hover:bg-transparent disabled:cursor-default transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-2.5 min-w-0">
                        {isQuar ? (
                          <AlertOctagon className="w-4 h-4 shrink-0" style={{ color: pillar.color }} />
                        ) : (
                          <FileText className="w-4 h-4 shrink-0 text-sub" />
                        )}
                        <span className="text-sm text-main truncate">{doc.nom_fichier}</span>
                      </span>
                      <span className="flex items-center gap-3 shrink-0 text-xs">
                        <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: pillar.color }}>
                          <span className="w-2 h-2 rounded-full" style={{ background: pillar.color }} aria-hidden="true" />
                          {pillar.label}
                        </span>
                        <span className={isQuar ? 'text-[var(--critical-text)] font-semibold' : 'text-sub'}>
                          {isQuar ? 'Bloquée' : doc.statut === 'nettoye' ? 'DLP appliqué' : 'Prête'}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="p-5">
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files?.length) onUploadFiles(e.dataTransfer.files);
              }}
              className="rounded-xl border border-dashed border-strong hover:border-[var(--text-primary)] px-4 py-4 flex flex-col items-center justify-center gap-1 text-center cursor-pointer transition"
            >
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-main">
                <Upload className="w-4 h-4" />
                Déposer des pièces
              </span>
              <span className="text-xs text-sub">.md, .txt ou .pdf · masquage des données personnelles automatique</span>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".md,.txt,.pdf"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) onUploadFiles(e.target.files);
                }}
              />
            </div>
          </div>
        </section>
      </div>
    </motion.div>
  );
};
