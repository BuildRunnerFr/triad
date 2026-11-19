/**
 * Point d'entrée unique GSAP (licence standard GSAP « no charge », usage applicatif autorisé).
 * Enregistre les plugins une seule fois et expose les courbes de la marque TRIAD.
 */
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);

/** Décélération exponentielle « arrivée confiante » (ease-out-expo). */
export const EASE_OUT = 'expo.out';
/** Sortie plus rapide que l'entrée. */
export const EASE_IN = 'power2.in';

export const DURATION = {
  feedback: 0.14,
  state: 0.24,
  view: 0.42,
  focal: 0.7,
} as const;

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export { gsap, useGSAP };
