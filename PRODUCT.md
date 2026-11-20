# Product

<!-- impeccable:product-schema 1 -->

> Faits déduits du dépôt (README, AGENTS.md, code, données de démo) pendant une session non accompagnée ; l'utilisateur a donné « carte blanche » sur le visuel. Les éléments marqués *(déduit)* sont à confirmer.

## Platform

web

## Users

- **Consultants Deloitte Risk Advisory Cyber** *(déduit)* : préparent et conduisent un audit de conformité NIS2 chez un client (démo : Centre Hospitalier de Valmont, entité essentielle santé). Ils chargent un dossier de pièces, lancent l'audit multi-agents, arbitrent chaque constat, puis signent la synthèse pour débloquer les livrables.
- **Audience secondaire** *(déduit)* : comité de direction (COMEX) et DSI du client, à qui le consultant présente les résultats (mode « Présentation COMEX », brief Art. 20).
- **Jury du Hackathon Deloitte × Google Cloud** : évalue la démonstration.

## Product Purpose

Croiser trois sources vérifiables pour un audit NIS2 : le **Dit** (entretiens), l'**Écrit** (PSSI, PV, contrats) et le **Réel** (configuration Google Cloud lue en lecture seule). Faire apparaître les contradictions, les qualifier, et produire 12 livrables scellés (rapport, dossier de preuve, notifications ANSSI/CNIL, brief COMEX, Terraform…) uniquement après validation humaine. Succès : un consultant défend chaque constat devant un COMEX avec une preuve citée mot à mot.

## Positioning

La triangulation contradictoire Dit × Écrit × Réel, avec citations vérifiées et chaîne d'intégrité SHA-256 append-only : chaque affirmation du client est confrontée à un document et à une configuration réelle. Les livrables restent verrouillés (HTTP 403) tant qu'un humain n'a pas signé.

## Operating Context

- Mission d'audit en deux phases comparées : AVANT et APRÈS entretiens contradictoires.
- Pipeline de 4 agents (Douanier : DLP/anti-injection ; Analyste conformité ; Contre-auditeur ; Garde du corps : scellement).
- Usage sur poste de consultant (bureau, salle de réunion client, écran partagé/projecteur pour le COMEX) *(déduit)* ; consultation mobile ponctuelle.
- Démonstration live devant un jury.

## Capabilities and Constraints

- Sondes GCP strictement en lecture seule ; aucune remédiation exécutée depuis l'app (playbooks en dry-run, Terraform à revoir en PR).
- 12 exports verrouillés en 403 avant `POST /api/validate`, re-verrouillés si un arbitrage GRC change.
- Chaîne SHA-256 append-only, bundles v1 à v6, signature HMAC `X-Triad-Signature`.
- Frontend : React 19, Vite, Tailwind 4, Three.js, framer-motion, GSAP, Lenis ; CSP stricte (aucun script inline, aucun `dangerouslySetInnerHTML`) ; budget JS initial < 358 400 octets.
- Interface 100 % en français.
- Référentiels : NIS2 Art. 20, 21 (§2 a–j), 23 ; correspondances HDS v2, ISO/IEC 27001:2022, RGPD Art. 28/32/33/34.

## Brand Commitments

- Contexte Deloitte : vert Deloitte `#86BC25` comme couleur de marque *(déduit du code ; pas de charte fournie)*.
- Nom du produit : TRIAD ; triptyque « Ce qu'on dit. Ce qu'on écrit. Ce qui est vrai. »

## Evidence on Hand

- Scénario de démonstration réel du dépôt : `data/` (notes d'entretien DSI, PSSI, PV de restauration, annexe fournisseur, snapshot GCP, référentiel NIS2, cache de démo).
- Aucun client réel, témoignage ou chiffre commercial : ne rien inventer de tel.

## Product Principles

1. La preuve avant l'affirmation : chaque constat montre sa source exacte.
2. L'humain signe : rien ne sort sans attestation explicite.
3. La contradiction est le signal : l'écart Dit/Écrit/Réel est l'information principale.
4. Lecture seule sur le client : l'outil observe, il ne modifie jamais.
5. Défendable devant un COMEX : chiffres cohérents, vocabulaire de consultant, pas de jargon d'ingénieur.

## Accessibility & Inclusion

- Contraste WCAG AA minimum, focus clavier visible, respect de `prefers-reduced-motion`, raccourcis clavier existants (Ctrl K, Alt+1..5, ?).
