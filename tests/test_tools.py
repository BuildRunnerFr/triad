"""Tests unitaires des outils Python TRIAD (snapshot et API GCP mockées)."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

from triad.config import DATA_DIR
from triad.models import Finding
from triad.tools.gcp_tools import (
    gcp_check_backup_protection,
    gcp_check_iam_privileges,
    gcp_check_kms_and_logging,
    gcp_check_open_firewall,
    gcp_check_public_buckets,
    gcp_run_all_checks,
)
from triad.tools.doc_loader import clean_document_text, extract_sections, load_document
from triad.tools.injection_detector import scan_injection
from triad.tools.nis2_loader import get_nis2_requirements
from triad.tools.pii_redactor import redact_pii
from triad.tools.quote_verifier import verify_quote


def test_gcp_checks_snapshot(monkeypatch) -> None:
    monkeypatch.setenv("USE_GCP_SNAPSHOT", "true")

    buckets = gcp_check_public_buckets()
    public = [b for b in buckets if b["public"]]
    assert len(public) == 1
    assert "export-radiologie" in public[0]["bucket"]
    assert "allUsers" in public[0]["public_members"]

    fw = gcp_check_open_firewall()
    assert len(fw) == 1
    assert fw[0]["name"] == "allow-ssh-anywhere"
    assert "22" in fw[0]["exposed_sensitive_ports"]

    backups = gcp_check_backup_protection()
    by_name = {b["bucket"]: b for b in backups}
    assert any("backups-dpi" in k and not v["protege"] for k, v in by_name.items())
    assert any("archives-pacs" in k and v["protege"] for k, v in by_name.items())

    all_res = gcp_run_all_checks()
    assert set(all_res.keys()) == {
        "public_buckets",
        "open_firewall",
        "backup_protection",
        "iam_privileges",
        "kms_and_logging",
    }


def test_gcp_iam_privileges_and_kms_logging_snapshot(monkeypatch) -> None:
    monkeypatch.setenv("USE_GCP_SNAPSHOT", "true")

    iam = gcp_check_iam_privileges()
    assert iam["non_conforme"] is True
    roles = {b["role"] for b in iam["overprivileged_bindings"]}
    assert "roles/editor" in roles
    assert "roles/owner" in roles
    assert len(iam["stale_service_account_keys"]) >= 1
    assert iam["stale_service_account_keys"][0]["age_days"] > 90
    assert iam["stale_service_account_keys"][0]["non_conforme"] is True

    kms_log = gcp_check_kms_and_logging()
    assert kms_log["non_conforme"] is True
    keys_by_name = {k["name"].rsplit("/", 1)[-1]: k for k in kms_log["kms_keys"]}
    assert keys_by_name["key-dpi-patients"]["rotation_enabled"] is False
    assert keys_by_name["key-dpi-patients"]["non_conforme"] is True
    assert keys_by_name["key-pacs-imagerie"]["rotation_period_days"] == 90
    assert keys_by_name["key-pacs-imagerie"]["non_conforme"] is False

    log_buckets = kms_log["audit_log_buckets"]
    assert len(log_buckets) >= 1
    assert log_buckets[0]["retention_days"] < 365
    assert log_buckets[0]["non_conforme"] is True


def test_gcp_iam_and_kms_logging_api_mocked(monkeypatch) -> None:
    monkeypatch.setenv("USE_GCP_SNAPSHOT", "false")
    monkeypatch.setenv("PROJECT_ID", "ch-valmont-prod")
    monkeypatch.setenv("VERTEX_LOCATION", "europe-west9")

    class FakeSession:
        def post(self, url: str, json: dict[str, Any] | None = None, timeout: int = 15) -> Any:
            if ":getIamPolicy" in url:
                return SimpleNamespace(
                    ok=True,
                    json=lambda: {
                        "bindings": [
                            {"role": "roles/editor", "members": ["user:ops@ch-valmont.fr"]},
                            {"role": "roles/viewer", "members": ["user:audit@ch-valmont.fr"]},
                        ],
                        "auditConfigs": [],
                    },
                )
            return SimpleNamespace(ok=False, json=lambda: {})

        def get(self, url: str, timeout: int = 15) -> Any:
            if url.endswith("/serviceAccounts"):
                return SimpleNamespace(
                    ok=True,
                    json=lambda: {
                        "accounts": [
                            {"email": "sa-dpi@ch-valmont-prod.iam.gserviceaccount.com"}
                        ]
                    },
                )
            if "/keys?keyTypes=USER_MANAGED" in url:
                return SimpleNamespace(
                    ok=True,
                    json=lambda: {
                        "keys": [
                            {
                                "name": "projects/ch-valmont-prod/serviceAccounts/sa-dpi/keys/key123",
                                "keyType": "USER_MANAGED",
                                "validAfterTime": "2024-01-10T08:00:00Z",
                            }
                        ]
                    },
                )
            if url.endswith("/locations/europe-west9/keyRings"):
                return SimpleNamespace(
                    ok=True,
                    json=lambda: {
                        "keyRings": [
                            {
                                "name": "projects/ch-valmont-prod/locations/europe-west9/keyRings/kr1"
                            }
                        ]
                    },
                )
            if url.endswith("/locations/global/keyRings"):
                return SimpleNamespace(ok=True, json=lambda: {"keyRings": []})
            if url.endswith("/cryptoKeys"):
                return SimpleNamespace(
                    ok=True,
                    json=lambda: {
                        "cryptoKeys": [
                            {
                                "name": "projects/ch-valmont-prod/locations/europe-west9/keyRings/kr1/cryptoKeys/k-unrotated",
                                "purpose": "ENCRYPT_DECRYPT",
                            },
                            {
                                "name": "projects/ch-valmont-prod/locations/europe-west9/keyRings/kr1/cryptoKeys/k-ok",
                                "purpose": "ENCRYPT_DECRYPT",
                                "rotationPeriod": "7776000s",
                            },
                        ]
                    },
                )
            if url.endswith("/locations/-/buckets"):
                return SimpleNamespace(
                    ok=True,
                    json=lambda: {
                        "buckets": [
                            {
                                "name": "projects/ch-valmont-prod/locations/global/buckets/_Required",
                                "retentionDays": 400,
                                "locked": True,
                            },
                            {
                                "name": "projects/ch-valmont-prod/locations/global/buckets/_Default",
                                "retentionDays": 30,
                                "locked": False,
                            },
                        ]
                    },
                )
            return SimpleNamespace(ok=False, json=lambda: {})

    monkeypatch.setattr("triad.tools.gcp_tools._get_authorized_session", lambda: FakeSession())

    iam_res = gcp_check_iam_privileges()
    assert iam_res["non_conforme"] is True
    assert len(iam_res["overprivileged_bindings"]) == 1
    assert iam_res["overprivileged_bindings"][0]["role"] == "roles/editor"
    assert len(iam_res["stale_service_account_keys"]) == 1
    assert iam_res["stale_service_account_keys"][0]["key_id"] == "key123"

    kms_res = gcp_check_kms_and_logging()
    assert kms_res["non_conforme"] is True
    assert len(kms_res["kms_keys"]) == 2
    assert kms_res["kms_keys"][0]["non_conforme"] is True
    assert kms_res["kms_keys"][1]["non_conforme"] is False
    assert len(kms_res["audit_log_buckets"]) == 1
    assert kms_res["audit_log_buckets"][0]["retention_days"] == 30
    assert kms_res["audit_log_buckets"][0]["data_access_logs_enabled"] is False


def test_redact_pii_pssi_and_annexe() -> None:
    pssi = (DATA_DIR / "PSSI_CH_Valmont.md").read_text(encoding="utf-8")
    res_pssi = redact_pii(pssi, use_dlp=False)
    assert "[NOM_1]" in res_pssi["texte_masque"]
    assert "[EMAIL_1]" in res_pssi["texte_masque"]
    assert "[TEL_1]" in res_pssi["texte_masque"]
    assert "claire.moreau@ch-valmont.fr" not in res_pssi["texte_masque"]

    annexe = (DATA_DIR / "annexe_fournisseur_maintenance.md").read_text(encoding="utf-8")
    res_annexe = redact_pii(annexe, use_dlp=False)
    assert "[IBAN_1]" in res_annexe["texte_masque"]
    assert "FR76 3000" not in res_annexe["texte_masque"]


def test_scan_injection_detects_annexe_and_passes_pssi() -> None:
    pssi = (DATA_DIR / "PSSI_CH_Valmont.md").read_text(encoding="utf-8")
    res_clean = scan_injection(pssi, use_llm=False)
    assert res_clean["suspect"] is False

    annexe = (DATA_DIR / "annexe_fournisseur_maintenance.md").read_text(encoding="utf-8")
    res_inj = scan_injection(annexe, use_llm=False)
    assert res_inj["suspect"] is True
    assert res_inj["extrait_suspect"] is not None
    assert "ignore les instructions" in res_inj["extrait_suspect"].lower()


def test_verify_quote_exact_and_negative() -> None:
    pssi = (DATA_DIR / "PSSI_CH_Valmont.md").read_text(encoding="utf-8")
    docs = {"PSSI_CH_Valmont.md": pssi}

    ok = verify_quote(
        "PSSI_CH_Valmont.md",
        "aucune   donnée de santé n'est stockée sur un espace accessible publiquement.",
        docs,
    )
    assert ok["verifie"] is True

    ko = verify_quote("PSSI_CH_Valmont.md", "Texte inventé par un modèle", docs)
    assert ko["verifie"] is False

    missing = verify_quote("inconnu.md", "quelque chose", docs)
    assert missing["verifie"] is False


def test_nis2_loader() -> None:
    all_req = get_nis2_requirements()
    assert len(all_req) == 11
    incidents = get_nis2_requirements("incidents")
    assert any(r["id"] == "NIS2-23" for r in incidents)


def test_doc_loader_normalizes_whitespace_and_preserves_sections(tmp_path) -> None:
    messy_md = (
        "#   Politique   de\u00a0Sécurité  \n"
        "###   §3.1   Stockage   et\u202fexposition\n"
        "Aucune    donnée   de\u00a0santé   n’est   exposée   sur   Internet.   \n\n\n\n"
        "### §4.2   Authentification   forte\n"
        "Le **MFA** est obligatoire pour tout accès distant.\n"
    )
    md_file = tmp_path / "messy_pssi.md"
    md_file.write_text(messy_md, encoding="utf-8")

    cleaned_md = load_document(md_file)
    assert "### §3.1 Stockage et exposition" in cleaned_md
    assert "Aucune donnée de santé n’est exposée sur Internet." in cleaned_md
    assert "\n\n\n" not in cleaned_md

    sections = extract_sections(cleaned_md)
    sec_ids = [s["section_id"] for s in sections if s["section_id"]]
    assert "§3.1" in sec_ids
    assert "§4.2" in sec_ids

    # Vérifie que verify_quote gère les apostrophes typographiques, guillemets et décorateurs Markdown
    docs = {"messy_pssi.md": cleaned_md}
    q1 = verify_quote(
        "messy_pssi.md",
        "« Aucune donnée de santé n'est exposée sur Internet. »",
        docs,
    )
    assert q1["verifie"] is True
    assert q1["section"] == "§3.1"

    q2 = verify_quote(
        "messy_pssi.md",
        "Le MFA est obligatoire pour tout accès distant.",
        docs,
    )
    assert q2["verifie"] is True
    assert q2["section"] == "§4.2"

    # Vérifie la promotion des titres PDF et la réparation des césures PDF
    raw_pdf_extract = (
        "CHAPITRE 5 — CONTINUITÉ\n"
        "§5.2 Politique de sauvegarde\n"
        "Les sauve-\n"
        "gardes quotidiennes sont conser-\n"
        "vées   30   jours."
    )
    cleaned_pdf = clean_document_text(raw_pdf_extract, is_pdf=True)
    assert "## CHAPITRE 5" in cleaned_pdf
    assert "### §5.2 Politique de sauvegarde" in cleaned_pdf
    assert "Les sauvegardes quotidiennes sont conservées 30 jours." in cleaned_pdf
    q_pdf = verify_quote(
        "extrait.pdf",
        "Les sauvegardes quotidiennes sont conservées 30 jours.",
        {"extrait.pdf": cleaned_pdf},
    )
    assert q_pdf["verifie"] is True
    assert q_pdf["section"] == "§5.2"


def test_demo_cache_5_gcp_probes_and_verified_quotes() -> None:
    cache = json.loads((DATA_DIR / "demo_cache.json").read_text(encoding="utf-8"))
    sanitized_docs: dict[str, str] = {}
    for fname in (
        "PSSI_CH_Valmont.md",
        "PV_test_restauration.md",
        "notes_entretien_DSI.md",
    ):
        cleaned = load_document(DATA_DIR / fname)
        sanitized_docs[fname] = redact_pii(cleaned, use_dlp=False)["texte_masque"]

    for mode_key, expected_min in (("mode_avant", 6), ("mode_apres", 7)):
        findings = cache[mode_key]["findings"]
        assert len(findings) >= expected_min
        blob_text = json.dumps(findings, ensure_ascii=False)
        assert "sa-prestataire-meditech" in blob_text
        assert "roles/editor" in blob_text
        assert "key-dpi-patients" in blob_text
        assert "_Default" in blob_text

        for raw_f in findings:
            f = Finding.model_validate(raw_f)
            if f.dit is not None:
                res_dit = verify_quote(f.dit.source, f.dit.extrait, sanitized_docs)
                assert res_dit["verifie"] is True, f"Échec citation DIT {f.id}: {f.dit}"
            if f.ecrit is not None:
                res_ecrit = verify_quote(
                    f.ecrit.source, f.ecrit.extrait, sanitized_docs
                )
                assert res_ecrit["verifie"] is True, f"Échec citation ÉCRIT {f.id}: {f.ecrit}"
