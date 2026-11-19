"""Masquage des données personnelles et sensibles (Google Cloud DLP + fallback regex)."""

from __future__ import annotations

import re
from typing import Any

from triad.config import get_settings

INFO_TYPE_LABELS = {
    "PERSON_NAME": "NOM",
    "EMAIL_ADDRESS": "EMAIL",
    "PHONE_NUMBER": "TEL",
    "IBAN_CODE": "IBAN",
    "FRANCE_NIR": "NIR",
}

# Motifs regex de secours si l'API Cloud DLP est indisponible ou désactivée
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_IBAN_RE = re.compile(r"\bFR\d{2}(?:[ ]?[A-Z0-9]{4}){5}(?:[ ]?[A-Z0-9]{1,3})\b")
_NIR_RE = re.compile(r"\b[12]\s?\d{2}\s?(?:0[1-9]|1[0-2]|[2-9]\d)\s?\d{2}\s?\d{3}\s?\d{3}(?:\s?\d{2})?\b")
_PHONE_RE = re.compile(r"(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}\b")
_NAME_CONTEXT_RE = re.compile(
    r"(?:(?:RSSI|DSI|M\.|Mme|Dr|Responsable[^:\n]*)\s*:\s*(?:\*{1,2}\s*)?|M\.\s+|Mme\s+|RSSI,\s+)"
    r"([A-ZÉÈÊÀÂÎÔÙÛÇ][a-zéèêàâîôùûç-]+(?:\s+[A-ZÉÈÊÀÂÎÔÙÛÇ][a-zéèêàâîôùûç-]+)?)"
)


def _replace_with_counters(
    text: str,
    pattern: re.Pattern[str],
    label: str,
    mapping: dict[str, str],
    counters: dict[str, int],
    group: int = 0,
) -> str:
    def _sub(match: re.Match[str]) -> str:
        full = match.group(0)
        target = match.group(group)
        if target not in mapping:
            counters[label] = counters.get(label, 0) + 1
            mapping[target] = f"[{label}_{counters[label]}]"
        token = mapping[target]
        if group == 0:
            return token
        start, end = match.span(group)
        rel_start = start - match.start(0)
        rel_end = end - match.start(0)
        return full[:rel_start] + token + full[rel_end:]

    return pattern.sub(_sub, text)


def _redact_regex(text: str) -> tuple[str, dict[str, int], str]:
    mapping: dict[str, str] = {}
    counters: dict[str, int] = {}

    redacted = _replace_with_counters(text, _IBAN_RE, "IBAN", mapping, counters)
    redacted = _replace_with_counters(redacted, _EMAIL_RE, "EMAIL", mapping, counters)
    redacted = _replace_with_counters(redacted, _NIR_RE, "NIR", mapping, counters)
    redacted = _replace_with_counters(redacted, _PHONE_RE, "TEL", mapping, counters)
    redacted = _replace_with_counters(redacted, _NAME_CONTEXT_RE, "NOM", mapping, counters, group=1)

    # Remplace également les occurrences répétées d'un nom déjà détecté
    for raw_val, token in list(mapping.items()):
        if token.startswith("[NOM_"):
            redacted = re.sub(rf"\b{re.escape(raw_val)}\b", token, redacted)

    return redacted, counters, "regex_fallback"


def _redact_dlp(text: str, project_id: str) -> tuple[str, dict[str, int], str]:
    from google.cloud import dlp_v2

    client = dlp_v2.DlpServiceClient()
    parent = f"projects/{project_id}/locations/global"
    inspect_config = {
        "info_types": [{"name": t} for t in INFO_TYPE_LABELS],
        "min_likelihood": dlp_v2.Likelihood.POSSIBLE,
    }
    response = client.inspect_content(
        request={
            "parent": parent,
            "inspect_config": inspect_config,
            "item": {"value": text},
        }
    )

    findings = sorted(
        response.result.findings,
        key=lambda f: f.location.byte_range.start,
        reverse=True,
    )
    if not findings:
        return text, {}, "cloud_dlp"

    data_bytes = text.encode("utf-8")
    mapping: dict[str, str] = {}
    counters: dict[str, int] = {}

    # Attribution déterministe des compteurs dans l'ordre d'apparition
    for finding in sorted(response.result.findings, key=lambda f: f.location.byte_range.start):
        start = finding.location.byte_range.start
        end = finding.location.byte_range.end
        raw = data_bytes[start:end].decode("utf-8", errors="ignore")
        label = INFO_TYPE_LABELS.get(finding.info_type.name, "PII")
        if raw not in mapping:
            counters[label] = counters.get(label, 0) + 1
            mapping[raw] = f"[{label}_{counters[label]}]"

    mutable = bytearray(data_bytes)
    for finding in findings:
        start = finding.location.byte_range.start
        end = finding.location.byte_range.end
        raw = bytes(mutable[start:end]).decode("utf-8", errors="ignore")
        token = mapping.get(raw, "[PII]").encode("utf-8")
        mutable[start:end] = token

    return mutable.decode("utf-8", errors="ignore"), counters, "cloud_dlp"


def redact_pii(text: str, use_dlp: bool | None = None) -> dict[str, Any]:
    """Masque les données personnelles (DLP si configuré, sinon regex fallback).

    Retourne un dictionnaire contenant:
    - texte_masque: str
    - masquages: dict[str, int]
    - moteur: str ("cloud_dlp" ou "regex_fallback")
    """
    settings = get_settings()
    should_use_dlp = settings.use_dlp_api if use_dlp is None else use_dlp

    if should_use_dlp and settings.project_id:
        try:
            redacted, counts, engine = _redact_dlp(text, settings.project_id)
            return {"texte_masque": redacted, "masquages": counts, "moteur": engine}
        except Exception:
            pass

    redacted, counts, engine = _redact_regex(text)
    return {"texte_masque": redacted, "masquages": counts, "moteur": engine}
