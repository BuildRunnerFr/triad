import type { Finding, GraviteFinding } from '../../types';

/** Indices des strates, de bas en haut (roche-mère en bas). */
export const LAYERS = ['reel', 'ecrit', 'dit'] as const;
export type LayerKey = (typeof LAYERS)[number];

export const LAYER_LABEL: Record<LayerKey, string> = {
  dit: 'Dit',
  ecrit: 'Écrit',
  reel: 'Réel',
};

export const LAYER_CAPTION: Record<LayerKey, string> = {
  dit: 'entretiens',
  ecrit: 'documents',
  reel: 'configuration',
};

/** Épaisseur d'une strate (unités monde). */
export const T = 0.72;
/** Largeur de bloc autour d'un forage. */
export const W = 1.55;
/** Marge non faillée aux deux extrémités du bloc-diagramme. */
export const MARGIN = 0.7;
/** Profondeur du bloc. */
export const D = 2.6;

/** Rejet de faille proportionnel à la gravité. */
const REJET: Record<GraviteFinding, number> = {
  critique: 0.46,
  haute: 0.34,
  moyenne: 0.22,
  faible: 0.14,
};

export function layerBaseBottom(idx: number): number {
  return -1.5 * T + idx * T;
}

/** Strates concernées par la contradiction (« Dit ≠ Écrit », « Écrit ≠ Réel »…). */
export function contradictionLayers(c: string | null): LayerKey[] {
  if (!c) return [];
  const s = c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const out: LayerKey[] = [];
  if (s.includes('dit')) out.push('dit');
  if (s.includes('ecrit')) out.push('ecrit');
  if (s.includes('reel')) out.push('reel');
  return out.length === 2 ? out : [];
}

export function hasEvidence(f: Finding, layer: LayerKey): boolean {
  if (layer === 'dit') return !!f.dit?.extrait;
  if (layer === 'ecrit') return !!f.ecrit?.extrait;
  return !!(f.reel?.constat || f.reel?.ressource);
}

export interface CoreColumn {
  finding: Finding;
  x: number;
  rejet: number;
  /** Décalage vertical de chaque strate (index LAYERS). */
  shifts: [number, number, number];
  present: [boolean, boolean, boolean];
  /** Vides de faille : intervalles [bas, haut] ouverts entre strates décalées. */
  gaps: Array<[number, number]>;
  pair: LayerKey[];
}

export interface CoreLayout {
  length: number;
  x0: number;
  columns: CoreColumn[];
}

export function buildLayout(findings: Finding[]): CoreLayout {
  const n = Math.max(1, findings.length);
  const length = n * W + 2 * MARGIN;
  const x0 = -length / 2;
  const columns = findings.map((finding, i) => {
    const x = x0 + MARGIN + (i + 0.5) * W;
    const pair = contradictionLayers(finding.contradiction);
    const rejet = pair.length ? REJET[finding.gravite] ?? 0.2 : 0;
    const shifts: [number, number, number] = [0, 0, 0];
    if (pair.length) {
      const idx = pair.map((k) => LAYERS.indexOf(k)).sort();
      const lo = idx[0];
      const hi = idx[1];
      for (let l = 0; l < 3; l++) {
        if (l >= hi) shifts[l] = rejet / 2;
        else if (l <= lo) shifts[l] = -rejet / 2;
      }
    }
    const gaps: Array<[number, number]> = [];
    for (let l = 0; l < 2; l++) {
      const top = layerBaseBottom(l) + T + shifts[l];
      const bottom = layerBaseBottom(l + 1) + shifts[l + 1];
      if (bottom - top > 0.001) gaps.push([top, bottom]);
    }
    const present = LAYERS.map((k) => hasEvidence(finding, k)) as [
      boolean,
      boolean,
      boolean,
    ];
    return { finding, x, rejet, shifts, present, gaps, pair };
  });
  return { length, x0, columns };
}
