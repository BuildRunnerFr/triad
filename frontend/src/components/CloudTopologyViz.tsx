import React, { Suspense, lazy, useState } from 'react';
import {
  Globe,
  ShieldAlert,
  Database,
  CheckCircle2,
  Lock,
  Flame,
  ArrowRight,
  KeyRound,
  FileKey2,
  Box,
  Layers,
  Loader2,
} from 'lucide-react';
import type { AuditorProof, Finding, ThemeMode } from '../types';
import type { ToastTone } from './ToastStack';

const LazyCloud3DTopology = lazy(() => import('./Cloud3DTopology'));

interface CloudTopologyVizProps {
  findings: Finding[];
  proof: AuditorProof | null;
  theme: ThemeMode;
  onSelectFinding: (finding: Finding) => void;
  onNotify?: (title: string, detail?: string, tone?: ToastTone) => void;
}

export const CloudTopologyViz: React.FC<CloudTopologyVizProps> = ({
  findings,
  proof,
  theme,
  onSelectFinding,
  onNotify,
}) => {
  const [topoMode, setTopoMode] = useState<'3d' | '2d'>('3d');

  const findByKeyword = (kw: string) =>
    findings.find((f) =>
      `${f.theme} ${f.reel?.ressource || ''} ${f.ecrit?.extrait || ''}`
        .toLowerCase()
        .includes(kw)
    );

  const fBucket = findByKeyword('radiologie');
  const fSsh = findByKeyword('ssh');
  const fBackupKo = findByKeyword('dpi');
  const fBackupOk = findByKeyword('pacs');
  const fIam =
    findByKeyword('iam') ||
    findByKeyword('serviceaccount') ||
    findByKeyword('privil');
  const fKms =
    findByKeyword('kms') ||
    findByKeyword('journal') ||
    findByKeyword('audit log');

  return (
    <div className="pt-5 border-t border-hairline flex flex-col justify-between h-full">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-main">
            Topologie Cloud GCP
          </h3>
        </div>

        {/* Bascule fluide Vue 3D WebGL / Vue 2D */}
        <div role="group" aria-label="Mode de vue de la topologie" className="flex surface-subtle p-0.5 rounded-lg">
          <button
            type="button"
            onClick={() => setTopoMode('3d')}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-extrabold transition cursor-pointer ${
              topoMode === '3d'
                ? 'seg-active'
                : 'text-sub hover:text-main'
            }`}
          >
            <Box className="w-3.5 h-3.5" />
            <span>3D</span>
          </button>
          <button
            type="button"
            onClick={() => setTopoMode('2d')}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-extrabold transition cursor-pointer ${
              topoMode === '2d'
                ? 'seg-active'
                : 'text-sub hover:text-main'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Plan</span>
          </button>
        </div>
      </div>

      {topoMode === '3d' ? (
        <Suspense
          fallback={
            <div className="h-[315px] rounded-xl surface-card flex items-center justify-center gap-2 text-xs text-sub">
              <Loader2 className="w-4 h-4 animate-spin text-accent" />
              <span>Initialisation de la scène 3D WebGL…</span>
            </div>
          }
        >
          <LazyCloud3DTopology
            findings={findings}
            proof={proof}
            theme={theme}
            onSelectFinding={onSelectFinding}
            onNotify={onNotify}
          />
        </Suspense>
      ) : (
        /* Graphe d'exposition 2D */
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center my-auto">
          {/* Source Internet */}
          <div className="md:col-span-4 surface-card rounded-xl p-3.5 relative">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl badge-critical flex items-center justify-center shrink-0">
                <Globe className="w-5 h-5" />
              </div>
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wider tone-critical font-bold">
                  Zone Non-Fiable
                </div>
                <div className="text-xs font-extrabold text-main">
                  Internet Public
                </div>
                <div className="text-[11px] font-mono text-dim">
                  0.0.0.0/0 • allUsers
                </div>
              </div>
            </div>

            <div className="mt-3 pt-2.5 border-t border-hairline flex items-center justify-between text-[11px] tone-critical font-semibold">
              <span>2 vecteurs critiques ouverts</span>
              <ArrowRight className="w-3.5 h-3.5 animate-pulse" />
            </div>
          </div>

          {/* Ressources Cloud GCP */}
          <div className="md:col-span-8 space-y-2.5">
            {/* Vecteur 1 : Bucket Radiologie */}
            <button
              type="button"
              onClick={() => fBucket && onSelectFinding(fBucket)}
              disabled={!fBucket}
              className="w-full text-left surface-card hover:border-strong rounded-xl p-3 transition flex items-center justify-between gap-3 cursor-pointer disabled:cursor-default"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-8 h-8 rounded-lg badge-critical flex items-center justify-center shrink-0">
                  <Database className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-bold font-mono text-main truncate">
                    gs://ch-valmont-export-radiologie
                  </div>
                  <div className="text-[11px] text-sub truncate">
                    IAM{' '}
                    <code className="tone-critical font-semibold">
                      allUsers (objectViewer)
                    </code>{' '}
                    — Imagerie exposée
                  </div>
                </div>
              </div>
              <span className="badge-critical px-2 py-0.5 rounded-full text-[10px] font-extrabold shrink-0">
                PUBLIC
              </span>
            </button>

            {/* Vecteur 2 : Pare-feu SSH */}
            <button
              type="button"
              onClick={() => fSsh && onSelectFinding(fSsh)}
              disabled={!fSsh}
              className="w-full text-left surface-card hover:border-strong rounded-xl p-3 transition flex items-center justify-between gap-3 cursor-pointer disabled:cursor-default"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-8 h-8 rounded-lg badge-critical flex items-center justify-center shrink-0">
                  <Flame className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-bold font-mono text-main truncate">
                    vpc-firewall/allow-ssh-anywhere
                  </div>
                  <div className="text-[11px] text-sub truncate">
                    Port{' '}
                    <code className="tone-critical font-semibold">TCP:22</code>{' '}
                    ouvert à{' '}
                    <code className="tone-critical font-semibold">
                      0.0.0.0/0
                    </code>{' '}
                    hors bastion
                  </div>
                </div>
              </div>
              <span className="badge-critical px-2 py-0.5 rounded-full text-[10px] font-extrabold shrink-0">
                OUVERT
              </span>
            </button>

            {/* Grille 2 colonnes : Backups DPI vs Archives PACS */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => fBackupKo && onSelectFinding(fBackupKo)}
                disabled={!fBackupKo}
                className="text-left surface-card hover:border-strong rounded-xl p-2.5 transition flex items-center justify-between gap-2 cursor-pointer disabled:cursor-default"
              >
                <div className="min-w-0">
                  <div className="text-[11px] font-bold font-mono text-main truncate">
                    backups-dpi
                  </div>
                  <div className="text-[10px] tone-warning truncate font-medium">
                    Versionnement inactif • Rétention nulle
                  </div>
                </div>
                <ShieldAlert className="w-4 h-4 tone-warning shrink-0" />
              </button>

              <button
                type="button"
                onClick={() => fBackupOk && onSelectFinding(fBackupOk)}
                disabled={!fBackupOk}
                className="text-left surface-card hover:border-strong rounded-xl p-2.5 transition flex items-center justify-between gap-2 cursor-pointer disabled:cursor-default"
              >
                <div className="min-w-0">
                  <div className="text-[11px] font-bold font-mono text-main truncate">
                    archives-pacs
                  </div>
                  <div className="text-[10px] tone-success truncate font-medium">
                    Versionnement actif • Verrouillé 365j
                  </div>
                </div>
                <CheckCircle2 className="w-4 h-4 tone-success shrink-0" />
              </button>
            </div>

            {/* Sondes complémentaires IAM & KMS/Journaux si présentes dans les constats */}
            {(fIam || fKms) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {fIam && fIam.id !== fBucket?.id && (
                  <button
                    type="button"
                    onClick={() => onSelectFinding(fIam)}
                    className="text-left surface-card hover:border-strong rounded-xl p-2.5 transition flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <div className="min-w-0">
                      <div className="text-[11px] font-bold font-mono text-main truncate">
                        {fIam.reel?.ressource || 'iam/privilèges'}
                      </div>
                      <div className="text-[10px] tone-critical truncate font-medium">
                        {fIam.theme}
                      </div>
                    </div>
                    <KeyRound className="w-4 h-4 tone-critical shrink-0" />
                  </button>
                )}
                {fKms && (
                  <button
                    type="button"
                    onClick={() => onSelectFinding(fKms)}
                    className="text-left surface-card hover:border-strong rounded-xl p-2.5 transition flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <div className="min-w-0">
                      <div className="text-[11px] font-bold font-mono text-main truncate">
                        {fKms.reel?.ressource || 'kms/audit-logs'}
                      </div>
                      <div className="text-[10px] tone-warning truncate font-medium">
                        {fKms.theme}
                      </div>
                    </div>
                    <FileKey2 className="w-4 h-4 tone-warning shrink-0" />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Preuve IAM Moindre Privilège */}
      <div className="mt-3 pt-2.5 border-t border-hairline flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="inline-flex items-center gap-1.5 text-sub min-w-0">
          <Lock className="w-3.5 h-3.5 text-accent shrink-0" />
          <code className="font-mono text-main text-[10px] truncate">
            {proof?.service_account || 'triad-auditor@gcp.iam'}
          </code>
        </div>
        <span className="badge-success text-xs px-2 py-0.5 rounded font-semibold" title="La sonde lit la configuration, jamais les données (accès métier refusé, HTTP 403)">
          Lecture seule vérifiée
        </span>
      </div>
    </div>
  );
};
