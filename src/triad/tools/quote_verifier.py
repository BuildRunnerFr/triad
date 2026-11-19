"""Vérification déterministe des citations (Python pur, normalisation typographique et sections)."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from triad.tools.doc_loader import extract_sections

_OUTER_QUOTES_CHARS = "«»\"'“”„‹› \t\n"
_MD_DECORATION_RE = re.compile(r"(?:\*{1,2}|_{1,2}|`|^>\s*)", re.MULTILINE)


def _normalize(text: str, *, strip_markdown: bool = False) -> str:
    normalized = unicodedata.normalize("NFC", text)
    normalized = (
        normalized.replace("’", "'")
        .replace("‘", "'")
        .replace("“", '"')
        .replace("”", '"')
        .replace("\u2011", "-")
        .replace("\u2013", "-")
    )
    if strip_markdown:
        normalized = _MD_DECORATION_RE.sub("", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip().lower()
    return normalized


def _find_matching_section(content: str, norm_extrait: str) -> str | None:
    for sec in extract_sections(content):
        haystack = f"{sec['title']} {sec['content']}"
        if norm_extrait in _normalize(haystack, strip_markdown=True):
            return str(sec["section_id"] or sec["title"])
    return None


def verify_quote(
    source: str,
    extrait: str,
    documents: dict[str, str],
) -> dict[str, Any]:
    """Vérifie qu'un extrait existe mot pour mot (espaces/typographie/casse normalisés) dans la source."""
    if not source or not extrait or not extrait.strip():
        return {"verifie": False, "raison": "Source ou extrait vide."}

    content = documents.get(source)
    if content is None:
        # Tolérance sur le chemin relatif vs nom de fichier
        for doc_name, doc_content in documents.items():
            if doc_name.endswith(source) or source.endswith(doc_name):
                content = doc_content
                break

    if content is None:
        return {"verifie": False, "raison": f"Document source introuvable: {source}"}

    cleaned_extrait = extrait.strip().strip(_OUTER_QUOTES_CHARS)
    norm_extrait = _normalize(cleaned_extrait)
    norm_content = _normalize(content)
    found = bool(norm_extrait) and (norm_extrait in norm_content)

    if not found:
        # Seconde passe sans décorateurs Markdown inline (**gras**, > citation) mais mots stricts
        norm_extrait_md = _normalize(cleaned_extrait, strip_markdown=True)
        norm_content_md = _normalize(content, strip_markdown=True)
        found = bool(norm_extrait_md) and (norm_extrait_md in norm_content_md)
        if found:
            norm_extrait = norm_extrait_md

    matched_section = _find_matching_section(content, norm_extrait) if found else None

    return {
        "verifie": found,
        "source": source,
        "section": matched_section,
        "raison": (
            "Correspondance exacte confirmée."
            if found
            else "Extrait introuvable dans la source."
        ),
    }
