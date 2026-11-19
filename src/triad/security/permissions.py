"""Matrice des permissions strictes par agent (principe du moindre privilège)."""

from __future__ import annotations

PERMISSIONS: dict[str, list[str]] = {
    "Douanier": [
        "read_raw_file",
        "redact_pii",
        "scan_injection",
        "quarantine_file",
        "emit_sanitized_doc",
    ],
    "AnalysteConformite": [
        "read_sanitized_doc",
        "get_nis2_requirements",
        "gcp_check_public_buckets",
        "gcp_check_open_firewall",
        "gcp_check_backup_protection",
        "gcp_check_iam_privileges",
        "gcp_check_kms_and_logging",
    ],
    "ContreAuditeur": [
        "verify_quote",
        "read_sanitized_doc",
        "get_nis2_requirements",
    ],
    "GardeDuCorps": [
        "assemble_synthesis",
        "verify_chain",
    ],
}


def is_tool_allowed(agent_name: str, tool_name: str) -> bool:
    """Retourne True uniquement si l'outil est explicitement autorisé pour cet agent."""
    allowed = PERMISSIONS.get(agent_name, [])
    return tool_name in allowed
