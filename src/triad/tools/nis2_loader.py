"""Chargement du référentiel NIS2 depuis data/referentiel_nis2.json."""

from __future__ import annotations

import json
from typing import Any

from triad.config import DATA_DIR


def get_nis2_requirements(theme: str | None = None) -> list[dict[str, Any]]:
    """Retourne les exigences NIS2, optionnellement filtrées par thème."""
    path = DATA_DIR / "referentiel_nis2.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    exigences: list[dict[str, Any]] = data.get("exigences", [])
    if not theme:
        return exigences
    theme_lower = theme.strip().lower()
    return [
        ex
        for ex in exigences
        if theme_lower in ex.get("theme", "").lower()
        or theme_lower in ex.get("article", "").lower()
    ]
