import React, { useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  ArrowUpRight,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type {
  AuditMode,
  CrosswalkFrameworkKey,
  CrosswalkReport,
  Finding,
} from '../types';
import { apiFetch } from '../api';
import {
  computeLocalCrosswalkFallback,
  CROSSWALK_STATUS_META,
  FRAMEWORK_LABELS,
  normalizeServerCrosswalkReport,
} from '../utils/crosswalk';

interface Nis2CrosswalkCardProps {
  mode: AuditMode;
  sessionId?: string;
  findings: Finding[];
  onInspectFindingInExplorer: (finding: Finding) => void;
}

type FrameworkFilter = 'ALL' | CrosswalkFrameworkKey;
type StatusFilter = 'ALL' | 'GAPS' | 'COMPLIANT';

export const Nis2CrosswalkCard: React.FC<Nis2CrosswalkCardProps> = ({
  mode,
  sessionId,
  findings,
  onInspectFindingInExplorer,
}) => {
  const [serverReport, setServerReport] = useState<CrosswalkReport | null>(
    null
  );
  const [syncState, setSyncState] = useState<'loading' | 'synced' | 'fallback'>(
    'loading'
  );
  const [frameworkFilter, setFrameworkFilter] =
    useState<FrameworkFilter>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  const localFallback = useMemo(
    () => computeLocalCrosswalkFallback(findings, mode),
    [findings, mode]
  );

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setSyncState('loading');

    apiFetch(`/api/nis2/crosswalk?mode=${encodeURIComponent(mode)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: unknown = await res.json();
        if (cancelled) return;
        const normalized = normalizeServerCrosswalkReport(json, mode);
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

  const report = serverReport || localFallback;

  const findingsById = useMemo(() => {
    const map = new Map<string, Finding>();
    for (const f of findings) {
      map.set(f.id.toUpperCase(), f);
    }
    return map;
  }, [findings]);

  const filteredEntries = useMemo(() => {
    return [...report.entries]
      .filter((entry) => {
        if (
          frameworkFilter !== 'ALL' &&
          !entry.frameworks.includes(frameworkFilter)
        ) {
          return false;
        }
        if (statusFilter === 'GAPS' && entry.statut === 'conforme') {
          return false;
        }
        if (statusFilter === 'COMPLIANT' && entry.statut !== 'conforme') {
          return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          CROSSWALK_STATUS_META[b.statut].rank -
          CROSSWALK_STATUS_META[a.statut].rank
      );
  }, [report.entries, frameworkFilter, statusFilter]);

  const toggleRow = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const visibleColsCount =
    3 +
    (frameworkFilter === 'ALL' ? 3 : 1);

  return (
    <section
      aria-label="Concordance HDS, ISO 27001 et RGPD"
      className="space-y-4"
    >
      {/* En-tête court */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <h4 className="text-sm sm:text-base font-extrabold text-main">
            Référentiels HDS • ISO 27001 • RGPD
          </h4>
          <span className="font-mono text-[10px] font-bold px-2 py-0.5 rounded-full surface-subtle text-sub tabular-nums">
            {report.summary_counts.total} correspondances
          </span>
        </div>

        <div className="flex items-center gap-2">
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
      </div>

      {/* 4 tuiles KPI chiffrées aérées (3 référentiels cliquables + écarts actifs) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {(['HDS', 'ISO27001', 'RGPD'] as const).map((fw) => {
          const sum = report.frameworks_summary[fw];
          const isSelected = frameworkFilter === fw;
          return (
            <button
              key={fw}
              type="button"
              aria-pressed={isSelected}
              onClick={() =>
                setFrameworkFilter((prev) => (prev === fw ? 'ALL' : fw))
              }
              className={`text-left p-3.5 rounded-xl border transition cursor-pointer space-y-1 ${
                isSelected
                  ? 'border-[var(--deloitte)] bg-[var(--deloitte)]/15'
                  : 'surface-card border-hairline hover:border-strong'
              }`}
            >
              <div className="text-[10px] font-extrabold uppercase tracking-wider text-accent">
                {FRAMEWORK_LABELS[fw].short}
              </div>
              <div className="text-xl font-extrabold font-mono text-main tabular-nums">
                {sum.conformity_pct}%
              </div>
              <div className="text-[11px] text-sub tabular-nums">
                {sum.gap_count} écart(s) / {sum.total_controls}
              </div>
            </button>
          );
        })}

        <div className="surface-card rounded-xl p-3.5 space-y-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-dim">
            Écarts actifs
          </div>
          <div
            className={`text-xl font-extrabold font-mono tabular-nums ${
              report.summary_counts.gaps > 0 ? 'tone-critical' : 'tone-success'
            }`}
          >
            {report.summary_counts.gaps}/{report.summary_counts.total}
          </div>
          <div className="text-[11px] text-sub tabular-nums">
            {report.summary_counts.conforme} conforme(s)
          </div>
        </div>
      </div>

      {/* Filtres compacts */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label="Filtrer par référentiel"
          className="flex flex-wrap items-center gap-1.5"
        >
          {(
            [
              ['ALL', `Tous (${report.entries.length})`],
              ['HDS', `HDS (${report.frameworks_summary.HDS.total_controls})`],
              [
                'ISO27001',
                `ISO 27001 (${report.frameworks_summary.ISO27001.total_controls})`,
              ],
              [
                'RGPD',
                `RGPD (${report.frameworks_summary.RGPD.total_controls})`,
              ],
            ] as const
          ).map(([key, label]) => {
            const active = frameworkFilter === key;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() => setFrameworkFilter(key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer tabular-nums ${
                  active
                    ? 'bg-[var(--deloitte)] text-black'
                    : 'surface-card text-sub hover:text-main'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div
          role="group"
          aria-label="Filtrer par statut"
          className="flex flex-wrap items-center gap-1.5"
        >
          {(
            [
              ['ALL', 'Tous statuts'],
              ['GAPS', `Écarts (${report.summary_counts.gaps})`],
              ['COMPLIANT', `Conformes (${report.summary_counts.conforme})`],
            ] as const
          ).map(([key, label]) => {
            const active = statusFilter === key;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() => setStatusFilter(key)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer tabular-nums ${
                  active
                    ? 'bg-[var(--deloitte)] text-black'
                    : 'surface-subtle text-sub hover:text-main'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Table épurée avec accordéon Détails par ligne */}
      {filteredEntries.length === 0 ? (
        <div className="py-6 text-center surface-card rounded-xl">
          <p className="text-xs text-sub">
            Aucune correspondance pour ces filtres ({mode}).
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-hairline">
          <table className="w-full text-left text-xs">
            <thead className="surface-subtle text-[10px] uppercase tracking-wider text-sub border-b border-hairline">
              <tr>
                <th className="py-2.5 px-3">Exigence NIS2</th>
                {(frameworkFilter === 'ALL' || frameworkFilter === 'HDS') && (
                  <th className="py-2.5 px-3">HDS</th>
                )}
                {(frameworkFilter === 'ALL' ||
                  frameworkFilter === 'ISO27001') && (
                  <th className="py-2.5 px-3">ISO 27001</th>
                )}
                {(frameworkFilter === 'ALL' || frameworkFilter === 'RGPD') && (
                  <th className="py-2.5 px-3">RGPD</th>
                )}
                <th className="py-2.5 px-3 whitespace-nowrap">Statut</th>
                <th className="py-2.5 px-3 whitespace-nowrap text-right">
                  Constats &amp; Détails
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {filteredEntries.map((entry) => {
                const stMeta = CROSSWALK_STATUS_META[entry.statut];
                const isOpen = Boolean(expandedIds[entry.id]);

                return (
                  <React.Fragment key={entry.id}>
                    <tr
                      onClick={() => toggleRow(entry.id)}
                      className="row-interactive cursor-pointer"
                    >
                      <td className="py-2.5 px-3 align-middle max-w-[270px]">
                        <div className="flex items-center gap-1.5">
                          {isOpen ? (
                            <ChevronDown className="w-3.5 h-3.5 text-accent shrink-0" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-dim shrink-0" />
                          )}
                          <span className="font-mono text-[10px] font-extrabold px-1.5 py-0.5 rounded surface-subtle text-accent shrink-0">
                            {entry.nis2_article}
                          </span>
                          <span className="font-bold text-main truncate">
                            {entry.nis2_title}
                          </span>
                        </div>
                      </td>

                      {(frameworkFilter === 'ALL' ||
                        frameworkFilter === 'HDS') && (
                        <td className="py-2.5 px-3 align-middle">
                          <span className="font-mono text-[11px] font-bold text-main">
                            {entry.hds_ref}
                          </span>
                        </td>
                      )}

                      {(frameworkFilter === 'ALL' ||
                        frameworkFilter === 'ISO27001') && (
                        <td className="py-2.5 px-3 align-middle">
                          <span className="font-mono text-[11px] font-bold tone-info">
                            {entry.iso27001_ref}
                          </span>
                        </td>
                      )}

                      {(frameworkFilter === 'ALL' ||
                        frameworkFilter === 'RGPD') && (
                        <td className="py-2.5 px-3 align-middle">
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="font-mono text-[11px] font-bold text-main">
                              {entry.rgpd_ref}
                            </span>
                            {entry.cnil_applicable && (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full badge-warning text-[9px] font-extrabold">
                                <ShieldAlert className="w-2.5 h-2.5" />
                                <span>CNIL 72h</span>
                              </span>
                            )}
                          </div>
                        </td>
                      )}

                      <td className="py-2.5 px-3 align-middle whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-mono font-extrabold ${stMeta.badgeCls}`}
                        >
                          {stMeta.shortLabel}
                        </span>
                      </td>

                      <td className="py-2.5 px-3 align-middle text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          {entry.finding_ids.map((fid) => {
                            const target = findingsById.get(fid.toUpperCase());
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
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--deloitte)] hover:bg-[var(--deloitte-hover)] disabled:opacity-60 text-black font-mono text-[10px] font-extrabold transition cursor-pointer"
                              >
                                <span>{fid}</span>
                                <ArrowUpRight className="w-2.5 h-2.5" />
                              </button>
                            );
                          })}

                          <button
                            type="button"
                            aria-expanded={isOpen}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleRow(entry.id);
                            }}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded surface-subtle text-[10px] font-bold text-sub hover:text-main transition cursor-pointer"
                          >
                            <span>Détails</span>
                            <ChevronDown
                              className={`w-3 h-3 transition-transform ${
                                isOpen ? 'rotate-180 text-accent' : ''
                              }`}
                            />
                          </button>
                        </div>
                      </td>
                    </tr>

                    {isOpen && (
                      <tr className="surface-subtle">
                        <td
                          colSpan={visibleColsCount}
                          className="px-4 py-3 border-l-4 border-l-[var(--deloitte)] space-y-2.5"
                        >
                          <div className="space-y-1">
                            <div className="text-[10px] font-mono font-bold text-dim">
                              {entry.id} • {entry.domain} — {entry.nis2_title}
                            </div>
                            {entry.summary && (
                              <p className="text-xs text-main leading-relaxed">
                                {entry.summary}
                              </p>
                            )}
                          </div>

                          {(entry.hds_detail ||
                            entry.iso27001_detail ||
                            entry.rgpd_detail) && (
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 pt-1">
                              {entry.hds_detail && (
                                <div className="surface-card rounded-lg p-2.5">
                                  <div className="text-[10px] font-extrabold text-accent">
                                    HDS — {entry.hds_ref}
                                  </div>
                                  <div className="text-[11px] text-sub mt-0.5 leading-snug">
                                    {entry.hds_detail}
                                  </div>
                                </div>
                              )}
                              {entry.iso27001_detail && (
                                <div className="surface-card rounded-lg p-2.5">
                                  <div className="text-[10px] font-extrabold tone-info">
                                    ISO 27001 — {entry.iso27001_ref}
                                  </div>
                                  <div className="text-[11px] text-sub mt-0.5 leading-snug">
                                    {entry.iso27001_detail}
                                  </div>
                                </div>
                              )}
                              {entry.rgpd_detail && (
                                <div className="surface-card rounded-lg p-2.5">
                                  <div className="text-[10px] font-extrabold tone-warning">
                                    RGPD — {entry.rgpd_ref}
                                  </div>
                                  <div className="text-[11px] text-sub mt-0.5 leading-snug">
                                    {entry.rgpd_detail}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
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
    </section>
  );
};
