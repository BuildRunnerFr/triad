import React, { useRef, useState } from 'react';
import {
  FolderArchive,
  Upload,
  CheckCircle2,
  ShieldAlert,
  ShieldCheck,
  Loader2,
  Copy,
  Check,
  RotateCcw,
  FileCheck2,
  FileWarning,
  Link2,
  KeyRound,
  ChevronDown,
} from 'lucide-react';
import type {
  BundleSignatureStatus,
  ForensicBundleVerificationCertificate,
} from '../types';
import { verifyProofBundleArchive } from '../api';
import type { ToastTone } from './ToastStack';

interface ForensicBundleVerifierProps {
  onNotify?: (title: string, detail?: string, tone?: ToastTone) => void;
}

const BUNDLE_FILE_DESCRIPTIONS: Record<string, string> = {
  '01_Rapport_NIS2.md': 'Rapport exécutif Markdown',
  '02_Matrice_GRC.csv': 'Matrice GRC Dit × Écrit × Réel',
  '03_Synthese_Scellee.json': 'Synthèse structurée scellée',
  '04_Playbook_DryRun.sh': 'Playbook gcloud Dry-Run',
  '05_Mail_DSI.txt': 'Courriel post-audit DSI',
  '06_Audit_Chain.jsonl': 'Registre chaîné SHA-256',
  '07_PreNotification_ANSSI_Art23.md': 'Pré-Notification ANSSI (Art. 23 §4)',
  '08_Brief_COMEX_Art20.md': 'Brief Exécutif COMEX (Art. 20 NIS2)',
  '09_Remediation_GitOps.tf': 'Manifeste Terraform GitOps GCP (.tf)',
  '10_Guide_Entretien_Contradictoire.md':
    "Guide d'Entretien Contradictoire (DSI / RSSI / Achats)",
  '11_Registre_Arbitrages_GRC.md':
    "Registre d'Homologation & Arbitrages GRC",
  '12_Evaluation_CNIL_RGPD_Art33.md':
    'Évaluation Pré-Notification CNIL (RGPD Art. 33 & 34)',
};

const SIGNATURE_STATUS_META: Record<
  BundleSignatureStatus,
  {
    badgeLabel: string;
    cardLabel: string;
    detail: string;
    pillCls: string;
    textCls: string;
  }
> = {
  VERIFIED: {
    badgeLabel: 'HMAC-SHA256 : VERIFIED ✓',
    cardLabel: 'VERIFIED • Sceau valide ✓',
    detail: 'Signature émetteur HMAC-SHA256 authentifiée',
    pillCls: 'bg-black/25 text-current border border-current/30',
    textCls: 'text-accent',
  },
  UNSIGNED: {
    badgeLabel: 'HMAC-SHA256 : UNSIGNED',
    cardLabel: 'UNSIGNED • Non signé',
    detail: 'Export sans clé secrète HMAC configurée',
    pillCls: 'bg-black/20 text-current border border-current/25',
    textCls: 'text-sub',
  },
  INVALID: {
    badgeLabel: 'HMAC-SHA256 : INVALID ✕',
    cardLabel: 'INVALID • Sceau falsifié ✕',
    detail: 'Signature émetteur HMAC-SHA256 invalide ou altérée',
    pillCls: 'bg-[var(--rupture)] text-white border border-[var(--critical-border)]',
    textCls: 'tone-critical',
  },
};

function formatBytesFr(bytes?: number | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
}

function formatFileStatusFr(status?: string, valid?: boolean): string {
  if (valid) return 'Intègre ✓';
  switch ((status || '').toUpperCase()) {
    case 'MISSING':
      return 'Manquant ✕';
    case 'CORRUPTED':
      return 'Corrompu ✕';
    case 'UNLISTED':
      return 'Hors manifeste ✕';
    case 'TAMPERED':
    default:
      return 'Altéré ✕';
  }
}

export const ForensicBundleVerifier: React.FC<ForensicBundleVerifierProps> = ({
  onNotify,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [certificate, setCertificate] =
    useState<ForensicBundleVerificationCertificate | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [copiedHash, setCopiedHash] = useState(false);
  const [filesAccordionOpen, setFilesAccordionOpen] = useState(false);

  const handleVerifyFile = async (file: File) => {
    setIsVerifying(true);
    setRequestError(null);

    const outcome = await verifyProofBundleArchive(file);
    setIsVerifying(false);

    if (!outcome.ok) {
      setCertificate(null);
      setRequestError(outcome.detail);
      setFilesAccordionOpen(false);
      if (outcome.status !== 429) {
        onNotify?.(
          'Vérification forensique refusée',
          outcome.detail,
          'critical'
        );
      }
      return;
    }

    setCertificate(outcome.certificate);
    setFilesAccordionOpen(!outcome.certificate.authentic);

    const totalPieces = outcome.certificate.files_checked.length || 12;
    const versionTag =
      outcome.certificate.bundle_version ||
      (totalPieces >= 12
        ? 'v6'
        : totalPieces === 11
        ? 'v5'
        : totalPieces === 10
        ? 'v4'
        : totalPieces === 9
        ? 'v3'
        : totalPieces === 8
        ? 'v2'
        : 'v1');
    if (outcome.certificate.authentic) {
      onNotify?.(
        'Certificat Forensique : AUTHENTIQUE ✓',
        `${outcome.certificate.archive_name} — ${versionTag} (${totalPieces}/${totalPieces} pièces intègres, HMAC : ${outcome.certificate.signature_status}).`,
        'success'
      );
    } else {
      onNotify?.(
        'Certificat Forensique : ALTÉRÉ ✕',
        outcome.certificate.errors[0] ||
          `Rupture d'intégrité détectée dans ${outcome.certificate.archive_name}.`,
        'critical'
      );
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      void handleVerifyFile(selected);
    }
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) {
      void handleVerifyFile(dropped);
    }
  };

  const copyHeadHash = (hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedHash(true);
    window.setTimeout(() => setCopiedHash(false), 1800);
  };

  const resetVerifier = () => {
    setCertificate(null);
    setRequestError(null);
    setFilesAccordionOpen(false);
  };

  const validFilesCount = certificate
    ? certificate.files_checked.filter((f) => f.valid).length
    : 0;

  return (
    <section
      id="forensic-bundle-verifier"
      className="surface-panel rounded-2xl p-5 space-y-4 border border-hairline"
    >
      {/* En-tête compact zéro surcharge */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-[var(--accent-soft)] border border-[var(--deloitte)]/35 flex items-center justify-center shrink-0">
            <FolderArchive className="w-4 h-4 text-accent" />
          </div>
          <div>
            <h3 className="text-sm sm:text-base font-extrabold text-main">
              Vérificateur d&apos;Archive Probatoire (.zip)
            </h3>
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              <span className="badge-success px-2 py-0.5 rounded-full font-mono text-[10px] font-extrabold">
                v1..v6 • 12 pièces • HMAC-SHA256
              </span>
              <span className="px-2 py-0.5 rounded-full surface-subtle font-mono text-[10px] font-semibold text-sub">
                Anti-ZipSlip &amp; 0 écriture disque
              </span>
            </div>
          </div>
        </div>

        {(certificate || requestError) && (
          <button
            type="button"
            onClick={resetVerifier}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl surface-card hover:border-strong text-xs font-bold text-sub hover:text-main transition cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Réinitialiser</span>
          </button>
        )}
      </div>

      {/* Zone de dépôt épurée */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Sélectionner ou déposer un Dossier de Preuve .zip à vérifier"
        onClick={() => !isVerifying && fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !isVerifying) {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!isDragging) setIsDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragging(false);
        }}
        onDrop={handleDrop}
        className={`rounded-2xl border-2 border-dashed p-5 transition flex flex-col sm:flex-row items-center justify-between gap-4 ${
          isVerifying
            ? 'opacity-70 cursor-wait border-hairline surface-subtle'
            : isDragging
            ? 'border-[var(--deloitte)] bg-[var(--deloitte)]/10 cursor-copy'
            : 'border-hairline hover:border-[var(--deloitte)]/60 surface-card cursor-pointer'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          onChange={handleFileChange}
          className="hidden"
        />

        <div className="flex items-center gap-3.5 text-center sm:text-left">
          <div className="w-10 h-10 rounded-xl surface-subtle border border-hairline flex items-center justify-center shrink-0 mx-auto sm:mx-0">
            {isVerifying ? (
              <Loader2 className="w-5 h-5 text-accent animate-spin" />
            ) : (
              <Upload className="w-5 h-5 text-accent" />
            )}
          </div>
          <div>
            <div className="text-xs font-extrabold text-main">
              {isVerifying
                ? 'Vérification cryptographique en cours…'
                : 'Déposez une archive .zip ou cliquez pour parcourir'}
            </div>
            <div className="text-[11px] font-mono text-sub mt-0.5">
              MANIFEST_SHA256.txt • 06_Audit_Chain.jsonl • ≤ 20 Mo
            </div>
          </div>
        </div>

        <span className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[var(--deloitte)] hover:bg-[var(--deloitte-hover)] text-black text-xs font-extrabold transition shrink-0">
          <ShieldCheck className="w-4 h-4" />
          <span>Choisir une archive (.zip)</span>
        </span>
      </div>

      {/* Erreur HTTP de format / taille (400 / 413) */}
      {requestError && (
        <div className="rounded-xl p-3.5 border badge-critical flex items-start gap-2.5 text-xs">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <span className="font-extrabold">Archive rejetée : </span>
            <span>{requestError}</span>
          </div>
        </div>
      )}

      {/* CERTIFICAT D'AUTHENTICITÉ FORENSIQUE */}
      {certificate && (
        <div className="rounded-2xl border border-hairline surface-card overflow-hidden">
          {/* Bandeau de verdict */}
          <div
            className={`px-5 py-3.5 border-b border-hairline flex flex-wrap items-center justify-between gap-3 ${
              certificate.authentic ? 'badge-success' : 'badge-critical'
            }`}
          >
            <div className="flex items-center gap-3 min-w-0">
              {certificate.authentic ? (
                <CheckCircle2 className="w-5 h-5 shrink-0" />
              ) : (
                <ShieldAlert className="w-5 h-5 shrink-0" />
              )}
              <div className="min-w-0">
                <div className="text-[10px] font-extrabold uppercase tracking-widest opacity-90">
                  Certificat Forensique TRIAD
                </div>
                <div className="text-sm font-extrabold truncate">
                  {certificate.archive_name || 'Archive .zip'}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-extrabold ${
                  SIGNATURE_STATUS_META[certificate.signature_status].pillCls
                }`}
                title={SIGNATURE_STATUS_META[certificate.signature_status].detail}
              >
                <KeyRound className="w-3.5 h-3.5" />
                <span>
                  {SIGNATURE_STATUS_META[certificate.signature_status].badgeLabel}
                </span>
              </span>
              <span
                className={`px-3 py-1 rounded-full text-xs font-mono font-extrabold ${
                  certificate.authentic
                    ? 'bg-[var(--deloitte)] text-black'
                    : 'bg-[var(--rupture)] text-white'
                }`}
              >
                {certificate.authentic ? 'AUTHENTIQUE ✓' : 'ALTÉRÉ ✕'}
              </span>
            </div>
          </div>

          <div className="p-4 sm:p-5 space-y-4">
            {/* Métadonnées compactes */}
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-sub">
              {certificate.metadata?.client && (
                <span className="px-2.5 py-1 rounded-lg surface-subtle font-semibold text-main">
                  {certificate.metadata.client}
                </span>
              )}
              {certificate.metadata?.mode && (
                <span className="px-2.5 py-1 rounded-lg surface-subtle font-mono font-bold text-main">
                  Phase {certificate.metadata.mode}
                </span>
              )}
              {certificate.metadata?.session_id && (
                <span className="px-2.5 py-1 rounded-lg surface-subtle font-mono">
                  {certificate.metadata.session_id}
                </span>
              )}
              {certificate.files_checked.length > 0 && (
                <span className="px-2.5 py-1 rounded-lg surface-subtle font-mono font-bold text-accent">
                  {certificate.bundle_version ||
                    (certificate.files_checked.length >= 12
                      ? 'v6'
                      : certificate.files_checked.length === 11
                      ? 'v5'
                      : certificate.files_checked.length === 10
                      ? 'v4'
                      : certificate.files_checked.length === 9
                      ? 'v3'
                      : certificate.files_checked.length === 8
                      ? 'v2'
                      : 'v1')}{' '}
                  • {certificate.files_checked.length} pièces
                </span>
              )}
              {typeof certificate.size_bytes === 'number' && (
                <span className="px-2.5 py-1 rounded-lg surface-subtle font-mono tabular-nums">
                  {formatBytesFr(certificate.size_bytes)}
                </span>
              )}
            </div>

            {/* 5 piliers KPI de contrôle */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
              <div className="p-3 rounded-xl surface-subtle border border-hairline">
                <div className="text-[10px] font-bold uppercase text-sub">
                  Anti-ZipSlip
                </div>
                <div
                  className={`text-xs font-extrabold mt-1 ${
                    certificate.zip_slip_safe ? 'text-accent' : 'tone-critical'
                  }`}
                >
                  {certificate.zip_slip_safe ? 'Chemins sûrs ✓' : 'Bloqué ✕'}
                </div>
              </div>

              <div className="p-3 rounded-xl surface-subtle border border-hairline">
                <div className="text-[10px] font-bold uppercase text-sub">
                  Manifeste SHA-256
                </div>
                <div
                  className={`text-xs font-extrabold mt-1 tabular-nums ${
                    certificate.manifest_valid ? 'text-accent' : 'tone-critical'
                  }`}
                >
                  {certificate.manifest_valid
                    ? `${certificate.files_checked.length || 12}/${
                        certificate.files_checked.length || 12
                      } conformes ✓`
                    : 'Invalide ✕'}
                </div>
              </div>

              <div className="p-3 rounded-xl surface-subtle border border-hairline">
                <div className="text-[10px] font-bold uppercase text-sub">
                  Chaîne Audit
                </div>
                <div
                  className={`text-xs font-extrabold mt-1 tabular-nums ${
                    certificate.chain_valid ? 'text-accent' : 'tone-critical'
                  }`}
                >
                  {certificate.chain_valid
                    ? `${certificate.blocks_count ?? 0} blocs ✓`
                    : 'Rompue ✕'}
                </div>
              </div>

              <div className="p-3 rounded-xl surface-subtle border border-hairline">
                <div className="text-[10px] font-bold uppercase text-sub">
                  Synthèse Scellée
                </div>
                <div
                  className={`text-xs font-extrabold mt-1 ${
                    certificate.sealed_json_match
                      ? 'text-accent'
                      : 'tone-critical'
                  }`}
                >
                  {certificate.sealed_json_match
                    ? 'Concordante ✓'
                    : 'Discordante ✕'}
                </div>
              </div>

              <div className="p-3 rounded-xl surface-subtle border border-hairline col-span-2 sm:col-span-1">
                <div className="text-[10px] font-bold uppercase text-sub">
                  Sceau HMAC
                </div>
                <div
                  className={`text-xs font-mono font-extrabold mt-1 ${
                    SIGNATURE_STATUS_META[certificate.signature_status].textCls
                  }`}
                >
                  {SIGNATURE_STATUS_META[certificate.signature_status].cardLabel}
                </div>
              </div>
            </div>

            {/* Empreinte de tête recalculée */}
            <div className="px-3.5 py-2.5 rounded-xl surface-subtle border border-hairline flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Link2 className="w-4 h-4 text-accent shrink-0" />
                <div className="min-w-0 font-mono text-xs truncate">
                  <span className="text-[10px] font-sans font-bold uppercase text-sub mr-2">
                    Tête SHA-256 :
                  </span>
                  <span className="font-bold text-main">
                    {certificate.head_hash || 'Non calculable'}
                  </span>
                </div>
              </div>

              {certificate.head_hash && (
                <button
                  type="button"
                  onClick={() => copyHeadHash(certificate.head_hash!)}
                  className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg surface-card text-sub hover:text-main transition cursor-pointer shrink-0"
                >
                  {copiedHash ? (
                    <>
                      <Check className="w-3 h-3 text-accent" />
                      <span>Copié</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Copier</span>
                    </>
                  )}
                </button>
              )}
            </div>

            {/* Anomalies forensiques éventuelles */}
            {certificate.errors.length > 0 && (
              <div className="rounded-xl p-3.5 border badge-critical space-y-1">
                <div className="text-xs font-extrabold flex items-center gap-1.5">
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                  <span>Anomalies relevées ({certificate.errors.length})</span>
                </div>
                <ul className="list-disc pl-5 space-y-0.5 text-xs">
                  {certificate.errors.map((err, idx) => (
                    <li key={idx} className="break-words">
                      {err}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Accordéon repliable : Table détaillée des 12 pièces */}
            {certificate.files_checked.length > 0 && (
              <div className="rounded-xl border border-hairline overflow-hidden">
                <button
                  type="button"
                  aria-expanded={filesAccordionOpen}
                  onClick={() => setFilesAccordionOpen((prev) => !prev)}
                  className="w-full px-4 py-2.5 surface-subtle hover:bg-[var(--bg-hover)] flex items-center justify-between gap-2 text-xs font-bold text-main transition cursor-pointer"
                >
                  <span className="inline-flex items-center gap-2">
                    <FileCheck2 className="w-4 h-4 text-accent shrink-0" />
                    <span>
                      Détail des pièces contrôlées ({validFilesCount}/
                      {certificate.files_checked.length})
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-sub">
                    <span>{filesAccordionOpen ? 'Masquer' : 'Afficher'}</span>
                    <ChevronDown
                      className={`w-4 h-4 transition-transform ${
                        filesAccordionOpen ? 'rotate-180' : ''
                      }`}
                    />
                  </span>
                </button>

                {filesAccordionOpen && (
                  <div className="overflow-x-auto border-t border-hairline">
                    <table className="w-full text-left text-xs">
                      <thead className="surface-subtle text-[10px] uppercase text-sub border-b border-hairline">
                        <tr>
                          <th className="p-2.5">Pièce</th>
                          <th className="p-2.5">Taille</th>
                          <th className="p-2.5">SHA-256</th>
                          <th className="p-2.5 text-right">Statut</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border-subtle)]">
                        {certificate.files_checked.map((f) => {
                          const desc = BUNDLE_FILE_DESCRIPTIONS[f.filename];
                          return (
                            <tr key={f.filename}>
                              <td className="p-2.5">
                                <div className="flex items-center gap-2">
                                  {f.valid ? (
                                    <FileCheck2 className="w-4 h-4 text-accent shrink-0" />
                                  ) : (
                                    <FileWarning className="w-4 h-4 tone-critical shrink-0" />
                                  )}
                                  <div>
                                    <div className="font-mono font-bold text-main">
                                      {f.filename}
                                    </div>
                                    {desc && (
                                      <div className="text-[11px] text-sub">
                                        {desc}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td className="p-2.5 font-mono text-[11px] text-sub whitespace-nowrap tabular-nums">
                                {formatBytesFr(f.size_bytes)}
                              </td>
                              <td className="p-2.5 font-mono text-[11px]">
                                {f.actual_sha256 ? (
                                  <div className="space-y-0.5">
                                    <div
                                      className={
                                        f.valid
                                          ? 'text-sub'
                                          : 'tone-critical font-bold'
                                      }
                                    >
                                      {f.actual_sha256.slice(0, 20)}…
                                    </div>
                                    {f.expected_sha256 && !f.valid && (
                                      <div className="text-dim">
                                        att.: {f.expected_sha256.slice(0, 20)}…
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-dim">—</span>
                                )}
                              </td>
                              <td className="p-2.5 text-right whitespace-nowrap">
                                <span
                                  className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-extrabold ${
                                    f.valid ? 'badge-success' : 'badge-critical'
                                  }`}
                                >
                                  {formatFileStatusFr(f.status, f.valid)}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
