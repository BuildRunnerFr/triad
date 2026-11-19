"""Orchestration du SequentialAgent ADK TRIAD et exécution sur InMemoryRunner."""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from google.adk.agents import SequentialAgent
from google.adk.runners import InMemoryRunner
from google.genai import types

from triad.agents.analyste import AnalysteConformiteAgent
from triad.agents.contre_auditeur import ContreAuditeurAgent
from triad.agents.douanier import DouanierAgent
from triad.agents.garde_du_corps import GardeDuCorpsAgent
from triad.config import DATA_DIR, LOGS_DIR, get_settings
from triad.models import AuditMode, AuditSynthesis, Finding, SanitizedDocument
from triad.security.audit_log import AuditLogger, verify_chain
from triad.security.callbacks import make_security_callbacks
from triad.tools.doc_loader import load_document
from triad.tools.injection_detector import scan_injection
from triad.tools.pii_redactor import redact_pii


def build_triad_pipeline(
    audit_logger: AuditLogger,
    status_callback: Callable[[str, str], None] | None = None,
) -> SequentialAgent:
    """Construit le pipeline séquentiel ADK des 4 agents TRIAD."""
    callbacks = make_security_callbacks(audit_logger)

    douanier = DouanierAgent(
        before_tool_callback=callbacks["before_tool_callback"],
        status_callback=status_callback,
    )
    analyste = AnalysteConformiteAgent(
        before_tool_callback=callbacks["before_tool_callback"],
        before_model_callback=callbacks["before_model_callback"],
        after_model_callback=callbacks["after_model_callback"],
        status_callback=status_callback,
    )
    contre_auditeur = ContreAuditeurAgent(
        before_tool_callback=callbacks["before_tool_callback"],
        before_model_callback=callbacks["before_model_callback"],
        after_model_callback=callbacks["after_model_callback"],
        status_callback=status_callback,
    )
    garde_du_corps = GardeDuCorpsAgent(
        audit_logger=audit_logger,
        before_tool_callback=callbacks["before_tool_callback"],
        status_callback=status_callback,
    )

    return SequentialAgent(
        name="TriadPipeline",
        description="Pipeline d'audit NIS2 TRIAD : Douanier -> Analyste -> Contre-Auditeur -> Garde du Corps.",
        sub_agents=[douanier, analyste, contre_auditeur, garde_du_corps],
    )


def _run_demo_cache(
    input_files: list[Path],
    mode: AuditMode,
    audit_logger: AuditLogger,
    run_id: str,
    status_callback: Callable[[str, str], None] | None = None,
    t0: float | None = None,
) -> dict[str, Any]:
    """Rejoue le cache validé de Valmont tout en exécutant le vrai Douanier et la télémétrie."""
    start_ts = t0 if t0 is not None else time.perf_counter()
    cache = json.loads((DATA_DIR / "demo_cache.json").read_text(encoding="utf-8"))
    key = "mode_avant" if mode == "AVANT" else "mode_apres"
    payload = cache[key]

    # Agent 1 : Douanier
    if status_callback:
        status_callback("Douanier", "en_cours")
    sanitized_docs: list[SanitizedDocument] = []
    quarantined_docs: list[SanitizedDocument] = []
    for path in input_files:
        if mode == "AVANT" and "entretien" in path.name.lower():
            continue
        raw = load_document(path)
        red = redact_pii(raw)
        inj = scan_injection(red["texte_masque"], use_llm=False)
        doc_type = "dit" if "entretien" in path.name.lower() else "ecrit"
        if inj["suspect"]:
            quarantined_docs.append(
                SanitizedDocument(
                    nom_fichier=path.name,
                    type_source=doc_type,  # type: ignore[arg-type]
                    contenu_masque=red["texte_masque"],
                    masquages=red["masquages"],
                    statut="quarantaine",
                    raison_quarantaine=inj["raison"],
                    extrait_quarantaine=inj.get("extrait_suspect"),
                )
            )
            audit_logger.append("Douanier", "QUARANTINE", {"fichier": path.name})
        else:
            sanitized_docs.append(
                SanitizedDocument(
                    nom_fichier=path.name,
                    type_source=doc_type,  # type: ignore[arg-type]
                    contenu_masque=red["texte_masque"],
                    masquages=red["masquages"],
                    statut="nettoye",
                )
            )
            audit_logger.append("Douanier", "SANITIZED", {"fichier": path.name})
    if status_callback:
        status_callback("Douanier", "terminé")

    # Agent 2 : AnalysteConformite
    if status_callback:
        status_callback("AnalysteConformite", "en_cours")
    findings = [Finding.model_validate(f) for f in payload["findings"]]
    if status_callback:
        status_callback("AnalysteConformite", "terminé")

    # Agent 3 : ContreAuditeur
    if status_callback:
        status_callback("ContreAuditeur", "en_cours")
    top_3_risques = list(payload.get("top_3_risques", []))
    questions_entretien = list(payload.get("questions_entretien", []))
    mail_suivi = str(payload.get("mail_suivi", ""))
    if status_callback:
        status_callback("ContreAuditeur", "terminé")

    # Agent 4 : GardeDuCorps
    if status_callback:
        status_callback("GardeDuCorps", "en_cours")
    synthesis = AuditSynthesis(
        client=cache.get("client", "Centre Hospitalier de Valmont"),
        mode=mode,
        statut_validation="EN ATTENTE DE VALIDATION",
        findings=findings,
        top_3_risques=top_3_risques,
        questions_entretien=questions_entretien,
        mail_suivi=mail_suivi,
        documents_nettoyes=sanitized_docs,
        documents_quarantaine=quarantined_docs,
    )
    audit_logger.append(
        "GardeDuCorps",
        "SYNTHESIS_READY_CACHE",
        {"statut": synthesis.statut_validation, "nb_findings": len(synthesis.findings)},
    )
    chain_info = verify_chain(audit_logger.log_path)
    if status_callback:
        status_callback("GardeDuCorps", "terminé")

    elapsed = max(0.01, round(time.perf_counter() - start_ts, 3))
    return {
        "run_id": run_id,
        "synthesis": synthesis.model_dump(),
        "chain": chain_info,
        "elapsed_seconds": elapsed,
        "source": "demo_cache",
    }


async def run_audit_pipeline(
    input_files: list[Path],
    mode: AuditMode = "APRES",
    log_path: Path | None = None,
    use_cache: bool | None = None,
    status_callback: Callable[[str, str], None] | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    """Exécute le pipeline complet TRIAD en mode append-only sur le journal SHA-256."""
    t0 = time.perf_counter()
    settings = get_settings()
    resolved_log = log_path or (LOGS_DIR / "audit_trail.jsonl")
    resolved_run_id = run_id or f"run-{uuid.uuid4().hex[:12]}"
    audit_logger = AuditLogger(resolved_log, run_id=resolved_run_id, mode=mode)

    agent_starts: dict[str, float] = {}
    timings_ms: dict[str, int] = {}

    def _tracked_status_cb(agent: str, status: str) -> None:
        now = time.perf_counter()
        if status == "en_cours":
            agent_starts[agent] = now
        elif status in ("terminé", "bloqué") and agent in agent_starts:
            dt_ms = (now - agent_starts[agent]) * 1000.0
            timings_ms[agent] = max(1, round(dt_ms))
        if status_callback:
            status_callback(agent, status)

    audit_logger.append(
        "TriadPipeline",
        "RUN_START",
        {"mode": mode, "nb_fichiers": len(input_files)},
    )

    for ag in ("Douanier", "AnalysteConformite", "ContreAuditeur", "GardeDuCorps"):
        _tracked_status_cb(ag, "en_attente")

    should_use_cache = settings.use_demo_cache if use_cache is None else use_cache
    if should_use_cache:
        cache_res = _run_demo_cache(
            input_files=input_files,
            mode=mode,
            audit_logger=audit_logger,
            run_id=resolved_run_id,
            status_callback=_tracked_status_cb,
            t0=t0,
        )
        cache_res["timings_ms"] = dict(timings_ms)
        return cache_res

    pipeline = build_triad_pipeline(audit_logger, status_callback=_tracked_status_cb)
    runner = InMemoryRunner(agent=pipeline, app_name="triad_audit")
    session = await runner.session_service.create_session(
        app_name="triad_audit",
        user_id="consultant_deloitte",
        state={
            "input_files": [str(p) for p in input_files],
            "mode": mode,
            "run_id": resolved_run_id,
            "client": "Centre Hospitalier de Valmont",
        },
    )

    user_msg = types.Content(
        role="user",
        parts=[types.Part(text=f"Lancer l'audit NIS2 en mode {mode}.")],
    )
    async for _event in runner.run_async(
        user_id="consultant_deloitte",
        session_id=session.id,
        new_message=user_msg,
    ):
        pass

    final_session = await runner.session_service.get_session(
        app_name="triad_audit",
        user_id="consultant_deloitte",
        session_id=session.id,
    )
    state = final_session.state if final_session else {}
    elapsed = round(time.perf_counter() - t0, 2)

    return {
        "run_id": resolved_run_id,
        "synthesis": state.get("synthesis", {}),
        "chain": verify_chain(resolved_log),
        "elapsed_seconds": elapsed,
        "timings_ms": dict(timings_ms),
        "source": "adk_live",
    }
