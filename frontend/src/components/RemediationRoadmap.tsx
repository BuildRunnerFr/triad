import React, { useEffect, useMemo, useState } from 'react';
import {
  Flame,
  Wrench,
  Landmark,
  Terminal,
  Download,
  CheckCircle2,
  ArrowUpRight,
  TrendingUp,
  Target,
  RotateCcw,
  Lock,
  Clock,
  Scale,
  Sparkles,
  ChevronDown,
  Zap,
} from 'lucide-react';
import type {
  AuditMode,
  Finding,
  RemediationSimulationResult,
} from '../types';
import { simulateRemediationImpact } from '../api';
import { computeMaturityScore } from '../utils/auditMetrics';
import { computeLocalRemediationSimulation } from '../utils/grcSimulation';
import type { ToastTone } from './ToastStack';

interface RemediationRoadmapProps {
  findings: Finding[];
  clientName: string;
  mode: AuditMode;
  validated?: boolean;
  onSelectFinding: (finding: Finding) => void;
  onExportPlaybook?: () => void;
  onRequestValidationTab?: () => void;
  onNotify?: (title: string, detail?: string, tone?: ToastTone) => void;
}

export type HorizonKey = '0_30' | '30_60' | '60_90';
export type EffortKey = 'faible' | 'modere' | 'structurant';

export interface RoadmapActionItem {
  finding: Finding;
  horizon: HorizonKey;
  effort: EffortKey;
  effortLabel: string;
  workloadEstimate: string;
  impactScore: number;
  ownerRole: string;
  quadrant: 'quick_win' | 'major_project' | 'hygiene' | 'governance';
}

export function classifyFindingForRoadmap(f: Finding): RoadmapActionItem {
  const hay = `${f.theme} ${f.exigence_nis2} ${f.reel?.ressource || ''}`.toLowerCase();
  const hasCli = Boolean(f.commande_correction);

  let effort: EffortKey = 'modere';
  let effortLabel = 'Modéré';
  let workloadEstimate = '3 – 6 j.h';
  let ownerRole = 'Ingénierie Cloud & Sécurité';

  if (
    hasCli &&
    /allusers|allow-ssh|firewall|versioning|retention/i.test(
      `${f.commande_correction || ''} ${hay}`
    ) &&
    !/iam|kms|serviceaccount/i.test(hay)
  ) {
    effort = 'faible';
    effortLabel = 'Faible (Action directe)';
    workloadEstimate = '0,5 – 2 j.h';
    ownerRole = 'Ops Cloud / Administrateur GCP';
  } else if (
    /incident|notification|anssi|art\.\s*23|pacs|pra|pca|gouvernance/i.test(hay) &&
    !hasCli
  ) {
    effort = 'structurant';
    effortLabel = 'Structurant';
    workloadEstimate = '8 – 15 j.h';
    ownerRole = 'RSSI, DSI & Direction Juridique';
  } else if (/iam|kms|logging|journal|privil|serviceaccount|sauvegarde|backup/i.test(hay)) {
    effort = 'modere';
    effortLabel = 'Modéré';
    workloadEstimate = '4 – 8 j.h';
    ownerRole = 'Architecte Sécurité IAM / SecOps';
  }

  let horizon: HorizonKey = '30_60';
  if (
    f.statut === 'conforme' ||
    effort === 'structurant' ||
    f.gravite === 'faible' ||
    f.gravite === 'moyenne'
  ) {
    horizon = '60_90';
  } else if (
    effort === 'faible' &&
    (f.gravite === 'critique' || f.gravite === 'haute')
  ) {
    horizon = '0_30';
  } else {
    horizon = '30_60';
  }

  const baseImpact =
    f.statut === 'conforme'
      ? 35
      : f.gravite === 'critique'
      ? 96
      : f.gravite === 'haute'
      ? 80
      : f.gravite === 'moyenne'
      ? 56
      : 38;
  const impactScore = Math.min(99, baseImpact + (f.contradiction ? 3 : 0));

  let quadrant: RoadmapActionItem['quadrant'];
  if (impactScore >= 70 && effort === 'faible') {
    quadrant = 'quick_win';
  } else if (impactScore >= 70) {
    quadrant = 'major_project';
  } else if (effort === 'faible') {
    quadrant = 'hygiene';
  } else {
    quadrant = 'governance';
  }

  return {
    finding: f,
    horizon,
    effort,
    effortLabel,
    workloadEstimate,
    impactScore,
    ownerRole,
    quadrant,
  };
}

export const HORIZON_META: Record<
  HorizonKey,
  {
    badge: string;
    title: string;
    subtitle: string;
    accentCls: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  '0_30': {
    badge: 'J+0 à J+30',
    title: 'Urgence & Confinement',
    subtitle: 'Fermeture immédiate des expositions critiques & immuabilité',
    accentCls: 'badge-critical',
    icon: Flame,
  },
  '30_60': {
    badge: 'J+30 à J+60',
    title: 'IAM, KMS & Journaux',
    subtitle: 'Moindre privilège, rotation cryptographique et traces 365j',
    accentCls: 'badge-warning',
    icon: Wrench,
  },
  '60_90': {
    badge: 'J+60 à J+90',
    title: 'Gouvernance & PRA',
    subtitle: 'Processus de notification Art. 23, mise à jour PSSI et tests PRA',
    accentCls: 'badge-success',
    icon: Landmark,
  },
};

const GRAVITE_BADGE: Record<string, { label: string; cls: string }> = {
  critique: { label: 'Critique', cls: 'badge-critical' },
  haute: { label: 'Haute', cls: 'badge-high' },
  moyenne: { label: 'Moyenne', cls: 'badge-warning' },
  faible: { label: 'Faible', cls: 'surface-subtle text-sub' },
};

export const RemediationRoadmap: React.FC<RemediationRoadmapProps> = ({
  findings,
  clientName,
  mode,
  validated = false,
  onSelectFinding,
  onExportPlaybook,
  onRequestValidationTab,
  onNotify,
}) => {
  const [completedIds, setCompletedIds] = useState<Record<string, boolean>>({});
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [serverSim, setServerSim] =
    useState<RemediationSimulationResult | null>(null);

  useEffect(() => {
    setCompletedIds({});
    setExpandedIds({});
    setServerSim(null);
  }, [mode]);

  const selectedIdsList = useMemo(
    () =>
      Object.entries(completedIds)
        .filter(([, checked]) => Boolean(checked))
        .map(([id]) => id),
    [completedIds]
  );

  const hasSimulatedSelection = selectedIdsList.length > 0;

  const roadmapItems = useMemo(
    () => findings.map(classifyFindingForRoadmap),
    [findings]
  );

  const localSim = useMemo(
    () => computeLocalRemediationSimulation(findings, selectedIdsList, mode),
    [findings, selectedIdsList, mode]
  );

  useEffect(() => {
    if (!findings.length) {
      setServerSim(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await simulateRemediationImpact(
          selectedIdsList,
          mode,
          controller.signal
        );
        if (!controller.signal.aborted && res) {
          setServerSim(res);
        }
      } catch {
        // Repli déterministe local
      }
    }, 120);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [findings, selectedIdsList, mode]);

  const activeSim: RemediationSimulationResult = useMemo(() => {
    if (
      serverSim &&
      serverSim.mode === mode &&
      serverSim.selected_ids.length === selectedIdsList.length
    ) {
      return serverSim;
    }
    return localSim;
  }, [serverSim, localSim, mode, selectedIdsList.length]);

  const currentScore = activeSim.current_score ?? computeMaturityScore(findings);
  const simulatedScore = activeSim.projected_score;

  const selectScenarioPreset = (preset: '0_30' | '0_60' | 'ALL') => {
    const next: Record<string, boolean> = {};
    for (const item of roadmapItems) {
      if (item.finding.statut === 'conforme') continue;
      if (preset === 'ALL') {
        next[item.finding.id] = true;
      } else if (preset === '0_30' && item.horizon === '0_30') {
        next[item.finding.id] = true;
      } else if (
        preset === '0_60' &&
        (item.horizon === '0_30' || item.horizon === '30_60')
      ) {
        next[item.finding.id] = true;
      }
    }
    setCompletedIds(next);
  };

  const toggleCompleted = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCompletedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleExpanded = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const downloadContent = (filename: string, content: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    onNotify?.('Feuille de route exportée', filename, 'success');
  };

  const exportRoadmapCsv = () => {
    const headers = [
      'Horizon',
      'ID',
      'Theme',
      'Exigence_NIS2',
      'Gravite',
      'Effort',
      'Charge_Estimee',
      'Responsable',
      'Action_Recommandee',
      'Commande_gcloud',
    ];
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const rows = roadmapItems.map((it) =>
      [
        HORIZON_META[it.horizon].badge,
        it.finding.id,
        it.finding.theme,
        it.finding.exigence_nis2,
        it.finding.gravite,
        it.effortLabel,
        it.workloadEstimate,
        it.ownerRole,
        it.finding.recommandation,
        it.finding.commande_correction || '',
      ]
        .map(esc)
        .join(';')
    );
    downloadContent(
      `Plan_Remediation_NIS2_30_60_90j_${mode}.csv`,
      '\uFEFF' + [headers.join(';'), ...rows].join('\n'),
      'text/csv;charset=utf-8;'
    );
  };

  const exportRoadmapMarkdown = () => {
    const lines: string[] = [
      `# Plan de Remédiation Cyber NIS2 (30 / 60 / 90 jours) — ${clientName}`,
      `**Phase :** ${mode} | **Indice initial :** ${currentScore}% | **Cible post-plan :** 100%`,
      '',
    ];
    for (const hKey of ['0_30', '30_60', '60_90'] as const) {
      const meta = HORIZON_META[hKey];
      const group = roadmapItems.filter((i) => i.horizon === hKey);
      lines.push(`## ${meta.badge} — ${meta.title}`);
      if (!group.length) {
        lines.push('_Aucune action requise sur cet horizon._\n');
        continue;
      }
      for (const it of group) {
        lines.push(
          `### [${it.finding.id}] ${it.finding.theme} (${it.finding.exigence_nis2})`
        );
        lines.push(
          `- **Gravité :** ${it.finding.gravite.toUpperCase()} | **Effort :** ${it.effortLabel} (${it.workloadEstimate}) | **Porteur :** ${it.ownerRole}`
        );
        lines.push(`- **Action :** ${it.finding.recommandation}`);
        if (it.finding.commande_correction) {
          lines.push(`- **Correctif technique :** \`${it.finding.commande_correction}\``);
        }
        lines.push('');
      }
    }
    downloadContent(
      `Plan_Remediation_NIS2_30_60_90j_${mode}.md`,
      lines.join('\n'),
      'text/markdown;charset=utf-8;'
    );
  };

  if (findings.length === 0) {
    return (
      <div className="surface-panel rounded-2xl p-8 text-center text-xs text-sub">
        Aucun constat disponible — lancez un audit pour générer le plan 30/60/90j.
      </div>
    );
  }

  const quickWins = roadmapItems.filter(
    (i) => i.quadrant === 'quick_win' && i.finding.statut !== 'conforme'
  );
  const majorProjects = roadmapItems.filter((i) => i.quadrant === 'major_project');
  const hygieneItems = roadmapItems.filter((i) => i.quadrant === 'hygiene');
  const govItems = roadmapItems.filter((i) => i.quadrant === 'governance');

  return (
    <div className="space-y-5">
      {/* PANNEAU SIMULATEUR ROI & CARTES KPI CHIFFRÉES */}
      <div className="surface-panel rounded-2xl p-5 space-y-4">
        {/* En-tête court + Exports */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl badge-success flex items-center justify-center shrink-0">
              <TrendingUp className="w-4 h-4" />
            </div>
            <h3 className="text-sm sm:text-base font-extrabold text-main">
              Trajectoire &amp; ROI 30/60/90j
            </h3>
            <span className="badge-success font-mono text-[11px] font-extrabold px-2.5 py-0.5 rounded-full tabular-nums">
              {currentScore}% → {simulatedScore}% (+
              {Math.max(0, activeSim.score_delta)} pts)
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onExportPlaybook && (
              <button
                type="button"
                onClick={() => {
                  if (validated) {
                    onExportPlaybook();
                  } else {
                    onNotify?.(
                      'Validation humaine requise',
                      'Validez la synthèse pour débloquer le playbook gcloud scellé.',
                      'warning'
                    );
                    onRequestValidationTab?.();
                  }
                }}
                title={
                  validated
                    ? 'Télécharger le script Bash dry-run scellé SHA-256'
                    : 'Validation humaine consultant requise (verrou 403)'
                }
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                  validated
                    ? 'surface-card hover:border-[#86BC25] text-main'
                    : 'badge-warning hover:opacity-90'
                }`}
              >
                {validated ? (
                  <Terminal className="w-3.5 h-3.5 text-accent" />
                ) : (
                  <Lock className="w-3.5 h-3.5" />
                )}
                <span>Playbook (.sh)</span>
              </button>
            )}
            <button
              type="button"
              onClick={exportRoadmapCsv}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl surface-card hover:border-strong text-xs font-bold text-main transition cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-accent" />
              <span>CSV (.csv)</span>
            </button>
            <button
              type="button"
              onClick={exportRoadmapMarkdown}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#86BC25] hover:bg-[#96cf2e] text-black text-xs font-extrabold transition cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Markdown (.md)</span>
            </button>
          </div>
        </div>

        {/* Barre de scénarios rapides */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-hairline">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-bold text-sub mr-1 inline-flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 text-accent" />
              Scénarios :
            </span>
            <button
              type="button"
              onClick={() => selectScenarioPreset('0_30')}
              className="px-2.5 py-1 rounded-lg surface-card hover:border-[#86BC25] text-xs font-bold text-main transition cursor-pointer"
            >
              J+30 Quick-Wins
            </button>
            <button
              type="button"
              onClick={() => selectScenarioPreset('0_60')}
              className="px-2.5 py-1 rounded-lg surface-card hover:border-[#86BC25] text-xs font-bold text-main transition cursor-pointer"
            >
              J+60 Consolidation
            </button>
            <button
              type="button"
              onClick={() => selectScenarioPreset('ALL')}
              className="px-2.5 py-1 rounded-lg bg-[var(--accent-soft)] border border-[#86BC25]/45 hover:bg-[#86BC25] hover:text-black text-xs font-extrabold text-accent transition cursor-pointer"
            >
              Plan 90j (100%)
            </button>
            {hasSimulatedSelection && (
              <button
                type="button"
                onClick={() => setCompletedIds({})}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg surface-subtle hover:border-strong text-xs font-semibold text-sub hover:text-main transition cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Réinitialiser</span>
              </button>
            )}
          </div>

          <span className="font-mono text-[11px] text-sub px-2.5 py-0.5 rounded-full surface-subtle tabular-nums">
            {activeSim.remediated_ids.length}/{activeSim.actionable_findings} simulé(s)
          </span>
        </div>

        {/* 4 Cartes KPI aérées : Score, Charge j.h, Exposition Art. 34, Quick-Wins */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3.5">
          {/* KPI 1 : Score AVANT -> APRÈS simulation */}
          <div className="surface-card rounded-2xl p-4 space-y-2 border border-hairline">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-sub">
                Score Projeté
              </span>
              <span className="badge-success font-mono text-[10px] font-extrabold px-2 py-0.5 rounded-full tabular-nums">
                +{Math.max(0, activeSim.score_delta)} pts
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-base font-bold text-sub tabular-nums">
                {currentScore}%
              </span>
              <span className="text-dim">→</span>
              <span className="text-2xl font-extrabold text-main tabular-nums">
                {simulatedScore}%
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full surface-subtle overflow-hidden flex">
              <div
                className="h-full bg-slate-500/50 transition-all duration-300"
                style={{ width: `${Math.min(100, currentScore)}%` }}
              />
              <div
                className="h-full bg-[#86BC25] transition-all duration-300"
                style={{
                  width: `${Math.max(
                    0,
                    Math.min(100 - currentScore, activeSim.score_delta)
                  )}%`,
                }}
              />
            </div>
          </div>

          {/* KPI 2 : Charge j.h */}
          <div className="surface-card rounded-2xl p-4 space-y-1.5 border border-hairline">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-sub inline-flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-accent" />
                Charge j.h
              </span>
              <span className="font-mono text-[10px] px-2 py-0.5 rounded-full surface-subtle text-sub tabular-nums">
                {activeSim.workload_jh.estimated_jh > 0
                  ? `${String(activeSim.workload_jh.min_jh).replace('.', ',')}–${String(
                      activeSim.workload_jh.max_jh
                    ).replace('.', ',')} j.h`
                  : '0 j.h'}
              </span>
            </div>
            <div className="text-2xl font-extrabold font-mono text-main tabular-nums">
              {String(activeSim.workload_jh.estimated_jh).replace('.', ',')} j.h
            </div>
            <div className="text-[11px] text-sub">
              {activeSim.remediated_ids.length > 0
                ? `${activeSim.remediated_ids.length} chantier(s) chiffré(s)`
                : 'Cochez un chantier pour chiffrer'}
            </div>
          </div>

          {/* KPI 3 : Exposition Art. 34 */}
          <div className="surface-card rounded-2xl p-4 space-y-1.5 border border-hairline">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-sub inline-flex items-center gap-1">
                <Scale className="w-3.5 h-3.5 text-accent" />
                Exposition Art. 34
              </span>
              <span
                className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${
                  activeSim.art34_exposure.risk_level_after === 'MAÎTRISÉ'
                    ? 'badge-success'
                    : activeSim.art34_exposure.risk_level_after === 'MODÉRÉ'
                    ? 'badge-info'
                    : activeSim.art34_exposure.risk_level_after === 'ÉLEVÉ'
                    ? 'badge-warning'
                    : 'badge-critical'
                }`}
              >
                {activeSim.art34_exposure.risk_level_before} →{' '}
                {activeSim.art34_exposure.risk_level_after}
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-extrabold font-mono text-accent tabular-nums">
                -{String(activeSim.art34_exposure.exposure_reduction_pct).replace('.', ',')}%
              </span>
              <span className="text-[11px] font-mono text-sub tabular-nums">
                ({activeSim.art34_exposure.critical_gaps_before}→
                {activeSim.art34_exposure.critical_gaps_after} crit.)
              </span>
            </div>
            <div className="text-[11px] text-dim truncate">
              {activeSim.art34_exposure.plafond_label}
            </div>
          </div>

          {/* KPI 4 : Quick-Wins */}
          <div className="surface-card rounded-2xl p-4 space-y-1.5 border border-hairline">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-sub inline-flex items-center gap-1">
                <Zap className="w-3.5 h-3.5 text-accent" />
                Quick-Wins
              </span>
              <span className="badge-success text-[10px] font-bold px-2 py-0.5 rounded-full">
                Effort Faible
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-extrabold font-mono text-main tabular-nums">
                {quickWins.length}
              </span>
              <span className="text-[11px] text-sub">
                action(s) J+30
              </span>
            </div>
            <div className="text-[11px] font-mono text-sub tabular-nums">
              {activeSim.workload_jh.quick_wins_count} activé(s) en simulation
            </div>
          </div>
        </div>

        {/* Gains par Pilier NIS2 — grille compacte 2 colonnes */}
        <div className="surface-subtle rounded-xl p-3.5 border border-hairline">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2.5">
            {activeSim.pillars.map((p) => (
              <div key={p.id} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="min-w-0 truncate">
                    <span className="font-bold text-main">{p.title}</span>{' '}
                    <span className="text-[10px] font-mono text-dim">
                      ({p.article})
                    </span>
                  </div>
                  <div className="font-mono text-[11px] shrink-0 tabular-nums">
                    <span className="text-sub">{p.current_score}%</span>
                    {p.gain > 0 && (
                      <>
                        <span className="text-dim mx-1">→</span>
                        <span className="font-extrabold text-accent">
                          {p.projected_score}% (+{p.gain})
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="h-1.5 w-full rounded-full surface-card overflow-hidden flex">
                  <div
                    className="h-full bg-slate-500/55 transition-all duration-300"
                    style={{ width: `${Math.min(100, p.current_score)}%` }}
                  />
                  {p.gain > 0 && (
                    <div
                      className="h-full bg-[#86BC25] transition-all duration-300"
                      style={{
                        width: `${Math.min(100 - p.current_score, p.gain)}%`,
                      }}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* COLONNES 30 / 60 / 90 JOURS : CARTES CONDENSÉES + ACCORDÉON « DÉTAILS » */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
        {(['0_30', '30_60', '60_90'] as const).map((hKey) => {
          const meta = HORIZON_META[hKey];
          const Icon = meta.icon;
          const items = roadmapItems.filter((i) => i.horizon === hKey);

          return (
            <div
              key={hKey}
              className="surface-panel rounded-2xl p-4 space-y-3"
            >
              <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-hairline">
                <div className="flex items-center gap-2.5">
                  <div
                    className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${meta.accentCls}`}
                  >
                    <Icon className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="font-mono text-[10px] font-extrabold uppercase tracking-wider text-accent">
                      {meta.badge}
                    </span>
                    <h4 className="text-xs font-extrabold text-main">
                      {meta.title}
                    </h4>
                  </div>
                </div>
                <span className="font-mono text-[11px] font-extrabold px-2.5 py-0.5 rounded-full surface-subtle text-main tabular-nums">
                  {items.length}
                </span>
              </div>

              {items.length === 0 ? (
                <div className="surface-subtle rounded-xl p-4 text-center text-[11px] text-dim">
                  Aucun chantier sur cet horizon.
                </div>
              ) : (
                <div className="space-y-2">
                  {items.map((it) => {
                    const isAlreadyCompliant = it.finding.statut === 'conforme';
                    const isDone = Boolean(completedIds[it.finding.id]);
                    const isExpanded = Boolean(expandedIds[it.finding.id]);
                    const gravMeta =
                      GRAVITE_BADGE[it.finding.gravite] || GRAVITE_BADGE.moyenne;

                    return (
                      <div
                        key={it.finding.id}
                        className={`surface-card hover:border-strong rounded-xl overflow-hidden transition ${
                          isDone || isAlreadyCompliant
                            ? 'opacity-80 border-[#86BC25]/50'
                            : ''
                        }`}
                      >
                        {/* Ligne condensée par défaut */}
                        <div
                          role="button"
                          tabIndex={0}
                          aria-expanded={isExpanded}
                          onClick={() => toggleExpanded(it.finding.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              toggleExpanded(it.finding.id);
                            }
                          }}
                          className="p-3 space-y-2 cursor-pointer"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              {isAlreadyCompliant ? (
                                <CheckCircle2
                                  className="w-4 h-4 text-accent shrink-0"
                                  aria-label="Contrôle déjà conforme"
                                />
                              ) : (
                                <input
                                  type="checkbox"
                                  checked={isDone}
                                  onClick={(e) => toggleCompleted(it.finding.id, e)}
                                  onChange={() => {}}
                                  aria-label={`Simuler remédiation ${it.finding.id}`}
                                  className="accent-[#86BC25] rounded cursor-pointer shrink-0"
                                />
                              )}
                              <span className="font-mono text-[11px] font-extrabold px-1.5 py-0.5 rounded bg-[#86BC25] text-black shrink-0">
                                {it.finding.id}
                              </span>
                              <span
                                className={`text-xs font-extrabold text-main truncate ${
                                  isDone ? 'line-through' : ''
                                }`}
                              >
                                {it.finding.theme}
                              </span>
                            </div>

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelectFinding(it.finding);
                              }}
                              title="Ouvrir l'inspecteur de preuve"
                              className="p-1 rounded-lg surface-subtle hover:border-[#86BC25] text-accent shrink-0 cursor-pointer"
                            >
                              <ArrowUpRight className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-1.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {isAlreadyCompliant ? (
                                <span className="badge-success text-[10px] font-bold px-2 py-0.5 rounded-full">
                                  Conforme ✓
                                </span>
                              ) : (
                                <span
                                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${gravMeta.cls}`}
                                >
                                  {gravMeta.label}
                                </span>
                              )}
                              <span className="font-mono text-[10px] font-bold px-2 py-0.5 rounded-full surface-subtle text-main tabular-nums">
                                {it.workloadEstimate}
                              </span>
                              {it.finding.commande_correction && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded surface-subtle font-mono text-[10px] font-bold text-accent">
                                  <Terminal className="w-2.5 h-2.5" />
                                  CLI
                                </span>
                              )}
                            </div>

                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-sub">
                              <span>Détails</span>
                              <ChevronDown
                                className={`w-3.5 h-3.5 transition-transform ${
                                  isExpanded ? 'rotate-180 text-accent' : ''
                                }`}
                              />
                            </span>
                          </div>
                        </div>

                        {/* Accordéon Détails (Dit / Écrit / Réel, recommandation, gcloud) */}
                        {isExpanded && (
                          <div className="px-3 pb-3 pt-2.5 border-t border-hairline surface-subtle space-y-2 text-[11px]">
                            <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] font-mono text-sub">
                              <span>{it.finding.exigence_nis2}</span>
                              <span>{it.ownerRole}</span>
                            </div>

                            {(it.finding.dit || it.finding.ecrit || it.finding.reel) && (
                              <div className="space-y-1 rounded-lg surface-card p-2 border border-hairline text-[10px]">
                                {it.finding.dit && (
                                  <div className="text-sub line-clamp-2">
                                    <strong className="text-main">Dit :</strong> «{' '}
                                    {it.finding.dit.extrait} »
                                  </div>
                                )}
                                {it.finding.ecrit && (
                                  <div className="text-sub line-clamp-2">
                                    <strong className="text-main">Écrit :</strong> «{' '}
                                    {it.finding.ecrit.extrait} »
                                  </div>
                                )}
                                {it.finding.reel && (
                                  <div className="text-sub line-clamp-2">
                                    <strong className="text-main">Réel :</strong>{' '}
                                    {it.finding.reel.constat}
                                  </div>
                                )}
                              </div>
                            )}

                            <p className="text-sub leading-relaxed">
                              <strong className="text-main">Action :</strong>{' '}
                              {it.finding.recommandation}
                            </p>

                            {it.finding.commande_correction && (
                              <pre className="p-2 rounded-lg surface-card border border-hairline font-mono text-[10px] text-accent overflow-x-auto">
                                {it.finding.commande_correction}
                              </pre>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* MATRICE D'ARBITRAGE EFFORT × IMPACT CONDENSÉE */}
      <div className="surface-panel rounded-2xl p-4 sm:p-5 space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Target className="w-4 h-4 text-accent" />
            <h3 className="text-sm font-extrabold text-main">
              Matrice Effort × Impact NIS2
            </h3>
          </div>
          <span className="text-[11px] font-mono text-dim">
            4 quadrants d&apos;arbitrage
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Quadrant 1 */}
          <div className="surface-card rounded-xl p-3.5 edge-accent space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-extrabold text-main">
                1. Quick-Wins Prioritaires
              </span>
              <span className="badge-success text-[10px] font-bold px-2 py-0.5 rounded-full">
                Impact Fort • Effort Faible
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {quickWins.length === 0 ? (
                <span className="text-[11px] text-dim">Aucun élément</span>
              ) : (
                quickWins.map((it) => (
                  <button
                    key={it.finding.id}
                    type="button"
                    onClick={() => onSelectFinding(it.finding)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg surface-subtle hover:border-[#86BC25] text-xs font-bold text-main transition cursor-pointer"
                  >
                    <span className="font-mono text-[10px] px-1.5 py-0.2 rounded bg-[#86BC25] text-black">
                      {it.finding.id}
                    </span>
                    <span>{it.finding.theme}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Quadrant 2 */}
          <div className="surface-card rounded-xl p-3.5 edge-amber space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-extrabold text-main">
                2. Chantiers Structurants
              </span>
              <span className="badge-warning text-[10px] font-bold px-2 py-0.5 rounded-full">
                Impact Fort • Effort Modéré+
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {majorProjects.length === 0 ? (
                <span className="text-[11px] text-dim">Aucun élément</span>
              ) : (
                majorProjects.map((it) => (
                  <button
                    key={it.finding.id}
                    type="button"
                    onClick={() => onSelectFinding(it.finding)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg surface-subtle hover:border-amber-500 text-xs font-bold text-main transition cursor-pointer"
                  >
                    <span className="font-mono text-[10px] px-1.5 py-0.2 rounded badge-warning">
                      {it.finding.id}
                    </span>
                    <span>{it.finding.theme}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Quadrant 3 */}
          <div className="surface-card rounded-xl p-3.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-extrabold text-main">
                3. Hygiène Opérationnelle
              </span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded surface-subtle text-sub">
                Effort Faible
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {hygieneItems.length === 0 ? (
                <span className="text-[11px] text-dim">Aucun élément</span>
              ) : (
                hygieneItems.map((it) => (
                  <button
                    key={it.finding.id}
                    type="button"
                    onClick={() => onSelectFinding(it.finding)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg surface-subtle text-xs font-semibold text-main cursor-pointer"
                  >
                    <span className="font-mono text-[10px]">{it.finding.id}</span>
                    <span>{it.finding.theme}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Quadrant 4 */}
          <div className="surface-card rounded-xl p-3.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-extrabold text-main">
                4. Maintien &amp; PRA
              </span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded surface-subtle text-sub">
                Amélioration continue
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {govItems.length === 0 ? (
                <span className="text-[11px] text-dim">Aucun élément</span>
              ) : (
                govItems.map((it) => (
                  <button
                    key={it.finding.id}
                    type="button"
                    onClick={() => onSelectFinding(it.finding)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg surface-subtle hover:border-strong text-xs font-semibold text-main cursor-pointer"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-accent" />
                    <span className="font-mono text-[10px]">{it.finding.id}</span>
                    <span>{it.finding.theme}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
