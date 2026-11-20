import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BookCheck,
  ShieldCheck,
  ArrowUpRight,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Network,
  HeartPulse,
  GitCompare,
} from 'lucide-react';
import type { AuditMode, Finding, SanitizedDocument } from '../types';
import { apiFetch } from '../api';
import {
  COVERAGE_STATUS_META,
  VERIFICATION_TYPE_LABELS,
  computeLocalNis2Coverage,
  normalizeServerNis2Coverage,
  type Nis2CoverageReport,
  type Nis2RequirementCoverageItem,
} from '../utils/nis2Coverage';

const loadNis2SupplyChainCard = () =>
  import('./Nis2SupplyChainCard').then((m) => ({
    default: m.Nis2SupplyChainCard,
  }));
const loadNis2ContinuityCard = () =>
  import('./Nis2ContinuityCard').then((m) => ({
    default: m.Nis2ContinuityCard,
  }));
const loadNis2CrosswalkCard = () =>
  import('./Nis2CrosswalkCard').then((m) => ({
    default: m.Nis2CrosswalkCard,
  }));

const LazyNis2SupplyChainCard = lazy(loadNis2SupplyChainCard);
const LazyNis2ContinuityCard = lazy(loadNis2ContinuityCard);
const LazyNis2CrosswalkCard = lazy(loadNis2CrosswalkCard);

const SubCardSkeleton: React.FC = () => (
  <div
    role="status"
    aria-label="Chargement du module de conformité"
    className="space-y-3 animate-pulse py-1"
  >
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div className="surface-card rounded-xl h-20" />
      <div className="surface-card rounded-xl h-20" />
      <div className="surface-card rounded-xl h-20" />
      <div className="surface-card rounded-xl h-20" />
    </div>
    <div className="surface-card rounded-xl h-48" />
  </div>
);

interface Nis2CoverageMatrixProps {
  mode: AuditMode;
  sessionId?: string;
  findings: Finding[];
  docs?: SanitizedDocument[];
  onInspectFindingInExplorer: (finding: Finding) => void;
}

type CoverageSubTab = 'coverage' | 'vendors' | 'continuity' | 'crosswalk';
type CoverageFilter = 'ALL' | 'GAPS' | 'COMPLIANT' | 'UNCOVERED';

const SHORT_TITLES_BY_ID: Record<string, string> = {
  'NIS2-21-2-A': 'Analyse des risques & PSSI',
  'NIS2-21-2-B': 'Détection & réponse incidents',
  'NIS2-21-2-C': 'Continuité PCA/PRA & sauvegardes',
  'NIS2-21-2-D': "Chaîne d'approvisionnement & tiers",
  'NIS2-21-2-E': 'Vulnérabilités & maintenance',
  'NIS2-21-2-F': "Évaluation d'efficacité cyber",
  'NIS2-21-2-G': 'Hygiène cyber & formation',
  'NIS2-21-2-H': 'Cryptographie & chiffrement KMS',
  'NIS2-21-2-I': "Contrôle d'accès & exposition",
  'NIS2-21-2-J': 'Authentification MFA & flux',
  'NIS2-23': 'Notification ANSSI (24h / 72h / 1m)',
};

function getShortRequirementTitle(item: Nis2RequirementCoverageItem): string {
  const mapped = SHORT_TITLES_BY_ID[item.id.toUpperCase()];
  if (mapped) return mapped;
  const raw = item.intitule_resume.trim();
  if (raw.length <= 46) return raw;
  return `${raw.slice(0, 44).trimEnd()}…`;
}

const SUB_TABS: ReadonlyArray<{
  key: CoverageSubTab;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { key: 'coverage', label: 'Couverture NIS2', Icon: BookCheck },
  { key: 'vendors', label: 'Prestataires', Icon: Network },
  { key: 'continuity', label: 'Continuité RTO/RPO', Icon: HeartPulse },
  { key: 'crosswalk', label: 'Référentiels HDS/ISO/RGPD', Icon: GitCompare },
];

export const Nis2CoverageMatrix: React.FC<Nis2CoverageMatrixProps> = ({
  mode,
  sessionId,
  findings,
  docs = [],
  onInspectFindingInExplorer,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<CoverageSubTab>('coverage');
  const [filter, setFilter] = useState<CoverageFilter>('ALL');
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [serverReport, setServerReport] = useState<Nis2CoverageReport | null>(
    null
  );
  const [syncState, setSyncState] = useState<'loading' | 'synced' | 'fallback'>(
    'loading'
  );
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const localReport = useMemo(
    () => computeLocalNis2Coverage(findings, mode),
    [findings, mode]
  );

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setSyncState('loading');

    apiFetch(`/api/nis2/coverage?mode=${mode}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: unknown = await res.json();
        if (cancelled) return;
        const normalized = normalizeServerNis2Coverage(json, mode);
        if (normalized) {
          setServerReport(normalized);
          setSyncState('synced');
        } else {
          setServerReport(null);
          setSyncState('fallback');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setServerReport(null);
          setSyncState('fallback');
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [mode, findings, sessionId]);

  const report = serverReport || localReport;

  const findingsById = useMemo(() => {
    const map = new Map<string, Finding>();
    for (const f of findings) {
      map.set(f.id.toUpperCase(), f);
    }
    return map;
  }, [findings]);

  const partielsCount = report.counts.partiel + report.counts.a_confirmer;
  const gapsCount = report.counts.non_conforme + partielsCount;

  const filteredItems = useMemo(() => {
    return report.items.filter((it) => {
      if (filter === 'ALL') return true;
      if (filter === 'GAPS') {
        return (
          it.statut === 'non_conforme' ||
          it.statut === 'partiel' ||
          it.statut === 'a_confirmer'
        );
      }
      if (filter === 'COMPLIANT') return it.statut === 'conforme';
      if (filter === 'UNCOVERED') return it.statut === 'non_couvert';
      return true;
    });
  }, [report.items, filter]);

  const toggleRow = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const preloadSubTabChunk = useCallback((key: CoverageSubTab) => {
    if (key === 'vendors') {
      void loadNis2SupplyChainCard();
    } else if (key === 'continuity') {
      void loadNis2ContinuityCard();
    } else if (key === 'crosswalk') {
      void loadNis2CrosswalkCard();
    }
  }, []);

  const handleTabKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    idx: number
  ) => {
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % SUB_TABS.length;
    else if (e.key === 'ArrowLeft')
      nextIdx = (idx - 1 + SUB_TABS.length) % SUB_TABS.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = SUB_TABS.length - 1;

    if (nextIdx !== null) {
      e.preventDefault();
      const nextKey = SUB_TABS[nextIdx].key;
      preloadSubTabChunk(nextKey);
      setActiveSubTab(nextKey);
      tabRefs.current[nextIdx]?.focus();
    }
  };

  return (
    <div className="surface-panel rounded-2xl p-5 space-y-5">
      {/* Barre de sous-onglets épurée avec préchargement au survol/focus */}
      <div
        role="tablist"
        aria-label="Sous-onglets de conformité réglementaire"
        className="flex flex-wrap items-center gap-1.5 p-1 rounded-xl surface-subtle"
      >
        {SUB_TABS.map((tab, idx) => {
          const isActive = activeSubTab === tab.key;
          const Icon = tab.Icon;
          return (
            <button
              key={tab.key}
              ref={(el) => {
                tabRefs.current[idx] = el;
              }}
              id={`nis2-subtab-${tab.key}`}
              role="tab"
              type="button"
              aria-selected={isActive}
              aria-controls={`nis2-subpanel-${tab.key}`}
              tabIndex={isActive ? 0 : -1}
              onMouseEnter={() => preloadSubTabChunk(tab.key)}
              onFocus={() => preloadSubTabChunk(tab.key)}
              onClick={() => setActiveSubTab(tab.key)}
              onKeyDown={(e) => handleTabKeyDown(e, idx)}
              className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-extrabold transition cursor-pointer ${
                isActive
                  ? 'seg-active'
                  : 'text-sub hover:text-main'
              }`}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span>{tab.label}</span>
              {tab.key === 'coverage' && (
                <span
                  className={`font-mono text-[10px] px-1.5 py-0.2 rounded-full tabular-nums ${
                    isActive
                      ? 'bg-black/15 text-black'
                      : 'surface-card text-sub'
                  }`}
                >
                  {report.coverageRatePct}%
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Panneau actif uniquement */}
      {activeSubTab === 'coverage' && (
        <div
          id="nis2-subpanel-coverage"
          role="tabpanel"
          aria-labelledby="nis2-subtab-coverage"
          className="space-y-4"
        >
          {/* En-tête court */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3 className="text-sm sm:text-base font-extrabold text-main">
                Couverture NIS2 — Art. 21 &amp; 23
              </h3>
              <span className="font-mono text-[10px] font-bold px-2 py-0.5 rounded-full surface-subtle text-sub tabular-nums">
                {report.totalRequirements} exigences • {mode}
              </span>
            </div>

            {syncState === 'synced' && (
              <span className="badge-success inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold">
                <ShieldCheck className="w-3 h-3" />
                <span>API synchronisée</span>
              </span>
            )}
            {syncState === 'loading' && (
              <span className="surface-subtle text-sub inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-mono">
                <RefreshCw className="w-3 h-3 animate-spin" />
                <span>Sync…</span>
              </span>
            )}
          </div>

          {/* Barre KPI compacte aérée */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="surface-card rounded-xl p-3.5 space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-sub">
                  Exigences évaluées
                </span>
                <span className="text-[11px] text-sub tabular-nums">
                  {report.coveredCount}/{report.totalRequirements}
                </span>
              </div>
              <div
                className="text-xl font-extrabold text-main tabular-nums"
                title="Part des exigences NIS2 rattachées à au moins un constat (évaluées, pas forcément conformes)"
              >
                {report.coverageRatePct}%
              </div>
              <div className="h-1.5 w-full rounded-full surface-subtle overflow-hidden">
                <div
                  className="h-full rounded-full bg-[var(--text-secondary)] opacity-60 transition-all duration-300"
                  style={{
                    width: `${Math.min(100, Math.max(4, report.coverageRatePct))}%`,
                  }}
                />
              </div>
            </div>

            <div className="surface-card rounded-xl p-3.5 space-y-1">
              <div className="text-xs font-semibold text-sub">
                Conformes
              </div>
              <div className="text-xl font-extrabold font-mono tone-success tabular-nums">
                {report.counts.conforme}
              </div>
              <div className="text-[11px] text-sub">Validées par preuve</div>
            </div>

            <div className="surface-card rounded-xl p-3.5 space-y-1">
              <div className="text-xs font-semibold text-sub">
                Partiels
              </div>
              <div className="text-xl font-extrabold font-mono tone-warning tabular-nums">
                {partielsCount}
              </div>
              <div className="text-[11px] text-sub tabular-nums">
                dont {report.counts.a_confirmer} à confirmer
              </div>
            </div>

            <div className="surface-card rounded-xl p-3.5 space-y-1">
              <div className="text-xs font-semibold text-sub">
                Écarts
              </div>
              <div className="text-xl font-extrabold font-mono tone-critical tabular-nums">
                {gapsCount}
              </div>
              <div className="text-[11px] text-sub tabular-nums">
                {report.counts.non_conforme} non conforme(s)
              </div>
            </div>
          </div>

          {/* Filtres rapides */}
          <div
            role="group"
            aria-label="Filtrer les exigences NIS2"
            className="flex flex-wrap items-center gap-1.5"
          >
            {(
              [
                ['ALL', `Toutes (${report.items.length})`],
                ['GAPS', `Écarts (${gapsCount})`],
                ['COMPLIANT', `Conformes (${report.counts.conforme})`],
                ['UNCOVERED', `À couvrir (${report.counts.non_couvert})`],
              ] as const
            ).map(([key, label]) => {
              const active = filter === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(key)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer tabular-nums ${
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

          {/* Table condensée avec accordéon par ligne */}
          {filteredItems.length === 0 ? (
            <div className="py-6 text-center surface-card rounded-xl space-y-2">
              <p className="text-xs text-sub font-semibold">
                Aucune exigence dans ce filtre ({mode}).
              </p>
              <button
                type="button"
                onClick={() => setFilter('ALL')}
                className="text-xs font-bold text-accent hover:underline cursor-pointer"
              >
                Afficher tout ({report.items.length})
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-hairline">
              <table className="w-full text-left text-xs">
                <thead className="surface-subtle text-[10px] uppercase tracking-wider text-sub border-b border-hairline">
                  <tr>
                    <th className="py-2.5 px-3 whitespace-nowrap">Article</th>
                    <th className="py-2.5 px-3">Intitulé</th>
                    <th className="py-2.5 px-3 whitespace-nowrap">Statut</th>
                    <th className="py-2.5 px-3 whitespace-nowrap text-right">
                      Constats
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {filteredItems.map((item) => {
                    const statusMeta = COVERAGE_STATUS_META[item.statut];
                    const isExpanded = Boolean(expandedIds[item.id]);
                    const shortTitle = getShortRequirementTitle(item);

                    return (
                      <React.Fragment key={item.id}>
                        <tr
                          onClick={() => toggleRow(item.id)}
                          className="row-interactive cursor-pointer"
                        >
                          <td className="py-2.5 px-3 align-middle whitespace-nowrap">
                            <button
                              type="button"
                              aria-expanded={isExpanded}
                              aria-label={`Détails ${item.article}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleRow(item.id);
                              }}
                              className="inline-flex items-center gap-1.5 font-mono font-extrabold text-main text-xs cursor-pointer"
                            >
                              {isExpanded ? (
                                <ChevronDown className="w-3.5 h-3.5 text-accent shrink-0" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5 text-dim shrink-0" />
                              )}
                              <span>{item.article}</span>
                            </button>
                          </td>

                          <td className="py-2.5 px-3 align-middle">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-bold text-main">
                                {shortTitle}
                              </span>
                              <span className="hidden sm:inline-block text-[10px] px-2 py-0.5 rounded surface-subtle text-dim">
                                {item.theme}
                              </span>
                            </div>
                          </td>

                          <td className="py-2.5 px-3 align-middle whitespace-nowrap">
                            <span
                              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold ${statusMeta.badgeCls}`}
                            >
                              {statusMeta.shortLabel}
                            </span>
                          </td>

                          <td className="py-2.5 px-3 align-middle text-right whitespace-nowrap">
                            {item.finding_ids.length === 0 ? (
                              <span className="text-[11px] font-mono text-dim">
                                —
                              </span>
                            ) : (
                              <div className="inline-flex flex-wrap justify-end gap-1.5">
                                {item.finding_ids.map((fid) => {
                                  const target = findingsById.get(
                                    fid.toUpperCase()
                                  );
                                  return (
                                    <button
                                      key={fid}
                                      type="button"
                                      disabled={!target}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (target) {
                                          onInspectFindingInExplorer(target);
                                        }
                                      }}
                                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md surface-subtle border border-hairline hover:border-strong disabled:opacity-60 text-main font-mono text-[11px] font-bold transition cursor-pointer"
                                    >
                                      <span>{fid}</span>
                                      <ArrowUpRight className="w-2.5 h-2.5" />
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr className="surface-subtle">
                            <td
                              colSpan={4}
                              className="px-4 py-3 border-l-4 border-l-[var(--deloitte)]"
                            >
                              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                                <div className="space-y-1">
                                  <div className="text-[10px] font-mono font-bold text-dim">
                                    {item.id} • Domaine : {item.theme}
                                  </div>
                                  <p className="text-xs text-main leading-relaxed">
                                    {item.intitule_resume}
                                  </p>
                                </div>

                                <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                                  {item.type_verification.map((tv) => (
                                    <span
                                      key={tv}
                                      className="px-2 py-0.5 rounded surface-card text-[10px] font-mono text-sub"
                                    >
                                      {VERIFICATION_TYPE_LABELS[tv] || tv}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeSubTab === 'vendors' && (
        <div
          id="nis2-subpanel-vendors"
          role="tabpanel"
          aria-labelledby="nis2-subtab-vendors"
        >
          <Suspense fallback={<SubCardSkeleton />}>
            <LazyNis2SupplyChainCard
              mode={mode}
              sessionId={sessionId}
              findings={findings}
              docs={docs}
              onInspectFindingInExplorer={onInspectFindingInExplorer}
            />
          </Suspense>
        </div>
      )}

      {activeSubTab === 'continuity' && (
        <div
          id="nis2-subpanel-continuity"
          role="tabpanel"
          aria-labelledby="nis2-subtab-continuity"
        >
          <Suspense fallback={<SubCardSkeleton />}>
            <LazyNis2ContinuityCard
              mode={mode}
              sessionId={sessionId}
              findings={findings}
              onInspectFindingInExplorer={onInspectFindingInExplorer}
            />
          </Suspense>
        </div>
      )}

      {activeSubTab === 'crosswalk' && (
        <div
          id="nis2-subpanel-crosswalk"
          role="tabpanel"
          aria-labelledby="nis2-subtab-crosswalk"
        >
          <Suspense fallback={<SubCardSkeleton />}>
            <LazyNis2CrosswalkCard
              mode={mode}
              sessionId={sessionId}
              findings={findings}
              onInspectFindingInExplorer={onInspectFindingInExplorer}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
};
