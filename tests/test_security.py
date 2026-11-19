"""Tests unitaires de la sécurité TRIAD (journal chaîné multi-runs, permissions, modèles)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from triad.models import Finding
from triad.security.audit_log import (
    GENESIS_HASH,
    AuditLogger,
    archive_to_worm_bucket,
    register_audit_listener,
    unregister_audit_listener,
    verify_chain,
)
from triad.security.permissions import is_tool_allowed


def test_audit_log_chain_and_tamper_detection(tmp_path: Path) -> None:
    log_file = tmp_path / "audit.jsonl"
    logger = AuditLogger(log_file)
    logger.append("Douanier", "READ_RAW", {"fichier": "PSSI_CH_Valmont.md"})
    logger.append("AnalysteConformite", "GCP_CHECK", {"check": "public_buckets"})
    logger.append("GardeDuCorps", "SYNTHESIS", {"statut": "EN ATTENTE DE VALIDATION"})

    ok = verify_chain(log_file)
    assert ok["valide"] is True
    assert ok["nb_entrees"] == 3

    # Altération manuelle de la ligne 2
    lines = log_file.read_text(encoding="utf-8").splitlines()
    tampered = json.loads(lines[1])
    tampered["action"] = "DELETE_BUCKET"
    lines[1] = json.dumps(tampered)
    log_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

    ko = verify_chain(log_file)
    assert ko["valide"] is False
    assert "altérée" in (ko["erreur"] or "").lower()


def test_audit_log_append_only_run_id_chaining_and_tamper(tmp_path: Path) -> None:
    log_file = tmp_path / "multi_run.jsonl"

    logger_avant = AuditLogger(log_file, run_id="run-avant-001", mode="AVANT")
    e1 = logger_avant.append("Douanier", "SANITIZED", {"fichier": "PSSI_CH_Valmont.md"})
    e2 = logger_avant.append("GardeDuCorps", "SYNTHESIS_READY", {"nb_findings": 3})

    # Second logger sur le même fichier sans reset : chaîne continue AVANT -> APRES
    logger_apres = AuditLogger(log_file, run_id="run-apres-002", mode="APRES")
    e3 = logger_apres.append("Douanier", "SANITIZED", {"fichier": "notes_entretien_DSI.md"})
    e4 = logger_apres.append("GardeDuCorps", "SYNTHESIS_READY", {"nb_findings": 5})

    assert e1["prev_hash"] == GENESIS_HASH
    assert e2["prev_hash"] == e1["hash"]
    assert e3["prev_hash"] == e2["hash"]
    assert e4["prev_hash"] == e3["hash"]
    assert e1["run_id"] == "run-avant-001" and e1["mode"] == "AVANT"
    assert e3["run_id"] == "run-apres-002" and e3["mode"] == "APRES"

    status = verify_chain(log_file)
    assert status["valide"] is True
    assert status["nb_entrees"] == 4
    assert len(logger_apres.read_entries(run_id="run-avant-001")) == 2
    assert len(logger_apres.read_entries(run_id="run-apres-002")) == 2

    # Toute modification de run_id brise l'empreinte SHA-256
    lines = log_file.read_text(encoding="utf-8").splitlines()
    forged = json.loads(lines[2])
    forged["run_id"] = "run-falsifie"
    lines[2] = json.dumps(forged)
    log_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

    broken = verify_chain(log_file)
    assert broken["valide"] is False
    assert "altérée" in (broken["erreur"] or "").lower()


def test_permissions_matrix() -> None:
    assert is_tool_allowed("Douanier", "read_raw_file") is True
    assert is_tool_allowed("Douanier", "gcp_check_public_buckets") is False
    assert is_tool_allowed("Douanier", "gcp_check_iam_privileges") is False
    assert is_tool_allowed("Douanier", "gcp_check_kms_and_logging") is False

    assert is_tool_allowed("AnalysteConformite", "gcp_check_public_buckets") is True
    assert is_tool_allowed("AnalysteConformite", "gcp_check_iam_privileges") is True
    assert is_tool_allowed("AnalysteConformite", "gcp_check_kms_and_logging") is True
    assert is_tool_allowed("AnalysteConformite", "read_raw_file") is False
    assert is_tool_allowed("AnalysteConformite", "delete_bucket") is False

    assert is_tool_allowed("ContreAuditeur", "verify_quote") is True
    assert is_tool_allowed("ContreAuditeur", "gcp_check_open_firewall") is False
    assert is_tool_allowed("ContreAuditeur", "gcp_check_iam_privileges") is False
    assert is_tool_allowed("ContreAuditeur", "gcp_check_kms_and_logging") is False

    assert is_tool_allowed("GardeDuCorps", "gcp_check_iam_privileges") is False
    assert is_tool_allowed("GardeDuCorps", "gcp_check_kms_and_logging") is False


def test_finding_pydantic_validation() -> None:
    with pytest.raises(ValidationError):
        Finding(
            id="BAD-ID",
            theme="Test",
            exigence_nis2="Art. 21",
            statut="non_conforme",
            gravite="critique",
            recommandation="Corriger",
            confiance=0.9,
        )


def test_realtime_audit_listener(tmp_path: Path) -> None:
    received: list[dict] = []

    def _cb(entry: dict) -> None:
        received.append(entry)

    register_audit_listener(_cb)
    try:
        logger = AuditLogger(tmp_path / "live.jsonl", run_id="run-test", mode="APRES")
        logger.append("Douanier", "SANITIZED", {"fichier": "PSSI_CH_Valmont.md"})
        assert len(received) == 1
        assert received[0]["agent"] == "Douanier"
        assert received[0]["run_id"] == "run-test"
        assert received[0]["mode"] == "APRES"
        assert len(received[0]["hash"]) == 64
    finally:
        unregister_audit_listener(_cb)


def test_worm_bucket_archive_noop_and_mocked_upload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log_path = tmp_path / "worm.jsonl"
    logger = AuditLogger(log_path, run_id="run-worm-01", mode="APRES")
    logger.append("ConsultantDeloitte", "HUMAN_VALIDATION", {"decision": "VALIDÉ"})

    # No-op propre en mode snapshot ou si AUDIT_LOGS_BUCKET est vide
    noop_empty = archive_to_worm_bucket(
        bucket_name="",
        use_gcp_snapshot=False,
        project_id="ch-valmont-prod",
        session_id="default",
        mode="APRES",
        run_id="run-worm-01",
        synthesis={"client": "CH Valmont"},
        log_path=log_path,
    )
    assert noop_empty["archived"] is False
    assert noop_empty["reason"] == "disabled_or_snapshot"

    noop_snap = archive_to_worm_bucket(
        bucket_name="ch-valmont-worm-logs",
        use_gcp_snapshot=True,
        project_id="ch-valmont-prod",
        session_id="default",
        mode="APRES",
        run_id="run-worm-01",
        synthesis={"client": "CH Valmont"},
        log_path=log_path,
    )
    assert noop_snap["archived"] is False

    # Upload WORM append-only (if_generation_match=0) lorsque configuré hors snapshot
    uploaded_calls: list[dict] = []

    class FakeBlob:
        def __init__(self, name: str) -> None:
            self.name = name

        def upload_from_string(
            self,
            data: str,
            content_type: str = "application/json",
            if_generation_match: int | None = None,
        ) -> None:
            uploaded_calls.append(
                {
                    "name": self.name,
                    "data": json.loads(data),
                    "content_type": content_type,
                    "if_generation_match": if_generation_match,
                }
            )

    class FakeBucket:
        def blob(self, name: str) -> FakeBlob:
            return FakeBlob(name)

    class FakeStorageClient:
        def __init__(self, project: str | None = None) -> None:
            self.project = project

        def bucket(self, name: str) -> FakeBucket:
            assert name == "ch-valmont-worm-logs"
            return FakeBucket()

    monkeypatch.setattr("google.cloud.storage.Client", FakeStorageClient)

    ok = archive_to_worm_bucket(
        bucket_name="gs://ch-valmont-worm-logs/",
        use_gcp_snapshot=False,
        project_id="ch-valmont-prod",
        session_id="sess-worm",
        mode="APRES",
        run_id="run-worm-01",
        synthesis={"client": "CH Valmont", "statut_validation": "VALIDÉ"},
        log_path=log_path,
    )
    assert ok["archived"] is True
    assert ok["object_uri"].startswith("gs://ch-valmont-worm-logs/audits/sess-worm/APRES_")
    assert len(uploaded_calls) == 1
    assert uploaded_calls[0]["if_generation_match"] == 0
    assert uploaded_calls[0]["data"]["integrity"]["chain"]["valide"] is True


def test_structured_cloud_logging_auto_kservice_json_and_violation_event(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    from triad.security.callbacks import simulate_unauthorized_action
    from triad.security.structured_log import resolve_log_format

    # 1. LOG_FORMAT=auto sans K_SERVICE -> format texte lisible
    monkeypatch.setenv("LOG_FORMAT", "auto")
    monkeypatch.delenv("K_SERVICE", raising=False)
    assert resolve_log_format() == "text"

    log_txt = tmp_path / "audit_trail_local-dev.jsonl"
    logger_txt = AuditLogger(log_txt, run_id="run-txt", mode="AVANT")
    capsys.readouterr()
    logger_txt.append("Douanier", "SANITIZED", {"fichier": "PSSI_CH_Valmont.md"})
    out_txt = capsys.readouterr().out.strip()
    assert out_txt.startswith("[TRIAD][INFO]")
    assert "session=local-dev" in out_txt
    assert "event_type=AUDIT_SANITIZED" in out_txt

    # 2. LOG_FORMAT=auto avec K_SERVICE défini (Cloud Run) -> bascule automatique en JSON
    monkeypatch.setenv("K_SERVICE", "triad-prod")
    assert resolve_log_format() == "json"

    log_k = tmp_path / "audit_trail_cloudrun-sess.jsonl"
    logger_k = AuditLogger(log_k, run_id="run-cr", mode="APRES")
    capsys.readouterr()
    e_ok = logger_k.append("Douanier", "QUARANTINE", {"fichier": "annexe.md"})
    rec_k = json.loads(capsys.readouterr().out.strip())
    assert rec_k["severity"] == "WARNING"
    assert rec_k["component"] == "triad"
    assert rec_k["service"] == "triad-prod"
    assert rec_k["session_id"] == "cloudrun-sess"
    assert rec_k["agent"] == "Douanier"
    assert rec_k["action"] == "QUARANTINE"
    assert rec_k["event_type"] == "PROMPT_INJECTION_QUARANTINED"
    assert rec_k["sha256"] == e_ok["hash"]

    # 3. LOG_FORMAT=json forcé (même hors K_SERVICE) + événement SECURITY_VIOLATION_BLOCKED
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.setenv("LOG_FORMAT", "json")
    assert resolve_log_format() == "json"

    log_viol = tmp_path / "audit_trail_sec-alert.jsonl"
    logger_viol = AuditLogger(log_viol, run_id="run-viol", mode="APRES")
    capsys.readouterr()
    viol_res = simulate_unauthorized_action(logger_viol)
    assert viol_res["blocked"] is True

    raw_line = capsys.readouterr().out.strip()
    rec_viol = json.loads(raw_line)
    assert rec_viol["severity"] == "CRITICAL"
    assert rec_viol["component"] == "triad"
    assert rec_viol["session_id"] == "sec-alert"
    assert rec_viol["agent"] == "AnalysteConformite"
    assert rec_viol["action"] == "VIOLATION"
    assert rec_viol["event_type"] == "SECURITY_VIOLATION_BLOCKED"
    assert len(rec_viol["sha256"]) == 64


def test_verify_entries_chain_in_memory_valid_and_tampered(tmp_path: Path) -> None:
    from triad.security.audit_log import verify_entries_chain

    log_path = tmp_path / "mem_chain.jsonl"
    logger = AuditLogger(log_path, run_id="r1", mode="APRES")
    logger.append("Douanier", "SANITIZED", {"doc": "a.md"})
    logger.append("ConsultantDeloitte", "HUMAN_VALIDATION", {"decision": "VALIDÉ"})
    entries = logger.read_entries()

    res_ok = verify_entries_chain(entries)
    assert res_ok["valide"] is True
    assert res_ok["nb_entrees"] == 2

    forged = [dict(e) for e in entries]
    forged[1]["action"] = "TAMPERED"
    res_ko = verify_entries_chain(forged)
    assert res_ko["valide"] is False
    assert "altérée" in (res_ko["erreur"] or "").lower()
