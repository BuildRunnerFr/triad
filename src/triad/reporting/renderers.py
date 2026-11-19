"""Rendu des 12 livrables d'audit (Markdown, CSV, HCL, Shell dry-run, JSON scellé) — fonctions pures."""

from __future__ import annotations

import csv
import io
import re
from datetime import datetime, timezone
from typing import Any

from triad.api.session_store import (
    VALID_GRC_DECISIONS,
)
from triad.models import AuditMode
from triad.reporting.scoring import compute_nis2_score, compute_remediation_simulation
from triad.security.audit_log import (
    GENESIS_HASH,
)


def render_report_markdown(syn: dict[str, Any]) -> str:
    lines = [
        f"# Rapport d'audit NIS2 — {syn.get('client', 'Client')}",
        f"**Mode :** {syn.get('mode')} | **Statut :** {syn.get('statut_validation')}",
        "",
        "## Top 3 Risques",
    ]
    for r in syn.get("top_3_risques", []):
        lines.append(f"- {r}")
    lines.append("\n## Matrice Dit / Écrit / Réel")
    for f in syn.get("findings", []):
        lines.append(
            f"### {f['id']} — {f['theme']} ({f['statut'].upper()} | {f['gravite'].upper()})"
        )
        lines.append(f"- **Exigence :** {f['exigence_nis2']}")
        if f.get("dit"):
            lines.append(f"- **Dit ({f['dit']['source']}) :** « {f['dit']['extrait']} »")
        if f.get("ecrit"):
            lines.append(
                f"- **Écrit ({f['ecrit']['source']} {f['ecrit'].get('section', '')}) :** « {f['ecrit']['extrait']} »"
            )
        if f.get("reel"):
            lines.append(
                f"- **Réel ({f['reel']['ressource']}) :** {f['reel']['constat']}"
            )
        lines.append(f"- **Recommandation :** {f['recommandation']}")
        if f.get("commande_correction"):
            lines.append(f"- **Correction proposée :** `{f['commande_correction']}`")
        dec = f.get("decision_grc")
        if isinstance(dec, dict) and dec.get("decision"):
            dec_label = dec.get("decision_label") or dec.get("decision")
            porteur_txt = dec.get("porteur") or "Non renseigné"
            echeance_txt = dec.get("echeance") or "Non définie"
            comm_txt = f" — Note : {dec['commentaire']}" if dec.get("commentaire") else ""
            lines.append(
                f"- **Décision d'arbitrage GRC :** {dec_label} (`{dec['decision']}`) "
                f"— Porteur : {porteur_txt} | Échéance : {echeance_txt}{comm_txt}"
            )
        lines.append("")
    return "\n".join(lines)


def render_anssi_draft_markdown(
    session_id: str,
    active_mode: AuditMode,
    slot: dict[str, Any],
    syn: dict[str, Any],
    chain_info: dict[str, Any],
    head_hash: str,
) -> str:
    """Génère le brouillon structuré de pré-notification ANSSI conforme aux 3 jalons Art. 23 §4 NIS2."""
    now_iso = datetime.now(timezone.utc).isoformat()
    client_name = syn.get("client", "Centre Hospitalier de Valmont")
    statut_val = syn.get("statut_validation", "VALIDÉ")
    chain_label = "VALIDE" if chain_info.get("valide") else "ALTÉRÉE"
    nb_entrees = chain_info.get("nb_entrees", 0)

    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    non_conformes = [f for f in findings if f.get("statut") != "conforme"]
    critiques_et_hautes = [
        f
        for f in non_conformes
        if f.get("gravite") in {"critique", "haute"}
        or "23" in str(f.get("exigence_nis2") or "")
    ]
    focus_findings = critiques_et_hautes or non_conformes

    has_public_exposure = any(
        "allusers" in f"{(f.get('reel') or {}).get('constat', '')} {f.get('commande_correction', '')}".lower()
        for f in focus_findings
    )
    has_unreported_incident = any(
        "23" in str(f.get("exigence_nis2") or "") and f.get("statut") == "non_conforme"
        for f in focus_findings
    )

    lines: list[str] = [
        "# Brouillon de Pré-Notification Réglementaire ANSSI — Article 23 NIS2",
        f"## {client_name} (*Entité Essentielle — Annexe I, Secteur Santé*)",
        "",
        "> **AVERTISSEMENT RÉGLEMENTAIRE (BROUILLON PRÉPARATOIRE — AUCUN ENVOI AUTOMATIQUE)**  ",
        "> Ce document préparatoire a été assemblé après validation humaine du consultant cyber.  ",
        "> Aucune déclaration automatique n'est transmise à l'ANSSI (*MonEspaceNIS2*) ni au *CERT Santé* par les agents IA.",
        "",
        "### Métadonnées & Scellement Cryptographique",
        f"- **Entité concernée :** {client_name}",
        "- **Cadre légal :** Directive (UE) 2022/2555 (NIS2) — Article 23 §1 & §4 (Obligations de notification en trois étapes)",
        "- **Autorités destinataires :** ANSSI (Autorité nationale cyber) & CERT Santé (appui sectoriel santé)",
        f"- **Mode d'audit / Statut :** `{active_mode}` | `{statut_val}`",
        f"- **Session / Run ID :** `{session_id}` / `{slot.get('run_id') or 'n/a'}`",
        f"- **Empreinte SHA-256 (`head_hash`) :** `{head_hash}`",
        f"- **Intégrité de la chaîne d'audit :** {chain_label} ({nb_entrees} maillons vérifiés)",
        f"- **Date de génération (UTC) :** {now_iso}",
        "",
        "---",
        "",
        "## 1. Jalon 1 — Alerte Précoce sous 24 heures (*Art. 23 §4 a NIS2*)",
        "**Objectif réglementaire :** Signaler sans retard injustifié, et au plus tard dans les **24 heures** suivant la prise de connaissance, tout incident ou exposition significative affectant la disponibilité, l'authenticité, l'intégrité ou la confidentialité des services de santé.",
        "",
        "### 1.1 Qualification préliminaire",
        f"- **Nombre d'écarts significatifs relevés :** {len(focus_findings)} constat(s) prioritaire(s) sur {len(findings)} contrôles audités.",
        (
            "- **Suspicion d'acte malveillant / illicite :** **OUI / À CONFIRMER EN FORENSIQUE** "
            "(indice d'incident antérieur non notifié et/ou exposition directe sur Internet relevés lors du croisement *Dit / Écrit / Réel*)."
            if (has_unreported_incident or has_public_exposure)
            else "- **Suspicion d'acte malveillant / illicite :** À évaluer par le SOC / CERT interne lors de la qualification initiale."
        ),
        "- **Impact transfrontalier potentiel :** Faible à modéré (hébergement cloud régional `europe-west9`, vérification d'éventuels accès externes hors frontières en cours).",
        "- **Point de contact déclarant (RSSI / DSI) :** `[À COMPLÉTER AVANT DÉPÔT SUR MONESPACENIS2]`",
        "",
        "### 1.2 Faits déclencheurs immédiats",
    ]

    if focus_findings:
        for f in focus_findings:
            fid = f.get("id", "F-XXX")
            grav = str(f.get("gravite", "")).upper()
            theme = f.get("theme", "")
            reel = f.get("reel") if isinstance(f.get("reel"), dict) else {}
            dit = f.get("dit") if isinstance(f.get("dit"), dict) else {}
            resume = (
                reel.get("constat")
                or dit.get("extrait")
                or f.get("recommandation")
                or "Écart non conforme identifié."
            )
            lines.append(f"- **[{fid} — {grav}] {theme} :** {resume}")
    else:
        lines.append("- Aucun écart critique ou non conforme majeur déclenchant une alerte immédiate.")

    lines.extend(
        [
            "",
            "---",
            "",
            "## 2. Jalon 2 — Notification d'Évaluation sous 72 heures (*Art. 23 §4 b NIS2*)",
            "**Objectif réglementaire :** Mettre à jour l'alerte précoce dans les **72 heures** avec une évaluation initiale de la gravité, de l'impact sur les services essentiels (DPI, PACS, messagerie clinique), des indicateurs techniques et des mesures de confinement engagées.",
            "",
            "### 2.1 Évaluation technique détaillée (*Croisement Dit / Écrit / Réel*)",
        ]
    )

    if non_conformes:
        for f in non_conformes:
            fid = f.get("id", "F-XXX")
            grav = str(f.get("gravite", "")).upper()
            statut = str(f.get("statut", "")).upper()
            contra = f.get("contradiction") or "Écart de conformité"
            reel = f.get("reel") if isinstance(f.get("reel"), dict) else {}
            ressource = reel.get("ressource") or "Périmètre documentaire / organisationnel"
            lines.extend(
                [
                    f"#### {fid} — {f.get('theme', '')} (`{grav}` | `{statut}` | `{contra}`)",
                    f"- **Exigence NIS2 :** {f.get('exigence_nis2', '')}",
                    f"- **Actif / Ressource concernée :** `{ressource}`",
                ]
            )
            if reel.get("constat"):
                lines.append(f"- **Preuve technique (Réel) :** {reel['constat']}")
            if f.get("commande_correction"):
                lines.append(
                    f"- **Mesure de confinement immédiate (Dry-Run) :** `{f['commande_correction']}`"
                )
            dec = f.get("decision_grc")
            if isinstance(dec, dict) and dec.get("decision"):
                lines.append(
                    f"- **Arbitrage GRC enregistré :** {dec.get('decision_label') or dec['decision']} "
                    f"(Porteur : {dec.get('porteur') or 'À désigner'} | Échéance : {dec.get('echeance') or 'À définir'})"
                )
            lines.append("")
    else:
        lines.extend(["Aucun écart ouvert à notifier au titre de l'évaluation 72 h.", ""])

    lines.extend(
        [
            "---",
            "",
            "## 3. Jalon 3 — Plan de Rapport Final sous 1 mois (*Art. 23 §4 d NIS2*)",
            "**Objectif réglementaire :** Transmettre au plus tard **un mois** après la notification 72 h un rapport final comprenant la description détaillée de l'incident/écart, la cause profonde (*Root Cause*), les mesures d'atténuation appliquées et le plan de gouvernance à long terme.",
            "",
            "### 3.1 Analyse des causes profondes (*Root Cause Analysis*)",
            "- **Décalage entre gouvernance déclarative et réalité Cloud (*Dit / Écrit ≠ Réel*) :** Absence de contrôle continu automatisé sur les liaisons IAM publiques, les règles pare-feu d'administration, le verrouillage immuable des sauvegardes et la rétention des journaux d'audit.",
            "- **Processus d'escalade ANSSI (Art. 23) :** Nécessité de formaliser le seuil de déclenchement 24 h / 72 h pour tout incident affectant même partiellement les actifs hospitaliers ou les comptes prestataires.",
            "",
            "### 3.2 Trajectoire de remédiation et arbitrages GRC retenus",
        ]
    )

    if non_conformes:
        for f in non_conformes:
            fid = f.get("id", "F-XXX")
            dec = f.get("decision_grc") if isinstance(f.get("decision_grc"), dict) else {}
            dec_lbl = dec.get("decision_label") or "À corriger (arbitrage standard)"
            porteur = dec.get("porteur") or "DSI / RSSI"
            echeance = dec.get("echeance") or "Plan 30–90 jours"
            note_suffix = f" — *Note : {dec['commentaire']}*" if dec.get("commentaire") else ""
            lines.append(
                f"- **{fid} ({f.get('theme', '')})** : {f.get('recommandation', '')} "
                f"-> **{dec_lbl}** | Porteur : **{porteur}** | Échéance : **{echeance}**{note_suffix}"
            )
    else:
        lines.append("- Maintien en condition opérationnelle et revue périodique trimestrielle.")

    lines.extend(
        [
            "",
            "---",
            f"*Brouillon scellé cryptographiquement par TRIAD — SHA-256 : `{head_hash}`*",
            "",
        ]
    )
    return "\n".join(lines)


def render_comex_brief_markdown(
    session_id: str,
    active_mode: AuditMode,
    state: dict[str, Any],
    slot: dict[str, Any],
    syn: dict[str, Any],
    chain_info: dict[str, Any],
    head_hash: str,
) -> str:
    """Génère la note exécutive 1 page dédiée aux Organes de Direction (Article 20 NIS2)."""
    now_iso = datetime.now(timezone.utc).isoformat()
    client_name = syn.get("client", "Centre Hospitalier de Valmont")
    statut_val = syn.get("statut_validation", "VALIDÉ")
    chain_label = "VALIDE" if chain_info.get("valide") else "ALTÉRÉE"
    nb_entrees = chain_info.get("nb_entrees", 0)

    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    non_conformes = [f for f in findings if f.get("statut") != "conforme"]
    actionable_ids = [
        str(f.get("id") or "")
        for f in non_conformes
        if f.get("id")
        and ((f.get("decision_grc") or {}).get("decision") != "risque_accepte")
    ]
    sim = compute_remediation_simulation(
        session_id=session_id,
        active_mode=active_mode,
        syn=syn,
        raw_selected_ids=actionable_ids,
    )
    workload = sim["workload_jh"]
    art34 = sim["art34_exposure"]

    avant_syn = (state.get("results_by_mode", {}).get("AVANT") or {}).get("synthesis")
    apres_syn = (state.get("results_by_mode", {}).get("APRES") or {}).get("synthesis")
    delta_line: str | None = None
    if isinstance(avant_syn, dict) and isinstance(apres_syn, dict):
        score_av = compute_nis2_score(
            [f for f in (avant_syn.get("findings") or []) if isinstance(f, dict)]
        )
        score_ap = compute_nis2_score(
            [f for f in (apres_syn.get("findings") or []) if isinstance(f, dict)]
        )
        diff_pts = score_ap - score_av
        sign = "+" if diff_pts > 0 else ""
        delta_line = (
            f"- **Écart d'audit Documentaire (`AVANT`) vs Contre-Expertise (`APRÈS`) :** "
            f"`{score_av}/100` -> `{score_ap}/100` (`{sign}{diff_pts} pts` après confrontation au réel Cloud & entretiens)"
        )

    contradictions = [
        f
        for f in non_conformes
        if f.get("contradiction")
        or (isinstance(f.get("dit"), dict) and isinstance(f.get("reel"), dict))
    ]
    top_risks = [str(r) for r in (syn.get("top_3_risques") or []) if r][:3]

    lines: list[str] = [
        "# Brief Exécutif Organes de Direction — Article 20 NIS2",
        f"## {client_name} (*Note de Synthèse Direction Générale / COMEX — 1 Page*)",
        "",
        "> **OBJET : RESPONSABILITÉ DIRECTE DES ORGANES DE DIRECTION (ART. 20 NIS2)**  ",
        "> Conformément à l'Article 20 §1 et §2 de la Directive (UE) 2022/2555 (*NIS2*), les organes de direction des Entités Essentielles doivent **approuver formellement** les mesures de gestion des risques de cybersécurité (Art. 21), **superviser leur mise en œuvre** et peuvent être tenus **personnellement responsables** en cas de manquement.",
        "",
        "### Indicateurs Clés de Gouvernance & Scellement",
        f"- **Entité auditée :** {client_name} (*Entité Essentielle — Annexe I, Santé*)",
        f"- **Périmètre / Statut :** Mode `{active_mode}` | `{statut_val}` | Session `{session_id}`",
        f"- **Score de maturité NIS2 actuel :** **`{sim['current_score']}/100`** -> Cible après plan d'action : **`{sim['projected_score']}/100`** (`+{sim['score_delta']} pts`)",
    ]
    if delta_line:
        lines.append(delta_line)

    lines.extend(
        [
            f"- **Budget charge de remédiation estimé :** **`{workload['label']}`** ({workload['quick_wins_count']} Quick Win(s) immédiat(s))",
            f"- **Plafond légal d'exposition (Art. 34 §4 NIS2) :** **{art34['plafond_label']}** (Indice d'exposition : `{art34['current_risk_index']}/100` — *{art34['risk_level_before']}* -> `{art34['projected_risk_index']}/100` après remédiation, soit **`-{art34['exposure_reduction_pct']} %`**)",
            f"- **Scellement cryptographique SHA-256 (`head_hash`) :** `{head_hash}` ({chain_label}, {nb_entrees} maillons)",
            f"- **Édité le (UTC) :** {now_iso}",
            "",
            "---",
            "",
            "## 1. Obligations Légales des Dirigeants (*Article 20 & Article 32 §5 NIS2*)",
            "1. **Approbation & Supervision (Art. 20 §1) :** Délibération obligatoire du COMEX/Directoire validant la trajectoire de conformité Art. 21 et les arbitrages de risque.",
            "2. **Formation obligatoire des dirigeants (Art. 20 §2) :** Les membres des organes de direction doivent suivre une formation régulière à l'évaluation des risques cyber et de leur impact métier.",
            "3. **Régime de responsabilité & injonctions (Art. 32 §5 b & Art. 34 §4) :** Au-delà des sanctions pécuniaires (**jusqu'à 10 M€ ou 2 % du CA mondial**), l'autorité compétente peut demander la suspension temporaire d'exercice de fonctions dirigeantes en cas d'inaction grave face à des écarts critiques avérés.",
            "",
            "## 2. Top 3 Risques Exécutifs & Contradictions Critiques (*Dit / Écrit ≠ Réel*)",
        ]
    )

    if top_risks:
        for idx, risk in enumerate(top_risks, start=1):
            lines.append(f"{idx}. {risk}")
    else:
        lines.append("1. Aucun risque critique prioritaire remonté dans la synthèse courante.")

    lines.append("")
    if contradictions:
        lines.append("### Dissonances majeures prouvées par la contre-expertise :")
        for f in contradictions[:4]:
            fid = f.get("id", "F-XXX")
            grav = str(f.get("gravite", "")).upper()
            contra = f.get("contradiction") or "Dit / Écrit ≠ Réel"
            dit_ext = ((f.get("dit") or {}).get("extrait") if isinstance(f.get("dit"), dict) else None)
            reel_cst = ((f.get("reel") or {}).get("constat") if isinstance(f.get("reel"), dict) else None)
            summary_parts: list[str] = []
            if dit_ext:
                summary_parts.append(f"*Déclaré :* « {dit_ext} »")
            if reel_cst:
                summary_parts.append(f"*Constaté sur GCP :* {reel_cst}")
            detail_str = " vs ".join(summary_parts) if summary_parts else str(f.get("recommandation") or "")
            lines.append(f"- **[{fid} — {grav}] {f.get('theme', '')}** (`{contra}`) : {detail_str}")
        lines.append("")

    by_h = workload["by_horizon"]
    lines.extend(
        [
            "## 3. Arbitrages GRC & Trajectoire Budgétaire (`j.h`)",
            f"- **Enveloppe globale retenue :** **{workload['label']}** répartie sur 3 horizons opérationnels :",
            f"  - **Urgence 0–30 jours (Confinement & Quick Wins) :** `{by_h['0_30']['estimated_jh']} j.h` ({by_h['0_30']['count']} chantier(s))",
            f"  - **Consolidation 30–60 jours :** `{by_h['30_60']['estimated_jh']} j.h` ({by_h['30_60']['count']} chantier(s))",
            f"  - **Transformation 60–90 jours :** `{by_h['60_90']['estimated_jh']} j.h` ({by_h['60_90']['count']} chantier(s))",
            "",
            "### Synthèse des décisions d'arbitrage GRC soumises au COMEX :",
        ]
    )

    if non_conformes:
        for f in non_conformes:
            fid = f.get("id", "F-XXX")
            dec = f.get("decision_grc") if isinstance(f.get("decision_grc"), dict) else {}
            dec_lbl = dec.get("decision_label") or "À corriger (plan prioritaire)"
            porteur = dec.get("porteur") or "DSI / RSSI"
            echeance = dec.get("echeance") or "J+30"
            lines.append(
                f"- **{fid} — {f.get('theme', '')}** (`{str(f.get('gravite', '')).upper()}`) : "
                f"**{dec_lbl}** | Porteur : **{porteur}** | Échéance : **{echeance}**"
            )
    else:
        lines.append("- Conformité nominale sur les contrôles évalués ; maintien en condition de sécurité.")

    lines.extend(
        [
            "",
            "## 4. Résolutions Proposées à l'Approbation du COMEX (*Art. 20 §1 NIS2*)",
            "- [ ] **Résolution n°1 :** Approuver formellement la matrice des risques *Dit / Écrit / Réel* et les arbitrages GRC ci-dessus.",
            f"- [ ] **Résolution n°2 :** Allouer l'enveloppe de **`{workload['label']}`** et mandater la DSI / le RSSI sur l'exécution immédiate des chantiers `0–30 jours`.",
            "- [ ] **Résolution n°3 :** Valider la procédure d'escalade réglementaire ANSSI (*Art. 23 §4 : Alerte 24 h / Évaluation 72 h / Rapport 1 mois*) et programmer la session annuelle de formation cyber des dirigeants (*Art. 20 §2*).",
            "",
            "---",
            f"*Brief exécutif scellé cryptographiquement par TRIAD — SHA-256 : `{head_hash}`*",
            "",
        ]
    )
    return "\n".join(lines)


def _hcl_escape_string(raw: str) -> str:
    return (
        str(raw or "")
        .replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\r", " ")
        .replace("\n", " ")
        .strip()
    )


def render_terraform_remediation_hcl(
    session_id: str,
    active_mode: AuditMode,
    slot: dict[str, Any],
    syn: dict[str, Any],
    chain_info: dict[str, Any],
    head_hash: str,
    project_id: str = "",
    region: str = "",
) -> str:
    """Génère un manifeste Terraform HCL déclaratif prêt pour revue PR GitOps (jamais appliqué automatiquement)."""
    now_iso = datetime.now(timezone.utc).isoformat()
    client_name = _hcl_escape_string(syn.get("client", "Centre Hospitalier de Valmont"))
    project_default = _hcl_escape_string(project_id or "ch-valmont-demo")
    region_default = _hcl_escape_string(region or "europe-west9")
    chain_label = "VALIDE" if chain_info.get("valide") else "ALTÉRÉE"
    nb_entrees = chain_info.get("nb_entrees", 0)

    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    by_id: dict[str, dict[str, Any]] = {
        str(f.get("id")): f for f in findings if f.get("id")
    }

    def _grc_comment_for(fid: str) -> str:
        f = by_id.get(fid)
        if not isinstance(f, dict):
            return f"# Arbitrage GRC [{fid}] : Standard (À corriger)"
        dec = f.get("decision_grc")
        if isinstance(dec, dict) and dec.get("decision"):
            lbl = dec.get("decision_label") or dec.get("decision")
            porteur = dec.get("porteur") or "DSI / RSSI"
            echeance = dec.get("echeance") or "Plan 30-90j"
            return f"# Arbitrage GRC [{fid}] : {lbl} | Porteur : {porteur} | Échéance : {echeance}"
        return f"# Arbitrage GRC [{fid}] : À corriger (remédiation déclarative GitOps)"

    lines: list[str] = [
        "# ==============================================================================",
        "# TRIAD — Manifeste Correctif Terraform GitOps GCP (NIS2 Art. 21 & Art. 23)",
        f"# Client           : {client_name}",
        f"# Mode / Statut    : {active_mode} | {syn.get('statut_validation', 'VALIDÉ')}",
        f"# Session / Run ID : {session_id} / {slot.get('run_id') or 'n/a'}",
        f"# Empreinte SHA-256: {head_hash}",
        f"# Intégrité chaîne : {chain_label} ({nb_entrees} maillons vérifiés)",
        f"# Généré le (UTC)  : {now_iso}",
        "# ------------------------------------------------------------------------------",
        "# AVERTISSEMENT DE SÉCURITÉ OBLIGATOIRE :",
        "#   revue humaine / terraform plan requis — jamais appliqué automatiquement par TRIAD.",
        "#   Les agents IA TRIAD opèrent exclusivement en LECTURE SEULE sur Google Cloud.",
        "#   Soumettre ce fichier à une Pull Request GitOps avant tout 'terraform apply'.",
        "# ==============================================================================",
        "",
        "terraform {",
        '  required_version = ">= 1.5.0"',
        "  required_providers {",
        "    google = {",
        '      source  = "hashicorp/google"',
        '      version = "~> 5.0"',
        "    }",
        "  }",
        "}",
        "",
        'variable "project_id" {',
        '  description = "Identifiant du projet Google Cloud cible à remédier"',
        "  type        = string",
        f'  default     = "{project_default}"',
        "}",
        "",
        'variable "region" {',
        '  description = "Région souveraine HDS / NIS2 (Paris)"',
        "  type        = string",
        f'  default     = "{region_default}"',
        "}",
        "",
        'variable "bastion_iap_cidr" {',
        '  description = "Plage CIDR officielle Identity-Aware Proxy (IAP TCP Forwarding) ou Bastion VPN"',
        "  type        = string",
        '  default     = "35.235.240.0/20"',
        "}",
        "",
        "locals {",
        "  triad_common_labels = {",
        '    managed_by      = "triad-gitops-remediation"',
        f'    nis2_audit_mode = "{active_mode.lower()}"',
        f'    audit_head_sha  = "{head_hash[:16]}"',
        "  }",
        "}",
        "",
        "# ------------------------------------------------------------------------------",
        "# [F-001] Art. 21 §2 (i) — Suppression de l'exposition allUsers & PAP enforced",
        _grc_comment_for("F-001"),
        "# ------------------------------------------------------------------------------",
        'resource "google_storage_bucket" "remediate_export_radiologie" {',
        '  name                        = "${var.project_id}-export-radiologie"',
        "  project                     = var.project_id",
        "  location                    = upper(var.region)",
        '  public_access_prevention    = "enforced"',
        "  uniform_bucket_level_access = true",
        "  labels                      = local.triad_common_labels",
        "}",
        "",
        "# ------------------------------------------------------------------------------",
        "# [F-002] Art. 21 §2 (i) — Fermeture SSH 0.0.0.0/0 au profit du bastion IAP/VPN",
        _grc_comment_for("F-002"),
        "# Note PR : importer/supprimer la règle legacy 'allow-ssh-anywhere' (0.0.0.0/0)",
        "# ------------------------------------------------------------------------------",
        'resource "google_compute_firewall" "remediate_ssh_iap_bastion" {',
        '  name          = "allow-ssh-iap-bastion-only"',
        "  project       = var.project_id",
        '  network       = "default"',
        '  direction     = "INGRESS"',
        "  priority      = 1000",
        "  source_ranges = [var.bastion_iap_cidr]",
        "",
        "  allow {",
        '    protocol = "tcp"',
        '    ports    = ["22"]',
        "  }",
        "",
        '  target_tags = ["bastion-managed"]',
        '  description = "NIS2 Art. 21.2.i — Administration SSH restreinte au tunnel IAP/Bastion VPN"',
        "}",
        "",
        "# ------------------------------------------------------------------------------",
        "# [F-003] Art. 21 §2 (c) — Immuabilité WORM 30j & Versioning sur backups-dpi",
        _grc_comment_for("F-003"),
        "# ------------------------------------------------------------------------------",
        'resource "google_storage_bucket" "remediate_backups_dpi" {',
        '  name                        = "${var.project_id}-backups-dpi"',
        "  project                     = var.project_id",
        "  location                    = upper(var.region)",
        '  public_access_prevention    = "enforced"',
        "  uniform_bucket_level_access = true",
        "  labels                      = local.triad_common_labels",
        "",
        "  versioning {",
        "    enabled = true",
        "  }",
        "",
        "  retention_policy {",
        "    is_locked        = true",
        "    retention_period = 2592000 # 30 jours minimum anti-ransomware (PSSI §5.2)",
        "  }",
        "}",
        "",
        "# ------------------------------------------------------------------------------",
        "# [F-006] Art. 21 §2 (d, i, j) — Moindre privilège IAM prestataire (sans clé JSON)",
        _grc_comment_for("F-006"),
        "# Note PR : révoquer roles/editor projet et la clé USER_MANAGED 7f9a3c12e84b09d1",
        "# ------------------------------------------------------------------------------",
        'resource "google_project_iam_custom_role" "prestataire_pacs_minimal" {',
        '  role_id     = "triadPrestatairePacsMaintenance"',
        "  project     = var.project_id",
        '  title       = "Maintenance PACS Moindre Privilège (NIS2 Art. 21.2.d)"',
        '  description = "Remplace roles/editor pour sa-prestataire-meditech sans accès aux données DPI"',
        "  permissions = [",
        '    "storage.buckets.get",',
        '    "logging.logEntries.create",',
        "  ]",
        "}",
        "",
        'resource "google_storage_bucket_iam_member" "prestataire_meditech_scoped" {',
        "  bucket = google_storage_bucket.remediate_export_radiologie.name",
        "  role   = google_project_iam_custom_role.prestataire_pacs_minimal.name",
        '  member = "serviceAccount:sa-prestataire-meditech@${var.project_id}.iam.gserviceaccount.com"',
        "}",
        "",
        "# ------------------------------------------------------------------------------",
        "# [F-007] Art. 21 §2 (h) & Art. 23 — Rotation KMS 90j (7776000s) & Logs 365j",
        _grc_comment_for("F-007"),
        "# ------------------------------------------------------------------------------",
        'resource "google_kms_key_ring" "kr_sante_dpi" {',
        '  name     = "kr-sante-dpi"',
        "  project  = var.project_id",
        "  location = var.region",
        "}",
        "",
        'resource "google_kms_crypto_key" "remediate_key_dpi_patients" {',
        '  name            = "key-dpi-patients"',
        "  key_ring        = google_kms_key_ring.kr_sante_dpi.id",
        '  purpose         = "ENCRYPT_DECRYPT"',
        '  rotation_period = "7776000s" # Rotation automatique tous les 90 jours',
        "  labels          = local.triad_common_labels",
        "",
        "  lifecycle {",
        "    prevent_destroy = true",
        "  }",
        "}",
        "",
        'resource "google_logging_project_bucket_config" "remediate_default_audit_retention" {',
        "  project        = var.project_id",
        '  location       = "global"',
        '  bucket_id      = "_Default"',
        "  retention_days = 365 # Conformité PSSI §6.1 (12 mois)",
        "  locked         = true",
        "}",
        "",
        'resource "google_project_iam_audit_config" "remediate_data_access_audit_logs" {',
        "  project = var.project_id",
        '  service = "storage.googleapis.com"',
        "",
        "  audit_log_config {",
        '    log_type = "ADMIN_READ"',
        "  }",
        "  audit_log_config {",
        '    log_type = "DATA_READ"',
        "  }",
        "  audit_log_config {",
        '    log_type = "DATA_WRITE"',
        "  }",
        "}",
        "",
    ]
    return "\n".join(lines)


def render_interview_guide_markdown(
    *,
    session_id: str,
    active_mode: AuditMode,
    slot: dict[str, Any],
    syn: dict[str, Any],
    chain_info: dict[str, Any],
    head_hash: str,
) -> str:
    """Génère le Guide d'Entretien Contradictoire pré-rempli par interlocuteur (DSI, Admin Cloud, RSSI / DPO, Achats / Juridique)."""
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    client_name = str(syn.get("client") or "Centre Hospitalier de Valmont")
    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    by_id: dict[str, dict[str, Any]] = {
        str(f.get("id")): f for f in findings if f.get("id")
    }
    docs_quar = [d for d in (syn.get("documents_quarantaine") or []) if isinstance(d, dict)]
    decisions_map = dict(slot.get("decisions") or {})
    is_apres = active_mode == "APRES"
    chain_ok = bool(chain_info.get("valide"))
    nb_entrees = int(chain_info.get("nb_entrees") or 0)

    mode_label = (
        "APRÈS ENTRETIEN — Contre-Interrogatoire & Levée des Contradictions (Dit ≠ Écrit ≠ Réel)"
        if is_apres
        else "AVANT ENTRETIEN — Préparation Contradictoire à Froid (Écrit ≠ Réel)"
    )
    posture_intro = (
        "Ce guide consolide les contradictions relevées **après recueil du déclaratif oral de la DSI** (`notes_entretien_DSI.md`), "
        "confrontées aux engagements de la PSSI et aux sondes techniques Google Cloud en lecture seule. "
        "Il structure la séance de clôture contradictoire et la collecte des pièces justificatives opposables (dont la qualification de l'incident non notifié de septembre `F-004`)."
        if is_apres
        else "Ce guide prépare la **conduite d'entretien contradictoire initial** avant recueil du déclaratif oral. "
        "Il s'appuie sur les divergences factuelles déjà établies entre le corpus écrit (`PSSI`, procédures) et la réalité technique Google Cloud en lecture seule (`Écrit ≠ Réel`), "
        "afin d'obtenir des réponses précises et des preuves vérifiables en séance."
    )

    def _finding_summary_block(fid: str) -> list[str]:
        f = by_id.get(fid)
        if not f:
            return []
        statut = str(f.get("statut") or "inconnu").upper()
        gravite = str(f.get("gravite") or "inconnue").upper()
        contradiction = str(f.get("contradiction") or "Contrôle témoin")
        exigence = str(f.get("exigence_nis2") or "Art. 21 NIS2")
        theme = str(f.get("theme") or fid)

        dit_obj = f.get("dit") if isinstance(f.get("dit"), dict) else None
        ecrit_obj = f.get("ecrit") if isinstance(f.get("ecrit"), dict) else None
        reel_obj = f.get("reel") if isinstance(f.get("reel"), dict) else None

        out = [
            f"- **[{fid}] {theme}** — `{gravite}` • Statut : `{statut}` • Divergence : **{contradiction}** ({exigence})",
        ]
        if dit_obj and dit_obj.get("extrait"):
            out.append(
                f"  - *Dit ({dit_obj.get('source', 'Entretien')})* : « {dit_obj.get('extrait')} »"
            )
        elif not is_apres:
            out.append("  - *Dit* : Non recueilli à ce stade (question ouverte à poser sans induire la réponse).")
        if ecrit_obj and ecrit_obj.get("extrait"):
            sec = f" {ecrit_obj.get('section')}" if ecrit_obj.get("section") else ""
            out.append(
                f"  - *Écrit ({ecrit_obj.get('source', 'PSSI')}{sec})* : « {ecrit_obj.get('extrait')} »"
            )
        if reel_obj and reel_obj.get("constat"):
            res_name = f" (`{reel_obj.get('ressource')}`)" if reel_obj.get("ressource") else ""
            out.append(f"  - *Réel GCP*{res_name} : {reel_obj.get('constat')}")
        return out

    lines: list[str] = [
        "# GUIDE D'ENTRETIEN CONTRADICTOIRE NIS2 — PRÉ-REMPLI PAR INTERLOCUTEUR",
        "",
        f"> **Entité auditée** : {client_name}  ",
        f"> **Phase & Mode d'audit** : `{active_mode}` — {mode_label}  ",
        f"> **Session TRIAD** : `{session_id}` • **Généré le** : {now_iso}  ",
        f"> **Intégrité cryptographique** : `{'INTÈGRE' if chain_ok else 'À VÉRIFIER'}` ({nb_entrees} maillons SHA-256) • **Empreinte de tête** : `{head_hash}`",
        "",
        posture_intro,
        "",
        "---",
        "",
        "## Alerte Prioritaire — Quarantaine Fournisseur & Risque Tiers (Art. 21 §2 d)",
        "",
    ]

    if docs_quar:
        for qdoc in docs_quar:
            qname = str(qdoc.get("nom_fichier") or "piece_tierce_inconnue.md")
            qreason = str(
                qdoc.get("raison_quarantaine")
                or qdoc.get("alerte_injection")
                or "Tentative d'injection de prompt indirecte neutralisée par l'agent Douanier."
            )
            lines.extend(
                [
                    f"- **Pièce isolée en quarantaine** : `{qname}` (**Prestataire concerné : MedTech Solutions SAS**)",
                    f"  - **Motif de blocage (`Douanier`)** : {qreason}",
                    "  - **Conséquence méthodologique** : document exclu du contexte d'analyse automatique pour prévenir toute manipulation du verdict ; vérification contradictoire humaine obligatoire avec les Achats et le RSSI.",
                ]
            )
    else:
        lines.extend(
            [
                "- **Vigilance Chaîne d'Approvisionnement (`MedTech Solutions SAS`)** : vérifier systématiquement l'intégrité des annexes techniques fournies par les prestataires de télémaintenance PACS/imagerie (`annexe_fournisseur_maintenance.md`) et le cloisonnement du compte `sa-prestataire-meditech`.",
            ]
        )

    lines.extend(
        [
            "",
            "---",
            "",
            "## 1. Direction des Systèmes d'Information (`DSI`)",
            "",
            "**Objectif de séance** : Confronter le pilotage opérationnel de la production hospitalière (exposition Internet, accès d'administration, résilience anti-rançongiciel et gestion des incidents) aux preuves techniques GCP.",
            "",
            "### Divergences constatées sur le périmètre DSI",
        ]
    )
    for fid in ("F-001", "F-002", "F-003", "F-004", "F-005"):
        lines.extend(_finding_summary_block(fid))

    lines.extend(
        [
            "",
            "### Questions contradictoires à poser au `DSI`",
        ]
    )
    if is_apres:
        lines.extend(
            [
                "1. **[F-001 — Exposition HDS]** Lors de l'entretien, il a été indiqué que *« les données patients ne sont jamais exposées sur Internet »*, or `gs://ch-valmont-demo-export-radiologie` accorde `roles/storage.objectViewer` à `allUsers` : quel flux métier a créé ce partage et quelles données d'imagerie y ont transité ?",
                "2. **[F-002 — Administration hors VPN]** Vous avez affirmé que *« l'accès admin passe uniquement par le VPN »*, alors que la règle `allow-ssh-anywhere` ouvre `TCP/22` à `0.0.0.0/0` sur le VPC `default` : quelle équipe ou quel prestataire utilise cet accès direct hors bastion ?",
                "3. **[F-003 / F-005 — Rançongiciel & PRA]** Pourquoi le bucket `gs://ch-valmont-demo-backups-dpi` est-il dépourvu de versioning et de verrouillage WORM alors que `gs://ch-valmont-demo-archives-pacs` (`F-005`) applique déjà une rétention verrouillée de 365 jours ?",
                "4. **[F-004 — Incident de septembre]** L'incident de septembre (compromission d'un compte prestataire et coupure partielle de messagerie) a été qualifié en séance de *« petit incident géré en interne »* : sur quels critères objectifs l'alerte précoce ANSSI sous 24 h (Art. 23 NIS2 / PSSI §6.2) a-t-elle été écartée ?",
            ]
        )
    else:
        lines.extend(
            [
                "1. **[F-001 — Exposition HDS]** Comment garantissez-vous en pratique qu'aucun espace de stockage d'échange (notamment radiologie / imagerie) n'est accessible publiquement, alors que la sonde GCP relève `allUsers` sur `gs://ch-valmont-demo-export-radiologie` (écart `Écrit ≠ Réel` face à la PSSI §3.1) ?",
                "2. **[F-002 — Administration réseau]** Quel est le chemin réseau nominal d'administration des serveurs Cloud et comment expliquez-vous la présence active de la règle `allow-ssh-anywhere` (`TCP/22` ouvert à `0.0.0.0/0`) en contradiction avec la PSSI §4.3 ?",
                "3. **[F-003 / F-005 — Sauvegardes DPI vs PACS]** Quelles mesures techniques empêchent la suppression malveillante des sauvegardes du DPI (`backups-dpi`) en cas de compromission d'un compte administrateur, par comparaison avec le bucket conforme `archives-pacs` (`F-005`) ?",
                "4. **[Détection d'incidents — Art. 23]** L'établissement a-t-il connu un incident de sécurité ou une indisponibilité impliquant un prestataire au cours des 12 derniers mois, et quel circuit d'escalade vers la Direction Générale et l'ANSSI a été activé ?",
            ]
        )

    lines.extend(
        [
            "",
            "### Preuves attendues en séance (`DSI`)",
            "- Schéma d'architecture réseau à jour du bastion VPN / IAP et registre formel des dérogations pare-feu.",
            "- Dernier procès-verbal de test de restauration couvrant la production `backups-dpi` (et planification de l'extension PRA 2026 à `archives-pacs`).",
            "- Main courante chronologique et rapport post-mortem interne de tout incident survenu sur les 12 derniers mois.",
            "",
            "---",
            "",
            "## 2. Administrateur Cloud & Infrastructure GCP (`Admin Cloud`)",
            "",
            "**Objectif de séance** : Valider la faisabilité immédiate des remédiations techniques (IAM, VPC, Cloud Storage WORM, KMS, Cloud Logging) et identifier l'origine des dérives de configuration.",
            "",
            "### Divergences constatées sur le périmètre `Admin Cloud`",
        ]
    )
    for fid in ("F-006", "F-007", "F-001", "F-002", "F-003"):
        lines.extend(_finding_summary_block(fid))

    lines.extend(
        [
            "",
            "### Questions contradictoires à poser à l'`Admin Cloud`",
            "1. **[F-006 — Sur-privilèges & Clé statique]** Pourquoi le compte `sa-prestataire-meditech@ch-valmont-demo.iam.gserviceaccount.com` détient-il le rôle primitif `roles/editor` avec une clé JSON `USER_MANAGED` active depuis **248 jours** (> plafond PSSI de 90 jours), et qui utilise encore le compte générique `admin-legacy@ch-valmont.fr` (`roles/owner`) ?",
            "2. **[F-007 — Rotation KMS & Traces 365 j]** Qu'est-ce qui bloque l'activation de la rotation automatique à 90 jours sur `key-dpi-patients` (déjà active sur `key-pacs-imagerie`) ainsi que le passage du bucket Cloud Logging `_Default` de 30 jours à **365 jours** avec journaux `DATA_READ` / `DATA_WRITE` ?",
            "3. **[F-001 / F-002 — Garde-fous d'organisation]** Des contraintes Organization Policy (`storage.publicAccessPrevention`, `iam.disableServiceAccountKeyCreation`, restriction IAP `35.235.240.0/20`) sont-elles déployées ou prêtes à être revues via `terraform plan` ?",
            "",
            "### Preuves attendues en séance (`Admin Cloud`)",
            "- Export complet de la politique IAM du projet et inventaire horodaté des clés `USER_MANAGED` actives.",
            "- Journal d'activité Cloud Audit Logs (`Admin Activity`) identifiant l'auteur et la date de création de `allow-ssh-anywhere` et du binding `allUsers`.",
            "- Sortie de revue `terraform plan` (en lecture seule) sur le manifeste GitOps de remédiation (`09_Remediation_GitOps.tf`).",
            "",
            "---",
            "",
            "## 3. Gouvernance Cyber & Protection des Données (`RSSI / DPO`)",
            "",
            "**Objectif de séance** : Évaluer la conformité réglementaire NIS2 (Art. 20, Art. 21, Art. 23) et RGPD / HDS (Art. 32, 33, 34), la conservation probatoire des traces et l'effectivité des contrôles périodiques PSSI.",
            "",
            "### Divergences constatées sur le périmètre `RSSI / DPO`",
        ]
    )
    for fid in ("F-004", "F-001", "F-006", "F-007"):
        lines.extend(_finding_summary_block(fid))

    lines.extend(
        [
            "",
            "### Questions contradictoires à poser au `RSSI / DPO`",
            "1. **[F-001 — Analyse d'impact RGPD / HDS]** Suite à l'exposition `allUsers` constatée sur `gs://ch-valmont-demo-export-radiologie`, une investigation forensique d'accès non autorisé et une évaluation de notification CNIL (72 h — Art. 33 RGPD) et ARS/ANSSI ont-elles été engagées ?",
            "2. **[F-004 — Procédure Art. 23 NIS2]** Disposez-vous d'une matrice opérationnelle d'astreinte permettant de qualifier un incident significatif et de transmettre l'alerte précoce ANSSI sous **24 h**, la notification sous **72 h** et le rapport final à **1 mois** ?"
            + (
                " Pourquoi cette procédure (§6.2 PSSI) n'a-t-elle pas été déclenchée lors de la compromission prestataire de septembre ?"
                if is_apres
                else ""
            ),
            "3. **[F-006 / F-007 — Revues des droits & Rétention 12 mois]** À quelle fréquence les revues de comptes à privilèges (PSSI §4.1) et le contrôle de rétention légale à 12 mois des journaux HDS/NIS2 (PSSI §6.1, actuellement à 30 jours sur `_Default`) sont-ils audités ?",
            "",
            "### Preuves attendues en séance (`RSSI / DPO`)",
            "- Procédure opérationnelle de notification d'incident (ANSSI Art. 23 / CNIL Art. 33) et grille de seuils de criticité.",
            "- Registre des incidents de sécurité et des violations de données à caractère personnel des 24 derniers mois.",
            "- Comptes-rendus signés des deux dernières revues semestrielles/trimestrielles des habilitations IAM.",
            "",
            "---",
            "",
            "## 4. Direction des Achats & Service Juridique (`Achats / Juridique` — Art. 21 §2 d)",
            "",
            "**Objectif de séance** : Encadrer contractuellement la chaîne d'approvisionnement numérique (`MedTech Solutions SAS`, infogérance télémaintenance, hébergement HDS) suite aux écarts techniques et à la mise en quarantaine documentaire.",
            "",
            "### Points d'alerte tiers & contractuels",
            "- **Prestataire critique identifié** : `MedTech Solutions SAS` (télémaintenance imagerie / PACS) — pièce `annexe_fournisseur_maintenance.md` isolée en **quarantaine anti-injection** par le sas `Douanier`.",
            "- **Exposition technique associée** : compte prestataire `sa-prestataire-meditech` en `roles/editor` avec clé statique de 248 jours (`F-006`), ouverture SSH `0.0.0.0/0` (`F-002`)"
            + (
                " et compromission avérée d'un compte prestataire en septembre non notifiée (`F-004`)."
                if is_apres
                else "."
            ),
            "",
            "### Questions contradictoires à poser aux `Achats / Juridique`",
            "1. **[Quarantaine `MedTech Solutions SAS`]** Par quel canal l'annexe technique `annexe_fournisseur_maintenance.md` (bloquée par le sas anti-injection de prompt) a-t-elle été réceptionnée et qui valide l'intégrité documentaire des livrables fournisseurs avant intégration au référentiel interne ?",
            "2. **[Clauses NIS2 Art. 21 §2 d & PSSI §3.3]** Le contrat de maintenance `MedTech Solutions SAS` et le marché d'infogérance intègrent-ils un Plan d'Assurance Sécurité (PAS) opposable imposant : l'accès exclusif par bastion nominatif MFA, l'interdiction des clés statiques longue durée, le droit d'audit et la notification d'incident sans délai (< 24 h) ?",
            "3. **[Responsabilité & Réversibilité]**"
            + (
                " Quelles pénalités ou mesures conservatoires contractuelles ont été activées envers le prestataire impliqué dans l'incident de septembre (`F-004`) ?"
                if is_apres
                else " Quelles clauses de suspension immédiate d'accès et de mise en demeure s'appliquent en cas de non-conformité cyber d'un sous-traitant critique ?"
            ),
            "",
            "### Preuves attendues en séance (`Achats / Juridique`)",
            "- Contrat de télémaintenance `MedTech Solutions SAS` signé, annexes PAS (PSSI §3.3) et certificat HDS / ISO 27001 en cours de validité.",
            "- Registre des tiers critiques ayant accès au SI hospitalier (Art. 21 §2 d NIS2) et conventions d'accès distant nominatif.",
            "- Projet d'avenant de sécurité imposant l'authentification éphémère (Workload Identity / IAP), la révocation sous 1 h et l'alerte cyber < 24 h.",
        ]
    )

    # Constats personnalisés additionnels (hors F-001..F-007)
    standard_ids = {"F-001", "F-002", "F-003", "F-004", "F-005", "F-006", "F-007"}
    custom_findings = [f for f in findings if str(f.get("id") or "") not in standard_ids]
    if custom_findings:
        lines.extend(
            [
                "",
                "---",
                "",
                "## Constats Complémentaires Spécifiques à la Session",
                "",
            ]
        )
        for cf in custom_findings:
            cid = str(cf.get("id") or "F-CUSTOM")
            lines.extend(_finding_summary_block(cid))

    extra_questions = [
        str(q).strip() for q in (syn.get("questions_entretien") or []) if str(q).strip()
    ]
    if extra_questions:
        lines.extend(
            [
                "",
                "---",
                "",
                "## Questions de Relance Automatisées du Contre-Auditeur",
                "",
            ]
        )
        for idx, q_txt in enumerate(extra_questions, start=1):
            lines.append(f"{idx}. {q_txt}")

    if decisions_map:
        lines.extend(
            [
                "",
                "---",
                "",
                "## Arbitrages GRC du Consultant à Confirmer en Séance",
                "",
                "| Constat | Décision GRC | Porteur désigné | Échéance | Commentaire / Justification |",
                "| :--- | :--- | :--- | :--- | :--- |",
            ]
        )
        for fid in sorted(decisions_map.keys()):
            d = decisions_map[fid]
            if not isinstance(d, dict):
                continue
            dec_lbl = str(d.get("decision") or "-")
            owner = str(d.get("porteur") or "À confirmer")
            due = str(d.get("echeance") or "-")
            note = str(d.get("commentaire") or "-").replace("\n", " ")
            lines.append(f"| `{fid}` | `{dec_lbl}` | {owner} | {due} | {note} |")

    lines.extend(
        [
            "",
            "---",
            "",
            "## Sceau Probatoire & Traçabilité Forensique TRIAD",
            "",
            "- **Validation humaine obligatoire** : `APPROUVÉ PAR LE CONSULTANT` (verrou `HTTP 403` levé après revue).",
            f"- **Mode certifié** : `{active_mode}` • **Session** : `{session_id}`",
            f"- **Empreinte SHA-256 de tête (`06_Audit_Chain.jsonl`)** : `{head_hash}`",
            "",
        ]
    )
    return "\n".join(lines)


def render_risk_register_markdown(
    *,
    session_id: str,
    active_mode: AuditMode,
    slot: dict[str, Any],
    syn: dict[str, Any],
    chain_info: dict[str, Any],
    head_hash: str,
) -> str:
    """Génère le Registre Officiel d'Homologation & Dérogations GRC opposable au Comité d'Audit (NIS2 Art. 20 & Art. 21 §1)."""
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    client_name = str(syn.get("client") or "Centre Hospitalier de Valmont")
    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    decisions_map = dict(slot.get("decisions") or {})
    nis2_score = compute_nis2_score(findings)
    chain_ok = bool(chain_info.get("valide"))
    nb_entrees = int(chain_info.get("nb_entrees") or 0)

    short_labels: dict[str, str] = {
        "a_corriger": "À corriger",
        "mesure_compensatoire": "Mesure compensatoire",
        "risque_accepte": "Risque accepté",
        "a_approfondir": "À approfondir",
    }

    rows: list[dict[str, Any]] = []
    counts_by_key = {
        "a_corriger": 0,
        "mesure_compensatoire": 0,
        "risque_accepte": 0,
        "a_approfondir": 0,
    }
    explicit_count = 0

    for f in findings:
        fid = str(f.get("id") or "F-???")
        theme = str(f.get("theme") or fid)
        exigence = str(f.get("exigence_nis2") or "Art. 21 NIS2")
        statut = str(f.get("statut") or "inconnu")
        gravite = str(f.get("gravite") or "moyenne")
        contradiction = str(f.get("contradiction") or "Contrôle témoin")
        reel_obj = f.get("reel") if isinstance(f.get("reel"), dict) else {}
        ressource = str(reel_obj.get("ressource") or "Périmètre documentaire / gouvernance")
        recommandation = str(f.get("recommandation") or "Maintenir le contrôle périodique.")

        explicit_dec = decisions_map.get(fid)
        if not isinstance(explicit_dec, dict) and isinstance(f.get("decision_grc"), dict):
            explicit_dec = f.get("decision_grc")

        if isinstance(explicit_dec, dict) and str(explicit_dec.get("decision") or "") in short_labels:
            is_explicit = True
            explicit_count += 1
            dec_key = str(explicit_dec["decision"])
            dec_short = short_labels[dec_key]
            dec_full = str(explicit_dec.get("decision_label") or VALID_GRC_DECISIONS.get(dec_key, dec_short))
            porteur = str(explicit_dec.get("porteur") or "").strip() or "Direction SI & RSSI (à préciser)"
            echeance = str(explicit_dec.get("echeance") or "").strip() or (
                "Revue 90 j" if dec_key == "risque_accepte" else "J+30"
            )
            commentaire = str(explicit_dec.get("commentaire") or "").strip() or recommandation
            updated_at = str(explicit_dec.get("updated_at") or now_iso)
        else:
            is_explicit = False
            if statut == "conforme":
                dec_key = "mesure_compensatoire"
            elif statut == "a_confirmer":
                dec_key = "a_approfondir"
            else:
                dec_key = "a_corriger"
            dec_short = short_labels[dec_key]
            dec_full = VALID_GRC_DECISIONS.get(dec_key, dec_short)
            porteur = (
                "RSSI & Direction Générale"
                if fid == "F-004"
                else ("Équipe Cloud & Infra GCP" if statut != "conforme" else "Équipe Infra (maintien)")
            )
            echeance = (
                "J+15"
                if gravite == "critique"
                else ("J+30" if gravite == "haute" else ("Continu" if statut == "conforme" else "J+60"))
            )
            commentaire = recommandation
            updated_at = "Proposition par défaut (revue consultant)"

        counts_by_key[dec_key] = counts_by_key.get(dec_key, 0) + 1
        rows.append(
            {
                "fid": fid,
                "theme": theme,
                "exigence": exigence,
                "statut": statut,
                "gravite": gravite,
                "contradiction": contradiction,
                "ressource": ressource,
                "recommandation": recommandation,
                "is_explicit": is_explicit,
                "dec_key": dec_key,
                "dec_short": dec_short,
                "dec_full": dec_full,
                "porteur": porteur,
                "echeance": echeance,
                "commentaire": commentaire,
                "updated_at": updated_at,
            }
        )

    lines: list[str] = [
        "# REGISTRE OFFICIEL D'HOMOLOGATION, D'ARBITRAGES & DÉROGATIONS GRC (NIS2)",
        "",
        f"> **Entité Essentielle auditée** : {client_name}  ",
        "> **Cadre réglementaire** : Directive (UE) 2022/2555 **NIS2 — Article 20 (Gouvernance & responsabilité des dirigeants) & Article 21 §1 (Proportionnalité & gestion des risques)** • PSSI §2.2 & §7  ",
        f"> **Phase & Mode certifié** : `{active_mode}` • **Indice de maturité NIS2** : `{nis2_score}/100`  ",
        f"> **Session TRIAD** : `{session_id}` • **Scellé le** : {now_iso}  ",
        f"> **Intégrité de la chaîne d'audit** : `{'INTÈGRE' if chain_ok else 'À VÉRIFIER'}` ({nb_entrees} maillons SHA-256) • **Empreinte de tête** : `{head_hash}`",
        "",
        "Ce registre constitue la **pièce officielle de gouvernance cyber opposable au Comité d'Audit, au Conseil de Surveillance et à l'ANSSI**. "
        "Conformément à l'Article 20 NIS2 et à la PSSI §2.2 du CH Valmont, tout écart technique ou organisationnel fait l'objet d'un arbitrage tracé "
        "(`À corriger`, `Mesure compensatoire`, `Risque accepté`, `À approfondir`), assorti d'un porteur nominatif, d'une échéance et d'une justification motivée.",
        "",
        "---",
        "",
        "## 1. Synthèse Exécutive des Arbitrages GRC",
        "",
        "| Catégorie d'Arbitrage GRC | Nombre de Constats | Règle d'Homologation & Suivi Comité Cyber |",
        "| :--- | :---: | :--- |",
        f"| **À corriger** (`À corriger prioritairement`) | **{counts_by_key['a_corriger']}** | Remédiation obligatoire sous SLA (`J+15` critique / `J+30` haute) avec contre-audit technique. |",
        f"| **Mesure compensatoire** (`Mesure compensatoire validée`) | **{counts_by_key['mesure_compensatoire']}** | Contrôle alternatif documenté réduisant l'exposition résiduelle à un seuil acceptable. |",
        f"| **Risque accepté** (`Risque accepté temporairement`) | **{counts_by_key['risque_accepte']}** | Dérogation formelle co-signée par la Direction Générale (validité maximale 90 jours, PSSI §2.2). |",
        f"| **À approfondir** (`À approfondir`) | **{counts_by_key['a_approfondir']}** | Instruction contradictoire ou preuve complémentaire exigée sous 15 jours ouvrés. |",
        f"| **Total des constats instruits** *(dont {explicit_count} arbitrage(s) explicite(s) du consultant)* | **{len(rows)}** | Registre intégralement couvert et scellé dans `06_Audit_Chain.jsonl`. |",
        "",
        "---",
        "",
        "## 2. Matrice Consolidée de Traitement & d'Homologation des Risques",
        "",
        "| ID | Thème & Exigence NIS2 | Gravité / Statut | Décision GRC | Origine | Porteur Désigné | Échéance | Justification / Mesure Retenue |",
        "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |",
    ]

    for r in rows:
        origin_lbl = "Arbitrage Consultant" if r["is_explicit"] else "Posture par défaut"
        clean_justif = str(r["commentaire"]).replace("|", "/").replace("\n", " ")
        lines.append(
            f"| `{r['fid']}` | **{r['theme']}** ({r['exigence']}) | `{r['gravite'].upper()}` / `{r['statut']}` "
            f"| **{r['dec_short']}** | {origin_lbl} | {r['porteur']} | `{r['echeance']}` | {clean_justif} |"
        )

    lines.extend(
        [
            "",
            "---",
            "",
            "## 3. Fiches Officielles d'Acceptation de Risque Résiduel & de Suivi par Constat",
            "",
        ]
    )

    for r in rows:
        derogation_notice = (
            "DÉROGATION OFFICIELLE — Co-signature obligatoire de la Direction Générale (Art. 20 NIS2 & PSSI §2.2) ; réexamen impératif à 90 jours."
            if r["dec_key"] == "risque_accepte"
            else (
                "CONTRÔLE COMPENSATOIRE — Vérification trimestrielle d'effectivité en Comité Cyber."
                if r["dec_key"] == "mesure_compensatoire"
                else (
                    "INVESTIGATION COMPLÉMENTAIRE — Collecte de preuves attendue avant clôture d'homologation."
                    if r["dec_key"] == "a_approfondir"
                    else "PLAN DE REMÉDIATION PRIORITAIRE — Clôture soumise à contre-vérification par sonde GCP."
                )
            )
        )
        lines.extend(
            [
                f"### [{r['fid']}] {r['theme']} — Décision : {r['dec_short']} ({r['dec_full']})",
                f"- **Exigence opposable** : {r['exigence']} • **Divergence** : `{r['contradiction']}`",
                f"- **Actif / Ressource cible** : `{r['ressource']}` • **Gravité initiale** : `{r['gravite'].upper()}` (`{r['statut']}`)",
                f"- **Statut d'instruction** : {'Arbitrage explicite scellé par le consultant' if r['is_explicit'] else 'Posture recommandée par défaut'} (*{r['updated_at']}*)",
                f"- **Porteur responsable** : **{r['porteur']}** • **Échéance opposable** : `{r['echeance']}`",
                f"- **Justification motivée / Plan d'action** : {r['commentaire']}",
                f"- **Clause de gouvernance Comité d'Audit** : {derogation_notice}",
                "",
            ]
        )

    lines.extend(
        [
            "---",
            "",
            "## 4. Visa d'Homologation & Co-Signatures Réglementaires (Article 20 NIS2)",
            "",
            "| Rôle & Instance de Gouvernance | Titulaire / Fonction | Statut de Revue | Signature / Date |",
            "| :--- | :--- | :--- | :--- |",
            "| **Direction Générale (Responsabilité Art. 20 NIS2)** | Directeur Général — CH de Valmont | À contre-signer en Comité Cyber | `[  ] Approuvé le ___/___/2026` |",
            "| **Direction des Systèmes d'Information** | M. Garnier — DSI | Porteur opérationnel du plan | `[  ] Approuvé le ___/___/2026` |",
            "| **Sécurité des Systèmes d'Information** | Mme Claire Moreau — RSSI | Contrôle de conformité PSSI | `[  ] Approuvé le ___/___/2026` |",
            f"| **Direction de Mission Audit Cyber** | Consultant Risk Advisory — Deloitte | **VALIDÉ HUMAINEMENT (`{active_mode}`)** | Scellé UTC `{now_iso}` |",
            "",
            "---",
            "",
            "## 5. Sceau Cryptographique d'Opposabilité TRIAD",
            "",
            "- **Verrou humain `HTTP 403`** : levé explicitement par approbation du consultant ; toute modification ultérieure d'un arbitrage révoque automatiquement la validation et scelle un bloc `FINDING_DECISION_UPDATED`.",
            f"- **Session & Mode** : `{session_id}` / `{active_mode}`",
            f"- **Empreinte SHA-256 de tête (`06_Audit_Chain.jsonl`)** : `{head_hash}`",
            "",
        ]
    )
    return "\n".join(lines)


def render_cnil_draft_markdown(
    *,
    session_id: str,
    active_mode: AuditMode,
    slot: dict[str, Any],
    syn: dict[str, Any],
    chain_info: dict[str, Any],
    head_hash: str,
) -> str:
    """Génère la Pré-Évaluation de Notification CNIL (RGPD Art. 33 & Art. 34) et l'articulation Double Guichet ANSSI + CNIL."""
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    client_name = str(syn.get("client") or "Centre Hospitalier de Valmont")
    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    by_id: dict[str, dict[str, Any]] = {
        str(f.get("id")): f for f in findings if f.get("id")
    }
    decisions_map: dict[str, Any] = dict(slot.get("decisions") or {})
    is_apres = active_mode == "APRES" or "F-004" in by_id
    chain_ok = bool(chain_info.get("valide"))
    nb_entrees = int(chain_info.get("nb_entrees") or 0)

    decision_labels = {
        "CORRIGER": "CORRIGER (Remédiation prioritaire)",
        "ACCEPTER_RISQUE": "ACCEPTER LE RISQUE (Dérogation motivée)",
        "TRANSFÉRER": "TRANSFÉRER (Tiers / Cyber-assurance)",
        "FAUX_POSITIF": "FAUX POSITIF (Écart écarté sur preuve)",
    }

    posture_banner = (
        "APRÈS ENTRETIEN CONTRADICTOIRE (`APRES` — Dit ≠ Écrit ≠ Réel) — Incident prestataire de septembre (`F-004`) + Exposition publique HDS (`F-001`)"
        if is_apres
        else "AVANT ENTRETIEN (`AVANT` — Écrit ≠ Réel) — Qualification préventive DPO sur exposition publique HDS (`F-001`) & accès tiers (`F-006`)"
    )

    lines: list[str] = [
        "# PRÉ-ÉVALUATION DE NOTIFICATION CNIL — VIOLATION DE DONNÉES (RGPD ART. 33 & ART. 34)",
        "",
        "> **AVERTISSEMENT D'USAGE RÉGLEMENTAIRE** : Ce document est un **projet d'instruction contradictoire DPO / RSSI** généré sous verrou humain (`HTTP 403`). **TRIAD n'effectue aucun envoi automatisé vers le téléservice de la CNIL (`notifications.cnil.fr`) ni vers l'ANSSI.** La qualification juridique finale et la télédéclaration relèvent exclusivement du **Responsable de Traitement** (Direction Générale) assisté du **Délégué à la Protection des Données (DPO)**.",
        "",
        "## 1. Identification de l'Entité de Santé & Contexte d'Audit",
        "",
        f"- **Responsable de traitement** : {client_name} (Établissement de santé — Entité Essentielle NIS2 & périmètre Données de Santé à Caractère Personnel — DSCP / HDS)",
        f"- **Session & Mode d'audit** : `{session_id}` — {posture_banner}",
        f"- **Horodatage de génération** : {now_iso}",
        "- **Délégué à la Protection des Données (DPO)** : `[À COMPLÉTER PAR LE DPO — Nom, numéro de désignation CNIL, contact direct 24/7]`",
        "- **RSSI / Référent Sécurité SI** : `[À COMPLÉTER PAR LE RSSI — Coordonnées cellule de crise]`",
        f"- **Intégrité de la chaîne de preuves TRIAD** : {'INTÈGRE ✓' if chain_ok else 'À VÉRIFIER'} ({nb_entrees} maillons SHA-256, empreinte de tête `{head_hash[:24]}…`)",
        "",
        "## 2. Articulation Réglementaire « Double Guichet » (ANSSI NIS2 + CNIL RGPD)",
        "",
        "En secteur hospitalier, un incident ou une exposition non maîtrisée affectant des compartiments d'imagerie ou de messagerie déclenche une **double obligation déclarative autonome et cumulative** :",
        "",
        "| Autorité / Destinataire | Base légale | Délai légal | Seuil de déclenchement | Livrable TRIAD associé |",
        "| :--- | :--- | :--- | :--- | :--- |",
        "| **ANSSI** (`monservicesecurise.cyber.gouv.fr`) | Directive (UE) 2022/2555 **NIS2 Art. 23 §4** | **< 24 h** (alerte précoce) • **< 72 h** (notification) • **< 1 mois** (rapport final) | Incident ayant un impact significatif sur la fourniture des services essentiels de soins ou la sécurité réseau/SI | `07_PreNotification_ANSSI_Art23.md` |",
        "| **CNIL** (`notifications.cnil.fr`) | **RGPD Art. 33 §1 & §4** + **HDS Exigence 5.4** | **≤ 72 h** après prise de connaissance (notification en 2 étapes possible — Art. 33 §4 ; motivation obligatoire si > 72 h — Art. 33 §1 al. 2) | Toute violation de sécurité entraînant, de manière accidentelle ou illicite, la divulgation ou l'accès non autorisé à des DCP / DSCP (sauf absence probable de risque) | **`12_Evaluation_CNIL_RGPD_Art33.md`** (présent document) |",
        "| **Personnes concernées (Patients / Agents)** | **RGPD Art. 34 §1–§3** | **Dans les meilleurs délais** | Violation susceptible d'engendrer un **risque élevé** pour les droits et libertés des patients (données de santé Art. 9 RGPD) | Section 5 ci-dessous |",
        "",
        "## 3. Qualification Factuelle des Faits Générateurs (Périmètre DSCP / HDS)",
        "",
        "### 3.1 Exposition publique Internet du compartiment d'imagerie (`F-001` — Critique)",
        "- **Constat technique prouvé (`Réel` GCP)** : La sonde en lecture seule sur `gs://ch-valmont-demo-export-radiologie` établit la présence d'une liaison IAM publique `allUsers` avec le rôle `roles/storage.objectViewer` (`public_access_prevention = inherited` non forcé à `enforced`).",
        "- **Nature des données exposées** : Compartiment dédié aux exports d'imagerie médicale et comptes rendus radiologiques relevant des **données concernant la santé (RGPD Art. 9)** et du référentiel **HDS v2.0 (Exigences 4.2 & 4.5)**.",
        "- **Facteur aggravant de traçabilité (`F-007`)** : La rétention du puits Cloud Logging `_Default` est plafonnée à **30 jours** non verrouillés (contre 365 j requis par la PSSI §6.1). Conformément à la doctrine de la CNIL et au principe d'*Accountability* (**RGPD Art. 5 §2**), l'impossibilité technique d'écarter formellement tout téléchargement non autorisé au-delà des 30 derniers jours **commande une présomption de risque justifiant la notification préventive Art. 33 (< 72 h à compter du constat d'audit)**.",
        "",
    ]

    if is_apres:
        f4 = by_id.get("F-004") or {}
        f4_desc = str(
            f4.get("recommandation")
            or "Qualifier immédiatement le périmètre exact des boîtes aux lettres et pièces jointes médicales potentiellement consultées lors de l'incident de septembre."
        )
        lines.extend(
            [
                "### 3.2 Compromission de messagerie prestataire non notifiée (`F-004` — Spécifique Mode `APRES`)",
                "- **Révélation contradictoire (`Dit` vs `Écrit`)** : Lors de l'entretien avec la DSI (`notes_entretien_DSI.md`), il a été reconnu à l'oral qu'un **compte de messagerie d'un prestataire externe a subi une compromission en septembre**, maîtrisée en interne sans saisine documentée du DPO, sans inscription au registre des violations (**RGPD Art. 33 §5**) et sans notification à la CNIL ni à l'ANSSI.",
                "- **Qualification RGPD Art. 33 §1 alinéa 2 (Notification tardive > 72 h)** : Le délai initial de 72 heures par rapport à l'événement de septembre étant dépassé, la notification à la CNIL — si l'exposition de données personnelles ou médicales dans les échanges de messagerie est confirmée ou ne peut être exclue — **doit impérativement être accompagnée des motifs du retard** :",
                "  1. Absence d'escalade vers le DPO lors du traitement purement technique de l'incident en septembre ;",
                "  2. Détection formelle de l'écart lors de l'audit contradictoire indépendant TRIAD ;",
                "  3. Ouverture immédiate d'une investigation rétrospective et refonte du circuit d'alerte interne PSSI §6.2.",
                f"- **Action immédiate requise** : {f4_desc}",
                "",
            ]
        )
    else:
        lines.extend(
            [
                "### 3.2 Points de levée de doute contradictoire avant clôture (`AVANT` — Pré-entretien)",
                "- **Périmètre actuel (`Écrit ≠ Réel`)** : Aucun déclaratif oral n'a encore été consolidé dans ce mode. Aucun incident historique de type compromission de compte n'est documenté dans les pièces écrites fournies.",
                "- **Vérification impérative en séance avec le DPO et la DSI** : Confirmer l'absence de tout incident de sécurité ou de messagerie survenu au cours des 12 derniers mois non inscrit au registre interne des violations (**RGPD Art. 33 §5**).",
                "",
            ]
        )

    lines.extend(
        [
            "### 3.3 Exposition liée au sous-traitant tiers hors registre (`F-006` — RGPD Art. 28 & Art. 32 §4)",
            "- **Constat technique** : Le compte de service externe `svc-medsoft-maint@ch-valmont-demo.iam.gserviceaccount.com` détient le rôle primitif `roles/owner` sur l'ensemble du projet Cloud sans figurer au registre officiel des tiers autorisés ni disposer d'un avenant de sous-traitance **RGPD Art. 28** audité.",
            "- **Impact CNIL** : Exiger du prestataire MedSoft l'attestation d'absence de compromission de clé privée de compte de service et révoquer immédiatement le privilège `roles/owner`.",
            "",
            "## 4. Pré-Remplissage Structuré du Téléservice CNIL (RGPD Art. 33 §3)",
            "",
            "| Rubrique officielle CNIL (Art. 33 §3) | Éléments factuels pré-remplis par TRIAD | Compléments requis du DPO |",
            "| :--- | :--- | :--- |",
            "| **a) Nature de la violation** | Violation de **confidentialité** (exposition publique `allUsers: objectViewer` sur `gs://ch-valmont-demo-export-radiologie`"
            + (
                " + compromission de compte messagerie prestataire en septembre `F-004`"
                if is_apres
                else ""
            )
            + ") ; vulnérabilité de **disponibilité** identifiée en parallèle sur `backup-dpi` (`F-003`, sans chiffrement malveillant constaté à ce jour). | Préciser la date exacte de création du binding `allUsers` (via journaux IAM Admin Activity conservés 400 j sur GCP) et le nombre d'objets présents dans le bucket. |",
            "| **a bis) Catégories & nombre approximatif de personnes / enregistrements** | Patients ayant fait l'objet d'un export radiologique temporaire vers `export-radiologie`"
            + (
                " et personnes citées dans le fil de messagerie prestataire compromis en septembre"
                if is_apres
                else ""
            )
            + " (**données de santé Art. 9 RGPD** : métadonnées DICOM, identifiants patients, clichés ou comptes rendus). | `[À COMPLÉTER PAR LE DPO : volumétrie exacte d'objets GCS & nombre de patients distincts]` |",
            "| **b) Nom et coordonnées du DPO** | Délégué à la Protection des Données du "
            + client_name
            + " | `[À COMPLÉTER : Identité, mél fonctionnel dpo@..., téléphone direct]` |",
            "| **c) Conséquences probables de la violation** | Accès potentiel sans authentification par des tiers non habilités ou moteurs d'indexation à des fichiers d'imagerie médicale ; atteinte au secret médical (Art. L.1110-4 CSP) et risque d'usurpation ou de chantage ciblé. | Évaluer si les fichiers déposés contenaient des données directement identifiantes (nom/NIR dans les en-têtes DICOM) ou pseudonymisées. |",
            "| **d) Mesures prises ou proposées pour remédier à la violation** | 1. Suppression immédiate du binding `allUsers` et activation `public_access_prevention = enforced` (`04_Playbook_DryRun.sh` / `09_Remediation_GitOps.tf`) ;<br>2. Fermeture du port SSH `0.0.0.0/0` (`F-002`) ;<br>3. Révocation `roles/owner` de `svc-medsoft-maint` (`F-006`) ;<br>4. Passage de la rétention Cloud Logging `_Default` à **365 jours verrouillés** et activation des `DATA_READ` Audit Logs (`F-007`). | Joindre l'horodatage effectif d'exécution du changement en production après revue humaine CAB/DSI. |",
            "",
            "## 5. Évaluation de la Communication Individuelle aux Patients (RGPD Art. 34)",
            "",
            "L'**article 34 §1 du RGPD** impose d'informer directement les patients en termes clairs et simples lorsque la violation est susceptible d'engendrer un **risque élevé** pour leurs droits et libertés. S'agissant de **données de santé (Art. 9 RGPD)** d'un établissement hospitalier, le CEPD (Lignes directrices WP250 rev.01) retient par principe une présomption de risque élevé si une exfiltration effective ou une indexation publique a eu lieu.",
            "",
            "- **Examen de l'exemption de chiffrement (Art. 34 §3 a)** : **NON APPLICABLE** pour l'exposition `allUsers` (`F-001`). Le chiffrement au repos par défaut côté Google Cloud déchiffre automatiquement les objets servis en HTTPS à tout appelant disposant du droit `objectViewer` (`allUsers`), et les compartiments ne disposent pas d'un chiffrement applicatif bout-en-bout côté client (`F-007`).",
            "- **Examen des mesures subséquentes (Art. 34 §3 b)** : Si l'analyse immédiate des journaux Cloud Storage sur les 30 derniers jours et des métadonnées d'objets démontre l'**absence totale de fichier nominatif déposé** ou l'**absence avérée de requête externe avant coupure immédiate de `allUsers`**, le DPO pourra documenter au registre Art. 33 §5 que le risque élevé ne s'est plus susceptible de se matérialiser.",
            "- **Recommandation opérationnelle DPO** : Procéder à une **notification initiale conservatoire à la CNIL sous 72 h (Art. 33 §4)** dès validation du présent constat, et statuer sous 48 h avec la Direction Médicale sur l'activation de la communication individuelle aux patients (**Art. 34**) au vu de l'inventaire exact des objets présents dans `gs://ch-valmont-demo-export-radiologie`"
            + (
                " et des boîtes aux lettres impactées par l'incident de septembre (`F-004`)."
                if is_apres
                else "."
            ),
            "",
            "## 6. Alignement avec les Arbitrages GRC de la Session",
            "",
        ]
    )

    cnil_fids = ["F-001", "F-004", "F-006", "F-007"]
    present_cnil_fids = [fid for fid in cnil_fids if fid in by_id or fid in decisions_map]
    if not present_cnil_fids:
        present_cnil_fids = ["F-001", "F-006", "F-007"]

    for fid in present_cnil_fids:
        f_obj = by_id.get(fid) or {}
        theme = str(f_obj.get("theme") or fid)
        dec = decisions_map.get(fid)
        if isinstance(dec, dict) and dec.get("decision"):
            raw_d = str(dec.get("decision"))
            lbl_d = str(
                dec.get("decision_label")
                or VALID_GRC_DECISIONS.get(raw_d)
                or decision_labels.get(raw_d)
                or raw_d
            )
            justif = str(
                dec.get("commentaire") or dec.get("justification") or "Non renseignée"
            )
            owner = str(dec.get("porteur") or dec.get("owner") or "DPO / RSSI")
            deadline = str(
                dec.get("echeance") or dec.get("deadline") or "Immédiat (< 72 h)"
            )
            lines.append(
                f"- **`{fid}` ({theme})** : **{lbl_d}** — Porteur : `{owner}` • Échéance : `{deadline}` • Justification : *{justif}*"
            )
        else:
            lines.append(
                f"- **`{fid}` ({theme})** : *Aucun arbitrage dérogatoire enregistré — Remédiation technique immédiate recommandée par défaut.*"
            )

    lines.extend(
        [
            "",
            "## 7. Sceau Forensique & Chaîne de Preuve TRIAD",
            "",
            "- **Contrôle humain obligatoire** : Livrable déverrouillé uniquement après approbation explicite du consultant (`POST /api/validate`). Toute modification ultérieure d'un arbitrage GRC révoque la validation et rétablit le verrou `HTTP 403`.",
            f"- **Session / Mode** : `{session_id}` / `{active_mode}`",
            f"- **Empreinte SHA-256 de tête (`06_Audit_Chain.jsonl`)** : `{head_hash}`",
            "",
        ]
    )
    return "\n".join(lines)


def build_sealed_json_payload(
    session_id: str,
    active_mode: AuditMode,
    slot: dict[str, Any],
    entries: list[dict[str, Any]],
    chain_info: dict[str, Any],
) -> dict[str, Any]:
    head_hash = entries[-1]["hash"] if entries else GENESIS_HASH
    distinct_runs = list(dict.fromkeys(e.get("run_id") for e in entries if e.get("run_id")))
    return {
        "schema_version": "1.0",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
        "mode": active_mode,
        "run_id": slot.get("run_id"),
        "validated": True,
        "statut_validation": slot["synthesis"].get("statut_validation", "VALIDÉ"),
        "elapsed_seconds": slot.get("elapsed_seconds"),
        "timings_ms": dict(slot.get("timings_ms") or {}),
        "decisions": dict(slot.get("decisions") or {}),
        "source": slot.get("source"),
        "synthesis": slot["synthesis"],
        "integrity": {
            "algorithm": "SHA-256",
            "chain": chain_info,
            "genesis_hash": GENESIS_HASH,
            "head_hash": head_hash,
            "nb_entrees": len(entries),
            "runs": distinct_runs,
        },
        "chain": chain_info,
        "audit_log": entries,
    }


_CSV_FORMULA_PREFIXES = ("=", "+", "-", "@")


def _sanitize_csv_cell(value: Any) -> str:
    """Neutralise l'injection de formules CSV/Excel (=, +, -, @, tab, CR) en préfixant par '."""
    if value is None:
        return ""
    raw_str = str(value)
    if not raw_str:
        return ""
    starts_with_ctrl = raw_str[0] in ("\t", "\r")
    collapsed = raw_str.replace("\r\n", " ").replace("\r", " ").replace("\n", " ").strip()
    if not collapsed:
        return ""
    if starts_with_ctrl or collapsed.startswith(_CSV_FORMULA_PREFIXES):
        return f"'{collapsed}"
    return collapsed


def render_csv_bytes(syn: dict[str, Any], active_mode: AuditMode, head_hash: str) -> bytes:
    client_name = syn.get("client", "Centre Hospitalier de Valmont")
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=",", quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    writer.writerow(
        [
            "ID",
            "Client",
            "Mode",
            "Thème",
            "Exigence NIS2",
            "Statut",
            "Gravité",
            "Contradiction",
            "Dit (Source)",
            "Dit (Extrait)",
            "Écrit (Source & Section)",
            "Écrit (Extrait)",
            "Réel (Ressource GCP)",
            "Réel (Constat)",
            "Citation Vérifiée",
            "Confiance",
            "Recommandation",
            "Commande Corrective (Dry-Run)",
            "Décision GRC",
            "Porteur Métier",
            "Échéance Cible",
            "Commentaire d'Arbitrage",
            "Empreinte SHA-256",
        ]
    )

    for f in syn.get("findings", []):
        if not isinstance(f, dict):
            continue
        dit = f.get("dit") if isinstance(f.get("dit"), dict) else {}
        ecrit = f.get("ecrit") if isinstance(f.get("ecrit"), dict) else {}
        reel = f.get("reel") if isinstance(f.get("reel"), dict) else {}
        dec = f.get("decision_grc") if isinstance(f.get("decision_grc"), dict) else {}
        ecrit_src = ecrit.get("source", "")
        ecrit_sec = ecrit.get("section", "")
        ecrit_ref = f"{ecrit_src} ({ecrit_sec})".strip() if ecrit_src and ecrit_sec else ecrit_src

        row = [
            f.get("id", ""),
            client_name,
            active_mode,
            f.get("theme", ""),
            f.get("exigence_nis2", ""),
            f.get("statut", ""),
            f.get("gravite", ""),
            f.get("contradiction") or "",
            dit.get("source", "") if dit else "",
            dit.get("extrait", "") if dit else "",
            ecrit_ref,
            ecrit.get("extrait", "") if ecrit else "",
            reel.get("ressource", "") if reel else "",
            reel.get("constat", "") if reel else "",
            "OUI" if f.get("citation_verifiee") else "NON",
            f.get("confiance", ""),
            f.get("recommandation", ""),
            f.get("commande_correction") or "",
            dec.get("decision_label") or dec.get("decision") or "",
            dec.get("porteur", "") if dec else "",
            dec.get("echeance", "") if dec else "",
            dec.get("commentaire", "") if dec else "",
            head_hash,
        ]
        writer.writerow([_sanitize_csv_cell(col) for col in row])

    return buf.getvalue().encode("utf-8-sig")


_UNSAFE_SHELL_RE = re.compile(r"[;|`<>]|\$\(")


def _is_safe_gcloud_chain(cmd: str) -> bool:
    parts = [p.strip() for p in cmd.split("&&")]
    if not parts:
        return False
    return all(
        part.startswith("gcloud ") and not _UNSAFE_SHELL_RE.search(part)
        for part in parts
    )


def render_playbook_script(
    session_id: str,
    active_mode: AuditMode,
    slot: dict[str, Any],
    syn: dict[str, Any],
    chain_info: dict[str, Any],
    head_hash: str,
) -> str:
    now_iso = datetime.now(timezone.utc).isoformat()
    chain_label = "VALIDE" if chain_info.get("valide") else "ALTÉRÉE"

    lines = [
        "#!/usr/bin/env bash",
        "# ==============================================================================",
        "# TRIAD — Playbook de Remédiation Cloud (NIS2) — DRY-RUN SCELLÉ SHA-256",
        f"# Client           : {syn.get('client', 'Client')}",
        f"# Mode / Statut    : {active_mode} | {syn.get('statut_validation', 'VALIDÉ')}",
        f"# Session / Run ID : {session_id} / {slot.get('run_id') or 'n/a'}",
        f"# Empreinte SHA-256: {head_hash}",
        f"# Intégrité chaîne : {chain_label} ({chain_info.get('nb_entrees', 0)} maillons)",
        f"# Généré le (UTC)  : {now_iso}",
        "# SÉCURITÉ         : Mode DRY-RUN actif par défaut (EXECUTE=false).",
        "#                    Aucune commande n'est jamais exécutée par les agents IA.",
        "# ==============================================================================",
        "set -euo pipefail",
        "",
        'EXECUTE="${EXECUTE:-false}"',
        f'EXPECTED_CHAIN_HASH="{head_hash}"',
        "",
        'echo "=== Playbook de remédiation NIS2 — TRIAD (SHA-256: ${EXPECTED_CHAIN_HASH:0:16}...) ==="',
        'if [[ "${EXECUTE}" != "true" ]]; then',
        '  echo "[MODE DRY-RUN] Simulation active : aucune modification ne sera envoyée à Google Cloud."',
        '  echo "Pour exécuter avec confirmation interactive étape par étape : EXECUTE=true bash $0"',
        "fi",
        "",
    ]

    actionable_count = 0
    for f in syn.get("findings", []):
        raw_cmd = (f.get("commande_correction") or "").strip()
        if not raw_cmd:
            continue
        clean_cmd = re.sub(
            r"\s*\(NON\s+EX[ÉE]CUT[ÉE]E?\)\s*$",
            "",
            raw_cmd,
            flags=re.IGNORECASE,
        ).strip()
        if not clean_cmd:
            continue

        actionable_count += 1
        fid = str(f.get("id", f"STEP-{actionable_count:03d}"))
        theme = str(f.get("theme", "Contrôle")).replace('"', "'")
        gravite = str(f.get("gravite", "")).upper()
        exigence = str(f.get("exigence_nis2", ""))
        ressource = str((f.get("reel") or {}).get("ressource", "GCP")).replace('"', "'")

        lines.extend(
            [
                "# ------------------------------------------------------------------------------",
                f"# [{fid}] {theme} ({gravite} — {exigence})",
                f"# Ressource : {ressource}",
                "# ------------------------------------------------------------------------------",
                'echo ""',
                f'echo "[{fid}] {theme} — {ressource}"',
            ]
        )

        if _is_safe_gcloud_chain(clean_cmd):
            escaped_preview = clean_cmd.replace("\\", "\\\\").replace('"', '\\"')
            lines.extend(
                [
                    f'echo "  Commande : {escaped_preview}"',
                    'if [[ "${EXECUTE}" == "true" ]]; then',
                    f'  read -r -p "  Confirmer l\'exécution réelle de [{fid}] sur GCP ? (taper OUI) : " _confirm',
                    '  if [[ "${_confirm}" == "OUI" ]]; then',
                    f"    {clean_cmd}",
                    f'    echo "  -> [EXÉCUTÉ] Remédiation [{fid}] appliquée."',
                    "  else",
                    f'    echo "  -> [IGNORÉ] Étape [{fid}] annulée par l\'opérateur."',
                    "  fi",
                    "else",
                    f'  echo "  -> [DRY-RUN] Aucune action exécutée pour [{fid}]."',
                    "fi",
                    "",
                ]
            )
        else:
            commented = clean_cmd.replace("\n", " ")
            lines.extend(
                [
                    f"# [REVUE MANUELLE REQUISE] Commande hors gabarit gcloud strict : {commented}",
                    f'echo "  -> [MANUEL] Vérifier et appliquer manuellement la mesure corrective [{fid}]."',
                    "",
                ]
            )

    lines.append(
        f'echo "=== Fin du playbook TRIAD ({actionable_count} remédiation(s) gcloud référencée(s)) ==="'
    )
    return "\n".join(lines) + "\n"
