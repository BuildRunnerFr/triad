export type AuditMode = 'AVANT' | 'APRES';
export type ThemeMode = 'dark' | 'light';
export type NavSection = 'mission' | 'cockpit' | 'triad' | 'compare' | 'deliverables';

export type StatutFinding = 'conforme' | 'partiel' | 'non_conforme' | 'a_confirmer';
export type GraviteFinding = 'critique' | 'haute' | 'moyenne' | 'faible';

export interface DitEvidence {
  source: string;
  extrait: string;
}

export interface EcritEvidence {
  source: string;
  section?: string;
  extrait: string;
}

export interface ReelEvidence {
  outil_gcp?: string;
  ressource: string;
  constat: string;
  preuve?: Record<string, unknown> | null;
  preuve_json?: Record<string, unknown> | null;
}

export type GrcDecisionType =
  | 'a_corriger'
  | 'mesure_compensatoire'
  | 'risque_accepte'
  | 'a_approfondir';

export interface FindingGrcDecision {
  finding_id: string;
  mode: AuditMode;
  decision: GrcDecisionType;
  decision_label: string;
  porteur: string;
  echeance: string;
  commentaire: string;
  updated_at?: string;
}

export interface Finding {
  id: string;
  lot_nis2?: string;
  exigence_nis2: string;
  theme: string;
  statut: StatutFinding;
  gravite: GraviteFinding;
  contradiction: string | null;
  dit: DitEvidence | null;
  ecrit: EcritEvidence | null;
  reel: ReelEvidence | null;
  confiance?: number;
  citation_verifiee: boolean;
  recommandation: string;
  commande_correction: string | null;
  decision_grc?: FindingGrcDecision | null;
}

export interface SanitizedDocument {
  nom_fichier: string;
  type_source?: 'dit' | 'ecrit';
  contenu_masque?: string;
  masquages?: Record<string, number>;
  statut: 'nettoye' | 'quarantaine' | 'pret';
  raison_quarantaine?: string | null;
  extrait_quarantaine?: string | null;
}

export interface AuditSynthesis {
  client: string;
  mode: AuditMode;
  statut_validation: 'EN ATTENTE DE VALIDATION' | 'VALIDÉ';
  findings: Finding[];
  top_3_risques: string[];
  questions_entretien: string[];
  mail_suivi: string;
  documents_nettoyes: SanitizedDocument[];
  documents_quarantaine: SanitizedDocument[];
}

export interface AuditLogEntry {
  ts: string;
  agent: string;
  action: string;
  details: Record<string, unknown> | string;
  prev_hash: string;
  hash: string;
  run_id?: string;
  mode?: string;
}

export interface ChainStatus {
  valide: boolean;
  nb_entrees: number;
  erreur: string | null;
}

export interface AuditLogQueryFilters {
  agent?: string;
  action?: string;
  mode?: string;
  q?: string;
}

export interface AuditLogExplorerResponse {
  session_id?: string;
  chain_valid: boolean;
  chain?: ChainStatus;
  head_hash?: string | null;
  total_entries: number;
  filtered_count: number;
  available_agents: string[];
  available_actions: string[];
  available_modes: string[];
  matched_indices: number[];
  entries: AuditLogEntry[];
}

export interface StatusResponse {
  files: string[];
  mode: AuditMode;
  agent_statuses: Record<string, string>;
  synthesis: AuditSynthesis | null;
  validated: boolean;
  modes_ready?: Record<AuditMode, boolean>;
  modes_validated?: Record<AuditMode, boolean>;
  syntheses_by_mode?: Partial<Record<AuditMode, AuditSynthesis | null>>;
  timings_ms?: Record<string, number> | null;
  timings_by_mode?: Partial<Record<AuditMode, Record<string, number> | null>>;
  decisions?: Record<string, FindingGrcDecision>;
  decisions_by_mode?: Partial<Record<AuditMode, Record<string, FindingGrcDecision>>>;
  security_alert: string | null;
  elapsed_seconds: number | null;
  source: string | null;
  audit_log: AuditLogEntry[];
  chain: ChainStatus;
  session_id?: string;
  run_id?: string | null;
}

export interface SessionSummary {
  session_id: string;
  client?: string | null;
  modes_ready?: Partial<Record<AuditMode, boolean>>;
  modes_validated?: Partial<Record<AuditMode, boolean>>;
  updated_at?: string | null;
  files_count?: number;
}

export interface ServerAuditDiffItem {
  id: string;
  theme: string;
  exigence_nis2: string;
  category:
    | 'dit_contradiction'
    | 'confirmed_gap'
    | 'new_gap'
    | 'resolved_or_compliant';
  category_label: string;
  is_dit_contradiction: boolean;
  is_new_gap: boolean;
  is_confirmed_gap: boolean;
  is_resolved_or_compliant: boolean;
  avant: Finding | null;
  apres: Finding | null;
}

export interface ServerAuditDiffResponse {
  session_id: string;
  client: string;
  ready: boolean;
  modes_ready: Record<AuditMode, boolean>;
  modes_validated: Record<AuditMode, boolean>;
  missing_modes: AuditMode[];
  runs?: Partial<Record<AuditMode, string | null>>;
  score_nis2: {
    avant: number | null;
    apres: number | null;
    delta: number | null;
  };
  counts: {
    findings_avant: number;
    findings_apres: number;
    nouveaux_constats: number;
    ruptures_dit: number;
    ecarts_confirmes: number;
    conformes_ou_leves: number;
  };
  items: ServerAuditDiffItem[];
  chain?: ChainStatus;
  timings_ms?: Record<string, number> | null;
  timings_by_mode?: Partial<Record<AuditMode, Record<string, number> | null>>;
}

export interface AuditorProof {
  service_account: string;
  objet_test: string;
  resultat: string;
  mode: string;
}

export interface DocumentSearchHit {
  nom_fichier: string;
  statut: 'nettoye' | 'quarantaine' | 'pret' | string;
  line: number;
  snippet: string;
  match: string;
}

export interface BundleFileVerificationItem {
  filename: string;
  valid: boolean;
  present?: boolean;
  status?: string;
  expected_sha256?: string | null;
  actual_sha256?: string | null;
  size_bytes?: number | null;
  error?: string | null;
}

export interface ForensicBundleMetadata {
  client?: string | null;
  mode?: string | null;
  session_id?: string | null;
  run_id?: string | null;
  statut_validation?: string | null;
  exported_at?: string | null;
}

export type BundleSignatureStatus = 'VERIFIED' | 'UNSIGNED' | 'INVALID';

export interface ForensicBundleVerificationCertificate {
  authentic: boolean;
  zip_slip_safe: boolean;
  manifest_valid: boolean;
  chain_valid: boolean;
  sealed_json_match: boolean;
  signature_status: BundleSignatureStatus;
  signature_hmac?: string | null;
  bundle_version?: string | null;
  head_hash: string | null;
  sealed_head_hash?: string | null;
  blocks_count?: number | null;
  size_bytes?: number | null;
  metadata?: ForensicBundleMetadata;
  files_checked: BundleFileVerificationItem[];
  errors: string[];
  archive_name?: string;
  verified_at?: string;
}

export interface FindingDecisionPatchPayload {
  decision: GrcDecisionType;
  porteur: string;
  echeance: string;
  commentaire: string;
  mode: AuditMode;
}

export interface FindingDecisionPatchResponse {
  session_id: string;
  mode: AuditMode;
  finding_id: string;
  decision: FindingGrcDecision;
  finding: Finding;
  validated: boolean;
  validation_reset: boolean;
  statut_validation: string;
  decisions: Record<string, FindingGrcDecision>;
  chain: ChainStatus;
}

export interface SimulatedPillarGain {
  id: string;
  title: string;
  article: string;
  current_score: number;
  projected_score: number;
  gain: number;
  finding_ids: string[];
  remediated_ids: string[];
}

export interface SimulatedHorizonWorkload {
  count: number;
  estimated_jh: number;
  finding_ids: string[];
}

export interface RemediationSimulationResult {
  mode: AuditMode;
  source: 'server' | 'local';
  selected_ids: string[];
  remediated_ids: string[];
  total_findings: number;
  actionable_findings: number;
  current_score: number;
  projected_score: number;
  score_delta: number;
  workload_jh: {
    estimated_jh: number;
    min_jh: number;
    max_jh: number;
    label: string;
    quick_wins_count: number;
    by_horizon: Record<'0_30' | '30_60' | '60_90', SimulatedHorizonWorkload>;
  };
  art34_exposure: {
    entity_category: string;
    article: string;
    plafond_sanction_eur: number;
    plafond_ca_pct: number;
    plafond_label: string;
    current_risk_index: number;
    projected_risk_index: number;
    exposure_reduction_pct: number;
    critical_gaps_before: number;
    critical_gaps_after: number;
    risk_level_before: string;
    risk_level_after: string;
  };
  pillars: SimulatedPillarGain[];
}

export interface SessionImportResponse {
  imported: boolean;
  session_id: string;
  client?: string | null;
  mode?: AuditMode;
  modes_ready?: Partial<Record<AuditMode, boolean>>;
  modes_validated?: Partial<Record<AuditMode, boolean>>;
  head_hash?: string | null;
  nb_entrees?: number;
  chain?: ChainStatus;
}

export type SupplyChainRiskLevel =
  | 'CRITIQUE'
  | 'ÉLEVÉ'
  | 'MODÉRÉ'
  | 'MAÎTRISÉ';

export interface SupplyChainVendorEntry {
  id: string;
  name: string;
  role: string;
  context: string;
  contract_ref?: string | null;
  risk_level: SupplyChainRiskLevel;
  finding_ids: string[];
  quarantined: boolean;
  quarantine_reason?: string | null;
  source_document?: string | null;
  recommended_clauses: string[];
}

export interface SupplyChainReport {
  session_id?: string;
  mode: AuditMode;
  article: string;
  source: 'server' | 'local';
  overall_risk: SupplyChainRiskLevel;
  quarantined_docs_count: number;
  vendors: SupplyChainVendorEntry[];
  summary_counts: {
    total: number;
    critique: number;
    eleve: number;
    modere: number;
    maitrise: number;
  };
}

export type ContinuityRansomwareStatus = 'IMMUTABLE' | 'EXPOSÉ';

export type ContinuityExposureLevel =
  | 'CRITIQUE'
  | 'ÉLEVÉ'
  | 'MODÉRÉ'
  | 'MAÎTRISÉ';

export interface ContinuityProcessEntry {
  id: string;
  name: string;
  criticality: string;
  pssi_ref?: string | null;
  rto_target: string;
  rto_actual: string;
  rto_gap: boolean;
  rpo_target: string;
  rpo_actual: string;
  rpo_gap: boolean;
  ransomware_status: ContinuityRansomwareStatus;
  exposure_level: ContinuityExposureLevel;
  context: string;
  finding_ids: string[];
  pra_actions: string[];
  last_test_ref?: string | null;
}

export interface ContinuityReport {
  session_id?: string;
  mode: AuditMode;
  article: string;
  pssi_reference: string;
  source: 'server' | 'local';
  overall_exposure: ContinuityExposureLevel;
  ransomware_readiness: ContinuityRansomwareStatus;
  processes: ContinuityProcessEntry[];
  summary_counts: {
    total: number;
    immutable: number;
    expose: number;
    rto_rpo_gaps: number;
    critique: number;
    eleve: number;
    modere: number;
    maitrise: number;
  };
}

export type CrosswalkFrameworkKey = 'HDS' | 'ISO27001' | 'RGPD';

export type CrosswalkGapStatus =
  | 'non_conforme'
  | 'partiel'
  | 'conforme'
  | 'a_confirmer';

export interface CrosswalkFrameworkSummary {
  framework: CrosswalkFrameworkKey;
  label: string;
  total_controls: number;
  compliant_count: number;
  gap_count: number;
  conformity_pct: number;
  status_label: string;
}

export interface CrosswalkEntry {
  id: string;
  nis2_article: string;
  nis2_title: string;
  domain: string;
  hds_ref: string;
  hds_detail?: string;
  iso27001_ref: string;
  iso27001_detail?: string;
  rgpd_ref: string;
  rgpd_detail?: string;
  frameworks: CrosswalkFrameworkKey[];
  statut: CrosswalkGapStatus;
  gravite?: GraviteFinding;
  summary: string;
  finding_ids: string[];
  cnil_applicable?: boolean;
}

export interface CrosswalkReport {
  session_id?: string;
  mode: AuditMode;
  source: 'server' | 'local';
  title: string;
  frameworks_summary: Record<CrosswalkFrameworkKey, CrosswalkFrameworkSummary>;
  entries: CrosswalkEntry[];
  summary_counts: {
    total: number;
    gaps: number;
    conforme: number;
    non_conforme: number;
    partiel: number;
  };
}

export interface TriadSecurityBarrier {
  id: string;
  label: string;
  category: string;
  active: boolean;
  status_label: string;
  detail: string;
}

export interface TriadSecurityPosture {
  status: string;
  hmac_signing_enabled: boolean;
  gcp_read_only: boolean;
  locked_exports_count: number;
  audit_chain_valid: boolean;
  rate_limiter_enabled: boolean;
  csp_strict: boolean;
  prompt_injection_quarantine: boolean;
  dlp_pii_redaction: boolean;
  max_upload_mb: number;
  barriers: TriadSecurityBarrier[];
  checked_at?: string | null;
}

export type DrawerContent =
  | { type: 'finding'; finding: Finding; allDocs?: SanitizedDocument[] }
  | {
      type: 'doc';
      doc: SanitizedDocument;
      highlightQuote?: string;
      highlightLine?: number;
    }
  | { type: 'report'; markdown: string; synthesis: AuditSynthesis; mode: AuditMode; latestHash?: string }
  | { type: 'mail'; mailText: string; mode: AuditMode }
  | null;
