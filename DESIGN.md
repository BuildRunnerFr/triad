---
name: TRIAD
description: Audit NIS2 par triangulation Dit × Écrit × Réel, lu comme une étude de cabinet qu'on manipule.
colors:
  deloitte: "#86BC25"
  deloitte-hover: "#78AA1E"
  accent-text: "#286E0A"
  dit: "#2350B8"
  ecrit: "#7A3A9E"
  reel: "#286E0A"
  rupture: "#B32F16"
  high-text: "#B34A0B"
  warning-text: "#8A5A00"
  info-text: "#1F5FA8"
  ink-on-green: "#0B100D"
  paper-canvas: "#F2F3EF"
  paper-surface: "#FBFBF8"
  paper-subtle: "#E9ECE6"
  paper-elevated: "#FFFFFF"
  ink-rail: "#0E1813"
  text-primary: "#141A16"
  text-secondary: "#46504A"
  text-muted: "#5C6660"
  border-subtle: "rgba(20, 26, 22, 0.11)"
  border-strong: "rgba(20, 26, 22, 0.24)"
  night-canvas: "#0C110F"
  night-rail: "#080C0A"
  night-surface: "#121915"
  night-subtle: "#18211C"
  night-elevated: "#1A231E"
  night-text-primary: "#EEF2EE"
  night-text-secondary: "#A9B5AD"
  night-text-muted: "#87958C"
  night-accent-text: "#9BD03A"
  night-dit: "#7EA4FF"
  night-ecrit: "#C79BEA"
  night-reel: "#9BD03A"
  night-rupture: "#FF7A5C"
typography:
  display:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "7.5rem"
    fontWeight: 560
    lineHeight: 0.82
    letterSpacing: "-0.05em"
    fontFeature: "\"tnum\""
  headline:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.6rem"
    fontWeight: 560
    lineHeight: 1.08
    letterSpacing: "-0.028em"
  headline-comex:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "3.1rem"
    fontWeight: 560
    lineHeight: 1.08
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 560
    lineHeight: 1.4
    letterSpacing: "-0.018em"
  figure:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 560
    lineHeight: 1.4
    fontFeature: "\"tnum\""
  body:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: "-0.006em"
    fontFeature: "\"ss01\""
  label:
    fontFamily: "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 640
    lineHeight: 1.33
    letterSpacing: "-0.006em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.33
    letterSpacing: "0em"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  2xl: "12px"
  3xl: "16px"
  full: "9999px"
spacing:
  hairline: "1px"
  xs: "4px"
  sm: "8px"
  md: "16px"
  row-x: "20px"
  row-y: "14px"
  lg: "24px"
  rail: "224px"
  content-max: "1440px"
components:
  button-primary:
    backgroundColor: "{colors.deloitte}"
    textColor: "{colors.ink-on-green}"
    rounded: "{rounded.lg}"
    padding: "6px 16px"
    height: "38px"
    typography: "{typography.label}"
  button-primary-hover:
    backgroundColor: "{colors.deloitte-hover}"
    textColor: "{colors.ink-on-green}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
    typography: "{typography.label}"
  segment-active:
    backgroundColor: "{colors.paper-elevated}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "34px"
  segment-idle:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
  segment-track:
    backgroundColor: "{colors.paper-subtle}"
    rounded: "{rounded.lg}"
    padding: "2px"
  tab-underline-active:
    textColor: "{colors.text-primary}"
    padding: "10px 14px"
  panel:
    backgroundColor: "{colors.paper-surface}"
    rounded: "{rounded.2xl}"
  concordance-row:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.text-primary}"
    padding: "14px 20px"
  input-search:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.xl}"
    padding: "6px 28px 6px 32px"
  badge-critical:
    textColor: "{colors.rupture}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  rail:
    backgroundColor: "{colors.ink-rail}"
    textColor: "{colors.night-text-primary}"
    width: "{spacing.rail}"
  rail-item:
    textColor: "{colors.night-text-secondary}"
    rounded: "{rounded.xl}"
    padding: "8px 12px"
    height: "38px"
---

# Design System: TRIAD

## Overview

**Creative North Star: "L'étude de cabinet qu'on manipule"**

TRIAD se lit comme un rapport de cabinet de conseil devenu interactif : un papier vert-gris très clair, une encre presque noire, une seule grotesque éditoriale, des filets de 1px plutôt que des boîtes, et de grands chiffres annotés comme dans une planche de rapport annuel. L'information principale est la contradiction entre ce que le client dit, ce qu'il écrit et ce qui est vrai dans sa configuration ; elle est dessinée comme un graphique éditorial annoté (le ruban de concordance), jamais comme un voyant de tableau de bord.

La densité est celle d'un outil de travail de consultant : listes à filets triées par gravité, faits secondaires alignés en ligne, une action principale par écran. Le seul aplat de couleur fort est le vert Deloitte, réservé à l'action principale et aux états validés ; les trois piliers portent chacun leur teinte à pleine force (cobalt, prune, vert), et le vermillon annote la rupture. Le mouvement est court, décéléré, sans rebond, et s'efface entièrement sous `prefers-reduced-motion`.

Ce monde remplace explicitement l'ancien cockpit cyber sombre à néon : pas de fond nuit par défaut, pas de lueurs, pas de grille de cartes KPI identiques. Le thème sombre existe, mais comme « encre » vert très sombre, pas comme bleu nuit néon.

**Key Characteristics:**
- Papier vert-gris clair par défaut, rail de navigation en encre profonde.
- Une seule famille, Schibsted Grotesk, de l'énorme numéral au micro-libellé ; JetBrains Mono uniquement pour les empreintes, ressources et identifiants de constat.
- Filets de 1px comme structure ; panneaux à peine relevés, bordures complètes teintées pour le ton.
- Trois teintes de piliers (Dit, Écrit, Réel) et un vermillon d'annotation, toutes contrôlées WCAG AA.
- Gravité lue par le diamètre d'un point sur une rampe fixe, jamais par la seule couleur.

## Colors

Un papier neutre teinté de vert, une encre presque noire, trois teintes de piliers à pleine force et un vermillon d'annotation ; le vert Deloitte en aplat reste rare.

### Primary
- **Vert Deloitte** (`deloitte`) : seul aplat de marque. Bouton principal (« Auditer », « Présentation COMEX », « Ouvrir l'investigation », « Revoir et signer »), sceau de validation, pastille « prêt » de phase, contour de focus, curseur de saisie, sélection de texte (35 % d'opacité). Le texte posé dessus est l'encre `ink-on-green` (contraste 8,4:1), jamais du blanc. Survol : `deloitte-hover` (clair) ; en sombre le survol s'éclaircit (#96CF2E).
- **Vert lisible** (`accent-text`) : la version texte du vert (5,2:1 sur papier), pour liens d'action (« Voir le cockpit → »), états « Conforme », « Intègre ✓ », maturité visée. Fond doux associé : `rgba(134,188,37,0.16)` ; bordure : `rgba(45,122,12,0.38)`.

### Secondary
- **Cobalt du Dit** (`dit`) : entretiens, déclarations. Point gauche du ruban, polygone « Déclaré » du radar, pastille de pièce « Dit ».
- **Prune de l'Écrit** (`ecrit`) : PSSI, PV, contrats. Point central du ruban, pastille de pièce « Écrit ».
- **Vert du Réel** (`reel`) : configuration Google Cloud lue en lecture seule. Point droit du ruban quand le réel confirme, polygone « Réel vérifié ».

Chaque pilier a son fond doux à 9-10 % d'opacité (`--dit-soft`, `--ecrit-soft`, `--reel-soft`) pour les bordures de section de la vue Triangle.

### Tertiary
- **Vermillon de rupture** (`rupture`) : l'annotation de contradiction. Chiffre-titre du cockpit, mot « rupture » et cassure du ruban, statut « Non conforme », écart du radar, bannière d'alerte de sécurité. Il sert aussi de ton « critique » (`--critical-text`, fond 8 %, bordure 32 %).
- **Tons d'état** : `high-text` (orange brûlé, gravité haute), `warning-text` (ocre, « Partiel », verrous), `info-text` (bleu, session nommée). Tous ont un trio texte / fond doux / bordure (`--*-bg`, `--*-border`) et existent en sombre.

### Neutral
- **Papier d'étude** (`paper-canvas`) : fond de l'application. Vert-gris, jamais crème.
- **Feuille** (`paper-surface`) : panneaux, lignes, en-tête collant.
- **Papier ombré** (`paper-subtle`) : pistes de segments, fil de progression, en-têtes de tableau.
- **Feuille relevée** (`paper-elevated`) : segment actif, en-tête du tiroir, dialogues.
- **Encre** (`text-primary`, 17:1), **Encre secondaire** (`text-secondary`, 8:1), **Encre atténuée** (`text-muted`, 5,7:1) : trois niveaux de texte, tous AA sur papier comme sur feuille.
- **Filet** (`border-subtle`) et **Filet appuyé** (`border-strong`) : séparations, contours de boutons secondaires, trait Dit–Écrit du ruban.
- **Encre de rail** (`ink-rail`) : le rail de navigation, toujours sombre quel que soit le thème.
- La gamme neutre Tailwind `slate-50…950` est réaffectée aux neutres vert-gris (#F4F6F3 → #0C110F) : tout `slate-*` résiduel reste donc dans le monde.

### Thème sombre (« encre »)
Les jetons `night-*` redéfinissent les mêmes rôles sous `[data-theme="dark"]` : fond #0C110F, feuilles #121915, textes #EEF2EE / #A9B5AD / #87958C, piliers éclaircis (cobalt #7EA4FF, prune #C79BEA, vert #9BD03A), vermillon #FF7A5C. Tous les textes y dépassent 5,7:1.

### Named Rules
**The Green Fill Rule.** L'aplat vert Deloitte est réservé à l'action principale de l'écran et aux états validés (sceau, signature). Un onglet, un filtre ou une bascule sélectionnés ne deviennent jamais verts.

**The Three Pillars Rule.** Cobalt = Dit, prune = Écrit, vert = Réel, partout (ruban, radar, pièces, triangle, légendes). Ces teintes ne servent à rien d'autre.

**The Vermillion Annotates Rule.** Le vermillon signale une rupture ou un niveau critique, et il s'accompagne toujours d'un mot ou d'une forme (« rupture », cassure, diamètre) : la couleur seule ne porte jamais l'information.

**The Scoped Night Rule.** Les surfaces sombres dans un écran clair (rail, overlay du pipeline) portent `data-theme="dark"` pour récupérer les jetons sombres ; on n'y écrit pas de couleurs claires codées en dur.

## Typography

**Display Font:** Schibsted Grotesk (variable 400–900, auto-hébergée, avec ui-sans-serif, system-ui)
**Body Font:** Schibsted Grotesk
**Label/Mono Font:** JetBrains Mono (variable 400–800, auto-hébergée), usage restreint

**Character:** Une grotesque de presse unique, resserrée en grand (-0.05em sur le numéral, -0.018em sur les titres), qui donne la voix d'un rapport annuel ; la mono n'apparaît que là où l'on lit une empreinte machine.

Les graisses Tailwind sont recalées pour un rendu éditorial : `semibold` = 560, `bold` = 640, `extrabold` = 720. Le corps active `ss01` et un interlettrage de -0.006em ; les titres `h1–h4` prennent -0.018em et `text-wrap: balance`. Les chiffres alignés utilisent `tabular-nums`.

### Hierarchy
- **Display** (560, 7.5rem / 5.5rem sous 640px, interligne 0.82, -0.05em, vermillon) : le numéral autonome du chiffre-titre du cockpit, accompagné d'une annotation reliée par un filet de 24px (« dont 3 critiques »). Un seul par écran.
- **Headline** (560, 2.6rem / 1.6rem mobile, 1.08, -0.028em) : la phrase-titre qui dit la contradiction avec les chiffres dans le texte. Titre client de Mission : 2.4rem / 1.9rem, 1.1. Présentation COMEX : 3.1rem / 2rem (phrase-titre) et 2.25rem (en-tête).
- **Title** (560, 1rem) : titres de section (« Ruptures, par gravité », « Phases d'audit »), titre de vue dans l'en-tête, intitulé du tiroir.
- **Figure** (560, 1.25rem, tabulaire) : faits secondaires séparés par des filets (maturité, citations, effort) ; 1.5rem dans le mode COMEX.
- **Body** (400, 0.875rem) : intitulés de constat (560), descriptions, risques COMEX. Les citations dans le tiroir montent à 15px.
- **Label** (640, 0.75rem, casse normale) : boutons, segments, libellés de faits, statuts. Micro-libellés et puces : 11px.
- **Mono** (400, 0.75rem) : identifiants F-00x, empreintes SHA-256, comptes de service et ressources GCP, touches clavier.

### Named Rules
**The One Grotesque Rule.** Tout le texte, du numéral de 7.5rem au libellé de 11px, est en Schibsted Grotesk. Aucune seconde famille d'affichage.

**The Mono Is Evidence Rule.** JetBrains Mono est réservée aux empreintes, ressources et identifiants de constat. Un libellé, un statut ou un compteur humain (« Lecture seule vérifiée », « 12 exports ») est en grotesque.

**The No Eyebrow Rule.** Aucun sur-titre en petites capitales au-dessus d'un titre ; le titre dit lui-même ce qu'est la section. Les libellés restent en casse normale.

## Layout

Coque à deux colonnes : rail d'encre de 224px (`lg:w-56`), collant et pleine hauteur à partir de 1024px, qui devient une barre horizontale défilante au-dessus du contenu en dessous. À droite, un en-tête collant sur une ligne (titre de vue, fil de progression Dossier → Audit → Arbitrage → Scellement, bascule AVANT|APRÈS, « Auditer », menu Options) et un contenu centré à 1440px maximum avec gouttières de 16px (24px dès 640px) et 24px de marge verticale (14px en densité compacte). Une barre basse collante porte l'état des livrables et « Revoir et valider ».

Le rythme repose sur des écarts de 24px entre blocs (`space-y-6`, `gap-6`), des lignes de liste à 14px × 20px, et des faits secondaires en grille 2 / 3 / 6 colonnes séparées par des filets verticaux. Le cockpit place la liste de rubans sur 8 colonnes et les « Trois risques » sur 4 à partir de 1280px. Les zones à défilement interne (tiroir, journaux, palette, COMEX) portent `data-lenis-prevent`.

Deux densités : Confort (défaut) et Compact, qui resserre panneaux (14px × 16px), cartes et cellules de tableau. Cibles tactiles de 34–38px dans l'en-tête et le rail.

## Elevation & Depth

Le système est plat et structuré par les filets. La profondeur vient du ton (papier → feuille → feuille relevée) et d'un filet de 1px ; l'ombre n'est qu'un murmure sous les panneaux et une vraie ombre portée seulement pour ce qui flotte au-dessus du document.

### Shadow Vocabulary
- **Panneau** (`box-shadow: 0 1px 2px rgba(20,26,22,0.05)` ; sombre `0 1px 2px rgba(0,0,0,0.35)`) : panneaux de section et en-tête collant.
- **Dialogue** (`box-shadow: 0 18px 48px -12px rgba(20,26,22,0.28), 0 2px 6px rgba(20,26,22,0.06)` ; sombre `0 24px 64px -12px rgba(0,0,0,0.7)`) : surfaces relevées (menus, palette, dialogues, lien d'évitement).
- **Segment actif** (`box-shadow: inset 0 0 0 1px var(--border-strong), 0 1px 2px rgba(0,0,0,0.08)`) : l'élément sélectionné d'une bascule ou d'un groupe d'onglets.

### Named Rules
**The Hairline First Rule.** Une séparation se fait d'abord par un filet de 1px (`border-subtle`) ; une boîte n'apparaît que pour regrouper une liste ou un panneau, et les faits chiffrés ne sont jamais mis en cartes.

## Shapes

Coins sobres et serrés : 8px pour les boutons et segments, 10px pour le rail, les champs et les blocs internes, 12px pour les panneaux de section, 16px pour les blocs focaux (sceau, panneaux COMEX), pilule pour puces et compteurs. Le contour de focus prend 0.6rem de rayon.

Les tons se marquent par une **bordure complète teintée** (accent, info, prune, ocre, vermillon) qui l'emporte sur la bordure de surface, jamais par une bande latérale. Les phases AVANT/APRÈS sont deux faces nettes ; la face choisie prend un contour d'encre de 2px. Le ruban de concordance est la géométrie signature : trois points sur une ligne de 168 × 30px, trait plein quand les sources concordent, tirets quand elles sont partielles ou à confirmer, cassure en double barre oblique quand elles se contredisent.

## Components

### Buttons
Directs et peu nombreux : un seul bouton vert par zone, tout le reste au trait.
- **Shape:** coins doux (8px).
- **Primary:** aplat vert Deloitte, texte encre #0B100D en 640, 38px de haut dans l'en-tête, icône 14px. Survol : vert assombri. Désactivé : 50 % d'opacité. Quand le dossier est vide, « Auditer » redescend en secondaire.
- **Secondary:** fond transparent, filet `border-subtle` qui passe à `border-strong` au survol, texte encre 640 en 12px (« Piliers », « Voir AVANT → APRÈS », « Revoir et valider »).
- **Lien d'action:** texte `accent-text` en 640 suivi d'une flèche (« Voir le cockpit → », « Tous les constats (7) → »).
- **Focus:** contour vert Deloitte de 2px décalé de 2px, sur tout élément interactif.

### Chips
- **Style:** puce pilule au trio ton / fond doux / bordure (`badge-critical`, `badge-warning`, `badge-success`, `badge-info`, `badge-violet`), en casse normale.
- **Identifiants de constat:** puces neutres en mono (F-003 ↗), jamais colorées.
- **Compteurs du rail:** pastilles teintées fixes (vermillon pour l'investigation, ocre pour « À signer »).

### Cards / Containers
- **Corner Style:** 12px pour les panneaux de section.
- **Background:** feuille (`paper-surface`) sur papier.
- **Shadow Strategy:** ombre « Panneau » uniquement (voir Elevation & Depth).
- **Border:** filet `border-subtle` complet ; en-tête de panneau séparé par un filet.
- **Internal Padding:** 16–20px ; les listes vont bord à bord avec des filets entre lignes.

### Inputs / Fields
- **Style:** feuille, filet subtil, coins de 10px, 12px de texte, icône de recherche à gauche.
- **Focus:** la bordure passe au vert Deloitte ; le curseur de saisie est vert.
- **Cases et radios:** couleur d'accent native verte.

### Navigation
- **Rail:** encre profonde, scopé `data-theme="dark"`. Marque TRIAD (triangle sur carré vert), recherche « Ctrl K » et « ? », cinq vues (Mission, Cockpit, Investigation, Comparateur, Livrables) en 640 / 12px, 38px de haut, coins 10px. Repos : texte atténué, survol en voile blanc à 4 %. Actif : voile vert à 15 % et contour vert à 40 % (une teinte, pas un aplat), icône verte. Pied : état de chaîne « SHA-256 (n) · Intègre ✓ ».
- **Bascules et onglets compacts:** piste `paper-subtle` à 2px de marge, élément actif en segment neutre (feuille relevée + contour intérieur appuyé), inactifs en encre secondaire.
- **Onglets de section (Livrables):** soulignés de 2px en encre pour l'actif, filet appuyé au survol.
- **Fil de progression:** étapes cliquables dans une piste ombrée ; l'étape en cours prend fond et bordure d'accent doux, les étapes faites une coche verte.
- **Mobile:** rail en barre horizontale sans barre de défilement, fil de progression masqué sous 768px, client masqué sous 1536px.

### Ruban de concordance (signature)
Le geste qui définit TRIAD. Une ligne de constat cliquable : identifiant mono, intitulé (560, souligné au survol) et détail « Dit ≠ Réel · Art. 21 §2 (i) », puis le glyphe : point cobalt (Dit, 4.5px de rayon), point prune (Écrit), point Réel coloré par statut (vermillon non conforme, ocre partiel, vert conforme, anneau vide à confirmer). Le rayon du point Réel suit une rampe fixe de gravité : 3.5 / 4.75 / 6 / 7.5px (faible → critique). La rupture se place là où elle a lieu (entre Dit et Écrit, ou entre Écrit et Réel), cassée en double barre oblique et annotée du mot « rupture » en vermillon sur les lignes critiques. Une légende partagée (« Diamètre = gravité ») est posée une fois au-dessus de la liste. Ordre de lecture commun à toutes les vues : gravité, puis statut, puis identifiant.

### Chiffre-titre éditorial
Bandeau d'ouverture du cockpit : numéral vermillon de 7.5rem, annotation reliée par un filet, phrase-titre de 2.6rem qui intègre les chiffres, ligne de contexte en encre secondaire, puis une rangée de six faits chiffrés séparés par des filets. Le mode Présentation COMEX reprend la même grammaire à l'échelle projection (plein écran, 1320px, phrase-titre de 3.1rem).

### Tiroir d'inspection
Panneau droit de 672px qui glisse depuis le bord (ressort amorti), voile noir à 60 % flouté. En-tête sur feuille relevée : identifiant mono puis intitulé, navigation constat précédent/suivant (J/K, position « 1/7 »). Onglets en segments neutres ; citations en corps 15px. Les blocs internes entrent en fondu montant échelonné (0.09s).

### Sceau de validation
Attestation au contour et fond d'accent doux, coins 16px, cadenas sur carré vert plein. À la signature, une seule fois : dévoilement par masque de gauche à droite (0.7s, décélération exponentielle), l'anse du cadenas s'ouvre, le compteur de livrables verrouillés descend de 12 à 0 (0.6s), l'empreinte se déchiffre et les détails arrivent échelonnés. Sous mouvement réduit, l'état final est posé immédiatement.

### Mouvement
Courbe de marque `expo.out` (décélération confiante), sortie `power2.in`. Durées : retour 0.14s, changement d'état 0.24s, vue 0.42s, moment focal 0.7s. Survol de ligne 0.12s, thème 0.18s. Défilement fluide Lenis à inertie courte (lerp 0.14) désactivé sous mouvement réduit ; les décomptes et révélations ne se jouent qu'une fois par résultat.

## Do's and Don'ts

### Do:
- **Do** réserver l'aplat vert Deloitte (#86BC25, texte #0B100D) à l'action principale de l'écran et aux états validés.
- **Do** marquer toute sélection (onglet, filtre, bascule AVANT|APRÈS) par le segment neutre : feuille relevée, contour intérieur `border-strong`.
- **Do** séparer par des filets de 1px avant d'ajouter une boîte ; aligner les faits chiffrés en ligne à filets.
- **Do** exprimer un ton par une bordure complète teintée (accent, info, prune, ocre, vermillon).
- **Do** employer cobalt, prune et vert uniquement pour Dit, Écrit et Réel, et annoter chaque rupture vermillon par un mot ou une cassure.
- **Do** coder la gravité par le diamètre du point (3.5 → 7.5px), jamais par la seule couleur.
- **Do** poser `data-theme="dark"` sur toute surface sombre insérée dans un écran clair (rail, overlay du pipeline).
- **Do** garder la mono pour les empreintes SHA-256, les ressources GCP et les identifiants F-00x.
- **Do** utiliser `expo.out` et les durées 0.14 / 0.24 / 0.42 / 0.7s, et tout couper sous `prefers-reduced-motion`.

### Don't:
- **Don't** revenir au cockpit cyber sombre à néon : pas de fond nuit par défaut, pas de lueur colorée, pas de bleu nuit.
- **Don't** construire une grille de cartes KPI identiques ; un chiffre important devient une phrase-titre annotée.
- **Don't** utiliser de bande latérale colorée sur une carte ou une ligne.
- **Don't** colorer en vert plein un onglet, un filtre ou un élément de navigation sélectionné.
- **Don't** poser de sur-titre en petites capitales au-dessus d'un titre, ni de libellés en capitales espacées.
- **Don't** utiliser la mono pour un libellé, un statut ou un compteur lisible par un humain.
- **Don't** introduire une seconde famille d'affichage ni une police chargée depuis un CDN (les fontes sont auto-hébergées, CSP stricte).
- **Don't** utiliser d'easing à rebond ou élastique.
