import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import type { AuditMode, Finding, ThemeMode } from '../../types';
import { gsap, prefersReducedMotion } from '../../motion/gsap';
import { createGeologyScene, type GeologySceneApi } from './scene';
import { contradictionLayers, hasEvidence, LAYER_CAPTION, LAYER_LABEL, type LayerKey } from './model';

interface GeologyCoreProps {
  findings: Finding[];
  mode: AuditMode;
  theme: ThemeMode;
  onInspectFinding: (finding: Finding) => void;
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

const STATUT_LABEL: Record<Finding['statut'], string> = {
  conforme: 'Conforme',
  partiel: 'Partiel',
  non_conforme: 'Non conforme',
  a_confirmer: 'À confirmer',
};

const GRAVITE_LABEL: Record<Finding['gravite'], string> = {
  critique: 'critique',
  haute: 'haute',
  moyenne: 'moyenne',
  faible: 'faible',
};

const PILLAR_VAR: Record<LayerKey, string> = {
  dit: 'var(--dit)',
  ecrit: 'var(--ecrit)',
  reel: 'var(--reel)',
};

function describe(f: Finding): string {
  const pair = contradictionLayers(f.contradiction);
  const missing = (['dit', 'ecrit', 'reel'] as LayerKey[]).filter((k) => !hasEvidence(f, k));
  const parts = [pair.length ? `faille ${f.contradiction}` : 'couches continues'];
  if (missing.length) parts.push(`lacune ${missing.map((k) => LAYER_LABEL[k]).join(', ')}`);
  return parts.join(' · ');
}

const Swatch: React.FC<{ color: string; hatch?: boolean }> = ({ color, hatch }) => (
  <span
    aria-hidden="true"
    className="inline-block w-4 h-2.5 rounded-[2px] border border-[var(--border-strong)]"
    style={
      hatch
        ? {
            backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 1px, transparent 1px 4px)`,
          }
        : { background: `color-mix(in oklab, ${color} 30%, var(--bg-surface))` }
    }
  />
);

const EvidenceRow: React.FC<{ layer: LayerKey; finding: Finding }> = ({ layer, finding }) => {
  let source = '';
  let text = '';
  if (layer === 'dit' && finding.dit) {
    source = finding.dit.source;
    text = finding.dit.extrait;
  } else if (layer === 'ecrit' && finding.ecrit) {
    source = [finding.ecrit.source, finding.ecrit.section].filter(Boolean).join(' · ');
    text = finding.ecrit.extrait;
  } else if (layer === 'reel' && finding.reel) {
    source = finding.reel.ressource;
    text = finding.reel.constat;
  }
  const pair = contradictionLayers(finding.contradiction);
  const broken = pair.includes(layer);
  return (
    <div className="py-2.5 border-t border-hairline first:border-t-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-bold" style={{ color: PILLAR_VAR[layer] }}>
          {LAYER_LABEL[layer]}
          <span className="font-medium text-dim"> · {LAYER_CAPTION[layer]}</span>
        </span>
        {broken && (
          <span className="text-[11px] font-semibold text-[var(--rupture)]">en faille</span>
        )}
      </div>
      {text ? (
        <>
          <p className="mt-1 text-[13px] leading-snug text-main line-clamp-4">« {text} »</p>
          {source && (
            <p
              className={`mt-1 text-[11px] text-dim truncate ${layer === 'reel' ? 'font-mono' : ''}`}
              title={source}
            >
              {source}
            </p>
          )}
        </>
      ) : (
        <p className="mt-1 text-[13px] text-dim italic">Strate lacunaire : aucune preuve recueillie.</p>
      )}
    </div>
  );
};

const GeologyCore: React.FC<GeologyCoreProps> = ({ findings, mode, theme, onInspectFinding }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef(new Map<string, HTMLSpanElement>());
  const apiRef = useRef<GeologySceneApi | null>(null);
  const [glOk] = useState(() => (typeof document !== 'undefined' ? webglAvailable() : false));
  const [failed, setFailed] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelSide, setPanelSide] = useState<'left' | 'right'>('right');
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const hoverRef = useRef<string | null>(null);
  hoverRef.current = hoverId;
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const byId = useMemo(() => new Map(findings.map((f) => [f.id, f])), [findings]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const hovered = hoverId ? byId.get(hoverId) ?? null : null;
  const findingsKey = findings.map((f) => `${f.id}:${f.contradiction}:${f.gravite}`).join('|') + mode;

  const placeOverlays = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    labelRefs.current.forEach((el, id) => {
      const p = api.project(id, 'tip');
      if (p) el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
    });
    const tip = tooltipRef.current;
    const hid = hoverRef.current;
    if (tip && hid) {
      const p = api.project(hid, 'tip');
      if (p) tip.style.transform = `translate(${p.x}px, ${p.y - 26}px) translate(-50%, -100%)`;
    }
  }, []);

  const openPanel = useCallback(
    (id: string) => {
      const api = apiRef.current;
      const stage = stageRef.current;
      if (api && stage) {
        const p = api.project(id, 'core');
        setPanelSide(p && p.x > stage.clientWidth * 0.55 ? 'left' : 'right');
      }
      setSelectedId(id);
    },
    []
  );

  const select = useCallback(
    (id: string | null) => {
      const api = apiRef.current;
      if (!id || id === selectedRef.current) {
        api?.retract();
        setSelectedId(null);
        return;
      }
      if (api) {
        setSelectedId(null);
        api.extract(id, () => openPanel(id));
      } else {
        setSelectedId(id);
      }
    },
    [openPanel]
  );

  const selectRef = useRef(select);
  selectRef.current = select;

  // Scène (reconstruite quand l'ensemble des constats change).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !glOk) return;
    let api: GeologySceneApi | null = null;
    try {
      api = createGeologyScene(stage, {
        findings,
        reducedMotion: reduced,
        onHover: (id) => setHoverId(id),
        onPick: (id) => {
          if (!id) {
            api?.retract();
            setSelectedId(null);
          } else selectRef.current(id);
        },
        onFrame: () => placeOverlays(),
      });
    } catch {
      setFailed(true);
      return;
    }
    apiRef.current = api;
    return () => {
      apiRef.current = null;
      api?.dispose();
      setSelectedId(null);
      setHoverId(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findingsKey, glOk, reduced]);

  useEffect(() => {
    apiRef.current?.setTheme();
  }, [theme]);

  useEffect(() => {
    apiRef.current?.setHover(hoverId);
    placeOverlays();
  }, [hoverId, placeOverlays]);

  // Ouverture latérale du panneau (instantanée en mouvement réduit).
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el || !selected) return;
    if (reduced) return;
    const from = panelSide === 'right' ? 'inset(0 100% 0 0)' : 'inset(0 0 0 100%)';
    const tw = gsap.fromTo(
      el,
      { clipPath: from, x: panelSide === 'right' ? -12 : 12 },
      { clipPath: 'inset(0 0% 0 0%)', x: 0, duration: 0.42, ease: 'expo.out', clearProps: 'clipPath,transform' }
    );
    return () => {
      tw.kill();
    };
  }, [selected, panelSide, reduced]);

  // Échap / clic hors de la planche : la carotte redescend.
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') select(null);
    };
    const onDoc = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) select(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDoc);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDoc);
    };
  }, [selectedId, select]);

  const useGl = glOk && !failed;
  const faultCount = findings.filter((f) => contradictionLayers(f.contradiction).length).length;

  return (
    <div ref={rootRef} className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-1">
        <h3 className="text-sm font-bold text-main">
          Coupe des constats
          <span className="font-medium text-dim">
            {' '}
            · {findings.length} forages, {faultCount} faille{faultCount > 1 ? 's' : ''} · phase{' '}
            {mode === 'AVANT' ? 'avant' : 'après'}
          </span>
        </h3>
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-sub" aria-label="Légende">
          <li className="inline-flex items-center gap-1.5">
            <Swatch color="var(--dit)" />
            Dit · entretiens
          </li>
          <li className="inline-flex items-center gap-1.5">
            <Swatch color="var(--ecrit)" />
            Écrit · documents
          </li>
          <li className="inline-flex items-center gap-1.5">
            <Swatch color="var(--reel)" />
            Réel · configuration
          </li>
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block w-4 h-0 border-t-2 border-[var(--rupture)]" />
            faille = contradiction
          </li>
          <li className="inline-flex items-center gap-1.5">
            <Swatch color="var(--text-secondary)" hatch />
            lacune = preuve absente
          </li>
        </ul>
      </div>

      <div className="relative">
        {useGl ? (
          <div
            ref={stageRef}
            className="relative h-[300px] sm:h-[440px] lg:h-[500px] rounded-xl overflow-hidden border border-hairline"
            style={{ background: 'var(--bg-canvas)' }}
          >
            <div aria-hidden="true" className="pointer-events-none absolute inset-0">
              {findings.map((f) => (
                <span
                  key={f.id}
                  ref={(el) => {
                    if (el) labelRefs.current.set(f.id, el);
                    else labelRefs.current.delete(f.id);
                  }}
                  className={`absolute left-0 top-0 font-mono text-[10.5px] tabular-nums whitespace-nowrap transition-colors ${
                    f.id === hoverId || f.id === selectedId ? 'text-main font-bold' : 'text-sub'
                  }`}
                >
                  {f.id}
                </span>
              ))}
              {hovered && hovered.id !== selectedId && (
                <div
                  ref={tooltipRef}
                  className="absolute left-0 top-0 max-w-[240px] rounded-md px-2.5 py-1.5 surface-elevated border border-hairline shadow-[0_6px_18px_-8px_rgba(0,0,0,0.35)]"
                >
                  <p className="font-mono text-[10.5px] text-dim">{hovered.id}</p>
                  <p className="text-xs font-semibold text-main leading-snug">{hovered.theme}</p>
                  {hovered.contradiction && (
                    <p className="text-[11px] text-[var(--rupture)] mt-0.5">{hovered.contradiction}</p>
                  )}
                </div>
              )}
            </div>
            <p className="pointer-events-none absolute left-3 bottom-2 text-[11px] text-dim">
              Glisser pour orienter la coupe · cliquer un forage pour extraire la carotte
            </p>
          </div>
        ) : (
          <p className="rounded-xl border border-hairline px-4 py-3 text-xs text-sub">
            Rendu 3D indisponible sur ce poste : la coupe est décrite forage par forage ci-dessous.
          </p>
        )}

        {selected && (
          <div
            ref={panelRef}
            role="dialog"
            aria-label={`Carotte ${selected.id}`}
            className={`mt-3 sm:mt-0 sm:absolute sm:top-3 sm:w-[340px] sm:max-h-[calc(100%-24px)] overflow-auto rounded-xl surface-elevated border border-hairline shadow-[0_14px_36px_-18px_rgba(0,0,0,0.45)] ${
              panelSide === 'right' ? 'sm:right-3' : 'sm:left-3'
            }`}
          >
            <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
              <div className="min-w-0">
                <p className="font-mono text-[11px] text-dim">
                  Carotte {selected.id}
                  {selected.lot_nis2 ? ` · ${selected.lot_nis2}` : ''}
                </p>
                <h4 className="text-sm font-bold text-main leading-snug">{selected.theme}</h4>
                <p className="mt-0.5 text-[11px] text-sub">
                  {STATUT_LABEL[selected.statut]} · gravité {GRAVITE_LABEL[selected.gravite]}
                  {selected.contradiction ? (
                    <span className="text-[var(--rupture)] font-semibold"> · {selected.contradiction}</span>
                  ) : (
                    ' · couches alignées'
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => select(null)}
                aria-label="Redescendre la carotte"
                className="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-lg text-dim hover:text-main hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-4">
              {(['dit', 'ecrit', 'reel'] as LayerKey[]).map((k) => (
                <EvidenceRow key={k} layer={k} finding={selected} />
              ))}
            </div>
            <div className="px-4 pb-4 pt-2">
              <button
                type="button"
                onClick={() => onInspectFinding(selected)}
                className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-[var(--deloitte)] hover:bg-[var(--deloitte-hover)] text-black text-xs font-extrabold transition cursor-pointer"
              >
                Ouvrir le constat
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      <ul className="flex flex-wrap gap-1.5" aria-label="Forages de la coupe">
        {findings.map((f) => {
          const pair = contradictionLayers(f.contradiction).length > 0;
          const active = f.id === selectedId;
          return (
            <li key={f.id}>
              <button
                type="button"
                aria-pressed={active}
                aria-label={`${f.id}, ${f.theme} : ${describe(f)}. ${active ? 'Redescendre' : 'Extraire'} la carotte`}
                onClick={() => select(f.id)}
                onPointerEnter={() => setHoverId(f.id)}
                onPointerLeave={() => setHoverId(null)}
                onFocus={() => setHoverId(f.id)}
                onBlur={() => setHoverId(null)}
                className={`inline-flex items-center gap-2 min-h-[28px] px-2.5 py-1 rounded-lg border text-xs transition cursor-pointer ${
                  active
                    ? 'border-[var(--border-strong)] bg-[var(--bg-subtle)] text-main'
                    : 'border-hairline text-sub hover:text-main hover:bg-[var(--bg-hover)]'
                }`}
              >
                <span className="font-mono text-[11px] tabular-nums">{f.id}</span>
                <span className="max-w-[180px] truncate">{f.theme}</span>
                {pair && (
                  <span aria-hidden="true" className="inline-block w-2.5 h-0 border-t-2 border-[var(--rupture)]" />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {!useGl && (
        <ol className="space-y-1 text-xs text-sub">
          {findings.map((f) => (
            <li key={f.id}>
              <span className="font-mono">{f.id}</span> · {f.theme} : {describe(f)}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};

export default GeologyCore;
