# Notes d'entretien — Audit NIS2 Centre Hospitalier de Valmont
**Interlocuteur :** M. Garnier, Directeur des Systèmes d'Information (DSI)  
**Auditeur :** Consultant Risk Advisory Cyber — Deloitte  
**Date :** 12 novembre 2025  
**Objet :** Évaluation de maturité et conformité NIS2

---

## 1. Gouvernance et exposition des données
M. Garnier confirme que la PSSI a été mise à jour en début d'année et que le RSSI assure le suivi des risques. Concernant l'hébergement Google Cloud pour les exports d'imagerie et les sauvegardes :
> "Nos données patients ne sont jamais exposées sur Internet."

Le DSI précise que tous les buckets contenant des données médicales sont privés par défaut et réservés aux équipes internes autorisées.

## 2. Accès et administration des serveurs
Sur la sécurisation des accès distants et de l'administration des machines virtuelles Compute Engine :
> "L'accès admin passe uniquement par le VPN."

Aucun administrateur ni prestataire n'est censé se connecter en SSH ou RDP directement depuis Internet.

## 3. Sauvegardes et résilience face aux rançongiciels
Interrogé sur la protection des sauvegardes du DPI et du PACS contre un chiffrement ou une suppression malveillante :
> "Nos sauvegardes sont protégées, un ransomware ne peut pas les supprimer."

M. Garnier indique qu'un test de restauration a bien été réalisé en mars 2025 et s'est déroulé sans anomalie.

## 4. Gestion et déclaration des incidents
Sur l'existence d'incidents récents et l'application de la procédure de notification ANSSI (article 23 NIS2) :
> "On a eu un petit incident en septembre, géré en interne, rien de grave."

Précision obtenue en relance : il s'agissait d'une compromission temporaire d'un compte prestataire sur un poste administratif ayant entraîné une interruption partielle de la messagerie interne pendant une demi-journée. Aucune alerte précoce ni notification n'a été transmise à l'ANSSI ou au CERT Santé.
