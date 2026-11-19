import { useEffect } from 'react';
import Lenis from 'lenis';
import { gsap, prefersReducedMotion } from './gsap';

/**
 * Défilement fluide Lenis (MIT) sur la fenêtre, piloté par le ticker GSAP.
 * - Désactivé si l'utilisateur demande « réduire les animations ».
 * - Les zones défilantes internes (tiroirs, journaux, tableaux, dialogues) doivent porter
 *   `data-lenis-prevent` pour garder leur défilement natif.
 * - Inertie volontairement courte : outil de travail, pas une page vitrine.
 */
export default function SmoothScroll() {
  useEffect(() => {
    if (prefersReducedMotion()) return undefined;
    const lenis = new Lenis({
      lerp: 0.14,
      wheelMultiplier: 1,
      smoothWheel: true,
      syncTouch: false,
      anchors: true,
      // Les conteneurs défilants internes (tiroir, journaux, aperçus, palette) gardent le défilement natif.
      prevent: (node) =>
        node.closest(
          '[data-lenis-prevent], [role="dialog"], [cmdk-root], .overflow-y-auto, .overflow-auto, canvas'
        ) !== null,
    });
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    document.documentElement.classList.add('lenis');
    return () => {
      gsap.ticker.remove(tick);
      gsap.ticker.lagSmoothing(500, 33); // valeurs par défaut GSAP
      lenis.destroy();
      document.documentElement.classList.remove('lenis');
    };
  }, []);
  return null;
}
