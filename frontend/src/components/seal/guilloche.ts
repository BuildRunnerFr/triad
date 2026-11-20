/**
 * Géométrie d'un sceau guilloché entièrement déterministe à partir d'une empreinte SHA-256.
 *
 * Les 32 octets de l'empreinte paramètrent trois familles de courbes (bande externe ondulée en
 * passes décalées, bande médiane, rosace hypotrochoïde centrale), leurs phases, leurs épaisseurs
 * et le secteur de fracture utilisé quand la chaîne est altérée. Même empreinte = même sceau.
 *
 * Repère : viewBox 0 0 200 200, centre (100, 100). Budget : < 6 000 points au total.
 */

export const SEAL_VIEWBOX = 200;
const C = SEAL_VIEWBOX / 2;
const TAU = Math.PI * 2;

export type SealCurveFamily = 'outer' | 'mid' | 'inner';

export interface SealCurve {
  family: SealCurveFamily;
  /** Tracé intact (avec une coupure dans le secteur de fracture quand `broken`). */
  d: string;
  /** Portion déplacée/brisée (vide si la chaîne est intègre). */
  fracture: string;
  width: number;
}

export interface SealGeometry {
  curves: SealCurve[];
  pointCount: number;
  /** Angle de départ de la microtypographie (degrés). */
  textRotation: number;
  /** Secteur de fracture [début, fin] en radians. */
  fractureSector: [number, number];
  /** Paramètres lisibles (débogage, preuve de déterminisme). */
  params: {
    outerLobes: number;
    outerPasses: number;
    midLobes: number;
    midPasses: number;
    innerLobes: number;
    innerPasses: number;
  };
}

/** Normalise une empreinte en 32 octets (hex invalide ou trop court : complété de façon stable). */
export function hashToBytes(hash: string): number[] {
  const clean = (hash || '').toLowerCase().replace(/[^0-9a-f]/g, '').padEnd(64, '0').slice(0, 64);
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
  return bytes;
}

const unit = (b: number) => b / 255;

/** Angle normalisé dans [0, 2π). */
const norm = (a: number) => ((a % TAU) + TAU) % TAU;

const inSector = (angle: number, [start, end]: [number, number]) => {
  const a = norm(angle - start);
  return a <= norm(end - start);
};

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

interface Pt {
  x: number;
  y: number;
}

/**
 * Convertit une liste de points (fermée) en tracé SVG. En mode brisé, les points du secteur sont
 * retirés du tracé intact et regroupés, déplacés (rotation + dérive radiale en dents de scie),
 * dans le tracé de fracture.
 */
function toPaths(points: Pt[], broken: boolean, sector: [number, number], shear: number) {
  if (!broken) {
    let d = `M${fmt(points[0].x)} ${fmt(points[0].y)}`;
    for (let i = 1; i < points.length; i++) d += `L${fmt(points[i].x)} ${fmt(points[i].y)}`;
    return { d: `${d}Z`, fracture: '' };
  }
  let d = '';
  let fracture = '';
  let penIntact = false;
  let penFracture = false;
  const rot = 0.07 + shear * 0.05; // ~4 à 7 degrés
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const dx = p.x - C;
    const dy = p.y - C;
    const angle = Math.atan2(dy, dx);
    if (inSector(angle, sector)) {
      penIntact = false;
      const r = Math.hypot(dx, dy);
      // Dérive radiale en dents de scie : la portion semble « glissée » et cassée.
      const local = norm(angle - sector[0]) / Math.max(1e-6, norm(sector[1] - sector[0]));
      const saw = ((local * 5) % 1) - 0.5;
      const r2 = r * (1.035 + shear * 0.03) + saw * 2.2;
      const a2 = angle + rot;
      const x = C + r2 * Math.cos(a2);
      const y = C + r2 * Math.sin(a2);
      fracture += `${penFracture ? 'L' : 'M'}${fmt(x)} ${fmt(y)}`;
      penFracture = true;
    } else {
      penFracture = false;
      d += `${penIntact ? 'L' : 'M'}${fmt(p.x)} ${fmt(p.y)}`;
      penIntact = true;
    }
  }
  return { d, fracture };
}

/**
 * Bande ondulée : r(θ) = base + a·sin(kθ + φ) + a2·sin(mθ + ψ), en `passes` copies déphasées
 * (le déphasage fin entre copies produit le moiré caractéristique des billets).
 */
function waveRing(
  base: number,
  amp: number,
  lobes: number,
  amp2: number,
  harmonic: number,
  phase: number,
  samples: number
): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * TAU;
    const r = base + amp * Math.sin(lobes * t + phase) + amp2 * Math.sin(harmonic * t + phase * 1.7);
    pts.push({ x: C + r * Math.cos(t), y: C + r * Math.sin(t) });
  }
  return pts;
}

/** Hypotrochoïde fermée à `lobes` lobes : R = lobes·r, période 2π. */
function hypotrochoid(outerR: number, lobes: number, dRatio: number, rotation: number, samples: number): Pt[] {
  // (R − r) + d = outerR, avec d = dRatio·r.
  const r = outerR / (lobes - 1 + dRatio);
  const R = lobes * r;
  const d = dRatio * r;
  const k = (R - r) / r;
  const pts: Pt[] = [];
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * TAU;
    const x = (R - r) * Math.cos(t) + d * Math.cos(k * t);
    const y = (R - r) * Math.sin(t) - d * Math.sin(k * t);
    pts.push({ x: C + x * cosR - y * sinR, y: C + x * sinR + y * cosR });
  }
  return pts;
}

export function buildSealGeometry(hash: string, broken: boolean): SealGeometry {
  const b = hashToBytes(hash);

  // Secteur de fracture : 44° à 70°, position dictée par l'empreinte.
  const fStart = unit(b[16]) * TAU;
  const fracture: [number, number] = [fStart, fStart + ((44 + unit(b[17]) * 26) * Math.PI) / 180];
  const shear = unit(b[18]);

  const curves: SealCurve[] = [];
  let pointCount = 0;
  const push = (family: SealCurveFamily, pts: Pt[], width: number) => {
    pointCount += pts.length;
    const { d, fracture: fr } = toPaths(pts, broken, fracture, shear);
    curves.push({ family, d, fracture: fr, width });
  };

  const widthOf = (byte: number) => 0.5 + unit(byte) * 0.3; // 0.5 à 0.8

  // 1) Bande externe : 9 à 24 lobes, 7 à 11 passes.
  const outerLobes = 9 + (b[0] % 16);
  const outerPasses = 7 + (b[1] % 5);
  const outerAmp = 4.5 + unit(b[2]) * 4.5;
  const outerHarm = outerLobes * 2 + (b[3] % 5) - 2;
  const outerAmp2 = unit(b[4]) * 2;
  const outerBase = 70.5;
  // Les passes couvrent 55 à 100 % d'un demi-période à une période de phase : le recouvrement produit le treillis moiré.
  const outerStep = (TAU * (0.5 + unit(b[5]) * 0.5)) / outerPasses;
  const outerPhase0 = unit(b[19]) * TAU;
  const outerW = widthOf(b[12]);
  for (let i = 0; i < outerPasses; i++) {
    push(
      'outer',
      waveRing(outerBase, outerAmp, outerLobes, outerAmp2, outerHarm, outerPhase0 + i * outerStep, 240),
      outerW
    );
  }

  // 2) Bande médiane : 5 à 14 lobes, 5 à 8 passes, sens de déphasage selon l'empreinte.
  const midLobes = 5 + (b[6] % 10);
  const midPasses = 5 + (b[7] % 4);
  const midAmp = 3.5 + unit(b[8]) * 3.5;
  const midHarm = midLobes * 3 + (b[20] % 3);
  const midAmp2 = unit(b[21]) * 1.4;
  const midBase = 49;
  const midDir = b[22] % 2 === 0 ? 1 : -1;
  const midStep = (midDir * TAU * (0.45 + unit(b[23]) * 0.5)) / midPasses;
  const midPhase0 = unit(b[24]) * TAU;
  const midW = widthOf(b[13]);
  for (let i = 0; i < midPasses; i++) {
    push('mid', waveRing(midBase, midAmp, midLobes, midAmp2, midHarm, midPhase0 + i * midStep, 200), midW);
  }

  // 3) Rosace centrale hypotrochoïde : 5 à 13 lobes, 2 à 4 passes (rayon de stylet décroissant).
  const innerLobes = 5 + (b[9] % 9);
  const innerPasses = 2 + (b[10] % 3);
  const innerRot0 = unit(b[11]) * TAU;
  const dRatio0 = 0.55 + unit(b[25]) * 0.4;
  const innerRotStep = ((TAU / innerLobes) * (0.2 + unit(b[26]) * 0.6)) / innerPasses;
  const innerW = widthOf(b[14]);
  for (let i = 0; i < innerPasses; i++) {
    push(
      'inner',
      hypotrochoid(36 - i * 1.6, innerLobes, dRatio0 * (1 - i * 0.14), innerRot0 + i * innerRotStep, 360),
      innerW
    );
  }

  return {
    curves,
    pointCount,
    textRotation: Math.round(unit(b[15]) * 360),
    fractureSector: fracture,
    params: { outerLobes, outerPasses, midLobes, midPasses, innerLobes, innerPasses },
  };
}
