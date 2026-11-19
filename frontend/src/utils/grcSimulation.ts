import type {
  AuditMode,
  Finding,
  GrcDecisionType,
  RemediationSimulationResult,
  SimulatedHorizonWorkload,
  SimulatedPillarGain,
} from '../types';
import { computeMaturityScore } from './auditMetrics';

export const GRC_DECISION_META: Record<
  GrcDecisionType,
  {
    label: string;
    shortLabel: string;
    description: string;
    badgeCls: string;
    printCls: string;
  }
> = {
  a_corriger: {
    label: 'À corriger prioritairement',
    shortLabel: 'À corriger',
    description: 'Correction technique ou procédurale exigée sur l’horizon cible.',
    badgeCls: 'badge-critical',
    printCls: 'bg-rose-100 text-rose-900',
  },
  mesure_compensatoire: {
    label: 'Mesure compensatoire validée',
    shortLabel: 'Compensatoire ✓',
    description: 'Contrôle alternatif documenté couvrant le risque opérationnel.',
    badgeCls: 'badge-success',
    printCls: 'bg-emerald-100 text-emerald-900',
  },
  risque_accepte: {
    label: 'Risque accepté temporairement',
    shortLabel: 'Risque accepté',
    description: 'Dérogation formelle signée par la direction avec revue datée.',
    badgeCls: 'badge-warning',
    printCls: 'bg-amber-100 text-amber-900',
  },
  a_approfondir: {
    label: 'À approfondir',
    shortLabel: 'À approfondir',
    description: 'Vérification complémentaire ou preuve additionnelle attendue.',
    badgeCls: 'badge-info',
    printCls: 'bg-sky-100 text-sky-900',
  },
};

export const GRC_DECISION_OPTIONS: GrcDecisionType[] = [
  'a_corriger',
  'mesure_compensatoire',
  'risque_accepte',
  'a_approfondir',
];

function estimateFindingWorkload(f: Finding): {
  effort: 'faible' | 'modere' | 'structurant';
  minJh: number;
  maxJh: number;
  avgJh: number;
  horizon: '0_30' | '30_60' | '60_90';
} {
  if (f.statut === 'conforme') {
    return {
      effort: 'faible',
      minJh: 0,
      maxJh: 0,
      avgJh: 0,
      horizon: '60_90',
    };
  }

  const hay = `${f.theme} ${f.exigence_nis2} ${f.reel?.ressource || ''}`.toLowerCase();
  const cmd = f.commande_correction || '';
  const hasCli = Boolean(cmd.trim());

  let effort: 'faible' | 'modere' | 'structurant' = 'modere';
  let minJh = 3.0;
  let maxJh = 6.0;
  let avgJh = 4.5;

  if (
    hasCli &&
    /allusers|allow-ssh|firewall|versioning|retention/i.test(`${cmd} ${hay}`) &&
    !/iam|kms|serviceaccount/i.test(hay)
  ) {
    effort = 'faible';
    minJh = 0.5;
    maxJh = 2.0;
    avgJh = 1.25;
  } else if (
    /incident|notification|anssi|art\.\s*23|pacs|pra|pca|gouvernance/i.test(hay) &&
    !hasCli
  ) {
    effort = 'structurant';
    minJh = 8.0;
    maxJh = 15.0;
    avgJh = 11.5;
  } else if (/iam|kms|logging|journal|privil|serviceaccount|sauvegarde|backup/i.test(hay)) {
    effort = 'modere';
    minJh = 4.0;
    maxJh = 8.0;
    avgJh = 6.0;
  }

  let horizon: '0_30' | '30_60' | '60_90' = '30_60';
  if (effort === 'structurant' || f.gravite === 'faible' || f.gravite === 'moyenne') {
    horizon = '60_90';
  } else if (
    effort === 'faible' &&
    (f.gravite === 'critique' || f.gravite === 'haute')
  ) {
    horizon = '0_30';
  }

  return { effort, minJh, maxJh, avgJh, horizon };
}

function pillarSingleScore(f: Finding): number {
  if (f.statut === 'conforme') return 94;
  if (f.statut === 'partiel') return 55;
  if (f.statut === 'a_confirmer') return 42;
  return f.gravite === 'critique' ? 14 : 26;
}

function findingArt34Weight(f: Finding): number {
  if (f.statut === 'conforme') return 0;
  const base =
    f.gravite === 'critique'
      ? 100
      : f.gravite === 'haute'
      ? 75
      : f.gravite === 'moyenne'
      ? 45
      : 20;
  if (f.statut === 'partiel') return base * 0.45;
  if (f.statut === 'a_confirmer') return base * 0.55;
  return base;
}

function riskLevelFromIndex(riskIndex: number, criticalOpen: number): string {
  if (criticalOpen >= 1 || riskIndex >= 65) return 'CRITIQUE';
  if (riskIndex >= 35) return 'ÉLEVÉ';
  if (riskIndex >= 12) return 'MODÉRÉ';
  return 'MAÎTRISÉ';
}

function formatJhFr(val: number): string {
  return String(Math.round(val * 10) / 10).replace('.', ',');
}

/**
 * Calcul déterministe local du simulateur d'impact & ROI NIS2 (miroir exact de `/api/remediation/simulate`).
 */
export function computeLocalRemediationSimulation(
  findings: Finding[],
  selectedIds: string[],
  mode: AuditMode
): RemediationSimulationResult {
  const selectedSet = new Set(selectedIds.map((id) => id.trim().toUpperCase()));
  const remediatedIds: string[] = [];
  let actionableCount = 0;

  let totalMinJh = 0;
  let totalMaxJh = 0;
  let totalEstJh = 0;
  let quickWinsCount = 0;

  const byHorizon: Record<'0_30' | '30_60' | '60_90', SimulatedHorizonWorkload> = {
    '0_30': { count: 0, estimated_jh: 0, finding_ids: [] },
    '30_60': { count: 0, estimated_jh: 0, finding_ids: [] },
    '60_90': { count: 0, estimated_jh: 0, finding_ids: [] },
  };

  const projectedFindings: Finding[] = findings.map((f) => {
    const fid = f.id.trim().toUpperCase();
    const isActionable = f.statut !== 'conforme';
    if (isActionable) actionableCount += 1;

    const w = estimateFindingWorkload(f);
    const isRemediated = isActionable && selectedSet.has(fid);
    if (isRemediated) {
      remediatedIds.push(fid);
      totalMinJh += w.minJh;
      totalMaxJh += w.maxJh;
      totalEstJh += w.avgJh;
      if (w.effort === 'faible') quickWinsCount += 1;
      byHorizon[w.horizon].count += 1;
      byHorizon[w.horizon].estimated_jh =
        Math.round((byHorizon[w.horizon].estimated_jh + w.avgJh) * 10) / 10;
      byHorizon[w.horizon].finding_ids.push(fid);
      return { ...f, statut: 'conforme' };
    }
    return f;
  });

  const currentScore = computeMaturityScore(findings);
  const projectedScore = computeMaturityScore(projectedFindings);

  const pillarSpecs: Array<{
    id: string;
    title: string;
    article: string;
    fallback: number;
    pred: (f: Finding) => boolean;
  }> = [
    {
      id: 'data-exposure',
      title: 'Protection & Cloisonnement des Données de Santé',
      article: 'Art. 21 §2 (i) — Stockage',
      fallback: 20,
      pred: (x) =>
        /radiologie|exposition des données|public|allusers/i.test(
          `${x.theme} ${x.reel?.ressource || ''}`
        ),
    },
    {
      id: 'network-sec',
      title: 'Sécurité Réseau & Administration Système',
      article: 'Art. 21 §2 (i) — Flux',
      fallback: 20,
      pred: (x) =>
        /ssh|pare-feu|réseau|firewall|bastion/i.test(
          `${x.theme} ${x.reel?.ressource || ''}`
        ),
    },
    {
      id: 'backup-pca',
      title: 'Continuité d’Activité & Immuabilité des Sauvegardes',
      article: 'Art. 21 §2 (c) — PCA / PRA',
      fallback: 50,
      pred: (x) =>
        /sauvegarde|continuité|pacs|dpi|restauration|backup/i.test(
          `${x.theme} ${x.exigence_nis2} ${x.reel?.ressource || ''}`
        ),
    },
    {
      id: 'iam-crypto',
      title: 'Gouvernance IAM, Moindre Privilège & Cryptographie KMS',
      article: 'Art. 21 §2 (h, i, j)',
      fallback: 62,
      pred: (x) =>
        /iam|kms|chiffrement|cryptographie|serviceaccount|privil|clé/i.test(
          `${x.theme} ${x.exigence_nis2} ${x.reel?.ressource || ''}`
        ) &&
        !/radiologie|ssh/i.test(`${x.theme} ${x.reel?.ressource || ''}`),
    },
    {
      id: 'incident-anssi',
      title: 'Gestion des Incidents & Notification ANSSI',
      article: 'Art. 23 — 24h / 72h / 1 mois',
      fallback: mode === 'AVANT' ? 48 : 22,
      pred: (x) =>
        /incident|notification|anssi|art\.\s*23/i.test(
          `${x.theme} ${x.exigence_nis2}`
        ),
    },
  ];

  const remediatedSet = new Set(remediatedIds);
  const pillars: SimulatedPillarGain[] = pillarSpecs.map((spec) => {
    const curMatched = findings.filter(spec.pred);
    const projMatched = projectedFindings.filter(spec.pred);
    if (curMatched.length === 0) {
      return {
        id: spec.id,
        title: spec.title,
        article: spec.article,
        current_score: spec.fallback,
        projected_score: spec.fallback,
        gain: 0,
        finding_ids: [],
        remediated_ids: [],
      };
    }
    const curP = Math.round(
      curMatched.reduce((acc, f) => acc + pillarSingleScore(f), 0) /
        curMatched.length
    );
    const projP = Math.round(
      projMatched.reduce((acc, f) => acc + pillarSingleScore(f), 0) /
        projMatched.length
    );
    const fIds = curMatched.map((f) => f.id);
    return {
      id: spec.id,
      title: spec.title,
      article: spec.article,
      current_score: curP,
      projected_score: projP,
      gain: projP - curP,
      finding_ids: fIds,
      remediated_ids: fIds.filter((id) => remediatedSet.has(id.toUpperCase())),
    };
  });

  const riskBeforeRaw = findings.reduce((acc, f) => acc + findingArt34Weight(f), 0);
  const riskAfterRaw = projectedFindings.reduce(
    (acc, f) => acc + findingArt34Weight(f),
    0
  );
  const maxRisk = Math.max(100, findings.length * 100);
  const currentRiskIndex = findings.length
    ? Math.min(100, Math.round((riskBeforeRaw / maxRisk) * 100))
    : 0;
  const projectedRiskIndex = findings.length
    ? Math.min(100, Math.round((riskAfterRaw / maxRisk) * 100))
    : 0;
  const exposureReductionPct =
    riskBeforeRaw > 0
      ? Math.round(((riskBeforeRaw - riskAfterRaw) / riskBeforeRaw) * 1000) / 10
      : 0;

  const critBefore = findings.filter(
    (f) => f.statut !== 'conforme' && f.gravite === 'critique'
  ).length;
  const critAfter = projectedFindings.filter(
    (f) => f.statut !== 'conforme' && f.gravite === 'critique'
  ).length;

  const estJh = Math.round(totalEstJh * 10) / 10;
  const minJh = Math.round(totalMinJh * 10) / 10;
  const maxJh = Math.round(totalMaxJh * 10) / 10;

  return {
    mode,
    source: 'local',
    selected_ids: Array.from(selectedSet),
    remediated_ids: remediatedIds,
    total_findings: findings.length,
    actionable_findings: actionableCount,
    current_score: currentScore,
    projected_score: projectedScore,
    score_delta: projectedScore - currentScore,
    workload_jh: {
      estimated_jh: estJh,
      min_jh: minJh,
      max_jh: maxJh,
      label:
        estJh > 0
          ? `${formatJhFr(estJh)} j.h (fourchette ${formatJhFr(minJh)} – ${formatJhFr(maxJh)} j.h)`
          : '0 j.h',
      quick_wins_count: quickWinsCount,
      by_horizon: byHorizon,
    },
    art34_exposure: {
      entity_category: 'Entité Essentielle (Annexe I — Santé)',
      article: 'Art. 34 §4 Directive (UE) 2022/2555 (NIS2)',
      plafond_sanction_eur: 10_000_000,
      plafond_ca_pct: 2.0,
      plafond_label: "Jusqu'à 10 M€ ou 2 % du CA annuel mondial",
      current_risk_index: currentRiskIndex,
      projected_risk_index: projectedRiskIndex,
      exposure_reduction_pct: exposureReductionPct,
      critical_gaps_before: critBefore,
      critical_gaps_after: critAfter,
      risk_level_before: riskLevelFromIndex(currentRiskIndex, critBefore),
      risk_level_after: riskLevelFromIndex(projectedRiskIndex, critAfter),
    },
    pillars,
  };
}

/**
 * Normalise la réponse serveur de `POST /api/remediation/simulate`.
 */
export function normalizeServerSimulation(
  payload: unknown,
  fallbackMode: AuditMode
): RemediationSimulationResult | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (
    typeof obj.current_score !== 'number' ||
    typeof obj.projected_score !== 'number'
  ) {
    return null;
  }

  const wl =
    obj.workload_jh && typeof obj.workload_jh === 'object'
      ? (obj.workload_jh as Record<string, unknown>)
      : {};
  const rawHorizon =
    wl.by_horizon && typeof wl.by_horizon === 'object'
      ? (wl.by_horizon as Record<string, Record<string, unknown>>)
      : {};

  const parseH = (key: '0_30' | '30_60' | '60_90'): SimulatedHorizonWorkload => {
    const h = rawHorizon[key] || {};
    return {
      count: typeof h.count === 'number' ? h.count : 0,
      estimated_jh: typeof h.estimated_jh === 'number' ? h.estimated_jh : 0,
      finding_ids: Array.isArray(h.finding_ids)
        ? h.finding_ids.filter((x): x is string => typeof x === 'string')
        : [],
    };
  };

  const art34 =
    obj.art34_exposure && typeof obj.art34_exposure === 'object'
      ? (obj.art34_exposure as Record<string, unknown>)
      : {};

  const rawPillars = Array.isArray(obj.pillars) ? obj.pillars : [];
  const pillars: SimulatedPillarGain[] = rawPillars
    .map((p): SimulatedPillarGain | null => {
      if (!p || typeof p !== 'object') return null;
      const item = p as Record<string, unknown>;
      if (typeof item.id !== 'string' || typeof item.title !== 'string') {
        return null;
      }
      const cur = typeof item.current_score === 'number' ? item.current_score : 0;
      const proj =
        typeof item.projected_score === 'number' ? item.projected_score : cur;
      return {
        id: item.id,
        title: item.title,
        article: typeof item.article === 'string' ? item.article : '',
        current_score: cur,
        projected_score: proj,
        gain: typeof item.gain === 'number' ? item.gain : proj - cur,
        finding_ids: Array.isArray(item.finding_ids)
          ? item.finding_ids.filter((x): x is string => typeof x === 'string')
          : [],
        remediated_ids: Array.isArray(item.remediated_ids)
          ? item.remediated_ids.filter((x): x is string => typeof x === 'string')
          : [],
      };
    })
    .filter((p): p is SimulatedPillarGain => p !== null);

  return {
    mode:
      obj.mode === 'AVANT' || obj.mode === 'APRES' ? obj.mode : fallbackMode,
    source: 'server',
    selected_ids: Array.isArray(obj.selected_ids)
      ? obj.selected_ids.filter((x): x is string => typeof x === 'string')
      : [],
    remediated_ids: Array.isArray(obj.remediated_ids)
      ? obj.remediated_ids.filter((x): x is string => typeof x === 'string')
      : [],
    total_findings:
      typeof obj.total_findings === 'number' ? obj.total_findings : 0,
    actionable_findings:
      typeof obj.actionable_findings === 'number' ? obj.actionable_findings : 0,
    current_score: obj.current_score,
    projected_score: obj.projected_score,
    score_delta:
      typeof obj.score_delta === 'number'
        ? obj.score_delta
        : obj.projected_score - obj.current_score,
    workload_jh: {
      estimated_jh: typeof wl.estimated_jh === 'number' ? wl.estimated_jh : 0,
      min_jh: typeof wl.min_jh === 'number' ? wl.min_jh : 0,
      max_jh: typeof wl.max_jh === 'number' ? wl.max_jh : 0,
      label: typeof wl.label === 'string' ? wl.label : '0 j.h',
      quick_wins_count:
        typeof wl.quick_wins_count === 'number' ? wl.quick_wins_count : 0,
      by_horizon: {
        '0_30': parseH('0_30'),
        '30_60': parseH('30_60'),
        '60_90': parseH('60_90'),
      },
    },
    art34_exposure: {
      entity_category:
        typeof art34.entity_category === 'string'
          ? art34.entity_category
          : 'Entité Essentielle (Annexe I — Santé)',
      article:
        typeof art34.article === 'string'
          ? art34.article
          : 'Art. 34 §4 Directive (UE) 2022/2555 (NIS2)',
      plafond_sanction_eur:
        typeof art34.plafond_sanction_eur === 'number'
          ? art34.plafond_sanction_eur
          : 10_000_000,
      plafond_ca_pct:
        typeof art34.plafond_ca_pct === 'number' ? art34.plafond_ca_pct : 2.0,
      plafond_label:
        typeof art34.plafond_label === 'string'
          ? art34.plafond_label
          : "Jusqu'à 10 M€ ou 2 % du CA annuel mondial",
      current_risk_index:
        typeof art34.current_risk_index === 'number'
          ? art34.current_risk_index
          : 0,
      projected_risk_index:
        typeof art34.projected_risk_index === 'number'
          ? art34.projected_risk_index
          : 0,
      exposure_reduction_pct:
        typeof art34.exposure_reduction_pct === 'number'
          ? art34.exposure_reduction_pct
          : 0,
      critical_gaps_before:
        typeof art34.critical_gaps_before === 'number'
          ? art34.critical_gaps_before
          : 0,
      critical_gaps_after:
        typeof art34.critical_gaps_after === 'number'
          ? art34.critical_gaps_after
          : 0,
      risk_level_before:
        typeof art34.risk_level_before === 'string'
          ? art34.risk_level_before
          : 'MODÉRÉ',
      risk_level_after:
        typeof art34.risk_level_after === 'string'
          ? art34.risk_level_after
          : 'MAÎTRISÉ',
    },
    pillars,
  };
}
