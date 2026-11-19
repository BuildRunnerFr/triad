import type {
  AuditSynthesis,
  Finding,
  GraviteFinding,
  ServerAuditDiffResponse,
  StatutFinding,
} from '../types';

export const GRAVITE_RANK: Record<GraviteFinding, number> = {
  critique: 4,
  haute: 3,
  moyenne: 2,
  faible: 1,
};

export const STATUT_RISK_RANK: Record<StatutFinding, number> = {
  non_conforme: 4,
  partiel: 3,
  a_confirmer: 2,
  conforme: 1,
};

export function computeMaturityScore(findings: Finding[]): number {
  if (!findings.length) return 0;
  const sum = findings.reduce((acc, f) => {
    if (f.statut === 'conforme') return acc + 100;
    if (f.statut === 'partiel') return acc + 55;
    if (f.statut === 'a_confirmer') return acc + 40;
    return acc;
  }, 0);
  return Math.round(sum / findings.length);
}

export type ComparisonCategory =
  | 'dit_contradiction'
  | 'confirmed_gap'
  | 'new_gap'
  | 'resolved_or_compliant';

export interface ComparedFindingItem {
  key: string;
  id: string;
  theme: string;
  exigence_nis2: string;
  avant: Finding | null;
  apres: Finding | null;
  category: ComparisonCategory;
  categoryLabel: string;
  isDitContradiction: boolean;
  isNewGap: boolean;
  isConfirmedGap: boolean;
  isResolvedOrCompliant: boolean;
}

export interface AuditComparisonSummary {
  scoreAvant: number;
  scoreApres: number;
  scoreDelta: number;
  ditContradictionsCount: number;
  confirmedGapsCount: number;
  newGapsCount: number;
  resolvedOrCompliantCount: number;
  items: ComparedFindingItem[];
}

function normalizeMatchKey(f: Finding): string {
  if (f.reel?.ressource) {
    return `res:${f.reel.ressource.trim().toLowerCase()}`;
  }
  return `theme:${f.theme.trim().toLowerCase()}`;
}

export function matchesComparisonFilter(
  item: ComparedFindingItem,
  filter: 'ALL' | ComparisonCategory
): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'dit_contradiction') return item.isDitContradiction;
  if (filter === 'confirmed_gap') return item.isConfirmedGap;
  if (filter === 'new_gap') return item.isNewGap;
  if (filter === 'resolved_or_compliant') return item.isResolvedOrCompliant;
  return true;
}

export function compareSyntheses(
  avantSyn: AuditSynthesis,
  apresSyn: AuditSynthesis
): AuditComparisonSummary {
  const avantList = avantSyn.findings || [];
  const apresList = apresSyn.findings || [];

  const matchedAvantIds = new Set<string>();
  const items: ComparedFindingItem[] = [];

  for (const ap of apresList) {
    // Correspondance prioritaire par identifiant exact, puis par ressource/thème
    let av = avantList.find((x) => x.id === ap.id && !matchedAvantIds.has(x.id)) || null;
    if (!av) {
      const targetKey = normalizeMatchKey(ap);
      av =
        avantList.find(
          (x) => !matchedAvantIds.has(x.id) && normalizeMatchKey(x) === targetKey
        ) || null;
    }
    if (av) {
      matchedAvantIds.add(av.id);
    }

    const contradictionStr = (ap.contradiction || '').toLowerCase();
    const avantContradictionStr = (av?.contradiction || '').toLowerCase();
    const isDitContradiction =
      contradictionStr.includes('dit') && !avantContradictionStr.includes('dit');
    const isResolvedOrCompliant = ap.statut === 'conforme';
    const isNewGap = !av && ap.statut !== 'conforme';
    const isConfirmedGap = Boolean(
      av && av.statut !== 'conforme' && ap.statut !== 'conforme'
    );

    let category: ComparisonCategory;
    let categoryLabel: string;

    if (isResolvedOrCompliant) {
      category = 'resolved_or_compliant';
      categoryLabel =
        av && av.statut !== 'conforme'
          ? 'Écart levé post-entretien'
          : 'Contrôle conforme validé';
    } else if (isDitContradiction) {
      category = 'dit_contradiction';
      categoryLabel = contradictionStr.includes('réel')
        ? 'Rupture Dit ≠ Réel dévoilée'
        : 'Rupture Dit ≠ Écrit dévoilée';
    } else if (isNewGap) {
      category = 'new_gap';
      categoryLabel = 'Nouvel écart post-entretien';
    } else {
      category = 'confirmed_gap';
      categoryLabel = 'Écart technique confirmé';
    }

    items.push({
      key: `${av?.id || 'none'}-${ap.id}`,
      id: ap.id,
      theme: ap.theme,
      exigence_nis2: ap.exigence_nis2,
      avant: av,
      apres: ap,
      category,
      categoryLabel,
      isDitContradiction,
      isNewGap,
      isConfirmedGap,
      isResolvedOrCompliant,
    });
  }

  // Contrôles présents en AVANT mais absents en APRÈS (levés ou requalifiés)
  for (const av of avantList) {
    if (matchedAvantIds.has(av.id)) continue;
    items.push({
      key: `${av.id}-resolved`,
      id: av.id,
      theme: av.theme,
      exigence_nis2: av.exigence_nis2,
      avant: av,
      apres: null,
      category: 'resolved_or_compliant',
      categoryLabel: 'Point pré-entretien clos',
      isDitContradiction: false,
      isNewGap: false,
      isConfirmedGap: false,
      isResolvedOrCompliant: true,
    });
  }

  const scoreAvant = computeMaturityScore(avantList);
  const scoreApres = computeMaturityScore(apresList);

  return {
    scoreAvant,
    scoreApres,
    scoreDelta: scoreApres - scoreAvant,
    ditContradictionsCount: items.filter((i) => i.isDitContradiction).length,
    confirmedGapsCount: items.filter((i) => i.isConfirmedGap).length,
    newGapsCount: items.filter((i) => i.isNewGap).length,
    resolvedOrCompliantCount: items.filter((i) => i.isResolvedOrCompliant).length,
    items,
  };
}

/** Génère des alias de recherche pratiques pour F-001 -> "F-001 F-01 F1" */
export function buildFindingAliases(id: string): string[] {
  const match = id.match(/^([A-Za-z]+)-?0*(\d+)$/);
  if (!match) return [id];
  const prefix = match[1].toUpperCase();
  const num = match[2];
  return [
    id,
    `${prefix}-${num.padStart(3, '0')}`,
    `${prefix}-${num.padStart(2, '0')}`,
    `${prefix}-${num}`,
    `${prefix}${num}`,
  ];
}

/**
 * Convertit la réponse officielle `GET /api/audit/diff` en `AuditComparisonSummary`
 * utilisé par le Comparateur AVANT vs APRÈS.
 */
export function mapServerDiffToComparisonSummary(
  diff: ServerAuditDiffResponse
): AuditComparisonSummary | null {
  if (!diff || !diff.ready || !Array.isArray(diff.items)) return null;

  const scoreAvant =
    typeof diff.score_nis2?.avant === 'number' ? diff.score_nis2.avant : 0;
  const scoreApres =
    typeof diff.score_nis2?.apres === 'number' ? diff.score_nis2.apres : 0;
  const scoreDelta =
    typeof diff.score_nis2?.delta === 'number'
      ? diff.score_nis2.delta
      : scoreApres - scoreAvant;

  const items: ComparedFindingItem[] = diff.items.map((it, idx) => ({
    key: `${it.avant?.id || 'none'}-${it.apres?.id || it.id}-${idx}`,
    id: it.id,
    theme: it.theme,
    exigence_nis2: it.exigence_nis2,
    avant: it.avant || null,
    apres: it.apres || null,
    category: it.category,
    categoryLabel: it.category_label,
    isDitContradiction: Boolean(it.is_dit_contradiction),
    isNewGap: Boolean(it.is_new_gap),
    isConfirmedGap: Boolean(it.is_confirmed_gap),
    isResolvedOrCompliant: Boolean(it.is_resolved_or_compliant),
  }));

  return {
    scoreAvant,
    scoreApres,
    scoreDelta,
    ditContradictionsCount:
      typeof diff.counts?.ruptures_dit === 'number'
        ? diff.counts.ruptures_dit
        : items.filter((i) => i.isDitContradiction).length,
    confirmedGapsCount:
      typeof diff.counts?.ecarts_confirmes === 'number'
        ? diff.counts.ecarts_confirmes
        : items.filter((i) => i.isConfirmedGap).length,
    newGapsCount:
      typeof diff.counts?.nouveaux_constats === 'number'
        ? diff.counts.nouveaux_constats
        : items.filter((i) => i.isNewGap).length,
    resolvedOrCompliantCount:
      typeof diff.counts?.conformes_ou_leves === 'number'
        ? diff.counts.conformes_ou_leves
        : items.filter((i) => i.isResolvedOrCompliant).length,
    items,
  };
}

export const CANONICAL_AGENTS = [
  {
    key: 'Douanier',
    label: 'Douanier',
    shortRole: 'Sas DLP & Anti-Injection',
  },
  {
    key: 'AnalysteConformite',
    label: 'Analyste Conformité',
    shortRole: 'NIS2 × Sondes GCP',
  },
  {
    key: 'ContreAuditeur',
    label: 'Contre-Auditeur',
    shortRole: 'Preuve Textuelle Exacte',
  },
  {
    key: 'GardeDuCorps',
    label: 'Garde du Corps',
    shortRole: 'Registre SHA-256',
  },
] as const;

export function hasAgentTimings(
  timings?: Record<string, number> | null
): timings is Record<string, number> {
  if (!timings || typeof timings !== 'object') return false;
  return CANONICAL_AGENTS.some(
    (ag) =>
      typeof timings[ag.key] === 'number' && Number.isFinite(timings[ag.key])
  );
}

export function formatAgentTimingMs(ms: number | undefined | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms === 0) return '< 1 ms';
  if (ms < 1) return `${ms.toFixed(1).replace('.', ',')} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2).replace('.', ',')} s`;
}

export function sumAgentTimingsMs(
  timings?: Record<string, number> | null
): number | null {
  if (!hasAgentTimings(timings)) return null;
  return CANONICAL_AGENTS.reduce((acc, ag) => {
    const val = timings[ag.key];
    return typeof val === 'number' && Number.isFinite(val) && val >= 0
      ? acc + val
      : acc;
  }, 0);
}
