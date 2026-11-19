"""Callbacks de sécurité ADK branchés sur tous les agents TRIAD."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from triad.security.audit_log import AuditLogger
from triad.security.permissions import is_tool_allowed


def delete_bucket(bucket_name: str) -> dict[str, Any]:
    """Outil factice (stub) sans aucune implémentation GCP — sert uniquement à tester le blocage."""
    raise RuntimeError(
        f"Exécution interdite: delete_bucket({bucket_name}) ne doit jamais être exécuté."
    )


def make_security_callbacks(audit_logger: AuditLogger) -> dict[str, Any]:
    """Construit les callbacks ADK (outil + modèle) liés à un AuditLogger."""

    def before_tool_callback(tool: Any, args: dict[str, Any], tool_context: Any) -> dict[str, Any] | None:
        agent_name = getattr(tool_context, "agent_name", None) or "Inconnu"
        tool_name = getattr(tool, "name", None) or getattr(tool, "__name__", str(tool))

        if not is_tool_allowed(agent_name, tool_name):
            msg = (
                f"VIOLATION: l'agent '{agent_name}' a tenté d'appeler l'outil "
                f"non autorisé '{tool_name}'."
            )
            audit_logger.append(
                agent=agent_name,
                action="VIOLATION",
                details={"outil": tool_name, "args": args, "message": msg},
            )
            state = getattr(tool_context, "state", None)
            if isinstance(state, dict):
                state["security_violation"] = True
                state["violation_message"] = msg
                state["pipeline_status"] = "bloqué"
            actions = getattr(tool_context, "actions", None)
            if actions is not None:
                actions.escalate = True
            return {"status": "BLOCKED", "violation": True, "message": msg}

        audit_logger.append(
            agent=agent_name,
            action="TOOL_CALL",
            details={"outil": tool_name, "cles_args": sorted(args.keys())},
        )
        return None

    def before_model_callback(callback_context: Any, llm_request: Any) -> None:
        agent_name = getattr(callback_context, "agent_name", None) or "Inconnu"
        audit_logger.append(
            agent=agent_name,
            action="MODEL_REQUEST",
            details={"model": getattr(llm_request, "model", None)},
        )
        return None

    def after_model_callback(callback_context: Any, llm_response: Any) -> None:
        agent_name = getattr(callback_context, "agent_name", None) or "Inconnu"
        audit_logger.append(
            agent=agent_name,
            action="MODEL_RESPONSE",
            details={"finish_reason": str(getattr(llm_response, "finish_reason", "OK"))},
        )
        return None

    return {
        "before_tool_callback": before_tool_callback,
        "before_model_callback": before_model_callback,
        "after_model_callback": after_model_callback,
    }


def simulate_unauthorized_action(audit_logger: AuditLogger) -> dict[str, Any]:
    """Déclenche une vraie tentative d'appel de delete_bucket par AnalysteConformite.

    Passe par le vrai before_tool_callback et la vraie matrice PERMISSIONS,
    sans appel LLM (< 1 s).
    """
    callbacks = make_security_callbacks(audit_logger)
    before_tool = callbacks["before_tool_callback"]

    fake_tool = SimpleNamespace(name="delete_bucket")
    state: dict[str, Any] = {}
    actions = SimpleNamespace(escalate=False)
    ctx = SimpleNamespace(agent_name="AnalysteConformite", state=state, actions=actions)

    result = before_tool(
        fake_tool,
        {"bucket_name": "gs://ch-valmont-demo-backups-dpi"},
        ctx,
    )
    return {
        "blocked": bool(result and result.get("violation")),
        "escalated": actions.escalate,
        "result": result,
        "state": state,
    }
