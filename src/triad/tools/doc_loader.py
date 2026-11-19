"""Chargement et normalisation des documents Markdown, TXT et PDF avec préservation des sections."""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path
from typing import Any

ALLOWED_EXTENSIONS = {".md", ".txt", ".pdf"}
MAX_FILE_BYTES = 10 * 1024 * 1024  # 10 Mo

_UNICODE_SPACES_RE = re.compile(r"[\u00a0\u202f\u2007\u2009\u200a\ufeff]+")
_MULTI_HORIZONTAL_SPACE_RE = re.compile(r"[ \t]{2,}")
_MD_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
_PDF_SECTION_LINE_RE = re.compile(
    r"^(?:(§\s*\d+(?:\.\d+)*)\b\s*[-—:.]?\s*(.*)|"
    r"((?:CHAPITRE|ANNEXE|ARTICLE|SECTION)\s+[A-Z0-9IVX]+)\b\s*[-—:.]?\s*(.*)|"
    r"(\d+(?:\.\d+){1,3})\s+([A-ZÉÈÊÀÂÎÔÙÛÇ][^\n]{2,90}))$"
)
_SECTION_ID_RE = re.compile(r"(§\s*\d+(?:\.\d+)*)")


def clean_document_text(raw_text: str, *, is_pdf: bool = False) -> str:
    """Nettoie les espaces multiples tout en préservant les titres de sections Markdown/PDF."""
    if not raw_text:
        return ""

    text = unicodedata.normalize("NFC", raw_text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _UNICODE_SPACES_RE.sub(" ", text)

    if is_pdf:
        # Répare les césures de fin de ligne typiques de l'extraction PDF
        text = re.sub(r"([a-zà-ÿœæ])-\n[ \t]*([a-zà-ÿœæ])", r"\1\2", text)

    output_lines: list[str] = []
    for raw_line in text.split("\n"):
        collapsed = _MULTI_HORIZONTAL_SPACE_RE.sub(" ", raw_line).strip()
        if not collapsed:
            output_lines.append("")
            continue

        md_match = _MD_HEADING_RE.match(collapsed)
        if md_match:
            hashes, title = md_match.group(1), md_match.group(2).strip()
            if output_lines and output_lines[-1] != "":
                output_lines.append("")
            output_lines.append(f"{hashes} {title}")
            continue

        if is_pdf:
            pdf_sec = _PDF_SECTION_LINE_RE.match(collapsed)
            if pdf_sec:
                if pdf_sec.group(1):
                    sec_code = re.sub(r"\s+", "", pdf_sec.group(1))
                    rest = pdf_sec.group(2).strip()
                    level = "###" if "." in sec_code else "##"
                    heading_text = f"{sec_code} {rest}".strip()
                elif pdf_sec.group(3):
                    level = "##"
                    heading_text = f"{pdf_sec.group(3)} {pdf_sec.group(4)}".strip()
                else:
                    num_code = pdf_sec.group(5)
                    level = "###" if num_code.count(".") >= 1 else "##"
                    heading_text = f"§{num_code} {pdf_sec.group(6)}".strip()

                if output_lines and output_lines[-1] != "":
                    output_lines.append("")
                output_lines.append(f"{level} {heading_text}")
                continue

        output_lines.append(collapsed)

    joined = "\n".join(output_lines)
    joined = re.sub(r"\n{3,}", "\n\n", joined)
    return joined.strip()


def extract_sections(text: str) -> list[dict[str, Any]]:
    """Découpe un document nettoyé en sections indexées par leurs titres Markdown/PDF."""
    cleaned = clean_document_text(text)
    sections: list[dict[str, Any]] = []
    current_title = "Préambule"
    current_level = 0
    current_id: str | None = None
    buffer: list[str] = []

    def _flush() -> None:
        body = "\n".join(buffer).strip()
        if body or current_level > 0:
            sections.append(
                {
                    "level": current_level,
                    "title": current_title,
                    "section_id": current_id,
                    "content": body,
                }
            )

    for line in cleaned.split("\n"):
        md_match = _MD_HEADING_RE.match(line)
        if md_match:
            _flush()
            buffer = []
            current_level = len(md_match.group(1))
            current_title = md_match.group(2).strip()
            sec_match = _SECTION_ID_RE.search(current_title)
            current_id = re.sub(r"\s+", "", sec_match.group(1)) if sec_match else None
        else:
            buffer.append(line)

    _flush()
    return sections


def load_document(file_path: Path) -> str:
    """Charge un fichier brut (.md, .txt, .pdf), nettoie les espaces et préserve les titres."""
    ext = file_path.suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError(f"Extension non autorisée: {ext} (autorisées: .md, .txt, .pdf)")
    size = file_path.stat().st_size
    if size > MAX_FILE_BYTES:
        raise ValueError(f"Fichier trop volumineux ({size} octets > 5 Mo).")
    if ext == ".pdf":
        from pypdf import PdfReader

        reader = PdfReader(str(file_path))
        raw_pdf = "\n\n".join(page.extract_text() or "" for page in reader.pages)
        return clean_document_text(raw_pdf, is_pdf=True)

    raw_text = file_path.read_text(encoding="utf-8")
    return clean_document_text(raw_text, is_pdf=False)
