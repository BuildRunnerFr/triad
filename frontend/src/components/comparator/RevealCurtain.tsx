import React, { useCallback, useMemo, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import type { Finding, StatutFinding } from '../../types';
import type { ComparedFindingItem } from '../../utils/auditMetrics';
import { gsap, prefersReducedMotion, useGSAP } from '../../motion/gsap';

/**
 * Rideau de révélation AVANT / APRÈS.
 *
 * Deux états du même tableau sont superposés : la vision déclarée (AVANT) en
 * dessous, la vision vérifiée (APRÈS) au-dessus, découpée par clip-path à partir
 * de la position du rideau. Les deux couches visuelles sont aria-hidden ; un
 * tableau sr-only porte les deux valeurs de chaque constat pour les lecteurs
 * d'écran, et la poignée est un vrai role="slider".
 */

interface RevealCurtainProps {
  items: ComparedFindingItem[];
  scoreAvant: number;
  scoreApres: number;
}

type Phase = 'avant' | 'apres';

/** Poids identiques à computeMaturityScore (utils/auditMetrics). */
const STATUT_WEIGHT: Record<StatutFinding, number> = {
  conforme: 100,
  partiel: 55,
  a_confirmer: 40,
  non_conforme: 0,
};

const STATUT_BASE: Record<StatutFinding, string> = {
  conforme: 'Conforme',
  partiel: 'Partiel',
  non_conforme: 'Non conforme',
  a_confirmer: 'À confirmer',
};

function statusLabel(f: Finding | null, phase: Phase): string {
  if (!f) return 'Non évalué';
  const base = STATUT_BASE[f.statut] ?? 'À confirmer';
  if (f.statut === 'a_confirmer') return base;
  return `${base} ${phase === 'avant' ? 'déclaré' : 'vérifié'}`;
}

/** Une rangée est en rupture quand la vérification dégrade la déclaration ou dément le Dit. */
function isRupture(item: ComparedFindingItem): boolean {
  if (!item.apres) return false;
  if (item.isDitContradiction) return true;
  if (!item.avant) return item.apres.statut !== 'conforme';
  return STATUT_WEIGHT[item.apres.statut] < STATUT_WEIGHT[item.avant.statut];
}

function apresTone(item: ComparedFindingItem): string {
  const f = item.apres;
  if (!f) return 'var(--text-muted)';
  if (isRupture(item)) return 'var(--rupture)';
  if (f.statut === 'conforme') return 'var(--accent-text)';
  if (f.statut === 'partiel') return 'var(--warning-text)';
  return 'var(--text-secondary)';
}

const clamp = (v: number) => Math.min(100, Math.max(0, v));

/* -------------------------------------------------------------------------- */

const Bar: React.FC<{ value: number | null; color: string; track?: string }> = ({
  value,
  color,
  track = 'var(--border-subtle)',
}) => (
  <span className="relative block h-[3px] w-full rounded-full overflow-hidden" style={{ background: track }}>
    {value !== null && (
      <span
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ width: `${Math.max(value, 2)}%`, background: color }}
      />
    )}
  </span>
);

interface LayerProps {
  phase: Phase;
  items: ComparedFindingItem[];
  score: number;
}

/**
 * Une couche complète du tableau. Les deux couches ont une géométrie strictement
 * identique (mêmes rangées, mêmes hauteurs, même graisse de texte) : seules
 * l'encre et les valeurs changent, pour que le passage du rideau se lise en place.
 */
const Layer: React.FC<LayerProps> = ({ phase, items, score }) => {
  const avant = phase === 'avant';
  const scoreTone = avant ? 'var(--text-secondary)' : score < 50 ? 'var(--rupture)' : 'var(--accent-text)';
  // Les deux en-têtes sont rendus dans chaque couche (l'autre en visibility:hidden)
  // pour garantir des hauteurs identiques quel que soit le retour à la ligne.
  const header = (side: Phase, value: number) => (
    <div
      className={side === 'avant' ? 'text-left' : 'text-right'}
      style={side === phase ? undefined : { visibility: 'hidden' }}
    >
      <div className="text-sm font-semibold text-main">
        {side === 'avant' ? 'Ce que la DSI déclare' : 'Ce que les faits montrent'}
      </div>
      <div className="text-xs text-sub mt-0.5 leading-snug">
        {side === 'avant' ? 'AVANT · pré-audit documentaire' : 'APRÈS · entretiens et sondes'}
      </div>
      <div className="mt-2 text-xl sm:text-2xl font-semibold tabular-nums leading-none" style={{ color: scoreTone }}>
        {value} %
        <span className="ml-1.5 text-xs font-normal text-sub">
          {side === 'avant' ? 'maturité déclarée' : 'maturité vérifiée'}
        </span>
      </div>
    </div>
  );
  return (
    <div className="w-full" style={{ background: avant ? 'var(--bg-subtle)' : 'var(--bg-surface)' }}>
      {/* En-tête : chaque phase occupe sa moitié, la jauge traverse tout le tableau */}
      <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-hairline">
        <div className="grid grid-cols-2 gap-x-4 sm:gap-x-8 items-start">
          {header('avant', score)}
          {header('apres', score)}
        </div>
        <div className="mt-3">
          <Bar value={score} color={avant ? 'var(--text-muted)' : scoreTone} />
        </div>
      </div>

      <ul className="divide-y divide-[var(--border-subtle)]">
        {items.map((item) => {
          const f = avant ? item.avant : item.apres;
          const weight = f ? STATUT_WEIGHT[f.statut] ?? 40 : null;
          const rupture = !avant && isRupture(item);
          const tone = avant ? (f ? 'var(--text-secondary)' : 'var(--text-muted)') : apresTone(item);
          return (
            <li
              key={item.key}
              className="h-[64px] sm:h-12 px-4 sm:px-5 grid grid-cols-[2.9rem_minmax(0,1fr)] sm:grid-cols-[3.75rem_minmax(0,1fr)_minmax(0,1fr)] content-center items-center gap-x-3 gap-y-1"
              style={rupture ? { background: 'var(--rupture-soft)' } : undefined}
            >
              <span className="font-mono text-xs" style={{ color: avant ? 'var(--text-muted)' : 'var(--text-secondary)' }}>
                {item.id}
              </span>
              <span className="text-sm truncate" style={{ color: avant ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
                {item.theme}
              </span>
              <span className="col-start-2 sm:col-start-3 flex items-center justify-end sm:justify-start gap-3 min-w-0">
                <span
                  className="text-xs whitespace-nowrap sm:w-[10.5rem]"
                  style={{ color: tone, fontWeight: rupture ? 650 : 500 }}
                >
                  {statusLabel(f, phase)}
                </span>
                <span className="w-14 sm:w-auto sm:flex-1 sm:max-w-[10rem] shrink-0">
                  <Bar value={weight} color={avant ? 'var(--text-muted)' : tone} />
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

/* -------------------------------------------------------------------------- */

export const RevealCurtain: React.FC<RevealCurtainProps> = ({ items, scoreAvant, scoreApres }) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const [pos, setPos] = useState<number>(reduced ? 50 : 0);
  const [dragging, setDragging] = useState(false);
  const pointerId = useRef<number | null>(null);
  const introRef = useRef<gsap.core.Tween | null>(null);

  const ruptureCount = useMemo(() => items.filter(isRupture).length, [items]);

  // Ouverture : le rideau glisse une fois de la gauche jusqu'au milieu.
  useGSAP(
    () => {
      if (reduced) return;
      const proxy = { v: 0 };
      introRef.current = gsap.to(proxy, {
        v: 50,
        duration: 0.9,
        delay: 0.25,
        ease: 'power3.out',
        onUpdate: () => setPos(proxy.v),
      });
    },
    { scope: stageRef }
  );

  const stopIntro = () => {
    introRef.current?.kill();
    introRef.current = null;
  };

  const posFromClientX = useCallback((clientX: number) => {
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    setPos(clamp(((clientX - r.left) / r.width) * 100));
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== null) return; // ignore un second doigt
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stopIntro();
    pointerId.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    posFromClientX(e.clientX);
    handleRef.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== e.pointerId) return;
    posFromClientX(e.clientX);
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointerId.current !== e.pointerId) return;
    pointerId.current = null;
    setDragging(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 5;
    let next: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = pos - step;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = pos + step;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 100;
    else if (e.key === 'PageDown') next = pos - 25;
    else if (e.key === 'PageUp') next = pos + 25;
    if (next === null) return;
    e.preventDefault();
    stopIntro();
    setPos(clamp(Math.round(next)));
  };

  const rounded = Math.round(pos);
  const valueText =
    rounded <= 0
      ? 'Vision vérifiée APRÈS seule'
      : rounded >= 100
      ? 'Vision déclarée AVANT seule'
      : `${rounded} % vision déclarée à gauche, ${100 - rounded} % vision vérifiée à droite`;

  return (
    <section aria-labelledby="curtain-title" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="curtain-title" className="text-base font-semibold text-main">
          Déclaré ou vérifié : faites glisser le rideau
        </h3>
        <p className="text-xs text-sub">
          {ruptureCount > 0 ? (
            <>
              <span className="font-semibold tabular-nums" style={{ color: 'var(--rupture)' }}>
                {ruptureCount}
              </span>{' '}
              constat{ruptureCount > 1 ? 's' : ''} basculent à la vérification
            </>
          ) : (
            'Aucune dégradation à la vérification'
          )}
        </p>
      </div>

      <div
        ref={stageRef}
        className="relative rounded-xl border border-hairline overflow-hidden select-none"
        style={{ touchAction: 'pan-y', cursor: dragging ? 'grabbing' : 'ew-resize' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        {/* Couche AVANT : dans le flux, elle donne la hauteur */}
        <div aria-hidden="true">
          <Layer phase="avant" items={items} score={scoreAvant} />
        </div>

        {/* Couche APRÈS : superposée, révélée à droite du rideau */}
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{ clipPath: `inset(0 0 0 ${pos}%)`, willChange: 'clip-path' }}
        >
          <Layer phase="apres" items={items} score={scoreApres} />
        </div>

        {/* Rideau : filet d'encre et poignée */}
        <div
          className="absolute inset-y-0 pointer-events-none"
          style={{ left: `${pos}%`, width: 0 }}
        >
          <span
            className="absolute inset-y-0 -translate-x-1/2 w-[2px]"
            style={{ background: 'var(--text-primary)' }}
            aria-hidden="true"
          />
          <div
            ref={handleRef}
            role="slider"
            tabIndex={0}
            aria-label="Position du rideau entre vision déclarée et vision vérifiée"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={rounded}
            aria-valuetext={valueText}
            aria-orientation="horizontal"
            aria-controls="curtain-sr-table"
            onKeyDown={onKeyDown}
            className="pointer-events-auto absolute top-1/2 left-0 w-9 h-11 rounded-full flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--accent-text)] focus-visible:ring-offset-[var(--bg-surface)]"
            style={{
              background: 'var(--text-primary)',
              color: 'var(--bg-surface)',
              boxShadow: '0 2px 8px -2px rgba(0,0,0,0.35)',
              transform: `translate(-50%, -50%) scale(${dragging ? 1.06 : 1})`,
              transition: 'transform 140ms cubic-bezier(0.23, 1, 0.32, 1)',
              cursor: dragging ? 'grabbing' : 'grab',
            }}
          >
            <GripVertical className="w-4 h-4" aria-hidden="true" />
          </div>
        </div>
      </div>

      <p className="text-xs text-sub" aria-hidden="true">
        Glissez la poignée, ou utilisez les flèches ← → du clavier une fois la poignée sélectionnée.
      </p>

      {/* Alternative textuelle complète : les deux états pour chaque constat */}
      <table id="curtain-sr-table" className="sr-only">
        <caption>
          Comparaison déclaré et vérifié, maturité déclarée {scoreAvant} %, maturité vérifiée {scoreApres} %
        </caption>
        <thead>
          <tr>
            <th scope="col">Constat</th>
            <th scope="col">Thème</th>
            <th scope="col">Déclaré (AVANT)</th>
            <th scope="col">Vérifié (APRÈS)</th>
            <th scope="col">Rupture</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.key}>
              <th scope="row">{item.id}</th>
              <td>{item.theme}</td>
              <td>{statusLabel(item.avant, 'avant')}</td>
              <td>{statusLabel(item.apres, 'apres')}</td>
              <td>{isRupture(item) ? 'Oui' : 'Non'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};

export default RevealCurtain;
