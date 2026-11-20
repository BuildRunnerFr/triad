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
        className="max-w-4xl space-y-6 pt-1"
      >
        <div className="pb-6 border-b border-hairline">
          <h2 className="text-[1.75rem] sm:text-[2.35rem] leading-[1.12] font-semibold tracking-[-0.025em] text-main">
            Mesurer ce que les entretiens ont changé.
          </h2>
          <p className="mt-3 max-w-2xl text-sm text-sub leading-relaxed">
            La phase AVANT confronte l&apos;Écrit au Réel ; la phase APRÈS y ajoute le Dit des entretiens. Une fois les
            deux synthèses prêtes, le comparateur montre les déclarations démenties, les écarts confirmés et
            l&apos;évolution de la maturité, constat par constat.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-main">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[var(--ecrit)]" aria-hidden="true" />Écrit ×
              <span className="w-2 h-2 rounded-full bg-[var(--reel)]" aria-hidden="true" />Réel
            </span>
            <span className="text-sub">→</span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[var(--dit)]" aria-hidden="true" />Dit ×
              <span className="w-2 h-2 rounded-full bg-[var(--ecrit)]" aria-hidden="true" />Écrit ×
              <span className="w-2 h-2 rounded-full bg-[var(--reel)]" aria-hidden="true" />Réel
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div
            className={`rounded-xl p-4 border flex items-center justify-between gap-2 ${
              avantSynthesis ? 'border-[var(--accent-border)] bg-[var(--accent-soft)]' : 'border-hairline bg-[var(--bg-surface)]'
            }`}
          >
            <div>
              <div className="text-sm font-semibold text-main">Phase AVANT</div>
              <div className="text-xs text-sub mt-0.5">
                {avantSynthesis
                  ? `${avantSynthesis.findings.length} constats • ${avantSynthesis.questions_entretien.length} questions`
                  : 'En attente'}
              </div>
            </div>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full surface-subtle text-main">
              {avantSynthesis ? 'Prête' : 'À lancer'}
            </span>
          </div>

          <div
            className={`rounded-xl p-4 border flex items-center justify-between gap-2 ${
              apresSynthesis ? 'border-[var(--accent-border)] bg-[var(--accent-soft)]' : 'border-hairline bg-[var(--bg-surface)]'
            }`}
          >
            <div>
              <div className="text-sm font-semibold text-main">Phase APRÈS</div>
              <div className="text-xs text-sub mt-0.5">
                {apresSynthesis
                  ? `${apresSynthesis.findings.length} constats triangulés`
                  : 'En attente'}
              </div>
            </div>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full surface-subtle text-main">
              {apresSynthesis ? 'Prête' : 'À lancer'}
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
              className="inline-flex items-center gap-2 bg-[var(--deloitte)] hover:bg-[var(--deloitte-hover)] disabled:opacity-50 text-black font-extrabold text-xs px-5 py-2.5 rounded-xl transition cursor-pointer"
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
              className="inline-flex items-center gap-2 bg-[var(--deloitte)] hover:bg-[var(--deloitte-hover)] disabled:opacity-50 text-black font-extrabold text-xs px-5 py-2.5 rounded-xl transition cursor-pointer"
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
      {/* CHIFFRE-TITRE : ce que les entretiens ont changé, en une phrase */}
      <section aria-labelledby="compare-lede" className="pt-1 pb-6 border-b border-hairline">
        <p className="text-sm text-sub">
          Comparaison des deux phases · {serverDiff?.counts?.findings_avant ?? avantSynthesis.findings.length} constats
          AVANT, {serverDiff?.counts?.findings_apres ?? apresSynthesis.findings.length} APRÈS
        </p>
        <h2
          id="compare-lede"
          className="mt-2 max-w-4xl text-[1.75rem] sm:text-[2.35rem] leading-[1.12] font-semibold tracking-[-0.025em] text-main"
        >
          Les entretiens ont fait apparaître{' '}
          <span className="text-[var(--rupture)] font-bold tabular-nums">{summary.ditContradictionsCount}</span>{' '}
          déclaration{summary.ditContradictionsCount > 1 ? 's' : ''} de la DSI démentie
          {summary.ditContradictionsCount > 1 ? 's' : ''} par les faits ; la maturité passe de{' '}
          <span className="tabular-nums">{summary.scoreAvant} %</span> à{' '}
          <span className={`tabular-nums font-bold ${summary.scoreDelta < 0 ? 'text-[var(--rupture)]' : 'text-[var(--accent-text)]'}`}>
            {summary.scoreApres} %
          </span>
          .
        </h2>

        <dl className="mt-6 grid grid-cols-2 lg:grid-cols-4 border-t border-hairline">
          {[
            {
              label: 'Évolution de la maturité',
              value: `${summary.scoreDelta > 0 ? '+' : ''}${summary.scoreDelta} pts`,
              tone: summary.scoreDelta < 0 ? 'text-[var(--rupture)]' : 'text-[var(--accent-text)]',
            },
            {
              label: 'Écarts confirmés',
              value: `${summary.confirmedGapsCount}${summary.newGapsCount > 0 ? ` (+${summary.newGapsCount} nouveau${summary.newGapsCount > 1 ? 'x' : ''})` : ''}`,
              tone: undefined,
            },
            {
              label: 'Effort de remédiation',
              value: fullPlanWorkload
                ? `${fullPlanWorkload.workload_jh.estimated_jh.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} j·h`
                : '—',
              tone: undefined,
              note: fullPlanWorkload
                ? `entre ${fullPlanWorkload.workload_jh.min_jh.toLocaleString('fr-FR')} et ${fullPlanWorkload.workload_jh.max_jh.toLocaleString('fr-FR')} j·h${fullPlanWorkload.workload_jh.quick_wins_count > 0 ? `, ${fullPlanWorkload.workload_jh.quick_wins_count} gains rapides` : ''}`
                : undefined,
            },
            {
              label: 'Exposition aux sanctions (Art. 34)',
              value: fullPlanWorkload ? `Risque ${fullPlanWorkload.art34_exposure.risk_level_before.toLowerCase()}` : '—',
              tone:
                fullPlanWorkload?.art34_exposure.risk_level_before === 'CRITIQUE'
                  ? 'text-[var(--rupture)]'
                  : undefined,
              note: 'jusqu’à 10 M€ ou 2 % du CA mondial',
            },
          ].map((fact, i) => (
            <div
              key={fact.label}
              className={`pt-3 pb-1 pr-4 ${i > 0 ? 'pl-4 border-l border-hairline' : ''} ${i === 2 ? 'max-lg:border-l-0 max-lg:pl-0' : ''}`}
            >
              <dt className="text-xs text-sub">{fact.label}</dt>
              <dd className={`mt-1 text-xl font-semibold tabular-nums ${fact.tone || 'text-main'}`}>{fact.value}</dd>
              {fact.note && <dd className="text-xs text-sub mt-0.5">{fact.note}</dd>}
            </div>
          ))}
        </dl>

        {showAgentTimings && (
          <p className="mt-4 text-xs text-sub tabular-nums">
            Exécution de la chaîne d&apos;agents :{' '}
            {totalAvantMs !== null && <>AVANT {formatAgentTimingMs(totalAvantMs)}</>}
            {totalAvantMs !== null && totalApresMs !== null && ' · '}
            {totalApresMs !== null && <>APRÈS {formatAgentTimingMs(totalApresMs)}</>}
          </p>
        )}
      </section>

      {/* LIGNE 2 : LISTE CONDENSÉE PAR CONSTAT + ACCORDÉON « DÉTAILS » */}
      <div className="surface-panel rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-hairline">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-main">
              Évolution constat par constat{' '}
              <span className="text-sub font-normal tabular-nums">
                ({filteredItems.length} / {summary.items.length})
              </span>
            </h3>
            {diffSource === 'server' && (
              <span className="inline-flex items-center gap-1 text-xs text-sub">
                <ShieldCheck className="w-3 h-3" />
                Calculé sur le registre scellé
                {serverDiff?.chain?.valide ? ` (${serverDiff.chain.nb_entrees} entrées)` : ''}
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
                      ? 'seg-active'
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
          <div className="-mx-4 sm:-mx-5 divide-y divide-[var(--border-subtle)] border-t border-hairline">
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
                  className="overflow-hidden"
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
                    className="px-4 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-3 cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    {/* Gauche : ID + Thème + Exigence */}
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="font-mono text-xs text-sub shrink-0 w-12">
                        {item.id}
                      </span>
                      <span className="text-sm font-semibold text-main">
                        {item.theme}
                      </span>
                      <span className="text-xs text-sub hidden sm:inline">
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
                            Levé
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
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg surface-subtle hover:border-[var(--deloitte)] text-xs font-bold text-accent transition cursor-pointer"
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
                          <span className="text-xs font-semibold text-sub">
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
                          <span className="text-xs font-semibold text-sub text-accent">
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
                                  <div className="text-xs font-semibold text-sub mb-0.5 flex items-center gap-1">
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
