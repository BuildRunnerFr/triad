import * as THREE from 'three';
import type { TopologyPalette } from './palette';

/* Étiquettes : fiche papier fine dessinée en canvas 2D (2× pour la netteté). */

const W = 1024;
const H = 288;
const SPRITE_W = 2.85;
const SPRITE_H = (SPRITE_W * H) / W;

export interface LabelSpec {
  title: string;
  subtitle: string;
  /** Couleur CSS du statut (pastille, et bordure si `strong`). */
  accent: string;
  /** Bordure dans la teinte du statut (ressource exposée). */
  strong: boolean;
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

export function drawLabel(
  canvas: HTMLCanvasElement,
  spec: LabelSpec,
  palette: TopologyPalette
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);

  const titleFont = '600 46px "JetBrains Mono", ui-monospace, monospace';
  const subFont = '500 40px "Schibsted Grotesk", system-ui, sans-serif';
  const padX = 34;
  const dotGap = 30;
  const maxText = W - 2 * padX - 40 - dotGap;

  ctx.font = titleFont;
  const title = fit(ctx, spec.title, maxText);
  const titleW = ctx.measureText(title).width;
  ctx.font = subFont;
  const sub = fit(ctx, spec.subtitle, maxText + dotGap);
  const subW = ctx.measureText(sub).width;

  const cardW = Math.min(W - 20, Math.max(titleW + dotGap, subW) + padX * 2 + 4);
  const cardH = 196;
  const x = (W - cardW) / 2;
  const y = (H - cardH) / 2;

  ctx.beginPath();
  ctx.roundRect(x, y, cardW, cardH, 18);
  ctx.globalAlpha = 0.96;
  ctx.fillStyle = palette.css.elevated;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = spec.strong ? 3.5 : 2.5;
  ctx.strokeStyle = spec.strong ? spec.accent : palette.css.hairlineStrong;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x + padX + 9, y + 66, 10, 0, Math.PI * 2);
  ctx.fillStyle = spec.accent;
  ctx.fill();

  ctx.textBaseline = 'alphabetic';
  ctx.font = titleFont;
  ctx.fillStyle = palette.css.ink;
  ctx.fillText(title, x + padX + dotGap, y + 82);

  ctx.font = subFont;
  ctx.fillStyle = palette.css.inkSoft;
  ctx.fillText(sub, x + padX, y + 150);
}

export function createLabel(
  specFor: (p: TopologyPalette) => LabelSpec,
  palette: TopologyPalette
): { sprite: THREE.Sprite; redraw: (p: TopologyPalette) => void } {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  drawLabel(canvas, specFor(palette), palette);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(SPRITE_W, SPRITE_H, 1);
  sprite.renderOrder = 10;

  return {
    sprite,
    redraw: (p) => {
      drawLabel(canvas, specFor(p), p);
      texture.needsUpdate = true;
    },
  };
}

export { SPRITE_H as LABEL_SPRITE_H };
