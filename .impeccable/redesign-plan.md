# Refonte TRIAD — plan de nuit (branche redesign/nuit, fin 2026-11-20 08:30)

Contrat : .impeccable/surfaces/frontend-src-app-tsx.md (étude de cabinet, ruban de concordance).

## Itérations (cocher au fil de l'eau)
- [x] 1. Fondations : police Schibsted Grotesk auto-hébergée, jetons clair (défaut) + sombre, filets, rail encre, en-tête, barre basse, focus/sélection.
- [x] 2. Cockpit : chiffre-titre éditorial annoté, rubans de concordance, radar retravaillé (rampe de gravité), hiérarchie, Présentation COMEX.
- [x] 3. Vue 3D / topologie : monde clair, volumes nets, gravité = diamètre, pas d'auto-rotation par défaut, contrôles dédoublonnés.
- [x] 4. Investigation : liste de constats en rubans, filtres réduits (≤5 visibles + menu), tiroir avec constat suivant/précédent.
- [x] 5. Mission : premier écran orienté tâche (que faire d'abord), session repliée, pipeline 4 agents.
- [x] 6. Livrables & gouvernance : hiérarchie des 12 livrables, aperçus, libellés consultant (plus de delete_bucket / Garde du Corps en façade).
- [x] 7. Comparateur AVANT/APRÈS (deux faces + bascule), palette de commandes, toasts, overlay pipeline.
- [ ] 8. Mobile (barre d'outils repliée, cibles 44px), thème sombre, accessibilité, détecteur, revue de finition + DESIGN.md.

- [x] 9. Mode Présentation COMEX (plein écran) + tiroir « Piliers et trame DSI ».
- [x] 10. Sous-vues de couverture (Prestataires Art. 21 §2 d, Continuité RTO/RPO, Référentiels HDS/ISO/RGPD) + matrice NIS2.
- [x] 11. Livrables : Plan de remédiation, Posture et permissions, Intégrité des preuves (registre, vérificateur .zip).
- [x] 12. Palette de commandes, dialogue raccourcis, notifications, états vides (nouvelle session).

## Carnet des tours suivants (petits lots sûrs, un par réveil)
- [x] Comparateur : section « Questions d'audition Phase AVANT » (tuile icône) → titre simple + liste à filets.
- [x] Vérificateur .zip (ForensicBundleVerifier) : revue visuelle et alignement (filets, pas de mono costume).
- [x] Posture et permissions : revue visuelle et alignement.
- [x] Rafraîchir la planche Figma (captures comparateur/couverture/remédiation à jour).
- [ ] 08:30 : récapitulatif final (republier la page récap si besoin), notification, arrêt de la boucle.
Contexte : backend isolé sur http://127.0.0.1:8091 (copie dans scratchpad/iso, dist lié) ; scripts de capture dans scratchpad (shots.cjs, delivtabs.cjs, coverage.cjs, a11y.cjs) ; page récap : https://claude.ai/artifact/T8H2DtYCZis8VPj7HcuYUm (fichier scratchpad/recap/index.html).

## Journal
- 01:10 — It.1 : PRODUCT.md, tirage (candidate 6 « étude de cabinet », seed:c9ef73d2d28d009f), contrat de surface ; Schibsted Grotesk + JetBrains Mono auto-hébergées (Google Fonts retiré) ; jetons clair par défaut / sombre encre ; @theme (slate→neutres vert-gris, rayons, graisses) ; 234 couleurs codées en dur → jetons ; favicon ; thème persisté.
- 01:15 — It.2 : cockpit recomposé : phrase-titre éditoriale (affirmations contredites, chiffres dans le texte, CountUp une fois), faits secondaires séparés par filets, « Ruptures, par gravité » en rubans de concordance (composant ConcordanceRibbon : rupture localisée Dit≠Écrit / Écrit≠Réel, gravité = diamètre), « Trois risques à porter au COMEX » ; cartes KPI SpotlightCard retirées (gabarit hero-metric refusé) ; barre basse mobile sur une ligne.
- 01:19 — It.3 : scène 3D recolorée (papier/encre, matières mates, vermillon/ambre, sonde en cobalt, étiquettes Schibsted), rotation off par défaut, bascule 3D/2D dédoublonnée (« 3D / Plan »), filtres neutres ; radar sémantique (Déclaré = Dit cobalt, Réel = vert) ; codemod global de 76 classes rose/amber/sky/violet/emerald → jetons ; pastilles du rail en teintes claires fixes.
- 01:24 — It.4 : Investigation en liste de rubans (un panneau à filets, légende, ordre de lecture partagé rankFindings), gravité en <select> (10 → 6 contrôles visibles), compteurs neutres ; tiroir : en-tête clair sans sur-titre, navigation constat précédent/suivant (boutons + J/K, position 1/7), puces explicites (Gravité critique, Confiance 98 %), citations en corps 15px, onglets neutres.
- 01:27 — It.5 : Mission recomposée : client en titre, session repliée dans un menu <details> (sélection, nouvelle, export/import, suppression), déroulé de mission en 4 étapes (état réel : dossier, audit, arbitrage, signature ; la prochaine porte la seule action principale), phases AVANT/APRÈS en deux faces (radio) avec couloirs colorés et produit attendu, chaîne des 4 agents visible avec rôles en langage consultant, pièces en lignes à filets avec pilier coloré, zone de dépôt accessible au clavier.
- 01:30 — It.6 : Livrables : onglets soulignés en vocabulaire consultant (Livrables, Plan de remédiation, Posture et permissions, Intégrité des preuves), bouton de démo « delete_bucket » renommé et déplacé dans l'onglet Intégrité ; écran de signature en deux colonnes (attestation + « Ce que la signature débloque », 12 livrables en 4 groupes) ; après signature, mur de boutons remplacé par 4 colonnes d'export libellées, pastilles redondantes retirées, onglets d'aperçu neutres.
- 01:33 — It.7 : Comparateur recomposé (phrase-titre « les entretiens ont fait apparaître N déclarations démenties », faits à filets, télémétrie réduite à une ligne, matrice en un panneau à filets, identifiants neutres, jargon /api/audit/diff reformulé) ; overlay du pipeline et rail : jetons sombres scopés via data-theme="dark" (contraste correct en thème clair).
- 01:40 — It.8a : en-tête sur une ligne (titre, progression, phase, Auditer, menu Options : thème, densité, cache, palette, raccourcis, réinitialiser) ; pastille client masquée sous 2xl ; revue du thème sombre sur les 5 vues : cohérente.
- 01:38 — It.9 : mode Présentation COMEX refait en brief d'une page à l'échelle projection (phrase-titre 50px, faits à filets, trois risques, contradictions en rubans, trajectoire 90 j par pilier avec barre actuel/visé, décisions attendues Art. 20) ; tiroir des piliers en liste à filets (score vérifié + repère bleu du déclaré, écart en vermillon) ; vue Triangle : bordures teintées et libellés Dit/Écrit/Réel en couleurs de piliers ; easing sans rebond (détecteur : 4 → 0 hors fonte).
- 04:54 — It.10-11 : balayage par regex sur 15 composants (sélections vertes → seg-active, puces F-00x neutres, micro-libellés en capitales → libellés, pastilles en casse normale, pastilles rouges pleines → badge-critical) ; sous-vues couverture/prestataires/continuité/référentiels et onglets plan de remédiation/posture/intégrité alignés sur le monde.
- 04:55 — It.12 : palette (puces neutres, surlignage souligné, focus d'input propre), dialogue raccourcis (texte sans « poste de commande cyber »), état vide : « Auditer » de l'en-tête secondaire tant que le dossier est vide, badge « À signer » masqué sans synthèse.
- 05:02 — Revue de finition (verdict fix) appliquée en un lot : chiffre-titre en numéral autonome 7,5rem + annotation à filet (valeur exacte, plus de CountUp), sur-titres supprimés (cockpit, mission, COMEX), radar sans animation (polygones toujours dessinés) et rayon réduit < 640px, 4 dernières bandes latérales retirées, chiffres de couverture en ligne à filets, en-tête de tableau en casse normale, radar et topologie en sections à filet, filtres 3D qui se replient sur mobile, mono retiré des libellés (« Lecture seule vérifiée », « Données serveur à jour », « À lancer », « 12 exports »).
- 05:04 — Verdict final du relecteur (session non accompagnée, revue finale) : 6/8 résolues, 2 partielles (5 : panneau englobant de la couverture ; 7 : mono résiduel). Corrigées ensuite hors revue (auto-vérifiées) : couverture en section à filet + onglets soulignés, « Art. 21 et 23 » en grotesque, pilules du comparateur remplacées ; état vide du comparateur refait (phrase-titre, couloirs, phases sans badge).
- 05:07 — DESIGN.md + .impeccable/design.json écrits par le documenteur (système tel que construit). Défauts résiduels relevés par lui et corrigés : halo vert du logo, rebond du cadenas et ressort du tiroir (→ expo.out), ~22 libellés en capitales, « Tester Garde du Corps » → « Tester le blocage d'une action », couleurs codées en dur du rail → jetons (rail scopé sombre).
- 05:12 — Figma : fichier « TRIAD — Système de design « Étude de cabinet » » créé dans les brouillons (https://www.figma.com/design/wxUUTGa33qnOnbLHpxT29P), planche générée depuis le code (palette clair/sombre, piliers, typographie, chiffre-titre, rubans, commandes, sceau, 7 écrans). Vue 3D Investigation agrandie, socle mat ; onglets défilables sur mobile ; retour tactile à l'appui.
- 05:14 — Mesure d'accessibilité sur le rendu (5 vues × 2 thèmes) : 0 échec de contraste AA (vert de texte #286E0A, vermillon clair #B32F16, compteur d'onglet sombre corrigé), cibles < 24 px agrandies (lien « Tous les constats », filtres 3D, boutons Détails) ; DESIGN.md/design.json mis à jour.
- 05:17 — Overlay d'audit en langage consultant (« Audit en cours », statuts En cours / Terminé / En attente) ; lignes du comparateur allégées (statuts, charge et catégorie en texte coloré, actions en liens).
- 05:21 — Page récapitulative avant/après publiée (artifact privé) ; tiroir : commande gcloud à la ligne ; plan de remédiation : 4 chiffres en ligne à filets (plus de cartes, plus de mono).
- 05:23 — Comparateur : questions AVANT en titre-phrase + liste numérotée à filets ; posture et vérificateur .zip revus, mono retirée de 13 pastilles d'état.
- 05:24 — Planche Figma mise à jour (page 2, node 2:2 : captures à jour, couleurs AA). Carnet terminé ; tours suivants = contrôles de santé jusqu'au récapitulatif de 08:30.
- 06:26 — Investigation › Triangle : sommets aux couleurs de pilier en casse phrase, verdict sans majuscules, 3 colonnes à filets, puces F-00x neutres (rupture en texte vermillon), « Ouvrir le constat » en action secondaire. Vérifié 1440 clair / 390 sombre.
- 06:27 — Balayage mobile 390 (5 vues, clair) : aucune casse, plus aucune majuscule décorative dans le code.
- 07:27 — Couverture › Continuité / Prestataires / Référentiels : libellés de niveau en casse phrase (Critique, Exposé, Immuable…), pastilles rouge plein → badge-critical, valeurs RTO/RPO en grotesque sur 2 lignes au lieu de mono tronquée.
- 07:29 — Référentiels HDS/ISO/RGPD : intitulé d'exigence complet (plus de troncature), article en sous-ligne, citations en grotesque au lieu de mono.
