"""Scores NIS2, estimation d'effort et simulation de remédiation (calculs purs, sans état HTTP)."""

from __future__ import annotations

import math
import re
from typing import Any

from triad.models import AuditMode


def compute_nis2_score(findings: list[dict[str, Any]]) -> int:
    """Calcule l'indice de maturité NIS2 (0-100) en parité exacte avec le comparateur UI."""
    if not findings:
        return 0
    total = 0
    for f in findings:
        statut = f.get("statut")
        if statut == "conforme":
            total += 100
        elif statut == "partiel":
            total += 55
        elif statut == "a_confirmer":
            total += 40
    return math.floor((total / len(findings)) + 0.5)


def _estimate_finding_effort_and_horizon(
    finding: dict[str, Any],
) -> tuple[str, str, float, float, float, str]:
    """Estime l'effort (j.h) et l'horizon (0_30 / 30_60 / 60_90) d'un chantier de remédiation."""
    statut = str(finding.get("statut") or "")
    if statut == "conforme":
        return "faible", "Maintien en condition conforme", 0.0, 0.0, 0.0, "60_90"

    reel = finding.get("reel") if isinstance(finding.get("reel"), dict) else {}
    hay = (
        f"{finding.get('theme') or ''} "
        f"{finding.get('exigence_nis2') or ''} "
        f"{reel.get('ressource') or ''}"
    ).lower()
    cmd = str(finding.get("commande_correction") or "")
    has_cli = bool(cmd.strip())

    effort = "modere"
    effort_label = "Modéré (3 – 6 j.h)"
    min_jh, max_jh, avg_jh = 3.0, 6.0, 4.5

    if (
        has_cli
        and re.search(r"allusers|allow-ssh|firewall|versioning|retention", f"{cmd} {hay}", re.I)
        and not re.search(r"iam|kms|serviceaccount", hay, re.I)
    ):
        effort = "faible"
        effort_label = "Quick-Win Cloud (0,5 – 2 j.h)"
        min_jh, max_jh, avg_jh = 0.5, 2.0, 1.25
    elif (
        re.search(r"incident|notification|anssi|art\.\s*23|pacs|pra|pca|gouvernance", hay, re.I)
        and not has_cli
    ):
        effort = "structurant"
        effort_label = "Structurant (8 – 15 j.h)"
        min_jh, max_jh, avg_jh = 8.0, 15.0, 11.5
    elif re.search(r"iam|kms|logging|journal|privil|serviceaccount|sauvegarde|backup", hay, re.I):
        effort = "modere"
        effort_label = "Modéré IAM / SecOps (4 – 8 j.h)"
        min_jh, max_jh, avg_jh = 4.0, 8.0, 6.0

    gravite = str(finding.get("gravite") or "")
    if effort == "structurant" or gravite in {"faible", "moyenne"}:
        horizon = "60_90"
    elif effort == "faible" and gravite in {"critique", "haute"}:
        horizon = "0_30"
    else:
        horizon = "30_60"

    return effort, effort_label, min_jh, max_jh, avg_jh, horizon


def _pillar_single_score(f: dict[str, Any]) -> int:
    st = f.get("statut")
    if st == "conforme":
        return 94
    if st == "partiel":
        return 55
    if st == "a_confirmer":
        return 42
    return 14 if f.get("gravite") == "critique" else 26


def _finding_art34_risk_weight(f: dict[str, Any]) -> float:
    st = f.get("statut")
    if st == "conforme":
        return 0.0
    grav = f.get("gravite")
    base = 100.0 if grav == "critique" else 75.0 if grav == "haute" else 45.0 if grav == "moyenne" else 20.0
    if st == "partiel":
        return base * 0.45
    if st == "a_confirmer":
        return base * 0.55
    return base


def _risk_level_from_index(risk_index: int, critical_open: int) -> str:
    if critical_open >= 1 or risk_index >= 65:
        return "CRITIQUE"
    if risk_index >= 35:
        return "ÉLEVÉ"
    if risk_index >= 12:
        return "MODÉRÉ"
    return "MAÎTRISÉ"


def compute_remediation_simulation(
    session_id: str,
    active_mode: AuditMode,
    syn: dict[str, Any] | None,
    raw_selected_ids: list[str],
) -> dict[str, Any]:
    selected_norm: list[str] = []
    selected_set: set[str] = set()
    for raw_id in raw_selected_ids:
        norm = str(raw_id or "").strip().upper()
        if norm and norm not in selected_set:
            selected_set.add(norm)
            selected_norm.append(norm)

    findings = (
        [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
        if isinstance(syn, dict)
        else []
    )
    projected_findings: list[dict[str, Any]] = []
    remediated_ids: list[str] = []
    actionable_ids: list[str] = []
    items_out: list[dict[str, Any]] = []

    total_min_jh = 0.0
    total_max_jh = 0.0
    total_est_jh = 0.0
    quick_wins_count = 0
    by_horizon: dict[str, dict[str, Any]] = {
        "0_30": {"count": 0, "estimated_jh": 0.0, "finding_ids": []},
        "30_60": {"count": 0, "estimated_jh": 0.0, "finding_ids": []},
        "60_90": {"count": 0, "estimated_jh": 0.0, "finding_ids": []},
    }

    for f in findings:
        fid = str(f.get("id") or "").strip().upper()
        cur_statut = str(f.get("statut") or "a_confirmer")
        is_actionable = cur_statut != "conforme"
        if is_actionable:
            actionable_ids.append(fid)

        effort, effort_label, f_min, f_max, f_avg, horizon = _estimate_finding_effort_and_horizon(f)
        is_selected = fid in selected_set
        is_remediated = is_selected and is_actionable

        proj_copy = dict(f)
        if is_remediated:
            proj_copy["statut"] = "conforme"
            remediated_ids.append(fid)
            total_min_jh += f_min
            total_max_jh += f_max
            total_est_jh += f_avg
            if effort == "faible":
                quick_wins_count += 1
            by_horizon[horizon]["count"] += 1
            by_horizon[horizon]["estimated_jh"] = round(
                by_horizon[horizon]["estimated_jh"] + f_avg, 1
            )
            by_horizon[horizon]["finding_ids"].append(fid)

        projected_findings.append(proj_copy)
        items_out.append(
            {
                "id": fid,
                "theme": f.get("theme", ""),
                "exigence_nis2": f.get("exigence_nis2", ""),
                "gravite": f.get("gravite", ""),
                "statut_actuel": cur_statut,
                "statut_projete": proj_copy["statut"],
                "selected": is_selected,
                "remediated": is_remediated,
                "effort": effort,
                "effort_label": effort_label,
                "estimated_jh": round(f_avg, 1),
                "min_jh": round(f_min, 1),
                "max_jh": round(f_max, 1),
                "horizon": horizon,
            }
        )

    current_score = compute_nis2_score(findings)
    projected_score = compute_nis2_score(projected_findings)

    pillar_specs = [
        (
            "data-exposure",
            "Protection & Cloisonnement des Données de Santé",
            "Art. 21 §2 (i) — Stockage",
            20,
            lambda x: bool(
                re.search(
                    r"radiologie|exposition des données|public|allusers",
                    f"{x.get('theme') or ''} {(x.get('reel') or {}).get('ressource') or ''}",
                    re.I,
                )
            ),
        ),
        (
            "network-sec",
            "Sécurité Réseau & Administration Système",
            "Art. 21 §2 (i) — Flux",
            20,
            lambda x: bool(
                re.search(
                    r"ssh|pare-feu|réseau|firewall|bastion",
                    f"{x.get('theme') or ''} {(x.get('reel') or {}).get('ressource') or ''}",
                    re.I,
                )
            ),
        ),
        (
            "backup-pca",
            "Continuité d’Activité & Immuabilité des Sauvegardes",
            "Art. 21 §2 (c) — PCA / PRA",
            50,
            lambda x: bool(
                re.search(
                    r"sauvegarde|continuité|pacs|dpi|restauration|backup",
                    f"{x.get('theme') or ''} {x.get('exigence_nis2') or ''} {(x.get('reel') or {}).get('ressource') or ''}",
                    re.I,
                )
            ),
        ),
        (
            "iam-crypto",
            "Gouvernance IAM, Moindre Privilège & Cryptographie KMS",
            "Art. 21 §2 (h, i, j)",
            62,
            lambda x: bool(
                re.search(
                    r"iam|kms|chiffrement|cryptographie|serviceaccount|privil|clé",
                    f"{x.get('theme') or ''} {x.get('exigence_nis2') or ''} {(x.get('reel') or {}).get('ressource') or ''}",
                    re.I,
                )
                and not re.search(
                    r"radiologie|ssh",
                    f"{x.get('theme') or ''} {(x.get('reel') or {}).get('ressource') or ''}",
                    re.I,
                )
            ),
        ),
        (
            "incident-anssi",
            "Gestion des Incidents & Notification ANSSI",
            "Art. 23 — 24h / 72h / 1 mois",
            48 if active_mode == "AVANT" else 22,
            lambda x: bool(
                re.search(
                    r"incident|notification|anssi|art\.\s*23",
                    f"{x.get('theme') or ''} {x.get('exigence_nis2') or ''}",
                    re.I,
                )
            ),
        ),
    ]

    remediated_set = set(remediated_ids)
    pillars_out: list[dict[str, Any]] = []
    for pid, ptitle, particle, fallback_score, pred in pillar_specs:
        cur_matched = [f for f in findings if pred(f)]
        proj_matched = [f for f in projected_findings if pred(f)]
        if not cur_matched:
            cur_p = fallback_score
            proj_p = fallback_score
            m_ids: list[str] = []
        else:
            cur_p = math.floor(
                (sum(_pillar_single_score(f) for f in cur_matched) / len(cur_matched)) + 0.5
            )
            proj_p = math.floor(
                (sum(_pillar_single_score(f) for f in proj_matched) / len(proj_matched)) + 0.5
            )
            m_ids = [str(f.get("id") or "") for f in cur_matched if f.get("id")]

        pillars_out.append(
            {
                "id": pid,
                "title": ptitle,
                "article": particle,
                "current_score": cur_p,
                "projected_score": proj_p,
                "gain": proj_p - cur_p,
                "finding_ids": m_ids,
                "remediated_ids": [fid for fid in m_ids if fid in remediated_set],
            }
        )

    risk_before_raw = sum(_finding_art34_risk_weight(f) for f in findings)
    risk_after_raw = sum(_finding_art34_risk_weight(f) for f in projected_findings)
    max_possible_risk = max(100.0, len(findings) * 100.0) if findings else 100.0
    current_risk_index = (
        min(100, round((risk_before_raw / max_possible_risk) * 100)) if findings else 0
    )
    projected_risk_index = (
        min(100, round((risk_after_raw / max_possible_risk) * 100)) if findings else 0
    )
    exposure_reduction_pct = (
        round(((risk_before_raw - risk_after_raw) / risk_before_raw) * 100.0, 1)
        if risk_before_raw > 0
        else 0.0
    )
    crit_before = sum(
        1
        for f in findings
        if f.get("statut") != "conforme" and f.get("gravite") == "critique"
    )
    crit_after = sum(
        1
        for f in projected_findings
        if f.get("statut") != "conforme" and f.get("gravite") == "critique"
    )

    est_jh = round(total_est_jh, 1)
    min_jh = round(total_min_jh, 1)
    max_jh = round(total_max_jh, 1)
    workload_label = (
        f"{str(est_jh).replace('.', ',')} j.h "
        f"(fourchette {str(min_jh).replace('.', ',')} – {str(max_jh).replace('.', ',')} j.h)"
        if est_jh > 0
        else "0 j.h"
    )

    return {
        "session_id": session_id,
        "mode": active_mode,
        "has_synthesis": isinstance(syn, dict),
        "selected_ids": selected_norm,
        "remediated_ids": remediated_ids,
        "total_findings": len(findings),
        "actionable_findings": len(actionable_ids),
        "current_score": current_score,
        "projected_score": projected_score,
        "score_delta": projected_score - current_score,
        "workload_jh": {
            "estimated_jh": est_jh,
            "min_jh": min_jh,
            "max_jh": max_jh,
            "label": workload_label,
            "quick_wins_count": quick_wins_count,
            "by_horizon": by_horizon,
        },
        "art34_exposure": {
            "entity_category": "Entité Essentielle (Annexe I — Santé)",
            "article": "Art. 34 §4 Directive (UE) 2022/2555 (NIS2)",
            "plafond_sanction_eur": 10_000_000,
            "plafond_ca_pct": 2.0,
            "plafond_label": "Jusqu'à 10 M€ ou 2 % du CA annuel mondial",
            "current_risk_index": current_risk_index,
            "projected_risk_index": projected_risk_index,
            "exposure_reduction_pct": exposure_reduction_pct,
            "critical_gaps_before": crit_before,
            "critical_gaps_after": crit_after,
            "risk_level_before": _risk_level_from_index(current_risk_index, crit_before),
            "risk_level_after": _risk_level_from_index(projected_risk_index, crit_after),
        },
        "pillars": pillars_out,
        "items": items_out,
    }
