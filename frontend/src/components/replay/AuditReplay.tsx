import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Pause, Play, RotateCcw, ShieldAlert, X } from 'lucide-react';
import type { AuditLogEntry, AuditMode, AuditSynthesis } from '../../types';
import { fetchFilteredAuditLog } from '../../api';
import { gsap, prefersReducedMotion, useGSAP } from '../../motion/gsap';
import { actionLabel } from '../CustodyStrand';
import {
  ACTS,
  buildReplayModel,
  detailFile,
  formatClock,
  formatTs,
  type ActId,
  type ReplayDoc,
  type ReplayModel,
} from './replayModel';

/**
 * « Rejouer l'audit » : un montage en quatre actes piloté par le registre SHA-256 réel.
 * Une seule timeline GSAP, en pause par défaut sous reduced-motion (ouverte sur l'état final),
 * scrubbable à la souris et au clavier. Aucune boucle quand la lecture est arrêtée.
 */

interface AuditReplayProps {
  synthesis: AuditSynthesis;
  mode: AuditMode;
  onClose: () => void;
}

interface Cue {
  t: number;
  idx: number;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'ready'; entries: AuditLogEntry[]; head: string | null; valid: boolean };

const FOCUSABLE =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

const PILLARS = [
  { key: 'dit', label: 'Dit', color: 'var(--dit)' },
  { key: 'ecrit', label: 'Écrit', color: 'var(--ecrit)' },
  { key: 'reel', label: 'Réel', color: 'var(--reel)' },
] as const;

const MAX_LINKS = 30;

function involved(contradiction: string | null): Set<string> {
  const out = new Set<string>();
  if (!contradiction) return out;
  const c = contradiction.toLowerCase();
  if (c.includes('dit')) out.add('dit');
  if (c.includes('écrit') || c.includes('ecrit')) out.add('ecrit');
  if (c.includes('réel') || c.includes('reel')) out.add('reel');
  return out;
}

/* ───────────────────────── Pièces (acte 1) ───────────────────────── */

const DocCard: React.FC<{ doc: ReplayDoc; k: number; asSlot?: boolean }> = ({ doc, k, asSlot }) => {
  if (asSlot) {
    return <div data-r="slot" data-k={k} aria-hidden="true" className="w-full sm:w-[244px] h-[212px]" />;
  }
  const pillar = doc.source === 'dit' ? PILLARS[0] : doc.source === 'ecrit' ? PILLARS[1] : null;
  return (
    <article
      data-r={doc.quarantined ? 'qcard' : 'card'}
      data-k={k}
      data-name={doc.name}
      className="relative w-full sm:w-[244px] h-[212px] rounded-lg border border-hairline bg-[var(--bg-elevated)] px-4 pt-3.5 pb-3 flex flex-col shadow-[var(--shadow-panel)]"
    >
      <div className="min-w-0">
        <h4 className="text-[13px] font-semibold text-main truncate" title={doc.name}>
          {doc.name}
        </h4>
        {pillar && (
          <p className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-sub">
            <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full" style={{ background: pillar.color }} />
            {pillar.label}
          </p>
        )}
      </div>
      <div className="mt-2.5 space-y-1 text-[12px] leading-[1.55] text-sub min-h-0 overflow-hidden">
        {doc.lines.map((line, li) => (
          <p key={li} className="relative">
            {line.map((part, pi) =>
              part.token ? (
                <span key={pi} className="relative inline-block font-mono text-[10.5px] text-muted px-0.5">
                  {part.text}
                  <span
                    data-r="bar"
                    aria-hidden="true"
                    className="absolute inset-x-0 top-[2px] bottom-[2px] rounded-[2px] bg-[var(--text-primary)] origin-left flex items-center justify-center"
                  >
                    <span className="font-mono text-[9.5px] text-[var(--bg-elevated)]">
                      {part.text.replace(/[[\]]/g, '').toLowerCase()}
                    </span>
                  </span>
                </span>
              ) : (
                <span key={pi}>{part.text}</span>
              )
            )}
            {doc.quarantined && (
              <span
                data-r="strike"
                aria-hidden="true"
                className="absolute left-0 right-0 top-1/2 h-[1.5px] bg-[var(--rupture)] origin-left"
              />
            )}
          </p>
        ))}
      </div>
      <p
        data-r="stamp"
        className={`mt-auto pt-2 flex items-center gap-1.5 text-[11.5px] font-semibold ${
          doc.quarantined ? 'text-[var(--rupture)]' : 'text-[var(--accent-text)]'
        }`}
      >
        {doc.quarantined ? (
          <>
            <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
            Injection détectée
          </>
        ) : (
          <>
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
            Assainie · {doc.masks} masquage{doc.masks > 1 ? 's' : ''}
          </>
        )}
      </p>
      {doc.quarantined && (
        <span
          data-r="qborder"
          aria-hidden="true"
          className="pointer-events-none absolute -inset-px rounded-lg border border-[var(--rupture)]"
        />
      )}
    </article>
  );
};

/* ───────────────────────── Composant ───────────────────────── */

const AuditReplay: React.FC<AuditReplayProps> = ({ synthesis, mode, onClose }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const numRef = useRef<HTMLSpanElement>(null);
  const playBtnRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const tlRef = useRef<gsap.core.Timeline | null>(null);
  const cuesRef = useRef<Cue[]>([]);
  const ruptureCuesRef = useRef<number[]>([]);
  const actStartsRef = useRef<number[]>([0, 0, 0, 0]);
  const progressRef = useRef<number | null>(null);
  const playingRef = useRef(false);
  const blockRef = useRef(-1);
  const actRef = useRef<ActId>(0);
  const announceTimer = useRef<number | null>(null);
  const speedRef = useRef<1 | 2>(1);
  const reduced = useMemo(() => prefersReducedMotion(), []);

  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [layoutKey, setLayoutKey] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2>(1);
  const [block, setBlock] = useState(-1);
  const [act, setAct] = useState<ActId>(0);
  const [duration, setDuration] = useState(0);
  const [actStarts, setActStarts] = useState<number[]>([0, 0, 0, 0]);
  const [live, setLive] = useState('');

  /* Données réelles : registre chaîné de la session. */
  useEffect(() => {
    const ctrl = new AbortController();
    fetchFilteredAuditLog({}, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        if (!res || res.entries.length === 0) setLoad({ kind: 'empty' });
        else
          setLoad({
            kind: 'ready',
            entries: res.entries,
            head: res.head_hash ?? null,
            valid: res.chain_valid,
          });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setLoad({ kind: 'empty' });
      });
    return () => ctrl.abort();
  }, []);

  const model: ReplayModel | null = useMemo(
    () => (load.kind === 'ready' ? buildReplayModel(load.entries, load.head, synthesis, mode) : null),
    [load, synthesis, mode]
  );
  const chainValid = load.kind === 'ready' ? load.valid : false;

  /* Maillons affichés au scellement (compressés au-delà de MAX_LINKS). */
  const links = useMemo(() => {
    if (!model) return [] as ({ idx: number } | { gap: number })[];
    const n = model.chain.length;
    if (n <= MAX_LINKS) return model.chain.map((_, idx) => ({ idx }));
    const head = 4;
    const tail = MAX_LINKS - head - 1;
    return [
      ...Array.from({ length: head }, (_, idx) => ({ idx })),
      { gap: n - head - tail },
      ...Array.from({ length: tail }, (_, i) => ({ idx: n - tail + i })),
    ];
  }, [model]);

  /* Modale : verrou du défilement, focus initial, restitution du focus. */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeBtnRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      if (announceTimer.current) window.clearTimeout(announceTimer.current);
      if (opener && typeof opener.focus === 'function') opener.focus();
    };
  }, []);

  useEffect(() => {
    if (model) playBtnRef.current?.focus();
  }, [model]);

  /* Reconstruit la timeline quand la mise en page change (positions mesurées). */
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !model) return;
    let timer = 0;
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setLayoutKey((k) => k + 1), 180);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [model]);

  const sync = useCallback(() => {
    const tl = tlRef.current;
    if (!tl) return;
    const t = tl.time();
    const d = tl.duration() || 1;
    const p = t / d;
    progressRef.current = p;
    if (fillRef.current) fillRef.current.style.transform = `scaleX(${p})`;
    if (thumbRef.current) thumbRef.current.style.left = `${p * 100}%`;
    if (clockRef.current) clockRef.current.textContent = formatClock(t);
    trackRef.current?.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    if (numRef.current) {
      const n = ruptureCuesRef.current.filter((c) => c <= t + 1e-4).length;
      if (numRef.current.textContent !== String(n)) numRef.current.textContent = String(n);
    }
    let cur = -1;
    for (const c of cuesRef.current) {
      if (c.t <= t + 1e-4) cur = c.idx;
      else break;
    }
    if (cur !== blockRef.current) {
      blockRef.current = cur;
      setBlock(cur);
    }
    const starts = actStartsRef.current;
    let a: ActId = 0;
    for (let i = 3; i >= 0; i -= 1) {
      if (t >= starts[i] - 1e-4) {
        a = i as ActId;
        break;
      }
    }
    if (a !== actRef.current) {
      actRef.current = a;
      setAct(a);
    }
  }, []);

  useGSAP(
    () => {
      const root = rootRef.current;
      if (!root || !model) return;
      const q = gsap.utils.selector(root);
      const cues: Cue[] = [];
      const ruptureCues: number[] = [];
      const tl = gsap.timeline({
        paused: true,
        defaults: { ease: 'expo.out', duration: 0.6 },
        onUpdate: sync,
        onComplete: () => {
          playingRef.current = false;
          setPlaying(false);
        },
      });
      const scenes = q('[data-r="scene"]');
      const sceneIn = (i: number, at: number) => {
        tl.fromTo(scenes[i], { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.45, ease: 'power2.out' }, at);
        const head = scenes[i].querySelector('[data-r="head"]');
        if (head) tl.fromTo(head, { y: 14, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.7 }, at + 0.05);
      };
      const sceneOut = (i: number, at: number) => {
        tl.fromTo(
          scenes[i],
          { autoAlpha: 1, y: 0 },
          { autoAlpha: 0, y: -10, duration: 0.4, ease: 'power2.in', immediateRender: false },
          at
        );
      };
      // Toutes les scènes masquées au départ.
      gsap.set(scenes, { autoAlpha: 0 });

      /* ── Acte 1 : réception ── */
      const a1 = 0;
      sceneIn(0, a1);
      const cards = q('[data-r="card"]');
      const qcards = q('[data-r="qcard"]');
      const ordered = [...cards, ...qcards];
      const offsets = new Map<Element, { x: number; y: number }>();
      for (const qc of qcards) {
        const slot = root.querySelector(`[data-r="slot"][data-k="${(qc as HTMLElement).dataset.k}"]`);
        if (!slot) continue;
        const a = slot.getBoundingClientRect();
        const b = qc.getBoundingClientRect();
        offsets.set(qc, { x: a.left - b.left, y: a.top - b.top });
      }
      ordered.forEach((card, i) => {
        const off = offsets.get(card) ?? { x: 0, y: 0 };
        tl.fromTo(
          card,
          { x: off.x, y: off.y - 26, rotation: i % 2 ? 1.4 : -1.4, autoAlpha: 0 },
          { x: off.x, y: off.y, rotation: 0, autoAlpha: 1, duration: 0.8 },
          a1 + 0.55 + i * 0.3
        );
      });
      tl.fromTo(q('[data-r="bar"]'), { scaleX: 0 }, { scaleX: 0, duration: 0.01 }, 0);
      tl.fromTo(q('[data-r="stamp"]'), { autoAlpha: 0 }, { autoAlpha: 0, duration: 0.01 }, 0);
      tl.fromTo(q('[data-r="strike"]'), { scaleX: 0 }, { scaleX: 0, duration: 0.01 }, 0);
      tl.fromTo(q('[data-r="qborder"]'), { opacity: 0 }, { opacity: 0, duration: 0.01 }, 0);
      tl.fromTo(q('[data-r="qzone-body"]'), { autoAlpha: 0 }, { autoAlpha: 0, duration: 0.01 }, 0);
      let t = a1 + 0.55 + ordered.length * 0.3 + 0.55;
      const docTimes = new Map<string, number>();
      for (const card of cards) {
        const bars = card.querySelectorAll('[data-r="bar"]');
        docTimes.set((card as HTMLElement).dataset.name || '', t);
        if (bars.length) {
          tl.fromTo(
            bars,
            { scaleX: 0 },
            { scaleX: 1, duration: 0.42, ease: 'power3.out', stagger: 0.14, immediateRender: false },
            t
          );
        }
        tl.fromTo(
          card.querySelector('[data-r="stamp"]'),
          { autoAlpha: 0, y: 4 },
          { autoAlpha: 1, y: 0, duration: 0.5, immediateRender: false },
          t + 0.2 + bars.length * 0.14
        );
        t += 0.75 + bars.length * 0.14;
      }
      for (const qc of qcards) {
        docTimes.set((qc as HTMLElement).dataset.name || '', t);
        tl.fromTo(
          qc.querySelectorAll('[data-r="strike"]'),
          { scaleX: 0 },
          { scaleX: 1, duration: 0.4, ease: 'power2.out', stagger: 0.1, immediateRender: false },
          t
        );
        tl.fromTo(qc.querySelector('[data-r="qborder"]'), { opacity: 0 }, { opacity: 1, duration: 0.3, immediateRender: false }, t);
        tl.fromTo(
          qc.querySelector('[data-r="stamp"]'),
          { autoAlpha: 0 },
          { autoAlpha: 1, duration: 0.4, immediateRender: false },
          t + 0.2
        );
        const off = offsets.get(qc) ?? { x: 0, y: 0 };
        tl.fromTo(
          qc,
          { x: off.x, y: off.y },
          { x: 0, y: 0, duration: 1.1, ease: 'expo.inOut', immediateRender: false },
          t + 0.9
        );
        t += 1.9;
      }
      if (qcards.length) {
        tl.fromTo(
          q('[data-r="qzone-body"]'),
          { autoAlpha: 0, y: 6 },
          { autoAlpha: 1, y: 0, duration: 0.6, immediateRender: false },
          t - 0.6
        );
      }
      // Entrées du registre de l'acte 1, calées sur la pièce concernée.
      let fallback = a1 + 0.55 + ordered.length * 0.3;
      for (const idx of model.runByAct[0]) {
        const e = model.chain[idx];
        const file = detailFile(e);
        if (e.action === 'RUN_START') cues.push({ t: a1 + 0.2, idx });
        else if (file && docTimes.has(file)) cues.push({ t: docTimes.get(file)!, idx });
        else {
          cues.push({ t: Math.min(fallback, t), idx });
          fallback += 0.3;
        }
      }
      t += 0.9;
      sceneOut(0, t);

      /* ── Acte 2 : sondes ── */
      const a2 = t + 0.35;
      sceneIn(1, a2);
      const rows = q('[data-r="resrow"]');
      tl.fromTo(rows, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.5, stagger: 0.05 }, a2 + 0.25);
      const scan = q('[data-r="scan"]')[0];
      const list = q('[data-r="reslist"]')[0] as HTMLElement | undefined;
      const per = rows.length > 5 ? 0.6 : 0.8;
      const sweepStart = a2 + 0.7;
      const sweep = Math.max(1.6, rows.length * per);
      const listH = list ? list.getBoundingClientRect().height : 300;
      if (scan) {
        tl.fromTo(scan, { y: 0, autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2, ease: 'none' }, sweepStart - 0.2);
        tl.fromTo(scan, { y: 0 }, { y: listH, duration: sweep, ease: 'none', immediateRender: false }, sweepStart);
        tl.to(scan, { autoAlpha: 0, duration: 0.3, ease: 'none' }, sweepStart + sweep);
      }
      rows.forEach((row, i) => {
        const at = sweepStart + ((i + 0.55) / Math.max(1, rows.length)) * sweep;
        tl.fromTo(
          row.querySelector('[data-r="res"]'),
          { opacity: 0.42 },
          { opacity: 1, duration: 0.3, ease: 'power2.out' },
          at
        );
        tl.fromTo(
          row.querySelector('[data-r="read"]'),
          { autoAlpha: 0, x: -4 },
          { autoAlpha: 1, x: 0, duration: 0.45 },
          at
        );
      });
      model.runByAct[1].forEach((idx, i, arr) => {
        cues.push({ t: sweepStart + ((i + 0.5) / arr.length) * sweep, idx });
      });
      t = sweepStart + sweep + 1.1;
      sceneOut(1, t);

      /* ── Acte 3 : confrontation ── */
      const a3 = t + 0.35;
      sceneIn(2, a3);
      tl.fromTo(q('[data-r="fhead"]'), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5 }, a3 + 0.2);
      tl.fromTo(q('[data-r="numwrap"]'), { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.7 }, a3 + 0.3);
      const frows = q('[data-r="frow"]');
      let ft = a3 + 0.7;
      frows.forEach((row) => {
        tl.fromTo(row, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.6 }, ft);
        tl.fromTo(
          row.querySelectorAll('[data-r="seg"]'),
          { scaleX: 0 },
          { scaleX: 1, duration: 0.5, ease: 'power3.out', stagger: 0.08 },
          ft + 0.1
        );
        const hot = row.querySelectorAll('[data-r="segr"]');
        const label = row.querySelector('[data-r="rlabel"]');
        if (hot.length && label) {
          const at = ft + 0.55;
          tl.fromTo(hot, { opacity: 0 }, { opacity: 1, duration: 0.25, ease: 'power2.out' }, at);
          tl.fromTo(label, { autoAlpha: 0, x: -6 }, { autoAlpha: 1, x: 0, duration: 0.5 }, at);
          if (numRef.current) {
            tl.fromTo(
              numRef.current,
              { yPercent: -16, opacity: 0.3 },
              { yPercent: 0, opacity: 1, duration: 0.55, immediateRender: false },
              at
            );
          }
          ruptureCues.push(at);
        } else if (label) {
          tl.fromTo(label, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.4 }, ft + 0.5);
        }
        ft += 1.05;
      });
      const act3 = model.runByAct[2];
      act3.forEach((idx, i) => {
        const e = model.chain[idx];
        if (i === 0 && e.action.startsWith('SYNTHESIS_READY')) cues.push({ t: a3 + 0.4, idx });
        else cues.push({ t: ft - 0.4 + (i / Math.max(1, act3.length)) * 0.8, idx });
      });
      tl.fromTo(q('[data-r="fmore"]'), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.4 }, ft - 0.3);
      t = ft + 1.2;
      sceneOut(2, t);

      /* ── Acte 4 : scellement ── */
      const a4 = t + 0.35;
      sceneIn(3, a4);
      const linkEls = q('[data-r="link"]');
      const step = Math.min(0.42, 5.2 / Math.max(1, linkEls.length));
      let lt = a4 + 0.55;
      linkEls.forEach((el) => {
        const joint = el.querySelector('[data-r="joint"]');
        tl.fromTo(el, { x: 22, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: 0.5 }, lt);
        if (joint) tl.fromTo(joint, { scaleX: 0 }, { scaleX: 1, duration: 0.3, ease: 'power2.out' }, lt + 0.12);
        const idx = Number((el as HTMLElement).dataset.idx);
        if (Number.isFinite(idx) && idx >= 0) cues.push({ t: lt + 0.1, idx });
        lt += step;
      });
      const hashEl = q('[data-r="hash"]')[0];
      tl.fromTo(q('[data-r="hlabel"]'), { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.6 }, lt + 0.2);
      if (hashEl) {
        tl.fromTo(
          hashEl,
          { clipPath: 'inset(0% 100% 0% 0%)' },
          { clipPath: 'inset(0% 0% 0% 0%)', duration: 1.5, ease: 'power2.out' },
          lt + 0.35
        );
      }
      tl.fromTo(q('[data-r="hstatus"]'), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5 }, lt + 1.6);
      tl.to({}, { duration: 1.2 }, lt + 1.9);

      cues.sort((x, y) => x.t - y.t || x.idx - y.idx);
      cuesRef.current = cues;
      ruptureCuesRef.current = ruptureCues;
      actStartsRef.current = [a1, a2, a3, a4];
      setActStarts([a1, a2, a3, a4]);
      setDuration(tl.duration());
      tl.timeScale(speedRef.current);
      tlRef.current = tl;

      const saved = progressRef.current;
      if (saved !== null) {
        tl.progress(saved);
        if (playingRef.current && saved < 1) tl.play();
      } else if (reduced) {
        tl.progress(1);
        playingRef.current = false;
        setPlaying(false);
      } else {
        tl.progress(0);
        tl.play();
        playingRef.current = true;
        setPlaying(true);
      }
      sync();

      return () => {
        tlRef.current = null;
      };
    },
    { scope: rootRef, dependencies: [model, layoutKey], revertOnUpdate: true }
  );

  useEffect(() => {
    speedRef.current = speed;
    tlRef.current?.timeScale(speed);
  }, [speed]);

  /* Annonces lecteur d'écran : l'acte à chaque changement, le bloc seulement au pas-à-pas. */
  useEffect(() => {
    if (!model) return;
    setLive(`Acte ${act + 1} sur 4 : ${ACTS[act].name}.`);
  }, [act, model]);

  const announceBlock = useCallback(() => {
    if (!model) return;
    if (announceTimer.current) window.clearTimeout(announceTimer.current);
    announceTimer.current = window.setTimeout(() => {
      const idx = blockRef.current;
      const e = idx >= 0 ? model.chain[idx] : null;
      setLive(
        e
          ? `${ACTS[actRef.current].name}. Bloc ${idx + 1} sur ${model.chain.length} : ${actionLabel(e.action)}, ${e.agent}, ${formatTs(e.ts)}.`
          : `${ACTS[actRef.current].name}. Aucun bloc encore rejoué.`
      );
    }, 380);
  }, [model]);

  const togglePlay = useCallback(() => {
    const tl = tlRef.current;
    if (!tl) return;
    if (tl.progress() >= 0.999) {
      tl.restart();
      playingRef.current = true;
      setPlaying(true);
    } else if (tl.paused() || !tl.isActive()) {
      tl.play();
      playingRef.current = true;
      setPlaying(true);
    } else {
      tl.pause();
      playingRef.current = false;
      setPlaying(false);
    }
  }, []);

  const seekTime = useCallback((time: number) => {
    const tl = tlRef.current;
    if (!tl) return;
    const tt = Math.max(0, Math.min(tl.duration(), time));
    tl.time(tt);
    if (tt >= tl.duration()) {
      tl.pause();
      playingRef.current = false;
      setPlaying(false);
    }
  }, []);

  const onTrackKey = (e: React.KeyboardEvent) => {
    const tl = tlRef.current;
    if (!tl) return;
    const now = tl.time();
    const cueTimes = [...new Set(cuesRef.current.map((c) => +c.t.toFixed(3)))];
    const starts = actStartsRef.current;
    let handled = true;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp': {
        const next = e.shiftKey ? now + 5 : cueTimes.find((c) => c > now + 0.01) ?? tl.duration();
        seekTime(next);
        break;
      }
      case 'ArrowLeft':
      case 'ArrowDown': {
        const prev = e.shiftKey
          ? now - 5
          : [...cueTimes].reverse().find((c) => c < now - 0.01) ?? 0;
        seekTime(prev);
        break;
      }
      case 'PageDown': {
        seekTime(starts.find((s) => s > now + 0.01) ?? tl.duration());
        break;
      }
      case 'PageUp': {
        seekTime([...starts].reverse().find((s) => s < now - 0.3) ?? 0);
        break;
      }
      case 'Home':
        seekTime(0);
        break;
      case 'End':
        seekTime(tl.duration());
        break;
      case ' ':
      case 'Enter':
        togglePlay();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      if (e.key !== ' ' && e.key !== 'Enter') announceBlock();
    }
  };

  /* Scrub à la souris / au doigt. */
  const dragRef = useRef<{ wasPlaying: boolean } | null>(null);
  const seekFromPointer = (clientX: number) => {
    const track = trackRef.current;
    const tl = tlRef.current;
    if (!track || !tl) return;
    const r = track.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    tl.progress(p);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    const tl = tlRef.current;
    if (!tl || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { wasPlaying: !tl.paused() && tl.isActive() };
    tl.pause();
    seekFromPointer(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragRef.current) seekFromPointer(e.clientX);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const tl = tlRef.current;
    if (!drag || !tl) return;
    if (drag.wasPlaying && tl.progress() < 1) tl.play();
    else {
      playingRef.current = false;
      setPlaying(false);
    }
    announceBlock();
  };

  /* Clavier global de la modale : Échap, piège du focus, espace. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null || el === document.activeElement
        );
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (!active || !root.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (e.key === ' ') {
        const target = e.target as HTMLElement | null;
        if (target && target.closest('button, [role="slider"], input, textarea')) return;
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, togglePlay]);

  const current = model && block >= 0 ? model.chain[block] : null;
  const total = model?.chain.length ?? 0;
  const ended = duration > 0 && !playing && (progressRef.current ?? 0) >= 0.999;

  const qDocs = model?.docs.filter((d) => d.quarantined) ?? [];
  const cleanDocs = model?.docs.filter((d) => !d.quarantined) ?? [];
  const toolCalls = model?.runByAct[1].length ?? 0;

  const ui = (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="replay-title"
      aria-describedby="replay-desc"
      data-lenis-prevent
      className="fixed inset-0 z-[70] flex flex-col bg-[var(--bg-canvas)] text-main"
    >
      <header className="flex items-start justify-between gap-4 px-4 sm:px-8 lg:px-12 py-4 border-b border-hairline">
        <div className="min-w-0">
          <h2 id="replay-title" className="text-lg sm:text-xl font-semibold tracking-[-0.02em] text-main">
            Rejouer l’audit
          </h2>
          <p id="replay-desc" className="mt-0.5 text-[13px] text-sub">
            {synthesis.client || 'Centre Hospitalier de Valmont'} · phase {mode === 'APRES' ? 'APRÈS' : 'AVANT'} ·
            montage tiré du registre SHA-256{total ? ` (${total} bloc${total > 1 ? 's' : ''})` : ''}
          </p>
        </div>
        <button
          ref={closeBtnRef}
          type="button"
          onClick={onClose}
          aria-label="Fermer le replay (Échap)"
          className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg border border-hairline hover:border-strong text-sub hover:text-main transition cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <div ref={stageRef} className="relative flex-1 min-h-0 overflow-hidden">
        {load.kind === 'loading' && (
          <p className="absolute inset-0 grid place-items-center text-sm text-sub">Lecture du registre…</p>
        )}
        {load.kind === 'empty' && (
          <div className="absolute inset-0 grid place-items-center px-6">
            <p className="max-w-md text-center text-sm text-sub">
              Le registre de cette session est vide : lancez ou rechargez un audit pour pouvoir le rejouer.
            </p>
          </div>
        )}
        {model && (
          <>
            {/* Acte 1 — Réception */}
            <section data-r="scene" aria-hidden={act !== 0} className="absolute inset-0 overflow-y-auto px-4 sm:px-8 lg:px-12 py-6 lg:py-9">
              <div className="mx-auto max-w-[1280px] xl:[zoom:1.25]">
                <SceneHead i={0} />
                <div className="mt-8 flex flex-col lg:flex-row gap-8 lg:gap-12">
                  <div className="flex-1 min-w-0 flex flex-wrap gap-4 sm:gap-5 content-start">
                    {cleanDocs.map((d, i) => (
                      <DocCard key={d.name} doc={d} k={i} />
                    ))}
                    {qDocs.map((d, i) => (
                      <DocCard key={`slot-${d.name}`} doc={d} k={100 + i} asSlot />
                    ))}
                  </div>
                  {qDocs.length > 0 && (
                    <div className="lg:w-[284px] shrink-0 lg:border-l border-t lg:border-t-0 border-hairline pt-5 lg:pt-0 lg:pl-8">
                      <h4 className="text-sm font-semibold text-[var(--rupture)]">Quarantaine</h4>
                      <div className="mt-4 space-y-4">
                        {qDocs.map((d, i) => (
                          <DocCard key={d.name} doc={d} k={100 + i} />
                        ))}
                      </div>
                      <p data-r="qzone-body" className="mt-4 text-[12.5px] leading-relaxed text-sub max-w-[244px]">
                        {qDocs[0].reason || 'Pièce écartée avant toute lecture par l’IA.'} La pièce n’atteint pas le
                        modèle.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* Acte 2 — Sondes */}
            <section data-r="scene" aria-hidden={act !== 1} className="absolute inset-0 overflow-y-auto px-4 sm:px-8 lg:px-12 py-6 lg:py-9">
              <div className="mx-auto max-w-[1280px] xl:[zoom:1.25]">
                <SceneHead i={1} />
                <div className="mt-8 max-w-[920px]">
                  <div className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_140px_96px] gap-4 pb-2 border-b border-strong text-[12px] text-sub">
                    <span>Ressource GCP</span>
                    <span className="hidden sm:block">Constats liés</span>
                    <span>Relevé</span>
                  </div>
                  <div data-r="reslist" className="relative">
                    {model.resources.map((r) => (
                      <div
                        key={r.name}
                        data-r="resrow"
                        className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_140px_96px] gap-4 items-center py-3 border-b border-hairline"
                      >
                        <span data-r="res" className="font-mono text-[12.5px] text-main truncate" title={r.name}>
                          {r.name}
                        </span>
                        <span className="hidden sm:block font-mono text-[11.5px] text-muted">{r.findingIds.join(' ')}</span>
                        <span data-r="read" className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--accent-text)]">
                          <Check className="w-3.5 h-3.5" aria-hidden="true" />
                          Lu
                        </span>
                      </div>
                    ))}
                    <div data-r="scan" aria-hidden="true" className="pointer-events-none absolute left-0 right-0 top-0 h-0">
                      <div className="absolute left-0 right-0 bottom-0 h-12 bg-gradient-to-t from-[var(--reel-soft)] to-transparent" />
                      <div className="absolute left-0 right-0 -top-px h-[1.5px] bg-[var(--reel)]" />
                    </div>
                  </div>
                  <p className="mt-4 text-[12.5px] text-sub">
                    {model.resources.length} ressource{model.resources.length > 1 ? 's' : ''} relevée
                    {model.resources.length > 1 ? 's' : ''} · aucune écriture
                    {toolCalls > 0 ? ` · ${toolCalls} appel${toolCalls > 1 ? 's' : ''} consigné${toolCalls > 1 ? 's' : ''} au registre` : ''}
                  </p>
                </div>
              </div>
            </section>

            {/* Acte 3 — Confrontation */}
            <section data-r="scene" aria-hidden={act !== 2} className="absolute inset-0 overflow-y-auto px-4 sm:px-8 lg:px-12 py-6 lg:py-9">
              <div className="mx-auto max-w-[1280px] xl:[zoom:1.25]">
                <SceneHead i={2} />
                <div className="mt-8 flex flex-col-reverse lg:flex-row gap-8 lg:gap-16">
                  <div className="flex-1 min-w-0 max-w-[880px]">
                    <div
                      data-r="fhead"
                      className="grid grid-cols-[56px_1fr_132px] sm:grid-cols-[64px_1fr_204px_132px] gap-4 pb-2 border-b border-strong text-[12px] text-sub"
                    >
                      <span>Constat</span>
                      <span>Thème</span>
                      <span className="hidden sm:grid grid-cols-3 gap-1.5">
                        {PILLARS.map((p) => (
                          <span key={p.key} style={{ color: p.color }} className="font-semibold">
                            {p.label}
                          </span>
                        ))}
                      </span>
                      <span>Rupture</span>
                    </div>
                    {model.findings.map((f) => {
                      const hot = involved(f.contradiction);
                      return (
                        <div
                          key={f.id}
                          data-r="frow"
                          className="grid grid-cols-[56px_1fr_132px] sm:grid-cols-[64px_1fr_204px_132px] gap-4 items-center py-3 border-b border-hairline"
                        >
                          <span className="font-mono text-[12px] text-sub">{f.id}</span>
                          <span className="text-[13.5px] text-main truncate">{f.theme}</span>
                          <span className="hidden sm:grid grid-cols-3 gap-1.5" aria-hidden="true">
                            {PILLARS.map((p) => {
                              const present = f[p.key];
                              return (
                                <span key={p.key} className="relative h-2">
                                  <span
                                    data-r="seg"
                                    className={`absolute inset-0 rounded-full origin-left ${present ? '' : 'border border-dashed border-strong'}`}
                                    style={present ? { background: p.color, opacity: 0.85 } : undefined}
                                  />
                                  {hot.has(p.key) && (
                                    <span data-r="segr" className="absolute -inset-y-[3px] inset-x-0 rounded-full bg-[var(--rupture)]" />
                                  )}
                                </span>
                              );
                            })}
                          </span>
                          <span
                            data-r="rlabel"
                            className={`text-[12.5px] font-semibold ${f.contradiction ? 'text-[var(--rupture)]' : 'text-[var(--accent-text)]'}`}
                          >
                            {f.contradiction || 'Concordant'}
                          </span>
                        </div>
                      );
                    })}
                    {model.hiddenFindings > 0 && (
                      <p data-r="fmore" className="mt-3 text-[12.5px] text-sub">
                        et {model.hiddenFindings} autre{model.hiddenFindings > 1 ? 's' : ''} constat
                        {model.hiddenFindings > 1 ? 's' : ''} au dossier
                      </p>
                    )}
                  </div>
                  <div data-r="numwrap" className="lg:w-[260px] shrink-0 lg:pt-6">
                    <span className="block overflow-hidden">
                      <span
                        ref={numRef}
                        aria-hidden="true"
                        className="block text-[4.5rem] sm:text-[7.5rem] leading-[0.86] font-semibold tracking-[-0.05em] text-[var(--rupture)] tabular-nums"
                      >
                        0
                      </span>
                    </span>
                    <p className="mt-3 text-sm text-sub">
                      rupture{model.ruptures > 1 ? 's' : ''} sur {model.totalFindings} constat
                      {model.totalFindings > 1 ? 's' : ''}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            {/* Acte 4 — Scellement */}
            <section data-r="scene" aria-hidden={act !== 3} className="absolute inset-0 overflow-y-auto px-4 sm:px-8 lg:px-12 py-6 lg:py-9">
              <div className="mx-auto max-w-[1280px] xl:[zoom:1.25]">
                <SceneHead i={3} />
                <ol className="mt-10 flex flex-wrap items-center gap-y-5" aria-label="Maillons du registre">
                  {links.map((l, i) =>
                    'gap' in l ? (
                      <li key={`gap-${i}`} data-r="link" data-idx="-1" className="flex items-center">
                        <span className="px-3 text-[12px] text-sub tabular-nums">… {l.gap} blocs …</span>
                        <span data-r="joint" aria-hidden="true" className="w-5 h-[1.5px] bg-[var(--border-strong)] origin-left" />
                      </li>
                    ) : (
                      <li key={l.idx} data-r="link" data-idx={l.idx} className="flex items-center">
                        <span
                          className={`inline-flex flex-col justify-center h-[54px] w-[104px] px-4 rounded-full border-[1.5px] ${
                            l.idx === total - 1
                              ? 'border-[var(--accent-text)]'
                              : l.idx === block
                                ? 'border-[var(--text-primary)]'
                                : 'border-strong'
                          } bg-[var(--bg-elevated)]`}
                        >
                          <span className="text-[10.5px] text-muted tabular-nums">bloc {l.idx + 1}</span>
                          <span className="font-mono text-[12px] text-main">{model.chain[l.idx].hash.slice(0, 6)}</span>
                        </span>
                        {i < links.length - 1 && (
                          <span data-r="joint" aria-hidden="true" className="w-5 h-[1.5px] bg-[var(--reel)] origin-left" />
                        )}
                      </li>
                    )
                  )}
                </ol>
                <div className="mt-12 max-w-[920px]">
                  <p data-r="hlabel" className="text-sm text-sub">
                    Empreinte de tête du registre
                  </p>
                  <p data-r="hash" className="mt-2 font-mono text-[15px] sm:text-[1.3rem] leading-snug text-main break-all">
                    {model.headHash}
                  </p>
                  <p
                    data-r="hstatus"
                    className={`mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold ${
                      chainValid ? 'text-[var(--accent-text)]' : 'text-[var(--rupture)]'
                    }`}
                  >
                    {chainValid ? <Check className="w-4 h-4" aria-hidden="true" /> : <ShieldAlert className="w-4 h-4" aria-hidden="true" />}
                    {chainValid
                      ? `Chaîne vérifiée par le serveur · ${total} bloc${total > 1 ? 's' : ''} liés`
                      : 'Le serveur signale une rupture dans la chaîne'}
                  </p>
                </div>
              </div>
            </section>
          </>
        )}
      </div>

      {/* Barre de lecture façon montage */}
      <footer className="border-t border-hairline px-4 sm:px-8 lg:px-12 pt-3 pb-4 bg-[var(--bg-surface)]">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12.5px] min-h-[20px]">
          <span className="font-semibold text-main tabular-nums">
            {model ? (block >= 0 ? `Bloc ${block + 1} / ${total}` : `Bloc — / ${total}`) : 'Bloc —'}
          </span>
          {current && (
            <>
              <span className="text-main">{actionLabel(current.action)}</span>
              <span className="text-sub">{current.agent}</span>
              <span className="text-sub tabular-nums">{formatTs(current.ts)}</span>
              <span className="font-mono text-[11.5px] text-muted">{current.hash.slice(0, 12)}</span>
            </>
          )}
        </div>
        <div className="mt-2 flex items-center gap-3 sm:gap-4">
          <button
            ref={playBtnRef}
            type="button"
            onClick={togglePlay}
            disabled={!model}
            aria-label={ended ? 'Rejouer depuis le début' : playing ? 'Mettre en pause' : 'Lire'}
            className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full bg-[var(--text-primary)] text-[var(--bg-canvas)] hover:opacity-90 disabled:opacity-40 transition cursor-pointer"
          >
            {ended ? (
              <RotateCcw className="w-4 h-4" />
            ) : playing ? (
              <Pause className="w-4 h-4" />
            ) : (
              <Play className="w-4 h-4 translate-x-[1px]" />
            )}
          </button>
          <div className="relative flex-1 min-w-0 h-12">
            <div
              ref={trackRef}
              role="slider"
              tabIndex={model ? 0 : -1}
              aria-label="Position dans le replay"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={0}
              aria-valuetext={`${ACTS[act].name}, ${block >= 0 ? `bloc ${block + 1} sur ${total}` : 'aucun bloc'}`}
              aria-keyshortcuts="ArrowLeft ArrowRight PageUp PageDown Home End Space"
              onKeyDown={onTrackKey}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              className="absolute inset-x-0 top-0 h-6 cursor-pointer touch-none rounded-sm"
            >
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[3px] rounded-full bg-[var(--bg-subtle)]" />
              <div
                ref={fillRef}
                className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[3px] rounded-full bg-[var(--text-primary)] origin-left"
                style={{ transform: 'scaleX(0)' }}
              />
              {duration > 0 &&
                actStarts.slice(1).map((s, i) => (
                  <span
                    key={i}
                    aria-hidden="true"
                    className="absolute top-1/2 -translate-y-1/2 w-px h-3 bg-[var(--border-strong)]"
                    style={{ left: `${(s / duration) * 100}%` }}
                  />
                ))}
              <div
                ref={thumbRef}
                aria-hidden="true"
                className="absolute top-1/2 w-3.5 h-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--text-primary)] ring-2 ring-[var(--bg-surface)]"
                style={{ left: '0%' }}
              />
            </div>
            {duration > 0 &&
              ACTS.map((a, i) => (
                <button
                  key={a.name}
                  type="button"
                  onClick={() => {
                    seekTime(actStarts[i] + 0.01);
                    announceBlock();
                  }}
                  aria-label={`Aller à l’acte ${i + 1} : ${a.name}`}
                  className={`absolute top-6 h-6 -ml-1 px-1 text-[11.5px] rounded transition cursor-pointer whitespace-nowrap ${
                    act === i ? 'text-main font-semibold' : 'text-muted hover:text-main'
                  } ${i > 0 && i < 3 ? 'max-sm:hidden' : ''}`}
                  style={{ left: `${(actStarts[i] / duration) * 100}%` }}
                >
                  {a.name}
                </button>
              ))}
          </div>
          <span className="shrink-0 text-[12px] text-sub tabular-nums">
            <span ref={clockRef}>00:00</span> / {formatClock(duration)}
          </span>
          <div className="shrink-0 hidden sm:flex p-0.5 rounded-lg bg-[var(--bg-subtle)]" role="group" aria-label="Vitesse de lecture">
            {([1, 2] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={speed === s}
                onClick={() => setSpeed(s)}
                className={`h-7 px-2.5 rounded-md text-[12px] font-semibold tabular-nums transition cursor-pointer ${
                  speed === s ? 'bg-[var(--bg-elevated)] text-main shadow-[var(--shadow-panel)]' : 'text-sub hover:text-main'
                }`}
              >
                x{s}
              </button>
            ))}
          </div>
        </div>
      </footer>

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {live}
      </div>
    </div>
  );

  return createPortal(ui, document.body);
};

const SceneHead: React.FC<{ i: number }> = ({ i }) => (
  <div data-r="head" className="max-w-[720px]">
    <h3 className="text-[1.75rem] sm:text-[2.6rem] leading-[1.08] font-semibold tracking-[-0.028em] text-main">
      {ACTS[i].name}
    </h3>
    <p className="mt-2 text-[14px] text-sub">
      {ACTS[i].caption} <span className="text-muted">· {ACTS[i].agent}</span>
    </p>
  </div>
);

export default AuditReplay;
