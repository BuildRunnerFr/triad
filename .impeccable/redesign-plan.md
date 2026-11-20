# Refonte TRIAD — plan de nuit (branche redesign/nuit, fin 2026-11-20 08:30)

Contrat : .impeccable/surfaces/frontend-src-app-tsx.md (étude de cabinet, ruban de concordance).

## Itérations (cocher au fil de l'eau)
- [x] 1. Fondations : police Schibsted Grotesk auto-hébergée, jetons clair (défaut) + sombre, filets, rail encre, en-tête, barre basse, focus/sélection.
- [x] 2. Cockpit : chiffre-titre éditorial annoté, rubans de concordance, radar retravaillé (rampe de gravité), hiérarchie, Présentation COMEX.
- [x] 3. Vue 3D / topologie : monde clair, volumes nets, gravité = diamètre, pas d'auto-rotation par défaut, contrôles dédoublonnés.
- [ ] 4. Investigation : liste de constats en rubans, filtres réduits (≤5 visibles + menu), tiroir avec constat suivant/précédent.
- [ ] 5. Mission : premier écran orienté tâche (que faire d'abord), session repliée, pipeline 4 agents.
- [ ] 6. Livrables & gouvernance : hiérarchie des 12 livrables, aperçus, libellés consultant (plus de delete_bucket / Garde du Corps en façade).
- [ ] 7. Comparateur AVANT/APRÈS (deux faces + bascule), palette de commandes, toasts, overlay pipeline.
- [ ] 8. Mobile (barre d'outils repliée, cibles 44px), thème sombre, accessibilité, détecteur, revue de finition + DESIGN.md.

## Journal
- 01:25 — It.1 : PRODUCT.md, tirage (candidate 6 « étude de cabinet », seed:c9ef73d2d28d009f), contrat de surface ; Schibsted Grotesk + JetBrains Mono auto-hébergées (Google Fonts retiré) ; jetons clair par défaut / sombre encre ; @theme (slate→neutres vert-gris, rayons, graisses) ; 234 couleurs codées en dur → jetons ; favicon ; thème persisté.
- 01:50 — It.2 : cockpit recomposé : phrase-titre éditoriale (affirmations contredites, chiffres dans le texte, CountUp une fois), faits secondaires séparés par filets, « Ruptures, par gravité » en rubans de concordance (composant ConcordanceRibbon : rupture localisée Dit≠Écrit / Écrit≠Réel, gravité = diamètre), « Trois risques à porter au COMEX » ; cartes KPI SpotlightCard retirées (gabarit hero-metric refusé) ; barre basse mobile sur une ligne.
- 02:15 — It.3 : scène 3D recolorée (papier/encre, matières mates, vermillon/ambre, sonde en cobalt, étiquettes Schibsted), rotation off par défaut, bascule 3D/2D dédoublonnée (« 3D / Plan »), filtres neutres ; radar sémantique (Déclaré = Dit cobalt, Réel = vert) ; codemod global de 76 classes rose/amber/sky/violet/emerald → jetons ; pastilles du rail en teintes claires fixes.
