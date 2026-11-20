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

const GRAVITE_BADGE: Record<string, { label: string; tone: string }> = {
  critique: { label: 'Critique', tone: 'tone-critical' },
  haute: { label: 'Haute', tone: 'tone-high' },
  moyenne: { label: 'Moyenne', tone: 'tone-warning' },
  faible: { label: 'Faible', tone: 'text-sub' },
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
            <h3 className="text-lg font-semibold tracking-[-0.018em] text-main">
              Trajectoire &amp; ROI 30/60/90j
            </h3>
            <span className="badge-success text-[13px] font-semibold px-2.5 py-0.5 rounded-full tabular-nums">
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
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[13px] font-semibold transition cursor-pointer ${
                  validated
                    ? 'surface-card hover:border-[var(--deloitte)] text-main'
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
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl surface-card hover:border-strong text-[13px] font-semibold text-main transition cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-accent" />
              <span>CSV (.csv)</span>
            </button>
            <button
              type="button"
              onClick={exportRoadmapMarkdown}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[var(--deloitte)] hover:bg-[var(--deloitte-hover)] text-black text-[13px] font-bold transition cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Markdown (.md)</span>
            </button>
          </div>
        </div>

        {/* Barre de scénarios rapides */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-hairline">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold text-sub mr-1 inline-flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 text-accent" />
              Scénarios :
            </span>
            <button
              type="button"
              onClick={() => selectScenarioPreset('0_30')}
              className="px-2.5 py-1 rounded-lg surface-card hover:border-[var(--deloitte)] text-[13px] font-semibold text-main transition cursor-pointer"
            >
              J+30 Quick-Wins
            </button>
            <button
              type="button"
              onClick={() => selectScenarioPreset('0_60')}
              className="px-2.5 py-1 rounded-lg surface-card hover:border-[var(--deloitte)] text-[13px] font-semibold text-main transition cursor-pointer"
            >
              J+60 Consolidation
            </button>
            <button
              type="button"
              onClick={() => selectScenarioPreset('ALL')}
              className="px-2.5 py-1 rounded-lg bg-[var(--accent-soft)] border border-[var(--deloitte)]/45 hover:bg-[var(--deloitte)] hover:text-black text-[13px] font-bold text-accent transition cursor-pointer"
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

          <span className="text-xs text-sub tabular-nums">
            {activeSim.remediated_ids.length}/{activeSim.actionable_findings} simulé(s)
          </span>
        </div>

        {/* 4 chiffres séparés par des filets : Score, Charge j.h, Exposition Art. 34, Quick-Wins */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 border-t border-hairline">
          {/* KPI 1 : Score AVANT -> APRÈS simulation */}
          <div className="pt-3 pb-2 pr-4 xl:pl-4 xl:first:pl-0 xl:border-l xl:first:border-l-0 border-hairline space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-sub">
                Score Projeté
              </span>
              <span className="badge-success text-xs font-semibold px-2 py-0.5 rounded-full tabular-nums">
                +{Math.max(0, activeSim.score_delta)} pts
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-base font-bold text-sub tabular-nums">
                {currentScore}%
              </span>
              <span className="text-dim">→</span>
              <span className="text-2xl font-semibold text-main tabular-nums">
                {simulatedScore}%
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full surface-subtle overflow-hidden flex">
              <div
                className="h-full bg-slate-500/50 transition-all duration-300"
                style={{ width: `${Math.min(100, currentScore)}%` }}
              />
              <div
                className="h-full bg-[var(--deloitte)] transition-all duration-300"
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
          <div className="pt-3 pb-2 pr-4 xl:pl-4 xl:border-l border-hairline space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-sub inline-flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-accent" />
                Charge j.h
              </span>
              <span className="text-xs px-2 py-0.5 rounded-full surface-subtle text-sub tabular-nums">
                {activeSim.workload_jh.estimated_jh > 0
                  ? `${String(activeSim.workload_jh.min_jh).replace('.', ',')}–${String(
                      activeSim.workload_jh.max_jh
                    ).replace('.', ',')} j.h`
                  : '0 j.h'}
              </span>
            </div>
            <div className="text-2xl font-semibold text-main tabular-nums">
              {String(activeSim.workload_jh.estimated_jh).replace('.', ',')} j.h
            </div>
            <div className="text-xs text-sub">
              {activeSim.remediated_ids.length > 0
                ? `${activeSim.remediated_ids.length} chantier(s) chiffré(s)`
                : 'Cochez un chantier pour chiffrer'}
            </div>
          </div>

          {/* KPI 3 : Exposition Art. 34 */}
          <div className="pt-3 pb-2 pr-4 xl:pl-4 xl:border-l border-hairline space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-sub inline-flex items-center gap-1">
                <Scale className="w-3.5 h-3.5 text-accent" />
                Exposition Art. 34
              </span>
              <span
                className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
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
              <span className="text-2xl font-semibold text-accent tabular-nums">
                -{String(activeSim.art34_exposure.exposure_reduction_pct).replace('.', ',')}%
              </span>
              <span className="text-xs text-sub tabular-nums">
                ({activeSim.art34_exposure.critical_gaps_before}→
                {activeSim.art34_exposure.critical_gaps_after} crit.)
              </span>
            </div>
            <div className="text-xs text-dim truncate">
              {activeSim.art34_exposure.plafond_label}
            </div>
          </div>

          {/* KPI 4 : Quick-Wins */}
          <div className="pt-3 pb-2 pr-4 xl:pl-4 xl:border-l border-hairline space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-sub inline-flex items-center gap-1">
                <Zap className="w-3.5 h-3.5 text-accent" />
                Quick-Wins
              </span>
              <span className="badge-success text-[13px] font-semibold px-2 py-0.5 rounded-full">
                Effort Faible
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold text-main tabular-nums">
                {quickWins.length}
              </span>
              <span className="text-xs text-sub">
                action(s) J+30
              </span>
            </div>
            <div className="text-xs text-sub tabular-nums">
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
                    <span className="text-xs text-dim">
                      ({p.article})
                    </span>
                  </div>
                  <div className="text-xs shrink-0 tabular-nums">
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
                      className="h-full bg-[var(--deloitte)] transition-all duration-300"
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

      {/* COLONNES 30 / 60 / 90 JOURS : LISTE ÉDITORIALE À FILETS + DÉTAILS DÉPLIABLES */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
        {(['0_30', '30_60', '60_90'] as const).map((hKey) => {
          const meta = HORIZON_META[hKey];
          const Icon = meta.icon;
          const items = roadmapItems.filter((i) => i.horizon === hKey);

          return (
            <section
              key={hKey}
              aria-labelledby={`horizon-${hKey}`}
              className="surface-panel rounded-2xl px-4 pt-4 pb-2 sm:px-5"
            >
              <header className="flex items-start justify-between gap-3 pb-3 border-b border-hairline">
                <div className="flex items-start gap-3 min-w-0">
                  <div
                    className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${meta.accentCls}`}
                  >
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-accent tabular-nums">
                      {meta.badge}
                    </p>
                    <h4
                      id={`horizon-${hKey}`}
                      className="text-[15px] leading-snug font-semibold text-main"
                    >
                      {meta.title}
                    </h4>
                  </div>
                </div>
                <span
                  className="mt-0.5 text-[13px] font-semibold text-sub tabular-nums"
                  aria-label={`${items.length} chantier${items.length > 1 ? 's' : ''}`}
                >
                  {items.length}
                </span>
              </header>

              {items.length === 0 ? (
                <p className="py-6 text-center text-xs text-dim">
                  Aucun chantier sur cet horizon.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--border-subtle)]">
                  {items.map((it) => {
                    const isAlreadyCompliant = it.finding.statut === 'conforme';
                    const isDone = Boolean(completedIds[it.finding.id]);
                    const isExpanded = Boolean(expandedIds[it.finding.id]);
                    const gravMeta =
                      GRAVITE_BADGE[it.finding.gravite] || GRAVITE_BADGE.moyenne;
                    const detailsId = `roadmap-details-${it.finding.id}`;

                    return (
                      <li key={it.finding.id} className="py-3">
                        <div className="flex items-start gap-2">
                          {/* Case de simulation : 20 px visibles, cible 28 px */}
                          {isAlreadyCompliant ? (
                            <span
                              className="w-7 h-7 -ml-1 flex items-center justify-center shrink-0"
                              title="Contrôle déjà conforme"
                            >
                              <CheckCircle2
                                className="w-5 h-5 text-accent"
                                aria-label="Contrôle déjà conforme"
                              />
                            </span>
                          ) : (
                            <label
                              className="w-7 h-7 -ml-1 flex items-center justify-center shrink-0 cursor-pointer rounded-lg hover:bg-[var(--bg-hover)] transition-colors"
                              title="Inclure dans la simulation"
                            >
                              <input
                                type="checkbox"
                                checked={isDone}
                                onChange={() =>
                                  setCompletedIds((prev) => ({
                                    ...prev,
                                    [it.finding.id]: !prev[it.finding.id],
                                  }))
                                }
                                aria-label={`Simuler la remédiation de ${it.finding.id}`}
                                className="w-5 h-5 accent-[var(--deloitte)] cursor-pointer"
                              />
                            </label>
                          )}

                          {/* Titre + méta : bouton de dépliage des détails */}
                          <button
                            type="button"
                            aria-expanded={isExpanded}
                            aria-controls={detailsId}
                            onClick={() => toggleExpanded(it.finding.id)}
                            title={isExpanded ? 'Masquer les détails' : 'Afficher les détails'}
                            className="group flex-1 min-w-0 flex items-start gap-2 text-left cursor-pointer pt-0.5"
                          >
                            <span className="flex-1 min-w-0">
                            <span className="flex items-baseline gap-2">
                              <span className="font-mono text-xs font-semibold text-sub shrink-0">
                                {it.finding.id}
                              </span>
                              <span
                                className={`text-sm leading-snug font-semibold text-main line-clamp-2 group-hover:underline underline-offset-2 decoration-[var(--border-strong)] ${
                                  isDone ? 'line-through decoration-[var(--text-muted)]' : ''
                                }`}
                              >
                                {it.finding.theme}
                              </span>
                            </span>
                            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-sub">
                              <span
                                className={`font-semibold ${
                                  isAlreadyCompliant
                                    ? 'tone-success'
                                    : gravMeta.tone
                                }`}
                              >
                                {isAlreadyCompliant ? 'Conforme' : gravMeta.label}
                              </span>
                              <span aria-hidden="true" className="text-dim">·</span>
                              <span className="tabular-nums">{it.workloadEstimate}</span>
                              {it.finding.commande_correction && (
                                <>
                                  <span aria-hidden="true" className="text-dim">·</span>
                                  <span className="inline-flex items-center gap-1">
                                    <Terminal className="w-3 h-3 text-accent" />
                                    gcloud
                                  </span>
                                </>
                              )}
                            </span>
                            </span>
                            <ChevronDown
                              aria-hidden="true"
                              className={`mt-1 w-4 h-4 shrink-0 text-dim group-hover:text-main transition-transform duration-200 ${
                                isExpanded ? 'rotate-180 text-accent' : ''
                              }`}
                            />
                          </button>

                          <button
                            type="button"
                            onClick={() => onSelectFinding(it.finding)}
                            title="Ouvrir l'inspecteur de preuve"
                            aria-label={`Ouvrir l'inspecteur de preuve pour ${it.finding.id}`}
                            className="w-7 h-7 -mr-1 flex items-center justify-center rounded-lg text-accent hover:bg-[var(--bg-hover)] shrink-0 cursor-pointer transition-colors"
                          >
                            <ArrowUpRight className="w-4 h-4" />
                          </button>
                        </div>

                        {/* Détails (exigence, porteur, Dit / Écrit / Réel, action, gcloud) */}
                        {isExpanded && (
                          <div
                            id={detailsId}
                            className="mt-3 ml-8 space-y-3 text-xs text-sub"
                          >
                            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                              <dt className="text-dim">Exigence</dt>
                              <dd className="text-main">{it.finding.exigence_nis2}</dd>
                              <dt className="text-dim">Porteur</dt>
                              <dd className="text-main">{it.ownerRole}</dd>
                            </dl>

                            {(it.finding.dit || it.finding.ecrit || it.finding.reel) && (
                              <div className="space-y-1 pl-3 border-l border-hairline">
                                {it.finding.dit && (
                                  <p className="line-clamp-2">
                                    <strong className="font-semibold text-[var(--dit)]">Dit</strong>{' '}
                                    « {it.finding.dit.extrait} »
                                  </p>
                                )}
                                {it.finding.ecrit && (
                                  <p className="line-clamp-2">
                                    <strong className="font-semibold text-[var(--ecrit)]">Écrit</strong>{' '}
                                    « {it.finding.ecrit.extrait} »
                                  </p>
                                )}
                                {it.finding.reel && (
                                  <p className="line-clamp-2">
                                    <strong className="font-semibold text-[var(--reel)]">Réel</strong>{' '}
                                    {it.finding.reel.constat}
                                  </p>
                                )}
                              </div>
                            )}

                            <p className="leading-relaxed">
                              <strong className="font-semibold text-main">Action :</strong>{' '}
                              {it.finding.recommandation}
                            </p>

                            {it.finding.commande_correction && (
                              <pre className="px-3 py-2 rounded-lg surface-subtle border border-hairline font-mono text-xs text-main overflow-x-auto">
                                {it.finding.commande_correction}
                              </pre>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {/* MATRICE D'ARBITRAGE EFFORT × IMPACT CONDENSÉE */}
      <div className="surface-panel rounded-2xl p-4 sm:p-5 space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Target className="w-4 h-4 text-accent" />
            <h3 className="text-base font-semibold text-main">
              Matrice Effort × Impact NIS2
            </h3>
          </div>
          <span className="text-xs text-dim">
            4 quadrants d&apos;arbitrage
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Quadrant 1 */}
          <div className="surface-card rounded-xl p-3.5 edge-accent space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-bold text-main">
                1. Quick-Wins Prioritaires
              </span>
              <span className="badge-success text-[13px] font-semibold px-2 py-0.5 rounded-full">
                Impact Fort • Effort Faible
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {quickWins.length === 0 ? (
                <span className="text-xs text-dim">Aucun élément</span>
              ) : (
                quickWins.map((it) => (
                  <button
                    key={it.finding.id}
                    type="button"
                    onClick={() => onSelectFinding(it.finding)}
                    className="inline-flex items-center gap-1.5 text-left px-2.5 py-1 rounded-lg surface-subtle hover:border-[var(--deloitte)] text-[13px] font-semibold text-main transition cursor-pointer"
                  >
                    <span className="font-mono text-xs px-1.5 py-0.5 rounded surface-subtle border border-hairline text-main whitespace-nowrap shrink-0">
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
              <span className="text-[13px] font-bold text-main">
                2. Chantiers Structurants
              </span>
              <span className="badge-warning text-[13px] font-semibold px-2 py-0.5 rounded-full">
                Impact Fort • Effort Modéré+
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {majorProjects.length === 0 ? (
                <span className="text-xs text-dim">Aucun élément</span>
              ) : (
                majorProjects.map((it) => (
                  <button
                    key={it.finding.id}
                    type="button"
                    onClick={() => onSelectFinding(it.finding)}
                    className="inline-flex items-center gap-1.5 text-left px-2.5 py-1 rounded-lg surface-subtle hover:border-[var(--warning-border)] text-[13px] font-semibold text-main transition cursor-pointer"
                  >
                    <span className="font-mono text-xs px-1.5 py-0.5 rounded badge-warning whitespace-nowrap shrink-0">
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
              <span className="text-[13px] font-bold text-main">
                3. Hygiène Opérationnelle
              </span>
              <span className="text-xs px-2 py-0.5 rounded-full surface-subtle text-sub">
                Effort Faible
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {hygieneItems.length === 0 ? (
                <span className="text-xs text-dim">Aucun élément</span>
              ) : (
                hygieneItems.map((it) => (
                  <button
                    key={it.finding.id}
                    type="button"
                    onClick={() => onSelectFinding(it.finding)}
                    className="inline-flex items-center gap-1.5 text-left px-2.5 py-1 rounded-lg surface-subtle text-xs font-semibold text-main cursor-pointer"
                  >
                    <span className="font-mono text-xs whitespace-nowrap shrink-0">{it.finding.id}</span>
                    <span>{it.finding.theme}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Quadrant 4 */}
          <div className="surface-card rounded-xl p-3.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-bold text-main">
                4. Maintien &amp; PRA
              </span>
              <span className="text-xs px-2 py-0.5 rounded-full surface-subtle text-sub">
                Amélioration continue
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {govItems.length === 0 ? (
                <span className="text-xs text-dim">Aucun élément</span>
              ) : (
                govItems.map((it) => (
                  <button
                    key={it.finding.id}
                    type="button"
                    onClick={() => onSelectFinding(it.finding)}
                    className="inline-flex items-center gap-1.5 text-left px-2.5 py-1 rounded-lg surface-subtle hover:border-strong text-xs font-semibold text-main cursor-pointer"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-accent" />
                    <span className="font-mono text-xs whitespace-nowrap shrink-0">{it.finding.id}</span>
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
