import type {
  AuditMode,
  CrosswalkEntry,
  CrosswalkFrameworkKey,
  CrosswalkFrameworkSummary,
  CrosswalkGapStatus,
  CrosswalkReport,
  Finding,
  GraviteFinding,
} from '../types';

export const CROSSWALK_STATUS_META: Record<
  CrosswalkGapStatus,
  {
    label: string;
    shortLabel: string;
    badgeCls: string;
    rank: number;
  }
> = {
  non_conforme: {
    label: 'Écart majeur',
    shortLabel: 'Non conforme',
    badgeCls: 'badge-critical',
    rank: 4,
  },
  partiel: {
    label: 'Conformité partielle',
    shortLabel: 'Partiel',
    badgeCls: 'badge-high',
    rank: 3,
  },
  a_confirmer: {
    label: 'À confirmer',
    shortLabel: 'À confirmer',
    badgeCls: 'badge-warning',
    rank: 2,
  },
  conforme: {
    label: 'Conforme',
    shortLabel: 'Conforme',
    badgeCls: 'badge-success',
    rank: 1,
  },
};

export const FRAMEWORK_LABELS: Record<
  CrosswalkFrameworkKey,
  {
    short: string;
    full: string;
    pillCls: string;
  }
> = {
  HDS: {
    short: 'HDS',
    full: 'Référentiel HDS (ANS • Hébergeurs Données de Santé)',
    pillCls: 'border-[#86BC25]/40 text-accent bg-[#86BC25]/10',
  },
  ISO27001: {
    short: 'ISO 27001:2022',
    full: 'ISO/IEC 27001:2022 — Annexe A',
    pillCls: 'border-sky-500/40 text-sky-400 bg-sky-500/10',
  },
  RGPD: {
    short: 'RGPD Art. 32/33',
    full: 'RGPD (UE) 2016/679 — Art. 28, 32, 33 & 34',
    pillCls: 'border-amber-500/40 text-amber-400 bg-amber-500/10',
  },
};

export function normalizeCrosswalkStatus(raw: unknown): CrosswalkGapStatus {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (
    s === 'NON_CONFORME' ||
    s === 'NON CONFORME' ||
    s.includes('CRIT') ||
    s.includes('RUPTURE') ||
    s.includes('EXPOS') ||
    s === 'GAP' ||
    s === 'ECART' ||
    s === 'ÉCART' ||
    s === 'KO'
  ) {
    return 'non_conforme';
  }
  if (
    s === 'PARTIEL' ||
    s.includes('PARTI') ||
    s.includes('MODÉR') ||
    s.includes('MODER') ||
    s.includes('ÉLEV') ||
    s.includes('ELEV')
  ) {
    return 'partiel';
  }
  if (
    s === 'A_CONFIRMER' ||
    s.includes('CONFIRM') ||
    s.includes('ATTENTE') ||
    s === 'UNVERIFIED'
  ) {
    return 'a_confirmer';
  }
  if (
    s === 'CONFORME' ||
    s.includes('MAÎTR') ||
    s.includes('MAITR') ||
    s === 'OK' ||
    s === 'COMPLIANT'
  ) {
    return 'conforme';
  }
  return 'partiel';
}

function normalizeGravite(raw: unknown): GraviteFinding | undefined {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === 'critique' || s === 'critical') return 'critique';
  if (s === 'haute' || s === 'high' || s === 'elevee' || s === 'élevée') {
    return 'haute';
  }
  if (s === 'moyenne' || s === 'medium' || s === 'moderee') return 'moyenne';
  if (s === 'faible' || s === 'low') return 'faible';
  return undefined;
}

function extractStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        for (const k of ['id', 'code', 'ref', 'control', 'label', 'title']) {
          if (typeof o[k] === 'string' && (o[k] as string).trim()) {
            return (o[k] as string).trim();
          }
        }
      }
      return '';
    })
    .filter(Boolean);
}

function pickStr(
  obj: Record<string, unknown>,
  keys: string[],
  fallback = ''
): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return fallback;
}

function extractControlPair(
  row: Record<string, unknown>,
  nestedKeys: string[],
  refKeys: string[],
  detailKeys: string[],
  fallbackRef: string
): { ref: string; detail?: string } {
  for (const nk of nestedKeys) {
    const val = row[nk];
    if (typeof val === 'string' && val.trim()) {
      return { ref: val.trim() };
    }
    if (Array.isArray(val) && val.length > 0) {
      const joined = extractStringArray(val).join(' • ');
      if (joined) return { ref: joined };
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      const ref = pickStr(
        o,
        ['ref', 'control', 'clause', 'article', 'code', 'id', 'label'],
        ''
      );
      const detail = pickStr(
        o,
        ['detail', 'title', 'requirement', 'intitule', 'description', 'summary'],
        ''
      );
      if (ref || detail) {
        return {
          ref: ref || detail,
          detail: ref && detail && detail !== ref ? detail : undefined,
        };
      }
    }
  }

  const flatRef = pickStr(row, refKeys, '');
  const flatDetail = pickStr(row, detailKeys, '');
  return {
    ref: flatRef || fallbackRef,
    detail: flatDetail || undefined,
  };
}

function isApplicableRef(ref: string): boolean {
  const t = ref.trim().toUpperCase();
  return Boolean(
    t && t !== '—' && t !== '-' && t !== 'N/A' && t !== 'NON APPLICABLE'
  );
}

function computeFrameworkSummaryFromEntries(
  fw: CrosswalkFrameworkKey,
  label: string,
  entries: CrosswalkEntry[]
): CrosswalkFrameworkSummary {
  const scoped = entries.filter((e) => e.frameworks.includes(fw));
  const total = scoped.length;
  const compliant = scoped.filter((e) => e.statut === 'conforme').length;
  const gaps = total - compliant;
  const pct = total > 0 ? Math.round((compliant / total) * 100) : 100;
  return {
    framework: fw,
    label,
    total_controls: total,
    compliant_count: compliant,
    gap_count: gaps,
    conformity_pct: pct,
    status_label:
      gaps === 0
        ? 'Conforme ✓'
        : scoped.some((e) => e.statut === 'non_conforme')
        ? `${gaps} écart(s) critique(s)`
        : `${gaps} point(s) d'attention`,
  };
}

function parseServerFrameworkSummary(
  raw: unknown,
  fw: CrosswalkFrameworkKey,
  fallback: CrosswalkFrameworkSummary
): CrosswalkFrameworkSummary {
  if (!raw || typeof raw !== 'object') return fallback;
  const o = raw as Record<string, unknown>;
  const total =
    typeof o.total_controls === 'number'
      ? o.total_controls
      : typeof o.total === 'number'
      ? o.total
      : fallback.total_controls;
  const compliant =
    typeof o.compliant_count === 'number'
      ? o.compliant_count
      : typeof o.conforme === 'number'
      ? o.conforme
      : typeof o.compliant === 'number'
      ? o.compliant
      : fallback.compliant_count;
  const gaps =
    typeof o.gap_count === 'number'
      ? o.gap_count
      : typeof o.gaps === 'number'
      ? o.gaps
      : typeof o.ecarts === 'number'
      ? o.ecarts
      : Math.max(0, total - compliant);
  const pct =
    typeof o.conformity_pct === 'number'
      ? Math.round(o.conformity_pct)
      : typeof o.coverage_pct === 'number'
      ? Math.round(o.coverage_pct)
      : typeof o.score_pct === 'number'
      ? Math.round(o.score_pct)
      : total > 0
      ? Math.round((compliant / total) * 100)
      : fallback.conformity_pct;

  return {
    framework: fw,
    label: pickStr(o, ['label', 'name', 'title'], fallback.label),
    total_controls: total,
    compliant_count: compliant,
    gap_count: gaps,
    conformity_pct: pct,
    status_label: pickStr(
      o,
      ['status_label', 'status', 'verdict'],
      fallback.status_label
    ),
  };
}

export function normalizeServerCrosswalkReport(
  payload: unknown,
  fallbackMode: AuditMode
): CrosswalkReport | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (obj.has_synthesis === false) return null;

  const rawList = Array.isArray(obj.entries)
    ? obj.entries
    : Array.isArray(obj.mappings)
    ? obj.mappings
    : Array.isArray(obj.rows)
    ? obj.rows
    : Array.isArray(obj.items)
    ? obj.items
    : Array.isArray(obj.concordance)
    ? obj.concordance
    : Array.isArray(obj.crosswalk)
    ? obj.crosswalk
    : Array.isArray(obj.controls)
    ? obj.controls
    : null;

  if (!rawList || rawList.length === 0) return null;

  const entries: CrosswalkEntry[] = rawList
    .map((raw, idx): CrosswalkEntry | null => {
      if (!raw || typeof raw !== 'object') return null;
      const r = raw as Record<string, unknown>;

      const id = pickStr(
        r,
        ['id', 'mapping_id', 'row_id', 'code'],
        `CW-${String(idx + 1).padStart(2, '0')}`
      );

      const nis2Article = pickStr(
        r,
        ['nis2_article', 'article_nis2', 'article', 'nis2_ref', 'nis2'],
        'Art. 21 NIS2'
      );

      const nis2Title = pickStr(
        r,
        [
          'nis2_title',
          'nis2_requirement',
          'exigence_nis2',
          'title',
          'intitule',
          'label',
        ],
        'Exigence de sécurité NIS2'
      );

      const domain = pickStr(
        r,
        ['domain', 'theme', 'domaine', 'category', 'pillar'],
        'Sécurité SIH & Cloud'
      );

      const hds = extractControlPair(
        r,
        ['hds', 'hds_mapping'],
        ['hds_ref', 'hds_control', 'exigence_hds', 'hds_clause'],
        ['hds_detail', 'hds_title', 'hds_description'],
        '—'
      );

      const iso = extractControlPair(
        r,
        ['iso27001', 'iso_27001', 'iso_mapping'],
        [
          'iso27001_ref',
          'iso_27001_ref',
          'iso27001_control',
          'iso_control',
          'annexe_a',
        ],
        ['iso27001_detail', 'iso_detail', 'iso_title'],
        '—'
      );

      const rgpd = extractControlPair(
        r,
        ['rgpd', 'gdpr', 'rgpd_mapping'],
        ['rgpd_ref', 'rgpd_article', 'gdpr_ref', 'exigence_rgpd'],
        ['rgpd_detail', 'rgpd_title', 'gdpr_detail'],
        '—'
      );

      const explicitFws = extractStringArray(r.frameworks).map((f) =>
        f.toUpperCase()
      );
      const frameworks: CrosswalkFrameworkKey[] = [];
      if (
        isApplicableRef(hds.ref) ||
        explicitFws.some((f) => f.includes('HDS'))
      ) {
        frameworks.push('HDS');
      }
      if (
        isApplicableRef(iso.ref) ||
        explicitFws.some((f) => f.includes('ISO') || f.includes('27001'))
      ) {
        frameworks.push('ISO27001');
      }
      if (
        isApplicableRef(rgpd.ref) ||
        explicitFws.some((f) => f.includes('RGPD') || f.includes('GDPR'))
      ) {
        frameworks.push('RGPD');
      }
      if (frameworks.length === 0) {
        frameworks.push('HDS', 'ISO27001', 'RGPD');
      }

      const statut = normalizeCrosswalkStatus(
        r.statut ?? r.status ?? r.gap_status ?? r.etat ?? r.compliance_status
      );

      const findingIds = extractStringArray(
        r.finding_ids ??
          r.findings ??
          r.linked_findings ??
          r.constats_lies ??
          r.related_findings
      ).map((fid) => fid.toUpperCase());

      const summary = pickStr(
        r,
        [
          'summary',
          'context',
          'constat',
          'gap_summary',
          'observation',
          'description',
        ],
        ''
      );

      const cnilApplicable =
        typeof r.cnil_applicable === 'boolean'
          ? r.cnil_applicable
          : typeof r.cnil_art33_applicable === 'boolean'
          ? r.cnil_art33_applicable
          : /33|34|violation|fuite|notification/i.test(
              `${rgpd.ref} ${rgpd.detail || ''}`
            );

      return {
        id,
        nis2_article: nis2Article,
        nis2_title: nis2Title,
        domain,
        hds_ref: hds.ref,
        hds_detail: hds.detail,
        iso27001_ref: iso.ref,
        iso27001_detail: iso.detail,
        rgpd_ref: rgpd.ref,
        rgpd_detail: rgpd.detail,
        frameworks,
        statut,
        gravite: normalizeGravite(r.gravite ?? r.severity),
        summary,
        finding_ids: findingIds,
        cnil_applicable: cnilApplicable,
      };
    })
    .filter((e): e is CrosswalkEntry => e !== null);

  if (entries.length === 0) return null;

  const computedHds = computeFrameworkSummaryFromEntries(
    'HDS',
    FRAMEWORK_LABELS.HDS.short,
    entries
  );
  const computedIso = computeFrameworkSummaryFromEntries(
    'ISO27001',
    FRAMEWORK_LABELS.ISO27001.short,
    entries
  );
  const computedRgpd = computeFrameworkSummaryFromEntries(
    'RGPD',
    FRAMEWORK_LABELS.RGPD.short,
    entries
  );

  const rawFwSummaries =
    (obj.frameworks_summary && typeof obj.frameworks_summary === 'object'
      ? (obj.frameworks_summary as Record<string, unknown>)
      : null) ||
    (obj.framework_summaries && typeof obj.framework_summaries === 'object'
      ? (obj.framework_summaries as Record<string, unknown>)
      : null) ||
    (obj.by_framework && typeof obj.by_framework === 'object'
      ? (obj.by_framework as Record<string, unknown>)
      : null) ||
    (obj.summaries && typeof obj.summaries === 'object'
      ? (obj.summaries as Record<string, unknown>)
      : null);

  const frameworksSummary: Record<
    CrosswalkFrameworkKey,
    CrosswalkFrameworkSummary
  > = {
    HDS: parseServerFrameworkSummary(
      rawFwSummaries?.HDS ?? rawFwSummaries?.hds,
      'HDS',
      computedHds
    ),
    ISO27001: parseServerFrameworkSummary(
      rawFwSummaries?.ISO27001 ??
        rawFwSummaries?.iso27001 ??
        rawFwSummaries?.iso_27001,
      'ISO27001',
      computedIso
    ),
    RGPD: parseServerFrameworkSummary(
      rawFwSummaries?.RGPD ?? rawFwSummaries?.rgpd ?? rawFwSummaries?.gdpr,
      'RGPD',
      computedRgpd
    ),
  };

  const nonConformeCount = entries.filter(
    (e) => e.statut === 'non_conforme'
  ).length;
  const partielCount = entries.filter(
    (e) => e.statut === 'partiel' || e.statut === 'a_confirmer'
  ).length;
  const conformeCount = entries.filter((e) => e.statut === 'conforme').length;

  return {
    session_id: typeof obj.session_id === 'string' ? obj.session_id : undefined,
    mode:
      obj.mode === 'AVANT' || obj.mode === 'APRES' ? obj.mode : fallbackMode,
    source: 'server',
    title:
      pickStr(obj, ['title', 'label']) ||
      'Concordance Multi-Référentiels Santé (NIS2 ↔ HDS ↔ ISO 27001:2022 ↔ RGPD)',
    frameworks_summary: frameworksSummary,
    entries,
    summary_counts: {
      total: entries.length,
      gaps: nonConformeCount + partielCount,
      conforme: conformeCount,
      non_conforme: nonConformeCount,
      partiel: partielCount,
    },
  };
}

export function computeLocalCrosswalkFallback(
  findings: Finding[],
  mode: AuditMode
): CrosswalkReport {
  const byId = new Map<string, Finding>();
  for (const f of findings) {
    byId.set(f.id.toUpperCase(), f);
  }

  const statusOf = (
    fid: string,
    defaultStatut: CrosswalkGapStatus
  ): CrosswalkGapStatus => {
    const f = byId.get(fid);
    if (!f) return defaultStatut;
    return normalizeCrosswalkStatus(f.statut);
  };

  const hasF004 = byId.has('F-004');
  const f004Statut: CrosswalkGapStatus = hasF004
    ? statusOf('F-004', 'non_conforme')
    : mode === 'APRES'
    ? 'non_conforme'
    : 'a_confirmer';

  const entries: CrosswalkEntry[] = [
    {
      id: 'CW-01',
      nis2_article: 'Art. 21 §2 (a) & (h)',
      nis2_title: 'Protection des actifs critiques & cloisonnement stockage HDS',
      domain: 'Confidentialité Données de Santé',
      hds_ref: 'HDS Exig. 4.2 & Souveraineté Stockage',
      hds_detail: 'Interdiction d’exposition publique des données médicales',
      iso27001_ref: 'A.5.15 • A.8.11 • A.8.24',
      iso27001_detail: 'Contrôle d’accès, masquage et cryptographie',
      rgpd_ref: 'Art. 32 §1 (a)(b) & Art. 33/34',
      rgpd_detail: 'Confidentialité des données de santé & analyse de violation',
      frameworks: ['HDS', 'ISO27001', 'RGPD'],
      statut: statusOf('F-001', 'non_conforme'),
      gravite: byId.get('F-001')?.gravite || 'critique',
      summary:
        'Exposition publique allUsers détectée sur gs://ch-valmont-demo-export-radiologie-2025 contenant des exports DICOM/imagerie : déclenche l’analyse conjointe ANSSI Art. 23 & CNIL Art. 33.',
      finding_ids: byId.has('F-001') ? ['F-001'] : [],
      cnil_applicable: true,
    },
    {
      id: 'CW-02',
      nis2_article: 'Art. 21 §2 (e) & (i)',
      nis2_title: 'Sécurité réseau, filtrage périmétrique & accès distants',
      domain: 'Cloisonnement Réseau & Administration',
      hds_ref: 'HDS Exig. 4.5 — Flux d’administration sécurisés',
      hds_detail: 'Bastion obligatoire et interdiction d’ouverture Internet directe',
      iso27001_ref: 'A.8.20 • A.8.21 • A.8.22',
      iso27001_detail: 'Sécurité des réseaux et cloisonnement des services',
      rgpd_ref: 'Art. 32 §1 (b)',
      rgpd_detail: 'Intégrité et résilience des systèmes de traitement',
      frameworks: ['HDS', 'ISO27001', 'RGPD'],
      statut: statusOf('F-002', 'non_conforme'),
      gravite: byId.get('F-002')?.gravite || 'critique',
      summary:
        'Règle pare-feu allow-ssh-anywhere (TCP/22 ouvert à 0.0.0.0/0) contraire au bastion VPN/IAP exigé par HDS et la PSSI §4.3.',
      finding_ids: byId.has('F-002') ? ['F-002'] : [],
    },
    {
      id: 'CW-03',
      nis2_article: 'Art. 21 §2 (c)',
      nis2_title: 'Gestion des sauvegardes immuables, PCA/PRA & anti-rançongiciel',
      domain: 'Continuité Clinique (DPI & PACS)',
      hds_ref: 'HDS Exig. 4.6 — Sauvegardes & reprise garantie',
      hds_detail: 'Immuabilité WORM et tests périodiques documentés',
      iso27001_ref: 'A.8.13 • A.5.29 • A.5.30',
      iso27001_detail: 'Sauvegarde des informations & préparation TIC à la continuité',
      rgpd_ref: 'Art. 32 §1 (c)',
      rgpd_detail: 'Capacité à rétablir la disponibilité des données de santé',
      frameworks: ['HDS', 'ISO27001', 'RGPD'],
      statut: statusOf('F-003', 'non_conforme'),
      gravite: byId.get('F-003')?.gravite || 'critique',
      summary:
        'Absence de versioning et de Bucket Lock WORM sur gs://ch-valmont-demo-backups-dpi (F-003), tandis qu’archives-pacs valide le témoin WORM 365 j (F-005).',
      finding_ids: ['F-003', 'F-005'].filter((id) => byId.has(id)),
    },
    {
      id: 'CW-04',
      nis2_article: 'Art. 23 §1 & §4',
      nis2_title: 'Notification des incidents significatifs (24 h / 72 h / 1 mois)',
      domain: 'Double Guichet ANSSI & CNIL',
      hds_ref: 'HDS Exig. 6.1 — Notification incidents au client HDS',
      hds_detail: 'Alerte sans délai de tout incident affectant le SIH',
      iso27001_ref: 'A.5.24 • A.5.25 • A.5.26',
      iso27001_detail: 'Gestion, qualification et réponse aux incidents sécurité',
      rgpd_ref: 'Art. 33 (CNIL 72 h) & Art. 34',
      rgpd_detail: 'Notification de violation de données à caractère personnel',
      frameworks: ['HDS', 'ISO27001', 'RGPD'],
      statut: f004Statut,
      gravite: byId.get('F-004')?.gravite || 'haute',
      summary:
        mode === 'APRES' || hasF004
          ? 'Incident de septembre (compromission compte prestataire & coupure messagerie 1/2 journée) géré en interne sans alerte ANSSI 24 h ni évaluation formelle CNIL 72 h.'
          : 'Procédure documentaire présente en PSSI §6, à confronter aux incidents réels lors de l’entretien contradictoire DSI.',
      finding_ids: byId.has('F-004') ? ['F-004'] : [],
      cnil_applicable: true,
    },
    {
      id: 'CW-05',
      nis2_article: 'Art. 21 §2 (d) & (i)',
      nis2_title: 'Chaîne d’approvisionnement, IAM tiers & hygiène des privilèges',
      domain: 'Gouvernance Tiers & Identités Cloud',
      hds_ref: 'HDS Exig. 3.3 & 4.1 — Maîtrise des sous-traitants & accès',
      hds_detail: 'Moindre privilège, PAS contractuel et rotation des secrets',
      iso27001_ref: 'A.5.19 • A.5.21 • A.8.2 • A.8.5',
      iso27001_detail: 'Sécurité des relations fournisseurs & droits d’accès privilégiés',
      rgpd_ref: 'Art. 28 & Art. 32 §4',
      rgpd_detail: 'Encadrement contractuel du sous-traitant et habilitations',
      frameworks: ['HDS', 'ISO27001', 'RGPD'],
      statut: statusOf('F-006', 'non_conforme'),
      gravite: byId.get('F-006')?.gravite || 'critique',
      summary:
        'Compte sa-prestataire-meditech doté de roles/editor avec clé statique âgée de 248 j (> 90 j PSSI §4.1) et compte admin-legacy roles/owner actif.',
      finding_ids: byId.has('F-006') ? ['F-006'] : [],
    },
    {
      id: 'CW-06',
      nis2_article: 'Art. 21 §2 (f) & (h)',
      nis2_title: 'Journalisation forensique, rotation KMS & contrôle continu',
      domain: 'Traçabilité & Cryptographie Souveraine',
      hds_ref: 'HDS Exig. 4.4 & 4.7 — Traces d’audit (12 mois) & clés KMS UE',
      hds_detail: 'Conservation intègre des journaux et gestion du cycle de vie des clés',
      iso27001_ref: 'A.8.15 • A.8.16 • A.8.24',
      iso27001_detail: 'Journalisation, surveillance des activités et gestion des clés',
      rgpd_ref: 'Art. 5 §2 & Art. 32 §1 (a)(d)',
      rgpd_detail: 'Accountability, chiffrement CMEK et évaluation régulière',
      frameworks: ['HDS', 'ISO27001', 'RGPD'],
      statut: statusOf('F-007', 'partiel'),
      gravite: byId.get('F-007')?.gravite || 'haute',
      summary:
        'Rétention Cloud Logging _Default plafonnée à 30 j (contre 12 mois PSSI §6.1 / HDS) et rotation automatique absente sur la clé KMS key-dpi-patients.',
      finding_ids: byId.has('F-007') ? ['F-007'] : [],
    },
    {
      id: 'CW-07',
      nis2_article: 'Art. 21 §2 (c) & (h)',
      nis2_title: 'Archivage médical longue durée verrouillé & chiffré CMEK',
      domain: 'Archives Imagerie PACS',
      hds_ref: 'HDS Exig. 4.6 & Souveraineté europe-west9',
      hds_detail: 'Conservation intègre et chiffrement régional UE',
      iso27001_ref: 'A.8.13 • A.8.24',
      iso27001_detail: 'Protection immuable des archives et rotation KMS 90 j',
      rgpd_ref: 'Art. 32 §1 (a)(c)',
      rgpd_detail: 'Intégrité et chiffrement à l’état de l’art des archives HDS',
      frameworks: ['HDS', 'ISO27001', 'RGPD'],
      statut: statusOf('F-005', 'conforme'),
      gravite: byId.get('F-005')?.gravite || 'faible',
      summary:
        'Contrôle témoin positif validé sur gs://ch-valmont-demo-archives-pacs : versioning actif, rétention WORM verrouillée 365 j et clé KMS rotation 90 j.',
      finding_ids: byId.has('F-005') ? ['F-005'] : [],
    },
  ];

  const frameworksSummary: Record<
    CrosswalkFrameworkKey,
    CrosswalkFrameworkSummary
  > = {
    HDS: computeFrameworkSummaryFromEntries(
      'HDS',
      FRAMEWORK_LABELS.HDS.short,
      entries
    ),
    ISO27001: computeFrameworkSummaryFromEntries(
      'ISO27001',
      FRAMEWORK_LABELS.ISO27001.short,
      entries
    ),
    RGPD: computeFrameworkSummaryFromEntries(
      'RGPD',
      FRAMEWORK_LABELS.RGPD.short,
      entries
    ),
  };

  const nonConformeCount = entries.filter(
    (e) => e.statut === 'non_conforme'
  ).length;
  const partielCount = entries.filter(
    (e) => e.statut === 'partiel' || e.statut === 'a_confirmer'
  ).length;
  const conformeCount = entries.filter((e) => e.statut === 'conforme').length;

  return {
    mode,
    source: 'local',
    title:
      'Concordance Multi-Référentiels Santé (NIS2 ↔ HDS ↔ ISO 27001:2022 ↔ RGPD)',
    frameworks_summary: frameworksSummary,
    entries,
    summary_counts: {
      total: entries.length,
      gaps: nonConformeCount + partielCount,
      conforme: conformeCount,
      non_conforme: nonConformeCount,
      partiel: partielCount,
    },
  };
}
