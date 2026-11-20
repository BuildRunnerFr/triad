import React, { Suspense, lazy, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Zap,
  CheckCircle2,
  Terminal,
  ArrowUpRight,
} from 'lucide-react';
import type { AuditMode, Finding } from '../types';

// Chunk séparé : three n'entre jamais dans le bundle initial.
const LazyConcordancePrism3D = lazy(() => import('./ConcordancePrism3D'));

let webglSupport: boolean | null = null;
function hasWebGL(): boolean {
  if (webglSupport !== null) return webglSupport;
  try {
    const c = document.createElement('canvas');
    webglSupport = Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

interface TriadTriangleVizProps {
  findings: Finding[];
  selectedFinding: Finding | null;
  mode: AuditMode;
  onSelectFinding: (f: Finding) => void;
  onInspectFinding: (f: Finding) => void;
}

export const TriadTriangleViz: React.FC<TriadTriangleVizProps> = ({
  findings,
  selectedFinding,
  mode,
  onSelectFinding,
  onInspectFinding,
}) => {
  const [use3D, setUse3D] = useState(() => typeof window !== 'undefined' && hasWebGL());
  const active = selectedFinding || findings[0] || null;
  if (!active) return null;

  const c = (active.contradiction || '').toLowerCase();
  const isAllThree = c.includes('dit') && c.includes('écrit') && c.includes('réel');
  const breakDitEcrit =
    isAllThree || (c.includes('dit') && c.includes('écrit') && !c.includes('réel'));
  const breakDitReel =
    isAllThree || (c.includes('dit') && c.includes('réel') && !c.includes('écrit'));
  const breakEcritReel =
    isAllThree || (c.includes('écrit') && c.includes('réel') && !c.includes('dit'));
  const isClean = active.statut === 'conforme';

  const edgeColor = (broken: boolean) => {
    if (broken) return 'var(--rupture)';
    if (isClean) return 'var(--reel)';
    return 'var(--border-strong)';
  };

  // Schéma SVG : repli si WebGL indisponible, et pendant le chargement du chunk 3D.
  const svgDiagram = (
    <svg viewBox="0 0 340 235" className="w-full max-w-[340px] select-none">
      {/* Arête 1 : DIT <-> ÉCRIT (Haut) */}
      <motion.line
        x1="78"
        y1="56"
        x2="262"
        y2="56"
        style={{ stroke: edgeColor(breakDitEcrit) }}
        strokeWidth={breakDitEcrit ? 3.5 : 2}
        strokeDasharray={breakDitEcrit ? '6 4' : undefined}
        initial={{ opacity: 0.4 }}
        animate={{ opacity: 1 }}
      />
      {/* Arête 2 : DIT <-> RÉEL (Gauche) */}
      <motion.line
        x1="74"
        y1="66"
        x2="164"
        y2="182"
        style={{ stroke: edgeColor(breakDitReel) }}
        strokeWidth={breakDitReel ? 3.5 : 2}
        strokeDasharray={breakDitReel ? '6 4' : undefined}
      />
      {/* Arête 3 : ÉCRIT <-> RÉEL (Droite) */}
      <motion.line
        x1="266"
        y1="66"
        x2="176"
        y2="182"
        style={{ stroke: edgeColor(breakEcritReel) }}
        strokeWidth={breakEcritReel ? 3.5 : 2}
        strokeDasharray={breakEcritReel ? '6 4' : undefined}
      />

      {/* Badge central de verdict */}
      <g transform="translate(170, 114)">
        <rect
          x="-68"
          y="-15"
          width="136"
          height="30"
          rx="15"
          style={{
            fill: active.contradiction
              ? 'var(--critical-bg)'
              : isClean
              ? 'var(--accent-soft)'
              : 'var(--bg-subtle)',
            stroke: active.contradiction
              ? 'var(--critical-border)'
              : isClean
              ? 'var(--accent-border)'
              : 'var(--border-strong)',
          }}
          strokeWidth="1.5"
        />
        <text
          textAnchor="middle"
          y="4"
          style={{
            fill: active.contradiction
              ? 'var(--critical-text)'
              : isClean
              ? 'var(--accent-text)'
              : 'var(--text-secondary)',
          }}
          fontSize="11"
          fontWeight="640"
        >
          {active.contradiction || (isClean ? 'Aligné' : active.statut.replace('_', ' '))}
        </text>
      </g>

      {/* Sommet 1 : LE DIT */}
      <g transform="translate(68, 50)">
        <circle
          r="27"
          style={{
            fill: 'var(--bg-surface)',
            stroke: 'var(--dit)',
          }}
          strokeWidth="1.8"
        />
        <text
          textAnchor="middle"
          y="-2"
          style={{ fill: 'var(--dit)' }}
          fontSize="11"
          fontWeight="640"
        >
          Dit
        </text>
        <text
          textAnchor="middle"
          y="11"
          style={{ fill: 'var(--text-secondary)' }}
          fontSize="8.5"
          fontWeight="500"
        >
          {mode === 'AVANT' ? 'N/A' : 'Entretien'}
        </text>
      </g>

      {/* Sommet 2 : L'ÉCRIT */}
      <g transform="translate(272, 50)">
        <circle
          r="27"
          style={{
            fill: 'var(--bg-surface)',
            stroke: 'var(--ecrit)',
          }}
          strokeWidth="1.8"
        />
        <text
          textAnchor="middle"
          y="-2"
          style={{ fill: 'var(--ecrit)' }}
          fontSize="11"
          fontWeight="640"
        >
          Écrit
        </text>
        <text
          textAnchor="middle"
          y="11"
          style={{ fill: 'var(--text-secondary)' }}
          fontSize="8.5"
          fontWeight="500"
        >
          PSSI / PV
        </text>
      </g>

      {/* Sommet 3 : LE RÉEL */}
      <g transform="translate(170, 192)">
        <circle
          r="28"
          style={{
            fill: 'var(--bg-surface)',
            stroke: 'var(--reel)',
          }}
          strokeWidth="1.8"
        />
        <text
          textAnchor="middle"
          y="-2"
          style={{ fill: 'var(--reel)' }}
          fontSize="11"
          fontWeight="640"
        >
          Réel
        </text>
        <text
          textAnchor="middle"
          y="11"
          style={{ fill: 'var(--text-secondary)' }}
          fontSize="8.5"
          fontWeight="500"
        >
          Cloud GCP
        </text>
      </g>
    </svg>
  );

  return (
    <div className="surface-panel rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-hairline">
        <h3 className="text-base font-semibold text-main">
          Triangulation Dit × Écrit × Réel
        </h3>

        {/* Sélecteur rapide par puce F-001, F-002... */}
        <div className="flex flex-wrap items-center gap-1.5">
          {findings.map((f) => {
            const isSelected = f.id === active.id;
            const isKo = f.statut === 'non_conforme';
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => onSelectFinding(f)}
                className={`min-h-[28px] px-2.5 py-1 rounded-lg font-mono text-xs font-semibold transition cursor-pointer ${
                  isSelected
                    ? 'seg-active'
                    : isKo
                    ? 'text-[var(--critical-text)] hover:bg-[var(--bg-hover)]'
                    : 'text-sub hover:text-main hover:bg-[var(--bg-hover)]'
                }`}
              >
                {f.id}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center pt-4">
        {/* Schéma SVG Triangulaire animé avec variables CSS compatibles Clair/Sombre (5 cols) */}
        <div className="lg:col-span-5 flex items-center justify-center min-w-0">
          {use3D ? (
            <Suspense fallback={svgDiagram}>
              <LazyConcordancePrism3D
                findings={findings}
                activeId={active.id}
                mode={mode}
                onSelect={onSelectFinding}
                onFallback={() => setUse3D(false)}
              />
            </Suspense>
          ) : (
            svgDiagram
          )}
        </div>

        {/* Synthèse instantanée du contrôle sélectionné (7 cols) */}
        <div className="lg:col-span-7 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-sub">
              {active.id}
            </span>
            <h4 className="text-base font-semibold text-main">{active.theme}</h4>
            <span className="text-xs text-sub">{active.exigence_nis2}</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 border-t border-hairline">
            <div className="pt-3 pb-1 sm:pr-4 sm:[&:not(:first-child)]:pl-4 sm:[&:not(:first-child)]:border-l border-hairline">
              <div className="text-xs font-semibold text-[var(--dit)] mb-1">
                Dit
              </div>
              <p className="text-xs text-main line-clamp-2 leading-relaxed">
                {active.dit
                  ? `« ${active.dit.extrait} »`
                  : mode === 'AVANT'
                  ? 'Phase AVANT'
                  : 'Non évoqué'}
              </p>
            </div>

            <div className="pt-3 pb-1 sm:pr-4 sm:[&:not(:first-child)]:pl-4 sm:[&:not(:first-child)]:border-l border-hairline">
              <div className="text-xs font-semibold text-[var(--ecrit)] mb-1">
                Écrit
              </div>
              <p className="text-xs text-main line-clamp-2 leading-relaxed">
                {active.ecrit ? `« ${active.ecrit.extrait} »` : 'Non documenté'}
              </p>
            </div>

            <div className="pt-3 pb-1 sm:pr-4 sm:[&:not(:first-child)]:pl-4 sm:[&:not(:first-child)]:border-l border-hairline">
              <div className="text-xs font-semibold text-[var(--reel)] mb-1">
                Réel
              </div>
              <p className="text-xs text-main line-clamp-2 leading-relaxed">
                {active.reel ? active.reel.constat : 'Procédural'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {active.contradiction ? (
                <span className="badge-critical inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-semibold">
                  <Zap className="w-3.5 h-3.5" />
                  {active.contradiction}
                </span>
              ) : (
                <span className="badge-success inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-semibold">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Cohérent
                </span>
              )}
              {active.commande_correction && (
                <span className="inline-flex items-center gap-1 text-xs text-sub">
                  <Terminal className="w-3.5 h-3.5 text-accent" />
                  gcloud prêt
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={() => onInspectFinding(active)}
              className="min-h-[32px] inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-strong text-main hover:bg-[var(--bg-hover)] text-xs font-semibold transition cursor-pointer"
            >
              <span>Ouvrir le constat</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
