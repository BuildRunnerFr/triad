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
}

const AGENT_PIPELINE_PREVIEW = [
  {
    step: '01',
    agentKey: 'Douanier',
    name: 'Douanier',
    role: 'Sas DLP & Quarantaine',
    icon: ShieldCheck,
    badgeCls: 'badge-warning',
  },
  {
    step: '02',
    agentKey: 'AnalysteConformite',
    name: 'Analyste Conformité',
    role: 'NIS2 × Sondes GCP',
    icon: ScanSearch,
    badgeCls: 'badge-info',
  },
  {
    step: '03',
    agentKey: 'ContreAuditeur',
    name: 'Contre-Auditeur',
    role: 'Citations Exactes',
    icon: Scale,
    badgeCls: 'badge-violet',
  },
  {
    step: '04',
    agentKey: 'GardeDuCorps',
    name: 'Garde du Corps',
    role: 'SHA-256 & Verrou 403',
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

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-6"
    >
      {/* BARRE DE SESSION MINIMALISTE */}
      <div className="surface-panel rounded-2xl px-4 py-3 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Layers className="w-4 h-4 text-accent shrink-0" />
            <span className="text-xs font-extrabold text-main">Session</span>
            <span
              className={`font-mono text-[11px] font-bold px-2.5 py-0.5 rounded-full ${
                isDefaultSession ? 'badge-success' : 'badge-info'
              }`}
            >
              {isDefaultSession ? 'Valmont (default)' : activeSessionId}
            </span>
            {availableSessions.length > 1 && (
              <span className="text-[11px] font-mono text-dim hidden sm:inline">
                {availableSessions.length} espaces
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {availableSessions.length > 1 && (
              <div
                role="group"
                aria-label="Accès rapide aux sessions"
                className="hidden xl:flex items-center gap-1 surface-subtle p-1 rounded-xl"
              >
                {availableSessions.slice(0, 3).map((sess) => {
                  const active = sess.session_id === activeSessionId;
                  const anyReady = Boolean(
                    sess.modes_ready?.AVANT || sess.modes_ready?.APRES
                  );
                  return (
                    <button
                      key={sess.session_id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => onSelectSession(sess.session_id)}
                      className={`min-h-[28px] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                        active
                          ? 'bg-[#86BC25] text-black'
                          : 'text-sub hover:text-main'
                      }`}
                    >
                      <span className="font-mono truncate max-w-[120px]">
                        {sess.session_id === DEFAULT_SESSION_ID
                          ? 'default'
                          : sess.session_id}
                      </span>
                      {anyReady && (
                        <span
                          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            active ? 'bg-black' : 'bg-[#86BC25]'
                          }`}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            <label className="sr-only" htmlFor="triad-session-select">
              Sélectionner une session d&apos;audit
            </label>
            <select
              id="triad-session-select"
              aria-label="Sélectionner une session d'audit enregistrée"
              value={activeSessionId}
              onChange={(e) => onSelectSession(e.target.value)}
              className="min-h-[34px] max-w-[230px] rounded-xl surface-card px-2.5 py-1 text-xs font-semibold text-main hover:border-strong focus:outline-none focus:border-[#86BC25] transition cursor-pointer"
            >
              {availableSessions.map((sess) => (
                <option key={sess.session_id} value={sess.session_id}>
                  {formatSessionOptionLabel(
                    sess,
                    sess.session_id === activeSessionId
                  )}
                </option>
              ))}
            </select>

            {onExportSession && (
              <button
                type="button"
                disabled={isExportingSession}
                onClick={handleTriggerExportSession}
                title={`Exporter le snapshot JSON signé de la session ${activeSessionId}`}
                className="min-h-[34px] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl surface-card hover:border-[#86BC25] disabled:opacity-50 text-xs font-semibold text-sub hover:text-main transition cursor-pointer"
              >
                {isExportingSession ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
                ) : (
                  <Download className="w-3.5 h-3.5 text-accent" />
                )}
                <span>Exporter</span>
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
                  title="Importer un snapshot de session (.json)"
                  className="min-h-[34px] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl surface-card hover:border-[#86BC25] disabled:opacity-50 text-xs font-semibold text-sub hover:text-main transition cursor-pointer"
                >
                  {isImportingSession ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
                  ) : (
                    <Upload className="w-3.5 h-3.5 text-accent" />
                  )}
                  <span>Importer</span>
                </button>
              </>
            )}

            {!isDefaultSession && onDeleteSession && (
              <button
                type="button"
                onClick={() => onDeleteSession(activeSessionId)}
                aria-label={`Supprimer la session ${activeSessionId}`}
                title="Supprimer cette session secondaire"
                className="min-h-[34px] inline-flex items-center gap-1 px-2.5 py-1 rounded-xl surface-card text-xs font-semibold text-sub hover:text-rose-500 hover:border-rose-500/40 transition cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}

            <button
              type="button"
              onClick={onCreateNewSession}
              className="min-h-[34px] inline-flex items-center gap-1.5 px-3 py-1 rounded-xl border border-[#86BC25]/45 bg-[var(--accent-soft)] hover:bg-[#86BC25] hover:text-black text-xs font-extrabold text-accent transition cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Nouvelle session</span>
            </button>
          </div>
        </div>

        {importErrorBanner && (
          <div
            role="alert"
            className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 flex items-start justify-between gap-3"
          >
            <div className="flex items-start gap-2 min-w-0 text-xs">
              <ShieldAlert className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <span className="font-extrabold text-rose-500">
                  Import refusé
                  {importErrorBanner.status
                    ? ` (HTTP ${importErrorBanner.status})`
                    : ''}{' '}
                  :{' '}
                </span>
                <span className="text-main break-words">
                  {importErrorBanner.detail}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setImportErrorBanner(null)}
              aria-label="Fermer l'alerte"
              className="p-1 rounded-lg text-sub hover:text-main transition cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* 2 BLOCS PRINCIPAUX AÉRÉS : SCÉNARIO (7 COLS) + PIÈCES DU DOSSIER (5 COLS) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* BLOC 1 : SCÉNARIO, PHASE & LANCEMENT */}
        <div className="xl:col-span-7 surface-panel rounded-2xl p-6 space-y-6 relative overflow-hidden">
          <div className="absolute -top-24 -right-24 w-56 h-56 rounded-full bg-[#86BC25]/8 blur-3xl pointer-events-none" />

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="badge-success inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-extrabold uppercase tracking-wider">
                <Building2 className="w-3.5 h-3.5" />
                Entité Essentielle • Santé
              </span>
              <span className="text-xs font-mono text-dim">
                NIS2 Art. 21 &amp; 23 • Sonde GCP Read-Only
              </span>
            </div>

            <h2 className="text-2xl font-extrabold tracking-tight text-main">
              {clientName || 'Centre Hospitalier de Valmont'}
            </h2>
          </div>

          {/* Sélecteur épuré des 2 phases */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <button
              type="button"
              onClick={() => onModeChange('AVANT')}
              className={`text-left p-4 rounded-xl border transition-all cursor-pointer ${
                mode === 'AVANT'
                  ? 'border-[#86BC25] bg-[var(--accent-soft)] shadow-xs'
                  : 'surface-card hover:border-strong'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-extrabold uppercase tracking-wide text-accent">
                  Phase AVANT
                </span>
                {modesReady?.AVANT && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#86BC25] text-black">
                    <CheckCircle2 className="w-3 h-3" />
                    Prêt
                  </span>
                )}
              </div>
              <div className="text-sm font-extrabold text-main">
                Écrit × Réel Cloud
              </div>
              <div className="text-xs text-sub mt-0.5">
                Pré-audit &amp; trame DSI
              </div>
            </button>

            <button
              type="button"
              onClick={() => onModeChange('APRES')}
              className={`text-left p-4 rounded-xl border transition-all cursor-pointer ${
                mode === 'APRES'
                  ? 'border-[#86BC25] bg-[var(--accent-soft)] shadow-xs'
                  : 'surface-card hover:border-strong'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-extrabold uppercase tracking-wide text-accent">
                  Phase APRÈS
                </span>
                {modesReady?.APRES && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#86BC25] text-black">
                    <CheckCircle2 className="w-3 h-3" />
                    Prêt
                  </span>
                )}
              </div>
              <div className="text-sm font-extrabold text-main">
                Dit × Écrit × Réel
              </div>
              <div className="text-xs text-sub mt-0.5">
                Contradictions &amp; livrables
              </div>
            </button>
          </div>

          {/* Barre d'actions d'exécution & accès rapide */}
          <div className="pt-4 border-t border-hairline flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onRunAudit}
                className="inline-flex items-center gap-2 bg-[#86BC25] hover:bg-[#96cf2e] text-black font-extrabold text-xs px-5 py-2.5 rounded-xl shadow-sm transition cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Auditer ({mode === 'AVANT' ? 'AVANT' : 'APRÈS'})</span>
              </button>

              <button
                type="button"
                onClick={onRunBothModes}
                className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl surface-card hover:border-strong text-xs font-bold text-main transition cursor-pointer"
                title="Exécuter AVANT puis APRÈS et ouvrir le Comparateur"
              >
                <GitCompareArrows className="w-3.5 h-3.5 text-accent" />
                <span>AVANT → APRÈS</span>
              </button>
            </div>

            {currentReady && (
              <div className="flex flex-wrap items-center gap-2">
                {bothReady && (
                  <button
                    type="button"
                    onClick={onOpenComparator}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl surface-card hover:border-strong text-xs font-bold text-accent transition cursor-pointer"
                  >
                    <GitCompareArrows className="w-3.5 h-3.5" />
                    <span>Comparateur</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={onOpenCockpit}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl surface-card hover:border-[#86BC25] text-xs font-extrabold text-main transition cursor-pointer"
                >
                  <span>Cockpit</span>
                  <ArrowRight className="w-3.5 h-3.5 text-accent" />
                </button>
              </div>
            )}
          </div>

          {/* Accordéon discret : Pipeline 4 Agents & Télémétrie */}
          <div className="pt-2 border-t border-hairline">
            <button
              type="button"
              aria-expanded={pipelineOpen}
              onClick={() => setPipelineOpen((v) => !v)}
              className="w-full flex items-center justify-between gap-2 py-1.5 text-left text-xs font-bold text-sub hover:text-main transition cursor-pointer"
            >
              <span className="inline-flex items-center gap-2">
                <ShieldCheck className="w-3.5 h-3.5 text-accent" />
                <span>Pipeline Zero-Trust (4 agents)</span>
                {showTimings && totalPipelineMs !== null && (
                  <span className="badge-success inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-bold tabular-nums">
                    <Clock className="w-2.5 h-2.5" />
                    {formatAgentTimingMs(totalPipelineMs)}
                  </span>
                )}
              </span>
              <ChevronDown
                className={`w-4 h-4 text-dim transition-transform ${
                  pipelineOpen ? 'rotate-180' : ''
                }`}
              />
            </button>

            {pipelineOpen && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-3">
                {AGENT_PIPELINE_PREVIEW.map((ag) => {
                  const Icon = ag.icon;
                  const agentMs =
                    timingsMs && typeof timingsMs[ag.agentKey] === 'number'
                      ? timingsMs[ag.agentKey]
                      : null;
                  return (
                    <div
                      key={ag.step}
                      className="surface-card rounded-xl p-3 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span
                          className={`w-7 h-7 rounded-lg flex items-center justify-center ${ag.badgeCls}`}
                        >
                          <Icon className="w-3.5 h-3.5" />
                        </span>
                        <span className="font-mono text-[10px] font-bold text-dim tabular-nums">
                          {agentMs !== null
                            ? formatAgentTimingMs(agentMs)
                            : `#${ag.step}`}
                        </span>
                      </div>
                      <div className="text-xs font-extrabold text-main leading-tight">
                        {ag.name}
                      </div>
                      <div className="text-[10px] text-sub leading-tight">
                        {ag.role}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* BLOC 2 : DÉPÔT & LISTE COMPACTE DES PIÈCES */}
        <div className="xl:col-span-5 surface-panel rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-extrabold text-main">
                Pièces du dossier
              </h3>
              <span className="font-mono text-[11px] font-bold px-2 py-0.5 rounded-full surface-subtle text-main tabular-nums">
                {docs.length}
              </span>
            </div>

            <button
              type="button"
              onClick={onLoadDemo}
              className="badge-success inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold hover:opacity-90 transition cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Démo Valmont</span>
            </button>
          </div>

          {/* Zone de dépôt compacte */}
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files?.length) {
                onUploadFiles(e.dataTransfer.files);
              }
            }}
            className="surface-card border-dashed hover:border-[#86BC25] rounded-xl px-4 py-3.5 flex items-center justify-center gap-2.5 cursor-pointer transition"
          >
            <Upload className="w-4 h-4 text-accent shrink-0" />
            <span className="text-xs font-semibold text-main">
              Déposer des pièces (.md, .txt, .pdf)
            </span>
            <span className="text-[10px] font-mono text-dim hidden sm:inline">
              • DLP auto
            </span>
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

          {/* Liste compacte des pièces */}
          {docs.length === 0 ? (
            <div className="surface-subtle rounded-xl p-6 text-center">
              <FolderOpen className="w-5 h-5 text-dim mx-auto mb-1" />
              <div className="text-xs font-semibold text-sub">
                Aucune pièce chargée
              </div>
            </div>
          ) : (
            <div className="space-y-2 max-h-[290px] overflow-y-auto pr-1">
              {docs.map((doc) => {
                const isQuar = doc.statut === 'quarantaine';
                const isDit = doc.nom_fichier.toLowerCase().includes('entretien');
                const isThirdParty = doc.nom_fichier
                  .toLowerCase()
                  .includes('fournisseur');
                const tagLabel = isQuar
                  ? 'Adverse'
                  : isDit
                  ? 'DIT'
                  : isThirdParty
                  ? 'TIERS'
                  : 'ÉCRIT';

                return (
                  <div
                    key={doc.nom_fichier}
                    onClick={() => doc.contenu_masque && onSelectDoc(doc)}
                    className={`px-3 py-2.5 rounded-xl border transition flex items-center justify-between gap-2.5 ${
                      doc.contenu_masque ? 'cursor-pointer' : ''
                    } ${
                      isQuar
                        ? 'badge-critical'
                        : 'surface-card hover:border-strong'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {isQuar ? (
                        <AlertOctagon className="w-4 h-4 tone-critical shrink-0" />
                      ) : (
                        <FileText className="w-4 h-4 text-accent shrink-0" />
                      )}
                      <span className="text-xs font-bold text-main truncate">
                        {doc.nom_fichier}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded surface-subtle text-dim">
                        {tagLabel}
                      </span>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          isQuar
                            ? 'badge-critical'
                            : doc.statut === 'nettoye'
                            ? 'badge-success'
                            : 'surface-subtle text-sub'
                        }`}
                      >
                        {isQuar
                          ? 'Bloqué'
                          : doc.statut === 'nettoye'
                          ? 'DLP ✓'
                          : 'Prêt'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
};
