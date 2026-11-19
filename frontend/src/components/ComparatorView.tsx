import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  GitCompareArrows,
  Zap,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  MessageSquareQuote,
  FileText,
  Server,
  Play,
  ArrowUpRight,
  TrendingUp,
  TrendingDown,
  Minus,
  MessageCircleQuestion,
  Clock,
  ShieldCheck,
  RefreshCw,
  ChevronDown,
  Terminal,
  Scale,
} from 'lucide-react';
import type {
  AuditMode,
  AuditSynthesis,
  Finding,
  ServerAuditDiffResponse,
} from '../types';
import { apiFetch } from '../api';
import {
  CANONICAL_AGENTS,
  compareSyntheses,
  formatAgentTimingMs,
  hasAgentTimings,
  mapServerDiffToComparisonSummary,
  matchesComparisonFilter,
  sumAgentTimingsMs,
  type ComparisonCategory,
} from '../utils/auditMetrics';
import { computeLocalRemediationSimulation } from '../utils/grcSimulation';
import { classifyFindingForRoadmap, HORIZON_META } from './RemediationRoadmap';

interface ComparatorViewProps {
  sessionId?: string;
  avantSynthesis: AuditSynthesis | null;
  apresSynthesis: AuditSynthesis | null;
  avantTimingsMs?: Record<string, number> | null;
  apresTimingsMs?: Record<string, number> | null;
  activeTimingsMs?: Record<string, number> | null;
  isRunning: boolean;
  onRunSingleMode: (targetMode: AuditMode) => void;
  onRunBothModes: () => void;
  onSelectFinding: (finding: Finding) => void;
  onOpenQuoteInDoc: (sourceName: string, quote: string) => void;
}

const STATUT_LABELS: Record<string, { label: string; cls: string }> = {
  non_conforme: { label: 'Non conforme', cls: 'badge-critical' },
  partiel: { label: 'Partiel', cls: 'badge-warning' },
  conforme: { label: 'Conforme', cls: 'badge-success' },
  a_confirmer: { label: 'À confirmer', cls: 'surface-subtle text-sub' },
};

export const ComparatorView: React.FC<ComparatorViewProps> = ({
  sessionId,
  avantSynthesis,
  apresSynthesis,
  avantTimingsMs,
  apresTimingsMs,
  activeTimingsMs,
  isRunning,
  onRunSingleMode,
  onRunBothModes,
  onSelectFinding,
  onOpenQuoteInDoc,
}) => {
  const [filter, setFilter] = useState<'ALL' | ComparisonCategory>('ALL');
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const [serverDiff, setServerDiff] = useState<ServerAuditDiffResponse | null>(
    null
  );
  const [diffSource, setDiffSource] = useState<
    'idle' | 'loading' | 'server' | 'local'
  >('idle');

  const bothReady = Boolean(avantSynthesis && apresSynthesis);

  const localSummary = useMemo(() => {
    if (!avantSynthesis || !apresSynthesis) return null;
    return compareSyntheses(avantSynthesis, apresSynthesis);
  }, [avantSynthesis, apresSynthesis]);

  useEffect(() => {
    if (!avantSynthesis || !apresSynthesis) {
      setServerDiff(null);
      setDiffSource('idle');
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setDiffSource('loading');

    apiFetch('/api/audit/diff', { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload: ServerAuditDiffResponse = await res.json();
        if (cancelled) return;
        if (payload && payload.ready && Array.isArray(payload.items)) {
          setServerDiff(payload);
          setDiffSource('server');
        } else {
          setServerDiff(null);
          setDiffSource('local');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setServerDiff(null);
          setDiffSource('local');
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [avantSynthesis, apresSynthesis, sessionId]);

  const summary = useMemo(() => {
    if (serverDiff) {
      const mapped = mapServerDiffToComparisonSummary(serverDiff);
      if (mapped) return mapped;
    }
    return localSummary;
  }, [serverDiff, localSummary]);

  const filteredItems = useMemo(() => {
    if (!summary) return [];
    return summary.items.filter((i) => matchesComparisonFilter(i, filter));
  }, [summary, filter]);

  const fullPlanWorkload = useMemo(() => {
    if (!apresSynthesis) return null;
    const actionableIds = apresSynthesis.findings
      .filter((f) => f.statut !== 'conforme')
      .map((f) => f.id);
    return computeLocalRemediationSimulation(
      apresSynthesis.findings,
      actionableIds,
      'APRES'
    );
  }, [apresSynthesis]);

  const resolvedAvantTimings = hasAgentTimings(
    serverDiff?.timings_by_mode?.AVANT
  )
    ? serverDiff?.timings_by_mode?.AVANT
    : hasAgentTimings(avantTimingsMs)
    ? avantTimingsMs
    : null;

  const resolvedApresTimings = hasAgentTimings(
    serverDiff?.timings_by_mode?.APRES
  )
    ? serverDiff?.timings_by_mode?.APRES
    : hasAgentTimings(apresTimingsMs)
    ? apresTimingsMs
    : hasAgentTimings(serverDiff?.timings_ms)
    ? serverDiff?.timings_ms
    : null;

  const resolvedFallbackTimings = hasAgentTimings(activeTimingsMs)
    ? activeTimingsMs
    : null;

  const showAgentTimings = Boolean(
    resolvedAvantTimings || resolvedApresTimings || resolvedFallbackTimings
  );

  const maxObservedAgentMs = useMemo(() => {
    let maxVal = 1;
    for (const ag of CANONICAL_AGENTS) {
      const candidates = [
        resolvedAvantTimings?.[ag.key],
        resolvedApresTimings?.[ag.key],
        resolvedFallbackTimings?.[ag.key],
      ];
      for (const c of candidates) {
        if (typeof c === 'number' && Number.isFinite(c) && c > maxVal) {
          maxVal = c;
        }
      }
    }
    return maxVal;
  }, [resolvedAvantTimings, resolvedApresTimings, resolvedFallbackTimings]);

  const toggleItemDetails = (key: string) => {
    setExpandedKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  if (!bothReady || !avantSynthesis || !apresSynthesis || !summary) {
    const missingMode: AuditMode | null =
      avantSynthesis && !apresSynthesis
        ? 'APRES'
        : !avantSynthesis && apresSynthesis
        ? 'AVANT'
        : null;

    const singleModeTimings =
      resolvedApresTimings || resolvedAvantTimings || resolvedFallbackTimings;

    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="surface-panel rounded-2xl p-6 sm:p-7 max-w-2xl mx-auto space-y-5"
      >
        <div className="flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-2xl bg-[#86BC25]/15 border border-[#86BC25]/35 text-accent flex items-center justify-center shrink-0">
            <GitCompareArrows className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-extrabold text-main">
              Comparateur AVANT → APRÈS
            </h2>
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              <span className="px-2 py-0.5 rounded-full surface-subtle font-mono text-[10px] font-bold text-sub">
                Écrit × Réel
              </span>
              <span className="text-dim text-xs">→</span>
              <span className="badge-success px-2 py-0.5 rounded-full font-mono text-[10px] font-extrabold">
                Dit × Écrit × Réel
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div
            className={`rounded-xl p-3.5 border flex items-center justify-between gap-2 ${
              avantSynthesis ? 'badge-success' : 'surface-card'
            }`}
          >
            <div>
              <div className="text-xs font-extrabold">Phase 1 • AVANT</div>
              <div className="text-[11px] opacity-85 mt-0.5">
                {avantSynthesis
                  ? `${avantSynthesis.findings.length} constats • ${avantSynthesis.questions_entretien.length} questions`
                  : 'En attente'}
              </div>
            </div>
            <span className="font-mono text-[10px] font-extrabold px-2 py-0.5 rounded-full surface-subtle text-main">
              {avantSynthesis ? 'Prête ✓' : 'Requise'}
            </span>
          </div>

          <div
            className={`rounded-xl p-3.5 border flex items-center justify-between gap-2 ${
              apresSynthesis ? 'badge-success' : 'surface-card'
            }`}
          >
            <div>
              <div className="text-xs font-extrabold">Phase 2 • APRÈS</div>
              <div className="text-[11px] opacity-85 mt-0.5">
                {apresSynthesis
                  ? `${apresSynthesis.findings.length} constats triangulés`
                  : 'En attente'}
              </div>
            </div>
            <span className="font-mono text-[10px] font-extrabold px-2 py-0.5 rounded-full surface-subtle text-main">
              {apresSynthesis ? 'Prête ✓' : 'Requise'}
            </span>
          </div>
        </div>

        {singleModeTimings && (
          <div className="surface-subtle rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-bold text-main inline-flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-accent" />
                Télémétrie Agents
              </span>
              <span className="font-mono text-dim tabular-nums">
                {formatAgentTimingMs(sumAgentTimingsMs(singleModeTimings))}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {CANONICAL_AGENTS.map((ag) => (
                <div
                  key={ag.key}
                  className="surface-card rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-2 text-[11px]"
                >
                  <span className="font-semibold text-sub truncate">
                    {ag.label}
                  </span>
                  <span className="font-mono font-bold text-accent tabular-nums shrink-0">
                    {formatAgentTimingMs(singleModeTimings[ag.key])}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="pt-2 flex flex-wrap items-center justify-end gap-3 border-t border-hairline">
          {missingMode ? (
            <button
              type="button"
              disabled={isRunning}
              onClick={() => onRunSingleMode(missingMode)}
              className="inline-flex items-center gap-2 bg-[#86BC25] hover:bg-[#96cf2e] disabled:opacity-50 text-black font-extrabold text-xs px-5 py-2.5 rounded-xl transition cursor-pointer"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>
                Lancer la phase {missingMode === 'AVANT' ? 'AVANT' : 'APRÈS'}
              </span>
            </button>
          ) : (
            <button
              type="button"
              disabled={isRunning}
              onClick={onRunBothModes}
              className="inline-flex items-center gap-2 bg-[#86BC25] hover:bg-[#96cf2e] disabled:opacity-50 text-black font-extrabold text-xs px-5 py-2.5 rounded-xl transition cursor-pointer"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>Exécuter la séquence AVANT → APRÈS</span>
            </button>
          )}
        </div>
      </motion.div>
    );
  }

  const DeltaIcon =
    summary.scoreDelta > 0
      ? TrendingUp
      : summary.scoreDelta < 0
      ? TrendingDown
      : Minus;

  const totalAvantMs = sumAgentTimingsMs(resolvedAvantTimings);
  const totalApresMs = sumAgentTimingsMs(
    resolvedApresTimings || resolvedFallbackTimings
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className="space-y-5"
    >
      {/* LIGNE 1 : 4 CARTES KPI CHIFFRÉES AÉRÉES */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* KPI 1 : Score AVANT -> APRÈS */}
        <div className="surface-panel rounded-2xl p-4 flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-sub">
              Score AVANT → APRÈS
            </span>
            <span
              className={`inline-flex items-center gap-1 text-xs font-extrabold px-2 py-0.5 rounded-full tabular-nums ${
                summary.scoreDelta > 0
                  ? 'badge-success'
                  : summary.scoreDelta < 0
                  ? 'badge-critical'
                  : 'surface-subtle text-sub'
              }`}
            >
              <DeltaIcon className="w-3.5 h-3.5" />
              {summary.scoreDelta > 0
                ? `+${summary.scoreDelta}`
                : summary.scoreDelta}{' '}
              pts
            </span>
          </div>
          <div className="flex items-baseline gap-2.5 mt-1">
            <span className="text-lg font-bold tabular-nums text-sub">
              {summary.scoreAvant}%
            </span>
            <ArrowRight className="w-4 h-4 text-dim" />
            <span className="text-3xl font-extrabold tabular-nums text-main">
              {summary.scoreApres}%
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] font-mono text-sub tabular-nums">
            <span>
              {serverDiff?.counts?.findings_avant ?? avantSynthesis.findings.length}{' '}
              →{' '}
              {serverDiff?.counts?.findings_apres ?? apresSynthesis.findings.length}{' '}
              constats
            </span>
            <span>•</span>
            <span className="tone-success font-bold">
              {summary.resolvedOrCompliantCount} sain(s)
            </span>
          </div>
        </div>

        {/* KPI 2 : Ruptures du Dit */}
        <div className="surface-panel rounded-2xl p-4 flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-sub">
              Ruptures du Dit
            </span>
            <div className="w-7 h-7 rounded-lg badge-critical flex items-center justify-center">
              <Zap className="w-3.5 h-3.5" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold tabular-nums tone-critical">
              +{summary.ditContradictionsCount}
            </span>
            <span className="badge-critical text-[10px] font-bold px-2 py-0.5 rounded-full">
              Dit ≠ Réel / Écrit
            </span>
          </div>
          <div className="text-[11px] font-mono text-sub">
            Déclarations DSI démenties
          </div>
        </div>

        {/* KPI 3 : Charge j.h & Quick-Wins */}
        <div className="surface-panel rounded-2xl p-4 flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-sub">
              Charge j.h
            </span>
            <div className="w-7 h-7 rounded-lg badge-success flex items-center justify-center">
              <Clock className="w-3.5 h-3.5" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold font-mono tabular-nums text-main">
              {fullPlanWorkload
                ? `${String(fullPlanWorkload.workload_jh.estimated_jh).replace(
                    '.',
                    ','
                  )}`
                : '0'}{' '}
              <span className="text-sm font-bold text-sub">j.h</span>
            </span>
            {fullPlanWorkload &&
              fullPlanWorkload.workload_jh.quick_wins_count > 0 && (
                <span className="badge-success text-[10px] font-extrabold px-2 py-0.5 rounded-full tabular-nums">
                  {fullPlanWorkload.workload_jh.quick_wins_count} Quick-Wins
                </span>
              )}
          </div>
          <div className="text-[11px] font-mono text-sub tabular-nums">
            {fullPlanWorkload
              ? `Fourchette ${String(fullPlanWorkload.workload_jh.min_jh).replace(
                  '.',
                  ','
                )}–${String(fullPlanWorkload.workload_jh.max_jh).replace(
                  '.',
                  ','
                )} j.h`
              : 'Plan 30/60/90j'}
          </div>
        </div>

        {/* KPI 4 : Exposition Art. 34 & Écarts */}
        <div className="surface-panel rounded-2xl p-4 flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-sub">
              Exposition Art. 34
            </span>
            <div className="w-7 h-7 rounded-lg badge-warning flex items-center justify-center">
              <Scale className="w-3.5 h-3.5" />
            </div>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold tabular-nums tone-warning">
              {summary.confirmedGapsCount}
            </span>
            <span className="text-xs font-semibold text-sub">écart(s)</span>
            {summary.newGapsCount > 0 && (
              <span className="badge-high text-[10px] font-bold px-2 py-0.5 rounded-full tabular-nums">
                +{summary.newGapsCount} nouveaux
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] font-mono text-sub">
            {fullPlanWorkload ? (
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${
                  fullPlanWorkload.art34_exposure.risk_level_before === 'CRITIQUE'
                    ? 'badge-critical'
                    : fullPlanWorkload.art34_exposure.risk_level_before === 'ÉLEVÉ'
                    ? 'badge-warning'
                    : 'badge-success'
                }`}
              >
                Risque {fullPlanWorkload.art34_exposure.risk_level_before}
              </span>
            ) : (
              <span>10 M€ / 2 % CA</span>
            )}
          </div>
        </div>
      </div>

      {/* TÉLÉMÉTRIE MULTI-AGENTS CONDENSÉE */}
      {showAgentTimings && (
        <div className="surface-panel rounded-2xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-accent" />
              <h3 className="text-xs sm:text-sm font-extrabold text-main">
                Télémétrie d&apos;Exécution par Agent
              </h3>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono tabular-nums">
              {totalAvantMs !== null && (
                <span className="surface-subtle text-sub px-2.5 py-0.5 rounded-lg">
                  AVANT :{' '}
                  <strong className="text-main">
                    {formatAgentTimingMs(totalAvantMs)}
                  </strong>
                </span>
              )}
              {totalApresMs !== null && (
                <span className="badge-success px-2.5 py-0.5 rounded-lg font-bold">
                  APRÈS : {formatAgentTimingMs(totalApresMs)}
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-2.5">
            {CANONICAL_AGENTS.map((ag, idx) => {
              const avMs = resolvedAvantTimings?.[ag.key];
              const apMs =
                resolvedApresTimings?.[ag.key] ??
                (!resolvedAvantTimings
                  ? resolvedFallbackTimings?.[ag.key]
                  : undefined);
              const primaryMs =
                typeof apMs === 'number'
                  ? apMs
                  : typeof avMs === 'number'
                  ? avMs
                  : null;
              const barPct =
                primaryMs !== null
                  ? Math.max(
                      6,
                      Math.min(100, Math.round((primaryMs / maxObservedAgentMs) * 100))
                    )
                  : 0;

              return (
                <div
                  key={ag.key}
                  className="surface-card rounded-xl p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-extrabold text-main truncate">
                      0{idx + 1}. {ag.label}
                    </span>
                    <span className="font-mono text-xs font-extrabold text-accent tabular-nums shrink-0">
                      {formatAgentTimingMs(primaryMs)}
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full surface-subtle overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[#86BC25] transition-all duration-300"
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                  {typeof avMs === 'number' && typeof apMs === 'number' && (
                    <div className="flex items-center justify-between text-[10px] font-mono text-sub tabular-nums">
                      <span>AV: {formatAgentTimingMs(avMs)}</span>
                      <span>AP: {formatAgentTimingMs(apMs)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* LIGNE 2 : LISTE CONDENSÉE PAR CONSTAT + ACCORDÉON « DÉTAILS » */}
      <div className="surface-panel rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-hairline">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm sm:text-base font-extrabold text-main">
              Matrice Différentielle ({filteredItems.length}/{summary.items.length})
            </h2>
            {diffSource === 'server' && (
              <span className="badge-success inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold">
                <ShieldCheck className="w-3 h-3" />
                /api/audit/diff
                {serverDiff?.chain?.valide
                  ? ` • ${serverDiff.chain.nb_entrees} blocs`
                  : ''}
              </span>
            )}
            {diffSource === 'loading' && (
              <span className="surface-subtle text-sub inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono">
                <RefreshCw className="w-3 h-3 animate-spin" />
                Sync…
              </span>
            )}
            {diffSource === 'local' && (
              <span className="surface-subtle text-sub inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono">
                Diff local
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ['ALL', `Tous (${summary.items.length})`],
                ['dit_contradiction', `Dit (${summary.ditContradictionsCount})`],
                ['confirmed_gap', `Confirmés (${summary.confirmedGapsCount})`],
                ['new_gap', `Nouveaux (${summary.newGapsCount})`],
                [
                  'resolved_or_compliant',
                  `Conformes (${summary.resolvedOrCompliantCount})`,
                ],
              ] as const
            ).map(([key, label]) => {
              const active = filter === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                    active
                      ? 'bg-[#86BC25] text-black'
                      : 'surface-card text-sub hover:text-main'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {filteredItems.length === 0 ? (
          <div className="py-8 text-center space-y-2">
            <p className="text-xs text-sub font-semibold">
              Aucun constat sur ce filtre.
            </p>
            <button
              type="button"
              onClick={() => setFilter('ALL')}
              className="text-xs font-bold text-accent hover:underline cursor-pointer"
            >
              Tout afficher ({summary.items.length})
            </button>
          </div>
        ) : (
          <div className="space-y-2.5">
            {filteredItems.map((item) => {
              const targetFinding = item.apres || item.avant;
              const avStatus = item.avant
                ? STATUT_LABELS[item.avant.statut] || STATUT_LABELS.a_confirmer
                : null;
              const apStatus = item.apres
                ? STATUT_LABELS[item.apres.statut] || STATUT_LABELS.a_confirmer
                : null;
              const roadmapMeta = targetFinding
                ? classifyFindingForRoadmap(targetFinding)
                : null;
              const isExpanded = Boolean(expandedKeys[item.key]);

              return (
                <div
                  key={item.key}
                  className="surface-card hover:border-strong rounded-2xl overflow-hidden transition"
                >
                  {/* Ligne condensée par défaut */}
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onClick={() => toggleItemDetails(item.key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleItemDetails(item.key);
                      }
                    }}
                    className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 cursor-pointer"
                  >
                    {/* Gauche : ID + Thème + Exigence */}
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="font-mono text-xs font-extrabold px-2 py-0.5 rounded bg-[#86BC25] text-black shrink-0">
                        {item.id}
                      </span>
                      <span className="text-sm font-extrabold text-main">
                        {item.theme}
                      </span>
                      <span className="text-xs font-mono text-dim hidden sm:inline">
                        {item.exigence_nis2}
                      </span>
                    </div>

                    {/* Droite : Évolution AVANT -> APRÈS, Charge j.h, Badges & Actions */}
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Évolution statut */}
                      <div className="inline-flex items-center gap-1 text-[10px] font-bold">
                        {avStatus ? (
                          <span className={`px-2 py-0.5 rounded-full ${avStatus.cls}`}>
                            {avStatus.label}
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full surface-subtle text-dim font-mono">
                            Absent
                          </span>
                        )}
                        <ArrowRight className="w-3 h-3 text-dim" />
                        {apStatus ? (
                          <span className={`px-2 py-0.5 rounded-full ${apStatus.cls}`}>
                            {apStatus.label}
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full badge-success">
                            Levé ✓
                          </span>
                        )}
                      </div>

                      {/* Charge j.h + Horizon */}
                      {roadmapMeta && targetFinding?.statut !== 'conforme' && (
                        <span className="px-2 py-0.5 rounded-full surface-subtle font-mono text-[10px] font-bold text-main tabular-nums">
                          {HORIZON_META[roadmapMeta.horizon].badge} •{' '}
                          {roadmapMeta.workloadEstimate}
                        </span>
                      )}

                      {/* Badge catégorie / contradiction */}
                      <span
                        className={`text-[10px] font-extrabold px-2.5 py-0.5 rounded-full ${
                          item.category === 'dit_contradiction'
                            ? 'badge-critical'
                            : item.category === 'new_gap'
                            ? 'badge-high'
                            : item.category === 'resolved_or_compliant'
                            ? 'badge-success'
                            : 'badge-warning'
                        }`}
                      >
                        {item.apres?.contradiction || item.categoryLabel}
                      </span>

                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg surface-subtle text-[11px] font-bold text-sub">
                        <span>Détails</span>
                        <ChevronDown
                          className={`w-3.5 h-3.5 transition-transform ${
                            isExpanded ? 'rotate-180 text-accent' : ''
                          }`}
                        />
                      </span>

                      {targetFinding && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectFinding(targetFinding);
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg surface-subtle hover:border-[#86BC25] text-xs font-bold text-accent transition cursor-pointer"
                        >
                          <span>Preuve</span>
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Accordéon « Détails » : Extraits Dit / Écrit / Réel, Recommandation & gcloud */}
                  {isExpanded && (
                    <div className="border-t border-hairline surface-subtle grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-[var(--border-subtle)]">
                      {/* Colonne Gauche : Phase 1 AVANT */}
                      <div className="lg:col-span-5 p-4 space-y-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-extrabold uppercase tracking-wider text-dim">
                            AVANT (Écrit × Réel)
                          </span>
                          {item.avant?.contradiction && (
                            <span className="badge-warning text-[10px] font-bold px-2 py-0.5 rounded">
                              {item.avant.contradiction}
                            </span>
                          )}
                        </div>

                        {item.avant ? (
                          <div className="space-y-1.5">
                            {item.avant.ecrit && (
                              <p className="text-sub leading-relaxed">
                                <FileText className="w-3 h-3 inline mr-1 tone-violet" />
                                <strong className="text-main">Écrit :</strong> «{' '}
                                {item.avant.ecrit.extrait} »
                              </p>
                            )}
                            {item.avant.reel && (
                              <p className="text-main font-medium leading-relaxed">
                                <Server className="w-3 h-3 inline mr-1 text-accent" />
                                <strong>Réel :</strong> {item.avant.reel.constat}
                              </p>
                            )}
                          </div>
                        ) : (
                          <p className="text-dim italic">
                            Non détectable avant audition DSI.
                          </p>
                        )}
                      </div>

                      {/* Colonne Droite : Phase 2 APRÈS */}
                      <div className="lg:col-span-7 p-4 space-y-2.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-extrabold uppercase tracking-wider text-accent">
                            APRÈS (Dit × Écrit × Réel)
                          </span>
                          {item.apres?.contradiction && (
                            <span className="badge-critical text-[10px] font-extrabold px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                              <Zap className="w-3 h-3" />
                              {item.apres.contradiction}
                            </span>
                          )}
                        </div>

                        {item.apres ? (
                          <div className="space-y-2">
                            {item.apres.dit && (
                              <div className="p-2.5 rounded-xl badge-info flex items-start justify-between gap-3">
                                <div>
                                  <div className="text-[10px] font-extrabold uppercase tracking-wider mb-0.5 flex items-center gap-1">
                                    <MessageSquareQuote className="w-3 h-3" />
                                    Déclaration DSI (Dit)
                                  </div>
                                  <p className="text-main italic font-medium">
                                    « {item.apres.dit.extrait} »
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenQuoteInDoc(
                                      item.apres!.dit!.source,
                                      item.apres!.dit!.extrait
                                    );
                                  }}
                                  className="text-[10px] font-mono underline shrink-0 cursor-pointer"
                                >
                                  Source
                                </button>
                              </div>
                            )}

                            <p className="text-sub leading-relaxed">
                              <strong className="text-main">Action :</strong>{' '}
                              {item.apres.recommandation}
                            </p>

                            {item.apres.commande_correction && (
                              <div className="rounded-lg surface-card border border-hairline p-2 space-y-1">
                                <div className="text-[10px] font-mono font-bold text-accent inline-flex items-center gap-1">
                                  <Terminal className="w-3 h-3" />
                                  Correctif gcloud (Dry-Run)
                                </div>
                                <pre className="font-mono text-[10px] text-main overflow-x-auto">
                                  {item.apres.commande_correction}
                                </pre>
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="tone-success font-medium">
                            Point levé en post-entretien.
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* LIGNE 3 : TRAME DE QUESTIONS PHASE AVANT EN ACCORDÉON COMPACT */}
      {avantSynthesis.questions_entretien?.length > 0 && (
        <div className="surface-panel rounded-2xl overflow-hidden">
          <button
            type="button"
            aria-expanded={questionsOpen}
            onClick={() => setQuestionsOpen((prev) => !prev)}
            className="w-full px-5 py-3.5 flex items-center justify-between gap-3 hover:bg-[var(--bg-hover)] transition cursor-pointer"
          >
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg badge-warning flex items-center justify-center shrink-0">
                <MessageCircleQuestion className="w-4 h-4" />
              </div>
              <span className="text-xs sm:text-sm font-extrabold text-main">
                Questions d&apos;audition Phase AVANT (
                {avantSynthesis.questions_entretien.length})
              </span>
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-sub">
              <span>{questionsOpen ? 'Masquer' : 'Afficher'}</span>
              <ChevronDown
                className={`w-4 h-4 transition-transform ${
                  questionsOpen ? 'rotate-180 text-accent' : ''
                }`}
              />
            </span>
          </button>

          {questionsOpen && (
            <div className="p-4 pt-3 border-t border-hairline grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {avantSynthesis.questions_entretien.map((q, idx) => (
                <div
                  key={idx}
                  className="surface-card rounded-xl p-3 flex items-start gap-2.5 text-xs"
                >
                  <span className="px-2 py-0.5 rounded font-mono font-bold text-[10px] badge-warning shrink-0 mt-0.5">
                    Q{idx + 1}
                  </span>
                  <p className="text-main leading-relaxed">{q}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
};
