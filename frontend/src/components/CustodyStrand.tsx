import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AuditLogEntry } from '../types';
import type { BrowserChainVerificationReport } from '../utils/webCryptoVerify';
import { gsap, prefersReducedMotion, useGSAP } from '../motion/gsap';

/**
 * Brin de la chaîne de garde : chaque entrée du registre SHA-256 est un maillon dessiné,
 * relié au précédent par son empreinte. Les 6 premiers caractères du hash d'un maillon
 * se retrouvent, de l'autre côté de l'attache, dans le prev_hash du maillon suivant.
 */

const GENESIS = '0'.repeat(64);
const GAP = 34;
const LINK_H = 74;
const ROW_GAP = 30;
const MIN_LINK_W = 150;

interface CustodyStrandProps {
  entries: AuditLogEntry[];
  report: BrowserChainVerificationReport | null;
  tamperedBlock: number | null;
  serverValid: boolean;
  /** Numéros de blocs correspondant aux filtres actifs (null = aucun filtre). */
  matched: Set<number> | null;
}

interface LinkModel {
  entry: AuditLogEntry;
  blockNum: number;
  x: number;
  y: number;
  dir: 1 | -1;
  row: number;
  /** Le maillon lui-même est fendu (contenu ou empreinte altérée). */
  cracked: boolean;
  /** L'attache avec le maillon précédent est rompue (prev_hash ≠ hash précédent). */
  joinBroken: boolean;
}

function short(h: string | undefined): string {
  return (h || '').slice(0, 6) || '——————';
}

function formatTs(ts: string | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString('fr-FR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC',
  }) + ' UTC';
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export const CustodyStrand: React.FC<CustodyStrandProps> = ({
  entries,
  report,
  tamperedBlock,
  serverValid,
  matched,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { links, cols, linkW, height } = useMemo(() => {
    const w = Math.max(width, 260);
    let c = Math.floor((w + GAP) / (MIN_LINK_W + GAP));
    c = Math.max(2, Math.min(6, c));
    const lw = (w - (c - 1) * GAP) / c;
    const out: LinkModel[] = entries.map((entry, i) => {
      const row = Math.floor(i / c);
      const posInRow = i % c;
      const dir: 1 | -1 = row % 2 === 0 ? 1 : -1;
      const col = dir === 1 ? posInRow : c - 1 - posInRow;
      const blockNum = i + 1;
      const proof = report?.byBlock[blockNum];
      const expectedPrev = i === 0 ? GENESIS : entries[i - 1].hash;
      const joinBroken =
        entry.prev_hash !== expectedPrev || Boolean(proof && !proof.prevHashValid);
      const cracked = tamperedBlock === blockNum || Boolean(proof && !proof.hashValid);
      return {
        entry,
        blockNum,
        x: col * (lw + GAP),
        y: row * (LINK_H + ROW_GAP),
        dir,
        row,
        cracked,
        joinBroken,
      };
    });
    const rows = Math.max(1, Math.ceil(entries.length / c));
    return { links: out, cols: c, linkW: lw, height: rows * LINK_H + (rows - 1) * ROW_GAP + 4 };
  }, [entries, width, report, tamperedBlock]);

  // Si le serveur signale une rupture qu'aucun maillon n'explique localement, on fend le premier maillon non vérifié.
  const unexplainedBreak =
    !serverValid && links.length > 0 && !links.some((l) => l.cracked || l.joinBroken);

  const layoutKey = `${entries.length}-${cols}-${width > 0 ? 1 : 0}`;

  useGSAP(
    () => {
      if (!svgRef.current || width === 0 || prefersReducedMotion()) return;
      const n = links.length;
      if (n === 0) return;
      const step = Math.min(0.07, 0.75 / n);
      const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
      tl.from('[data-strand-link]', {
        opacity: 0,
        scale: 0.9,
        transformOrigin: '50% 50%',
        duration: 0.42,
        stagger: step,
      });
      tl.from(
        '[data-strand-join]',
        {
          opacity: 0,
          scaleX: 0.2,
          transformOrigin: '50% 50%',
          duration: 0.32,
          stagger: step,
        },
        step * 0.6
      );
    },
    { scope: svgRef, dependencies: [layoutKey] }
  );

  const shown = active ?? null;
  const detail = shown !== null ? links[shown] : null;

  const onKey = (e: React.KeyboardEvent, i: number) => {
    let next = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(links.length - 1, i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = links.length - 1;
    else if (e.key === 'Escape') {
      setActive(null);
      return;
    } else return;
    e.preventDefault();
    setFocusIdx(next);
    setActive(next);
    const el = svgRef.current?.querySelector<SVGGElement>(`[data-strand-idx="${next}"]`);
    el?.focus();
  };

  if (entries.length === 0) return null;

  return (
    <div className="space-y-3">
      <div ref={wrapRef} className="w-full">
        {width > 0 && (
          <svg
            ref={svgRef}
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="group"
            aria-label={`Brin de la chaîne de garde, ${links.length} maillons. Flèches pour parcourir, chaque maillon affiche le début de son empreinte précédente et de la sienne.`}
            className="block overflow-visible select-none"
            onMouseLeave={() => setActive(null)}
          >
            {/* Attaches : empreinte d'un maillon emboîtée dans le prev_hash du suivant */}
            {links.slice(1).map((l, k) => {
              const p = links[k];
              const broken = l.joinBroken;
              const stroke = broken ? 'var(--rupture)' : 'var(--border-strong)';
              if (p.row === l.row) {
                const x1 = Math.min(p.x, l.x) + linkW;
                const cx = x1 + GAP / 2;
                const cy = l.y + LINK_H / 2;
                return (
                  <g key={`j-${l.blockNum}`} data-strand-join aria-hidden="true">
                    {broken ? (
                      <>
                        <path d={`M ${x1 - 4} ${cy} h ${GAP / 2 - 6}`} style={{ stroke, strokeWidth: 2, fill: 'none' }} />
                        <path d={`M ${cx + 6} ${cy} h ${GAP / 2 - 2}`} style={{ stroke, strokeWidth: 2, fill: 'none' }} />
                        <path d={`M ${cx - 3} ${cy - 7} l 6 14`} style={{ stroke, strokeWidth: 2, fill: 'none' }} />
                      </>
                    ) : (
                      <>
                        <ellipse cx={cx - 5} cy={cy} rx={11} ry={6} style={{ stroke, strokeWidth: 2, fill: 'none' }} />
                        <ellipse cx={cx + 5} cy={cy} rx={11} ry={6} style={{ stroke: 'var(--reel)', strokeWidth: 2, fill: 'none' }} />
                      </>
                    )}
                  </g>
                );
              }
              // Retour à la ligne (serpentin) : attache verticale sur le bord
              const cx = p.x + linkW / 2;
              const y1 = p.y + LINK_H;
              const cy = y1 + ROW_GAP / 2;
              return (
                <g key={`j-${l.blockNum}`} data-strand-join aria-hidden="true">
                  {broken ? (
                    <>
                      <path d={`M ${cx} ${y1 - 2} v ${ROW_GAP / 2 - 5}`} style={{ stroke, strokeWidth: 2, fill: 'none' }} />
                      <path d={`M ${cx} ${cy + 5} v ${ROW_GAP / 2 - 3}`} style={{ stroke, strokeWidth: 2, fill: 'none' }} />
                      <path d={`M ${cx - 7} ${cy - 3} l 14 6`} style={{ stroke, strokeWidth: 2, fill: 'none' }} />
                    </>
                  ) : (
                    <>
                      <ellipse cx={cx} cy={cy - 4} rx={6} ry={10} style={{ stroke, strokeWidth: 2, fill: 'none' }} />
                      <ellipse cx={cx} cy={cy + 4} rx={6} ry={10} style={{ stroke: 'var(--reel)', strokeWidth: 2, fill: 'none' }} />
                    </>
                  )}
                </g>
              );
            })}

            {links.map((l, i) => {
              const cracked = l.cracked || (unexplainedBreak && i === links.length - 1);
              const broken = cracked || l.joinBroken;
              const dim = matched !== null && !matched.has(l.blockNum);
              const isActive = active === i;
              const isHead = i === links.length - 1;
              const prevText = l.entry.prev_hash === GENESIS ? 'genèse' : short(l.entry.prev_hash);
              // Le côté « entrée » (prev_hash) fait face au maillon précédent dans le serpentin.
              const prevOnLeft = l.dir === 1;
              const pad = 12;
              const leftX = l.x + pad;
              const rightX = l.x + linkW - pad;
              const maxChars = Math.max(8, Math.floor((linkW - 2 * pad - 30) / 7.4));
              return (
                <g
                  key={`${l.entry.hash}-${l.blockNum}`}
                  data-strand-link
                  data-strand-idx={i}
                  role="button"
                  tabIndex={i === focusIdx ? 0 : -1}
                  aria-pressed={isActive}
                  aria-label={`Maillon ${l.blockNum}, ${l.entry.agent}, ${l.entry.action}${
                    broken ? ', rupture détectée' : ''
                  }. Précédent ${prevText}, empreinte ${short(l.entry.hash)}.`}
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => {
                    setFocusIdx(i);
                    setActive(i);
                  }}
                  onClick={() => setActive(i)}
                  onKeyDown={(e) => onKey(e, i)}
                  className="cursor-pointer outline-none strand-link"
                  style={{ opacity: dim ? 0.38 : 1, transition: 'opacity 200ms ease-out' }}
                >
                  <rect
                    x={l.x + 1}
                    y={l.y + 1}
                    width={linkW - 2}
                    height={LINK_H - 2}
                    rx={LINK_H / 2 - 6}
                    style={{
                      fill: broken ? 'var(--rupture-soft)' : isActive ? 'var(--bg-elevated)' : 'var(--bg-card)',
                      stroke: broken
                        ? 'var(--rupture)'
                        : isActive
                        ? 'var(--text-primary)'
                        : isHead
                        ? 'var(--reel)'
                        : 'var(--border-strong)',
                      strokeWidth: isActive || broken || isHead ? 2 : 1.25,
                      transition: 'stroke 160ms ease-out, fill 160ms ease-out',
                    }}
                  />
                  {cracked && (
                    <path
                      aria-hidden="true"
                      d={`M ${l.x + linkW * 0.56} ${l.y + 1} l -9 ${LINK_H * 0.28} l 12 ${LINK_H * 0.16} l -10 ${
                        LINK_H * 0.2
                      } l 7 ${LINK_H * 0.36 - 2}`}
                      style={{ fill: 'none', stroke: 'var(--rupture)', strokeWidth: 2.25, strokeLinejoin: 'round' }}
                    />
                  )}
                  <text
                    x={leftX + 4}
                    y={l.y + 29}
                    style={{ fontSize: 13, fontWeight: 600, fill: 'var(--text-primary)' }}
                  >
                    <tspan style={{ fill: broken ? 'var(--rupture)' : 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                      {String(l.blockNum).padStart(2, '0')}
                    </tspan>
                    <tspan dx={8}>{clip(l.entry.action, maxChars)}</tspan>
                  </text>
                  <text
                    x={prevOnLeft ? leftX + 4 : rightX - 4}
                    y={l.y + 54}
                    textAnchor={prevOnLeft ? 'start' : 'end'}
                    style={{
                      fontSize: 12,
                      fontFamily: 'var(--font-mono)',
                      fill: l.joinBroken ? 'var(--rupture)' : 'var(--text-muted)',
                    }}
                  >
                    {prevOnLeft ? `‹ ${prevText}` : `${prevText} ›`}
                  </text>
                  <text
                    x={prevOnLeft ? rightX - 4 : leftX + 4}
                    y={l.y + 54}
                    textAnchor={prevOnLeft ? 'end' : 'start'}
                    style={{
                      fontSize: 12,
                      fontFamily: 'var(--font-mono)',
                      fontWeight: 600,
                      fill: cracked ? 'var(--rupture)' : 'var(--reel)',
                    }}
                  >
                    {short(l.entry.hash)}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>

      <div
        aria-live="polite"
        className="min-h-[76px] rounded-xl border border-hairline px-4 py-3 text-[13px] text-sub"
      >
        {detail ? (
          <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-[auto_1fr]">
            <span className="text-xs text-dim">Maillon</span>
            <span className="text-main font-semibold">
              {String(detail.blockNum).padStart(2, '0')} · {detail.entry.agent} · {detail.entry.action}
              {(detail.cracked || detail.joinBroken) && (
                <span className="ml-2 text-[var(--rupture)]">
                  {detail.cracked ? 'empreinte non conforme' : 'attache rompue avec le maillon précédent'}
                </span>
              )}
            </span>
            <span className="text-xs text-dim">Horodatage</span>
            <span className="text-main tabular-nums">{formatTs(detail.entry.ts)}</span>
            <span className="text-xs text-dim">Empreinte précédente</span>
            <span className="font-mono text-xs break-all">{detail.entry.prev_hash}</span>
            <span className="text-xs text-dim">Empreinte</span>
            <span className="font-mono text-xs break-all text-[var(--reel)]">{detail.entry.hash}</span>
          </div>
        ) : (
          <p>
            Survolez ou parcourez un maillon au clavier pour lire son horodatage, son acteur et ses
            empreintes complètes. Chaque attache relie les 6 premiers caractères d&apos;une empreinte à
            l&apos;empreinte précédente du maillon suivant.
          </p>
        )}
      </div>
    </div>
  );
};

export default CustodyStrand;
