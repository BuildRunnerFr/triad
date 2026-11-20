import React, { useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  Lock,
  Clock,
  Database,
  ArrowUpRight,
  RefreshCw,
  ClipboardCheck,
  Copy,
  Check,
  ChevronDown,
} from 'lucide-react';
import type { AuditMode, ContinuityReport, Finding } from '../types';
import { apiFetch } from '../api';
import {
  computeLocalContinuityFallback,
  CONTINUITY_EXPOSURE_META,
  normalizeServerContinuityReport,
  RANSOMWARE_STATUS_META,
} from '../utils/continuity';

interface Nis2ContinuityCardProps {
  mode: AuditMode;
  sessionId?: string;
  findings: Finding[];
  onInspectFindingInExplorer: (finding: Finding) => void;
}

type ProcessFilter = 'ALL' | 'EXPOSED' | 'RTO_RPO_GAPS';

export const Nis2ContinuityCard: React.FC<Nis2ContinuityCardProps> = ({
  mode,
  sessionId,
  findings,
  onInspectFindingInExplorer,
}) => {
  const [serverReport, setServerReport] = useState<ContinuityReport | null>(
    null
  );
  const [syncState, setSyncState] = useState<'loading' | 'synced' | 'fallback'>(
    'loading'
  );
  const [filter, setFilter] = useState<ProcessFilter>('ALL');
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [copiedProcessId, setCopiedProcessId] = useState<string | null>(null);

  const localFallback = useMemo(
    () => computeLocalContinuityFallback(findings, mode),
    [findings, mode]
  );

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setSyncState('loading');

    apiFetch(`/api/nis2/continuity?mode=${encodeURIComponent(mode)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: unknown = await res.json();
        if (cancelled) return;
        const normalized = normalizeServerContinuityReport(json, mode);
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

  const filteredProcesses = useMemo(() => {
    const sorted = [...report.processes].sort(
      (a, b) =>
        CONTINUITY_EXPOSURE_META[b.exposure_level].rank -
        CONTINUITY_EXPOSURE_META[a.exposure_level].rank
    );
    if (filter === 'EXPOSED') {
      return sorted.filter((p) => p.ransomware_status === 'EXPOSÉ');
    }
    if (filter === 'RTO_RPO_GAPS') {
      return sorted.filter((p) => p.rto_gap || p.rpo_gap);
    }
    return sorted;
  }, [report.processes, filter]);

  const copyPraActions = (
    processId: string,
    processName: string,
    actions: string[]
  ) => {
    const formatted = [
      `Plan d'Exercices PRA & Continuité Clinique (NIS2 Art. 21 §2 c) — ${processName} :`,
      ...actions.map((a, idx) => `${idx + 1}. ${a}`),
    ].join('\n');
    navigator.clipboard.writeText(formatted);
    setCopiedProcessId(processId);
    window.setTimeout(() => setCopiedProcessId(null), 1800);
  };

  const toggleDetails = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const overallMeta = CONTINUITY_EXPOSURE_META[report.overall_exposure];

  return (
    <section
      aria-label="Continuité RTO / RPO — Art. 21 §2 (c)"
      className="space-y-4"
    >
      {/* En-tête court */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <h4 className="text-sm sm:text-base font-extrabold text-main">
            Continuité Clinique RTO / RPO
          </h4>
          <span
            className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-extrabold ${overallMeta.badgeCls}`}
          >
            {overallMeta.label}
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

      {/* 4 tuiles KPI chiffrées aérées */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="surface-card rounded-xl p-3.5 space-y-1">
          <div className="text-xs font-semibold text-sub">
            Processus vitaux
          </div>
          <div className="text-xl font-extrabold font-mono text-main tabular-nums">
            {report.summary_counts.total}
          </div>
          <div className="text-[11px] text-sub">Art. 21 §2 (c)</div>
        </div>

        <div className="surface-card rounded-xl p-3.5 space-y-1">
          <div className="text-xs font-semibold text-sub">
            Exposés rançongiciel
          </div>
          <div
            className={`text-xl font-extrabold font-mono tabular-nums ${
              report.summary_counts.expose > 0
                ? 'tone-critical'
                : 'tone-success'
            }`}
          >
            {report.summary_counts.expose}
          </div>
          <div className="text-[11px] text-sub">Sans WORM / test</div>
        </div>

        <div className="surface-card rounded-xl p-3.5 space-y-1">
          <div className="text-xs font-semibold text-sub">
            Écarts RTO / RPO
          </div>
          <div
            className={`text-xl font-extrabold font-mono tabular-nums ${
              report.summary_counts.rto_rpo_gaps > 0
                ? 'tone-warning'
                : 'tone-success'
            }`}
          >
            {report.summary_counts.rto_rpo_gaps}
          </div>
          <div className="text-[11px] text-sub">Cible PSSI vs réel</div>
        </div>

        <div className="surface-card rounded-xl p-3.5 space-y-1">
          <div className="text-xs font-semibold text-sub">
            Immuables WORM
          </div>
          <div className="text-xl font-extrabold font-mono text-accent tabular-nums">
            {report.summary_counts.immutable}
          </div>
          <div className="text-[11px] text-sub">Bucket Lock actif</div>
        </div>
      </div>

      {/* Filtres compacts */}
      <div
        role="group"
        aria-label="Filtrer les processus vitaux hospitaliers"
        className="flex flex-wrap items-center gap-1.5"
      >
        {(
          [
            ['ALL', `Tous (${report.processes.length})`],
            ['EXPOSED', `Exposés (${report.summary_counts.expose})`],
            ['RTO_RPO_GAPS', `Écarts RTO/RPO (${report.summary_counts.rto_rpo_gaps})`],
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

      {/* Grille des processus condensés + accordéon Détails */}
      {filteredProcesses.length === 0 ? (
        <div className="py-6 text-center surface-card rounded-xl">
          <p className="text-xs text-sub">Aucun processus dans ce filtre.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3.5">
          {filteredProcesses.map((proc) => {
            const expMeta = CONTINUITY_EXPOSURE_META[proc.exposure_level];
            const ransomMeta = RANSOMWARE_STATUS_META[proc.ransomware_status];
            const isOpen = Boolean(expandedIds[proc.id]);

            return (
              <div
                key={proc.id}
                className={`surface-card rounded-xl p-4 border ${expMeta.borderCls} flex flex-col justify-between gap-3`}
              >
                <div className="space-y-3">
                  {/* En-tête carte processus */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[10px] font-extrabold px-2 py-0.5 rounded surface-subtle text-sub">
                          {proc.id}
                        </span>
                        <h5 className="text-xs sm:text-sm font-extrabold text-main">
                          {proc.name}
                        </h5>
                      </div>
                      <div className="text-[11px] text-dim truncate mt-0.5">
                        {proc.criticality}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1 shrink-0">
                      <span
                        title={ransomMeta.detail}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-extrabold ${ransomMeta.badgeCls}`}
                      >
                        {proc.ransomware_status === 'IMMUTABLE' ? (
                          <Lock className="w-3 h-3" />
                        ) : (
                          <ShieldAlert className="w-3 h-3" />
                        )}
                        <span>{ransomMeta.shortLabel}</span>
                      </span>
                    </div>
                  </div>

                  {/* Duo chiffré compact RTO & RPO */}
                  <div className="grid grid-cols-2 gap-2">
                    <div
                      className={`rounded-lg p-2.5 border ${
                        proc.rto_gap
                          ? 'border-[var(--critical-border)] surface-subtle'
                          : 'border-[var(--deloitte)]/35 surface-subtle'
                      } space-y-1`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-sub">
                          <Clock className="w-3 h-3 text-accent" />
                          <span>RTO</span>
                        </span>
                        <span
                          className={`text-[9px] font-mono font-extrabold px-1.5 py-0.5 rounded ${
                            proc.rto_gap ? 'badge-critical' : 'badge-success'
                          }`}
                        >
                          {proc.rto_gap ? 'ÉCART' : 'TENU'}
                        </span>
                      </div>
                      <div className="font-mono text-xs font-extrabold text-main truncate">
                        {proc.rto_target}
                      </div>
                      <div
                        className={`text-[10px] font-medium line-clamp-1 ${
                          proc.rto_gap ? 'tone-critical' : 'text-accent'
                        }`}
                        title={proc.rto_actual}
                      >
                        {proc.rto_actual}
                      </div>
                    </div>

                    <div
                      className={`rounded-lg p-2.5 border ${
                        proc.rpo_gap
                          ? 'border-[var(--critical-border)] surface-subtle'
                          : 'border-[var(--deloitte)]/35 surface-subtle'
                      } space-y-1`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-sub">
                          <Database className="w-3 h-3 text-accent" />
                          <span>RPO</span>
                        </span>
                        <span
                          className={`text-[9px] font-mono font-extrabold px-1.5 py-0.5 rounded ${
                            proc.rpo_gap ? 'badge-critical' : 'badge-success'
                          }`}
                        >
                          {proc.rpo_gap ? 'EXPOSÉ' : 'GARANTI'}
                        </span>
                      </div>
                      <div className="font-mono text-xs font-extrabold text-main truncate">
                        {proc.rpo_target}
                      </div>
                      <div
                        className={`text-[10px] font-medium line-clamp-1 ${
                          proc.rpo_gap ? 'tone-critical' : 'text-accent'
                        }`}
                        title={proc.rpo_actual}
                      >
                        {proc.rpo_actual}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Pied : Constats F-00X + Accordéon Détails */}
                <div className="pt-2.5 border-t border-hairline flex flex-wrap items-center justify-between gap-2">
                  <div className="inline-flex flex-wrap items-center gap-1.5">
                    {proc.finding_ids.length === 0 ? (
                      <span className="text-[11px] font-mono text-dim">—</span>
                    ) : (
                      proc.finding_ids.map((fid) => {
                        const target = findingsById.get(fid.toUpperCase());
                        return (
                          <button
                            key={fid}
                            type="button"
                            disabled={!target}
                            onClick={() =>
                              target && onInspectFindingInExplorer(target)
                            }
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded surface-subtle border border-hairline text-main font-mono text-[10px] font-extrabold transition cursor-pointer"
                          >
                            <span>{fid}</span>
                            <ArrowUpRight className="w-2.5 h-2.5" />
                          </button>
                        );
                      })
                    )}
                  </div>

                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => toggleDetails(proc.id)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg surface-subtle text-[11px] font-bold text-sub hover:text-main transition cursor-pointer"
                  >
                    <span>Détails</span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 transition-transform ${
                        isOpen ? 'rotate-180 text-accent' : ''
                      }`}
                    />
                  </button>
                </div>

                {/* Accordéon dépliable : preuves PRA/PCA & exercices requis */}
                {isOpen && (
                  <div className="pt-2 border-t border-hairline space-y-2.5">
                    <div className="text-[11px] text-sub space-y-1">
                      <div>
                        <strong className="text-main">RTO réel :</strong>{' '}
                        {proc.rto_actual}
                      </div>
                      <div>
                        <strong className="text-main">RPO réel :</strong>{' '}
                        {proc.rpo_actual}
                      </div>
                      {proc.last_test_ref && (
                        <div className="font-mono text-[10px] text-dim pt-0.5">
                          PV / Test : {proc.last_test_ref}
                          {proc.pssi_ref ? ` • ${proc.pssi_ref}` : ''}
                        </div>
                      )}
                    </div>

                    {proc.context && (
                      <p className="text-xs text-sub leading-relaxed">
                        {proc.context}
                      </p>
                    )}

                    {proc.pra_actions.length > 0 && (
                      <div className="surface-subtle rounded-lg p-3 space-y-2 border border-hairline">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-sub text-accent flex items-center gap-1">
                            <ClipboardCheck className="w-3 h-3" />
                            <span>Exercices PRA ({proc.pra_actions.length})</span>
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              copyPraActions(proc.id, proc.name, proc.pra_actions)
                            }
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded surface-card text-[10px] font-bold text-sub hover:text-main transition cursor-pointer"
                          >
                            {copiedProcessId === proc.id ? (
                              <>
                                <Check className="w-2.5 h-2.5 text-accent" />
                                <span>Copié</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-2.5 h-2.5" />
                                <span>Copier</span>
                              </>
                            )}
                          </button>
                        </div>
                        <ul className="space-y-1 text-[11px] text-main leading-snug">
                          {proc.pra_actions.map((act, idx) => (
                            <li key={idx} className="flex items-start gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-[var(--deloitte)] mt-1.5 shrink-0" />
                              <span>{act}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
