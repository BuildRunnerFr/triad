# Procès-Verbal de Test de Restauration PRA
## Centre Hospitalier de Valmont

**Référence :** PV-PRA-2025-03  
**Date du test :** 18 mars 2025  
**Participants :** Équipe Infrastructure CHV, Éditeur DPI (présentiel)  
**Périmètre testé :** Base de données pré-production du Dossier Patient Informatisé (DPI)

---

## 1. Déroulement de l'exercice
Le 18 mars 2025, de 09h00 à 11h45, l'équipe infrastructure a procédé à un exercice de restauration à partir de la sauvegarde nocturne du 17 mars 2025 stockée sur le bucket dédié.

## 2. Résultats observés
- **Durée de restauration :** 2h15 (conforme au RTO cible de 4h).
- **Intégrité des données :** Vérification par somme de contrôle et ouverture applicative réussie sur l'environnement de pré-production.
- **Points d'attention relevés :**
  - Le test n'a pas porté sur les archives d'imagerie PACS.
  - La procédure n'a pas simulé une compromission des comptes d'administration cloud (scénario ransomware avec tentative de suppression des sauvegardes).

## 3. Conclusion
Test validé pour le périmètre DPI pré-production en date du 18 mars 2025. Prochain exercice planifié pour le premier semestre 2026.
