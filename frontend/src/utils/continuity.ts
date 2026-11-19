import type {
  AuditMode,
  ContinuityExposureLevel,
  ContinuityProcessEntry,
  ContinuityRansomwareStatus,
  ContinuityReport,
  Finding,
} from '../types';

export const CONTINUITY_EXPOSURE_META: Record<
  ContinuityExposureLevel,
  {
    label: string;
    badgeCls: string;
    borderCls: string;
    rank: number;
  }
> = {
  CRITIQUE: {
    label: 'CRITIQUE',
    badgeCls: 'bg-rose-600 text-white',
    borderCls: 'border-rose-500/40',
    rank: 4,
  },
  ÉLEVÉ: {
    label: 'ÉLEVÉ',
    badgeCls: 'badge-high',
    borderCls: 'border-amber-500/35',
    rank: 3,
  },
  MODÉRÉ: {
    label: 'MODÉRÉ',
    badgeCls: 'badge-warning',
    borderCls: 'border-hairline',
    rank: 2,
  },
  MAÎTRISÉ: {
    label: 'MAÎTRISÉ',
    badgeCls: 'badge-success',
    borderCls: 'border-[#86BC25]/35',
    rank: 1,
  },
};

export const RANSOMWARE_STATUS_META: Record<
  ContinuityRansomwareStatus,
  {
    label: string;
    shortLabel: string;
    detail: string;
    badgeCls: string;
  }
> = {
  IMMUTABLE: {
    label: 'IMMUTABLE ✓',
    shortLabel: 'IMMUTABLE',
    detail: 'Sauvegardes WORM / Bucket Lock actives contre la suppression',
    badgeCls: 'badge-success',
  },
  EXPOSÉ: {
    label: 'EXPOSÉ ✕',
    shortLabel: 'EXPOSÉ',
    detail: 'Sauvegardes sans verrouillage WORM / Bucket Lock anti-rançongiciel',
    badgeCls: 'bg-rose-600 text-white',
  },
};

export function normalizeContinuityExposureLevel(
  raw: unknown
): ContinuityExposureLevel {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (
    s.includes('CRIT') ||
    s === 'NON_CONFORME' ||
    s === 'RUPTURE' ||
    s === 'SEVERE'
  ) {
    return 'CRITIQUE';
  }
  if (
    s.includes('ÉLEV') ||
    s.includes('ELEV') ||
    s.includes('HAUT') ||
    s === 'HIGH'
  ) {
    return 'ÉLEVÉ';
  }
  if (
    s.includes('MODÉR') ||
    s.includes('MODER') ||
    s.includes('MOYEN') ||
    s === 'MEDIUM' ||
    s === 'PARTIEL' ||
    s === 'A_CONFIRMER'
  ) {
    return 'MODÉRÉ';
  }
  if (
    s.includes('MAÎTR') ||
    s.includes('MAITR') ||
    s.includes('CONFORME') ||
    s.includes('FAIBLE') ||
    s === 'LOW' ||
    s === 'OK'
  ) {
    return 'MAÎTRISÉ';
  }
  return 'MODÉRÉ';
}

export function normalizeRansomwareStatus(
  raw: unknown,
  fallback: ContinuityRansomwareStatus = 'EXPOSÉ'
): ContinuityRansomwareStatus {
  if (typeof raw === 'boolean') {
    return raw ? 'IMMUTABLE' : 'EXPOSÉ';
  }
  if (typeof raw === 'string') {
    const s = raw.trim().toUpperCase();
    if (
      s.includes('IMMUT') ||
      s.includes('WORM') ||
      s.includes('LOCKED') ||
      s.includes('VERROUILL') ||
      s.includes('PROTÉG') ||
      s.includes('PROTEG') ||
      s === 'SAFE' ||
      s === 'OK'
    ) {
      return 'IMMUTABLE';
    }
    if (
      s.includes('EXPOS') ||
      s.includes('VULN') ||
      s.includes('UNPROTECTED') ||
      s.includes('MUTABLE') ||
      s.includes('NON_PROT') ||
      s.includes('RISQUE') ||
      s.includes('AT_RISK') ||
      s.includes('COMPROM')
    ) {
      return 'EXPOSÉ';
    }
  }
  return fallback;
}

function extractStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        for (const k of [
          'action',
          'exercise',
          'exercice',
          'title',
          'label',
          'text',
          'description',
          'id',
        ]) {
          if (typeof o[k] === 'string' && (o[k] as string).trim()) {
            return (o[k] as string).trim();
          }
        }
      }
      return '';
    })
    .filter(Boolean);
}

function pickFirstString(
  obj: Record<string, unknown>,
  keys: string[],
  fallback = ''
): string {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
    if (typeof val === 'number' && Number.isFinite(val)) {
      return `${val} h`;
    }
  }
  return fallback;
}

function inferMetricGap(
  explicitGap: unknown,
  explicitCompliant: unknown,
  actualLabel: string
): boolean {
  if (typeof explicitGap === 'boolean') return explicitGap;
  if (typeof explicitCompliant === 'boolean') return !explicitCompliant;
  return /non test|expos|compromis|sans worm|sans bucket|non garanti|dépass|demi-journée|incertain|indisponib|0 j|>[ \t]*\d/i.test(
    actualLabel
  );
}

export function normalizeServerContinuityReport(
  payload: unknown,
  fallbackMode: AuditMode
): ContinuityReport | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (obj.has_synthesis === false) return null;

  const rawList = Array.isArray(obj.processes)
    ? obj.processes
    : Array.isArray(obj.vital_processes)
    ? obj.vital_processes
    : Array.isArray(obj.clinical_processes)
    ? obj.clinical_processes
    : Array.isArray(obj.services)
    ? obj.services
    : Array.isArray(obj.items)
    ? obj.items
    : Array.isArray(obj.entries)
    ? obj.entries
    : Array.isArray(obj.processus)
    ? obj.processus
    : null;

  if (!rawList || rawList.length === 0) return null;

  const globalExercises = extractStringArray(
    obj.pra_exercises ??
      obj.required_exercises ??
      obj.exercices_pra ??
      obj.pra_actions ??
      obj.recommended_actions
  );

  const processes: ContinuityProcessEntry[] = rawList
    .map((raw, idx): ContinuityProcessEntry | null => {
      if (!raw || typeof raw !== 'object') return null;
      const p = raw as Record<string, unknown>;

      const id = pickFirstString(
        p,
        ['id', 'process_id', 'service_id', 'code'],
        `CONT-${String(idx + 1).padStart(2, '0')}`
      );

      const name = pickFirstString(
        p,
        ['name', 'process_name', 'process', 'nom', 'service', 'title', 'label'],
        `Processus Clinique #${idx + 1}`
      );

      const criticality = pickFirstString(
        p,
        ['criticality', 'criticite', 'category', 'tier', 'role', 'perimeter'],
        'Processus hospitalier vital'
      );

      const pssiRef =
        pickFirstString(p, [
          'pssi_ref',
          'pssi_reference',
          'pssi_section',
          'reference_pssi',
        ]) || null;

      const nestedRto =
        p.rto && typeof p.rto === 'object'
          ? (p.rto as Record<string, unknown>)
          : null;
      const nestedRpo =
        p.rpo && typeof p.rpo === 'object'
          ? (p.rpo as Record<string, unknown>)
          : null;

      const rtoTarget =
        (nestedRto &&
          pickFirstString(nestedRto, ['target', 'cible', 'pssi', 'objective'])) ||
        pickFirstString(
          p,
          ['rto_target', 'target_rto', 'rto_cible', 'rto_pssi'],
          '4 h (PSSI §5.1)'
        );

      const rtoActual =
        (nestedRto &&
          pickFirstString(nestedRto, [
            'actual',
            'observed',
            'real',
            'reel',
            'capacite_reelle',
          ])) ||
        pickFirstString(
          p,
          [
            'rto_actual',
            'rto_observed',
            'observed_rto',
            'real_rto',
            'rto_reel',
            'capacite_rto',
            'rto_real',
          ],
          'À confirmer par exercice PRA'
        );

      const rtoGap = inferMetricGap(
        nestedRto?.gap ?? p.rto_gap ?? p.ecart_rto,
        nestedRto?.compliant ?? p.rto_compliant ?? p.rto_conforme ?? p.rto_met,
        rtoActual
      );

      const rpoTarget =
        (nestedRpo &&
          pickFirstString(nestedRpo, ['target', 'cible', 'pssi', 'objective'])) ||
        pickFirstString(
          p,
          ['rpo_target', 'target_rpo', 'rpo_cible', 'rpo_pssi'],
          '24 h (PSSI §5.1)'
        );

      const rpoActual =
        (nestedRpo &&
          pickFirstString(nestedRpo, [
            'actual',
            'observed',
            'real',
            'reel',
            'capacite_reelle',
          ])) ||
        pickFirstString(
          p,
          [
            'rpo_actual',
            'rpo_observed',
            'observed_rpo',
            'real_rpo',
            'rpo_reel',
            'capacite_rpo',
            'rpo_real',
          ],
          'À confirmer sur sauvegardes WORM'
        );

      const rpoGap = inferMetricGap(
        nestedRpo?.gap ?? p.rpo_gap ?? p.ecart_rpo,
        nestedRpo?.compliant ?? p.rpo_compliant ?? p.rpo_conforme ?? p.rpo_met,
        rpoActual
      );

      const ransomwareStatus = normalizeRansomwareStatus(
        p.ransomware_status ??
          p.anti_ransomware_status ??
          p.anti_ransomware ??
          p.statut_rancongiciel ??
          p.statut_anti_rancongiciel ??
          p.worm_status ??
          p.immutability_status ??
          p.backup_immutability ??
          p.immutable,
        rpoGap ? 'EXPOSÉ' : 'IMMUTABLE'
      );

      const exposureLevel = normalizeContinuityExposureLevel(
        p.exposure_level ??
          p.pca_pra_exposure ??
          p.exposition_pca_pra ??
          p.niveau_exposition ??
          p.risk_level ??
          p.niveau_risque ??
          p.gravite ??
          (ransomwareStatus === 'EXPOSÉ' && (rtoGap || rpoGap)
            ? 'CRITIQUE'
            : rtoGap || rpoGap
            ? 'ÉLEVÉ'
            : 'MAÎTRISÉ')
      );

      const context = pickFirstString(
        p,
        [
          'context',
          'description',
          'constat',
          'summary',
          'observation',
          'gap_detail',
          'ecart_detail',
        ],
        ''
      );

      const findingIds = extractStringArray(
        p.finding_ids ??
          p.findings ??
          p.linked_findings ??
          p.constats_lies ??
          p.related_findings
      ).map((fid) => fid.toUpperCase());

      const localActions = extractStringArray(
        p.pra_actions ??
          p.pra_exercises ??
          p.required_exercises ??
          p.exercices_pra ??
          p.exercices_requis ??
          p.actions_pra ??
          p.recommended_actions ??
          p.actions_requises ??
          p.recommandations
      );

      const praActions =
        localActions.length > 0
          ? localActions
          : globalExercises.length > 0
          ? globalExercises.slice(0, 2)
          : [
              'Activer le versioning et une rétention verrouillée WORM (Bucket Lock >= 30 j) sur les sauvegardes Cloud (Art. 21 §2 c).',
              'Exécuter un exercice annuel de restauration complète incluant un scénario de compromission rançongiciel (PSSI §5.3).',
            ];

      const lastTestRef =
        pickFirstString(p, [
          'last_test_ref',
          'pv_reference',
          'last_exercise',
          'dernier_exercice',
          'test_pra',
        ]) || null;

      return {
        id,
        name,
        criticality,
        pssi_ref: pssiRef,
        rto_target: rtoTarget,
        rto_actual: rtoActual,
        rto_gap: rtoGap,
        rpo_target: rpoTarget,
        rpo_actual: rpoActual,
        rpo_gap: rpoGap,
        ransomware_status: ransomwareStatus,
        exposure_level: exposureLevel,
        context,
        finding_ids: findingIds,
        pra_actions: praActions,
        last_test_ref: lastTestRef,
      };
    })
    .filter((entry): entry is ContinuityProcessEntry => entry !== null);

  if (processes.length === 0) return null;

  const immutableCount = processes.filter(
    (p) => p.ransomware_status === 'IMMUTABLE'
  ).length;
  const exposeCount = processes.filter(
    (p) => p.ransomware_status === 'EXPOSÉ'
  ).length;
  const rtoRpoGaps = processes.filter((p) => p.rto_gap || p.rpo_gap).length;

  const summaryCounts = {
    total: processes.length,
    immutable: immutableCount,
    expose: exposeCount,
    rto_rpo_gaps: rtoRpoGaps,
    critique: processes.filter((p) => p.exposure_level === 'CRITIQUE').length,
    eleve: processes.filter((p) => p.exposure_level === 'ÉLEVÉ').length,
    modere: processes.filter((p) => p.exposure_level === 'MODÉRÉ').length,
    maitrise: processes.filter((p) => p.exposure_level === 'MAÎTRISÉ').length,
  };

  const overallExposure: ContinuityExposureLevel =
    obj.overall_exposure || obj.overall_risk || obj.exposition_globale
      ? normalizeContinuityExposureLevel(
          obj.overall_exposure ?? obj.overall_risk ?? obj.exposition_globale
        )
      : summaryCounts.critique > 0
      ? 'CRITIQUE'
      : summaryCounts.eleve > 0
      ? 'ÉLEVÉ'
      : summaryCounts.modere > 0
      ? 'MODÉRÉ'
      : 'MAÎTRISÉ';

  const ransomwareReadiness: ContinuityRansomwareStatus =
    obj.ransomware_readiness || obj.anti_ransomware_status
      ? normalizeRansomwareStatus(
          obj.ransomware_readiness ?? obj.anti_ransomware_status,
          exposeCount > 0 ? 'EXPOSÉ' : 'IMMUTABLE'
        )
      : exposeCount > 0
      ? 'EXPOSÉ'
      : 'IMMUTABLE';

  return {
    session_id: typeof obj.session_id === 'string' ? obj.session_id : undefined,
    mode:
      obj.mode === 'AVANT' || obj.mode === 'APRES' ? obj.mode : fallbackMode,
    article:
      pickFirstString(obj, ['article']) ||
      'Art. 21 §2 (c) — Continuité des activités, gestion des sauvegardes et reprise après sinistre',
    pssi_reference:
      pickFirstString(obj, ['pssi_reference', 'pssi_ref']) ||
      'PSSI §5.1, §5.2 & §5.3 — Objectifs RTO (4 h) / RPO (24 h), Sauvegardes & Tests PRA',
    source: 'server',
    overall_exposure: overallExposure,
    ransomware_readiness: ransomwareReadiness,
    processes,
    summary_counts: summaryCounts,
  };
}

export function computeLocalContinuityFallback(
  findings: Finding[],
  mode: AuditMode
): ContinuityReport {
  const byId = new Map<string, Finding>();
  for (const f of findings) {
    byId.set(f.id.toUpperCase(), f);
  }

  const backupFindings = findings.filter((f) =>
    /f-003|backup|sauvegarde|continuit|retention|versioning|21.*\(c\)|21\.2\.c/i.test(
      `${f.id} ${f.theme} ${f.exigence_nis2} ${f.reel?.ressource || ''} ${f.reel?.constat || ''}`
    )
  );
  const hasBackupGap = backupFindings.some((f) => f.statut !== 'conforme');

  const f005 = byId.get('F-005');
  const f001 = byId.get('F-001');
  const pacsArchiveImmutable = !f005 || f005.statut === 'conforme';
  const pacsExportExposed = Boolean(f001 && f001.statut !== 'conforme');
  const pacsRelatedIds = ['F-005', 'F-001'].filter((fid) => byId.has(fid));

  const incidentF004 = byId.get('F-004');
  const hasSeptemberOutage = Boolean(
    incidentF004 && incidentF004.statut !== 'conforme'
  );

  const adminFindings = findings.filter((f) =>
    /f-002|f-004|f-006|f-007|ssh|0\.0\.0\.0|incident|kms|journalisation|logging/i.test(
      `${f.id} ${f.theme} ${f.exigence_nis2} ${f.reel?.ressource || ''}`
    )
  );
  const hasAdminGap =
    hasSeptemberOutage || adminFindings.some((f) => f.statut !== 'conforme');

  const dpiRelatedIds = Array.from(
    new Set(
      [
        ...backupFindings.map((f) => f.id.toUpperCase()),
        ...(byId.has('F-006') ? ['F-006'] : []),
        ...(byId.has('F-007') ? ['F-007'] : []),
      ].slice(0, 3)
    )
  );

  const adminRelatedIds = Array.from(
    new Set(adminFindings.map((f) => f.id.toUpperCase()).slice(0, 4))
  );

  const processes: ContinuityProcessEntry[] = [
    {
      id: 'PROC-001',
      name: 'DPI Patients',
      criticality: 'VITALE — Soins critiques, Urgences & Prescriptions',
      pssi_ref: 'PSSI §5.1, §5.2 & §5.3',
      rto_target: '4 h (PSSI §5.1)',
      rto_actual: hasBackupGap
        ? '> 72 h sous rançongiciel (2 h 15 hors attaque — PV-PRA-2025-03)'
        : '2 h 15 validé (PV-PRA-2025-03)',
      rto_gap: hasBackupGap,
      rpo_target: '24 h • Rétention 30 j',
      rpo_actual: hasBackupGap
        ? 'Perte totale possible (> 30 j) — sans Bucket Lock WORM'
        : '≤ 24 h garanti (Bucket Lock WORM 30 j)',
      rpo_gap: hasBackupGap,
      ransomware_status: hasBackupGap ? 'EXPOSÉ' : 'IMMUTABLE',
      exposure_level: hasBackupGap ? 'CRITIQUE' : 'MAÎTRISÉ',
      last_test_ref: 'PV-PRA-2025-03 (18 mars 2025 — pré-prod DPI uniquement)',
      context: hasBackupGap
        ? 'Restauration nominale mesurée à 2 h 15 en pré-production, mais gs://ch-valmont-demo-backups-dpi est dépourvu de versioning et de Bucket Lock : une compromission IAM permettrait de détruire les sauvegardes DPI.'
        : 'Objectifs RTO/RPO vérifiés et sauvegardes verrouillées en mode immuable WORM.',
      finding_ids: dpiRelatedIds,
      pra_actions: [
        'Activer immédiatement Object Versioning et une rétention verrouillée WORM (Bucket Lock 30 j) sur gs://ch-valmont-demo-backups-dpi (F-003).',
        'Rejouer l’exercice PRA DPI en simulant la compromission d’un compte administrateur Cloud et la bascule en mode dégradé papier des soins.',
      ],
    },
    {
      id: 'PROC-002',
      name: 'Imagerie PACS / DICOM',
      criticality: 'ESSENTIELLE — Diagnostic Médico-Technique & Radiologie',
      pssi_ref: 'PSSI §3.1, §5.1 & §5.3',
      rto_target: '4 h (PSSI §5.1)',
      rto_actual: 'Non démontré (périmètre PACS exclu du test PV-PRA-2025-03)',
      rto_gap: true,
      rpo_target: '24 h (PSSI §5.1)',
      rpo_actual: pacsArchiveImmutable
        ? '≤ 24 h (versioning actif + rétention WORM verrouillée 365 j — F-005)'
        : 'Exposé (verrouillage absent)',
      rpo_gap: !pacsArchiveImmutable,
      ransomware_status: pacsArchiveImmutable ? 'IMMUTABLE' : 'EXPOSÉ',
      exposure_level: !pacsArchiveImmutable
        ? 'CRITIQUE'
        : pacsExportExposed || Boolean(f005)
        ? 'MODÉRÉ'
        : 'MAÎTRISÉ',
      last_test_ref: 'Aucun PV de restauration PACS (écart PSSI §5.3)',
      context:
        'Le stockage d’archives gs://ch-valmont-demo-archives-pacs bénéficie d’un verrouillage WORM 365 j (témoin conforme F-005), mais la reprise PACS n’a pas été testée lors de l’exercice PV-PRA-2025-03 et export-radiologie reste exposé (F-001).',
      finding_ids: pacsRelatedIds,
      pra_actions: [
        'Étendre l’exercice PRA annuel S1 2026 au périmètre PACS/DICOM afin de qualifier le RTO réel face à la cible de 4 h (PSSI §5.3).',
        'Maintenir le verrouillage WORM 365 j sur archives-pacs (F-005) et supprimer l’exposition publique allUsers sur export-radiologie (F-001).',
      ],
    },
    {
      id: 'PROC-003',
      name: 'Messagerie & Postes Administratifs',
      criticality: 'OPÉRATIONNELLE — Admissions, Facturation & Coordination',
      pssi_ref: 'PSSI §5.1 & §6.1',
      rto_target: '4 h (PSSI §5.1)',
      rto_actual: hasSeptemberOutage
        ? 'Indisponibilité réelle d’une demi-journée (~4 h–6 h) subie en sept. (F-004)'
        : hasAdminGap
        ? 'Non qualifié (aucun test PCA messagerie documenté)'
        : '≤ 4 h conforme PSSI',
      rto_gap: hasSeptemberOutage || hasAdminGap,
      rpo_target: '24 h (PSSI §5.1)',
      rpo_actual: hasSeptemberOutage
        ? 'Traces Cloud Logging de sept. purgées (> 30 j sur _Default — F-007)'
        : 'Rétention forensique plafonnée à 30 j sur _Default (F-007)',
      rpo_gap: hasAdminGap,
      ransomware_status: hasAdminGap ? 'EXPOSÉ' : 'IMMUTABLE',
      exposure_level: hasSeptemberOutage
        ? 'CRITIQUE'
        : hasAdminGap
        ? 'ÉLEVÉ'
        : 'MAÎTRISÉ',
      last_test_ref: hasSeptemberOutage
        ? 'Sinistre réel sept. 2025 (indisponibilité 1/2 journée non notifiée)'
        : 'Vérification documentaire pré-entretien (phase AVANT)',
      context: hasSeptemberOutage
        ? 'Sinistre réel avéré en entretien (F-004) : compromission d’un compte prestataire sur poste administratif en septembre ayant coupé la messagerie une demi-journée sans activation du PCA ni alerte précoce ANSSI 24 h.'
        : 'Surface de mouvement latéral exposée (allow-ssh-anywhere 0.0.0.0/0 F-002, privilèges excessifs F-006 et rétention de journaux limitée à 30 j F-007) fragilisant la messagerie de crise.',
      finding_ids: adminRelatedIds,
      pra_actions: [
        'Déployer un canal de communication de crise hors-bande et coupler le déclenchement PCA/PRA au circuit de notification ANSSI 24 h / CERT Santé (Art. 23 — F-004).',
        'Restreindre SSH au bastion IAP (F-002), révoquer la clé statique prestataire de 248 j (F-006) et porter Cloud Logging _Default à 365 j (F-007).',
      ],
    },
  ];

  const immutableCount = processes.filter(
    (p) => p.ransomware_status === 'IMMUTABLE'
  ).length;
  const exposeCount = processes.filter(
    (p) => p.ransomware_status === 'EXPOSÉ'
  ).length;
  const rtoRpoGaps = processes.filter((p) => p.rto_gap || p.rpo_gap).length;

  const summaryCounts = {
    total: processes.length,
    immutable: immutableCount,
    expose: exposeCount,
    rto_rpo_gaps: rtoRpoGaps,
    critique: processes.filter((p) => p.exposure_level === 'CRITIQUE').length,
    eleve: processes.filter((p) => p.exposure_level === 'ÉLEVÉ').length,
    modere: processes.filter((p) => p.exposure_level === 'MODÉRÉ').length,
    maitrise: processes.filter((p) => p.exposure_level === 'MAÎTRISÉ').length,
  };

  const overallExposure: ContinuityExposureLevel =
    summaryCounts.critique > 0
      ? 'CRITIQUE'
      : summaryCounts.eleve > 0
      ? 'ÉLEVÉ'
      : summaryCounts.modere > 0
      ? 'MODÉRÉ'
      : 'MAÎTRISÉ';

  return {
    mode,
    article:
      'Art. 21 §2 (c) — Continuité des activités, gestion des sauvegardes et reprise après sinistre',
    pssi_reference:
      'PSSI §5.1, §5.2 & §5.3 — Objectifs RTO (4 h) / RPO (24 h), Sauvegardes & Tests PRA',
    source: 'local',
    overall_exposure: overallExposure,
    ransomware_readiness: exposeCount > 0 ? 'EXPOSÉ' : 'IMMUTABLE',
    processes,
    summary_counts: summaryCounts,
  };
}
