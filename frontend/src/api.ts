import type {
  AuditLogEntry,
  AuditLogExplorerResponse,
  AuditLogQueryFilters,
  AuditMode,
  BundleFileVerificationItem,
  BundleSignatureStatus,
  ChainStatus,
  DocumentSearchHit,
  FindingDecisionPatchPayload,
  FindingDecisionPatchResponse,
  ForensicBundleVerificationCertificate,
  RemediationSimulationResult,
  SanitizedDocument,
  SessionImportResponse,
  SessionSummary,
  TriadSecurityBarrier,
  TriadSecurityPosture,
} from './types';
import { normalizeServerSimulation } from './utils/grcSimulation';

export const DEFAULT_SESSION_ID = 'default';

/**
 * Normalise un identifiant de session en miroir strict du backend (`[A-Za-z0-9_-]{1,64}`).
 */
export function sanitizeSessionId(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return DEFAULT_SESSION_ID;
  const cleaned = raw.trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return cleaned || DEFAULT_SESSION_ID;
}

/**
 * Client HTTP léger compatible avec l'isolation multi-session (`?session_id=...` -> `X-Session-Id`).
 * Sans paramètre d'URL explicite (ou lorsque `session_id=default`), utilise la session par défaut
 * du serveur pour rester 100 % synchronisé avec les scripts de démonstration CLI.
 */
export function getActiveSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  const param = new URLSearchParams(window.location.search).get('session_id');
  if (!param || !param.trim()) return null;
  const cleaned = sanitizeSessionId(param);
  return cleaned === DEFAULT_SESSION_ID ? null : cleaned;
}

export function getEffectiveSessionId(): string {
  return getActiveSessionId() || DEFAULT_SESSION_ID;
}

/**
 * Met à jour `?session_id=...` dans l'URL sans rechargement complet de la page.
 * Si `sessionId` vaut `'default'` ou `null`, retire le paramètre pour préserver l'URL canonique.
 */
export function setActiveSessionIdInUrl(sessionId: string | null): string {
  const cleaned = sanitizeSessionId(sessionId);
  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    if (cleaned === DEFAULT_SESSION_ID) {
      url.searchParams.delete('session_id');
    } else {
      url.searchParams.set('session_id', cleaned);
    }
    window.history.pushState(
      { sessionId: cleaned },
      '',
      `${url.pathname}${url.search}${url.hash}`
    );
  }
  return cleaned;
}

/**
 * Génère un identifiant de nouvelle session d'audit isolée (`mission-HHMM-xxxx`).
 */
export function createMissionSessionId(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const suffix = Math.random().toString(36).slice(2, 6);
  return `mission-${hh}${mm}-${suffix}`;
}

type RateLimitListener = (retryAfterSeconds: number | null) => void;
let rateLimitListener: RateLimitListener | null = null;

export function setGlobalRateLimitListener(
  listener: RateLimitListener | null
): void {
  rateLimitListener = listener;
}

export function extractRetryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get('Retry-After');
  if (!raw) return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function apiFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
  const sessionId = getActiveSessionId();
  let res: Response;
  if (!sessionId) {
    res = await fetch(input, init);
  } else {
    const headers = new Headers(init?.headers || {});
    headers.set('X-Session-Id', sessionId);
    res = await fetch(input, { ...init, headers });
  }
  if (res.status === 429 && rateLimitListener) {
    rateLimitListener(extractRetryAfterSeconds(res));
  }
  return res;
}

export function buildStreamUrl(basePath: string): string {
  const sessionId = getActiveSessionId();
  if (!sessionId) return basePath;
  const sep = basePath.includes('?') ? '&' : '?';
  return `${basePath}${sep}session_id=${encodeURIComponent(sessionId)}`;
}

function normalizeSessionEntry(item: unknown): SessionSummary | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const rawId = obj.session_id ?? obj.id;
  if (typeof rawId !== 'string' || !rawId.trim()) return null;

  const rawReady =
    obj.modes_ready && typeof obj.modes_ready === 'object'
      ? (obj.modes_ready as Record<string, unknown>)
      : null;
  const rawValidated =
    obj.modes_validated && typeof obj.modes_validated === 'object'
      ? (obj.modes_validated as Record<string, unknown>)
      : null;

  const modesReady: Partial<Record<AuditMode, boolean>> | undefined = rawReady
    ? {
        AVANT: Boolean(rawReady.AVANT),
        APRES: Boolean(rawReady.APRES),
      }
    : undefined;

  const modesValidated: Partial<Record<AuditMode, boolean>> | undefined =
    rawValidated
      ? {
          AVANT: Boolean(rawValidated.AVANT),
          APRES: Boolean(rawValidated.APRES),
        }
      : undefined;

  const filesCount =
    typeof obj.files_count === 'number'
      ? obj.files_count
      : Array.isArray(obj.files)
      ? obj.files.length
      : undefined;

  return {
    session_id: sanitizeSessionId(rawId),
    client: typeof obj.client === 'string' ? obj.client : null,
    modes_ready: modesReady,
    modes_validated: modesValidated,
    updated_at: typeof obj.updated_at === 'string' ? obj.updated_at : null,
    files_count: filesCount,
  };
}

/**
 * Interroge `GET /api/sessions` avec repli gracieux si l'endpoint n'est pas encore disponible.
 */
export async function fetchSessionsList(): Promise<SessionSummary[]> {
  try {
    const res = await apiFetch('/api/sessions');
    if (!res.ok) return [];
    const data: unknown = await res.json();
    const rawItems: unknown[] = Array.isArray(data)
      ? data
      : data &&
        typeof data === 'object' &&
        Array.isArray((data as { sessions?: unknown[] }).sessions)
      ? (data as { sessions: unknown[] }).sessions
      : [];
    return rawItems
      .map(normalizeSessionEntry)
      .filter((s): s is SessionSummary => s !== null);
  } catch {
    return [];
  }
}

/**
 * Supprime une session secondaire persistée (`DELETE /api/sessions/{session_id}`).
 * Protège explicitement la session `default` (démo CH de Valmont).
 */
export async function deletePersistedSession(sessionId: string): Promise<boolean> {
  const cleaned = sanitizeSessionId(sessionId);
  if (cleaned === DEFAULT_SESSION_ID) return false;
  try {
    const res = await apiFetch(`/api/sessions/${encodeURIComponent(cleaned)}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch {
    return false;
  }
}

function normalizeDocumentSearchHit(
  raw: unknown,
  fallbackQuery: string
): DocumentSearchHit | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const nomFichier =
    typeof obj.nom_fichier === 'string'
      ? obj.nom_fichier
      : typeof obj.filename === 'string'
      ? obj.filename
      : typeof obj.file === 'string'
      ? obj.file
      : null;
  const snippet =
    typeof obj.snippet === 'string'
      ? obj.snippet
      : typeof obj.excerpt === 'string'
      ? obj.excerpt
      : typeof obj.extrait === 'string'
      ? obj.extrait
      : null;
  if (!nomFichier || !snippet) return null;

  const rawLine = obj.line ?? obj.line_number ?? obj.ligne ?? 1;
  const line =
    typeof rawLine === 'number' && Number.isFinite(rawLine) && rawLine >= 1
      ? Math.floor(rawLine)
      : 1;
  const statut =
    typeof obj.statut === 'string'
      ? obj.statut
      : typeof obj.status === 'string'
      ? obj.status
      : 'nettoye';
  const match =
    typeof obj.match === 'string' && obj.match.trim()
      ? obj.match
      : fallbackQuery;

  return {
    nom_fichier: nomFichier,
    statut,
    line,
    snippet,
    match,
  };
}

/**
 * Recherche plein-texte inter-documents sur les pièces anonymisées (`GET /api/documents/search?q=...&mode=...`).
 * Retourne `null` en cas d'indisponibilité réseau/endpoint afin d'activer le repli local sur `docs`.
 */
export async function searchDocumentsInSession(
  query: string,
  mode: AuditMode,
  signal?: AbortSignal
): Promise<DocumentSearchHit[] | null> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  try {
    const url = `/api/documents/search?q=${encodeURIComponent(trimmed)}&mode=${encodeURIComponent(mode)}`;
    const res = await apiFetch(url, signal ? { signal } : undefined);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const rawItems: unknown[] | null = Array.isArray(data)
      ? data
      : data && typeof data === 'object'
      ? Array.isArray((data as { results?: unknown[] }).results)
        ? (data as { results: unknown[] }).results
        : Array.isArray((data as { matches?: unknown[] }).matches)
        ? (data as { matches: unknown[] }).matches
        : Array.isArray((data as { items?: unknown[] }).items)
        ? (data as { items: unknown[] }).items
        : Array.isArray((data as { hits?: unknown[] }).hits)
        ? (data as { hits: unknown[] }).hits
        : null
      : null;
    if (!rawItems) return null;
    return rawItems
      .map((item) => normalizeDocumentSearchHit(item, trimmed))
      .filter((h): h is DocumentSearchHit => h !== null)
      .slice(0, 20);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return null;
  }
}

/**
 * Repli local déterministe sur les documents masqués déjà chargés en mémoire (`contenu_masque`).
 */
export function searchDocumentsLocally(
  docs: SanitizedDocument[],
  query: string,
  limit = 20
): DocumentSearchHit[] {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  const lowerQuery = trimmed.toLowerCase();
  const hits: DocumentSearchHit[] = [];

  for (const doc of docs) {
    const masked = doc.contenu_masque;
    if (!masked) continue;
    const lines = masked.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const lineText = lines[idx];
      const matchPos = lineText.toLowerCase().indexOf(lowerQuery);
      if (matchPos === -1) continue;

      const exactMatch = lineText.slice(matchPos, matchPos + trimmed.length);
      const start = Math.max(0, matchPos - 55);
      const end = Math.min(lineText.length, matchPos + trimmed.length + 75);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < lineText.length ? '…' : '';
      const snippet = `${prefix}${lineText.slice(start, end).trim()}${suffix}`;

      hits.push({
        nom_fichier: doc.nom_fichier,
        statut: doc.statut,
        line: idx + 1,
        snippet,
        match: exactMatch,
      });

      if (hits.length >= limit) {
        return hits;
      }
    }
  }

  return hits;
}

function normalizeForensicCertificate(
  payload: unknown,
  archiveName: string
): ForensicBundleVerificationCertificate | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;

  if (typeof obj.authentic !== 'boolean') return null;

  const zipSlipSafe =
    typeof obj.zip_slip_safe === 'boolean' ? obj.zip_slip_safe : true;
  const manifestValid = Boolean(obj.manifest_valid);
  const chainValid = Boolean(obj.chain_valid);
  const sealedJsonMatch =
    typeof obj.sealed_json_match === 'boolean'
      ? obj.sealed_json_match
      : Boolean(obj.authentic && chainValid);
  const headHash =
    typeof obj.head_hash === 'string' && obj.head_hash.trim()
      ? obj.head_hash
      : null;
  const sealedHeadHash =
    typeof obj.sealed_head_hash === 'string' && obj.sealed_head_hash.trim()
      ? obj.sealed_head_hash
      : typeof obj.expected_head_hash === 'string'
      ? obj.expected_head_hash
      : null;
  const blocksCount =
    typeof obj.chain_entries === 'number'
      ? obj.chain_entries
      : typeof obj.blocks_count === 'number'
      ? obj.blocks_count
      : typeof obj.entries_count === 'number'
      ? obj.entries_count
      : null;
  const sizeBytes =
    typeof obj.size_bytes === 'number' ? obj.size_bytes : null;

  const rawMeta =
    obj.metadata && typeof obj.metadata === 'object'
      ? (obj.metadata as Record<string, unknown>)
      : null;
  const metadata = rawMeta
    ? {
        client: typeof rawMeta.client === 'string' ? rawMeta.client : null,
        mode: typeof rawMeta.mode === 'string' ? rawMeta.mode : null,
        session_id:
          typeof rawMeta.session_id === 'string' ? rawMeta.session_id : null,
        run_id: typeof rawMeta.run_id === 'string' ? rawMeta.run_id : null,
        statut_validation:
          typeof rawMeta.statut_validation === 'string'
            ? rawMeta.statut_validation
            : null,
        exported_at:
          typeof rawMeta.exported_at === 'string' ? rawMeta.exported_at : null,
      }
    : undefined;

  const rawErrors = Array.isArray(obj.errors) ? obj.errors : [];
  const errors = rawErrors
    .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
    .filter((e) => Boolean(e));

  const rawFiles = Array.isArray(obj.files_checked) ? obj.files_checked : [];
  const filesChecked: BundleFileVerificationItem[] = rawFiles
    .map((entry): BundleFileVerificationItem | null => {
      if (typeof entry === 'string') {
        const mentionedInErrors = errors.some((err) => err.includes(entry));
        return {
          filename: entry,
          valid: manifestValid && !mentionedInErrors,
          present: true,
          status: manifestValid && !mentionedInErrors ? 'OK' : 'TAMPERED',
        };
      }
      if (!entry || typeof entry !== 'object') return null;
      const f = entry as Record<string, unknown>;
      const filename =
        typeof f.filename === 'string'
          ? f.filename
          : typeof f.file === 'string'
          ? f.file
          : typeof f.name === 'string'
          ? f.name
          : typeof f.path === 'string'
          ? f.path
          : null;
      if (!filename) return null;

      const valid =
        typeof f.valid === 'boolean'
          ? f.valid
          : typeof f.ok === 'boolean'
          ? f.ok
          : typeof f.sha256_valid === 'boolean'
          ? f.sha256_valid
          : typeof f.status === 'string'
          ? f.status.toLowerCase() === 'ok' || f.status.toLowerCase() === 'valid'
          : manifestValid && !errors.some((err) => err.includes(filename));

      return {
        filename,
        valid,
        present: typeof f.present === 'boolean' ? f.present : true,
        status: typeof f.status === 'string' ? f.status : valid ? 'OK' : 'TAMPERED',
        expected_sha256:
          typeof f.expected_sha256 === 'string'
            ? f.expected_sha256
            : typeof f.manifest_sha256 === 'string'
            ? f.manifest_sha256
            : null,
        actual_sha256:
          typeof f.actual_sha256 === 'string'
            ? f.actual_sha256
            : typeof f.computed_sha256 === 'string'
            ? f.computed_sha256
            : typeof f.sha256 === 'string'
            ? f.sha256
            : null,
        size_bytes:
          typeof f.size_bytes === 'number'
            ? f.size_bytes
            : typeof f.size === 'number'
            ? f.size
            : null,
        error: typeof f.error === 'string' ? f.error : null,
      };
    })
    .filter((f): f is BundleFileVerificationItem => f !== null);

  const rawSigStatus =
    typeof obj.signature_status === 'string'
      ? obj.signature_status.trim().toUpperCase()
      : '';
  const signatureStatus: BundleSignatureStatus =
    rawSigStatus === 'VERIFIED' ||
    rawSigStatus === 'UNSIGNED' ||
    rawSigStatus === 'INVALID'
      ? rawSigStatus
      : 'UNSIGNED';

  const signatureHmac =
    typeof obj.signature_hmac === 'string' && obj.signature_hmac.trim()
      ? obj.signature_hmac.trim()
      : typeof obj.hmac_signature === 'string' && obj.hmac_signature.trim()
      ? obj.hmac_signature.trim()
      : typeof obj.manifest_hmac === 'string' && obj.manifest_hmac.trim()
      ? obj.manifest_hmac.trim()
      : null;

  const rawBundleVer =
    typeof obj.bundle_version === 'string' && obj.bundle_version.trim()
      ? obj.bundle_version.trim()
      : typeof obj.format_version === 'string' && obj.format_version.trim()
      ? obj.format_version.trim()
      : null;
  const inferredBundleVersion =
    rawBundleVer ||
    (filesChecked.length >= 12
      ? 'v6'
      : filesChecked.length === 11
      ? 'v5'
      : filesChecked.length === 10
      ? 'v4'
      : filesChecked.length === 9
      ? 'v3'
      : filesChecked.length === 8
      ? 'v2'
      : filesChecked.length === 6
      ? 'v1'
      : null);

  return {
    authentic: obj.authentic,
    zip_slip_safe: zipSlipSafe,
    manifest_valid: manifestValid,
    chain_valid: chainValid,
    sealed_json_match: sealedJsonMatch,
    signature_status: signatureStatus,
    signature_hmac: signatureHmac,
    bundle_version: inferredBundleVersion,
    head_hash: headHash,
    sealed_head_hash: sealedHeadHash,
    blocks_count: blocksCount,
    size_bytes: sizeBytes,
    metadata,
    files_checked: filesChecked,
    errors,
    archive_name:
      typeof obj.filename === 'string' && obj.filename.trim()
        ? obj.filename
        : archiveName,
    verified_at: new Date().toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
  };
}

/**
 * Soumet une archive `.zip` de Dossier de Preuve à `POST /api/verify/bundle` pour expertise forensique.
 */
export async function verifyProofBundleArchive(
  file: File
): Promise<
  | { ok: true; certificate: ForensicBundleVerificationCertificate }
  | { ok: false; status: number; detail: string }
> {
  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await apiFetch('/api/verify/bundle', {
      method: 'POST',
      body: formData,
    });

    let bodyJson: unknown = null;
    try {
      bodyJson = await res.json();
    } catch {
      bodyJson = null;
    }

    const parsedCert = normalizeForensicCertificate(bodyJson, file.name);
    if (res.ok && parsedCert) {
      return { ok: true, certificate: parsedCert };
    }

    const detail =
      bodyJson &&
      typeof bodyJson === 'object' &&
      typeof (bodyJson as { detail?: unknown }).detail === 'string'
        ? ((bodyJson as { detail: string }).detail)
        : res.status === 413
        ? 'Archive trop volumineuse (limite maximale fixée à 20 Mo).'
        : res.status === 400
        ? 'Format d’archive invalide : veuillez fournir un fichier .zip valide.'
        : `Échec de la vérification forensique (HTTP ${res.status}).`;

    return { ok: false, status: res.status, detail };
  } catch {
    return {
      ok: false,
      status: 0,
      detail: 'Impossible de joindre le service de vérification forensique.',
    };
  }
}

/**
 * Enregistre une décision d'arbitrage GRC sur un constat (`PATCH /api/findings/{finding_id}/decision`).
 */
export async function patchFindingGrcDecision(
  findingId: string,
  payload: FindingDecisionPatchPayload
): Promise<
  | { ok: true; data: FindingDecisionPatchResponse }
  | { ok: false; status: number; detail: string }
> {
  try {
    const url = `/api/findings/${encodeURIComponent(findingId)}/decision?mode=${encodeURIComponent(payload.mode)}`;
    const res = await apiFetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    let bodyJson: unknown = null;
    try {
      bodyJson = await res.json();
    } catch {
      bodyJson = null;
    }

    if (res.ok && bodyJson && typeof bodyJson === 'object') {
      return {
        ok: true,
        data: bodyJson as FindingDecisionPatchResponse,
      };
    }

    const detail =
      bodyJson &&
      typeof bodyJson === 'object' &&
      typeof (bodyJson as { detail?: unknown }).detail === 'string'
        ? ((bodyJson as { detail: string }).detail)
        : `Échec de l’enregistrement de la décision GRC (HTTP ${res.status}).`;

    return { ok: false, status: res.status, detail };
  } catch {
    return {
      ok: false,
      status: 0,
      detail: 'Impossible de joindre le service d’arbitrage GRC.',
    };
  }
}

/**
 * Simule l'impact et le ROI NIS2 côté serveur (`POST /api/remediation/simulate`).
 */
export async function simulateRemediationImpact(
  selectedIds: string[],
  mode: AuditMode,
  signal?: AbortSignal
): Promise<RemediationSimulationResult | null> {
  try {
    const url = `/api/remediation/simulate?mode=${encodeURIComponent(mode)}`;
    const res = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected_ids: selectedIds, mode }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return normalizeServerSimulation(data, mode);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return null;
  }
}

function extractFilenameFromDisposition(
  res: Response,
  fallbackFilename: string
): string {
  const disposition = res.headers.get('Content-Disposition') || '';
  const matchedName = disposition.match(/filename="?([^";]+)"?/i)?.[1]?.trim();
  return matchedName || fallbackFilename;
}

/**
 * Récupère le brouillon réglementaire de Pré-Notification ANSSI Art. 23 NIS2
 * (`GET /api/export/anssi-draft?mode=...`), protégé par le verrou humain HTTP 403.
 */
export async function fetchAnssiDraft(
  mode: AuditMode
): Promise<
  | { ok: true; markdown: string; filename: string }
  | { ok: false; status: number; detail: string }
> {
  try {
    const res = await apiFetch(
      `/api/export/anssi-draft?mode=${encodeURIComponent(mode)}`
    );
    if (res.ok) {
      const markdown = await res.text();
      const filename = extractFilenameFromDisposition(
        res,
        `TRIAD_PreNotification_ANSSI_Art23_${mode}.md`
      );
      return { ok: true, markdown, filename };
    }

    let detail =
      res.status === 403
        ? 'Export pré-notification ANSSI bloqué : validation humaine du consultant requise.'
        : `Échec de la génération du brouillon ANSSI Art. 23 (HTTP ${res.status}).`;
    try {
      const errJson: unknown = await res.json();
      if (
        errJson &&
        typeof errJson === 'object' &&
        typeof (errJson as { detail?: unknown }).detail === 'string'
      ) {
        detail = (errJson as { detail: string }).detail;
      }
    } catch {
      // Conserver le message par défaut
    }
    return { ok: false, status: res.status, detail };
  } catch {
    return {
      ok: false,
      status: 0,
      detail: 'Impossible de joindre le générateur de pré-notification ANSSI.',
    };
  }
}

/**
 * Récupère le Brief Exécutif Organes de Direction — Art. 20 NIS2
 * (`GET /api/export/comex-brief?mode=...`), protégé par le verrou humain HTTP 403.
 */
export async function fetchComexBrief(
  mode: AuditMode
): Promise<
  | {
      ok: true;
      markdown: string;
      filename: string;
      signatureHeader: string | null;
    }
  | { ok: false; status: number; detail: string }
> {
  try {
    const res = await apiFetch(
      `/api/export/comex-brief?mode=${encodeURIComponent(mode)}`
    );
    if (res.ok) {
      const markdown = await res.text();
      const filename = extractFilenameFromDisposition(
        res,
        `TRIAD_Brief_COMEX_Art20_${mode}.md`
      );
      const signatureHeader = res.headers.get('X-Triad-Signature');
      return { ok: true, markdown, filename, signatureHeader };
    }

    let detail =
      res.status === 403
        ? 'Export brief COMEX bloqué : validation humaine du consultant requise.'
        : `Échec de la génération du Brief COMEX Art. 20 (HTTP ${res.status}).`;
    try {
      const errJson: unknown = await res.json();
      if (
        errJson &&
        typeof errJson === 'object' &&
        typeof (errJson as { detail?: unknown }).detail === 'string'
      ) {
        detail = (errJson as { detail: string }).detail;
      }
    } catch {
      // Conserver le message par défaut
    }
    return { ok: false, status: res.status, detail };
  } catch {
    return {
      ok: false,
      status: 0,
      detail: 'Impossible de joindre le générateur de Brief COMEX Art. 20.',
    };
  }
}

/**
 * Télécharge et récupère le Manifeste Terraform GitOps GCP (`GET /api/export/terraform?mode=...`).
 */
export async function fetchTerraformRemediation(
  mode: AuditMode
): Promise<
  | {
      ok: true;
      hclText: string;
      filename: string;
      signatureHeader: string | null;
    }
  | { ok: false; status: number; detail: string }
> {
  try {
    const res = await apiFetch(
      `/api/export/terraform?mode=${encodeURIComponent(mode)}`
    );
    if (res.ok) {
      const hclText = await res.text();
      const filename = extractFilenameFromDisposition(
        res,
        `TRIAD_Remediation_GitOps_${mode}.tf`
      );
      const signatureHeader = res.headers.get('X-Triad-Signature');
      return { ok: true, hclText, filename, signatureHeader };
    }

    let detail =
      res.status === 403
        ? 'Export Manifeste Terraform bloqué : validation humaine du consultant requise.'
        : `Échec de la génération du Manifeste Terraform GitOps (HTTP ${res.status}).`;
    try {
      const errJson: unknown = await res.json();
      if (
        errJson &&
        typeof errJson === 'object' &&
        typeof (errJson as { detail?: unknown }).detail === 'string'
      ) {
        detail = (errJson as { detail: string }).detail;
      }
    } catch {
      // Conserver le message par défaut
    }
    return { ok: false, status: res.status, detail };
  } catch {
    return {
      ok: false,
      status: 0,
      detail: 'Impossible de joindre le générateur de Manifeste Terraform GitOps.',
    };
  }
}

/**
 * Télécharge et récupère le Guide d'Entretien Contradictoire pré-rempli
 * (`GET /api/export/interview-guide?mode=...`), protégé par le 10e verrou humain HTTP 403.
 */
export async function fetchInterviewGuide(
  mode: AuditMode
): Promise<
  | {
      ok: true;
      markdown: string;
      filename: string;
      signatureHeader: string | null;
    }
  | { ok: false; status: number; detail: string }
> {
  try {
    const res = await apiFetch(
      `/api/export/interview-guide?mode=${encodeURIComponent(mode)}`
    );
    if (res.ok) {
      const markdown = await res.text();
      const filename = extractFilenameFromDisposition(
        res,
        `TRIAD_Guide_Entretien_Contradictoire_${mode}.md`
      );
      const signatureHeader = res.headers.get('X-Triad-Signature');
      return { ok: true, markdown, filename, signatureHeader };
    }

    let detail =
      res.status === 403
        ? "Export Guide d'Entretien Contradictoire bloqué : validation humaine du consultant requise."
        : `Échec de la génération du Guide d'Entretien Contradictoire (HTTP ${res.status}).`;
    try {
      const errJson: unknown = await res.json();
      if (
        errJson &&
        typeof errJson === 'object' &&
        typeof (errJson as { detail?: unknown }).detail === 'string'
      ) {
        detail = (errJson as { detail: string }).detail;
      }
    } catch {
      // Conserver le message par défaut
    }
    return { ok: false, status: res.status, detail };
  } catch {
    return {
      ok: false,
      status: 0,
      detail: "Impossible de joindre le générateur de Guide d'Entretien Contradictoire.",
    };
  }
}

/**
 * Télécharge et récupère le Registre Officiel des Arbitrages GRC & Risques Résiduels
 * (`GET /api/export/risk-register?mode=...`), protégé par le 11e verrou humain HTTP 403.
 */
export async function fetchRiskRegister(
  mode: AuditMode
): Promise<
  | {
      ok: true;
      markdown: string;
      filename: string;
      signatureHeader: string | null;
    }
  | { ok: false; status: number; detail: string }
> {
  try {
    const res = await apiFetch(
      `/api/export/risk-register?mode=${encodeURIComponent(mode)}`
    );
    if (res.ok) {
      const markdown = await res.text();
      const filename = extractFilenameFromDisposition(
        res,
        `TRIAD_Registre_Arbitrages_GRC_${mode}.md`
      );
      const signatureHeader = res.headers.get('X-Triad-Signature');
      return { ok: true, markdown, filename, signatureHeader };
    }

    let detail =
      res.status === 403
        ? "Export Registre d'Arbitrages GRC bloqué : validation humaine du consultant requise."
        : `Échec de la génération du Registre d'Arbitrages GRC (HTTP ${res.status}).`;
    try {
      const errJson: unknown = await res.json();
      if (
        errJson &&
        typeof errJson === 'object' &&
        typeof (errJson as { detail?: unknown }).detail === 'string'
      ) {
        detail = (errJson as { detail: string }).detail;
      }
    } catch {
      // Conserver le message par défaut
    }
    return { ok: false, status: res.status, detail };
  } catch {
    return {
      ok: false,
      status: 0,
      detail: "Impossible de joindre le générateur du Registre d'Arbitrages GRC.",
    };
  }
}

/**
 * Télécharge et récupère la Fiche d'Évaluation & Pré-Notification CNIL — RGPD Art. 33 & 34
 * (`GET /api/export/cnil-draft?mode=...`), protégée par le 12e verrou humain HTTP 403.
 */
export async function fetchCnilDraft(
  mode: AuditMode
): Promise<
  | {
      ok: true;
      markdown: string;
      filename: string;
      signatureHeader: string | null;
    }
  | { ok: false; status: number; detail: string }
> {
  try {
    const res = await apiFetch(
      `/api/export/cnil-draft?mode=${encodeURIComponent(mode)}`
    );
    if (res.ok) {
      const markdown = await res.text();
      const filename = extractFilenameFromDisposition(
        res,
        `TRIAD_Evaluation_CNIL_RGPD_Art33_${mode}.md`
      );
      const signatureHeader = res.headers.get('X-Triad-Signature');
      return { ok: true, markdown, filename, signatureHeader };
    }

    let detail =
      res.status === 403
        ? 'Export Évaluation CNIL Art. 33 bloqué : validation humaine du consultant requise.'
        : `Échec de la génération de l'Évaluation CNIL RGPD Art. 33 (HTTP ${res.status}).`;
    try {
      const errJson: unknown = await res.json();
      if (
        errJson &&
        typeof errJson === 'object' &&
        typeof (errJson as { detail?: unknown }).detail === 'string'
      ) {
        detail = (errJson as { detail: string }).detail;
      }
    } catch {
      // Conserver le message par défaut
    }
    return { ok: false, status: res.status, detail };
  } catch {
    return {
      ok: false,
      status: 0,
      detail: "Impossible de joindre le générateur d'Évaluation CNIL RGPD Art. 33.",
    };
  }
}

/**
 * Télécharge l'attestation logicielle souveraine SBOM CycloneDX 1.5 (`GET /api/security/sbom`).
 */
export async function fetchRuntimeSbom(): Promise<
  | {
      ok: true;
      jsonText: string;
      filename: string;
      specVersion: string;
      componentsCount: number;
      signatureHeader: string | null;
    }
  | { ok: false; status: number; detail: string }
> {
  try {
    const res = await apiFetch('/api/security/sbom');
    if (res.ok) {
      const jsonText = await res.text();
      const filename = extractFilenameFromDisposition(
        res,
        'TRIAD_SBOM_CycloneDX_1.5.json'
      );
      const signatureHeader = res.headers.get('X-Triad-Signature');
      let specVersion = '1.5';
      let componentsCount = 0;
      try {
        const parsed: unknown = JSON.parse(jsonText);
        if (parsed && typeof parsed === 'object') {
          const obj = parsed as Record<string, unknown>;
          if (typeof obj.specVersion === 'string' && obj.specVersion.trim()) {
            specVersion = obj.specVersion.trim();
          }
          if (Array.isArray(obj.components)) {
            componentsCount = obj.components.length;
          }
        }
      } catch {
        // Conserver les métadonnées par défaut si JSON compact/brut
      }
      return {
        ok: true,
        jsonText,
        filename,
        specVersion,
        componentsCount,
        signatureHeader,
      };
    }

    let detail = `Échec de la récupération de l'attestation SBOM CycloneDX (HTTP ${res.status}).`;
    try {
      const errJson: unknown = await res.json();
      if (
        errJson &&
        typeof errJson === 'object' &&
        typeof (errJson as { detail?: unknown }).detail === 'string'
      ) {
        detail = (errJson as { detail: string }).detail;
      }
    } catch {
      // Conserver le message par défaut
    }
    return { ok: false, status: res.status, detail };
  } catch {
    return {
      ok: false,
      status: 0,
      detail: "Impossible de joindre le service d'attestation SBOM CycloneDX.",
    };
  }
}

/**
 * Interroge l'explorateur forensique multi-critères du registre SHA-256 (`GET /api/audit/log`).
 * Préserve l'état d'intégrité `chain_valid` vérifié sur la chaîne complète non filtrée.
 */
export async function fetchFilteredAuditLog(
  filters: AuditLogQueryFilters,
  signal?: AbortSignal
): Promise<AuditLogExplorerResponse | null> {
  try {
    const params = new URLSearchParams();
    if (filters.agent && filters.agent.trim()) {
      params.set('agent', filters.agent.trim());
    }
    if (filters.action && filters.action.trim()) {
      params.set('action', filters.action.trim());
    }
    if (filters.mode && filters.mode.trim()) {
      params.set('mode', filters.mode.trim());
    }
    if (filters.q && filters.q.trim()) {
      params.set('q', filters.q.trim());
    }
    const qs = params.toString();
    const url = `/api/audit/log${qs ? `?${qs}` : ''}`;
    const res = await apiFetch(url, signal ? { signal } : undefined);
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    const rawEntries = Array.isArray(obj.entries)
      ? obj.entries
      : Array.isArray(obj.audit_log)
      ? obj.audit_log
      : [];
    const entries = rawEntries.filter(
      (item): item is AuditLogEntry => Boolean(item && typeof item === 'object')
    );

    const rawChain =
      obj.chain && typeof obj.chain === 'object'
        ? (obj.chain as Record<string, unknown>)
        : null;
    const chainObj: ChainStatus | undefined = rawChain
      ? {
          valide: Boolean(rawChain.valide),
          nb_entrees:
            typeof rawChain.nb_entrees === 'number'
              ? rawChain.nb_entrees
              : entries.length,
          erreur: typeof rawChain.erreur === 'string' ? rawChain.erreur : null,
        }
      : undefined;

    const chainValid =
      typeof obj.chain_valid === 'boolean'
        ? obj.chain_valid
        : chainObj
        ? chainObj.valide
        : true;

    const totalEntries =
      typeof obj.total_entries === 'number'
        ? obj.total_entries
        : chainObj
        ? chainObj.nb_entrees
        : entries.length;

    const filteredCount =
      typeof obj.filtered_count === 'number'
        ? obj.filtered_count
        : entries.length;

    const toStrList = (val: unknown): string[] =>
      Array.isArray(val)
        ? val
            .filter((x): x is string => typeof x === 'string' && Boolean(x.trim()))
            .map((x) => x.trim())
        : [];

    const matchedIndices = Array.isArray(obj.matched_indices)
      ? obj.matched_indices.filter(
          (n): n is number => typeof n === 'number' && Number.isFinite(n)
        )
      : [];

    return {
      session_id: typeof obj.session_id === 'string' ? obj.session_id : undefined,
      chain_valid: chainValid,
      chain: chainObj,
      head_hash: typeof obj.head_hash === 'string' ? obj.head_hash : null,
      total_entries: totalEntries,
      filtered_count: filteredCount,
      available_agents: toStrList(obj.available_agents),
      available_actions: toStrList(obj.available_actions),
      available_modes: toStrList(obj.available_modes),
      matched_indices: matchedIndices,
      entries,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return null;
  }
}

function readNestedBool(
  val: unknown,
  fallback = true
): { active: boolean; detail?: string } {
  if (typeof val === 'boolean') return { active: val };
  if (val && typeof val === 'object') {
    const o = val as Record<string, unknown>;
    const active =
      typeof o.enabled === 'boolean'
        ? o.enabled
        : typeof o.active === 'boolean'
        ? o.active
        : typeof o.valid === 'boolean'
        ? o.valid
        : typeof o.enforced === 'boolean'
        ? o.enforced
        : fallback;
    const detail =
      typeof o.detail === 'string'
        ? o.detail
        : typeof o.description === 'string'
        ? o.description
        : typeof o.summary === 'string'
        ? o.summary
        : typeof o.mode === 'string'
        ? o.mode
        : undefined;
    return { active, detail };
  }
  return { active: fallback };
}

/**
 * Récupère et normalise la Posture d'Auto-Sécurité TRIAD (`GET /api/security/posture?mode=...`).
 */
export async function fetchSecurityPosture(
  mode?: AuditMode,
  signal?: AbortSignal
): Promise<TriadSecurityPosture | null> {
  try {
    const query = mode ? `?mode=${encodeURIComponent(mode)}` : '';
    const res = await apiFetch(
      `/api/security/posture${query}`,
      signal ? { signal } : undefined
    );
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;

    const hmacEnabled =
      typeof obj.hmac_signing_enabled === 'boolean'
        ? obj.hmac_signing_enabled
        : obj.hmac_signing && typeof obj.hmac_signing === 'object'
        ? Boolean(
            (obj.hmac_signing as Record<string, unknown>).enabled ??
              (obj.hmac_signing as Record<string, unknown>).active
          )
        : false;

    const gcpReadOnly = readNestedBool(
      obj.gcp_read_only ?? obj.least_privilege_gcp ?? obj.gcp_least_privilege,
      true
    );
    const chainInfo = readNestedBool(
      obj.sha256_append_only ?? obj.audit_chain ?? obj.audit_chain_valid,
      true
    );
    const rateLimiter = readNestedBool(
      obj.rate_limiter ?? obj.rate_limiter_enabled ?? obj.anti_abuse_rate_limit,
      true
    );
    const cspHeaders = readNestedBool(
      obj.csp_headers ?? obj.security_headers ?? obj.csp_strict,
      true
    );
    const injectionQuarantine = readNestedBool(
      obj.prompt_injection_quarantine ??
        obj.anti_injection_quarantine ??
        obj.quarantine_guard,
      true
    );
    const dlpRedaction = readNestedBool(
      obj.dlp_pii_redaction ?? obj.pii_redaction ?? obj.dlp_guard,
      true
    );

    let lockedExportsCount = 12;
    if (typeof obj.locked_exports_count === 'number') {
      lockedExportsCount = obj.locked_exports_count;
    } else if (
      obj.human_validation_locks &&
      typeof obj.human_validation_locks === 'object'
    ) {
      const hvl = obj.human_validation_locks as Record<string, unknown>;
      if (typeof hvl.count === 'number') {
        lockedExportsCount = hvl.count;
      } else if (typeof hvl.locked_endpoints_count === 'number') {
        lockedExportsCount = hvl.locked_endpoints_count;
      } else if (Array.isArray(hvl.endpoints)) {
        lockedExportsCount = hvl.endpoints.length;
      }
    } else if (Array.isArray(obj.locked_exports)) {
      lockedExportsCount = obj.locked_exports.length;
    }

    let maxUploadMb = 2;
    if (typeof obj.max_upload_mb === 'number') {
      maxUploadMb = obj.max_upload_mb;
    } else if (obj.upload_limits && typeof obj.upload_limits === 'object') {
      const ul = obj.upload_limits as Record<string, unknown>;
      if (typeof ul.max_file_mb === 'number') {
        maxUploadMb = ul.max_file_mb;
      } else if (typeof ul.max_upload_bytes === 'number') {
        maxUploadMb = Math.max(
          1,
          Math.round(ul.max_upload_bytes / (1024 * 1024))
        );
      }
    }

    const rawBarriers = Array.isArray(obj.barriers)
      ? obj.barriers
      : Array.isArray(obj.controls)
      ? obj.controls
      : Array.isArray(obj.checks)
      ? obj.checks
      : Array.isArray(obj.guards)
      ? obj.guards
      : null;

    let barriers: TriadSecurityBarrier[] = [];
    if (rawBarriers && rawBarriers.length > 0) {
      barriers = rawBarriers
        .map((item, idx): TriadSecurityBarrier | null => {
          if (!item || typeof item !== 'object') return null;
          const b = item as Record<string, unknown>;
          const id =
            typeof b.id === 'string' && b.id.trim()
              ? b.id.trim()
              : typeof b.key === 'string' && b.key.trim()
              ? b.key.trim()
              : `barrier-${idx + 1}`;
          const label =
            typeof b.label === 'string' && b.label.trim()
              ? b.label.trim()
              : typeof b.title === 'string' && b.title.trim()
              ? b.title.trim()
              : typeof b.name === 'string' && b.name.trim()
              ? b.name.trim()
              : id;
          const category =
            typeof b.category === 'string' && b.category.trim()
              ? b.category.trim()
              : 'Défense active';
          const isHmacBarrier = /hmac|signing/i.test(`${id} ${label}`);
          const active =
            typeof b.active === 'boolean'
              ? b.active
              : typeof b.enabled === 'boolean'
              ? b.enabled
              : typeof b.enforced === 'boolean'
              ? b.enforced
              : isHmacBarrier
              ? hmacEnabled
              : true;
          const statusLabel =
            typeof b.status_label === 'string' && b.status_label.trim()
              ? b.status_label.trim()
              : typeof b.status === 'string' && b.status.trim()
              ? b.status.trim()
              : isHmacBarrier
              ? active
                ? 'VERIFIED / ACTIF'
                : 'UNSIGNED (Optionnel)'
              : active
              ? 'ACTIF ✓'
              : 'INACTIF';
          const detail =
            typeof b.detail === 'string' && b.detail.trim()
              ? b.detail.trim()
              : typeof b.description === 'string' && b.description.trim()
              ? b.description.trim()
              : typeof b.summary === 'string' && b.summary.trim()
              ? b.summary.trim()
              : '';
          return {
            id,
            label,
            category,
            active,
            status_label: statusLabel,
            detail,
          };
        })
        .filter((b): b is TriadSecurityBarrier => b !== null);
    }

    if (barriers.length === 0) {
      barriers = [
        {
          id: 'gcp_readonly',
          label: 'Moindre privilège GCP (Lecture seule)',
          category: 'Isolation Cloud',
          active: gcpReadOnly.active,
          status_label: gcpReadOnly.active ? 'ACTIF ✓' : 'INACTIF',
          detail:
            gcpReadOnly.detail ||
            'Aucune écriture ni exécution automatique sur Google Cloud Platform.',
        },
        {
          id: 'human_locks_403',
          label: `Verrous humains obligatoires (${lockedExportsCount} exports HTTP 403)`,
          category: 'Gouvernance Humaine',
          active: lockedExportsCount >= 12,
          status_label: `${lockedExportsCount} VERROUS ACTIFS ✓`,
          detail:
            "Rapport, Mail, JSON, CSV, Playbook, ANSSI Art. 23, COMEX Art. 20, Terraform .tf, Guide d'Entretien .md, Registre GRC .md, Évaluation CNIL Art. 33 .md et Bundle .zip (12 pièces) bloqués avant signature.",
        },
        {
          id: 'sha256_chain',
          label: 'Chaîne cryptographique SHA-256 append-only',
          category: 'Intégrité Forensique',
          active: chainInfo.active,
          status_label: chainInfo.active ? 'INTÈGRE ✓' : 'ALERTE ✕',
          detail:
            chainInfo.detail ||
            'Journal immuable chaîné depuis le bloc genèse 0×64 avec archivage WORM.',
        },
        {
          id: 'hmac_seal',
          label: 'Sceau émetteur HMAC-SHA256 (AUDIT_SIGNING_SECRET)',
          category: 'Authenticité Émetteur',
          active: hmacEnabled,
          status_label: hmacEnabled
            ? 'ACTIVÉ (X-Triad-Signature) ✓'
            : 'UNSIGNED (Clé non configurée)',
          detail: hmacEnabled
            ? 'Signature HMAC-SHA256 active sur les 12 livrables exportés, SBOM et snapshots.'
            : 'Intégrité SHA-256 active ; configurez AUDIT_SIGNING_SECRET pour signer les exports en HMAC-SHA256.',
        },
        {
          id: 'quarantine_guard',
          label: 'Quarantaine Anti-Injection de Prompt (Douanier)',
          category: 'Sécurité IA',
          active: injectionQuarantine.active,
          status_label: injectionQuarantine.active ? 'ACTIF ✓' : 'INACTIF',
          detail:
            injectionQuarantine.detail ||
            'Isolement déterministe des pièces adverses avant toute soumission au LLM.',
        },
        {
          id: 'dlp_pii',
          label: 'Masquage PII / DLP Souverain avant LLM',
          category: 'Protection HDS / RGPD',
          active: dlpRedaction.active,
          status_label: dlpRedaction.active ? 'ACTIF ✓' : 'INACTIF',
          detail:
            dlpRedaction.detail ||
            'Pseudonymisation locale des identités, NIR, e-mails, IP et secrets avant analyse.',
        },
        {
          id: 'rate_limiter_429',
          label: 'Limiteur anti-abus HTTP 429 (Retry-After)',
          category: 'Disponibilité API',
          active: rateLimiter.active,
          status_label: rateLimiter.active ? 'ACTIF ✓' : 'INACTIF',
          detail:
            rateLimiter.detail ||
            'Fenêtre glissante par IP protégeant les routes coûteuses d’audit et de vérification.',
        },
        {
          id: 'csp_headers',
          label: 'En-têtes HTTP stricts & Content-Security-Policy',
          category: 'Durcissement Web',
          active: cspHeaders.active,
          status_label: cspHeaders.active ? 'ACTIF ✓' : 'INACTIF',
          detail:
            cspHeaders.detail ||
            'CSP sans unsafe-inline script, X-Content-Type-Options: nosniff, X-Frame-Options: DENY.',
        },
        {
          id: 'upload_bounds',
          label: `Contrôles d'upload & anti-ZipSlip (${maxUploadMb} Mo / pièce)`,
          category: 'Surface d’Entrée',
          active: true,
          status_label: 'ACTIF ✓',
          detail:
            'Filtrage strict des extensions (.md/.txt/.json), lecture par blocs mémoire et inspection CRC-32.',
        },
      ];
    }

    return {
      status:
        typeof obj.status === 'string' && obj.status.trim()
          ? obj.status.trim()
          : 'OPÉRATIONNEL',
      hmac_signing_enabled: hmacEnabled,
      gcp_read_only: gcpReadOnly.active,
      locked_exports_count: lockedExportsCount,
      audit_chain_valid: chainInfo.active,
      rate_limiter_enabled: rateLimiter.active,
      csp_strict: cspHeaders.active,
      prompt_injection_quarantine: injectionQuarantine.active,
      dlp_pii_redaction: dlpRedaction.active,
      max_upload_mb: maxUploadMb,
      barriers,
      checked_at:
        typeof obj.checked_at === 'string'
          ? obj.checked_at
          : typeof obj.timestamp === 'string'
          ? obj.timestamp
          : null,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return null;
  }
}

/**
 * Exporte l'instantané portable complet d'une session (`GET /api/sessions/{session_id}/snapshot`).
 */
export async function exportSessionSnapshot(
  sessionId: string
): Promise<
  | { ok: true; filename: string; jsonText: string }
  | { ok: false; status: number; detail: string }
> {
  const cleaned = sanitizeSessionId(sessionId);
  try {
    const res = await apiFetch(
      `/api/sessions/${encodeURIComponent(cleaned)}/snapshot`
    );
    if (res.ok) {
      const jsonText = await res.text();
      const filename = extractFilenameFromDisposition(
        res,
        `TRIAD_Session_Snapshot_${cleaned}.json`
      );
      return { ok: true, filename, jsonText };
    }

    let detail = `Échec de l’export du snapshot de session (HTTP ${res.status}).`;
    try {
      const errJson: unknown = await res.json();
      if (
        errJson &&
        typeof errJson === 'object' &&
        typeof (errJson as { detail?: unknown }).detail === 'string'
      ) {
        detail = (errJson as { detail: string }).detail;
      }
    } catch {
      // Conserver le message par défaut
    }
    return { ok: false, status: res.status, detail };
  } catch {
    return {
      ok: false,
      status: 0,
      detail: 'Impossible de joindre le service d’export de session.',
    };
  }
}

/**
 * Restaure une session depuis un fichier Snapshot `.json` (`POST /api/sessions/import`)
 * après vérification cryptographique complète de la chaîne SHA-256 côté serveur.
 */
export async function importSessionSnapshot(
  file: File
): Promise<
  | { ok: true; sessionId: string; data: SessionImportResponse }
  | { ok: false; status: number; detail: string }
> {
  const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
  if (file.size > MAX_SNAPSHOT_BYTES) {
    return {
      ok: false,
      status: 413,
      detail: 'Snapshot de session trop volumineux (limite maximale fixée à 20 Mo).',
    };
  }

  let rawText = '';
  try {
    rawText = await file.text();
  } catch {
    return {
      ok: false,
      status: 400,
      detail: 'Impossible de lire le fichier snapshot sélectionné.',
    };
  }

  if (!rawText.trim()) {
    return {
      ok: false,
      status: 400,
      detail: 'Le fichier snapshot JSON sélectionné est vide.',
    };
  }

  try {
    const res = await apiFetch('/api/sessions/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawText,
    });

    let bodyJson: unknown = null;
    try {
      bodyJson = await res.json();
    } catch {
      bodyJson = null;
    }

    if (res.ok && bodyJson && typeof bodyJson === 'object') {
      const obj = bodyJson as Record<string, unknown>;
      const rawSid =
        typeof obj.session_id === 'string' && obj.session_id.trim()
          ? obj.session_id
          : DEFAULT_SESSION_ID;
      const restoredId = sanitizeSessionId(rawSid);
      return {
        ok: true,
        sessionId: restoredId,
        data: {
          ...(obj as unknown as SessionImportResponse),
          imported: true,
          session_id: restoredId,
        },
      };
    }

    const detail =
      bodyJson &&
      typeof bodyJson === 'object' &&
      typeof (bodyJson as { detail?: unknown }).detail === 'string'
        ? (bodyJson as { detail: string }).detail
        : res.status === 413
        ? 'Snapshot de session trop volumineux (> 20 Mo).'
        : res.status === 400
        ? 'Import refusé : chaîne cryptographique SHA-256 altérée ou structure JSON invalide.'
        : `Échec de la restauration de session (HTTP ${res.status}).`;

    return { ok: false, status: res.status, detail };
  } catch {
    return {
      ok: false,
      status: 0,
      detail: 'Impossible de joindre le service d’import de session.',
    };
  }
}
