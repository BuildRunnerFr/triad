# Politique de Sécurité des Systèmes d'Information (PSSI)
## Centre Hospitalier de Valmont — Entité Essentielle NIS2

**Référence :** PSSI-CHV-2025-v3.2  
**Date d'approbation :** 15 janvier 2025  
**Propriétaire :** Direction des Systèmes d'Information et de la Sécurité  
**Responsable de la Sécurité des Systèmes d'Information (RSSI) :** Claire Moreau  
**Contact RSSI :** claire.moreau@ch-valmont.fr — Tél. : +33 4 72 18 45 90  
**Classification :** Usage interne — Diffusion restreinte  

---

## §1. Objet, périmètre et gouvernance

### §1.1 Objectif
La présente Politique de Sécurité des Systèmes d'Information (PSSI) définit les règles, principes organisationnels et mesures techniques applicables à l'ensemble du système d'information du Centre Hospitalier de Valmont (CHV), établissement public de santé de 620 lits classé entité essentielle au titre de la directive européenne NIS2.

### §1.2 Périmètre d'application
La PSSI s'applique à :
- l'ensemble des personnels médicaux, soignants, administratifs et techniques ;
- les prestataires, sous-traitants et éditeurs intervenant sur le SI hospitalier ;
- l'ensemble des actifs numériques, incluant le Dossier Patient Informatisé (DPI), le PACS d'imagerie médicale, les serveurs sur site et les environnements hébergés dans le cloud public (Google Cloud Platform, région `europe-west9` Paris).

### §1.3 Gouvernance et revue
La PSSI est approuvée par la Direction Générale et le Président de la CME. Le RSSI, Claire Moreau, assure le pilotage du SMSI, anime le comité cyber trimestriel et veille à la mise à jour annuelle du présent document ainsi qu'à la sensibilisation annuelle obligatoire de tous les agents.

---

## §2. Classification et gestion des risques

### §2.1 Classification des données
Les informations traitées par le CHV sont classées selon quatre niveaux de sensibilité :
1. **Données de santé à caractère personnel (DSCP)** : niveau *Critique* (DPI, comptes rendus d'examens, imagerie DICOM/PACS, résultats biologiques).
2. **Données administratives et financières** : niveau *Confidentiel* (facturation, RH, coordonnées bancaires).
3. **Données techniques internes** : niveau *Interne* (journaux système, schémas réseau).
4. **Données publiques** : niveau *Public* (plaquettes d'information, offre de soins).

### §2.2 Analyse de risques
Une analyse de risques selon la méthode EBIOS Risk Manager est conduite tous les deux ans ou lors de tout changement majeur d'architecture (nouveau module DPI, migration cloud, interconnexion partenaire). Les risques résiduels jugés élevés sont formellement acceptés par la Direction Générale.

---

## §3. Protection des données de santé et stockage cloud

### §3.1 Stockage et exposition des données
Aucune donnée de santé n'est stockée sur un espace accessible publiquement.

Tout espace de stockage objet (bucket Cloud Storage) hébergeant des données cliniques, des exports d'imagerie ou des fichiers administratifs doit être configuré avec un accès strictement privé, un contrôle d'accès uniforme au niveau du bucket et l'interdiction absolue des liaisons IAM publiques (`allUsers`, `allAuthenticatedUsers`).

### §3.2 Chiffrement
Les données de santé sont chiffrées au repos (AES-256 minimum) et en transit (TLS 1.2 minimum, TLS 1.3 recommandé). Les flux inter-applicatifs contenant des données patients doivent utiliser des canaux authentifiés et chiffrés.

### §3.3 Gestion des tiers et sous-traitants
Tout fournisseur accédant au SI ou hébergeant des données du CHV signe une convention d'assurance sécurité (PAS) conforme aux exigences NIS2 et HDS, incluant des clauses de notification d'incident et de réversibilité.

---

## §4. Contrôle d'accès et sécurité réseau

### §4.1 Principe du moindre privilège
L'attribution des droits repose sur le principe du moindre privilège et la séparation des tâches. Les comptes nominatifs sont obligatoires ; l'usage de comptes génériques partagés est interdit. Une revue trimestrielle des comptes à privilèges est réalisée par l'équipe infrastructure.

### §4.2 Authentification forte
L'authentification multifacteur (MFA) est obligatoire pour :
- tout accès distant au réseau hospitalier ;
- tout accès aux consoles d'administration cloud et aux comptes à privilèges ;
- l'accès au DPI depuis l'extérieur de l'établissement.

### §4.3 Administration et exposition réseau
L'administration des serveurs s'effectue exclusivement via le bastion, accessible par VPN. Aucun port d'administration n'est exposé sur Internet.

Les flux SSH (TCP/22), RDP (TCP/3389) et interfaces d'administration web doivent être filtrés au niveau des pare-feu cloud et périmétriques afin de n'autoriser que les plages IP internes du bastion d'administration.

---

## §5. Continuité d'activité et sauvegardes

### §5.1 Objectifs de reprise
Pour les applications critiques (DPI, PACS, laboratoire, urgences), le CHV fixe un objectif de temps de reprise (RTO) de 4 heures et une perte de données maximale admissible (RPO) de 24 heures. Un Plan de Continuité d'Activité (PCA) et un Plan de Reprise d'Activité (PRA) sont maintenus à jour, incluant un mode dégradé papier pour les services de soins.

### §5.2 Politique de sauvegarde
Les bases de données critiques et les systèmes applicatifs font l'objet de sauvegardes quotidiennes automatisées, conservées pendant une durée de 30 jours sur des espaces dédiés dans le cloud.

### §5.3 Tests de restauration
Un exercice de restauration et de bascule PRA doit être mené au moins une fois par an et faire l'objet d'un procès-verbal formalisé validé par le DSI et le RSSI.

---

## §6. Gestion et notification des incidents de sécurité

### §6.1 Détection et réponse
Tout collaborateur ou prestataire constatant un comportement anormal (rançongiciel, fuite suspectée, accès non autorisé, indisponibilité critique) doit alerter immédiatement la cellule de crise cyber via l'astreinte RSSI (claire.moreau@ch-valmont.fr / +33 4 72 18 45 90). Les journaux d'événements de sécurité sont centralisés et conservés 12 mois.

### §6.2 Notification réglementaire (NIS2)
Conformément à l'article 23 de la directive NIS2, tout incident significatif affectant la continuité des soins ou la sécurité des systèmes essentiels fait l'objet :
- d'une alerte précoce à l'ANSSI sous 24 h ;
- d'une notification d'incident détaillée sous 72 h précisant l'évaluation initiale, la gravité et les indicateurs de compromission ;
- d'un rapport final dans un délai d'un mois suivant la notification.

---

## §7. Suivi de conformité et sanctions
Le RSSI réalise des contrôles techniques périodiques (scans de vulnérabilités, audits de configuration cloud) pour vérifier l'application effective de la présente PSSI. Tout écart constaté donne lieu à un plan de remédiation suivi en comité cyber. Le non-respect délibéré des règles exposées peut entraîner des mesures disciplinaires conformément au règlement intérieur de l'établissement.
