import React, { useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  AlertOctagon,
  ArrowUpRight,
  RefreshCw,
  FileWarning,
  FileText,
  Copy,
  Check,
  ChevronDown,
} from 'lucide-react';
import type {
  AuditMode,
  Finding,
  SanitizedDocument,
  SupplyChainReport,
} from '../types';
import { apiFetch } from '../api';
import {
  computeLocalSupplyChainFallback,
  normalizeServerSupplyChainReport,
  SUPPLY_CHAIN_RISK_META,
} from '../utils/supplyChain';

interface Nis2SupplyChainCardProps {
  mode: AuditMode;
  sessionId?: string;
  findings: Finding[];
  docs?: SanitizedDocument[];
  onInspectFindingInExplorer: (finding: Finding) => void;
}

type VendorFilter = 'ALL' | 'HIGH_RISK' | 'QUARANTINED';

export const Nis2SupplyChainCard: React.FC<Nis2SupplyChainCardProps> = ({
  mode,
  sessionId,
  findings,
  docs = [],
  onInspectFindingInExplorer,
}) => {
  const [serverReport, setServerReport] = useState<SupplyChainReport | null>(
    null
  );
  const [syncState, setSyncState] = useState<'loading' | 'synced' | 'fallback'>(
    'loading'
  );
  const [filter, setFilter] = useState<VendorFilter>('ALL');
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [copiedVendorId, setCopiedVendorId] = useState<string | null>(null);

  const localFallback = useMemo(
    () => computeLocalSupplyChainFallback(findings, docs, mode),
    [findings, docs, mode]
  );

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setSyncState('loading');

    apiFetch(`/api/nis2/supply-chain?mode=${encodeURIComponent(mode)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: unknown = await res.json();
        if (cancelled) return;
        const normalized = normalizeServerSupplyChainReport(json, mode);
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
  }, [mode, findings, docs, sessionId]);

  const report = serverReport || localFallback;

  const findingsById = useMemo(() => {
    const map = new Map<string, Finding>();
    for (const f of findings) {
      map.set(f.id.toUpperCase(), f);
    }
    return map;
  }, [findings]);

  const highRiskCount =
    report.summary_counts.critique + report.summary_counts.eleve;
  const quarantinedVendorsCount = useMemo(
    () => report.vendors.filter((v) => v.quarantined).length,
    [report.vendors]
  );
  const totalQuarantined = Math.max(
    report.quarantined_docs_count,
    quarantinedVendorsCount
  );

  const filteredVendors = useMemo(() => {
    const sorted = [...report.vendors].sort(
      (a, b) =>
        SUPPLY_CHAIN_RISK_META[b.risk_level].rank -
        SUPPLY_CHAIN_RISK_META[a.risk_level].rank
    );
    if (filter === 'HIGH_RISK') {
      return sorted.filter(
        (v) => v.risk_level === 'CRITIQUE' || v.risk_level === 'ÉLEVÉ'
      );
    }
    if (filter === 'QUARANTINED') {
      return sorted.filter((v) => v.quarantined);
    }
    return sorted;
  }, [report.vendors, filter]);

  const copyClauses = (
    vendorId: string,
    vendorName: string,
    clauses: string[]
  ) => {
    const formatted = [
      `Clauses contractuelles NIS2 Art. 21 §2 (d) — ${vendorName} :`,
      ...clauses.map((c, idx) => `${idx + 1}. ${c}`),
    ].join('\n');
    navigator.clipboard.writeText(formatted);
    setCopiedVendorId(vendorId);
    window.setTimeout(() => setCopiedVendorId(null), 1800);
  };

  const toggleDetails = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const overallMeta = SUPPLY_CHAIN_RISK_META[report.overall_risk];

  return (
    <section
      aria-label="Risque Prestataires — Art. 21 §2 (d)"
      className="space-y-4"
    >
      {/* En-tête court */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <h4 className="text-sm sm:text-base font-extrabold text-main">
            Prestataires &amp; Tiers — Art. 21 §2 (d)
          </h4>
          <span
            className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-extrabold ${overallMeta.badgeCls}`}
          >
            {overallMeta.label}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {totalQuarantined > 0 && (
            <span className="badge-critical inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold">
              <AlertOctagon className="w-3 h-3" />
              <span>{totalQuarantined} quarantaine DLP</span>
            </span>
          )}
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
          <div className="text-[10px] font-bold uppercase tracking-wider text-dim">
            Tiers évalués
          </div>
          <div className="text-xl font-extrabold font-mono text-main tabular-nums">
            {report.summary_counts.total}
          </div>
          <div className="text-[11px] text-sub">Périmètre {mode}</div>
        </div>

        <div className="surface-card rounded-xl p-3.5 space-y-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-dim">
            Critiques &amp; Élevés
          </div>
          <div
            className={`text-xl font-extrabold font-mono tabular-nums ${
              highRiskCount > 0 ? 'tone-critical' : 'tone-success'
            }`}
          >
            {highRiskCount}
          </div>
          <div className="text-[11px] text-sub tabular-nums">
            {report.summary_counts.critique} crit. •{' '}
            {report.summary_counts.eleve} élevé(s)
          </div>
        </div>

        <div className="surface-card rounded-xl p-3.5 space-y-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-dim">
            Quarantaine DLP
          </div>
          <div
            className={`text-xl font-extrabold font-mono tabular-nums ${
              totalQuarantined > 0 ? 'tone-critical' : 'text-main'
            }`}
          >
            {totalQuarantined}
          </div>
          <div className="text-[11px] text-sub">Anti-injection</div>
        </div>

        <div className="surface-card rounded-xl p-3.5 space-y-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-dim">
            Maîtrisés
          </div>
          <div className="text-xl font-extrabold font-mono text-accent tabular-nums">
            {report.summary_counts.maitrise}
          </div>
          <div className="text-[11px] text-sub tabular-nums">
            {report.summary_counts.modere} modéré(s)
          </div>
        </div>
      </div>

      {/* Filtres compacts */}
      <div
        role="group"
        aria-label="Filtrer les prestataires tiers"
        className="flex flex-wrap items-center gap-1.5"
      >
        {(
          [
            ['ALL', `Tous (${report.vendors.length})`],
            ['HIGH_RISK', `Critiques & Élevés (${highRiskCount})`],
            ['QUARANTINED', `Quarantaine (${quarantinedVendorsCount})`],
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
                  ? 'bg-[#86BC25] text-black'
                  : 'surface-card text-sub hover:text-main'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Cartes prestataires condensées + accordéon Détails */}
      {filteredVendors.length === 0 ? (
        <div className="py-6 text-center surface-card rounded-xl">
          <p className="text-xs text-sub">Aucun prestataire dans ce filtre.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3.5">
          {filteredVendors.map((vendor) => {
            const riskMeta = SUPPLY_CHAIN_RISK_META[vendor.risk_level];
            const isOpen = Boolean(expandedIds[vendor.id]);

            return (
              <div
                key={vendor.id}
                className={`surface-card rounded-xl p-4 border ${riskMeta.borderCls} flex flex-col justify-between gap-3`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[10px] font-extrabold px-2 py-0.5 rounded surface-subtle text-sub">
                        {vendor.id}
                      </span>
                      <h5 className="text-xs sm:text-sm font-extrabold text-main">
                        {vendor.name}
                      </h5>
                    </div>
                    <div className="text-[11px] text-sub truncate mt-0.5">
                      {vendor.role}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {vendor.quarantined && (
                      <span className="badge-critical inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold">
                        <FileWarning className="w-3 h-3" />
                        <span>DLP</span>
                      </span>
                    )}
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-extrabold ${riskMeta.badgeCls}`}
                    >
                      {riskMeta.label}
                    </span>
                  </div>
                </div>

                {/* Barre d'actions : Constats F-00X + Accordéon Détails */}
                <div className="pt-2.5 border-t border-hairline flex flex-wrap items-center justify-between gap-2">
                  <div className="inline-flex flex-wrap items-center gap-1.5">
                    {vendor.finding_ids.length === 0 ? (
                      <span className="text-[11px] font-mono text-dim">
                        Aucun écart actif
                      </span>
                    ) : (
                      vendor.finding_ids.map((fid) => {
                        const target = findingsById.get(fid.toUpperCase());
                        return (
                          <button
                            key={fid}
                            type="button"
                            disabled={!target}
                            onClick={() =>
                              target && onInspectFindingInExplorer(target)
                            }
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#86BC25] hover:bg-[#96cf2e] disabled:opacity-60 text-black font-mono text-[10px] font-extrabold transition cursor-pointer"
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
                    onClick={() => toggleDetails(vendor.id)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg surface-subtle text-[11px] font-bold text-sub hover:text-main transition cursor-pointer"
                  >
                    <span>
                      Détails ({vendor.recommended_clauses.length} clauses)
                    </span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 transition-transform ${
                        isOpen ? 'rotate-180 text-accent' : ''
                      }`}
                    />
                  </button>
                </div>

                {/* Accordéon dépliable : contexte, quarantaine & clauses Art. 21 §2 (d) */}
                {isOpen && (
                  <div className="pt-2 border-t border-hairline space-y-2.5">
                    {(vendor.contract_ref || vendor.source_document) && (
                      <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono text-dim">
                        {vendor.contract_ref && (
                          <span>Contrat : {vendor.contract_ref}</span>
                        )}
                        {vendor.source_document && (
                          <span>Source : {vendor.source_document}</span>
                        )}
                      </div>
                    )}

                    {vendor.context && (
                      <p className="text-xs text-sub leading-relaxed">
                        {vendor.context}
                      </p>
                    )}

                    {vendor.quarantined && vendor.quarantine_reason && (
                      <div className="rounded-lg p-2.5 border badge-critical text-[11px] flex items-start gap-2">
                        <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span className="leading-snug">
                          <strong>Injection bloquée :</strong>{' '}
                          {vendor.quarantine_reason}
                        </span>
                      </div>
                    )}

                    {vendor.recommended_clauses.length > 0 && (
                      <div className="surface-subtle rounded-lg p-3 space-y-2 border border-hairline">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-extrabold uppercase tracking-wider text-accent flex items-center gap-1">
                            <FileText className="w-3 h-3" />
                            <span>Clauses Art. 21 §2 (d)</span>
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              copyClauses(
                                vendor.id,
                                vendor.name,
                                vendor.recommended_clauses
                              )
                            }
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded surface-card text-[10px] font-bold text-sub hover:text-main transition cursor-pointer"
                          >
                            {copiedVendorId === vendor.id ? (
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
                          {vendor.recommended_clauses.map((clause, idx) => (
                            <li key={idx} className="flex items-start gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-[#86BC25] mt-1.5 shrink-0" />
                              <span>{clause}</span>
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
