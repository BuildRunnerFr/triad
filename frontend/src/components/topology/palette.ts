import * as THREE from 'three';

/**
 * Palette de la scène 3D, lue depuis les variables CSS du thème actif.
 * Les chaînes brutes servent au dessin canvas 2D (étiquettes), les THREE.Color
 * (espace linéaire) aux matériaux et shaders.
 */
export interface TopologyPalette {
  isDark: boolean;
  css: {
    canvas: string;
    surface: string;
    elevated: string;
    subtle: string;
    ink: string;
    inkSoft: string;
    muted: string;
    hairline: string;
    hairlineStrong: string;
    reel: string;
    rupture: string;
    dit: string;
    warning: string;
  };
  canvas: THREE.Color;
  paper: THREE.Color;
  paperSide: THREE.Color;
  ink: THREE.Color;
  inkSoft: THREE.Color;
  reel: THREE.Color;
  rupture: THREE.Color;
  dit: THREE.Color;
  warning: THREE.Color;
}

const FALLBACK_LIGHT = {
  canvas: '#F2F3EF',
  surface: '#FBFBF8',
  elevated: '#FFFFFF',
  subtle: '#E9ECE6',
  ink: '#141A16',
  inkSoft: '#46504A',
  muted: '#5C6660',
  hairline: 'rgba(20, 26, 22, 0.11)',
  hairlineStrong: 'rgba(20, 26, 22, 0.24)',
  reel: '#286E0A',
  rupture: '#B32F16',
  dit: '#2350B8',
  warning: '#8A5A00',
};

const FALLBACK_DARK = {
  canvas: '#0C110F',
  surface: '#121915',
  elevated: '#1A231E',
  subtle: '#18211C',
  ink: '#EEF2EE',
  inkSoft: '#A9B5AD',
  muted: '#87958C',
  hairline: 'rgba(238, 242, 238, 0.09)',
  hairlineStrong: 'rgba(238, 242, 238, 0.2)',
  reel: '#9BD03A',
  rupture: '#FF7A5C',
  dit: '#7EA4FF',
  warning: '#F2C14E',
};

function toColor(value: string, fallback: string): THREE.Color {
  const c = new THREE.Color();
  const v = value.trim();
  // Seuls les hexadécimaux sont convertis : rgba() ferait perdre l'alpha.
  if (/^#[0-9a-f]{3,8}$/i.test(v)) {
    c.setStyle(v.length === 9 ? v.slice(0, 7) : v);
  } else {
    c.setStyle(fallback);
  }
  return c;
}

function relLuminance(hex: string): number {
  const c = new THREE.Color();
  try {
    c.setStyle(hex);
  } catch {
    return 1;
  }
  // THREE.Color est déjà linéaire.
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** Lit la palette depuis l'élément (les variables cascadent depuis [data-theme]). */
export function readTopologyPalette(el: Element | null): TopologyPalette {
  const style = el ? getComputedStyle(el) : null;
  const get = (name: string) => style?.getPropertyValue(name).trim() || '';

  const canvasRaw = get('--bg-canvas');
  const isDark = canvasRaw ? relLuminance(canvasRaw) < 0.2 : false;
  const fb = isDark ? FALLBACK_DARK : FALLBACK_LIGHT;
  const pick = (name: string, key: keyof typeof fb) => get(name) || fb[key];

  const css = {
    canvas: pick('--bg-canvas', 'canvas'),
    surface: pick('--bg-surface', 'surface'),
    elevated: pick('--bg-elevated', 'elevated'),
    subtle: pick('--bg-subtle', 'subtle'),
    ink: pick('--text-primary', 'ink'),
    inkSoft: pick('--text-secondary', 'inkSoft'),
    muted: pick('--text-muted', 'muted'),
    hairline: pick('--border-subtle', 'hairline'),
    hairlineStrong: pick('--border-strong', 'hairlineStrong'),
    reel: pick('--reel', 'reel'),
    rupture: pick('--rupture', 'rupture'),
    dit: pick('--dit', 'dit'),
    warning: pick('--warning-text', 'warning'),
  };

  const canvas = toColor(css.canvas, fb.canvas);
  // La plateforme est une feuille posée sur le bureau : un ton au-dessus du fond.
  const paper = toColor(isDark ? css.subtle : css.surface, isDark ? fb.subtle : fb.surface);
  const paperSide = isDark
    ? canvas.clone().lerp(paper, 0.55)
    : toColor(css.subtle, fb.subtle);

  return {
    isDark,
    css,
    canvas,
    paper,
    paperSide,
    ink: toColor(css.ink, fb.ink),
    inkSoft: toColor(css.inkSoft, fb.inkSoft),
    reel: toColor(css.reel, fb.reel),
    rupture: toColor(css.rupture, fb.rupture),
    dit: toColor(css.dit, fb.dit),
    warning: toColor(css.warning, fb.warning),
  };
}
