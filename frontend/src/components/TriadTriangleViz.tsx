import React from 'react';
import { motion } from 'framer-motion';
import {
  Zap,
  CheckCircle2,
  Terminal,
  ArrowUpRight,
} from 'lucide-react';
import type { AuditMode, Finding } from '../types';

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
    if (broken) return '#F43F5E';
    if (isClean) return '#86BC25';
    return 'rgba(148,163,184,0.45)';
  };

  return (
    <div className="surface-panel rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-hairline">
        <h3 className="text-sm font-extrabold text-main">
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
                className={`px-2.5 py-1 rounded-lg font-mono text-xs font-bold transition cursor-pointer ${
                  isSelected
                    ? 'bg-[#86BC25] text-black border border-[#86BC25]'
                    : isKo
                    ? 'badge-critical hover:opacity-90'
                    : 'surface-card text-sub hover:text-main'
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
        <div className="lg:col-span-5 flex items-center justify-center">
          <svg viewBox="0 0 340 235" className="w-full max-w-[340px] select-none">
            {/* Arête 1 : DIT <-> ÉCRIT (Haut) */}
            <motion.line
              x1="78"
              y1="56"
              x2="262"
              y2="56"
              stroke={edgeColor(breakDitEcrit)}
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
              stroke={edgeColor(breakDitReel)}
              strokeWidth={breakDitReel ? 3.5 : 2}
              strokeDasharray={breakDitReel ? '6 4' : undefined}
            />
            {/* Arête 3 : ÉCRIT <-> RÉEL (Droite) */}
            <motion.line
              x1="266"
              y1="66"
              x2="176"
              y2="182"
              stroke={edgeColor(breakEcritReel)}
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
                fontSize="10.5"
                fontWeight="800"
              >
                {active.contradiction || (isClean ? 'ALIGNÉ ✓' : active.statut.toUpperCase())}
              </text>
            </g>

            {/* Sommet 1 : LE DIT */}
            <g transform="translate(68, 50)">
              <circle
                r="27"
                style={{
                  fill: 'var(--info-bg)',
                  stroke: 'var(--info-text)',
                }}
                strokeWidth="1.8"
              />
              <text
                textAnchor="middle"
                y="-2"
                style={{ fill: 'var(--info-text)' }}
                fontSize="10"
                fontWeight="800"
              >
                LE DIT
              </text>
              <text
                textAnchor="middle"
                y="11"
                style={{ fill: 'var(--text-secondary)' }}
                fontSize="8.5"
                fontWeight="600"
              >
                {mode === 'AVANT' ? 'N/A' : 'Entretien'}
              </text>
            </g>

            {/* Sommet 2 : L'ÉCRIT */}
            <g transform="translate(272, 50)">
              <circle
                r="27"
                style={{
                  fill: 'var(--violet-bg)',
                  stroke: 'var(--violet-text)',
                }}
                strokeWidth="1.8"
              />
              <text
                textAnchor="middle"
                y="-2"
                style={{ fill: 'var(--violet-text)' }}
                fontSize="10"
                fontWeight="800"
              >
                L&apos;ÉCRIT
              </text>
              <text
                textAnchor="middle"
                y="11"
                style={{ fill: 'var(--text-secondary)' }}
                fontSize="8.5"
                fontWeight="600"
              >
                PSSI / PV
              </text>
            </g>

            {/* Sommet 3 : LE RÉEL */}
            <g transform="translate(170, 192)">
              <circle
                r="28"
                style={{
                  fill: 'var(--accent-soft)',
                  stroke: '#86BC25',
                }}
                strokeWidth="2"
              />
              <text
                textAnchor="middle"
                y="-2"
                style={{ fill: 'var(--accent-text)' }}
                fontSize="10"
                fontWeight="800"
              >
                LE RÉEL
              </text>
              <text
                textAnchor="middle"
                y="11"
                style={{ fill: 'var(--text-secondary)' }}
                fontSize="8.5"
                fontWeight="600"
              >
                Cloud GCP
              </text>
            </g>
          </svg>
        </div>

        {/* Synthèse instantanée du contrôle sélectionné (7 cols) */}
        <div className="lg:col-span-7 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-extrabold px-2.5 py-0.5 rounded-md bg-[#86BC25] text-black">
              {active.id}
            </span>
            <h4 className="text-base font-extrabold text-main">{active.theme}</h4>
            <span className="text-xs text-sub">• {active.exigence_nis2}</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div className="surface-card rounded-xl p-3 border-t-2 border-t-sky-500">
              <div className="text-[10px] font-extrabold uppercase tone-info mb-1">
                DIT
              </div>
              <p className="text-xs text-main line-clamp-2 leading-relaxed">
                {active.dit
                  ? `« ${active.dit.extrait} »`
                  : mode === 'AVANT'
                  ? 'Phase AVANT'
                  : 'Non évoqué'}
              </p>
            </div>

            <div className="surface-card rounded-xl p-3 border-t-2 border-t-violet-500">
              <div className="text-[10px] font-extrabold uppercase tone-violet mb-1">
                ÉCRIT
              </div>
              <p className="text-xs text-main line-clamp-2 leading-relaxed">
                {active.ecrit ? `« ${active.ecrit.extrait} »` : 'Non documenté'}
              </p>
            </div>

            <div className="surface-card rounded-xl p-3 border-t-2 border-t-[#86BC25]">
              <div className="text-[10px] font-extrabold uppercase text-accent mb-1">
                RÉEL
              </div>
              <p className="text-xs text-main line-clamp-2 leading-relaxed">
                {active.reel ? active.reel.constat : 'Procédural'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {active.contradiction ? (
                <span className="badge-critical inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-bold">
                  <Zap className="w-3.5 h-3.5" />
                  {active.contradiction}
                </span>
              ) : (
                <span className="badge-success inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-bold">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Cohérent
                </span>
              )}
              {active.commande_correction && (
                <span className="inline-flex items-center gap-1 font-mono text-[11px] text-sub">
                  <Terminal className="w-3.5 h-3.5 text-accent" />
                  gcloud prêt
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={() => onInspectFinding(active)}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[#86BC25] hover:bg-[#96cf2e] text-black text-xs font-extrabold transition cursor-pointer"
            >
              <span>Inspecter</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
