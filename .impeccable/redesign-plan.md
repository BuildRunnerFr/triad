# Refonte TRIAD — plan de nuit (branche redesign/nuit, fin 2026-11-20 08:30)

Contrat : .impeccable/surfaces/frontend-src-app-tsx.md (étude de cabinet, ruban de concordance).

## Itérations (cocher au fil de l'eau)
- [x] 1. Fondations : police Schibsted Grotesk auto-hébergée, jetons clair (défaut) + sombre, filets, rail encre, en-tête, barre basse, focus/sélection.
- [x] 2. Cockpit : chiffre-titre éditorial annoté, rubans de concordance, radar retravaillé (rampe de gravité), hiérarchie, Présentation COMEX.
- [x] 3. Vue 3D / topologie : monde clair, volumes nets, gravité = diamètre, pas d'auto-rotation par défaut, contrôles dédoublonnés.
- [x] 4. Investigation : liste de constats en rubans, filtres réduits (≤5 visibles + menu), tiroir avec constat suivant/précédent.
- [x] 5. Mission : premier écran orienté tâche (que faire d'abord), session repliée, pipeline 4 agents.
- [ ] 6. Livrables & gouvernance : hiérarchie des 12 livrables, aperçus, libellés consultant (plus de delete_bucket / Garde du Corps en façade).
- [ ] 7. Comparateur AVANT/APRÈS (deux faces + bascule), palette de commandes, toasts, overlay pipeline.
- [ ] 8. Mobile (barre d'outils repliée, cibles 44px), thème sombre, accessibilité, détecteur, revue de finition + DESIGN.md.

## Journal
- 01:10 — It.1 : PRODUCT.md, tirage (candidate 6 « étude de cabinet », seed:c9ef73d2d28d009f), contrat de surface ; Schibsted Grotesk + JetBrains Mono auto-hébergées (Google Fonts retiré) ; jetons clair par défaut / sombre encre ; @theme (slate→neutres vert-gris, rayons, graisses) ; 234 couleurs codées en dur → jetons ; favicon ; thème persisté.
- 01:15 — It.2 : cockpit recomposé : phrase-titre éditoriale (affirmations contredites, chiffres dans le texte, CountUp une fois), faits secondaires séparés par filets, « Ruptures, par gravité » en rubans de concordance (composant ConcordanceRibbon : rupture localisée Dit≠Écrit / Écrit≠Réel, gravité = diamètre), « Trois risques à porter au COMEX » ; cartes KPI SpotlightCard retirées (gabarit hero-metric refusé) ; barre basse mobile sur une ligne.
- 01:19 — It.3 : scène 3D recolorée (papier/encre, matières mates, vermillon/ambre, sonde en cobalt, étiquettes Schibsted), rotation off par défaut, bascule 3D/2D dédoublonnée (« 3D / Plan »), filtres neutres ; radar sémantique (Déclaré = Dit cobalt, Réel = vert) ; codemod global de 76 classes rose/amber/sky/violet/emerald → jetons ; pastilles du rail en teintes claires fixes.
- 01:24 — It.4 : Investigation en liste de rubans (un panneau à filets, légende, ordre de lecture partagé rankFindings), gravité en <select> (10 → 6 contrôles visibles), compteurs neutres ; tiroir : en-tête clair sans sur-titre, navigation constat précédent/suivant (boutons + J/K, position 1/7), puces explicites (Gravité critique, Confiance 98 %), citations en corps 15px, onglets neutres.
- 01:33 — It.5 : Mission recomposée : client en titre, session repliée dans un menu <details> (sélection, nouvelle, export/import, suppression), déroulé de mission en 4 étapes (état réel : dossier, audit, arbitrage, signature ; la prochaine porte la seule action principale), phases AVANT/APRÈS en deux faces (radio) avec couloirs colorés et produit attendu, chaîne des 4 agents visible avec rôles en langage consultant, pièces en lignes à filets avec pilier coloré, zone de dépôt accessible au clavier.
