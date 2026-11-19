"""Journalisation structurée compatible Google Cloud Logging (JSON / auto-détection K_SERVICE)."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Literal

EffectiveLogFormat = Literal["json", "text", "off"]


def resolve_log_format(raw_format: str | None = None) -> EffectiveLogFormat:
    """Résout le format d'émission des logs ('auto' -> 'json' si K_SERVICE est défini, sinon 'text')."""
    fmt = (
        raw_format if raw_format is not None else os.getenv("LOG_FORMAT", "auto")
    ).strip().lower() or "auto"
    if fmt == "json":
        return "json"
    if fmt in {"text", "plain"}:
        return "text"
    if fmt in {"off", "none", "silent"}:
        return "off"
    if os.getenv("K_SERVICE", "").strip():
        return "json"
    return "text"


def infer_session_id_from_log_path(
    log_path: Path,
    explicit_session_id: str | None = None,
) -> str:
    """Déduit l'identifiant de session depuis un chemin de journal d'audit si non fourni."""
    if explicit_session_id and explicit_session_id.strip():
        return explicit_session_id.strip()
    fname = log_path.name
    if fname == "audit_trail.jsonl":
        return "default"
    if fname.startswith("audit_trail_") and fname.endswith(".jsonl"):
        extracted = fname[len("audit_trail_") : -len(".jsonl")].strip()
        return extracted or "default"
    return log_path.stem or "default"


def build_structured_audit_record(
    entry: dict[str, Any],
    *,
    session_id: str = "default",
) -> dict[str, Any]:
    """Construit l'objet structuré Cloud Logging (jsonPayload) à partir d'un maillon SHA-256."""
    action = str(entry.get("action") or "")
    agent = str(entry.get("agent") or "Inconnu")
    sha256_hex = str(entry.get("hash") or "")
    details = entry.get("details", {})

    if action == "VIOLATION":
        severity = "CRITICAL"
        event_type = "SECURITY_VIOLATION_BLOCKED"
    elif action == "QUARANTINE":
        severity = "WARNING"
        event_type = "PROMPT_INJECTION_QUARANTINED"
    elif action == "HUMAN_VALIDATION":
        severity = "NOTICE"
        event_type = "HUMAN_VALIDATION_APPROVED"
    else:
        severity = "INFO"
        event_type = f"AUDIT_{action.upper()}" if action else "AUDIT_EVENT"

    detail_msg = (
        str(details.get("message"))
        if isinstance(details, dict) and details.get("message")
        else f"{agent}:{action}"
    )

    return {
        "severity": severity,
        "timestamp": entry.get("ts"),
        "component": "triad",
        "service": os.getenv("K_SERVICE", "").strip() or "triad",
        "event_type": event_type,
        "session_id": session_id or "default",
        "run_id": entry.get("run_id"),
        "mode": entry.get("mode"),
        "agent": agent,
        "action": action,
        "sha256": sha256_hex,
        "prev_hash": entry.get("prev_hash"),
        "details": details,
        "message": (
            f"[TRIAD] {event_type} — {detail_msg} "
            f"(session={session_id or 'default'}, sha256={sha256_hex[:12]})"
        ),
    }


def format_audit_log_line(
    entry: dict[str, Any],
    *,
    session_id: str = "default",
    log_format: str | None = None,
) -> str | None:
    """Formate une ligne de journalisation selon LOG_FORMAT ('json' | 'text' | 'off')."""
    effective = resolve_log_format(log_format)
    if effective == "off":
        return None
    record = build_structured_audit_record(entry, session_id=session_id)
    if effective == "json":
        return json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    return (
        f"[TRIAD][{record['severity']}] session={record['session_id']} "
        f"agent={record['agent']} action={record['action']} "
        f"event_type={record['event_type']} sha256={record['sha256'][:16]}"
    )


def emit_structured_audit_event(
    entry: dict[str, Any],
    *,
    session_id: str = "default",
    stream: Any = None,
    log_format: str | None = None,
) -> dict[str, Any]:
    """Émet sur le flux standard l'entrée structurée correspondant au maillon SHA-256."""
    record = build_structured_audit_record(entry, session_id=session_id)
    line = format_audit_log_line(entry, session_id=session_id, log_format=log_format)
    if line is not None:
        target = stream if stream is not None else sys.stdout
        try:
            target.write(line + "\n")
            target.flush()
        except Exception:
            pass
    return record
