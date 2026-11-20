import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { Finding, GraviteFinding, StatutFinding } from '../types';

/**
 * Ruban de concordance : le geste signature de TRIAD.
 * Trois couloirs (Dit, Écrit, Réel) reliés comme un graphique éditorial annoté :
 * les sources qui concordent sont reliées d'un trait plein, la rupture avec le réel
 * est cassée et annotée en vermillon. La gravité se lit au diamètre du point Réel
 * (rampe fixe), jamais à la seule couleur.
 */

export const GRAVITE_RADIUS: Record<GraviteFinding, number> = {
  faible: 3.5,
  moyenne: 4.75,
  haute: 6,
  critique: 7.5,
};

const GRAVITE_ORDER: Record<GraviteFinding, number> = { critique: 4, haute: 3, moyenne: 2, faible: 1 };
const STATUT_ORDER: Record<StatutFinding, number> = { non_conforme: 4, partiel: 3, a_confirmer: 2, conforme: 1 };

/** Ordre de lecture partagé (cockpit, investigation, tiroir) : gravité puis statut, puis identifiant. */
export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      Number(a.statut === 'conforme') - Number(b.statut === 'conforme') ||
      GRAVITE_ORDER[b.gravite] - GRAVITE_ORDER[a.gravite] ||
      STATUT_ORDER[b.statut] - STATUT_ORDER[a.statut] ||
      a.id.localeCompare(b.id)
  );
}

export const GRAVITE_LABEL: Record<GraviteFinding, string> = {
  critique: 'Critique',
  haute: 'Haute',
  moyenne: 'Moyenne',
  faible: 'Faible',
};

export const STATUT_LABEL: Record<StatutFinding, string> = {
  non_conforme: 'Non conforme',
  partiel: 'Partiel',
  conforme: 'Conforme',
  a_confirmer: 'À confirmer',
};

const STATUT_COLOR: Record<StatutFinding, string> = {
  non_conforme: 'var(--rupture)',
  partiel: 'var(--warning-text)',
  conforme: 'var(--reel)',
  a_confirmer: 'var(--text-muted)',
};

const W = 168;
const H = 30;
const X = { dit: 10, ecrit: 84, reel: 158 } as const;
const Y = 17;

interface RibbonGlyphProps {
  finding: Finding;
  /** Affiche le mot « rupture » au-dessus de la cassure (lignes critiques). */
  annotate?: boolean;
}

/** Glyphe SVG seul (réutilisable dans les tableaux, le tiroir et le mode COMEX). */
export const RibbonGlyph: React.FC<RibbonGlyphProps> = ({ finding, annotate = false }) => {
  const { dit, ecrit, statut, gravite } = finding;
  const reelColor = STATUT_COLOR[statut];
  const r = GRAVITE_RADIUS[gravite];
  // Où se situe la rupture ? « Dit ≠ Écrit » casse entre les déclarations, sinon entre l'Écrit et le Réel.
  const ditVsEcrit = /dit\s*≠\s*[ée]crit/i.test(finding.contradiction || '');
  const broken = statut === 'non_conforme' && !ditVsEcrit;
  const midX = (X.ecrit + X.reel) / 2;
  const midDE = (X.dit + X.ecrit) / 2;
  const claimsAgree = Boolean(dit) && Boolean(ecrit) && !ditVsEcrit;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      className="shrink-0 overflow-visible"
      aria-hidden="true"
    >
      {/* Dit — Écrit : les déclarations concordent-elles entre elles ? */}
      {ditVsEcrit ? (
        <>
          <line x1={X.dit} y1={Y} x2={midDE - 5} y2={Y} style={{ stroke: 'var(--rupture)' }} strokeWidth={1.75} />
          <line x1={midDE + 5} y1={Y} x2={X.ecrit} y2={Y} style={{ stroke: 'var(--rupture)' }} strokeWidth={1.75} />
          <line x1={midDE - 6} y1={Y + 5} x2={midDE - 2} y2={Y - 5} style={{ stroke: 'var(--rupture)' }} strokeWidth={1.75} />
          <line x1={midDE + 2} y1={Y + 5} x2={midDE + 6} y2={Y - 5} style={{ stroke: 'var(--rupture)' }} strokeWidth={1.75} />
          {annotate && (
            <text x={midDE} y={4} textAnchor="middle" style={{ fill: 'var(--rupture)', fontSize: 9, fontWeight: 640 }}>
              rupture
            </text>
          )}
        </>
      ) : (
        <line
          x1={X.dit}
          y1={Y}
          x2={X.ecrit}
          y2={Y}
          style={{ stroke: 'var(--border-strong)' }}
          strokeWidth={1.5}
          strokeDasharray={claimsAgree ? undefined : '2 3'}
        />
      )}
      {/* Écrit — Réel : la configuration confirme-t-elle ? */}
      {broken ? (
        <>
          <line x1={X.ecrit} y1={Y} x2={midX - 5} y2={Y} style={{ stroke: reelColor }} strokeWidth={1.75} />
          <line x1={midX + 5} y1={Y} x2={X.reel} y2={Y} style={{ stroke: reelColor }} strokeWidth={1.75} />
          <line x1={midX - 6} y1={Y + 5} x2={midX - 2} y2={Y - 5} style={{ stroke: reelColor }} strokeWidth={1.75} />
          <line x1={midX + 2} y1={Y + 5} x2={midX + 6} y2={Y - 5} style={{ stroke: reelColor }} strokeWidth={1.75} />
          {annotate && (
            <text
              x={midX}
              y={4}
              textAnchor="middle"
              style={{ fill: reelColor, fontSize: 9, fontWeight: 640, letterSpacing: '0.02em' }}
            >
              rupture
            </text>
          )}
        </>
      ) : (
        <line
          x1={X.ecrit}
          y1={Y}
          x2={X.reel}
          y2={Y}
          style={{ stroke: ditVsEcrit ? 'var(--border-strong)' : reelColor }}
          strokeWidth={1.75}
          strokeDasharray={statut === 'partiel' ? '5 3' : statut === 'a_confirmer' ? '2 3' : undefined}
        />
      )}

      <circle
        cx={X.dit}
        cy={Y}
        r={4.5}
        style={dit ? { fill: 'var(--dit)' } : { fill: 'var(--bg-surface)', stroke: 'var(--text-muted)' }}
        strokeWidth={1.25}
      />
      <circle
        cx={X.ecrit}
        cy={Y}
        r={4.5}
        style={ecrit ? { fill: 'var(--ecrit)' } : { fill: 'var(--bg-surface)', stroke: 'var(--text-muted)' }}
        strokeWidth={1.25}
      />
      <circle
        cx={X.reel}
        cy={Y}
        r={r}
        style={
          statut === 'a_confirmer'
            ? { fill: 'var(--bg-surface)', stroke: reelColor }
            : { fill: reelColor }
        }
        strokeWidth={1.5}
      />
    </svg>
  );
};

/** Légende partagée des couloirs (à poser une fois au-dessus d'une liste de rubans). */
export const RibbonLegend: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-sub ${className}`}>
    <span className="inline-flex items-center gap-1.5">
      <span className="w-2.5 h-2.5 rounded-full bg-[var(--dit)]" aria-hidden="true" />
      Dit (entretiens)
    </span>
    <span className="inline-flex items-center gap-1.5">
      <span className="w-2.5 h-2.5 rounded-full bg-[var(--ecrit)]" aria-hidden="true" />
      Écrit (PSSI, PV, contrats)
    </span>
    <span className="inline-flex items-center gap-1.5">
      <span className="w-2.5 h-2.5 rounded-full bg-[var(--reel)]" aria-hidden="true" />
      Réel (configuration GCP)
    </span>
    <span className="inline-flex items-center gap-1.5">
      <svg width="34" height="12" viewBox="0 0 34 12" aria-hidden="true">
        <circle cx="4" cy="6" r="2.5" style={{ fill: 'var(--text-muted)' }} />
        <circle cx="14" cy="6" r="3.5" style={{ fill: 'var(--text-muted)' }} />
        <circle cx="27" cy="6" r="5.5" style={{ fill: 'var(--text-muted)' }} />
      </svg>
      Diamètre = gravité
    </span>
  </div>
);

interface ConcordanceRowProps {
  finding: Finding;
  onOpen: (finding: Finding) => void;
  /** Mention complémentaire sous la gravité (ex. arbitrage GRC). */
  note?: React.ReactNode;
  onHover?: (finding: Finding) => void;
}

/** Ligne de constat cliquable : identifiant, intitulé, ruban, gravité. */
export const ConcordanceRow: React.FC<ConcordanceRowProps> = ({ finding, onOpen, note, onHover }) => {
  const title = finding.theme;
  const detail = [finding.contradiction, finding.exigence_nis2].filter(Boolean).join(' · ');
  return (
    <li onMouseEnter={onHover ? () => onHover(finding) : undefined}>
      <button
        type="button"
        onClick={() => onOpen(finding)}
        className="group w-full grid grid-cols-[3.25rem_minmax(0,1fr)] md:grid-cols-[3.25rem_minmax(0,1fr)_auto_7.5rem] items-center gap-x-4 gap-y-2 px-4 sm:px-5 py-3.5 text-left hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
      >
        <span className="font-mono text-xs text-sub tabular-nums">{finding.id}</span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-main leading-snug line-clamp-2 group-hover:underline decoration-[var(--border-strong)] underline-offset-[3px]">
            {title}
          </span>
          <span className="block text-xs text-sub mt-0.5 truncate">
            {detail}
          </span>
        </span>
        <span className="col-start-2 md:col-start-auto">
          <RibbonGlyph finding={finding} annotate={finding.gravite === 'critique'} />
        </span>
        <span className="hidden md:flex flex-col items-end text-right">
          <span
            className="text-xs font-bold"
            style={{ color: STATUT_COLOR[finding.statut] }}
          >
            {STATUT_LABEL[finding.statut]}
          </span>
          <span className="text-xs text-sub inline-flex items-center gap-1">
            {GRAVITE_LABEL[finding.gravite]}
            <ArrowUpRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
          </span>
          {note && <span className="text-[11px] font-semibold text-[var(--accent-text)] mt-0.5">{note}</span>}
        </span>
      </button>
    </li>
  );
};
