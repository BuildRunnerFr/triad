"""Vues analytiques NIS2 : risque tiers (Art. 21 §2 d), continuité PCA/PRA (Art. 21 §2 c)
et correspondance multi-référentiels Santé (HDS / ISO 27001 / RGPD) — calculs purs sur l'état de session."""

from __future__ import annotations

import json
import re
from typing import Any

from triad.models import AuditMode
from triad.tools.nis2_loader import get_nis2_requirements

_SUPPLY_RISK_RANK: dict[str, int] = {
    "MAÎTRISÉ": 1,
    "MODÉRÉ": 2,
    "ÉLEVÉ": 3,
    "CRITIQUE": 4,
}


def _evaluate_vendor_risk_from_findings(
    linked_findings: list[dict[str, Any]], *, quarantined: bool = False
) -> str:
    """Calcule le niveau de risque tiers (CRITIQUE / ÉLEVÉ / MODÉRÉ / MAÎTRISÉ)."""
    if quarantined:
        return "CRITIQUE"
    non_conformes = [f for f in linked_findings if f.get("statut") != "conforme"]
    if not non_conformes:
        return "MAÎTRISÉ" if linked_findings else "MODÉRÉ"
    gravites = {str(f.get("gravite") or "").lower() for f in non_conformes}
    statuts = {str(f.get("statut") or "").lower() for f in non_conformes}
    if "critique" in gravites and "non_conforme" in statuts:
        return "CRITIQUE"
    if "critique" in gravites or "haute" in gravites:
        return "ÉLEVÉ"
    return "MODÉRÉ"


def build_supply_chain_view(
    state: dict[str, Any],
    session_id: str,
    mode: AuditMode | None = None,
) -> dict[str, Any]:
    """Registre d'évaluation du risque tiers & chaîne d'approvisionnement (NIS2 Art. 21 §2 d)."""
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    syn = slot.get("synthesis")
    has_synthesis = isinstance(syn, dict)

    if not has_synthesis:
        return {
            "session_id": session_id,
            "mode": active_mode,
            "has_synthesis": False,
            "article": "Art. 21 §2 (d) — Sécurité de la chaîne d'approvisionnement",
            "pssi_reference": "PSSI §3.3 — Gestion des tiers et sous-traitants (PAS NIS2 / HDS)",
            "source": "server",
            "overall_risk": "MAÎTRISÉ",
            "quarantined_docs_count": 0,
            "quarantined_documents": [],
            "vendors": [],
            "providers": [],
            "summary_counts": {
                "total": 0,
                "critique": 0,
                "eleve": 0,
                "modere": 0,
                "maitrise": 0,
            },
        }

    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    by_id: dict[str, dict[str, Any]] = {
        str(f.get("id")): f for f in findings if f.get("id")
    }
    docs_clean = [d for d in (syn.get("documents_nettoyes") or []) if isinstance(d, dict)]
    docs_quar = [d for d in (syn.get("documents_quarantaine") or []) if isinstance(d, dict)]
    quar_by_name: dict[str, dict[str, Any]] = {
        str(d.get("nom_fichier") or ""): d for d in docs_quar if d.get("nom_fichier")
    }
    clean_by_name: dict[str, dict[str, Any]] = {
        str(d.get("nom_fichier") or ""): d for d in docs_clean if d.get("nom_fichier")
    }

    quarantined_documents = [
        {
            "nom_fichier": str(d.get("nom_fichier") or ""),
            "raison": str(
                d.get("raison_quarantaine")
                or d.get("alerte_injection")
                or "Tentative d'injection de prompt bloquée par le Douanier"
            ),
        }
        for d in docs_quar
        if d.get("nom_fichier")
    ]

    vendors: list[dict[str, Any]] = []
    handled_doc_names: set[str] = set()

    # 1. Prestataire de télémaintenance imagerie/PACS (MedTech Solutions SAS / sa-prestataire-meditech)
    medtech_doc_name: str | None = None
    for cand in list(quar_by_name.keys()) + list(clean_by_name.keys()):
        if re.search(r"fournisseur|maintenance|medtech|prestataire", cand, re.I):
            medtech_doc_name = cand
            handled_doc_names.add(cand)
            break

    medtech_quar_doc = quar_by_name.get(medtech_doc_name or "")
    medtech_is_quar = medtech_quar_doc is not None
    medtech_quar_reason = (
        str(
            medtech_quar_doc.get("raison_quarantaine")
            or medtech_quar_doc.get("alerte_injection")
            or "Instruction d'injection de prompt indirecte détectée et isolée par le Douanier"
        )
        if medtech_quar_doc
        else None
    )

    medtech_findings: list[dict[str, Any]] = []
    for f in findings:
        blob = json.dumps(f, ensure_ascii=False).lower()
        fid = str(f.get("id") or "")
        if (
            fid in {"F-001", "F-002", "F-006"}
            or "meditech" in blob
            or "medtech" in blob
            or "allow-ssh-anywhere" in blob
            or "export-radiologie" in blob
        ):
            medtech_findings.append(f)

    medtech_fids = [str(f["id"]) for f in medtech_findings if f.get("id")]
    medtech_risk = _evaluate_vendor_risk_from_findings(
        medtech_findings, quarantined=medtech_is_quar
    )
    vendors.append(
        {
            "id": "SUP-001",
            "name": "MedTech Solutions SAS",
            "provider": "MedTech Solutions SAS",
            "role": "Télémaintenance Imagerie DICOM & Stockage PACS",
            "context": (
                "Contrat MNT-2025-089 — Maintenance des passerelles DICOM, accès distant "
                "et compte de service GCP sa-prestataire-meditech (roles/editor, clé 248 j)."
            ),
            "contract_ref": "MNT-2025-089 (PSSI §3.3 & §4.3)",
            "risk_level": medtech_risk,
            "finding_ids": medtech_fids,
            "quarantined": medtech_is_quar,
            "quarantine_reason": medtech_quar_reason,
            "source_document": medtech_doc_name or "PSSI_CH_Valmont.md",
            "recommended_clauses": [
                "Art. 21 §2 (d) & PSSI §4.1 : Révoquer la clé statique USER_MANAGED (248 j > 90 j) de sa-prestataire-meditech, migrer vers Workload Identity Federation et substituer roles/editor par un rôle minimal scopé.",
                "Art. 21 §2 (d) & PSSI §4.3 : Exiger par avenant PAS HDS/NIS2 le passage exclusif par bastion Identity-Aware Proxy (IAP) / VPN avec MFA nominatif (suppression de allow-ssh-anywhere 0.0.0.0/0).",
                "Art. 21 §2 (d) — Intégrité contractuelle : Notifier un audit contradictoire sécurité suite à la charge d'injection de prompt détectée dans l'annexe technique MNT-2025-089.",
            ],
        }
    )

    # 2. Infogérance / Prestataire Poste Administratif & Messagerie (différencié AVANT vs APRES via F-004)
    has_f004_incident = (
        "F-004" in by_id and by_id["F-004"].get("statut") != "conforme"
    )
    infogerance_findings = [
        f
        for f in findings
        if str(f.get("id") or "") in {"F-002", "F-004", "F-006"}
        or "compte prestataire" in json.dumps(f, ensure_ascii=False).lower()
    ]
    infogerance_fids = [str(f["id"]) for f in infogerance_findings if f.get("id")]
    if has_f004_incident:
        infogerance_risk = "CRITIQUE"
        infogerance_ctx = (
            "Compromission avérée d'un compte prestataire sur poste administratif en septembre "
            "(interruption messagerie interne d'une demi-journée non qualifiée ni notifiée ANSSI sous 24 h)."
        )
        infogerance_src = "notes_entretien_DSI.md"
    else:
        infogerance_risk = (
            "ÉLEVÉ"
            if any(f.get("statut") != "conforme" for f in infogerance_findings)
            else "MAÎTRISÉ"
        )
        infogerance_ctx = (
            "Accès tiers d'administration & support bureautique exposés par l'ouverture SSH "
            "0.0.0.0/0 et la persistance du compte générique admin-legacy (PSSI §4.1 & §4.2)."
        )
        infogerance_src = "PSSI_CH_Valmont.md"

    vendors.append(
        {
            "id": "SUP-002",
            "name": "Prestataire Support Administratif & Messagerie",
            "provider": "Prestataire Support Administratif & Messagerie",
            "role": "Infogérance Poste de Travail & Messagerie Interne",
            "context": infogerance_ctx,
            "contract_ref": "Convention PAS PSSI §3.3 & §6.2",
            "risk_level": infogerance_risk,
            "finding_ids": infogerance_fids,
            "quarantined": False,
            "quarantine_reason": None,
            "source_document": infogerance_src,
            "recommended_clauses": [
                "Art. 21 §2 (d) & Art. 23 §4 (a) : Imposer contractuellement un SLA d'alerte sécurité <= 4 heures vers l'astreinte RSSI du CH Valmont pour tenir le délai légal d'alerte précoce ANSSI (24 h).",
                "PSSI §4.1 & §4.2 : Interdire tout compte générique partagé (admin-legacy), imposer le MFA matériel sur tout accès distant et révoquer les droits sous 48 h en fin d'intervention.",
            ],
        }
    )

    # 3. Hébergeur Cloud Souverain / Responsabilité Partagée HDS (Google Cloud europe-west9)
    cloud_findings = [
        f
        for f in findings
        if str(f.get("id") or "") in {"F-003", "F-005", "F-007"}
        or any(
            kw in json.dumps(f, ensure_ascii=False).lower()
            for kw in ("backups-dpi", "kms", "logging")
        )
    ]
    cloud_fids = [str(f["id"]) for f in cloud_findings if f.get("id")]
    non_conf_cloud = [f for f in cloud_findings if f.get("statut") != "conforme"]
    if any(f.get("statut") == "non_conforme" for f in non_conf_cloud):
        cloud_risk = "ÉLEVÉ"
    elif non_conf_cloud:
        cloud_risk = "MODÉRÉ"
    else:
        cloud_risk = "MAÎTRISÉ"

    vendors.append(
        {
            "id": "SUP-003",
            "name": "Google Cloud Platform (europe-west9 — Paris)",
            "provider": "Google Cloud Platform (europe-west9 — Paris)",
            "role": "Hébergement Cloud Souverain & Continuité HDS",
            "context": (
                "Matrice de responsabilité partagée HDS/NIS2 — Configuration client des sauvegardes "
                "DPI (WORM), de la rotation cryptographique Cloud KMS et de la rétention Cloud Logging."
            ),
            "contract_ref": "Annexe HDS / Souveraineté PSSI §1.2, §5.2 & §6.1",
            "risk_level": cloud_risk,
            "finding_ids": cloud_fids,
            "quarantined": False,
            "quarantine_reason": None,
            "source_document": "PSSI_CH_Valmont.md",
            "recommended_clauses": [
                "Art. 21 §2 (d) & (c) : Appliquer côté client l'obligation de responsabilité partagée en activant le versioning et le Bucket Lock WORM 30 j sur gs://ch-valmont-demo-backups-dpi.",
                "Art. 21 §2 (d) & (h) : Verrouiller par Organization Policy la localisation europe-west9, activer la rotation KMS 90 j (key-dpi-patients) et porter Cloud Logging _Default à 365 j.",
            ],
        }
    )

    # 4. Détection dynamique de toute pièce additionnelle en quarantaine ou contrat tiers téléversé
    extra_idx = 4
    for d in docs_quar:
        dname = str(d.get("nom_fichier") or "")
        if not dname or dname in handled_doc_names:
            continue
        handled_doc_names.add(dname)
        q_reason = str(
            d.get("raison_quarantaine")
            or d.get("alerte_injection")
            or "Document tiers bloqué en quarantaine anti-injection par le Douanier"
        )
        vendors.append(
            {
                "id": f"SUP-{extra_idx:03d}",
                "name": f"Tiers Documentaire ({dname})",
                "provider": f"Tiers Documentaire ({dname})",
                "role": "Pièce externe / Annexe tierce isolée",
                "context": f"Pièce '{dname}' placée en quarantaine préventive avant soumission LLM.",
                "contract_ref": dname,
                "risk_level": "CRITIQUE",
                "finding_ids": [],
                "quarantined": True,
                "quarantine_reason": q_reason,
                "source_document": dname,
                "recommended_clauses": [
                    "Art. 21 §2 (d) : Bloquer l'intégration documentaire automatisée et conduire une revue contradictoire d'intégrité auprès de l'émetteur tiers.",
                ],
            }
        )
        extra_idx += 1

    counts = {
        "total": len(vendors),
        "critique": sum(1 for v in vendors if v["risk_level"] == "CRITIQUE"),
        "eleve": sum(1 for v in vendors if v["risk_level"] == "ÉLEVÉ"),
        "modere": sum(1 for v in vendors if v["risk_level"] == "MODÉRÉ"),
        "maitrise": sum(1 for v in vendors if v["risk_level"] == "MAÎTRISÉ"),
    }
    overall_risk = (
        max(
            (str(v["risk_level"]) for v in vendors),
            key=lambda r: _SUPPLY_RISK_RANK.get(r, 0),
        )
        if vendors
        else "MAÎTRISÉ"
    )

    return {
        "session_id": session_id,
        "mode": active_mode,
        "has_synthesis": True,
        "article": "Art. 21 §2 (d) — Sécurité de la chaîne d'approvisionnement",
        "pssi_reference": "PSSI §3.3 — Gestion des tiers et sous-traitants (PAS NIS2 / HDS)",
        "source": "server",
        "overall_risk": overall_risk,
        "quarantined_docs_count": len(quarantined_documents),
        "quarantined_documents": quarantined_documents,
        "vendors": vendors,
        "providers": vendors,
        "summary_counts": counts,
    }


def build_continuity_view(
    state: dict[str, Any],
    session_id: str,
    mode: AuditMode | None = None,
) -> dict[str, Any]:
    """Tableau de bord Continuité Clinique PCA/PRA, RTO/RPO & Exposition Rançongiciel (NIS2 Art. 21 §2 c)."""
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    syn = slot.get("synthesis")
    has_synthesis = isinstance(syn, dict)

    if not has_synthesis:
        return {
            "session_id": session_id,
            "mode": active_mode,
            "has_synthesis": False,
            "article": "Art. 21 §2 (c) — Continuité des activités, gestion des sauvegardes et reprise après sinistre",
            "pssi_reference": "PSSI §5.1, §5.2 & §5.3 — Objectifs RTO 4 h / RPO 24 h, sauvegardes 30 j et test PRA annuel",
            "source": "server",
            "overall_risk": "MAÎTRISÉ",
            "overall_exposure": "MAÎTRISÉ",
            "ransomware_readiness": "IMMUTABLE",
            "ransomware_exposed_count": 0,
            "immutable_count": 0,
            "processes": [],
            "summary_counts": {
                "total": 0,
                "immutable": 0,
                "expose": 0,
                "rto_rpo_gaps": 0,
                "critique": 0,
                "eleve": 0,
                "modere": 0,
                "maitrise": 0,
            },
        }

    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    by_id: dict[str, dict[str, Any]] = {
        str(f.get("id")): f for f in findings if f.get("id")
    }
    is_apres = active_mode == "APRES"

    # 1. Processus vital #1 : DPI Patients (Dossier Patient Informatisé, Urgences & Prescriptions)
    f003 = by_id.get("F-003")
    dpi_backup_exposed = bool(f003 and f003.get("statut") != "conforme") or any(
        "backups-dpi" in json.dumps(f, ensure_ascii=False).lower() and f.get("statut") != "conforme"
        for f in findings
    )
    dpi_fids = [
        fid
        for fid in ("F-003", "F-006", "F-007")
        if fid in by_id
    ]
    if not dpi_fids:
        dpi_fids = [
            str(f["id"])
            for f in findings
            if f.get("id")
            and any(
                kw in json.dumps(f, ensure_ascii=False).lower()
                for kw in ("backups-dpi", "sauvegarde", "dpi", "kms")
            )
        ]

    dpi_ransomware = "EXPOSÉ" if dpi_backup_exposed else "IMMUTABLE"
    dpi_risk = "CRITIQUE" if dpi_backup_exposed else "MAÎTRISÉ"
    dpi_context = (
        "Contradiction majeure Dit ≠ Réel : la DSI affirme que « les sauvegardes sont protégées contre les rançongiciels », "
        "alors que gs://ch-valmont-demo-backups-dpi n'a ni Object Versioning ni verrouillage WORM (F-003) et reste accessible "
        "aux comptes sur-privilégiés roles/editor & roles/owner (F-006)."
        if (is_apres and dpi_backup_exposed)
        else (
            "Divergence critique Écrit ≠ Réel face à la PSSI §5.1/§5.2 : le bucket gs://ch-valmont-demo-backups-dpi est dépourvu "
            "de versioning et de politique de rétention verrouillée, et l'exercice PV-PRA-2025-03 n'a pas testé la compromission IAM Cloud."
            if dpi_backup_exposed
            else "Sauvegardes DPI protégées par versioning et verrouillage WORM conformes aux objectifs PSSI §5.1/§5.2."
        )
    )
    dpi_actions = [
        "Activer immédiatement Object Versioning et une rétention WORM verrouillée de 30 jours minimum (2 592 000 s) sur gs://ch-valmont-demo-backups-dpi (F-003).",
        "Activer la rotation automatique à 90 jours de la clé Cloud KMS key-dpi-patients et supprimer les rôles primitifs roles/editor / roles/owner (F-006, F-007).",
        "Exécuter un exercice PRA complet incluant la simulation d'un compte administrateur Cloud compromis et la bascule en mode dégradé papier des soins.",
    ]

    # 2. Processus vital #2 : Imagerie PACS / DICOM
    f005 = by_id.get("F-005")
    f001 = by_id.get("F-001")
    pacs_archive_immutable = (f005 is None) or (f005.get("statut") == "conforme")
    pacs_export_exposed = bool(f001 and f001.get("statut") != "conforme")
    pacs_fids = [fid for fid in ("F-005", "F-001") if fid in by_id]
    pacs_ransomware = "IMMUTABLE" if pacs_archive_immutable else "EXPOSÉ"
    pacs_risk = (
        "CRITIQUE"
        if not pacs_archive_immutable
        else ("MODÉRÉ" if pacs_export_exposed or f005 is not None else "MAÎTRISÉ")
    )
    pacs_actions = [
        "Étendre l'exercice PRA annuel S1 2026 au périmètre PACS/DICOM (exclu du test PV-PRA-2025-03 du 18/03/2025) afin de qualifier le RTO réel face à la cible de 4 h (PSSI §5.3).",
        "Maintenir le verrouillage WORM 365 jours et la rotation KMS 90 jours sur gs://ch-valmont-demo-archives-pacs (F-005) et révoquer l'exposition publique allUsers sur export-radiologie (F-001).",
    ]

    # 3. Processus vital #3 : Messagerie & Postes Administratifs (différencié AVANT vs APRES via F-004)
    has_f004_outage = "F-004" in by_id and by_id["F-004"].get("statut") != "conforme"
    admin_exposed = bool(
        has_f004_outage
        or any(
            fid in by_id and by_id[fid].get("statut") != "conforme"
            for fid in ("F-002", "F-006", "F-007")
        )
    )
    msg_fids = [
        fid
        for fid in (("F-004", "F-002", "F-006", "F-007") if has_f004_outage else ("F-002", "F-006", "F-007"))
        if fid in by_id
    ]
    msg_ransomware = "EXPOSÉ" if admin_exposed else "IMMUTABLE"
    if has_f004_outage:
        msg_risk = "CRITIQUE"
        msg_rto_actual = "Indisponibilité réelle d'une demi-journée (~4 h–6 h) subie en septembre (F-004)"
        msg_rto_gap = (
            "Incident réel survenu en septembre (compromission d'un compte prestataire sur poste administratif) "
            "ayant interrompu la messagerie sans déclenchement du PCA ni alerte précoce ANSSI sous 24 h (F-004)."
        )
        msg_rpo_actual = "Traces Cloud Logging de septembre purgées (> 30 j sur _Default — F-007)"
        msg_rpo_gap = "Perte des preuves forensiques au-delà de 30 jours, en violation directe des 12 mois exigés par la PSSI §6.1."
        msg_context = (
            "Sinistre réel avéré en entretien (F-004) : compromission d'un compte prestataire sur poste administratif en septembre "
            "ayant coupé la messagerie interne une demi-journée, combinée à l'exposition SSH 0.0.0.0/0 (F-002) et à la purge des journaux à 30 j (F-007)."
        )
    else:
        msg_risk = "ÉLEVÉ" if admin_exposed else "MAÎTRISÉ"
        msg_rto_actual = "Non qualifié (aucun test PCA messagerie / bureautique documenté)"
        msg_rto_gap = (
            "Surface de mouvement latéral ouverte (SSH 0.0.0.0/0 F-002 + clés statiques 248 j F-006) menaçant la messagerie de crise."
        )
        msg_rpo_actual = "Rétention forensique plafonnée à 30 jours sur Cloud Logging _Default (F-007)"
        msg_rpo_gap = "Écart PSSI §6.1 : rétention de 30 jours insuffisante pour investiguer une compromission latente (cible : 365 jours)."
        msg_context = (
            "Exposition élevée des postes d'administration et de la messagerie interne via allow-ssh-anywhere (0.0.0.0/0, F-002), "
            "comptes à privilèges excessifs (F-006) et rétention de journaux limitée à 30 jours (F-007)."
        )

    msg_actions = [
        "Déployer un canal de communication de crise hors-bande indépendant de la messagerie interne et appliquer la grille de notification ANSSI 24 h / 72 h / 1 mois (Art. 23 NIS2 — F-004).",
        "Restreindre SSH au bastion IAP 35.235.240.0/20 (F-002), révoquer la clé statique prestataire de 248 j ainsi que admin-legacy (F-006) et porter Cloud Logging _Default à 365 jours (F-007).",
        "Inscrire un exercice annuel de continuité messagerie & confinement de poste administratif compromis au calendrier PCA/PRA.",
    ]

    processes: list[dict[str, Any]] = [
        {
            "id": "PROC-001",
            "name": "DPI Patients",
            "criticality": "VITALE — Soins critiques, Urgences & Prescriptions (620 lits)",
            "pssi_ref": "PSSI §5.1, §5.2 & §5.3",
            "context": dpi_context,
            "backup_resource": "gs://ch-valmont-demo-backups-dpi",
            "rto_target": "4 h (PSSI §5.1)",
            "rto_actual": (
                "> 72 h sous rançongiciel (2 h 15 hors attaque sur pré-prod — PV-PRA-2025-03)"
                if dpi_backup_exposed
                else "2 h 15 validé (PV-PRA-2025-03)"
            ),
            "rto_gap": bool(dpi_backup_exposed),
            "rto_gap_detail": (
                "Test PRA du 18/03/2025 mené sans scénario de compromission IAM ni verrouillage WORM : reconstruction complète requise en cas de wiper."
                if dpi_backup_exposed
                else "Conforme au RTO cible de 4 h."
            ),
            "rto_compliant": not dpi_backup_exposed,
            "rpo_target": "24 h (PSSI §5.1 — rétention 30 j §5.2)",
            "rpo_actual": (
                "Perte totale possible (> 30 j) — versioning & Bucket Lock désactivés"
                if dpi_backup_exposed
                else "≤ 24 h (sauvegardes immuables 30 j)"
            ),
            "rpo_gap": bool(dpi_backup_exposed),
            "rpo_gap_detail": (
                "Bucket gs://ch-valmont-demo-backups-dpi supprimable par tout compte roles/editor ou roles/owner compromis (F-003, F-006)."
                if dpi_backup_exposed
                else "Conforme au RPO cible de 24 h."
            ),
            "rpo_compliant": not dpi_backup_exposed,
            "ransomware_status": dpi_ransomware,
            "exposure_level": dpi_risk,
            "risk_level": dpi_risk,
            "pca_pra_exposure": dpi_risk,
            "last_test_ref": "PV-PRA-2025-03 (18 mars 2025 — pré-prod DPI, hors scénario ransomware)",
            "pra_last_tested": "18 mars 2025 (PV-PRA-2025-03 — pré-prod DPI uniquement, sans scénario ransomware)",
            "finding_ids": dpi_fids,
            "pra_actions": dpi_actions,
            "required_pra_actions": dpi_actions,
            "recommended_actions": dpi_actions,
        },
        {
            "id": "PROC-002",
            "name": "Imagerie PACS / DICOM",
            "criticality": "ESSENTIELLE — Diagnostic Médico-Technique & Archives Radiologie",
            "pssi_ref": "PSSI §3.1, §5.1 & §5.3",
            "context": (
                "Le stockage d'archives gs://ch-valmont-demo-archives-pacs est protégé par versioning et rétention WORM verrouillée 365 j (témoin conforme F-005), "
                "mais la reprise PACS n'a pas été testée lors de l'exercice PV-PRA-2025-03 et le bucket d'échange export-radiologie est exposé à allUsers (F-001)."
            ),
            "backup_resource": "gs://ch-valmont-demo-archives-pacs",
            "rto_target": "4 h (PSSI §5.1)",
            "rto_actual": "Non démontré (périmètre PACS exclu du test PV-PRA-2025-03)",
            "rto_gap": True,
            "rto_gap_detail": "Temps de remontée d'un volume DICOM complet non mesuré en 2025 (écart PSSI §5.3).",
            "rto_compliant": False,
            "rpo_target": "24 h (PSSI §5.1)",
            "rpo_actual": (
                "≤ 24 h (versioning actif + rétention WORM verrouillée 365 j — F-005)"
                if pacs_archive_immutable
                else "Exposé (verrouillage absent)"
            ),
            "rpo_gap": not pacs_archive_immutable,
            "rpo_gap_detail": (
                "Immutabilité WORM 365 j conforme sur archives-pacs ; cloisonner le bucket secondaire export-radiologie (F-001)."
                if pacs_archive_immutable
                else "Absence d'immutabilité WORM."
            ),
            "rpo_compliant": pacs_archive_immutable,
            "ransomware_status": pacs_ransomware,
            "exposure_level": pacs_risk,
            "risk_level": pacs_risk,
            "pca_pra_exposure": pacs_risk,
            "last_test_ref": "Non testé en 2025 (exclu de PV-PRA-2025-03 — planifié S1 2026)",
            "pra_last_tested": "Non testé en 2025 (exclu de PV-PRA-2025-03 — planifié S1 2026)",
            "finding_ids": pacs_fids,
            "pra_actions": pacs_actions,
            "required_pra_actions": pacs_actions,
            "recommended_actions": pacs_actions,
        },
        {
            "id": "PROC-003",
            "name": "Messagerie & Postes Administratifs",
            "criticality": "IMPORTANTE — Coordination Cellule de Crise, Admissions & Support",
            "pssi_ref": "PSSI §4.3, §5.1, §6.1 & §6.2",
            "context": msg_context,
            "backup_resource": "compute/firewalls/allow-ssh-anywhere & logging/buckets/_Default",
            "rto_target": "4 h (Coordination crise & alerte ANSSI < 24 h — PSSI §5.1 & §6.2)",
            "rto_actual": msg_rto_actual,
            "rto_gap": bool(admin_exposed),
            "rto_gap_detail": msg_rto_gap,
            "rto_compliant": not admin_exposed,
            "rpo_target": "24 h / Conservation forensique 365 j (PSSI §6.1)",
            "rpo_actual": msg_rpo_actual,
            "rpo_gap": bool(admin_exposed),
            "rpo_gap_detail": msg_rpo_gap,
            "rpo_compliant": not admin_exposed,
            "ransomware_status": msg_ransomware,
            "exposure_level": msg_risk,
            "risk_level": msg_risk,
            "pca_pra_exposure": msg_risk,
            "last_test_ref": "Aucun exercice PCA hors-bande documenté",
            "pra_last_tested": "Aucun exercice PCA hors-bande documenté",
            "finding_ids": msg_fids,
            "pra_actions": msg_actions,
            "required_pra_actions": msg_actions,
            "recommended_actions": msg_actions,
        },
    ]

    summary_counts = {
        "total": len(processes),
        "immutable": sum(1 for p in processes if p["ransomware_status"] == "IMMUTABLE"),
        "expose": sum(1 for p in processes if p["ransomware_status"] == "EXPOSÉ"),
        "rto_rpo_gaps": sum(1 for p in processes if p["rto_gap"] or p["rpo_gap"]),
        "critique": sum(1 for p in processes if p["exposure_level"] == "CRITIQUE"),
        "eleve": sum(1 for p in processes if p["exposure_level"] == "ÉLEVÉ"),
        "modere": sum(1 for p in processes if p["exposure_level"] == "MODÉRÉ"),
        "maitrise": sum(1 for p in processes if p["exposure_level"] == "MAÎTRISÉ"),
    }
    if summary_counts["critique"] > 0:
        overall_risk = "CRITIQUE"
    elif summary_counts["eleve"] > 0:
        overall_risk = "ÉLEVÉ"
    elif summary_counts["modere"] > 0:
        overall_risk = "MODÉRÉ"
    else:
        overall_risk = "MAÎTRISÉ"

    ransomware_readiness = "EXPOSÉ" if summary_counts["expose"] > 0 else "IMMUTABLE"

    return {
        "session_id": session_id,
        "mode": active_mode,
        "has_synthesis": True,
        "article": "Art. 21 §2 (c) — Continuité des activités, gestion des sauvegardes et reprise après sinistre",
        "pssi_reference": "PSSI §5.1, §5.2 & §5.3 — Objectifs RTO 4 h / RPO 24 h, sauvegardes 30 j et test PRA annuel",
        "source": "server",
        "overall_risk": overall_risk,
        "overall_exposure": overall_risk,
        "ransomware_readiness": ransomware_readiness,
        "ransomware_exposed_count": summary_counts["expose"],
        "immutable_count": summary_counts["immutable"],
        "processes": processes,
        "summary_counts": summary_counts,
    }


def build_crosswalk_view(
    state: dict[str, Any],
    session_id: str,
    mode: AuditMode | None = None,
) -> dict[str, Any]:
    """Table de correspondance multi-référentiels Santé : NIS2 ↔ HDS v2.0 ↔ ISO/IEC 27001:2022 ↔ RGPD Art. 32/33."""
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    syn = slot.get("synthesis")
    report_title = (
        "Correspondance Multi-Référentiels Santé — NIS2 ↔ HDS v2.0 ↔ ISO/IEC 27001:2022 ↔ RGPD Art. 32/33"
    )
    framework_labels: dict[str, str] = {
        "HDS": "Hébergeur de Données de Santé (HDS v2.0)",
        "ISO27001": "ISO/IEC 27001:2022 (Annexe A)",
        "RGPD": "RGPD (Art. 28, 32, 33 & 34 — Données de Santé)",
    }

    if not isinstance(syn, dict):
        empty_fw = {
            fw_key: {
                "framework": fw_key,
                "label": fw_label,
                "total_controls": 0,
                "compliant_count": 0,
                "gap_count": 0,
                "conformity_pct": 0,
                "status_label": "EN ATTENTE D'AUDIT",
            }
            for fw_key, fw_label in framework_labels.items()
        }
        return {
            "session_id": session_id,
            "mode": active_mode,
            "has_synthesis": False,
            "source": "server",
            "title": report_title,
            "frameworks_summary": empty_fw,
            "entries": [],
            "summary_counts": {
                "total": 0,
                "gaps": 0,
                "conforme": 0,
                "non_conforme": 0,
                "partiel": 0,
                "a_confirmer": 0,
            },
        }

    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    by_id: dict[str, dict[str, Any]] = {
        str(f.get("id")): f for f in findings if f.get("id")
    }
    nis2_reqs = {
        str(r.get("id")): r
        for r in get_nis2_requirements()
        if isinstance(r, dict) and r.get("id")
    }

    def _norm_status(fid: str, default_status: str) -> str:
        f = by_id.get(fid)
        if not f:
            return default_status
        raw = str(f.get("statut") or "").strip().lower()
        if raw in {"conforme", "partiel", "non_conforme", "a_confirmer"}:
            return raw
        return default_status

    def _norm_gravite(fid: str, default_gravite: str) -> str:
        f = by_id.get(fid)
        if not f:
            return default_gravite
        raw = str(f.get("gravite") or "").strip().lower()
        if raw in {"critique", "haute", "moyenne", "faible"}:
            return raw
        return default_gravite

    def _present_fids(*candidates: str) -> list[str]:
        return [cid for cid in candidates if cid in by_id]

    is_apres = active_mode == "APRES" or "F-004" in by_id
    r23_title = str(
        (nis2_reqs.get("NIS2-23") or {}).get("titre")
        or "Obligations de déclaration d'incident (24h alerte précoce, 72h notification)"
    )

    if is_apres:
        cw8_statut = _norm_status("F-004", "non_conforme")
        cw8_gravite = _norm_gravite("F-004", "haute")
        cw8_fids = _present_fids("F-004") or ["F-004"]
        cw8_summary = (
            "Compromission d'un compte de messagerie prestataire reconnue à l'oral en septembre (F-004) "
            "sans trace de pré-notification ANSSI (< 24 h) ni d'instruction contradictoire DPO / CNIL (< 72 h, RGPD Art. 33)."
        )
    else:
        cw8_statut = "a_confirmer"
        cw8_gravite = "moyenne"
        cw8_fids = []
        cw8_summary = (
            "Procédure écrite d'alerte ANSSI < 24 h (PSSI §6.2) présente au dossier ; effectivité opérationnelle "
            "du double guichet ANSSI / CNIL (RGPD Art. 33) et absence d'incident antérieur à vérifier en entretien contradictoire."
        )

    entries: list[dict[str, Any]] = [
        {
            "id": "CW-001",
            "nis2_article": "Art. 21 §2 (i) & (j)",
            "nis2_title": "Contrôle d'accès, sécurité des actifs et protection des données sensibles",
            "domain": "Cloisonnement Stockage Cloud & Imagerie Médicale (DSCP)",
            "hds_ref": "HDS v2.0 Exigences 4.2 & 4.5",
            "hds_detail": (
                "Cloisonnement strict des compartiments contenant des données de santé à caractère personnel "
                "(DSCP) et interdiction absolue d'exposition publique non authentifiée."
            ),
            "iso27001_ref": "Annexe A.5.15, A.8.3 & A.8.24",
            "iso27001_detail": (
                "Contrôle d'accès logique, restriction d'accès à l'information et protection des compartiments d'échange."
            ),
            "rgpd_ref": "RGPD Art. 9 & Art. 32 §1 (a)(b)",
            "rgpd_detail": (
                "Confidentialité des données concernant la santé : exposition publique allUsers sur "
                "gs://ch-valmont-demo-export-radiologie constitutive d'un risque de violation notifiable (Art. 33)."
            ),
            "frameworks": ["HDS", "ISO27001", "RGPD"],
            "statut": _norm_status("F-001", "non_conforme"),
            "gravite": _norm_gravite("F-001", "critique"),
            "summary": (
                "Compartiment d'export radiologique exposé publiquement sur Internet (allUsers : objectViewer) "
                "en contradiction directe avec la PSSI §3.1, le référentiel HDS et l'Art. 32 RGPD."
            ),
            "finding_ids": _present_fids("F-001"),
            "cnil_applicable": True,
        },
        {
            "id": "CW-002",
            "nis2_article": "Art. 21 §2 (e) & (j)",
            "nis2_title": "Sécurité de l'exploitation réseau et authentification multifacteur (MFA)",
            "domain": "Filtrage Réseau Périmétrique & Bastion d'Administration",
            "hds_ref": "HDS v2.0 Exigence 4.4",
            "hds_detail": (
                "Restriction des flux d'administration système aux rebonds authentifiés (IAP / Bastion MFA) "
                "et proscription d'ouverture SSH directe sur Internet."
            ),
            "iso27001_ref": "Annexe A.8.5, A.8.20 & A.8.22",
            "iso27001_detail": (
                "Authentification sécurisée des administrateurs, sécurité des réseaux et ségrégation des flux."
            ),
            "rgpd_ref": "RGPD Art. 32 §1 (b) (périmètre infrastructure)",
            "rgpd_detail": (
                "Durcissement périmétrique concourant à la protection indirecte des serveurs hospitaliers."
            ),
            "frameworks": ["HDS", "ISO27001"],
            "statut": _norm_status("F-002", "non_conforme"),
            "gravite": _norm_gravite("F-002", "critique"),
            "summary": (
                "Règle pare-feu allow-ssh-anywhere ouverte sur 0.0.0.0/0:22 en production malgré l'interdiction "
                "formelle de la PSSI §4.2 et l'obligation de rebond MFA."
            ),
            "finding_ids": _present_fids("F-002"),
            "cnil_applicable": False,
        },
        {
            "id": "CW-003",
            "nis2_article": "Art. 21 §2 (c)",
            "nis2_title": "Continuité des activités, gestion des sauvegardes et reprise après sinistre",
            "domain": "Résilience du DPI Patients & Protection Anti-Rançongiciel",
            "hds_ref": "HDS v2.0 Exigence 4.7",
            "hds_detail": (
                "Disponibilité garantie des DSCP, sauvegardes immuables (versioning + WORM) et tests réguliers de restauration."
            ),
            "iso27001_ref": "Annexe A.5.29, A.5.30 & A.8.13",
            "iso27001_detail": (
                "Préparation des TIC pour la continuité des soins (RTO 4 h / RPO 24 h) et sauvegarde intègre."
            ),
            "rgpd_ref": "RGPD Art. 32 §1 (c) & (d)",
            "rgpd_detail": (
                "Capacité à rétablir la disponibilité et l'accès aux dossiers patients dans des délais appropriés "
                "en cas d'incident physique ou technique (rançongiciel)."
            ),
            "frameworks": ["HDS", "ISO27001", "RGPD"],
            "statut": _norm_status("F-003", "non_conforme"),
            "gravite": _norm_gravite("F-003", "haute"),
            "summary": (
                "Bucket gs://ch-valmont-demo-backup-dpi dépourvu de versioning et de rétention WORM (7 j glissants), "
                "avec dépassement RTO 6h20 lors du test PV-PRA-2025-03 (cible PSSI 4 h)."
            ),
            "finding_ids": _present_fids("F-003"),
            "cnil_applicable": False,
        },
        {
            "id": "CW-004",
            "nis2_article": "Art. 21 §2 (c) & (f)",
            "nis2_title": "Protection de l'intégrité des archives critiques et évaluation d'efficacité",
            "domain": "Archivage Immuable Imagerie PACS / DICOM (Témoin Conforme)",
            "hds_ref": "HDS v2.0 Exigence 4.7.2",
            "hds_detail": (
                "Conservation intègre et verrouillage WORM 365 jours vérifiés sur gs://ch-valmont-demo-archives-pacs."
            ),
            "iso27001_ref": "Annexe A.5.33 & A.8.13",
            "iso27001_detail": (
                "Protection probante des enregistrements médicaux contre la destruction ou la falsification."
            ),
            "rgpd_ref": "RGPD Art. 5 §1 (f) & Art. 32 §1 (b)",
            "rgpd_detail": (
                "Intégrité permanente des archives d'imagerie médicale garantie par politique de rétention verrouillée."
            ),
            "frameworks": ["HDS", "ISO27001", "RGPD"],
            "statut": _norm_status("F-005", "conforme"),
            "gravite": _norm_gravite("F-005", "faible"),
            "summary": (
                "Contrôle témoin positif : versioning actif et rétention WORM verrouillée 365 jours confirmés "
                "sur le compartiment d'archives PACS (F-005)."
            ),
            "finding_ids": _present_fids("F-005"),
            "cnil_applicable": False,
        },
        {
            "id": "CW-005",
            "nis2_article": "Art. 21 §2 (d) & (i)",
            "nis2_title": "Sécurité de la chaîne d'approvisionnement et moindre privilège IAM",
            "domain": "Gouvernance des Sous-Traitants Tiers & Comptes à Privilèges",
            "hds_ref": "HDS v2.0 Exigences 5.1 & 6.2",
            "hds_detail": (
                "Maîtrise contractuelle des sous-traitants intervenant sur le SI hospitalier et bannissement des droits primitifs permanents."
            ),
            "iso27001_ref": "Annexe A.5.19, A.5.21 & A.8.2",
            "iso27001_detail": (
                "Sécurité de l'information dans les relations fournisseurs et restriction des privilèges d'administration."
            ),
            "rgpd_ref": "RGPD Art. 28 & Art. 32 §4",
            "rgpd_detail": (
                "Encadrement écrit obligatoire du sous-traitant MedSoft (Art. 28 RGPD) et limitation stricte des accès tiers aux DSCP."
            ),
            "frameworks": ["HDS", "ISO27001", "RGPD"],
            "statut": _norm_status("F-006", "non_conforme"),
            "gravite": _norm_gravite("F-006", "haute"),
            "summary": (
                "Compte prestataire externe svc-medsoft-maint doté du rôle primitif roles/owner à l'échelle projet "
                "et absent du registre officiel des tiers autorisés."
            ),
            "finding_ids": _present_fids("F-006"),
            "cnil_applicable": True,
        },
        {
            "id": "CW-006",
            "nis2_article": "Art. 21 §2 (h)",
            "nis2_title": "Politiques et procédures relatives à l'utilisation de la cryptographie",
            "domain": "Souveraineté Cryptographique KMS & Clés CMEK",
            "hds_ref": "HDS v2.0 Exigence 4.6",
            "hds_detail": (
                "Maîtrise souveraine du cycle de vie des clés cryptographiques protégeant les compartiments HDS."
            ),
            "iso27001_ref": "Annexe A.8.24",
            "iso27001_detail": (
                "Règles d'utilisation efficace de la cryptographie et rotation périodique des clés (90 jours)."
            ),
            "rgpd_ref": "RGPD Art. 32 §1 (a) & Art. 34 §3 (a)",
            "rgpd_detail": (
                "Le chiffrement CMEK conditionne l'exemption éventuelle de communication individuelle aux patients (Art. 34 §3 a)."
            ),
            "frameworks": ["HDS", "ISO27001"],
            "statut": _norm_status("F-007", "partiel"),
            "gravite": _norm_gravite("F-007", "moyenne"),
            "summary": (
                "Rotation automatique KMS 90 jours conforme sur key-dossier-patient, mais chiffrement Google-managed par défaut "
                "sur plusieurs compartiments de stockage au lieu d'un attachement CMEK systématique."
            ),
            "finding_ids": _present_fids("F-007"),
            "cnil_applicable": False,
        },
        {
            "id": "CW-007",
            "nis2_article": "Art. 21 §2 (f) & Art. 23",
            "nis2_title": "Journalisation forensique d'audit et capacité d'investigation",
            "domain": "Traçabilité Forensique 365 Jours & Qualification d'Exfiltration",
            "hds_ref": "HDS v2.0 Exigence 4.8",
            "hds_detail": (
                "Conservation intègre des traces d'accès et d'administration permettant l'imputabilité et l'analyse post-incident."
            ),
            "iso27001_ref": "Annexe A.8.15 & A.5.28",
            "iso27001_detail": (
                "Production, protection et rétention sur 12 mois des journaux d'événements et collecte de preuves."
            ),
            "rgpd_ref": "RGPD Art. 5 §2 & Art. 33 §3",
            "rgpd_detail": (
                "Principe d'Accountability : une rétention limitée à 30 j empêche d'écarter formellement une exfiltration antérieure sur le bucket public."
            ),
            "frameworks": ["HDS", "ISO27001", "RGPD"],
            "statut": "conforme" if _norm_status("F-007", "partiel") == "conforme" else "non_conforme",
            "gravite": _norm_gravite("F-007", "moyenne"),
            "summary": (
                "Puits Cloud Logging _Default plafonné à 30 jours non verrouillés contre les 365 jours exigés par la PSSI §6.1, "
                "limitant la fenêtre d'investigation forensique RGPD Art. 33."
            ),
            "finding_ids": _present_fids("F-007"),
            "cnil_applicable": True,
        },
        {
            "id": "CW-008",
            "nis2_article": "Art. 23 §1 & §4 + Art. 21 §2 (b)",
            "nis2_title": r23_title,
            "domain": "Double Guichet Réglementaire — ANSSI (24h/72h) & CNIL (72h)",
            "hds_ref": "HDS v2.0 Exigence 5.4",
            "hds_detail": (
                "Notification sans délai au responsable de traitement hospitalier de tout incident affectant les DSCP."
            ),
            "iso27001_ref": "Annexe A.5.24, A.5.25 & A.5.26",
            "iso27001_detail": (
                "Évaluation formelle des événements de sécurité et exécution documentée des procédures d'escalade réglementaire."
            ),
            "rgpd_ref": "RGPD Art. 33 (72 h CNIL) & Art. 34",
            "rgpd_detail": (
                "Notification à la CNIL sous 72 h de toute violation de données présentant un risque pour les patients (avec motivation du retard si > 72 h) et évaluation Art. 34."
            ),
            "frameworks": ["ISO27001", "RGPD"],
            "statut": cw8_statut,
            "gravite": cw8_gravite,
            "summary": cw8_summary,
            "finding_ids": cw8_fids,
            "cnil_applicable": True,
        },
    ]

    frameworks_summary: dict[str, dict[str, Any]] = {}
    for fw_key, fw_label in framework_labels.items():
        fw_entries = [e for e in entries if fw_key in e["frameworks"]]
        total_fw = len(fw_entries)
        compliant_fw = sum(1 for e in fw_entries if e["statut"] == "conforme")
        partiel_fw = sum(1 for e in fw_entries if e["statut"] == "partiel")
        non_conf_fw = sum(1 for e in fw_entries if e["statut"] == "non_conforme")
        a_conf_fw = sum(1 for e in fw_entries if e["statut"] == "a_confirmer")
        gap_fw = non_conf_fw + partiel_fw
        if total_fw > 0:
            weighted = compliant_fw + (0.5 * partiel_fw) + (0.25 * a_conf_fw)
            pct = int(round((weighted / total_fw) * 100))
        else:
            pct = 0
        if non_conf_fw > 0:
            status_lbl = f"NON CONFORME ({gap_fw} écart{'s' if gap_fw > 1 else ''})"
        elif partiel_fw > 0 or a_conf_fw > 0:
            status_lbl = "CONFORMITÉ PARTIELLE"
        else:
            status_lbl = "CONFORME ✓"
        frameworks_summary[fw_key] = {
            "framework": fw_key,
            "label": fw_label,
            "total_controls": total_fw,
            "compliant_count": compliant_fw,
            "gap_count": gap_fw,
            "conformity_pct": pct,
            "status_label": status_lbl,
        }

    conforme_cnt = sum(1 for e in entries if e["statut"] == "conforme")
    non_conforme_cnt = sum(1 for e in entries if e["statut"] == "non_conforme")
    partiel_cnt = sum(1 for e in entries if e["statut"] == "partiel")
    a_confirmer_cnt = sum(1 for e in entries if e["statut"] == "a_confirmer")

    return {
        "session_id": session_id,
        "mode": active_mode,
        "has_synthesis": True,
        "source": "server",
        "title": report_title,
        "frameworks_summary": frameworks_summary,
        "entries": entries,
        "summary_counts": {
            "total": len(entries),
            "gaps": non_conforme_cnt + partiel_cnt,
            "conforme": conforme_cnt,
            "non_conforme": non_conforme_cnt,
            "partiel": partiel_cnt,
            "a_confirmer": a_confirmer_cnt,
        },
    }
