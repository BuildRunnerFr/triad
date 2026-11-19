"""Tests d'intégration du pipeline ADK TRIAD (chaîne append-only multi-runs, sécurité + bout-en-bout)."""

from __future__ import annotations

from pathlib import Path

import pytest

from triad.agents.pipeline import run_audit_pipeline
from triad.config import DATA_DIR
from triad.security.audit_log import AuditLogger, verify_chain
from triad.security.callbacks import make_security_callbacks, simulate_unauthorized_action


def test_new_gcp_tools_enforced_by_security_callbacks(tmp_path: Path) -> None:
    from types import SimpleNamespace

    log_path = tmp_path / "rbac_gcp.jsonl"
    logger = AuditLogger(log_path, run_id="run-rbac", mode="APRES")
    before_tool = make_security_callbacks(logger)["before_tool_callback"]

    for tool_name in ("gcp_check_iam_privileges", "gcp_check_kms_and_logging"):
        allowed_ctx = SimpleNamespace(
            agent_name="AnalysteConformite",
            state={},
            actions=SimpleNamespace(escalate=False),
        )
        assert before_tool(SimpleNamespace(name=tool_name), {}, allowed_ctx) is None

        denied_ctx = SimpleNamespace(
            agent_name="ContreAuditeur",
            state={},
            actions=SimpleNamespace(escalate=False),
        )
        blocked = before_tool(SimpleNamespace(name=tool_name), {}, denied_ctx)
        assert blocked is not None and blocked["violation"] is True
        assert denied_ctx.actions.escalate is True

    assert verify_chain(log_path)["valide"] is True


def test_simulate_unauthorized_action_blocks_and_logs(tmp_path: Path) -> None:
    log_path = tmp_path / "sec.jsonl"
    logger = AuditLogger(log_path, run_id="run-sec-01", mode="APRES")
    res = simulate_unauthorized_action(logger)

    assert res["blocked"] is True
    assert res["escalated"] is True
    assert res["state"]["security_violation"] is True

    entries = logger.read_entries()
    assert len(entries) == 1
    assert entries[0]["action"] == "VIOLATION"
    assert entries[0]["agent"] == "AnalysteConformite"
    assert entries[0]["run_id"] == "run-sec-01"
    assert entries[0]["mode"] == "APRES"
    assert verify_chain(log_path)["valide"] is True


@pytest.mark.asyncio
async def test_pipeline_append_only_avant_then_apres_chaining(tmp_path: Path) -> None:
    log_path = tmp_path / "chained_pipeline.jsonl"
    demo_files = [
        DATA_DIR / "PSSI_CH_Valmont.md",
        DATA_DIR / "PV_test_restauration.md",
        DATA_DIR / "notes_entretien_DSI.md",
        DATA_DIR / "annexe_fournisseur_maintenance.md",
    ]

    res_avant = await run_audit_pipeline(
        input_files=demo_files,
        mode="AVANT",
        log_path=log_path,
        use_cache=True,
    )
    assert res_avant["chain"]["valide"] is True
    count_avant = res_avant["chain"]["nb_entrees"]
    assert count_avant >= 4

    res_apres = await run_audit_pipeline(
        input_files=demo_files,
        mode="APRES",
        log_path=log_path,
        use_cache=True,
    )
    assert res_apres["chain"]["valide"] is True
    assert res_apres["run_id"] != res_avant["run_id"]
    assert res_apres["chain"]["nb_entrees"] > count_avant

    logger = AuditLogger(log_path)
    entries_avant = logger.read_entries(run_id=res_avant["run_id"])
    entries_apres = logger.read_entries(run_id=res_apres["run_id"])
    assert len(entries_avant) == count_avant
    assert len(entries_apres) >= 5
    assert all(e["mode"] == "AVANT" for e in entries_avant)
    assert all(e["mode"] == "APRES" for e in entries_apres)
    assert entries_apres[0]["prev_hash"] == entries_avant[-1]["hash"]


@pytest.mark.asyncio
async def test_full_valmont_pipeline_live(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("USE_GCP_SNAPSHOT", "true")
    monkeypatch.setenv("USE_DEMO_CACHE", "false")

    demo_files = [
        DATA_DIR / "PSSI_CH_Valmont.md",
        DATA_DIR / "PV_test_restauration.md",
        DATA_DIR / "notes_entretien_DSI.md",
        DATA_DIR / "annexe_fournisseur_maintenance.md",
    ]

    result = await run_audit_pipeline(
        input_files=demo_files,
        mode="APRES",
        log_path=tmp_path / "audit.jsonl",
        use_cache=False,
    )

    assert result["elapsed_seconds"] < 90.0
    assert result["chain"]["valide"] is True

    syn = result["synthesis"]
    assert syn["statut_validation"] == "EN ATTENTE DE VALIDATION"

    # Quarantaine de l'annexe fournisseur + masquage IBAN avant quarantaine
    quarantined = syn["documents_quarantaine"]
    assert len(quarantined) == 1
    assert quarantined[0]["nom_fichier"] == "annexe_fournisseur_maintenance.md"
    assert "[IBAN_1]" in quarantined[0]["contenu_masque"]

    # Masquage PII sur la PSSI
    pssi_doc = next(d for d in syn["documents_nettoyes"] if d["nom_fichier"] == "PSSI_CH_Valmont.md")
    assert "[NOM_1]" in pssi_doc["contenu_masque"]
    assert "[EMAIL_1]" in pssi_doc["contenu_masque"]

    # Au moins 3 findings non conformes + règle citation_verifiee
    findings = syn["findings"]
    non_conformes = [f for f in findings if f["statut"] == "non_conforme"]
    assert len(non_conformes) >= 3

    for f in findings:
        assert f["citation_verifiee"] is True or f["statut"] == "a_confirmer"
