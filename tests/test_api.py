"""Tests d'intégration de l'API FastAPI TRIAD (isolation multi-sessions, chaîne SHA-256, validation)."""

from __future__ import annotations

import csv
import hashlib
import hmac
import io
import json
import re
import subprocess
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from triad.api.app import SESSION_STORE, app
from triad.api.session_store import SessionStore

client = TestClient(app)


def test_index_and_health() -> None:
    r = client.get("/")
    assert r.status_code == 200
    assert "TRIAD" in r.text
    assert "/assets/" in r.text

    for asset_path in re.findall(r'/(assets/[^"\']+)', r.text):
        ar = client.get(f"/{asset_path}")
        assert ar.status_code == 200

    h = client.get("/api/health")
    assert h.status_code == 200
    assert h.json()["status"] == "ok"
    assert h.headers.get("x-content-type-options") == "nosniff"
    assert h.headers.get("x-frame-options") == "DENY"
    assert h.headers.get("referrer-policy") == "strict-origin-when-cross-origin"
    assert "camera=()" in (h.headers.get("permissions-policy") or "")


def test_demo_flow_validation_gate_and_security_simulation() -> None:
    load = client.post("/api/demo/load")
    assert load.status_code == 200
    assert len(load.json()["loaded"]) == 4

    run_apres = client.post("/api/audit/run", json={"mode": "APRES", "use_cache": True})
    assert run_apres.status_code == 200
    data = run_apres.json()
    run_id_apres = data["run_id"]
    assert run_id_apres.startswith("run-")
    assert data["chain"]["valide"] is True
    nb_after_apres = data["chain"]["nb_entrees"]
    assert nb_after_apres >= 5
    assert len(data["synthesis"]["findings"]) >= 4
    assert len(data["synthesis"]["documents_quarantaine"]) == 1

    # Export bloqué avant validation humaine
    assert client.get("/api/export/report").status_code == 403
    assert client.get("/api/export/mail").status_code == 403
    assert client.get("/api/export/json").status_code == 403
    assert client.get("/api/export/playbook").status_code == 403
    assert client.get("/api/export/csv").status_code == 403
    assert client.get("/api/export/bundle").status_code == 403

    # Validation humaine
    val = client.post("/api/validate")
    assert val.status_code == 200
    assert val.json()["statut_validation"] == "VALIDÉ"

    # Export débloqué après validation (Markdown, Mail, JSON structuré + SHA-256)
    rep = client.get("/api/export/report")
    assert rep.status_code == 200
    assert "Centre Hospitalier de Valmont" in rep.text

    mail = client.get("/api/export/mail")
    assert mail.status_code == 200
    assert "Garnier" in mail.text

    exp_json = client.get("/api/export/json")
    assert exp_json.status_code == 200
    exp_data = exp_json.json()
    assert exp_data["validated"] is True
    assert exp_data["mode"] == "APRES"
    assert exp_data["synthesis"]["statut_validation"] == "VALIDÉ"
    assert exp_data["integrity"]["algorithm"] == "SHA-256"
    assert exp_data["integrity"]["chain"]["valide"] is True
    assert len(exp_data["integrity"]["head_hash"]) == 64
    assert run_id_apres in exp_data["integrity"]["runs"]

    playbook = client.get("/api/export/playbook")
    assert playbook.status_code == 200
    pb_text = playbook.text
    assert pb_text.startswith("#!/usr/bin/env bash")
    assert "set -euo pipefail" in pb_text
    assert 'EXECUTE="${EXECUTE:-false}"' in pb_text
    assert exp_data["integrity"]["head_hash"] in pb_text
    assert "gcloud storage buckets remove-iam-policy-binding" in pb_text
    assert "(NON EXÉCUTÉE)" not in pb_text
    syntax_chk = subprocess.run(["bash", "-n"], input=pb_text, text=True, capture_output=True)
    assert syntax_chk.returncode == 0, syntax_chk.stderr
    dry_run_exec = subprocess.run(["bash"], input=pb_text, text=True, capture_output=True)
    assert dry_run_exec.returncode == 0
    assert "[DRY-RUN]" in dry_run_exec.stdout

    # Simulation d'une action non autorisée (bouton démo)
    sim = client.post("/api/security/simulate-violation")
    assert sim.status_code == 200
    sim_data = sim.json()
    assert sim_data["blocked"] is True
    assert "VIOLATION" in sim_data["alert"]
    assert sim_data["chain"]["valide"] is True

    # Mode AVANT conservé séparément ET journal SHA-256 append-only continu (sans reset)
    run_avant = client.post("/api/audit/run", json={"mode": "AVANT", "use_cache": True})
    assert run_avant.status_code == 200
    run_id_avant = run_avant.json()["run_id"]
    assert run_id_avant != run_id_apres

    st_avant = client.get("/api/status?mode=AVANT").json()
    st_apres = client.get("/api/status?mode=APRES").json()
    assert len(st_avant["synthesis"]["questions_entretien"]) >= 3
    assert st_apres["synthesis"]["mail_suivi"] != ""
    assert st_avant["chain"]["valide"] is True
    assert st_avant["chain"]["nb_entrees"] > nb_after_apres

    logged_run_ids = {e.get("run_id") for e in st_avant["audit_log"]}
    logged_modes = {e.get("mode") for e in st_avant["audit_log"]}
    assert run_id_apres in logged_run_ids
    assert run_id_avant in logged_run_ids
    assert {"AVANT", "APRES"}.issubset(logged_modes)

    # Réinitialisation complète de l'affichage et du journal
    rst = client.post("/api/reset")
    assert rst.status_code == 200
    assert rst.json()["reset"] is True
    st = client.get("/api/status").json()
    assert st["synthesis"] is None
    assert st["files"] == []
    assert st["audit_log"] == []


def test_multi_session_isolation_header_and_query_param() -> None:
    headers_a = {"X-Session-Id": "session-alpha"}
    try:
        # Session Alpha (via header X-Session-Id) charge, lance APRES et valide
        r_load_a = client.post("/api/demo/load", headers=headers_a)
        assert r_load_a.status_code == 200
        assert r_load_a.json()["session_id"] == "session-alpha"

        r_run_a = client.post(
            "/api/audit/run",
            headers=headers_a,
            json={"mode": "APRES", "use_cache": True},
        )
        assert r_run_a.status_code == 200
        assert client.post("/api/validate", headers=headers_a).status_code == 200
        assert client.get("/api/export/report", headers=headers_a).status_code == 200

        # Session Beta (via query param ?session_id=session-beta) est totalement isolée
        st_b = client.get("/api/status?session_id=session-beta").json()
        assert st_b["session_id"] == "session-beta"
        assert st_b["synthesis"] is None
        assert st_b["validated"] is False
        assert st_b["files"] == []
        assert st_b["audit_log"] == []
        assert client.get("/api/export/report?session_id=session-beta").status_code == 403

        # Session par défaut ('default') n'est pas polluée par Alpha non plus
        st_def = client.get("/api/status").json()
        assert st_def["session_id"] == "default"
        assert st_def["synthesis"] is None

        # Une violation déclenchée dans Beta n'affecte ni Alpha ni son journal SHA-256
        sim_b = client.post("/api/security/simulate-violation?session_id=session-beta")
        assert sim_b.status_code == 200
        assert sim_b.json()["blocked"] is True

        st_a = client.get("/api/status", headers=headers_a).json()
        assert st_a["security_alert"] is None
        assert st_a["validated"] is True
        assert all(e["action"] != "VIOLATION" for e in st_a["audit_log"])

        st_b_after = client.get("/api/status?session_id=session-beta").json()
        assert st_b_after["security_alert"] is not None
        assert any(e["action"] == "VIOLATION" for e in st_b_after["audit_log"])

        # Reset de Beta ne vide pas Alpha
        client.post("/api/reset?session_id=session-beta")
        assert client.get("/api/status", headers=headers_a).json()["synthesis"] is not None
    finally:
        client.post("/api/reset", headers=headers_a)
        client.post("/api/reset?session_id=session-beta")


def test_session_disk_persistence_survives_restart() -> None:
    sid = "persist-restart"
    headers = {"X-Session-Id": sid}
    disk_file = SESSION_STORE.session_file(sid)
    try:
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "AVANT", "use_cache": True},
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        assert client.post("/api/validate?mode=APRES", headers=headers).status_code == 200
        assert disk_file.exists()

        # Simule un redémarrage complet du processus FastAPI (cache RAM vidé)
        SESSION_STORE.clear_memory_cache()

        st = client.get("/api/status", headers=headers).json()
        assert st["modes_ready"] == {"AVANT": True, "APRES": True}
        assert st["modes_validated"] == {"AVANT": False, "APRES": True}
        assert st["validated"] is True
        assert st["syntheses_by_mode"]["AVANT"] is not None
        assert st["syntheses_by_mode"]["APRES"] is not None

        # L'export JSON survit au redémarrage pour APRES (validé) mais reste 403 pour AVANT
        assert client.get("/api/export/json?mode=AVANT", headers=headers).status_code == 403
        res_json = client.get("/api/export/json?mode=APRES", headers=headers)
        assert res_json.status_code == 200
        assert res_json.json()["integrity"]["chain"]["valide"] is True
        assert len(res_json.json()["integrity"]["runs"]) == 2
    finally:
        client.post("/api/reset", headers=headers)
        assert not disk_file.exists()


def test_session_store_unit_save_reload_and_reset(tmp_path: Path) -> None:
    store1 = SessionStore(tmp_path / "sessions")
    state = store1.get("cabinet-paris")
    state["mode"] = "AVANT"
    state["results_by_mode"]["AVANT"]["validated"] = True
    state["results_by_mode"]["AVANT"]["synthesis"] = {"client": "CH Valmont", "findings": []}
    saved_path = store1.save("cabinet-paris")
    assert saved_path.exists()

    # Nouvelle instance (redémarrage) relit depuis tmp_path / "sessions"
    store2 = SessionStore(tmp_path / "sessions")
    reloaded = store2.get("cabinet-paris")
    assert reloaded["mode"] == "AVANT"
    assert reloaded["results_by_mode"]["AVANT"]["validated"] is True
    assert reloaded["results_by_mode"]["AVANT"]["synthesis"]["client"] == "CH Valmont"

    store2.reset("cabinet-paris")
    assert not saved_path.exists()
    assert store2.get("cabinet-paris")["results_by_mode"]["AVANT"]["synthesis"] is None


def test_validate_triggers_optional_worm_archive(monkeypatch) -> None:
    headers = {"X-Session-Id": "worm-api-session"}
    monkeypatch.setenv("AUDIT_LOGS_BUCKET", "ch-valmont-immutable-audit")
    monkeypatch.setenv("USE_GCP_SNAPSHOT", "false")
    monkeypatch.setenv("PROJECT_ID", "ch-valmont-prod")

    class FakeBlob:
        def __init__(self, name: str) -> None:
            self.name = name

        def upload_from_string(
            self,
            data: str,
            content_type: str = "application/json",
            if_generation_match: int | None = None,
        ) -> None:
            assert if_generation_match == 0

    class FakeBucket:
        def blob(self, name: str) -> FakeBlob:
            return FakeBlob(name)

    class FakeStorageClient:
        def __init__(self, project: str | None = None) -> None:
            self.project = project

        def bucket(self, name: str) -> FakeBucket:
            return FakeBucket()

    monkeypatch.setattr("google.cloud.storage.Client", FakeStorageClient)

    try:
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        run_r = client.post(
            "/api/audit/run",
            headers=headers,
            json={"mode": "APRES", "use_cache": True},
        )
        assert run_r.status_code == 200
        assert len(run_r.json()["synthesis"]["findings"]) == 7

        val_r = client.post("/api/validate", headers=headers)
        assert val_r.status_code == 200
        val_json = val_r.json()
        assert val_json["worm_archive"]["archived"] is True
        assert val_json["worm_archive"]["object_uri"].startswith(
            "gs://ch-valmont-immutable-audit/audits/worm-api-session/APRES_"
        )
        assert val_json["chain"]["valide"] is True

        st = client.get("/api/status", headers=headers).json()
        assert any(e["action"] == "WORM_ARCHIVED" for e in st["audit_log"])
    finally:
        client.post("/api/reset", headers=headers)


def test_export_playbook_neutralizes_unsafe_commands() -> None:
    headers = {"X-Session-Id": "playbook-sec-session"}
    try:
        assert client.get("/api/export/playbook", headers=headers).status_code == 403
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        # Toujours 403 avant validation humaine
        assert client.get("/api/export/playbook", headers=headers).status_code == 403

        # Injecte une commande suspecte pour vérifier la neutralisation par liste blanche gcloud
        state = SESSION_STORE.get("playbook-sec-session")
        state["results_by_mode"]["APRES"]["synthesis"]["findings"][0][
            "commande_correction"
        ] = "gcloud storage ls; rm -rf /tmp/x (NON EXÉCUTÉE)"
        SESSION_STORE.save("playbook-sec-session")

        assert client.post("/api/validate", headers=headers).status_code == 200
        res = client.get("/api/export/playbook", headers=headers)
        assert res.status_code == 200
        assert "# [REVUE MANUELLE REQUISE]" in res.text
        assert "\n    gcloud storage ls; rm -rf" not in res.text
    finally:
        client.post("/api/reset", headers=headers)


def test_export_csv_bom_and_formula_injection_protection() -> None:
    headers = {"X-Session-Id": "csv-grc-session"}
    try:
        assert client.get("/api/export/csv", headers=headers).status_code == 403
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        assert client.get("/api/export/csv", headers=headers).status_code == 403

        # Injecte des charges d'injection de formules CSV/Excel (=, +, -, @, tab)
        state = SESSION_STORE.get("csv-grc-session")
        findings = state["results_by_mode"]["APRES"]["synthesis"]["findings"]
        findings[0]["recommandation"] = "=CMD|' /C calc'!A0"
        findings[1]["recommandation"] = "+SUM(A1:A10)"
        findings[2]["recommandation"] = "-2+3+cmd"
        findings[3]["recommandation"] = "@IMPORTXML(A1,A2)"
        findings[4]["recommandation"] = "\t=HYPERLINK(\"http://evil\")"
        SESSION_STORE.save("csv-grc-session")

        assert client.post("/api/validate", headers=headers).status_code == 200
        csv_res = client.get("/api/export/csv", headers=headers)
        assert csv_res.status_code == 200
        # Vérifie le BOM UTF-8 (utf-8-sig) pour ouverture directe dans Excel FR
        assert csv_res.content.startswith(b"\xef\xbb\xbf")
        assert "text/csv" in (csv_res.headers.get("content-type") or "")

        decoded = csv_res.content.decode("utf-8-sig")
        rows = list(csv.DictReader(io.StringIO(decoded)))
        assert len(rows) == len(findings)
        assert rows[0]["ID"] == "F-001"
        assert rows[0]["Statut"] == "non_conforme"
        assert rows[0]["Gravité"] == "critique"
        assert rows[0]["Dit (Extrait)"] != ""
        assert rows[0]["Écrit (Extrait)"] != ""
        assert rows[0]["Réel (Constat)"] != ""
        assert len(rows[0]["Empreinte SHA-256"]) == 64

        # Toutes les formules dangereuses sont préfixées par une apostrophe '
        assert rows[0]["Recommandation"].startswith("'=CMD")
        assert rows[1]["Recommandation"].startswith("'+SUM")
        assert rows[2]["Recommandation"].startswith("'-2+3")
        assert rows[3]["Recommandation"].startswith("'@IMPORTXML")
        assert rows[4]["Recommandation"].startswith("'=HYPERLINK")
    finally:
        client.post("/api/reset", headers=headers)


def test_session_store_corrupted_and_partial_json_recovery(tmp_path: Path) -> None:
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)

    # 1. JSON tronqué
    (sessions_dir / "truncated.json").write_text('{"mode": "APRES", "files": [', encoding="utf-8")
    # 2. Octets binaires non-UTF-8
    (sessions_dir / "binary.json").write_bytes(b"\xff\xfe\x00\x81corrupt")
    # 3. Racine JSON de type tableau au lieu d'objet
    (sessions_dir / "array_root.json").write_text("[1, 2, 3]", encoding="utf-8")
    # 4. JSON partiel / incohérent (validated=true mais synthesis corrompue)
    (sessions_dir / "partial.json").write_text(
        '{"mode": "INCONNU", "files": ["ok.md", null, 42], '
        '"results_by_mode": {"APRES": {"validated": true, "synthesis": "invalide", '
        '"agent_statuses": {"Douanier": "inconnu", "GardeDuCorps": "terminé"}}}}',
        encoding="utf-8",
    )

    store = SessionStore(sessions_dir)
    for broken_sid in ("truncated", "binary", "array_root"):
        recovered = store.get(broken_sid)
        assert recovered["session_id"] == broken_sid
        assert recovered["mode"] == "APRES"
        assert recovered["files"] == []
        assert recovered["results_by_mode"]["APRES"]["synthesis"] is None
        assert recovered["results_by_mode"]["APRES"]["validated"] is False

    partial = store.get("partial")
    assert partial["mode"] == "APRES"
    assert partial["files"] == ["ok.md"]
    assert partial["results_by_mode"]["APRES"]["synthesis"] is None
    assert partial["results_by_mode"]["APRES"]["validated"] is False
    assert partial["results_by_mode"]["APRES"]["agent_statuses"]["Douanier"] == "en_attente"
    assert partial["results_by_mode"]["APRES"]["agent_statuses"]["GardeDuCorps"] == "terminé"

    # Vérifie aussi de bout en bout via l'API FastAPI sur un fichier disque corrompu
    api_sid = "corrupt-api-check"
    api_disk = SESSION_STORE.session_file(api_sid)
    try:
        api_disk.parent.mkdir(parents=True, exist_ok=True)
        api_disk.write_text("{json cassé!!!", encoding="utf-8")
        SESSION_STORE.clear_memory_cache()
        r = client.get("/api/status", headers={"X-Session-Id": api_sid})
        assert r.status_code == 200
        assert r.json()["synthesis"] is None
        assert r.json()["validated"] is False
    finally:
        client.post("/api/reset", headers={"X-Session-Id": api_sid})


def test_head_probes_index_and_health() -> None:
    head_index = client.head("/")
    assert head_index.status_code == 200
    assert "text/html" in (head_index.headers.get("content-type") or "")
    assert head_index.content == b""
    assert head_index.headers.get("x-content-type-options") == "nosniff"
    assert head_index.headers.get("x-frame-options") == "DENY"

    head_health = client.head("/api/health")
    assert head_health.status_code == 200
    assert "application/json" in (head_health.headers.get("content-type") or "")
    assert head_health.content == b""
    assert head_health.headers.get("x-content-type-options") == "nosniff"
    assert head_health.headers.get("x-frame-options") == "DENY"


def test_audit_diff_avant_apres_comparison() -> None:
    headers = {"X-Session-Id": "diff-avant-apres-session"}
    try:
        # 1. Avant tout run : les deux modes sont signalés manquants
        d0 = client.get("/api/audit/diff", headers=headers)
        assert d0.status_code == 200
        j0 = d0.json()
        assert j0["session_id"] == "diff-avant-apres-session"
        assert j0["ready"] is False
        assert j0["modes_ready"] == {"AVANT": False, "APRES": False}
        assert j0["missing_modes"] == ["AVANT", "APRES"]
        assert j0["score_nis2"] == {"avant": None, "apres": None, "delta": None}
        assert j0["nouveaux_constats"] == []
        assert j0["ruptures_dit"] == []

        assert client.post("/api/demo/load", headers=headers).status_code == 200

        # 2. Après exécution AVANT uniquement : score AVANT disponible, APRES manquant
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "AVANT", "use_cache": True},
            ).status_code
            == 200
        )
        d1 = client.get("/api/audit/diff", headers=headers)
        assert d1.status_code == 200
        j1 = d1.json()
        assert j1["ready"] is False
        assert j1["modes_ready"] == {"AVANT": True, "APRES": False}
        assert j1["missing_modes"] == ["APRES"]
        assert j1["score_nis2"]["avant"] == 26
        assert j1["score_nis2"]["apres"] is None
        assert j1["score_nis2"]["delta"] is None

        # 3. Après exécution APRES : comparatif complet calculé côté serveur
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        d2 = client.get("/api/audit/diff", headers=headers)
        assert d2.status_code == 200
        j2 = d2.json()
        assert j2["ready"] is True
        assert j2["modes_ready"] == {"AVANT": True, "APRES": True}
        assert j2["missing_modes"] == []
        assert j2["score_nis2"] == {"avant": 26, "apres": 22, "delta": -4}
        assert j2["counts"]["findings_avant"] == 6
        assert j2["counts"]["findings_apres"] == 7
        assert j2["counts"]["nouveaux_constats"] == 1
        assert j2["counts"]["ruptures_dit"] == 4
        assert j2["counts"]["ecarts_confirmes"] == 5
        assert j2["counts"]["conformes_ou_leves"] == 1
        assert j2["chain"]["valide"] is True

        # Nouveau constat découvert post-entretien : F-004 (incident non notifié ANSSI)
        new_ids = [c["id"] for c in j2["nouveaux_constats"]]
        assert new_ids == ["F-004"]
        assert j2["nouveaux_constats"][0]["contradiction"] == "Dit ≠ Écrit"

        # Ruptures du Dit dévoilées post-entretien : F-001, F-002, F-003 (Dit ≠ Réel) + F-004 (Dit ≠ Écrit)
        dit_ids = [c["id"] for c in j2["ruptures_dit"]]
        assert dit_ids == ["F-001", "F-002", "F-003", "F-004"]
        assert j2["ruptures_dit"][0]["contradiction_avant"] == "Écrit ≠ Réel"
        assert j2["ruptures_dit"][0]["contradiction_apres"] == "Dit ≠ Réel"

        # Isolation multi-session préservée sur /api/audit/diff
        other = client.get("/api/audit/diff?session_id=diff-untouched-session")
        assert other.status_code == 200
        assert other.json()["ready"] is False
    finally:
        client.post("/api/reset", headers=headers)
        client.post("/api/reset?session_id=diff-untouched-session")


def test_session_store_list_and_delete_without_sensitive_leak(tmp_path: Path) -> None:
    store = SessionStore(tmp_path / "sessions")
    s1 = store.get("mission-chu-nord")
    s1["files"] = ["/confidentiel/interne/PSSI_Secrete.md"]
    s1["security_alert"] = "ALERTE INTERNE"
    s1["results_by_mode"]["AVANT"]["synthesis"] = {
        "client": "CHU Nord",
        "findings": [],
        "documents_nettoyes": [{"nom_fichier": "PSSI.md", "contenu_masque": "TEXTE_SENSIBLE_XYZ"}],
    }
    store.save("mission-chu-nord")

    s2 = store.get("mission-clinique-sud")
    s2["results_by_mode"]["APRES"]["validated"] = True
    s2["results_by_mode"]["APRES"]["synthesis"] = {"client": "Clinique du Sud", "findings": []}
    store.save("mission-clinique-sud")

    listed = store.list_sessions()
    assert len(listed) == 2
    by_id = {item["session_id"]: item for item in listed}
    assert set(by_id.keys()) == {"mission-chu-nord", "mission-clinique-sud"}
    assert by_id["mission-chu-nord"]["client"] == "CHU Nord"
    assert by_id["mission-chu-nord"]["modes_ready"] == {"AVANT": True, "APRES": False}
    assert by_id["mission-chu-nord"]["modes_validated"] == {"AVANT": False, "APRES": False}
    assert by_id["mission-clinique-sud"]["client"] == "Clinique du Sud"
    assert by_id["mission-clinique-sud"]["modes_ready"] == {"AVANT": False, "APRES": True}
    assert by_id["mission-clinique-sud"]["modes_validated"] == {"AVANT": False, "APRES": True}
    assert by_id["mission-clinique-sud"]["updated_at"] != ""

    # Aucune donnée brute sensible ne doit fuiter dans list_sessions()
    serialized = json.dumps(listed, ensure_ascii=False)
    assert "/confidentiel/interne" not in serialized
    assert "TEXTE_SENSIBLE_XYZ" not in serialized
    assert "ALERTE INTERNE" not in serialized

    assert store.delete_session("mission-chu-nord") is True
    assert not store.session_file("mission-chu-nord").exists()
    assert store.delete_session("mission-chu-nord") is False
    remaining = store.list_sessions()
    assert [item["session_id"] for item in remaining] == ["mission-clinique-sud"]


def test_sessions_endpoints_and_agent_timings_telemetry() -> None:
    h1 = {"X-Session-Id": "sess-mgr-alpha"}
    h2 = {"X-Session-Id": "sess-mgr-beta"}
    expected_agents = {"Douanier", "AnalysteConformite", "ContreAuditeur", "GardeDuCorps"}
    try:
        st_init = client.get("/api/status", headers=h1).json()
        assert st_init["timings_ms"] == {}

        assert client.post("/api/demo/load", headers=h1).status_code == 200
        run_av = client.post(
            "/api/audit/run",
            headers=h1,
            json={"mode": "AVANT", "use_cache": True},
        )
        assert run_av.status_code == 200
        av_timings = run_av.json()["timings_ms"]
        assert set(av_timings.keys()) == expected_agents
        assert all(isinstance(v, int) and v >= 1 for v in av_timings.values())

        run_ap = client.post(
            "/api/audit/run",
            headers=h1,
            json={"mode": "APRES", "use_cache": True},
        )
        assert run_ap.status_code == 200
        ap_timings = run_ap.json()["timings_ms"]
        assert set(ap_timings.keys()) == expected_agents
        assert all(isinstance(v, int) and v >= 1 for v in ap_timings.values())
        assert client.post("/api/validate?mode=APRES", headers=h1).status_code == 200

        assert client.post("/api/demo/load", headers=h2).status_code == 200

        # Persistance disque de timings_ms après vidage du cache RAM
        SESSION_STORE.clear_memory_cache()
        st_after = client.get("/api/status?mode=APRES", headers=h1).json()
        assert set(st_after["timings_ms"].keys()) == expected_agents
        assert set(st_after["timings_by_mode"]["AVANT"].keys()) == expected_agents
        assert set(st_after["timings_by_mode"]["APRES"].keys()) == expected_agents

        # Listing multi-sessions via GET /api/sessions
        ls_res = client.get("/api/sessions", headers=h1)
        assert ls_res.status_code == 200
        ls_json = ls_res.json()
        assert ls_json["active_session_id"] == "sess-mgr-alpha"
        sessions_by_id = {s["session_id"]: s for s in ls_json["sessions"]}
        assert "sess-mgr-alpha" in sessions_by_id
        assert "sess-mgr-beta" in sessions_by_id

        alpha_meta = sessions_by_id["sess-mgr-alpha"]
        assert alpha_meta["client"] == "Centre Hospitalier de Valmont"
        assert alpha_meta["modes_ready"] == {"AVANT": True, "APRES": True}
        assert alpha_meta["modes_validated"] == {"AVANT": False, "APRES": True}
        assert isinstance(alpha_meta["updated_at"], str) and len(alpha_meta["updated_at"]) >= 19
        assert "synthesis" not in alpha_meta
        assert "files" not in alpha_meta

        # Suppression propre via DELETE /api/sessions/{session_id}
        del_res = client.delete("/api/sessions/sess-mgr-alpha")
        assert del_res.status_code == 200
        assert del_res.json() == {"deleted": True, "session_id": "sess-mgr-alpha"}
        assert not SESSION_STORE.session_file("sess-mgr-alpha").exists()

        # Idempotence au second appel
        del_again = client.delete("/api/sessions/sess-mgr-alpha")
        assert del_again.status_code == 200
        assert del_again.json() == {"deleted": False, "session_id": "sess-mgr-alpha"}

        ls_after = client.get("/api/sessions").json()
        remaining_ids = {s["session_id"] for s in ls_after["sessions"]}
        assert "sess-mgr-alpha" not in remaining_ids
        assert "sess-mgr-beta" in remaining_ids
    finally:
        client.delete("/api/sessions/sess-mgr-alpha")
        client.delete("/api/sessions/sess-mgr-beta")


def test_export_bundle_zip_integrity_and_sha256_manifest(tmp_path: Path) -> None:
    headers = {"X-Session-Id": "bundle-proof-session"}
    expected_entries = [
        "01_Rapport_NIS2.md",
        "02_Matrice_GRC.csv",
        "03_Synthese_Scellee.json",
        "04_Playbook_DryRun.sh",
        "05_Mail_DSI.txt",
        "06_Audit_Chain.jsonl",
        "07_PreNotification_ANSSI_Art23.md",
        "08_Brief_COMEX_Art20.md",
        "09_Remediation_GitOps.tf",
        "10_Guide_Entretien_Contradictoire.md",
        "11_Registre_Arbitrages_GRC.md",
        "12_Evaluation_CNIL_RGPD_Art33.md",
        "MANIFEST_SHA256.txt",
    ]
    try:
        assert client.get("/api/export/bundle", headers=headers).status_code == 403
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        # Toujours verrouillé avant approbation humaine
        assert client.get("/api/export/bundle", headers=headers).status_code == 403

        assert client.post("/api/validate", headers=headers).status_code == 200
        res = client.get("/api/export/bundle", headers=headers)
        assert res.status_code == 200
        assert res.headers.get("content-type") == "application/zip"
        content_disp = res.headers.get("content-disposition") or ""
        assert "TRIAD_Dossier_Preuve_NIS2_APRES_bundle-proof-session.zip" in content_disp

        with zipfile.ZipFile(io.BytesIO(res.content), mode="r") as zf:
            assert zf.testzip() is None
            assert zf.namelist() == expected_entries
            assert zf.read("02_Matrice_GRC.csv").startswith(b"\xef\xbb\xbf")

            sealed = json.loads(zf.read("03_Synthese_Scellee.json").decode("utf-8"))
            assert sealed["validated"] is True
            assert sealed["integrity"]["chain"]["valide"] is True

            chain_lines = [
                ln for ln in zf.read("06_Audit_Chain.jsonl").decode("utf-8").splitlines() if ln
            ]
            assert len(chain_lines) == sealed["integrity"]["nb_entrees"]

            manifest_text = zf.read("MANIFEST_SHA256.txt").decode("utf-8")
            manifest_lines = [
                ln
                for ln in manifest_text.splitlines()
                if ln.strip() and not ln.strip().startswith("#")
            ]
            assert len(manifest_lines) == 12
            for line in manifest_lines:
                digest, fname = line.split("  ", 1)
                assert len(digest) == 64
                assert hashlib.sha256(zf.read(fname)).hexdigest() == digest

            zf.extractall(tmp_path)

        # Vérifie la compatibilité native avec `sha256sum --strict -c MANIFEST_SHA256.txt`
        chk = subprocess.run(
            ["sha256sum", "--strict", "-c", "MANIFEST_SHA256.txt"],
            cwd=tmp_path,
            capture_output=True,
            text=True,
        )
        assert chk.returncode == 0, chk.stderr
    finally:
        client.delete("/api/sessions/bundle-proof-session")


def test_upload_strict_validation_extensions_count_and_chunked_size_limit() -> None:
    headers = {"X-Session-Id": "upload-hardened-session"}
    try:
        # Charge la démo pour vérifier qu'un upload rejeté n'écrase pas la session existante
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        before_files = client.get("/api/status", headers=headers).json()["files"]
        assert len(before_files) == 4

        # 1. Rejet 400 sur extension interdite (.exe, .docx)
        bad_ext = client.post(
            "/api/upload",
            headers=headers,
            files=[("files", ("payload.exe", b"MZ\x90\x00", "application/octet-stream"))],
        )
        assert bad_ext.status_code == 400
        assert ".exe" in bad_ext.json()["detail"]
        assert client.get("/api/status", headers=headers).json()["files"] == before_files

        # 2. Rejet 400 au-delà du nombre maximal de fichiers (> 20)
        too_many = [
            ("files", (f"doc_{i:02d}.md", b"# Politique\n", "text/markdown"))
            for i in range(21)
        ]
        res_many = client.post("/api/upload", headers=headers, files=too_many)
        assert res_many.status_code == 400
        assert "20" in res_many.json()["detail"]

        # 3. Rejet 413 au-delà de 10 Mo par fichier (lecture par chunks, nettoyage immédiat)
        oversized_bytes = b"A" * (10 * 1024 * 1024 + 1024)
        res_big = client.post(
            "/api/upload",
            headers=headers,
            files=[("files", ("trop_lourd.pdf", oversized_bytes, "application/pdf"))],
        )
        assert res_big.status_code == 413
        assert "10 Mo" in res_big.json()["detail"]
        # La session initiale est toujours intacte
        assert client.get("/api/status", headers=headers).json()["files"] == before_files

        # 4. Acceptation 200 sur extensions valides (.md, .txt, .pdf) + assainissement du nom
        ok_upload = client.post(
            "/api/upload",
            headers=headers,
            files=[
                ("files", ("../PSSI_Client.md", b"# PSSI\nControle d'acces strict.\n", "text/markdown")),
                ("files", ("notes_entretien.txt", b"Compte rendu DSI.\n", "text/plain")),
            ],
        )
        assert ok_upload.status_code == 200
        assert ok_upload.json()["uploaded"] == ["PSSI_Client.md", "notes_entretien.txt"]
    finally:
        client.delete("/api/sessions/upload-hardened-session")


def test_content_security_policy_header() -> None:
    for res in (client.get("/"), client.get("/api/health"), client.head("/api/health")):
        csp = res.headers.get("content-security-policy") or ""
        assert "default-src 'self'" in csp
        assert "object-src 'none'" in csp
        assert "frame-ancestors 'none'" in csp
        assert "fonts.googleapis.com" in csp
        assert "fonts.gstatic.com" in csp
        assert "blob:" in csp
        assert "data:" in csp


def test_nis2_coverage_matrix_avant_and_apres() -> None:
    headers = {"X-Session-Id": "nis2-cov-session"}
    try:
        # 1. Avant exécution : 0 exigence couverte sur les 11 du référentiel NIS2
        cov0 = client.get("/api/nis2/coverage", headers=headers)
        assert cov0.status_code == 200
        c0 = cov0.json()
        assert c0["has_synthesis"] is False
        assert c0["total_requirements"] == 11
        assert c0["covered_requirements"] == 0
        assert c0["coverage_rate"] == 0.0
        assert c0["counts_by_status"]["non_couvert"] == 11

        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "AVANT", "use_cache": True},
            ).status_code
            == 200
        )

        # 2. En mode AVANT : Art. 23 n'est touché que par F-007 (partiel)
        cov_av = client.get("/api/nis2/coverage?mode=AVANT", headers=headers).json()
        assert cov_av["has_synthesis"] is True
        assert cov_av["covered_requirements"] == 5
        assert cov_av["coverage_rate"] == 45.5
        by_id_av = {r["id"]: r for r in cov_av["requirements"]}
        assert by_id_av["NIS2-23"]["statut"] == "partiel"
        assert by_id_av["NIS2-23"]["finding_ids"] == ["F-007"]

        # 3. En mode APRES : F-004 fait basculer Art. 23 en non_conforme, F-006 couvre (i) et (j)
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        cov_ap = client.get("/api/nis2/coverage?mode=APRES", headers=headers).json()
        assert cov_ap["has_synthesis"] is True
        assert cov_ap["covered_requirements"] == 5
        by_id_ap = {r["id"]: r for r in cov_ap["requirements"]}
        assert by_id_ap["NIS2-23"]["statut"] == "non_conforme"
        assert by_id_ap["NIS2-23"]["finding_ids"] == ["F-004", "F-007"]
        assert by_id_ap["NIS2-21-2-i"]["statut"] == "non_conforme"
        assert by_id_ap["NIS2-21-2-i"]["finding_ids"] == ["F-001", "F-002", "F-006"]
        assert by_id_ap["NIS2-21-2-j"]["statut"] == "non_conforme"
        assert by_id_ap["NIS2-21-2-j"]["finding_ids"] == ["F-006"]
        assert by_id_ap["NIS2-21-2-c"]["statut"] == "non_conforme"
        assert by_id_ap["NIS2-21-2-c"]["finding_ids"] == ["F-003", "F-005"]
        assert by_id_ap["NIS2-21-2-a"]["statut"] == "non_couvert"
    finally:
        client.delete("/api/sessions/nis2-cov-session")


def test_rate_limiting_429_retry_after_and_metrics_endpoint(monkeypatch) -> None:
    monkeypatch.setenv("RATE_LIMIT_MAX_REQUESTS", "2")
    monkeypatch.setenv("RATE_LIMIT_WINDOW_SECONDS", "60")
    h_main = {"X-Session-Id": "rate-limit-main"}
    h_other = {"X-Session-Id": "rate-limit-other"}
    try:
        m_before = client.get("/api/metrics")
        assert m_before.status_code == 200
        b0 = m_before.json()

        assert client.post("/api/demo/load", headers=h_main).status_code == 200
        # 2 exécutions autorisées sur /api/audit/run, la 3e est bloquée en 429 + Retry-After
        assert (
            client.post(
                "/api/audit/run",
                headers=h_main,
                json={"mode": "AVANT", "use_cache": True},
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/audit/run",
                headers=h_main,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        r_429 = client.post(
            "/api/audit/run",
            headers=h_main,
            json={"mode": "APRES", "use_cache": True},
        )
        assert r_429.status_code == 429
        retry_after = int(r_429.headers.get("retry-after") or "0")
        assert 1 <= retry_after <= 60

        # Même limiteur par route sur /api/upload
        for _ in range(2):
            up_ok = client.post(
                "/api/upload",
                headers=h_main,
                files=[("files", ("note.md", b"# Note\n", "text/markdown"))],
            )
            assert up_ok.status_code == 200
        up_429 = client.post(
            "/api/upload",
            headers=h_main,
            files=[("files", ("note.md", b"# Note\n", "text/markdown"))],
        )
        assert up_429.status_code == 429
        assert int(up_429.headers.get("retry-after") or "0") >= 1

        # Une autre session n'est pas affectée par le quota de rate-limit-main
        assert (
            client.post(
                "/api/audit/run",
                headers=h_other,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )

        # Vérifie l'incrémentation temps réel dans GET /api/metrics
        m_after = client.get("/api/metrics")
        assert m_after.status_code == 200
        b1 = m_after.json()
        assert b1["requests_total"] > b0["requests_total"]
        assert b1["audits_executed"] >= b0["audits_executed"] + 3
        assert b1["uploads_total"] >= b0["uploads_total"] + 2
        assert b1["blocked"]["429"] >= b0["blocked"]["429"] + 2
        assert set(b1["blocked"].keys()) >= {"400", "403", "413", "429", "security_violations", "total"}
        assert b1["latency_ms"]["avg_request_ms"] >= 0.0
        assert b1["latency_ms"]["avg_audit_ms"] > 0.0
        avg_agents = b1["latency_ms"]["avg_agent_timings_ms"]
        for ag in ("Douanier", "AnalysteConformite", "ContreAuditeur", "GardeDuCorps"):
            assert avg_agents[ag] is not None and avg_agents[ag] > 0.0
    finally:
        client.delete("/api/sessions/rate-limit-main")
        client.delete("/api/sessions/rate-limit-other")


def test_documents_fulltext_search_masked_only_and_mode_scoping() -> None:
    headers = {"X-Session-Id": "doc-search-session"}
    try:
        # 1. Même après demo/load (sans exécution du Douanier), les fichiers bruts disque ne sont JAMAIS lus
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        pre = client.get("/api/documents/search?q=Moreau", headers=headers)
        assert pre.status_code == 200
        assert pre.json()["has_synthesis"] is False
        assert pre.json()["results"] == []

        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "AVANT", "use_cache": True},
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )

        # 2. Aucune fuite PII brute : les données personnelles d'origine sont absentes de l'index
        for raw_pii in ("Claire Moreau", "claire.moreau@ch-valmont.fr", "FR76 3000"):
            pii_res = client.get(
                "/api/documents/search",
                params={"q": raw_pii, "mode": "APRES"},
                headers=headers,
            ).json()
            assert pii_res["count"] == 0
            assert pii_res["results"] == []

        # 3. Les jetons masqués par le Douanier (y compris en quarantaine) sont cherchables
        iban_res = client.get(
            "/api/documents/search",
            params={"q": "[iban_1]", "mode": "APRES"},
            headers=headers,
        ).json()
        assert iban_res["count"] >= 1
        assert iban_res["results"][0]["nom_fichier"] == "annexe_fournisseur_maintenance.md"
        assert iban_res["results"][0]["statut"] == "quarantaine"
        assert iban_res["results"][0]["match"] == "[IBAN_1]"

        # 4. Filtrage par mode (AVANT exclut notes_entretien_DSI.md, APRES l'inclut) + sous-chaîne exacte
        av_ransom = client.get(
            "/api/documents/search",
            params={"q": "RANSOMWARE", "mode": "AVANT"},
            headers=headers,
        ).json()
        ap_ransom = client.get(
            "/api/documents/search",
            params={"q": "RANSOMWARE", "mode": "APRES"},
            headers=headers,
        ).json()
        av_files = {r["nom_fichier"] for r in av_ransom["results"]}
        ap_files = {r["nom_fichier"] for r in ap_ransom["results"]}
        assert "notes_entretien_DSI.md" not in av_files
        assert "notes_entretien_DSI.md" in ap_files
        assert "PV_test_restauration.md" in ap_files

        status_ap = client.get("/api/status?mode=APRES", headers=headers).json()
        docs_map = {
            d["nom_fichier"]: d["contenu_masque"]
            for d in (
                status_ap["synthesis"]["documents_nettoyes"]
                + status_ap["synthesis"]["documents_quarantaine"]
            )
        }
        for hit in ap_ransom["results"]:
            assert hit["line"] >= 1
            assert hit["match"].lower() == "ransomware"
            assert hit["snippet"] in docs_map[hit["nom_fichier"]]

        # 5. Plafond de 20 correspondances retournées sur requête fréquente
        capped = client.get(
            "/api/documents/search",
            params={"q": "de", "mode": "APRES"},
            headers=headers,
        ).json()
        assert capped["total_matches"] > 20
        assert capped["count"] == 20
        assert len(capped["results"]) == 20
    finally:
        client.delete("/api/sessions/doc-search-session")


def test_verify_bundle_endpoint_valid_tampered_zipslip_and_limits() -> None:
    headers = {"X-Session-Id": "verify-bundle-session"}
    try:
        # 1. Rejets HTTP 400 (extension non .zip / vide) et HTTP 413 (> 20 Mo)
        r_bad_ext = client.post(
            "/api/verify/bundle",
            headers=headers,
            files={"file": ("rapport.pdf", b"%PDF-1.4", "application/pdf")},
        )
        assert r_bad_ext.status_code == 400

        r_empty = client.post(
            "/api/verify/bundle",
            headers=headers,
            files={"file": ("vide.zip", b"", "application/zip")},
        )
        assert r_empty.status_code == 400

        oversized_zip = b"P" * (20 * 1024 * 1024 + 2048)
        r_too_big = client.post(
            "/api/verify/bundle",
            headers=headers,
            files={"file": ("enorme.zip", oversized_zip, "application/zip")},
        )
        assert r_too_big.status_code == 413

        # 2. Génère un vrai Dossier de Preuve scellé et vérifie son authenticité
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        assert client.post("/api/validate?mode=APRES", headers=headers).status_code == 200
        bundle_res = client.get("/api/export/bundle?mode=APRES", headers=headers)
        assert bundle_res.status_code == 200
        valid_zip_bytes = bundle_res.content

        v_ok = client.post(
            "/api/verify/bundle",
            headers=headers,
            files={"file": ("TRIAD_Dossier.zip", valid_zip_bytes, "application/zip")},
        )
        assert v_ok.status_code == 200
        cert_ok = v_ok.json()
        assert cert_ok["authentic"] is True
        assert cert_ok["manifest_valid"] is True
        assert cert_ok["chain_valid"] is True
        assert cert_ok["sealed_json_match"] is True
        assert cert_ok["zip_slip_safe"] is True
        assert cert_ok["signature_status"] == "UNSIGNED"
        assert cert_ok["bundle_version"] == "v6"
        assert cert_ok["errors"] == []
        assert len(cert_ok["files_checked"]) == 12
        assert all(item["valid"] for item in cert_ok["files_checked"])
        assert len(cert_ok["head_hash"]) == 64

        # 3. Test négatif #1 : altération d'un seul octet dans 01_Rapport_NIS2.md (MANIFEST invalide)
        tampered_piece_buf = io.BytesIO()
        with (
            zipfile.ZipFile(io.BytesIO(valid_zip_bytes), "r") as zf_in,
            zipfile.ZipFile(tampered_piece_buf, "w", compression=zipfile.ZIP_DEFLATED) as zf_out,
        ):
            for name in zf_in.namelist():
                data = zf_in.read(name)
                if name == "01_Rapport_NIS2.md":
                    data = (bytes([data[0] ^ 0x01]) + data[1:]) if data else b"X"
                zf_out.writestr(name, data)

        v_tampered_piece = client.post(
            "/api/verify/bundle",
            headers=headers,
            files={"file": ("alt_piece.zip", tampered_piece_buf.getvalue(), "application/zip")},
        ).json()
        assert v_tampered_piece["authentic"] is False
        assert v_tampered_piece["manifest_valid"] is False
        assert any("01_Rapport_NIS2.md" in err for err in v_tampered_piece["errors"])

        # 4. Test négatif #2 : altération d'un octet brut dans le flux binaire .zip
        mutated_raw = bytearray(valid_zip_bytes)
        mid = len(mutated_raw) // 3
        mutated_raw[mid] ^= 0xFF
        v_raw = client.post(
            "/api/verify/bundle",
            headers=headers,
            files={"file": ("alt_raw.zip", bytes(mutated_raw), "application/zip")},
        )
        assert v_raw.status_code == 200
        assert v_raw.json()["authentic"] is False
        assert len(v_raw.json()["errors"]) >= 1

        # 5. Test négatif #3 : falsification de 06_Audit_Chain.jsonl AVEC recalcul frauduleux du MANIFEST
        forged_chain_buf = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(valid_zip_bytes), "r") as zf_in:
            entries_map = {name: zf_in.read(name) for name in zf_in.namelist()}
        chain_text = entries_map["06_Audit_Chain.jsonl"].decode("utf-8")
        entries_map["06_Audit_Chain.jsonl"] = chain_text.replace(
            '"SANITIZED"', '"FORGED_ACTION"', 1
        ).encode("utf-8")
        new_manifest_lines = [
            f"{hashlib.sha256(entries_map[fname]).hexdigest()}  {fname}"
            for fname in (
                "01_Rapport_NIS2.md",
                "02_Matrice_GRC.csv",
                "03_Synthese_Scellee.json",
                "04_Playbook_DryRun.sh",
                "05_Mail_DSI.txt",
                "06_Audit_Chain.jsonl",
                "07_PreNotification_ANSSI_Art23.md",
                "08_Brief_COMEX_Art20.md",
                "09_Remediation_GitOps.tf",
                "10_Guide_Entretien_Contradictoire.md",
                "11_Registre_Arbitrages_GRC.md",
                "12_Evaluation_CNIL_RGPD_Art33.md",
            )
        ]
        entries_map["MANIFEST_SHA256.txt"] = ("\n".join(new_manifest_lines) + "\n").encode("utf-8")
        with zipfile.ZipFile(forged_chain_buf, "w", compression=zipfile.ZIP_DEFLATED) as zf_out:
            for fname, content in entries_map.items():
                zf_out.writestr(fname, content)

        v_forged = client.post(
            "/api/verify/bundle",
            headers=headers,
            files={"file": ("forged_chain.zip", forged_chain_buf.getvalue(), "application/zip")},
        ).json()
        assert v_forged["manifest_valid"] is True
        assert v_forged["chain_valid"] is False
        assert v_forged["authentic"] is False
        assert any("06_Audit_Chain.jsonl" in err for err in v_forged["errors"])

        # 6. Test négatif #4 : protection stricte anti-ZipSlip (../../etc/passwd)
        zipslip_buf = io.BytesIO()
        with zipfile.ZipFile(zipslip_buf, "w", compression=zipfile.ZIP_DEFLATED) as zf_evil:
            zf_evil.writestr("../../etc/passwd", b"root:x:0:0::/root:/bin/sh\n")
        v_slip = client.post(
            "/api/verify/bundle",
            headers=headers,
            files={"file": ("evil_slip.zip", zipslip_buf.getvalue(), "application/zip")},
        ).json()
        assert v_slip["authentic"] is False
        assert v_slip["zip_slip_safe"] is False
        assert any("ZipSlip" in err for err in v_slip["errors"])
    finally:
        client.delete("/api/sessions/verify-bundle-session")


def test_metrics_prometheus_openmetrics_format_and_json_default() -> None:
    # 1. JSON par défaut conservé à 100 %
    res_json = client.get("/api/metrics")
    assert res_json.status_code == 200
    assert res_json.headers["content-type"].startswith("application/json")
    snap = res_json.json()
    assert snap["status"] == "ok"
    assert "bundle_verifications_total" in snap

    # 2. Format texte Prometheus 0.0.4 via ?format=prometheus
    res_prom = client.get("/api/metrics?format=prometheus")
    assert res_prom.status_code == 200
    assert res_prom.headers["content-type"] == "text/plain; version=0.0.4; charset=utf-8"
    text = res_prom.text
    assert "# HELP triad_http_requests_total" in text
    assert "# TYPE triad_http_requests_total counter" in text
    assert "triad_audits_executed_total " in text
    assert "triad_validations_total " in text
    assert "triad_bundle_verifications_total " in text
    assert 'triad_blocked_requests_total{reason="429"} ' in text
    assert 'triad_agent_latency_avg_ms{agent="Douanier"} ' in text
    assert 'triad_rate_limit_config{param="max_requests"} ' in text

    for raw_line in text.splitlines():
        line = raw_line.strip()
        assert line != ""
        if line.startswith("#"):
            assert line.startswith(("# HELP ", "# TYPE "))
        else:
            parts = line.rsplit(" ", 1)
            assert len(parts) == 2
            float(parts[1])


def test_finding_grc_decision_persistence_validation_reset_chain_and_exports() -> None:
    headers = {"X-Session-Id": "grc-decision-session"}
    try:
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )

        # 1. Rejets 400 (décision invalide) et 404 (constat inconnu)
        bad_dec = client.patch(
            "/api/findings/F-001/decision",
            headers=headers,
            json={"decision": "inconnue"},
        )
        assert bad_dec.status_code == 400

        not_found = client.patch(
            "/api/findings/F-999/decision",
            headers=headers,
            json={"decision": "a_corriger"},
        )
        assert not_found.status_code == 404

        # 2. Validation humaine initiale -> exports déverrouillés (200)
        assert client.post("/api/validate?mode=APRES", headers=headers).status_code == 200
        assert client.get("/api/export/report?mode=APRES", headers=headers).status_code == 200

        # 3. Modification d'arbitrage GRC post-validation -> réinitialise validated=False + scelle SHA-256
        patch_res = client.patch(
            "/api/findings/f-001/decision",
            headers=headers,
            json={
                "mode": "APRES",
                "decision": "a_corriger",
                "porteur": "Équipe Cloud & RSSI",
                "echeance": "2026-12-15",
                "commentaire": "=PRIORITE_P0 Révoquer allUsers immédiatement",
            },
        )
        assert patch_res.status_code == 200
        pdata = patch_res.json()
        assert pdata["finding_id"] == "F-001"
        assert pdata["validated"] is False
        assert pdata["validation_reset"] is True
        assert pdata["statut_validation"] == "EN ATTENTE DE VALIDATION"
        assert pdata["decision"]["decision"] == "a_corriger"
        assert pdata["decision"]["decision_label"] == "À corriger prioritairement"
        assert pdata["chain"]["valide"] is True

        # Le verrou d'export est de nouveau actif tant qu'une nouvelle validation humaine n'a pas eu lieu
        for exp_url in (
            "/api/export/report?mode=APRES",
            "/api/export/csv?mode=APRES",
            "/api/export/json?mode=APRES",
            "/api/export/bundle?mode=APRES",
        ):
            assert client.get(exp_url, headers=headers).status_code == 403

        # 4. Survie au redémarrage serveur (SessionStore disque) + présence dans la chaîne SHA-256
        SESSION_STORE.clear_memory_cache()
        status_reloaded = client.get("/api/status?mode=APRES", headers=headers).json()
        assert status_reloaded["validated"] is False
        assert status_reloaded["decisions"]["F-001"]["porteur"] == "Équipe Cloud & RSSI"
        f001 = next(
            f for f in status_reloaded["synthesis"]["findings"] if f["id"] == "F-001"
        )
        assert f001["decision_grc"]["echeance"] == "2026-12-15"
        assert any(
            e["action"] == "FINDING_DECISION_UPDATED"
            and e["details"].get("finding_id") == "F-001"
            for e in status_reloaded["audit_log"]
        )

        # 5. Nouvelle validation humaine -> répercussion complète dans report, csv, json et bundle .zip
        assert client.post("/api/validate?mode=APRES", headers=headers).status_code == 200

        rep_txt = client.get("/api/export/report?mode=APRES", headers=headers).text
        assert "Décision d'arbitrage GRC" in rep_txt
        assert "À corriger prioritairement" in rep_txt
        assert "Équipe Cloud & RSSI" in rep_txt
        assert "2026-12-15" in rep_txt

        csv_txt = client.get("/api/export/csv?mode=APRES", headers=headers).content.decode(
            "utf-8-sig"
        )
        csv_rows = list(csv.DictReader(io.StringIO(csv_txt)))
        assert csv_rows[0]["Décision GRC"] == "À corriger prioritairement"
        assert csv_rows[0]["Porteur Métier"] == "Équipe Cloud & RSSI"
        assert csv_rows[0]["Échéance Cible"] == "2026-12-15"
        assert csv_rows[0]["Commentaire d'Arbitrage"].startswith("'=PRIORITE_P0")

        json_exp = client.get("/api/export/json?mode=APRES", headers=headers).json()
        assert json_exp["decisions"]["F-001"]["decision"] == "a_corriger"

        bundle_bytes = client.get("/api/export/bundle?mode=APRES", headers=headers).content
        ver = client.post(
            "/api/verify/bundle",
            headers=headers,
            files={"file": ("bundle_grc.zip", bundle_bytes, "application/zip")},
        ).json()
        assert ver["authentic"] is True
    finally:
        client.delete("/api/sessions/grc-decision-session")


def test_remediation_impact_and_roi_simulator() -> None:
    headers = {"X-Session-Id": "roi-sim-session"}
    try:
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )

        # 1. Aucune sélection -> score actuel inchangé (22), charge 0 j.h, réduction Art. 34 = 0 %
        sim0 = client.post(
            "/api/remediation/simulate",
            headers=headers,
            json={"selected_ids": [], "mode": "APRES"},
        ).json()
        assert sim0["has_synthesis"] is True
        assert sim0["current_score"] == 22
        assert sim0["projected_score"] == 22
        assert sim0["score_delta"] == 0
        assert sim0["workload_jh"]["estimated_jh"] == 0.0
        assert sim0["art34_exposure"]["plafond_sanction_eur"] == 10_000_000
        assert sim0["art34_exposure"]["exposure_reduction_pct"] == 0.0

        # 2. Sélection des chantiers critiques F-001, F-002, F-003 -> hausse nette du score et gains par pilier
        sim_qw = client.post(
            "/api/remediation/simulate",
            headers=headers,
            json={"selected_ids": ["F-001", "F-002", "F-003"], "mode": "APRES"},
        ).json()
        assert sim_qw["projected_score"] > sim_qw["current_score"]
        assert sim_qw["score_delta"] >= 35
        assert sim_qw["workload_jh"]["estimated_jh"] > 0.0
        assert sim_qw["workload_jh"]["quick_wins_count"] >= 2
        assert (
            sim_qw["art34_exposure"]["critical_gaps_after"]
            < sim_qw["art34_exposure"]["critical_gaps_before"]
        )
        pillars_by_id = {p["id"]: p for p in sim_qw["pillars"]}
        assert pillars_by_id["data-exposure"]["gain"] > 0
        assert pillars_by_id["network-sec"]["gain"] > 0
        assert pillars_by_id["backup-pca"]["gain"] > 0

        # Parité GET ?selected_ids=...
        sim_get = client.get(
            "/api/remediation/simulate?selected_ids=F-001,F-002,F-003&mode=APRES",
            headers=headers,
        ).json()
        assert sim_get["projected_score"] == sim_qw["projected_score"]

        # 3. Remédiation intégrale -> score projeté 100/100 et exposition résiduelle 0 %
        all_ids = [f"F-00{i}" for i in range(1, 8)]
        sim_all = client.post(
            "/api/remediation/simulate",
            headers=headers,
            json={"selected_ids": all_ids, "mode": "APRES"},
        ).json()
        assert sim_all["projected_score"] == 100
        assert sim_all["art34_exposure"]["exposure_reduction_pct"] == 100.0
        assert sim_all["art34_exposure"]["critical_gaps_after"] == 0
        assert sim_all["art34_exposure"]["risk_level_after"] == "MAÎTRISÉ"
    finally:
        client.delete("/api/sessions/roi-sim-session")


def test_sessions_ttl_cleanup_preserves_default_and_purges_expired(monkeypatch) -> None:
    from triad.api.app import LOGS_DIR, UPLOAD_DIR

    monkeypatch.setenv("SESSION_TTL_HOURS", "24")
    h_default = {"X-Session-Id": "default"}
    h_fresh = {"X-Session-Id": "ttl-fresh-session"}
    h_stale = {"X-Session-Id": "ttl-stale-session"}

    try:
        for h in (h_default, h_fresh, h_stale):
            assert client.post("/api/demo/load", headers=h).status_code == 200
            assert (
                client.post(
                    "/api/audit/run",
                    headers=h,
                    json={"mode": "AVANT", "use_cache": True},
                ).status_code
                == 200
            )

        assert (
            client.post(
                "/api/upload",
                headers=h_stale,
                files=[("files", ("stale_doc.md", b"# Stale\n", "text/markdown"))],
            ).status_code
            == 200
        )
        # Crée aussi un artefact dans logs/uploads/ttl-stale-session/ pour vérifier le nettoyage atomique
        logs_up_stale = LOGS_DIR / "uploads" / "ttl-stale-session"
        logs_up_stale.mkdir(parents=True, exist_ok=True)
        (logs_up_stale / "piece.md").write_text("# Piece\n", encoding="utf-8")

        # Vieillit artificiellement 'default' ET 'ttl-stale-session' à 2020 (expirés > 24h)
        for old_sid in ("default", "ttl-stale-session"):
            sf = SESSION_STORE.session_file(old_sid)
            payload = json.loads(sf.read_text(encoding="utf-8"))
            payload["updated_at"] = "2020-01-01T00:00:00+00:00"
            sf.write_text(json.dumps(payload), encoding="utf-8")
        SESSION_STORE.clear_memory_cache()

        # 1. Dry-run : identifie uniquement ttl-stale-session, ne supprime rien et protège 'default'
        dry = client.post("/api/sessions/cleanup", json={"dry_run": True}).json()
        assert dry["dry_run"] is True
        assert dry["cleaned"] is False
        assert dry["purged_sessions"] == ["ttl-stale-session"]
        assert "default" in dry["protected_sessions"]
        assert SESSION_STORE.session_file("ttl-stale-session").exists()

        # 2. Exécution réelle sans corps JSON : purge atomique de ttl-stale-session, conservation stricte de 'default' et 'ttl-fresh-session'
        real = client.post("/api/sessions/cleanup")
        assert real.status_code == 200
        rdata = real.json()
        assert rdata["cleaned"] is True
        assert rdata["purged_sessions"] == ["ttl-stale-session"]
        assert "default" in rdata["remaining_sessions"]
        assert "ttl-fresh-session" in rdata["remaining_sessions"]

        assert not SESSION_STORE.session_file("ttl-stale-session").exists()
        assert not (LOGS_DIR / "audit_trail_ttl-stale-session.jsonl").exists()
        assert not (UPLOAD_DIR / "ttl-stale-session").exists()
        assert not logs_up_stale.exists()
        assert SESSION_STORE.session_file("default").exists()
        assert (LOGS_DIR / "audit_trail.jsonl").exists()
    finally:
        client.post("/api/reset", headers=h_default)
        client.delete("/api/sessions/ttl-fresh-session")
        client.delete("/api/sessions/ttl-stale-session")


def test_export_anssi_draft_art23_gate_milestones_and_grc_decisions() -> None:
    headers = {"X-Session-Id": "anssi-draft-session"}
    try:
        # 1. Verrou HTTP 403 strict avant audit et avant validation humaine
        assert client.get("/api/export/anssi-draft", headers=headers).status_code == 403
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        assert client.get("/api/export/anssi-draft?mode=APRES", headers=headers).status_code == 403

        # 2. Enregistre un arbitrage GRC, valide humainement, puis exporte le brouillon Art. 23
        assert (
            client.patch(
                "/api/findings/F-004/decision",
                headers=headers,
                json={
                    "mode": "APRES",
                    "decision": "a_corriger",
                    "porteur": "Cellule Crise Cyber & RSSI",
                    "echeance": "J+15",
                    "commentaire": "Formaliser l'escalade ANSSI 24h et qualifier l'incident de septembre",
                },
            ).status_code
            == 200
        )
        assert client.post("/api/validate?mode=APRES", headers=headers).status_code == 200

        res = client.get("/api/export/anssi-draft?mode=APRES", headers=headers)
        assert res.status_code == 200
        assert "text/markdown" in (res.headers.get("content-type") or "")
        body = res.text

        # Vérifie la présence des 3 jalons Art. 23 §4 NIS2, des constats critiques, de l'arbitrage GRC et du head_hash
        assert "Jalon 1 — Alerte Précoce sous 24 heures" in body
        assert "Jalon 2 — Notification d'Évaluation sous 72 heures" in body
        assert "Jalon 3 — Plan de Rapport Final sous 1 mois" in body
        assert "F-001" in body and "F-004" in body
        assert "Cellule Crise Cyber & RSSI" in body
        assert "J+15" in body

        st = client.get("/api/status?mode=APRES", headers=headers).json()
        expected_head = st["audit_log"][-1]["hash"]
        assert expected_head in body

        # 3. Toute nouvelle modification GRC reverrouille aussi /api/export/anssi-draft en 403
        assert (
            client.patch(
                "/api/findings/F-001/decision",
                headers=headers,
                json={"decision": "mesure_compensatoire", "porteur": "Ops Cloud"},
            ).status_code
            == 200
        )
        assert client.get("/api/export/anssi-draft?mode=APRES", headers=headers).status_code == 403
    finally:
        client.delete("/api/sessions/anssi-draft-session")


def test_session_snapshot_export_and_cryptographic_import_json_and_multipart() -> None:
    src_sid = "snapshot-origin-session"
    h_src = {"X-Session-Id": src_sid}
    restored_sid_json = "___Restored_Session__1_"
    restored_sid_mp = "restored-multipart"

    try:
        # 404 sur session secondaire inexistante
        assert client.get("/api/sessions/inexistante-xyz/snapshot").status_code == 404

        assert client.post("/api/demo/load", headers=h_src).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=h_src,
                json={"mode": "AVANT", "use_cache": True},
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/audit/run",
                headers=h_src,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        assert (
            client.patch(
                "/api/findings/F-001/decision",
                headers=h_src,
                json={
                    "mode": "APRES",
                    "decision": "a_corriger",
                    "porteur": "DSI CH Valmont",
                    "echeance": "2026-12-01",
                },
            ).status_code
            == 200
        )
        assert client.post("/api/validate?mode=APRES", headers=h_src).status_code == 200

        snap_res = client.get(f"/api/sessions/{src_sid}/snapshot")
        assert snap_res.status_code == 200
        snap = snap_res.json()
        assert snap["session_id"] == src_sid
        assert snap["integrity"]["chain"]["valide"] is True
        assert len(snap["audit_log"]) >= 8
        # Aucun chemin absolu local exposé dans files
        assert all("/" not in f for f in snap["state"]["files"])

        # 1. Rejet HTTP 400 immédiat si un maillon de audit_log est altéré
        tampered_chain = json.loads(json.dumps(snap))
        tampered_chain["audit_log"][2]["action"] = "FALSIFIED_ACTION"
        r_bad_chain = client.post(
            "/api/sessions/import?target_session_id=should-not-exist",
            json=tampered_chain,
        )
        assert r_bad_chain.status_code == 400
        assert not SESSION_STORE.exists("should-not-exist")

        # 2. Rejet HTTP 400 si l'état est modifié sans concordance state_sha256 ou validation forgée sans preuve
        tampered_state = json.loads(json.dumps(snap))
        tampered_state["state"]["results_by_mode"]["AVANT"]["validated"] = True
        r_bad_state = client.post(
            "/api/sessions/import?target_session_id=should-not-exist",
            json=tampered_state,
        )
        assert r_bad_state.status_code == 400

        forged_minimal = {
            "session_id": "forged-val",
            "state": {
                "mode": "APRES",
                "results_by_mode": {
                    "APRES": {
                        "validated": True,
                        "synthesis": {"client": "X", "findings": []},
                    }
                },
            },
            "audit_log": [],
        }
        assert client.post("/api/sessions/import", json=forged_minimal).status_code == 400

        # 3. Import JSON valide vers un session_id assaini ("../Restored Session #1!" -> "___Restored_Session__1_")
        imp_json = client.post(
            "/api/sessions/import",
            params={"target_session_id": "../Restored Session #1!"},
            json=snap,
        )
        assert imp_json.status_code == 200
        imp_data = imp_json.json()
        assert imp_data["imported"] is True
        assert imp_data["session_id"] == restored_sid_json
        assert imp_data["modes_ready"] == {"AVANT": True, "APRES": True}
        assert imp_data["modes_validated"] == {"AVANT": False, "APRES": True}
        assert imp_data["chain"]["valide"] is True

        restored_status = client.get(
            "/api/status?mode=APRES",
            headers={"X-Session-Id": restored_sid_json},
        ).json()
        assert restored_status["decisions"]["F-001"]["porteur"] == "DSI CH Valmont"
        assert (
            client.get(
                "/api/export/anssi-draft?mode=APRES",
                headers={"X-Session-Id": restored_sid_json},
            ).status_code
            == 200
        )

        # 4. Import valide en multipart/form-data (téléversement de fichier .json depuis l'UI)
        imp_mp = client.post(
            "/api/sessions/import",
            data={"target_session_id": restored_sid_mp},
            files={"file": ("snapshot.json", snap_res.content, "application/json")},
        )
        assert imp_mp.status_code == 200
        assert imp_mp.json()["session_id"] == restored_sid_mp
        assert imp_mp.json()["head_hash"] == snap["integrity"]["head_hash"]
    finally:
        client.delete(f"/api/sessions/{src_sid}")
        client.delete(f"/api/sessions/{restored_sid_json}")
        client.delete(f"/api/sessions/{restored_sid_mp}")


def test_export_comex_brief_art20_gate_content_and_relock() -> None:
    headers = {"X-Session-Id": "comex-brief-session"}
    try:
        # 1. Verrouillé (HTTP 403) avant exécution et avant validation humaine
        assert client.get("/api/export/comex-brief", headers=headers).status_code == 403
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "AVANT", "use_cache": True},
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        assert client.get("/api/export/comex-brief?mode=APRES", headers=headers).status_code == 403

        # 2. Enregistre un arbitrage GRC puis valide uniquement APRES
        assert (
            client.patch(
                "/api/findings/F-001/decision",
                headers=headers,
                json={
                    "mode": "APRES",
                    "decision": "a_corriger",
                    "porteur": "Directeur Général & RSSI",
                    "echeance": "J+15",
                },
            ).status_code
            == 200
        )
        val_res = client.post("/api/validate?mode=APRES", headers=headers)
        assert val_res.status_code == 200

        # AVANT reste verrouillé en 403 tandis que APRES est déverrouillé en 200
        assert client.get("/api/export/comex-brief?mode=AVANT", headers=headers).status_code == 403
        res_ok = client.get("/api/export/comex-brief?mode=APRES", headers=headers)
        assert res_ok.status_code == 200
        assert res_ok.headers["content-type"].startswith("text/markdown")
        assert "TRIAD_Brief_COMEX_Art20_APRES.md" in (
            res_ok.headers.get("content-disposition") or ""
        )

        brief = res_ok.text
        assert "Article 20 NIS2" in brief
        assert "personnellement responsables" in brief
        assert "10 M€" in brief
        assert "j.h" in brief
        assert "Directeur Général & RSSI" in brief
        assert "J+15" in brief
        assert "AVANT" in brief and "APRÈS" in brief

        status_ap = client.get("/api/status?mode=APRES", headers=headers).json()
        head_hash = status_ap["audit_log"][-1]["hash"]
        assert head_hash in brief

        # 3. Une modification GRC post-approbation re-verrouille immédiatement l'export COMEX
        assert (
            client.patch(
                "/api/findings/F-002/decision",
                headers=headers,
                json={"mode": "APRES", "decision": "mesure_compensatoire", "porteur": "Équipe Réseau"},
            ).status_code
            == 200
        )
        assert client.get("/api/export/comex-brief?mode=APRES", headers=headers).status_code == 403
    finally:
        client.delete("/api/sessions/comex-brief-session")


def test_hmac_signing_secret_exports_manifest_verify_and_v1_retrocompat(
    monkeypatch, tmp_path: Path
) -> None:
    secret = "triad-iter13-hmac-signing-secret"
    monkeypatch.setenv("AUDIT_SIGNING_SECRET", secret)
    headers = {"X-Session-Id": "hmac-bundle-session"}
    repo_root = Path(__file__).resolve().parents[1]
    verify_script = repo_root / "scripts" / "verify_bundle.sh"

    try:
        health_json = client.get("/api/health").json()
        assert health_json["hmac_signing_enabled"] is True
        assert secret not in json.dumps(health_json)

        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        assert client.post("/api/validate?mode=APRES", headers=headers).status_code == 200

        # 1. Tous les 12 exports scellés exposent X-Triad-Signature = hmac-sha256=<digest exact>
        for ep in (
            "report",
            "mail",
            "json",
            "csv",
            "playbook",
            "anssi-draft",
            "comex-brief",
            "terraform",
            "interview-guide",
            "risk-register",
            "cnil-draft",
            "bundle",
        ):
            exp_res = client.get(f"/api/export/{ep}?mode=APRES", headers=headers)
            assert exp_res.status_code == 200, ep
            sig_hdr = exp_res.headers.get("x-triad-signature") or ""
            expected_hdr = (
                "hmac-sha256="
                + hmac.new(secret.encode("utf-8"), exp_res.content, hashlib.sha256).hexdigest()
            )
            assert sig_hdr == expected_hdr, ep
            if ep == "bundle":
                signed_zip_bytes = exp_res.content

        # 2. MANIFEST_SHA256.txt contient # TRIAD-HMAC-SHA256: <hex> tout en restant 100 % compatible sha256sum -c et verify_bundle.sh
        v2_zip_path = tmp_path / "signed_v2.zip"
        v2_zip_path.write_bytes(signed_zip_bytes)
        extract_dir = tmp_path / "extracted_v2"
        extract_dir.mkdir()
        with zipfile.ZipFile(io.BytesIO(signed_zip_bytes), "r") as zf:
            manifest_txt = zf.read("MANIFEST_SHA256.txt").decode("utf-8")
            assert "# TRIAD-HMAC-SHA256: " in manifest_txt
            zf.extractall(extract_dir)

        chk_sha = subprocess.run(
            ["sha256sum", "--strict", "-c", "MANIFEST_SHA256.txt"],
            cwd=extract_dir,
            capture_output=True,
            text=True,
        )
        assert chk_sha.returncode == 0, chk_sha.stderr

        chk_script_v2 = subprocess.run(
            ["bash", str(verify_script), str(v2_zip_path)],
            capture_output=True,
            text=True,
        )
        assert chk_script_v2.returncode == 0, chk_script_v2.stdout + chk_script_v2.stderr

        # 3. POST /api/verify/bundle retourne signature_status == "VERIFIED"
        cert_verified = client.post(
            "/api/verify/bundle",
            headers=headers,
            files={"file": ("signed_v2.zip", signed_zip_bytes, "application/zip")},
        ).json()
        assert cert_verified["authentic"] is True
        assert cert_verified["signature_status"] == "VERIFIED"
        assert isinstance(cert_verified["signature_hmac"], str)
        assert len(cert_verified["signature_hmac"]) == 64
        assert cert_verified["bundle_version"] == "v6"
        assert len(cert_verified["files_checked"]) == 12

        # 4. Falsification de la ligne # TRIAD-HMAC-SHA256 -> signature_status == "INVALID" et authentic == False
        forged_hmac_buf = io.BytesIO()
        with (
            zipfile.ZipFile(io.BytesIO(signed_zip_bytes), "r") as zf_in,
            zipfile.ZipFile(forged_hmac_buf, "w", compression=zipfile.ZIP_DEFLATED) as zf_out,
        ):
            for name in zf_in.namelist():
                raw = zf_in.read(name)
                if name == "MANIFEST_SHA256.txt":
                    txt = raw.decode("utf-8")
                    raw = re.sub(
                        r"# TRIAD-HMAC-SHA256:\s*[0-9a-fA-F]{64}",
                        "# TRIAD-HMAC-SHA256: " + ("f" * 64),
                        txt,
                    ).encode("utf-8")
                zf_out.writestr(name, raw)

        cert_invalid = client.post(
            "/api/verify/bundle",
            headers=headers,
            files={"file": ("forged_hmac.zip", forged_hmac_buf.getvalue(), "application/zip")},
        ).json()
        assert cert_invalid["authentic"] is False
        assert cert_invalid["signature_status"] == "INVALID"
        assert any("HMAC" in e for e in cert_invalid["errors"])

        # 5. Rétrocompatibilité archive v1 (6 pièces, sans 07/08 et sans ligne HMAC) -> UNSIGNED & authentic == True
        legacy_v1_buf = io.BytesIO()
        v1_files = (
            "01_Rapport_NIS2.md",
            "02_Matrice_GRC.csv",
            "03_Synthese_Scellee.json",
            "04_Playbook_DryRun.sh",
            "05_Mail_DSI.txt",
            "06_Audit_Chain.jsonl",
        )
        with (
            zipfile.ZipFile(io.BytesIO(signed_zip_bytes), "r") as zf_in,
            zipfile.ZipFile(legacy_v1_buf, "w", compression=zipfile.ZIP_DEFLATED) as zf_v1,
        ):
            v1_manifest_lines: list[str] = []
            for fname in v1_files:
                fdata = zf_in.read(fname)
                zf_v1.writestr(fname, fdata)
                v1_manifest_lines.append(f"{hashlib.sha256(fdata).hexdigest()}  {fname}")
            zf_v1.writestr(
                "MANIFEST_SHA256.txt",
                ("\n".join(v1_manifest_lines) + "\n").encode("utf-8"),
            )

        v1_bytes = legacy_v1_buf.getvalue()
        v1_zip_path = tmp_path / "legacy_v1.zip"
        v1_zip_path.write_bytes(v1_bytes)
        chk_script_v1 = subprocess.run(
            ["bash", str(verify_script), str(v1_zip_path)],
            capture_output=True,
            text=True,
        )
        assert chk_script_v1.returncode == 0, chk_script_v1.stdout + chk_script_v1.stderr

        cert_v1 = client.post(
            "/api/verify/bundle",
            headers=headers,
            files={"file": ("legacy_v1.zip", v1_bytes, "application/zip")},
        ).json()
        assert cert_v1["authentic"] is True
        assert cert_v1["signature_status"] == "UNSIGNED"
        assert cert_v1["signature_hmac"] is None
        assert len(cert_v1["files_checked"]) == 6
    finally:
        client.delete("/api/sessions/hmac-bundle-session")


def test_health_ready_deep_probe_get_head_200_and_503(monkeypatch, tmp_path: Path) -> None:
    import triad.api.app as app_module
    from triad.config import Settings

    # 1. État nominal : GET et HEAD /api/health/ready renvoient 200 OK et 5 contrôles verts
    r_get = client.get("/api/health/ready")
    assert r_get.status_code == 200
    body = r_get.json()
    assert body["ready"] is True
    assert body["status"] == "ready"
    assert body["checks"] == {
        "referentiel_nis2": True,
        "gcp_snapshot": True,
        "demo_cache": True,
        "dist_index": True,
        "logs_writable": True,
    }
    assert body["errors"] == []

    r_head = client.head("/api/health/ready")
    assert r_head.status_code == 200
    assert r_head.headers.get("x-content-type-options") == "nosniff"

    # 2. Référentiel JSON manquant -> 503 Service Unavailable (GET et HEAD)
    empty_data_dir = tmp_path / "empty_data"
    empty_data_dir.mkdir()
    real_settings = app_module.get_settings()
    monkeypatch.setattr(
        app_module,
        "get_settings",
        lambda: Settings(
            data_dir=empty_data_dir,
            logs_dir=real_settings.logs_dir,
        ),
    )
    r_missing_ref = client.get("/api/health/ready")
    assert r_missing_ref.status_code == 503
    assert r_missing_ref.json()["ready"] is False
    assert r_missing_ref.json()["checks"]["referentiel_nis2"] is False
    assert client.head("/api/health/ready").status_code == 503

    # 3. Build UI dist/index.html absent -> 503
    monkeypatch.setattr(app_module, "get_settings", lambda: real_settings)
    monkeypatch.setattr(app_module, "DIST_DIR", tmp_path / "missing_dist")
    r_missing_dist = client.get("/api/health/ready")
    assert r_missing_dist.status_code == 503
    assert r_missing_dist.json()["checks"]["dist_index"] is False

    # 4. Répertoire logs/ non inscriptible (pointe vers un fichier régulier) -> 503
    monkeypatch.undo()
    blocked_logs = tmp_path / "not_a_directory"
    blocked_logs.write_text("file", encoding="utf-8")
    monkeypatch.setattr(
        app_module,
        "get_settings",
        lambda: Settings(
            data_dir=real_settings.data_dir,
            logs_dir=blocked_logs,
        ),
    )
    r_unwritable = client.get("/api/health/ready")
    assert r_unwritable.status_code == 503
    assert r_unwritable.json()["checks"]["logs_writable"] is False


def test_nis2_supply_chain_register_avant_apres_and_quarantine() -> None:
    headers = {"X-Session-Id": "supply-chain-art21-session"}
    try:
        # 1. Avant tout audit : registre disponible (has_synthesis=False)
        r_init = client.get("/api/nis2/supply-chain", headers=headers)
        assert r_init.status_code == 200
        init_body = r_init.json()
        assert init_body["has_synthesis"] is False
        assert "Art. 21" in init_body["article"]
        assert init_body["source"] == "server"
        assert init_body["vendors"] == []
        assert init_body["summary_counts"]["total"] == 0

        # 2. Chargement démo + Audit AVANT : SUP-001 (MedTech) CRITIQUE & en quarantaine, SUP-002 ÉLEVÉ
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "AVANT", "use_cache": True},
            ).status_code
            == 200
        )
        r_avant = client.get("/api/nis2/supply-chain?mode=AVANT", headers=headers)
        assert r_avant.status_code == 200
        avant_body = r_avant.json()
        assert avant_body["has_synthesis"] is True
        assert avant_body["mode"] == "AVANT"
        assert avant_body["overall_risk"] == "CRITIQUE"
        assert avant_body["quarantined_docs_count"] >= 1

        by_id_avant = {v["id"]: v for v in avant_body["vendors"]}
        assert "SUP-001" in by_id_avant
        assert "SUP-002" in by_id_avant
        assert "SUP-003" in by_id_avant

        sup1 = by_id_avant["SUP-001"]
        assert sup1["risk_level"] == "CRITIQUE"
        assert sup1["quarantined"] is True
        assert sup1["source_document"] == "annexe_fournisseur_maintenance.md"
        assert sup1["quarantine_reason"]
        assert len(sup1["recommended_clauses"]) >= 2

        sup2_avant = by_id_avant["SUP-002"]
        assert sup2_avant["risk_level"] == "ÉLEVÉ"
        assert "F-002" in sup2_avant["finding_ids"]

        counts_av = avant_body["summary_counts"]
        assert counts_av["total"] == len(avant_body["vendors"])
        assert (
            counts_av["critique"]
            + counts_av["eleve"]
            + counts_av["modere"]
            + counts_av["maitrise"]
            == counts_av["total"]
        )

        # 3. Audit APRES : compromission prestataire (F-004) fait basculer SUP-002 en CRITIQUE
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        r_apres = client.get("/api/nis2/supply-chain?mode=APRES", headers=headers)
        assert r_apres.status_code == 200
        apres_body = r_apres.json()
        assert apres_body["mode"] == "APRES"
        by_id_apres = {v["id"]: v for v in apres_body["vendors"]}
        sup2_apres = by_id_apres["SUP-002"]
        assert sup2_apres["risk_level"] == "CRITIQUE"
        assert "F-004" in sup2_apres["finding_ids"]
        assert apres_body["summary_counts"]["critique"] >= 2
    finally:
        client.delete("/api/sessions/supply-chain-art21-session")


def test_export_terraform_gitops_gate_hcl_bundle_v3_and_retrocompat_v1_v2(
    monkeypatch, tmp_path: Path
) -> None:
    import os

    import triad.api.app as app_module
    from triad.config import Settings

    secret = "iter14-gitops-signing-secret-key-2026"
    real_settings = app_module.get_settings()
    monkeypatch.setattr(
        app_module,
        "get_settings",
        lambda: Settings(
            data_dir=real_settings.data_dir,
            logs_dir=real_settings.logs_dir,
            audit_signing_secret=secret,
        ),
    )

    headers = {"X-Session-Id": "terraform-gitops-v3-session"}
    verify_bundle_script = Path(__file__).resolve().parent.parent / "scripts" / "verify_bundle.sh"
    verify_snap_script = Path(__file__).resolve().parent.parent / "scripts" / "verify_snapshot.sh"

    try:
        # 1. Verrou 403 strict avant chargement et avant approbation humaine
        assert client.get("/api/export/terraform", headers=headers).status_code == 403
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        assert client.get("/api/export/terraform?mode=APRES", headers=headers).status_code == 403

        # 2. Approbation humaine -> HTTP 200 avec HCL déclaratif signé
        assert client.post("/api/validate?mode=APRES", headers=headers).status_code == 200
        tf_res = client.get("/api/export/terraform?mode=APRES", headers=headers)
        assert tf_res.status_code == 200
        assert "text/plain" in (tf_res.headers.get("content-type") or "")
        assert "TRIAD_Remediation_GitOps_APRES.tf" in (
            tf_res.headers.get("content-disposition") or ""
        )
        expected_tf_sig = (
            "hmac-sha256="
            + hmac.new(secret.encode("utf-8"), tf_res.content, hashlib.sha256).hexdigest()
        )
        assert tf_res.headers.get("x-triad-signature") == expected_tf_sig

        hcl = tf_res.text
        # Avertissement d'innocuité (jamais exécuté automatiquement)
        assert "terraform plan" in hcl
        assert "JAMAIS" in hcl.upper()
        # Blocs déclaratifs couvrant les écarts GCP critiques
        assert 'public_access_prevention    = "enforced"' in hcl
        assert "35.235.240.0/20" in hcl
        assert "retention_period = 2592000" in hcl
        assert "is_locked        = true" in hcl
        assert 'rotation_period = "7776000s"' in hcl
        assert "retention_days = 365" in hcl
        # Syntaxe HCL structurellement équilibrée (accolades ouvrantes == fermantes)
        assert hcl.count("{") == hcl.count("}")
        assert hcl.count("{") >= 12

        # 3. Bundle v3 (9 pièces avec 09_Remediation_GitOps.tf) + rétrocompatibilité v2 (8 pièces) & v1 (6 pièces)
        bundle_v3_bytes = client.get("/api/export/bundle?mode=APRES", headers=headers).content
        v3_path = tmp_path / "bundle_v3.zip"
        v3_path.write_bytes(bundle_v3_bytes)

        env_with_secret = {**os.environ, "AUDIT_SIGNING_SECRET": secret}
        chk_v3 = subprocess.run(
            ["bash", str(verify_bundle_script), str(v3_path)],
            env=env_with_secret,
            capture_output=True,
            text=True,
        )
        assert chk_v3.returncode == 0, chk_v3.stdout + chk_v3.stderr

        # Construction d'une archive v2 (8 pièces, sans 09_Remediation_GitOps.tf) et vérification API + CLI
        v2_files = (
            "01_Rapport_NIS2.md",
            "02_Matrice_GRC.csv",
            "03_Synthese_Scellee.json",
            "04_Playbook_DryRun.sh",
            "05_Mail_DSI.txt",
            "06_Audit_Chain.jsonl",
            "07_PreNotification_ANSSI_Art23.md",
            "08_Brief_COMEX_Art20.md",
        )
        legacy_v2_buf = io.BytesIO()
        with (
            zipfile.ZipFile(io.BytesIO(bundle_v3_bytes), "r") as zf_in,
            zipfile.ZipFile(legacy_v2_buf, "w", compression=zipfile.ZIP_DEFLATED) as zf_v2,
        ):
            v2_manifest_lines: list[str] = []
            for fname in v2_files:
                fdata = zf_in.read(fname)
                zf_v2.writestr(fname, fdata)
                v2_manifest_lines.append(f"{hashlib.sha256(fdata).hexdigest()}  {fname}")
            zf_v2.writestr(
                "MANIFEST_SHA256.txt",
                ("\n".join(v2_manifest_lines) + "\n").encode("utf-8"),
            )

        v2_bytes = legacy_v2_buf.getvalue()
        v2_path = tmp_path / "legacy_v2.zip"
        v2_path.write_bytes(v2_bytes)
        chk_v2 = subprocess.run(
            ["bash", str(verify_bundle_script), str(v2_path)],
            capture_output=True,
            text=True,
        )
        assert chk_v2.returncode == 0, chk_v2.stdout + chk_v2.stderr

        cert_v2 = client.post(
            "/api/verify/bundle",
            headers=headers,
            files={"file": ("legacy_v2.zip", v2_bytes, "application/zip")},
        ).json()
        assert cert_v2["authentic"] is True
        assert cert_v2["bundle_version"] == "v2"
        assert len(cert_v2["files_checked"]) == 8

        # 4. Vérification forensique hors-ligne du snapshot signé via scripts/verify_snapshot.sh
        snap_res = client.get(
            "/api/sessions/terraform-gitops-v3-session/snapshot", headers=headers
        )
        assert snap_res.status_code == 200
        snap_sig = snap_res.headers.get("x-triad-signature") or ""
        assert snap_sig.startswith("hmac-sha256=")
        snap_path = tmp_path / "TRIAD_Session_Snapshot_v3.json"
        snap_path.write_bytes(snap_res.content)

        chk_snap = subprocess.run(
            [
                "bash",
                str(verify_snap_script),
                str(snap_path),
                "--signature",
                snap_sig,
                "--secret",
                secret,
            ],
            capture_output=True,
            text=True,
        )
        assert chk_snap.returncode == 0, chk_snap.stdout + chk_snap.stderr

        # 5. Re-verrouillage automatique 403 après modification d'une décision GRC
        assert (
            client.patch(
                "/api/findings/F-002/decision",
                headers=headers,
                json={
                    "mode": "APRES",
                    "decision": "mesure_compensatoire",
                    "porteur": "Équipe Infra SecOps",
                },
            ).status_code
            == 200
        )
        assert client.get("/api/export/terraform?mode=APRES", headers=headers).status_code == 403
    finally:
        client.delete("/api/sessions/terraform-gitops-v3-session")


def test_security_posture_endpoint_barriers_and_hmac_toggle(monkeypatch) -> None:
    import triad.api.app as app_module
    from triad.config import Settings

    headers = {"X-Session-Id": "sec-posture-check-session"}
    real_settings = app_module.get_settings()
    try:
        # 1. Par défaut (sans clé HMAC) : posture opérationnelle, 9 exports verrouillés, hmac_signing_enabled=False
        monkeypatch.setattr(
            app_module,
            "get_settings",
            lambda: Settings(
                data_dir=real_settings.data_dir,
                logs_dir=real_settings.logs_dir,
                audit_signing_secret="",
            ),
        )
        r_unsigned = client.get("/api/security/posture", headers=headers)
        assert r_unsigned.status_code == 200
        p_unsigned = r_unsigned.json()
        assert p_unsigned["gcp_read_only"] is True
        assert p_unsigned["locked_exports_count"] == 12
        assert p_unsigned["audit_chain_valid"] is True
        assert p_unsigned["hmac_signing_enabled"] is False
        assert p_unsigned["rate_limiter_enabled"] is True
        assert p_unsigned["csp_strict"] is True
        assert p_unsigned["prompt_injection_quarantine"] is True
        assert p_unsigned["dlp_pii_redaction"] is True
        assert p_unsigned["max_upload_mb"] == 10
        assert len(p_unsigned["barriers"]) == 9

        # 2. Avec AUDIT_SIGNING_SECRET configuré : hmac_signing_enabled=True sans jamais exposer le secret
        secret_val = "super-confidential-hmac-secret-do-not-leak"
        monkeypatch.setattr(
            app_module,
            "get_settings",
            lambda: Settings(
                data_dir=real_settings.data_dir,
                logs_dir=real_settings.logs_dir,
                audit_signing_secret=secret_val,
            ),
        )
        r_signed = client.get("/api/security/posture", headers=headers)
        assert r_signed.status_code == 200
        p_signed = r_signed.json()
        assert p_signed["status"] == "OPÉRATIONNEL"
        assert p_signed["hmac_signing_enabled"] is True
        assert secret_val not in r_signed.text
        hmac_barrier = next(b for b in p_signed["barriers"] if b["id"] == "hmac_seal")
        assert hmac_barrier["active"] is True
        assert p_signed["locked_exports_count"] == 12
    finally:
        client.delete("/api/sessions/sec-posture-check-session")


def test_export_interview_guide_gate_avant_apres_bundle_v4_and_retrocompat_v1_v2_v3(
    monkeypatch, tmp_path: Path
) -> None:
    import os

    import triad.api.app as app_module
    from triad.config import Settings

    secret = "iter15-interview-guide-hmac-secret-2026"
    real_settings = app_module.get_settings()
    monkeypatch.setattr(
        app_module,
        "get_settings",
        lambda: Settings(
            data_dir=real_settings.data_dir,
            logs_dir=real_settings.logs_dir,
            audit_signing_secret=secret,
        ),
    )

    headers = {"X-Session-Id": "interview-guide-v4-session"}
    verify_bundle_script = Path(__file__).resolve().parent.parent / "scripts" / "verify_bundle.sh"

    try:
        # 1. Verrou humain HTTP 403 strict avant chargement et avant validation (10e verrou)
        assert client.get("/api/export/interview-guide", headers=headers).status_code == 403
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "AVANT", "use_cache": True},
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        assert (
            client.get("/api/export/interview-guide?mode=AVANT", headers=headers).status_code
            == 403
        )
        assert (
            client.get("/api/export/interview-guide?mode=APRES", headers=headers).status_code
            == 403
        )

        # 2. Validation AVANT uniquement : AVANT passe en 200, APRES reste verrouillé 403
        assert client.post("/api/validate?mode=AVANT", headers=headers).status_code == 200
        assert (
            client.get("/api/export/interview-guide?mode=APRES", headers=headers).status_code
            == 403
        )

        res_avant = client.get("/api/export/interview-guide?mode=AVANT", headers=headers)
        assert res_avant.status_code == 200
        assert "text/markdown" in (res_avant.headers.get("content-type") or "")
        assert "TRIAD_Guide_Entretien_Contradictoire_AVANT.md" in (
            res_avant.headers.get("content-disposition") or ""
        )
        expected_sig_av = (
            "hmac-sha256="
            + hmac.new(secret.encode("utf-8"), res_avant.content, hashlib.sha256).hexdigest()
        )
        assert res_avant.headers.get("x-triad-signature") == expected_sig_av

        md_avant = res_avant.text
        assert "AVANT ENTRETIEN" in md_avant
        assert "Écrit ≠ Réel" in md_avant
        for role_label in ("DSI", "Admin Cloud", "RSSI / DPO", "Achats / Juridique"):
            assert role_label in md_avant
        assert "MedTech Solutions SAS" in md_avant
        assert "annexe_fournisseur_maintenance.md" in md_avant
        assert "Preuves attendues en séance" in md_avant
        for fid in ("F-001", "F-002", "F-003", "F-005", "F-006", "F-007"):
            assert fid in md_avant

        # 3. Validation APRES : différenciation post-entretien (F-004 compromission prestataire septembre)
        assert client.post("/api/validate?mode=APRES", headers=headers).status_code == 200
        res_apres = client.get("/api/export/interview-guide?mode=APRES", headers=headers)
        assert res_apres.status_code == 200
        assert "TRIAD_Guide_Entretien_Contradictoire_APRES.md" in (
            res_apres.headers.get("content-disposition") or ""
        )
        md_apres = res_apres.text
        assert "APRÈS ENTRETIEN" in md_apres
        assert "F-004" in md_apres
        assert "petit incident géré en interne" in md_apres
        status_ap = client.get("/api/status?mode=APRES", headers=headers).json()
        assert status_ap["audit_log"][-1]["hash"] in md_apres

        # 4. Bundle v4 (10 pièces avec 10_Guide_Entretien_Contradictoire.md) + rétrocompatibilité v1 / v2 / v3 / v4
        bundle_v4_bytes = client.get("/api/export/bundle?mode=APRES", headers=headers).content
        v4_path = tmp_path / "bundle_v4.zip"
        v4_path.write_bytes(bundle_v4_bytes)
        env_with_secret = {**os.environ, "AUDIT_SIGNING_SECRET": secret}

        chk_v4 = subprocess.run(
            ["bash", str(verify_bundle_script), str(v4_path)],
            env=env_with_secret,
            capture_output=True,
            text=True,
        )
        assert chk_v4.returncode == 0, chk_v4.stdout + chk_v4.stderr

        cert_v4 = client.post(
            "/api/verify/bundle",
            headers=headers,
            files={"file": ("bundle_v4.zip", bundle_v4_bytes, "application/zip")},
        ).json()
        assert cert_v4["authentic"] is True
        assert cert_v4["bundle_version"] == "v6"
        assert cert_v4["signature_status"] == "VERIFIED"
        assert len(cert_v4["files_checked"]) == 12

        # Test rétrocompatibilité complète sur archives v1 (6), v2 (8) et v3 (9 pièces)
        version_matrix = {
            "v1": (
                "01_Rapport_NIS2.md",
                "02_Matrice_GRC.csv",
                "03_Synthese_Scellee.json",
                "04_Playbook_DryRun.sh",
                "05_Mail_DSI.txt",
                "06_Audit_Chain.jsonl",
            ),
            "v2": (
                "01_Rapport_NIS2.md",
                "02_Matrice_GRC.csv",
                "03_Synthese_Scellee.json",
                "04_Playbook_DryRun.sh",
                "05_Mail_DSI.txt",
                "06_Audit_Chain.jsonl",
                "07_PreNotification_ANSSI_Art23.md",
                "08_Brief_COMEX_Art20.md",
            ),
            "v3": (
                "01_Rapport_NIS2.md",
                "02_Matrice_GRC.csv",
                "03_Synthese_Scellee.json",
                "04_Playbook_DryRun.sh",
                "05_Mail_DSI.txt",
                "06_Audit_Chain.jsonl",
                "07_PreNotification_ANSSI_Art23.md",
                "08_Brief_COMEX_Art20.md",
                "09_Remediation_GitOps.tf",
            ),
        }
        for ver_label, ver_files in version_matrix.items():
            buf = io.BytesIO()
            with (
                zipfile.ZipFile(io.BytesIO(bundle_v4_bytes), "r") as zf_in,
                zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf_out,
            ):
                m_lines: list[str] = []
                for fname in ver_files:
                    fdata = zf_in.read(fname)
                    zf_out.writestr(fname, fdata)
                    m_lines.append(f"{hashlib.sha256(fdata).hexdigest()}  {fname}")
                zf_out.writestr(
                    "MANIFEST_SHA256.txt", ("\n".join(m_lines) + "\n").encode("utf-8")
                )
            ver_bytes = buf.getvalue()
            ver_path = tmp_path / f"retro_{ver_label}.zip"
            ver_path.write_bytes(ver_bytes)
            chk_cli = subprocess.run(
                ["bash", str(verify_bundle_script), str(ver_path)],
                capture_output=True,
                text=True,
            )
            assert chk_cli.returncode == 0, f"{ver_label}: {chk_cli.stdout}{chk_cli.stderr}"

            cert_retro = client.post(
                "/api/verify/bundle",
                headers=headers,
                files={"file": (f"retro_{ver_label}.zip", ver_bytes, "application/zip")},
            ).json()
            assert cert_retro["authentic"] is True, ver_label
            assert cert_retro["bundle_version"] == ver_label
            assert len(cert_retro["files_checked"]) == len(ver_files)

        # 5. Re-verrouillage automatique 403 sur modification d'arbitrage GRC + injection après re-validation
        assert (
            client.patch(
                "/api/findings/F-006/decision",
                headers=headers,
                json={
                    "mode": "APRES",
                    "decision": "a_corriger",
                    "porteur": "Achats & Admin Cloud",
                    "echeance": "J+15",
                    "commentaire": "Révocation clé 248j MedTech en séance",
                },
            ).status_code
            == 200
        )
        assert (
            client.get("/api/export/interview-guide?mode=APRES", headers=headers).status_code
            == 403
        )
        assert client.post("/api/validate?mode=APRES", headers=headers).status_code == 200
        revalidated_md = client.get(
            "/api/export/interview-guide?mode=APRES", headers=headers
        ).text
        assert "Révocation clé 248j MedTech en séance" in revalidated_md
    finally:
        client.delete("/api/sessions/interview-guide-v4-session")


def test_audit_log_multi_criteria_filtering_preserves_full_chain_integrity() -> None:
    headers = {"X-Session-Id": "audit-log-filter-session"}
    try:
        # 1. Session vierge : 0 entrée, chaîne valide
        r_empty = client.get("/api/audit/log", headers=headers)
        assert r_empty.status_code == 200
        empty_body = r_empty.json()
        assert empty_body["chain_valid"] is True
        assert empty_body["total_entries"] == 0
        assert empty_body["filtered_count"] == 0
        assert empty_body["entries"] == []

        # 2. Exécution AVANT + APRES + validation + violation simulée pour peupler agents, actions et modes
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "AVANT", "use_cache": True},
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        assert client.post("/api/validate?mode=APRES", headers=headers).status_code == 200
        assert client.post("/api/security/simulate-violation", headers=headers).status_code == 200

        # 3. Lecture complète non filtrée : parité exacte avec /api/status et facettes peuplées
        status_body = client.get("/api/status?mode=APRES", headers=headers).json()
        all_res = client.get("/api/audit/log", headers=headers)
        assert all_res.status_code == 200
        all_body = all_res.json()
        assert all_body["chain_valid"] is True
        assert all_body["chain"]["valide"] is True
        total = all_body["total_entries"]
        assert total == len(status_body["audit_log"])
        assert total >= 12
        assert all_body["filtered_count"] == total
        assert all_body["entries"] == status_body["audit_log"]
        assert "Douanier" in all_body["available_agents"]
        assert "ConsultantDeloitte" in all_body["available_agents"]
        assert "QUARANTINE" in all_body["available_actions"]
        assert "HUMAN_VALIDATION" in all_body["available_actions"]
        assert "VIOLATION" in all_body["available_actions"]
        assert all_body["available_modes"] == ["AVANT", "APRES"]

        # 4. Filtre par agent=Douanier : sous-ensemble strict mais chain_valid reste True sur la chaîne complète
        by_agent = client.get("/api/audit/log?agent=Douanier", headers=headers).json()
        assert by_agent["chain_valid"] is True
        assert by_agent["total_entries"] == total
        assert 0 < by_agent["filtered_count"] < total
        assert all(e["agent"] == "Douanier" for e in by_agent["entries"])
        assert "ConsultantDeloitte" in by_agent["available_agents"]

        # 5. Filtre combiné agent=Douanier & action=QUARANTINE & mode=APRES
        by_combo = client.get(
            "/api/audit/log?agent=Douanier&action=QUARANTINE&mode=APRES",
            headers=headers,
        ).json()
        assert by_combo["chain_valid"] is True
        assert by_combo["filtered_count"] == 1
        q_entry = by_combo["entries"][0]
        assert q_entry["agent"] == "Douanier"
        assert q_entry["action"] == "QUARANTINE"
        assert q_entry["mode"] == "APRES"

        # 6. Recherche q= sur détail documentaire, préfixe hash et préfixe prev_hash
        by_detail = client.get(
            "/api/audit/log?q=annexe_fournisseur_maintenance", headers=headers
        ).json()
        assert by_detail["chain_valid"] is True
        assert by_detail["filtered_count"] >= 2

        hash_prefix = q_entry["hash"][:16]
        by_hash = client.get(f"/api/audit/log?q={hash_prefix}", headers=headers).json()
        assert by_hash["chain_valid"] is True
        assert any(e["hash"] == q_entry["hash"] for e in by_hash["entries"])

        prev_prefix = q_entry["prev_hash"][:16]
        by_prev = client.get(f"/api/audit/log?q={prev_prefix}", headers=headers).json()
        assert by_prev["chain_valid"] is True
        assert any(e["prev_hash"] == q_entry["prev_hash"] for e in by_prev["entries"])

        # 7. Recherche q= sans résultat : filtered_count == 0 mais chain_valid == True et facettes conservées
        no_hit = client.get("/api/audit/log?q=introuvable_xyz_999", headers=headers).json()
        assert no_hit["chain_valid"] is True
        assert no_hit["total_entries"] == total
        assert no_hit["filtered_count"] == 0
        assert no_hit["entries"] == []
        assert "Douanier" in no_hit["available_agents"]
    finally:
        client.delete("/api/sessions/audit-log-filter-session")


def test_nis2_continuity_dashboard_preaudit_avant_and_apres() -> None:
    headers = {"X-Session-Id": "nis2-continuity-art21c-session"}
    try:
        # 1. État pré-audit : has_synthesis=False, 0 processus
        r_pre = client.get("/api/nis2/continuity", headers=headers)
        assert r_pre.status_code == 200
        pre = r_pre.json()
        assert pre["has_synthesis"] is False
        assert "Art. 21" in pre["article"]
        assert pre["source"] == "server"
        assert pre["processes"] == []
        assert pre["summary_counts"]["total"] == 0
        assert pre["ransomware_readiness"] == "IMMUTABLE"

        # 2. Chargement démo + Audit AVANT : DPI EXPOSÉ/CRITIQUE, PACS IMMUTABLE/MODÉRÉ, Messagerie ÉLEVÉ
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "AVANT", "use_cache": True},
            ).status_code
            == 200
        )
        r_av = client.get("/api/nis2/continuity?mode=AVANT", headers=headers)
        assert r_av.status_code == 200
        av = r_av.json()
        assert av["has_synthesis"] is True
        assert av["mode"] == "AVANT"
        assert av["overall_exposure"] == "CRITIQUE"
        assert av["ransomware_readiness"] == "EXPOSÉ"
        assert av["summary_counts"]["total"] == 3
        assert av["summary_counts"]["immutable"] == 1
        assert av["summary_counts"]["expose"] == 2
        assert av["summary_counts"]["rto_rpo_gaps"] == 3

        by_name_av = {p["name"]: p for p in av["processes"]}
        assert set(by_name_av.keys()) == {
            "DPI Patients",
            "Imagerie PACS / DICOM",
            "Messagerie & Postes Administratifs",
        }

        dpi_av = by_name_av["DPI Patients"]
        assert dpi_av["ransomware_status"] == "EXPOSÉ"
        assert dpi_av["exposure_level"] == "CRITIQUE"
        assert dpi_av["rto_gap"] is True
        assert dpi_av["rpo_gap"] is True
        assert "F-003" in dpi_av["finding_ids"]
        assert len(dpi_av["pra_actions"]) >= 2

        pacs_av = by_name_av["Imagerie PACS / DICOM"]
        assert pacs_av["ransomware_status"] == "IMMUTABLE"
        assert pacs_av["exposure_level"] == "MODÉRÉ"
        assert pacs_av["rto_gap"] is True
        assert pacs_av["rpo_gap"] is False
        assert "F-005" in pacs_av["finding_ids"]

        msg_av = by_name_av["Messagerie & Postes Administratifs"]
        assert msg_av["ransomware_status"] == "EXPOSÉ"
        assert msg_av["exposure_level"] == "ÉLEVÉ"

        # 3. Audit APRES : l'indisponibilité messagerie de septembre (F-004) fait passer Messagerie en CRITIQUE
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        r_ap = client.get("/api/nis2/continuity?mode=APRES", headers=headers)
        assert r_ap.status_code == 200
        ap = r_ap.json()
        assert ap["mode"] == "APRES"
        by_name_ap = {p["name"]: p for p in ap["processes"]}
        msg_ap = by_name_ap["Messagerie & Postes Administratifs"]
        assert msg_ap["exposure_level"] == "CRITIQUE"
        assert "F-004" in msg_ap["finding_ids"]
        assert ap["summary_counts"]["critique"] == 2
    finally:
        client.delete("/api/sessions/nis2-continuity-art21c-session")


def test_export_risk_register_grc_gate_decisions_bundle_v5_and_retrocompat_v1_to_v5(
    monkeypatch, tmp_path: Path
) -> None:
    import os

    import triad.api.app as app_module
    from triad.config import Settings

    secret = "iter16-risk-register-hmac-secret-2026"
    real_settings = app_module.get_settings()
    monkeypatch.setattr(
        app_module,
        "get_settings",
        lambda: Settings(
            data_dir=real_settings.data_dir,
            logs_dir=real_settings.logs_dir,
            audit_signing_secret=secret,
        ),
    )

    headers = {"X-Session-Id": "risk-register-v5-session"}
    verify_bundle_script = Path(__file__).resolve().parent.parent / "scripts" / "verify_bundle.sh"

    try:
        # 1. 11e verrou humain HTTP 403 strict avant chargement et avant approbation
        assert client.get("/api/export/risk-register", headers=headers).status_code == 403
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        assert (
            client.get("/api/export/risk-register?mode=APRES", headers=headers).status_code == 403
        )

        # 2. Saisie des 4 types d'arbitrages GRC opposables au Comité d'Audit
        grc_inputs = [
            (
                "F-001",
                "a_corriger",
                "Admin Cloud GCP",
                "J+7",
                "Révocation immédiate de allUsers sur export-radiologie",
            ),
            (
                "F-002",
                "mesure_compensatoire",
                "Équipe Réseau & Bastion",
                "J+15",
                "Filtrage transitoire Cloud Armor + restriction IP VPN",
            ),
            (
                "F-007",
                "risque_accepte",
                "Direction Générale & RSSI",
                "Revue 90 j",
                "Dérogation temporaire le temps de valider le budget stockage logs 365j",
            ),
            (
                "F-004",
                "a_approfondir",
                "RSSI & Cellule Juridique",
                "J+10",
                "Qualification juridique rétrospective de l'incident de septembre",
            ),
        ]
        for fid, dec_code, porteur, echeance, comment in grc_inputs:
            r_dec = client.patch(
                f"/api/findings/{fid}/decision",
                headers=headers,
                json={
                    "mode": "APRES",
                    "decision": dec_code,
                    "porteur": porteur,
                    "echeance": echeance,
                    "commentaire": comment,
                },
            )
            assert r_dec.status_code == 200

        # Toujours verrouillé tant que le consultant n'a pas approuvé
        assert (
            client.get("/api/export/risk-register?mode=APRES", headers=headers).status_code == 403
        )
        assert client.post("/api/validate?mode=APRES", headers=headers).status_code == 200

        # 3. Export HTTP 200 signé du Registre GRC (.md)
        reg_res = client.get("/api/export/risk-register?mode=APRES", headers=headers)
        assert reg_res.status_code == 200
        assert "text/markdown" in (reg_res.headers.get("content-type") or "")
        assert "TRIAD_Registre_Arbitrages_GRC_APRES.md" in (
            reg_res.headers.get("content-disposition") or ""
        )
        expected_sig = (
            "hmac-sha256="
            + hmac.new(secret.encode("utf-8"), reg_res.content, hashlib.sha256).hexdigest()
        )
        assert reg_res.headers.get("x-triad-signature") == expected_sig

        reg_md = reg_res.text
        assert "Article 20" in reg_md
        for expected_txt in (
            "À corriger",
            "Mesure compensatoire",
            "Risque accepté",
            "À approfondir",
            "Admin Cloud GCP",
            "Dérogation temporaire le temps de valider le budget stockage logs 365j",
            "Qualification juridique rétrospective de l'incident de septembre",
        ):
            assert expected_txt in reg_md
        head_hash = client.get("/api/status?mode=APRES", headers=headers).json()["audit_log"][-1][
            "hash"
        ]
        assert head_hash in reg_md

        # 4. Bundle v5 (11 pièces) + rétrocompatibilité intégrale v1 (6), v2 (8), v3 (9), v4 (10) et v5 (11)
        bundle_v5_bytes = client.get("/api/export/bundle?mode=APRES", headers=headers).content
        v5_path = tmp_path / "bundle_v5.zip"
        v5_path.write_bytes(bundle_v5_bytes)
        env_with_secret = {**os.environ, "AUDIT_SIGNING_SECRET": secret}

        chk_v5 = subprocess.run(
            ["bash", str(verify_bundle_script), str(v5_path)],
            env=env_with_secret,
            capture_output=True,
            text=True,
        )
        assert chk_v5.returncode == 0, chk_v5.stdout + chk_v5.stderr

        cert_v5 = client.post(
            "/api/verify/bundle",
            headers=headers,
            files={"file": ("bundle_v5.zip", bundle_v5_bytes, "application/zip")},
        ).json()
        assert cert_v5["authentic"] is True
        assert cert_v5["bundle_version"] == "v6"
        assert cert_v5["signature_status"] == "VERIFIED"
        assert len(cert_v5["files_checked"]) == 12

        all_10_v4 = (
            "01_Rapport_NIS2.md",
            "02_Matrice_GRC.csv",
            "03_Synthese_Scellee.json",
            "04_Playbook_DryRun.sh",
            "05_Mail_DSI.txt",
            "06_Audit_Chain.jsonl",
            "07_PreNotification_ANSSI_Art23.md",
            "08_Brief_COMEX_Art20.md",
            "09_Remediation_GitOps.tf",
            "10_Guide_Entretien_Contradictoire.md",
        )
        retro_matrix = {
            "v1": all_10_v4[:6],
            "v2": all_10_v4[:8],
            "v3": all_10_v4[:9],
            "v4": all_10_v4[:10],
        }
        for ver_label, ver_files in retro_matrix.items():
            buf = io.BytesIO()
            with (
                zipfile.ZipFile(io.BytesIO(bundle_v5_bytes), "r") as zf_in,
                zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf_out,
            ):
                m_lines: list[str] = []
                for fname in ver_files:
                    fdata = zf_in.read(fname)
                    zf_out.writestr(fname, fdata)
                    m_lines.append(f"{hashlib.sha256(fdata).hexdigest()}  {fname}")
                zf_out.writestr(
                    "MANIFEST_SHA256.txt", ("\n".join(m_lines) + "\n").encode("utf-8")
                )
            ver_bytes = buf.getvalue()
            ver_path = tmp_path / f"retro_iter16_{ver_label}.zip"
            ver_path.write_bytes(ver_bytes)
            chk_cli = subprocess.run(
                ["bash", str(verify_bundle_script), str(ver_path)],
                capture_output=True,
                text=True,
            )
            assert chk_cli.returncode == 0, f"{ver_label}: {chk_cli.stdout}{chk_cli.stderr}"

            cert_retro = client.post(
                "/api/verify/bundle",
                headers=headers,
                files={"file": (f"retro_iter16_{ver_label}.zip", ver_bytes, "application/zip")},
            ).json()
            assert cert_retro["authentic"] is True, ver_label
            assert cert_retro["bundle_version"] == ver_label
            assert len(cert_retro["files_checked"]) == len(ver_files)

        # 5. Re-verrouillage automatique 403 après nouvel arbitrage GRC
        assert (
            client.patch(
                "/api/findings/F-003/decision",
                headers=headers,
                json={"mode": "APRES", "decision": "a_corriger", "porteur": "Infra Backup"},
            ).status_code
            == 200
        )
        assert (
            client.get("/api/export/risk-register?mode=APRES", headers=headers).status_code == 403
        )
    finally:
        client.delete("/api/sessions/risk-register-v5-session")


def test_nis2_crosswalk_multi_framework_preaudit_avant_and_apres() -> None:
    headers = {"X-Session-Id": "nis2-crosswalk-hds-rgpd-session"}
    try:
        # 1. État pré-audit propre : has_synthesis=False, 0 entrée, 3 référentiels initialisés
        r_pre = client.get("/api/nis2/crosswalk", headers=headers)
        assert r_pre.status_code == 200
        pre = r_pre.json()
        assert pre["has_synthesis"] is False
        assert pre["source"] == "server"
        assert pre["entries"] == []
        assert pre["summary_counts"]["total"] == 0
        assert set(pre["frameworks_summary"].keys()) == {"HDS", "ISO27001", "RGPD"}
        for fw_key in ("HDS", "ISO27001", "RGPD"):
            assert pre["frameworks_summary"][fw_key]["total_controls"] == 0
            assert pre["frameworks_summary"][fw_key]["conformity_pct"] == 0

        # 2. Chargement démo + Audit AVANT : CW-008 en a_confirmer (aucun incident oral déclaré)
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "AVANT", "use_cache": True},
            ).status_code
            == 200
        )
        r_av = client.get("/api/nis2/crosswalk?mode=AVANT", headers=headers)
        assert r_av.status_code == 200
        av = r_av.json()
        assert av["has_synthesis"] is True
        assert av["mode"] == "AVANT"
        assert av["summary_counts"]["total"] == 8
        assert av["summary_counts"]["conforme"] == 1
        assert av["summary_counts"]["a_confirmer"] == 1

        by_id_av = {e["id"]: e for e in av["entries"]}
        assert by_id_av["CW-001"]["statut"] == "non_conforme"
        assert by_id_av["CW-001"]["cnil_applicable"] is True
        assert "F-001" in by_id_av["CW-001"]["finding_ids"]
        assert by_id_av["CW-004"]["statut"] == "conforme"
        assert "F-005" in by_id_av["CW-004"]["finding_ids"]
        assert by_id_av["CW-008"]["statut"] == "a_confirmer"
        assert by_id_av["CW-008"]["finding_ids"] == []

        for fw_key in ("HDS", "ISO27001", "RGPD"):
            fw_av = av["frameworks_summary"][fw_key]
            assert fw_av["total_controls"] >= 6
            assert fw_av["compliant_count"] == 1
            assert fw_av["gap_count"] >= 4
            assert 0 < fw_av["conformity_pct"] < 100

        # 3. Audit APRES : la compromission de septembre (F-004) fait basculer CW-008 en non_conforme et dégrade RGPD / ISO27001
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        r_ap = client.get("/api/nis2/crosswalk?mode=APRES", headers=headers)
        assert r_ap.status_code == 200
        ap = r_ap.json()
        assert ap["has_synthesis"] is True
        assert ap["mode"] == "APRES"
        by_id_ap = {e["id"]: e for e in ap["entries"]}
        assert by_id_ap["CW-008"]["statut"] == "non_conforme"
        assert by_id_ap["CW-008"]["gravite"] == "haute"
        assert by_id_ap["CW-008"]["cnil_applicable"] is True
        assert "F-004" in by_id_ap["CW-008"]["finding_ids"]
        assert ap["summary_counts"]["non_conforme"] == av["summary_counts"]["non_conforme"] + 1
        assert (
            ap["frameworks_summary"]["RGPD"]["gap_count"]
            == av["frameworks_summary"]["RGPD"]["gap_count"] + 1
        )
        assert (
            ap["frameworks_summary"]["RGPD"]["conformity_pct"]
            < av["frameworks_summary"]["RGPD"]["conformity_pct"]
        )
    finally:
        client.delete("/api/sessions/nis2-crosswalk-hds-rgpd-session")


def test_export_cnil_draft_art33_art34_gate_bundle_v6_and_retrocompat_v1_to_v6(
    monkeypatch, tmp_path: Path
) -> None:
    import os

    import triad.api.app as app_module
    from triad.config import Settings

    secret = "iter17-cnil-art33-hmac-secret-2026"
    real_settings = app_module.get_settings()
    monkeypatch.setattr(
        app_module,
        "get_settings",
        lambda: Settings(
            data_dir=real_settings.data_dir,
            logs_dir=real_settings.logs_dir,
            audit_signing_secret=secret,
        ),
    )

    headers = {"X-Session-Id": "cnil-art33-v6-session"}
    verify_bundle_script = Path(__file__).resolve().parent.parent / "scripts" / "verify_bundle.sh"

    try:
        # 1. 12e verrou humain HTTP 403 strict avant chargement et avant approbation humaine
        assert client.get("/api/export/cnil-draft", headers=headers).status_code == 403
        assert client.post("/api/demo/load", headers=headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "AVANT", "use_cache": True},
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/audit/run",
                headers=headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        assert client.get("/api/export/cnil-draft?mode=AVANT", headers=headers).status_code == 403
        assert client.get("/api/export/cnil-draft?mode=APRES", headers=headers).status_code == 403

        # 2. Arbitrage GRC DPO + validation AVANT et APRES -> export Markdown signé et différencié
        assert (
            client.patch(
                "/api/findings/F-001/decision",
                headers=headers,
                json={
                    "mode": "APRES",
                    "decision": "a_corriger",
                    "porteur": "DPO & Admin Cloud HDS",
                    "echeance": "Immédiat (< 24 h)",
                    "commentaire": "Révocation allUsers + instruction conservatoire CNIL Art. 33 §4",
                },
            ).status_code
            == 200
        )
        assert client.post("/api/validate?mode=AVANT", headers=headers).status_code == 200
        assert client.post("/api/validate?mode=APRES", headers=headers).status_code == 200

        cnil_av = client.get("/api/export/cnil-draft?mode=AVANT", headers=headers)
        assert cnil_av.status_code == 200
        assert "TRIAD_Evaluation_CNIL_RGPD_Art33_AVANT.md" in (
            cnil_av.headers.get("content-disposition") or ""
        )
        assert "Pré-entretien" in cnil_av.text
        assert "compromission de messagerie prestataire non notifiée (`F-004`" not in cnil_av.text.lower()

        cnil_ap = client.get("/api/export/cnil-draft?mode=APRES", headers=headers)
        assert cnil_ap.status_code == 200
        assert "text/markdown" in (cnil_ap.headers.get("content-type") or "")
        assert "TRIAD_Evaluation_CNIL_RGPD_Art33_APRES.md" in (
            cnil_ap.headers.get("content-disposition") or ""
        )
        expected_sig = (
            "hmac-sha256="
            + hmac.new(secret.encode("utf-8"), cnil_ap.content, hashlib.sha256).hexdigest()
        )
        assert cnil_ap.headers.get("x-triad-signature") == expected_sig

        md_ap = cnil_ap.text
        for expected_fragment in (
            "Double Guichet",
            "ANSSI",
            "72 h",
            "Art. 33",
            "Art. 34",
            "gs://ch-valmont-demo-export-radiologie",
            "F-001",
            "F-004",
            "DPO & Admin Cloud HDS",
            "Révocation allUsers + instruction conservatoire CNIL Art. 33 §4",
        ):
            assert expected_fragment in md_ap
        head_hash = client.get("/api/status?mode=APRES", headers=headers).json()["audit_log"][-1][
            "hash"
        ]
        assert head_hash in md_ap

        # 3. Bundle v6 (12 pièces) + rétrocompatibilité intégrale v1 (6), v2 (8), v3 (9), v4 (10), v5 (11) & v6 (12)
        bundle_v6_bytes = client.get("/api/export/bundle?mode=APRES", headers=headers).content
        v6_path = tmp_path / "bundle_v6.zip"
        v6_path.write_bytes(bundle_v6_bytes)
        env_with_secret = {**os.environ, "AUDIT_SIGNING_SECRET": secret}

        chk_v6 = subprocess.run(
            ["bash", str(verify_bundle_script), str(v6_path)],
            env=env_with_secret,
            capture_output=True,
            text=True,
        )
        assert chk_v6.returncode == 0, chk_v6.stdout + chk_v6.stderr
        assert "v6" in chk_v6.stdout

        cert_v6 = client.post(
            "/api/verify/bundle",
            headers=headers,
            files={"file": ("bundle_v6.zip", bundle_v6_bytes, "application/zip")},
        ).json()
        assert cert_v6["authentic"] is True
        assert cert_v6["bundle_version"] == "v6"
        assert cert_v6["signature_status"] == "VERIFIED"
        assert len(cert_v6["files_checked"]) == 12

        all_11_v5 = (
            "01_Rapport_NIS2.md",
            "02_Matrice_GRC.csv",
            "03_Synthese_Scellee.json",
            "04_Playbook_DryRun.sh",
            "05_Mail_DSI.txt",
            "06_Audit_Chain.jsonl",
            "07_PreNotification_ANSSI_Art23.md",
            "08_Brief_COMEX_Art20.md",
            "09_Remediation_GitOps.tf",
            "10_Guide_Entretien_Contradictoire.md",
            "11_Registre_Arbitrages_GRC.md",
        )
        retro_matrix = {
            "v1": all_11_v5[:6],
            "v2": all_11_v5[:8],
            "v3": all_11_v5[:9],
            "v4": all_11_v5[:10],
            "v5": all_11_v5[:11],
        }
        for ver_label, ver_files in retro_matrix.items():
            buf = io.BytesIO()
            with (
                zipfile.ZipFile(io.BytesIO(bundle_v6_bytes), "r") as zf_in,
                zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf_out,
            ):
                m_lines: list[str] = []
                for fname in ver_files:
                    fdata = zf_in.read(fname)
                    zf_out.writestr(fname, fdata)
                    m_lines.append(f"{hashlib.sha256(fdata).hexdigest()}  {fname}")
                zf_out.writestr(
                    "MANIFEST_SHA256.txt", ("\n".join(m_lines) + "\n").encode("utf-8")
                )
            ver_bytes = buf.getvalue()
            ver_path = tmp_path / f"retro_iter17_{ver_label}.zip"
            ver_path.write_bytes(ver_bytes)
            chk_cli = subprocess.run(
                ["bash", str(verify_bundle_script), str(ver_path)],
                capture_output=True,
                text=True,
            )
            assert chk_cli.returncode == 0, f"{ver_label}: {chk_cli.stdout}{chk_cli.stderr}"

            cert_retro = client.post(
                "/api/verify/bundle",
                headers=headers,
                files={"file": (f"retro_iter17_{ver_label}.zip", ver_bytes, "application/zip")},
            ).json()
            assert cert_retro["authentic"] is True, ver_label
            assert cert_retro["bundle_version"] == ver_label
            assert len(cert_retro["files_checked"]) == len(ver_files)

        # 4. Re-verrouillage automatique 403 après modification d'arbitrage GRC
        assert (
            client.patch(
                "/api/findings/F-004/decision",
                headers=headers,
                json={"mode": "APRES", "decision": "a_approfondir", "porteur": "DPO"},
            ).status_code
            == 200
        )
        assert client.get("/api/export/cnil-draft?mode=APRES", headers=headers).status_code == 403
    finally:
        client.delete("/api/sessions/cnil-art33-v6-session")


def test_security_sbom_cyclonedx_15_attestation_signature_and_container_fallback(
    monkeypatch, tmp_path: Path
) -> None:
    import triad.api.app as app_module
    from triad.config import Settings

    real_settings = app_module.get_settings()

    # 1. Sans clé HMAC : CycloneDX 1.5 déterministe valide, aucune signature, zéro écriture disque
    monkeypatch.setattr(
        app_module,
        "get_settings",
        lambda: Settings(
            data_dir=real_settings.data_dir,
            logs_dir=real_settings.logs_dir,
            audit_signing_secret="",
        ),
    )
    r1 = client.get("/api/security/sbom")
    r2 = client.get("/api/security/sbom")
    assert r1.status_code == 200
    assert r1.headers.get("content-type", "").startswith("application/json")
    assert "TRIAD_SBOM_CycloneDX_1.5.json" in (r1.headers.get("content-disposition") or "")
    assert r1.headers.get("x-triad-signature") is None
    assert r1.content == r2.content  # 100 % reproductible octet par octet

    sbom = r1.json()
    assert sbom["bomFormat"] == "CycloneDX"
    assert sbom["specVersion"] == "1.5"
    assert sbom["version"] == 1
    assert str(sbom["serialNumber"]).startswith("urn:uuid:")
    assert sbom["metadata"]["component"]["name"] == "triad"
    assert isinstance(sbom["components"], list) and len(sbom["components"]) >= 50
    assert isinstance(sbom["dependencies"], list) and len(sbom["dependencies"]) >= 2

    # 2. Avec AUDIT_SIGNING_SECRET : X-Triad-Signature valide et aucune fuite de secret
    secret = "iter17-sbom-confidential-signing-secret"
    monkeypatch.setattr(
        app_module,
        "get_settings",
        lambda: Settings(
            data_dir=real_settings.data_dir,
            logs_dir=real_settings.logs_dir,
            audit_signing_secret=secret,
        ),
    )
    r_signed = client.get("/api/security/sbom")
    assert r_signed.status_code == 200
    assert secret not in r_signed.text
    expected_sig = (
        "hmac-sha256="
        + hmac.new(secret.encode("utf-8"), r_signed.content, hashlib.sha256).hexdigest()
    )
    assert r_signed.headers.get("x-triad-signature") == expected_sig

    # 3. Repli conteneur slim (quand pyproject.toml et frontend/package-lock.json sont absents)
    fallback_sbom = app_module._build_runtime_cyclonedx_sbom(repo_root=tmp_path)
    assert fallback_sbom["bomFormat"] == "CycloneDX"
    assert fallback_sbom["specVersion"] == "1.5"
    assert str(fallback_sbom["serialNumber"]).startswith("urn:uuid:")
    assert isinstance(fallback_sbom["components"], list) and len(fallback_sbom["components"]) >= 10
    assert fallback_sbom == app_module._build_runtime_cyclonedx_sbom(repo_root=tmp_path)


def test_gzip_compression_and_cache_control_cloud_run_headers() -> None:
    from triad.api.app import DIST_DIR

    headers_sid = {"X-Session-Id": "gzip-cache-control-session"}
    try:
        # 1. Cache-Control: no-store strict sur /, /index.html et /api/*
        for non_cached_path in (
            "/",
            "/index.html",
            "/api/health",
            "/api/security/posture",
            "/api/security/sbom",
        ):
            r_nc = client.get(non_cached_path, headers=headers_sid)
            assert r_nc.status_code == 200, non_cached_path
            assert r_nc.headers.get("cache-control") == "no-store", non_cached_path

        # 2. Réponse < 500 octets (/api/health) : pas de compression GZip inutile
        r_small = client.get("/api/health", headers={"Accept-Encoding": "gzip"})
        assert r_small.status_code == 200
        assert len(r_small.content) < 500
        assert r_small.headers.get("content-encoding") is None

        # 3. Réponses JSON volumineuses (>= 500 octets) : GZip actif avec gain réel sur le fil
        r_sbom_raw = client.get("/api/security/sbom", headers={"Accept-Encoding": "identity"})
        r_sbom_gz = client.get("/api/security/sbom", headers={"Accept-Encoding": "gzip"})
        assert r_sbom_raw.status_code == 200 and r_sbom_gz.status_code == 200
        assert r_sbom_raw.headers.get("content-encoding") is None
        assert r_sbom_gz.headers.get("content-encoding") == "gzip"
        assert "Accept-Encoding" in (r_sbom_gz.headers.get("vary") or "")
        assert r_sbom_gz.content == r_sbom_raw.content
        raw_wire_len = int(r_sbom_raw.headers.get("content-length") or len(r_sbom_raw.content))
        gz_wire_len = int(r_sbom_gz.headers.get("content-length") or "0")
        assert 0 < gz_wire_len < raw_wire_len

        # 4. Assets statiques hashés par Vite (/assets/*) : Cache-Control immutable 1 an + GZip (>= 500 o)
        assets_dir = DIST_DIR / "assets"
        asset_files = sorted(
            p
            for p in (assets_dir.iterdir() if assets_dir.is_dir() else [])
            if p.is_file() and p.suffix in {".js", ".css"} and p.stat().st_size >= 500
        )
        assert len(asset_files) >= 1
        for asset in asset_files:
            r_asset = client.get(
                f"/assets/{asset.name}",
                headers={"Accept-Encoding": "gzip"},
            )
            assert r_asset.status_code == 200, asset.name
            assert (
                r_asset.headers.get("cache-control") == "public, max-age=31536000, immutable"
            ), asset.name
            assert r_asset.headers.get("content-encoding") == "gzip", asset.name

        # Un asset introuvable (404) ne doit jamais être mis en cache immutable
        r_missing_asset = client.get("/assets/__introuvable_404__.js")
        assert r_missing_asset.status_code == 404
        assert r_missing_asset.headers.get("cache-control") == "no-store"

        # 5. Livrables Markdown (>= 500 o) compressés en GZip, mais archive .zip exclue du double GZip
        assert client.post("/api/demo/load", headers=headers_sid).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=headers_sid,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        assert client.post("/api/validate?mode=APRES", headers=headers_sid).status_code == 200

        r_md = client.get(
            "/api/export/report?mode=APRES",
            headers={**headers_sid, "Accept-Encoding": "gzip"},
        )
        assert r_md.status_code == 200
        assert r_md.headers.get("content-encoding") == "gzip"
        assert r_md.headers.get("cache-control") == "no-store"

        r_zip = client.get(
            "/api/export/bundle?mode=APRES",
            headers={**headers_sid, "Accept-Encoding": "gzip"},
        )
        assert r_zip.status_code == 200
        assert r_zip.headers.get("content-encoding") is None
        assert r_zip.headers.get("cache-control") == "no-store"
    finally:
        client.delete("/api/sessions/gzip-cache-control-session")


def test_sbom_memory_cache_and_etag_304_conditional_requests(monkeypatch) -> None:
    import triad.api.app as app_module
    from triad.config import Settings

    secret = "iter19-etag-304-hmac-signing-secret"
    real_settings = app_module.get_settings()
    monkeypatch.setattr(
        app_module,
        "get_settings",
        lambda: Settings(
            data_dir=real_settings.data_dir,
            logs_dir=real_settings.logs_dir,
            audit_signing_secret=secret,
        ),
    )

    # 1. Mémorisation effective en cache mémoire de _build_runtime_cyclonedx_sbom() (zéro relecture disque)
    sbom_first = app_module._build_runtime_cyclonedx_sbom()
    sbom_second = app_module._build_runtime_cyclonedx_sbom()
    assert sbom_first is sbom_second

    def _forbid_recompute(_root: Path):
        raise AssertionError("Le SBOM doit être servi depuis le cache mémoire sans recalcul")

    monkeypatch.setattr(app_module, "_compute_runtime_cyclonedx_sbom_uncached", _forbid_recompute)
    assert app_module._build_runtime_cyclonedx_sbom() is sbom_first

    # 2. Validation conditionnelle ETag / If-None-Match -> HTTP 304 sur GET /api/security/sbom
    r_sbom_200 = client.get("/api/security/sbom")
    assert r_sbom_200.status_code == 200
    sbom_etag = r_sbom_200.headers.get("etag") or ""
    assert sbom_etag.startswith('"') and sbom_etag.endswith('"') and len(sbom_etag) == 66
    assert r_sbom_200.headers.get("cache-control") == "no-store"
    expected_sbom_sig = (
        "hmac-sha256="
        + hmac.new(secret.encode("utf-8"), r_sbom_200.content, hashlib.sha256).hexdigest()
    )
    assert r_sbom_200.headers.get("x-triad-signature") == expected_sbom_sig

    for inm_hdr in (sbom_etag, f"W/{sbom_etag}", f'"stale-000", {sbom_etag}', "*"):
        r_sbom_304 = client.get("/api/security/sbom", headers={"If-None-Match": inm_hdr})
        assert r_sbom_304.status_code == 304, inm_hdr
        assert r_sbom_304.content == b""
        assert r_sbom_304.headers.get("etag") == sbom_etag
        assert r_sbom_304.headers.get("cache-control") == "no-store"
        assert r_sbom_304.headers.get("x-triad-signature") == expected_sbom_sig

    r_sbom_miss = client.get("/api/security/sbom", headers={"If-None-Match": '"etag-different"'})
    assert r_sbom_miss.status_code == 200
    assert r_sbom_miss.content == r_sbom_200.content

    # 3. Validation conditionnelle ETag / If-None-Match -> HTTP 304 sur GET /api/nis2
    r_nis2_200 = client.get("/api/nis2")
    assert r_nis2_200.status_code == 200
    nis2_body = r_nis2_200.json()
    assert nis2_body["total"] == 11
    assert len(nis2_body["exigences"]) == 11
    nis2_etag = r_nis2_200.headers.get("etag") or ""
    assert nis2_etag.startswith('"') and nis2_etag.endswith('"') and len(nis2_etag) == 66
    assert r_nis2_200.headers.get("cache-control") == "no-store"
    expected_nis2_sig = (
        "hmac-sha256="
        + hmac.new(secret.encode("utf-8"), r_nis2_200.content, hashlib.sha256).hexdigest()
    )
    assert r_nis2_200.headers.get("x-triad-signature") == expected_nis2_sig

    r_nis2_304 = client.get("/api/nis2", headers={"If-None-Match": nis2_etag})
    assert r_nis2_304.status_code == 304
    assert r_nis2_304.content == b""
    assert r_nis2_304.headers.get("etag") == nis2_etag
    assert r_nis2_304.headers.get("cache-control") == "no-store"
    assert r_nis2_304.headers.get("x-triad-signature") == expected_nis2_sig

    r_nis2_theme = client.get("/api/nis2?theme=incidents")
    assert r_nis2_theme.status_code == 200
    assert 1 <= r_nis2_theme.json()["count"] < 11
    assert r_nis2_theme.headers.get("etag") != nis2_etag


def test_state_and_nis2_coverage_etag_304_and_mutation_invalidation() -> None:
    sid = "iter20-etag-state-coverage-session"
    base_headers = {"X-Session-Id": sid}
    seen_state_etags: set[str] = set()
    seen_cov_etags: set[str] = set()

    def _assert_fresh_etag_then_304(
        prev_state_etag: str | None, prev_cov_etag: str | None
    ) -> tuple[str, str]:
        # 1) /api/state : l'ancien ETag (s'il existe) est invalidé -> 200 OK avec nouvel ETag
        inm_state = {**base_headers, "If-None-Match": prev_state_etag} if prev_state_etag else base_headers
        r_st = client.get("/api/state?mode=APRES", headers=inm_state)
        assert r_st.status_code == 200
        assert r_st.headers.get("cache-control") == "no-store"
        st_etag = r_st.headers.get("etag") or ""
        assert st_etag.startswith('"') and st_etag.endswith('"') and len(st_etag) == 66
        assert st_etag not in seen_state_etags
        seen_state_etags.add(st_etag)

        # Parité exacte avec /api/status et HEAD /api/state
        r_status_alias = client.get("/api/status?mode=APRES", headers=base_headers)
        assert r_status_alias.status_code == 200
        assert r_status_alias.headers.get("etag") == st_etag
        assert r_status_alias.json() == r_st.json()

        r_st_head_200 = client.head("/api/state?mode=APRES", headers=base_headers)
        assert r_st_head_200.status_code == 200
        assert r_st_head_200.content == b""
        assert r_st_head_200.headers.get("etag") == st_etag

        # Validation conditionnelle 304 Not Modified (GET & HEAD, corps vide 0 octet)
        r_st_304 = client.get(
            "/api/state?mode=APRES", headers={**base_headers, "If-None-Match": st_etag}
        )
        assert r_st_304.status_code == 304
        assert r_st_304.content == b""
        assert r_st_304.headers.get("etag") == st_etag
        assert r_st_304.headers.get("cache-control") == "no-store"

        r_st_head_304 = client.head(
            "/api/state?mode=APRES", headers={**base_headers, "If-None-Match": st_etag}
        )
        assert r_st_head_304.status_code == 304
        assert r_st_head_304.content == b""

        # 2) /api/nis2/coverage : invalidation immédiate -> 200 OK avec nouvel ETag -> 304
        inm_cov = {**base_headers, "If-None-Match": prev_cov_etag} if prev_cov_etag else base_headers
        r_cov = client.get("/api/nis2/coverage?mode=APRES", headers=inm_cov)
        assert r_cov.status_code == 200
        assert r_cov.headers.get("cache-control") == "no-store"
        cov_etag = r_cov.headers.get("etag") or ""
        assert cov_etag.startswith('"') and cov_etag.endswith('"') and len(cov_etag) == 66
        assert cov_etag not in seen_cov_etags
        seen_cov_etags.add(cov_etag)

        r_cov_head_200 = client.head("/api/nis2/coverage?mode=APRES", headers=base_headers)
        assert r_cov_head_200.status_code == 200
        assert r_cov_head_200.content == b""
        assert r_cov_head_200.headers.get("etag") == cov_etag

        r_cov_304 = client.get(
            "/api/nis2/coverage?mode=APRES", headers={**base_headers, "If-None-Match": cov_etag}
        )
        assert r_cov_304.status_code == 304
        assert r_cov_304.content == b""
        assert r_cov_304.headers.get("etag") == cov_etag
        assert r_cov_304.headers.get("cache-control") == "no-store"

        r_cov_head_304 = client.head(
            "/api/nis2/coverage?mode=APRES", headers={**base_headers, "If-None-Match": cov_etag}
        )
        assert r_cov_head_304.status_code == 304
        assert r_cov_head_304.content == b""

        return st_etag, cov_etag

    try:
        # Étape 0 : session vierge initiale
        st_etag, cov_etag = _assert_fresh_etag_then_304(None, None)

        # Mutation 1 : Upload documentaire
        up_res = client.post(
            "/api/upload",
            headers=base_headers,
            files=[("files", ("PSSI_Test.md", b"# PSSI CH Valmont\nAcces MFA.\n", "text/markdown"))],
        )
        assert up_res.status_code == 200
        st_etag, cov_etag = _assert_fresh_etag_then_304(st_etag, cov_etag)

        # Mutation 2 : Chargement démo + Exécution de l'audit
        assert client.post("/api/demo/load", headers=base_headers).status_code == 200
        assert (
            client.post(
                "/api/audit/run",
                headers=base_headers,
                json={"mode": "APRES", "use_cache": True},
            ).status_code
            == 200
        )
        st_etag, cov_etag = _assert_fresh_etag_then_304(st_etag, cov_etag)

        # Mutation 3 : Arbitrage GRC sur un constat
        assert (
            client.patch(
                "/api/findings/F-001/decision",
                headers=base_headers,
                json={
                    "mode": "APRES",
                    "decision": "a_corriger",
                    "porteur": "Admin Cloud",
                    "echeance": "J+7",
                },
            ).status_code
            == 200
        )
        st_etag, cov_etag = _assert_fresh_etag_then_304(st_etag, cov_etag)

        # Mutation 4 : Validation humaine du consultant
        assert client.post("/api/validate?mode=APRES", headers=base_headers).status_code == 200
        st_etag, cov_etag = _assert_fresh_etag_then_304(st_etag, cov_etag)

        # Mutation 5 : Réinitialisation complète de la session
        assert client.post("/api/reset", headers=base_headers).status_code == 200
        _assert_fresh_etag_then_304(st_etag, cov_etag)
    finally:
        client.delete(f"/api/sessions/{sid}")




