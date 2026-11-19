import type { AuditMode, Finding, StatutFinding } from '../types';

export type Nis2CoverageStatus =
  | 'conforme'
  | 'non_conforme'
  | 'partiel'
  | 'a_confirmer'
  | 'non_couvert';

export interface CanonicalNis2Requirement {
  id: string;
  article: string;
  theme: string;
  intitule_resume: string;
  mots_cles: string[];
  type_verification: string[];
}

export interface Nis2RequirementCoverageItem {
  id: string;
  article: string;
  theme: string;
  intitule_resume: string;
  type_verification: string[];
  statut: Nis2CoverageStatus;
  finding_ids: string[];
}

export interface Nis2CoverageReport {
  referentiel: string;
  mode: AuditMode;
  source: 'server' | 'local';
  totalRequirements: number;
  coveredCount: number;
  coverageRatePct: number;
  counts: Record<Nis2CoverageStatus, number>;
  items: Nis2RequirementCoverageItem[];
}

/**
 * Référentiel canonique des 11 exigences de la Directive (UE) 2022/2555 (NIS2)
 * en miroir strict de `data/referentiel_nis2.json`.
 */
export const CANONICAL_NIS2_REQUIREMENTS: CanonicalNis2Requirement[] = [
  {
    id: 'NIS2-21-2-a',
    article: 'Art. 21 §2 (a)',
    theme: 'Gouvernance et risques',
    intitule_resume:
      "Politiques d'analyse des risques et de sécurité des systèmes d'information",
    mots_cles: [
      'pssi',
      'analyse de risques',
      'ebios',
      'gouvernance',
      'politique de sécurité',
    ],
    type_verification: ['documentaire', 'entretien'],
  },
  {
    id: 'NIS2-21-2-b',
    article: 'Art. 21 §2 (b)',
    theme: 'Gestion des incidents',
    intitule_resume:
      'Procédures de détection, traitement et réponse aux incidents de sécurité',
    mots_cles: [
      'incident',
      'détection',
      'cellule de crise',
      'journaux',
      'audit log',
      'réponse',
    ],
    type_verification: ['documentaire', 'entretien'],
  },
  {
    id: 'NIS2-21-2-c',
    article: 'Art. 21 §2 (c)',
    theme: 'Sauvegardes et continuité',
    intitule_resume:
      'Continuité des activités, gestion des sauvegardes protégées, reprise après sinistre et gestion de crise',
    mots_cles: [
      'sauvegarde',
      'backup',
      'versioning',
      'rétention',
      'immuabilité',
      'pra',
      'pca',
      'restauration',
      'rto',
      'rpo',
    ],
    type_verification: ['documentaire', 'technique_gcp', 'entretien'],
  },
  {
    id: 'NIS2-21-2-d',
    article: 'Art. 21 §2 (d)',
    theme: 'Gouvernance et risques',
    intitule_resume:
      "Sécurité de la chaîne d'approvisionnement et relations avec les fournisseurs et prestataires",
    mots_cles: [
      'fournisseur',
      'prestataire',
      'sous-traitant',
      "chaîne d'approvisionnement",
      'contrat',
    ],
    type_verification: ['documentaire', 'entretien'],
  },
  {
    id: 'NIS2-21-2-e',
    article: 'Art. 21 §2 (e)',
    theme: 'Gouvernance et risques',
    intitule_resume:
      "Sécurité lors de l'acquisition, du développement et de la maintenance des systèmes, y compris gestion des vulnérabilités",
    mots_cles: [
      'vulnérabilité',
      'maintenance',
      'développement',
      'correctif',
      'scan',
    ],
    type_verification: ['documentaire'],
  },
  {
    id: 'NIS2-21-2-f',
    article: 'Art. 21 §2 (f)',
    theme: 'Gouvernance et risques',
    intitule_resume:
      "Politiques et procédures d'évaluation de l'efficacité des mesures de cybersécurité",
    mots_cles: ['audit', 'contrôle', 'test', 'efficacité', 'comité cyber'],
    type_verification: ['documentaire', 'entretien'],
  },
  {
    id: 'NIS2-21-2-g',
    article: 'Art. 21 §2 (g)',
    theme: 'Gouvernance et risques',
    intitule_resume:
      "Pratiques de base en matière d'hygiène informatique et formation à la cybersécurité",
    mots_cles: ['sensibilisation', 'formation', 'hygiène', 'personnel'],
    type_verification: ['documentaire', 'entretien'],
  },
  {
    id: 'NIS2-21-2-h',
    article: 'Art. 21 §2 (h)',
    theme: 'Exposition des données',
    intitule_resume:
      "Politiques et procédures relatives à l'utilisation de la cryptographie et du chiffrement",
    mots_cles: [
      'chiffrement',
      'cryptographie',
      'kms',
      'aes',
      'tls',
      'rotation',
    ],
    type_verification: ['documentaire'],
  },
  {
    id: 'NIS2-21-2-i',
    article: 'Art. 21 §2 (i)',
    theme: 'Exposition des données et accès',
    intitule_resume:
      "Sécurité des ressources humaines, politiques de contrôle d'accès, exposition réseau et gestion des actifs",
    mots_cles: [
      "contrôle d'accès",
      'moindre privilège',
      'bucket',
      'public',
      'allusers',
      'pare-feu',
      'firewall',
      'ssh',
      'rdp',
      'vpn',
      'bastion',
    ],
    type_verification: ['documentaire', 'technique_gcp', 'entretien'],
  },
  {
    id: 'NIS2-21-2-j',
    article: 'Art. 21 §2 (j)',
    theme: 'Exposition des données et accès',
    intitule_resume:
      "Recours à l'authentification multifacteur (MFA) et aux communications sécurisées",
    mots_cles: ['mfa', 'authentification forte', 'multifacteur', 'accès distant'],
    type_verification: ['documentaire', 'entretien'],
  },
  {
    id: 'NIS2-23',
    article: 'Art. 23',
    theme: 'Gestion des incidents',
    intitule_resume:
      'Obligation de notification des incidents significatifs : alerte précoce sous 24 h, notification sous 72 h et rapport final sous 1 mois',
    mots_cles: [
      'anssi',
      '24 h',
      '72 h',
      '1 mois',
      'notification',
      'incident significatif',
      'alerte précoce',
    ],
    type_verification: ['documentaire', 'entretien'],
  },
];

const STATUS_SEVERITY: Record<StatutFinding, number> = {
  non_conforme: 4,
  partiel: 3,
  a_confirmer: 2,
  conforme: 1,
};

export const COVERAGE_STATUS_META: Record<
  Nis2CoverageStatus,
  { label: string; shortLabel: string; badgeCls: string; printCls: string }
> = {
  conforme: {
    label: 'Conforme',
    shortLabel: 'Conforme ✓',
    badgeCls: 'badge-success',
    printCls: 'bg-emerald-100 text-emerald-900',
  },
  partiel: {
    label: 'Partiel',
    shortLabel: 'Partiel',
    badgeCls: 'badge-warning',
    printCls: 'bg-amber-100 text-amber-900',
  },
  a_confirmer: {
    label: 'À confirmer',
    shortLabel: 'À confirmer',
    badgeCls: 'badge-info',
    printCls: 'bg-sky-100 text-sky-900',
  },
  non_conforme: {
    label: 'Non conforme',
    shortLabel: 'Non conforme',
    badgeCls: 'badge-critical',
    printCls: 'bg-rose-100 text-rose-900',
  },
  non_couvert: {
    label: 'À couvrir',
    shortLabel: 'À couvrir',
    badgeCls: 'surface-subtle text-sub border border-hairline',
    printCls: 'bg-slate-100 text-slate-600',
  },
};

export const VERIFICATION_TYPE_LABELS: Record<string, string> = {
  documentaire: 'Écrit (PSSI)',
  technique_gcp: 'Réel (GCP)',
  entretien: 'Dit (DSI)',
};

function normalizeCompact(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

function matchesRequirementArticle(
  f: Finding,
  req: CanonicalNis2Requirement
): boolean {
  if (f.lot_nis2 && f.lot_nis2.toUpperCase() === req.id.toUpperCase()) {
    return true;
  }
  const exCompact = normalizeCompact(f.exigence_nis2 || '');
  const artCompact = normalizeCompact(req.article);
  if (exCompact.includes(artCompact)) {
    return true;
  }
  // Correspondance souple ex. "Art. 21(2)(c)" ou "Article 23"
  const subLetter = req.id.match(/^NIS2-21-2-([a-j])$/i)?.[1]?.toLowerCase();
  if (subLetter) {
    return (
      exCompact.includes('21') &&
      (exCompact.includes(`(${subLetter})`) ||
        exCompact.includes(`§2${subLetter}`) ||
        exCompact.includes(`2(${subLetter})`))
    );
  }
  if (req.id === 'NIS2-23') {
    return /\b(art\.?|article)\s*23\b/i.test(f.exigence_nis2 || '');
  }
  return false;
}

function normalizeCoverageStatus(raw: unknown): Nis2CoverageStatus {
  if (typeof raw !== 'string') return 'non_couvert';
  const v = raw.trim().toLowerCase();
  if (v === 'conforme') return 'conforme';
  if (v === 'non_conforme') return 'non_conforme';
  if (v === 'partiel') return 'partiel';
  if (v === 'a_confirmer') return 'a_confirmer';
  return 'non_couvert';
}

function buildReportFromItems(
  items: Nis2RequirementCoverageItem[],
  mode: AuditMode,
  source: 'server' | 'local',
  explicitCoveragePct?: number | null
): Nis2CoverageReport {
  const counts: Record<Nis2CoverageStatus, number> = {
    conforme: 0,
    non_conforme: 0,
    partiel: 0,
    a_confirmer: 0,
    non_couvert: 0,
  };

  for (const it of items) {
    counts[it.statut] += 1;
  }

  const totalRequirements = items.length;
  const coveredCount = totalRequirements - counts.non_couvert;
  const computedPct =
    totalRequirements > 0
      ? Math.round((coveredCount / totalRequirements) * 100)
      : 0;

  let coverageRatePct = computedPct;
  if (
    typeof explicitCoveragePct === 'number' &&
    Number.isFinite(explicitCoveragePct) &&
    explicitCoveragePct >= 0
  ) {
    coverageRatePct =
      explicitCoveragePct > 0 && explicitCoveragePct <= 1 && coveredCount > 0
        ? Math.round(explicitCoveragePct * 100)
        : Math.round(explicitCoveragePct);
  }

  return {
    referentiel: 'Directive (UE) 2022/2555 (NIS2)',
    mode,
    source,
    totalRequirements,
    coveredCount,
    coverageRatePct,
    counts,
    items,
  };
}

/**
 * Calcul déterministe local de la matrice de couverture NIS2 (repli instantané).
 */
export function computeLocalNis2Coverage(
  findings: Finding[],
  mode: AuditMode
): Nis2CoverageReport {
  const items: Nis2RequirementCoverageItem[] = CANONICAL_NIS2_REQUIREMENTS.map(
    (req) => {
      let matched = findings.filter((f) => matchesRequirementArticle(f, req));

      // Repli par mots-clés si un constat n'avait pas de référence d'article explicite
      if (matched.length === 0) {
        matched = findings.filter((f) => {
          const alreadyHasExplicitArticle = CANONICAL_NIS2_REQUIREMENTS.some(
            (other) => matchesRequirementArticle(f, other)
          );
          if (alreadyHasExplicitArticle) return false;
          const hay = `${f.theme} ${f.exigence_nis2}`.toLowerCase();
          return req.mots_cles.some((kw) => hay.includes(kw.toLowerCase()));
        });
      }

      if (matched.length === 0) {
        return {
          id: req.id,
          article: req.article,
          theme: req.theme,
          intitule_resume: req.intitule_resume,
          type_verification: req.type_verification,
          statut: 'non_couvert',
          finding_ids: [],
        };
      }

      let worstStatut: StatutFinding = matched[0].statut;
      for (const m of matched) {
        if (STATUS_SEVERITY[m.statut] > STATUS_SEVERITY[worstStatut]) {
          worstStatut = m.statut;
        }
      }

      return {
        id: req.id,
        article: req.article,
        theme: req.theme,
        intitule_resume: req.intitule_resume,
        type_verification: req.type_verification,
        statut: worstStatut,
        finding_ids: matched.map((m) => m.id),
      };
    }
  );

  return buildReportFromItems(items, mode, 'local');
}

/**
 * Normalise la réponse de `GET /api/nis2/coverage` en `Nis2CoverageReport`.
 */
export function normalizeServerNis2Coverage(
  payload: unknown,
  mode: AuditMode
): Nis2CoverageReport | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;

  const rawArray = Array.isArray(payload)
    ? payload
    : Array.isArray(obj.requirements)
    ? obj.requirements
    : Array.isArray(obj.exigences)
    ? obj.exigences
    : Array.isArray(obj.items)
    ? obj.items
    : Array.isArray(obj.coverage)
    ? obj.coverage
    : null;

  if (!rawArray || rawArray.length === 0) return null;

  const byCanonicalId = new Map(
    CANONICAL_NIS2_REQUIREMENTS.map((r) => [r.id.toUpperCase(), r])
  );

  const items: Nis2RequirementCoverageItem[] = rawArray
    .map((entry): Nis2RequirementCoverageItem | null => {
      if (!entry || typeof entry !== 'object') return null;
      const e = entry as Record<string, unknown>;
      const rawId =
        typeof e.id === 'string'
          ? e.id
          : typeof e.requirement_id === 'string'
          ? e.requirement_id
          : typeof e.exigence_id === 'string'
          ? e.exigence_id
          : null;
      if (!rawId) return null;

      const canonical = byCanonicalId.get(rawId.toUpperCase());
      const rawFindingIds = Array.isArray(e.finding_ids)
        ? e.finding_ids
        : Array.isArray(e.findings)
        ? e.findings
        : [];
      const findingIds = rawFindingIds
        .map((x) =>
          typeof x === 'string'
            ? x
            : x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string'
            ? ((x as { id: string }).id)
            : null
        )
        .filter((x): x is string => Boolean(x));

      const rawVerif = Array.isArray(e.type_verification)
        ? e.type_verification.filter((v): v is string => typeof v === 'string')
        : canonical?.type_verification || [];

      return {
        id: rawId,
        article:
          typeof e.article === 'string'
            ? e.article
            : canonical?.article || rawId,
        theme:
          typeof e.theme === 'string'
            ? e.theme
            : canonical?.theme || 'Exigence NIS2',
        intitule_resume:
          typeof e.intitule_resume === 'string'
            ? e.intitule_resume
            : typeof e.intitule === 'string'
            ? e.intitule
            : typeof e.title === 'string'
            ? e.title
            : canonical?.intitule_resume || '',
        type_verification: rawVerif,
        statut: normalizeCoverageStatus(
          e.statut ?? e.status ?? e.statut_couverture ?? e.coverage_status
        ),
        finding_ids: findingIds,
      };
    })
    .filter((x): x is Nis2RequirementCoverageItem => x !== null);

  if (items.length === 0) return null;

  const rawRate =
    obj.coverage_rate_pct ??
    obj.taux_couverture_pct ??
    obj.taux_couverture ??
    obj.coverage_rate ??
    obj.coverage_pct ??
    null;

  return buildReportFromItems(
    items,
    mode,
    'server',
    typeof rawRate === 'number' ? rawRate : null
  );
}
