import React, { useId, useMemo, useRef } from 'react';
import { gsap, prefersReducedMotion, useGSAP } from '../../motion/gsap';
import { buildSealGeometry, SEAL_VIEWBOX } from './guilloche';

export type SealStatus = 'pending' | 'sealed' | 'broken';

interface GuillocheSealProps {
  /** Empreinte SHA-256 (64 caractères hex) qui paramètre entièrement la rosace. */
  hash: string;
  status: SealStatus;
  /** Joue le tracé puis l'impression (une seule fois, décidé par l'appelant). */
  play?: boolean;
  /** Numéro du bloc de tête du registre, affiché sous le monogramme. */
  blockNum?: number;
  /** Taille rendue en px (la microtypographie est compensée pour rester vers 10,5 px). */
  size?: number;
  className?: string;
}

const C = SEAL_VIEWBOX / 2;
const TEXT_R = 87.5;
/** Cercle de texte commençant en haut (sens horaire). */
const TEXT_PATH = `M${C} ${C - TEXT_R}A${TEXT_R} ${TEXT_R} 0 1 1 ${C - 0.01} ${C - TEXT_R}`;

const STATUS_LABEL: Record<SealStatus, string> = {
  pending: 'à sceller',
  sealed: 'scellé',
  broken: 'non conforme',
};

/**
 * Sceau guilloché : rosace de courbes fines, déterministe à partir de l'empreinte du registre.
 * Trois états : filigrane gris (à sceller), vert gaufré (scellé), fracturé vermillon (altéré).
 */
const GuillocheSeal: React.FC<GuillocheSealProps> = ({
  hash,
  status,
  play = false,
  blockNum,
  size = 200,
  className,
}) => {
  const rootRef = useRef<SVGSVGElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const filterId = `seal-emboss-${uid}`;
  const pathId = `seal-ring-${uid}`;
  const broken = status === 'broken';
  const geometry = useMemo(() => buildSealGeometry(hash, broken), [hash, broken]);

  const cleanHash = (hash || '').toLowerCase();
  // Compensation : la microtypographie reste vers 10,5 px rendus quelle que soit la taille.
  const fontSize = Math.min(12, (10.5 * SEAL_VIEWBOX) / size);
  const ringText = `${cleanHash} · SHA-256 · `;

  const stroke =
    status === 'sealed' ? 'var(--reel)' : 'var(--text-muted)';
  const innerStroke =
    status === 'sealed' ? 'var(--text-primary)' : 'var(--text-muted)';
  const curveOpacity = status === 'pending' ? 0.34 : status === 'broken' ? 0.5 : 0.78;
  const textFill = status === 'sealed' ? 'var(--text-secondary)' : 'var(--text-muted)';

  useGSAP(
    () => {
      const root = rootRef.current;
      if (!root || !play || status !== 'sealed' || prefersReducedMotion()) return;
      const curves = gsap.utils.toArray<SVGPathElement>('[data-seal-curve]', root);
      const fixtures = root.querySelectorAll('[data-seal-fixture]');
      const wax = root.querySelector('[data-seal-wax]');
      const press = root.querySelector('[data-seal-press]');

      const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });
      tl.set(curves, { strokeDasharray: '1 1', strokeDashoffset: 1 })
        .set(wax, { opacity: 0 })
        .fromTo(fixtures, { opacity: 0 }, { opacity: 1, duration: 0.4, stagger: 0.05 }, 0)
        // Tracé trait par trait, du bord vers le centre (~1,6 s au total).
        .to(curves, { strokeDashoffset: 0, duration: 0.85, stagger: { amount: 0.75 } }, 0.05)
        // Impression : léger enfoncement puis retour, la cire gaufrée apparaît.
        .to(press, { scale: 0.972, duration: 0.14, ease: 'power2.in', transformOrigin: '50% 50%' }, '>-0.1')
        .to(wax, { opacity: 1, duration: 0.22 }, '<')
        .to(press, { scale: 1, duration: 0.5, ease: 'expo.out' })
        .set(curves, { clearProps: 'strokeDasharray,strokeDashoffset' });
    },
    { scope: rootRef, dependencies: [play, status] }
  );

  const label = `Sceau guilloché ${STATUS_LABEL[status]}, empreinte ${cleanHash.slice(0, 12)}${
    broken ? ' — empreinte non conforme, chaîne altérée' : ''
  }`;

  return (
    <svg
      ref={rootRef}
      viewBox={`0 0 ${SEAL_VIEWBOX} ${SEAL_VIEWBOX}`}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className={className}
      data-seal-status={status}
      style={{ overflow: 'visible' }}
    >
      <defs>
        {/* Gaufrage sobre : relief spéculaire limité à la cire. */}
        <filter id={filterId} x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="1.6" result="blur" />
          <feSpecularLighting
            in="blur"
            surfaceScale="2.4"
            specularConstant="0.55"
            specularExponent="16"
            lightingColor="#ffffff"
            result="spec"
          >
            <feDistantLight azimuth="235" elevation="38" />
          </feSpecularLighting>
          <feComposite in="spec" in2="SourceAlpha" operator="in" result="specIn" />
          <feOffset in="SourceAlpha" dx="0.8" dy="1.1" result="off" />
          <feGaussianBlur in="off" stdDeviation="1.4" result="offBlur" />
          <feComposite in="SourceAlpha" in2="offBlur" operator="out" result="inner" />
          <feFlood floodColor="#000000" floodOpacity="0.16" />
          <feComposite in2="inner" operator="in" result="innerShadow" />
          <feMerge>
            <feMergeNode in="SourceGraphic" />
            <feMergeNode in="innerShadow" />
            <feMergeNode in="specIn" />
          </feMerge>
        </filter>
        <path id={pathId} d={TEXT_PATH} />
      </defs>

      <g data-seal-press>
        {status === 'sealed' && (
          <g data-seal-wax filter={`url(#${filterId})`}>
            <circle cx={C} cy={C} r={98.5} fill="var(--reel-soft)" />
            <circle cx={C} cy={C} r={22.5} fill="var(--reel-soft)" />
          </g>
        )}

        {/* Anneaux concentriques fixes */}
        <g fill="none" stroke={stroke} opacity={curveOpacity}>
          <circle data-seal-fixture cx={C} cy={C} r={98} strokeWidth={0.8} />
          <circle data-seal-fixture cx={C} cy={C} r={96.3} strokeWidth={0.5} />
          <circle data-seal-fixture cx={C} cy={C} r={83.2} strokeWidth={0.5} />
          <circle data-seal-fixture cx={C} cy={C} r={59.5} strokeWidth={0.4} strokeDasharray="0.6 1.4" />
          <circle data-seal-fixture cx={C} cy={C} r={38.4} strokeWidth={0.4} strokeDasharray="0.6 1.4" />
        </g>

        {/* Rosace guillochée */}
        <g fill="none" strokeLinejoin="round" opacity={curveOpacity}>
          {geometry.curves.map((curve, i) => (
            <path
              key={`c${i}`}
              data-seal-curve
              d={curve.d}
              pathLength={1}
              stroke={curve.family === 'inner' ? innerStroke : stroke}
              strokeWidth={curve.width}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
        {broken && (
          <g data-seal-fracture fill="none" stroke="var(--rupture)" opacity={0.92}>
            {geometry.curves.map((curve, i) =>
              curve.fracture ? (
                <path key={`f${i}`} d={curve.fracture} strokeWidth={curve.width + 0.15} vectorEffect="non-scaling-stroke" />
              ) : null
            )}
          </g>
        )}

        {/* Microtypographie : l'empreinte complète le long de l'anneau */}
        <text
          data-seal-fixture
          fill={broken ? 'var(--rupture)' : textFill}
          fontFamily="var(--font-mono)"
          fontSize={fontSize}
          letterSpacing="0.02em"
          aria-hidden="true"
          transform={`rotate(${geometry.textRotation} ${C} ${C})`}
        >
          <textPath href={`#${pathId}`} startOffset="0">
            {ringText}
          </textPath>
        </text>

        {/* Centre : monogramme et bloc de tête */}
        <circle cx={C} cy={C} r={21.5} fill="var(--bg-surface)" />
        <circle
          data-seal-fixture
          cx={C}
          cy={C}
          r={21.5}
          fill="none"
          stroke={broken ? 'var(--rupture)' : stroke}
          strokeWidth={0.7}
          opacity={status === 'pending' ? 0.5 : 0.9}
        />
        <g aria-hidden="true" textAnchor="middle">
          <text
            data-seal-fixture
            x={C}
            y={blockNum !== undefined ? C + 1.2 : C + 3}
            fontSize={(9.5 * SEAL_VIEWBOX) / size}
            fontWeight={700}
            letterSpacing="0.12em"
            fill={status === 'pending' ? 'var(--text-muted)' : broken ? 'var(--rupture)' : 'var(--accent-text)'}
          >
            TRIAD
          </text>
          {blockNum !== undefined && (
            <text
              data-seal-fixture
              x={C}
              y={C + 11}
              fontFamily="var(--font-mono)"
              fontSize={(8 * SEAL_VIEWBOX) / size}
              fill="var(--text-muted)"
            >
              #{String(blockNum).padStart(2, '0')}
            </text>
          )}
        </g>
      </g>
    </svg>
  );
};

export default GuillocheSeal;
