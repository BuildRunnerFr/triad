import type {
  AuditMode,
  Finding,
  SanitizedDocument,
  SupplyChainReport,
  SupplyChainRiskLevel,
  SupplyChainVendorEntry,
} from '../types';

export const SUPPLY_CHAIN_RISK_META: Record<
  SupplyChainRiskLevel,
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

export function normalizeSupplyChainRiskLevel(
  raw: unknown
): SupplyChainRiskLevel {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (
    s.includes('CRIT') ||
    s === 'NON_CONFORME' ||
    s === 'QUARANTINE' ||
    s === 'QUARANTAINE'
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

function extractStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        if (typeof o.clause === 'string') return o.clause.trim();
        if (typeof o.text === 'string') return o.text.trim();
        if (typeof o.label === 'string') return o.label.trim();
        if (typeof o.id === 'string') return o.id.trim();
      }
      return '';
    })
    .filter(Boolean);
}

export function normalizeServerSupplyChainReport(
  payload: unknown,
  fallbackMode: AuditMode
): SupplyChainReport | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (obj.has_synthesis === false) return null;

  const rawList = Array.isArray(obj.vendors)
    ? obj.vendors
    : Array.isArray(obj.providers)
    ? obj.providers
    : Array.isArray(obj.third_parties)
    ? obj.third_parties
    : Array.isArray(obj.items)
    ? obj.items
    : Array.isArray(obj.entries)
    ? obj.entries
    : Array.isArray(obj.prestataires)
    ? obj.prestataires
    : null;

  if (!rawList) return null;

  const vendors: SupplyChainVendorEntry[] = rawList
    .map((raw, idx): SupplyChainVendorEntry | null => {
      if (!raw || typeof raw !== 'object') return null;
      const v = raw as Record<string, unknown>;

      const id =
        typeof v.id === 'string' && v.id.trim()
          ? v.id.trim()
          : typeof v.vendor_id === 'string' && v.vendor_id.trim()
          ? v.vendor_id.trim()
          : typeof v.prestataire_id === 'string' && v.prestataire_id.trim()
          ? v.prestataire_id.trim()
          : `SC-${String(idx + 1).padStart(2, '0')}`;

      const name =
        typeof v.name === 'string' && v.name.trim()
          ? v.name.trim()
          : typeof v.vendor === 'string' && v.vendor.trim()
          ? v.vendor.trim()
          : typeof v.prestataire === 'string' && v.prestataire.trim()
          ? v.prestataire.trim()
          : typeof v.provider === 'string' && v.provider.trim()
          ? v.provider.trim()
          : typeof v.title === 'string' && v.title.trim()
          ? v.title.trim()
          : `Prestataire Tiers #${idx + 1}`;

      const role =
        typeof v.role === 'string' && v.role.trim()
          ? v.role.trim()
          : typeof v.category === 'string' && v.category.trim()
          ? v.category.trim()
          : typeof v.service === 'string' && v.service.trim()
          ? v.service.trim()
          : typeof v.perimeter === 'string' && v.perimeter.trim()
          ? v.perimeter.trim()
          : 'Sous-traitant / Tiers critique';

      const context =
        typeof v.context === 'string' && v.context.trim()
          ? v.context.trim()
          : typeof v.description === 'string' && v.description.trim()
          ? v.description.trim()
          : typeof v.constat === 'string' && v.constat.trim()
          ? v.constat.trim()
          : typeof v.summary === 'string' && v.summary.trim()
          ? v.summary.trim()
          : '';

      const quarantined =
        typeof v.quarantined === 'boolean'
          ? v.quarantined
          : typeof v.en_quarantaine === 'boolean'
          ? v.en_quarantaine
          : typeof v.injection_detected === 'boolean'
          ? v.injection_detected
          : typeof v.quarantine_status === 'string'
          ? /quarant|blocked|bloqu|alert/i.test(v.quarantine_status)
          : typeof v.statut_quarantaine === 'string'
          ? /quarant|blocked|bloqu|alert/i.test(v.statut_quarantaine)
          : false;

      const quarantineReason =
        typeof v.quarantine_reason === 'string' && v.quarantine_reason.trim()
          ? v.quarantine_reason.trim()
          : typeof v.raison_quarantaine === 'string' &&
            v.raison_quarantaine.trim()
          ? v.raison_quarantaine.trim()
          : typeof v.quarantine_alert === 'string' && v.quarantine_alert.trim()
          ? v.quarantine_alert.trim()
          : quarantined
          ? 'Tentative d’injection de prompt détectée et isolée en quarantaine par l’Agent Douanier.'
          : null;

      const sourceDoc =
        typeof v.source_document === 'string' && v.source_document.trim()
          ? v.source_document.trim()
          : typeof v.document === 'string' && v.document.trim()
          ? v.document.trim()
          : typeof v.nom_fichier === 'string' && v.nom_fichier.trim()
          ? v.nom_fichier.trim()
          : typeof v.source === 'string' && v.source.trim()
          ? v.source.trim()
          : null;

      const findingIds = extractStringArray(
        v.finding_ids ?? v.findings ?? v.constats_lies ?? v.related_findings
      ).map((fid) => fid.toUpperCase());

      const clauses = extractStringArray(
        v.recommended_clauses ??
          v.clauses ??
          v.contractual_clauses ??
          v.clauses_contractuelles ??
          v.clauses_nis2 ??
          v.recommandations
      );

      const riskLevel = normalizeSupplyChainRiskLevel(
        v.risk_level ??
          v.niveau_risque ??
          v.risk ??
          v.gravite ??
          (quarantined ? 'CRITIQUE' : 'MODÉRÉ')
      );

      return {
        id,
        name,
        role,
        context,
        contract_ref:
          typeof v.contract_ref === 'string' && v.contract_ref.trim()
            ? v.contract_ref.trim()
            : null,
        risk_level: riskLevel,
        finding_ids: findingIds,
        quarantined,
        quarantine_reason: quarantineReason,
        source_document: sourceDoc,
        recommended_clauses:
          clauses.length > 0
            ? clauses
            : [
                'Clause d’auditabilité sécurité et droit d’inspection sur pièce et sur site (Art. 21 §2 d NIS2).',
                'Notification obligatoire sous 24 heures de tout incident affectant le périmètre sous-traité (Art. 23 §4).',
              ],
      };
    })
    .filter((v): v is SupplyChainVendorEntry => v !== null);

  const summaryCounts = {
    total: vendors.length,
    critique: vendors.filter((v) => v.risk_level === 'CRITIQUE').length,
    eleve: vendors.filter((v) => v.risk_level === 'ÉLEVÉ').length,
    modere: vendors.filter((v) => v.risk_level === 'MODÉRÉ').length,
    maitrise: vendors.filter((v) => v.risk_level === 'MAÎTRISÉ').length,
  };

  const overallRisk: SupplyChainRiskLevel = obj.overall_risk
    ? normalizeSupplyChainRiskLevel(obj.overall_risk)
    : obj.niveau_risque_global
    ? normalizeSupplyChainRiskLevel(obj.niveau_risque_global)
    : summaryCounts.critique > 0
    ? 'CRITIQUE'
    : summaryCounts.eleve > 0
    ? 'ÉLEVÉ'
    : summaryCounts.modere > 0
    ? 'MODÉRÉ'
    : 'MAÎTRISÉ';

  const quarantinedDocsCount =
    typeof obj.quarantined_docs_count === 'number'
      ? obj.quarantined_docs_count
      : typeof obj.quarantine_count === 'number'
      ? obj.quarantine_count
      : vendors.filter((v) => v.quarantined).length;

  return {
    session_id: typeof obj.session_id === 'string' ? obj.session_id : undefined,
    mode:
      obj.mode === 'AVANT' || obj.mode === 'APRES' ? obj.mode : fallbackMode,
    article:
      typeof obj.article === 'string' && obj.article.trim()
        ? obj.article.trim()
        : 'Art. 21 §2 (d) & §3 — Sécurité de la chaîne d’approvisionnement',
    source: 'server',
    overall_risk: overallRisk,
    quarantined_docs_count: quarantinedDocsCount,
    vendors,
    summary_counts: summaryCounts,
  };
}

export function computeLocalSupplyChainFallback(
  findings: Finding[],
  docs: SanitizedDocument[],
  mode: AuditMode
): SupplyChainReport {
  const vendors: SupplyChainVendorEntry[] = [];

  const quarantinedVendorDocs = docs.filter(
    (d) =>
      d.statut === 'quarantaine' ||
      /fournisseur|prestataire|maintenance|tiers|sous[-_]?traitant/i.test(
        d.nom_fichier
      )
  );

  const remoteAccessFindings = findings.filter((f) =>
    /ssh|0\.0\.0\.0|pare-feu|firewall|télémaintenance|bastion|iap|f-002/i.test(
      `${f.id} ${f.theme} ${f.reel?.ressource || ''} ${f.reel?.constat || ''}`
    )
  );

  const iamSupplyFindings = findings.filter((f) =>
    /iam|serviceaccount|clé|prestataire|tiers|21\.2\.d|f-006|f-001/i.test(
      `${f.id} ${f.theme} ${f.exigence_nis2} ${f.reel?.ressource || ''}`
    )
  );

  if (quarantinedVendorDocs.length > 0 || remoteAccessFindings.length > 0) {
    const qDoc = quarantinedVendorDocs.find((d) => d.statut === 'quarantaine');
    const relatedIds = Array.from(
      new Set(
        [...remoteAccessFindings, ...iamSupplyFindings]
          .map((f) => f.id.toUpperCase())
          .slice(0, 3)
      )
    );
    vendors.push({
      id: 'SC-01',
      name: 'Prestataire de Télémaintenance Biomédicale / SIH',
      role: 'Maintenance applicative & accès distant infrastructure',
      context: qDoc
        ? `Pièce fournisseur '${qDoc.nom_fichier}' placée en quarantaine anti-injection et accès distant exposé identifié sur le périmètre Cloud.`
        : 'Accès d’administration et de télémaintenance tiers insuffisamment cloisonnés (absence de bastion IAP / MFA systématique).',
      risk_level:
        qDoc ||
        remoteAccessFindings.some(
          (f) => f.statut !== 'conforme' && f.gravite === 'critique'
        )
          ? 'CRITIQUE'
          : remoteAccessFindings.some((f) => f.statut !== 'conforme')
          ? 'ÉLEVÉ'
          : 'MAÎTRISÉ',
      finding_ids: relatedIds,
      quarantined: Boolean(qDoc),
      quarantine_reason:
        qDoc?.raison_quarantaine ||
        (qDoc
          ? 'Injection adverse détectée dans une annexe fournisseur et bloquée avant transmission aux agents LLM.'
          : null),
      source_document: qDoc?.nom_fichier || 'annexe_fournisseur_maintenance.md',
      recommended_clauses: [
        'Imposer contractuellement le passage exclusif par bastion Identity-Aware Proxy (IAP) avec MFA et journalisation nominative (interdiction formelle de tout SSH direct 0.0.0.0/0).',
        'Intégrer une clause d’audit de sécurité contradictoire et d’intégrité documentaire (Art. 21 §2 d NIS2).',
        'Exiger la notification sans délai (< 24 h) de toute compromission d’équipement ou de compte de télémaintenance (Art. 23 §4 NIS2).',
      ],
    });
  }

  const cloudFindings = findings.filter((f) =>
    /storage|bucket|kms|logging|backup|sauvegarde|hds/i.test(
      `${f.theme} ${f.reel?.ressource || ''}`
    )
  );
  const nonCompliantCloud = cloudFindings.filter(
    (f) => f.statut !== 'conforme'
  );
  vendors.push({
    id: 'SC-02',
    name: 'Hébergeur Cloud & Infogérance Infrastructure (GCP europe-west9)',
    role: 'IaaS / Stockage HDS, KMS & Journalisation',
    context:
      nonCompliantCloud.length > 0
        ? `${nonCompliantCloud.length} écart(s) de configuration partagée (responsabilité client/infogérant) relevé(s) sur les actifs Cloud critiques.`
        : 'Socle d’hébergement régional souverain conforme aux contrôles techniques audités.',
    risk_level: nonCompliantCloud.some((f) => f.gravite === 'critique')
      ? 'ÉLEVÉ'
      : nonCompliantCloud.length > 0
      ? 'MODÉRÉ'
      : 'MAÎTRISÉ',
    finding_ids: nonCompliantCloud.slice(0, 3).map((f) => f.id.toUpperCase()),
    quarantined: false,
    quarantine_reason: null,
    source_document: 'gcp_snapshot.json',
    recommended_clauses: [
      'Formaliser la matrice de responsabilité partagée (RACI Cloud / Infogérant / DSI) annexée au contrat HDS & NIS2 Art. 21 §2 (d).',
      'Garantir contractuellement la localisation exclusive des clés KMS et sauvegardes WORM en Union Européenne (europe-west9) et la réversibilité.',
    ],
  });

  const summaryCounts = {
    total: vendors.length,
    critique: vendors.filter((v) => v.risk_level === 'CRITIQUE').length,
    eleve: vendors.filter((v) => v.risk_level === 'ÉLEVÉ').length,
    modere: vendors.filter((v) => v.risk_level === 'MODÉRÉ').length,
    maitrise: vendors.filter((v) => v.risk_level === 'MAÎTRISÉ').length,
  };

  const overallRisk: SupplyChainRiskLevel =
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
      'Art. 21 §2 (d) & §3 — Sécurité de la chaîne d’approvisionnement',
    source: 'local',
    overall_risk: overallRisk,
    quarantined_docs_count: docs.filter((d) => d.statut === 'quarantaine')
      .length,
    vendors,
    summary_counts: summaryCounts,
  };
}
