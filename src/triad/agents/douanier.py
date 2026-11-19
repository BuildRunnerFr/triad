"""Agent 1 : Douanier (Gatekeeper) — Seul agent autorisé à lire les fichiers bruts."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, AsyncGenerator, Callable

from google.adk.agents import BaseAgent
from google.adk.agents.invocation_context import InvocationContext
from google.adk.events import Event, EventActions
from google.genai import types
from pydantic import PrivateAttr

from triad.models import SanitizedDocument
from triad.tools.doc_loader import ALLOWED_EXTENSIONS, MAX_FILE_BYTES, load_document
from triad.tools.injection_detector import scan_injection
from triad.tools.pii_redactor import redact_pii


def _read_raw_file(file_path: Path) -> str:
    return load_document(file_path)


def _infer_source_type(filename: str) -> str:
    lower = filename.lower()
    if "entretien" in lower or "interview" in lower or "dit" in lower:
        return "dit"
    return "ecrit"


class DouanierAgent(BaseAgent):
    """Contrôle, masque (PII) et filtre (prompt injection) chaque document entrant."""

    _before_tool_cb: Callable[..., Any] | None = PrivateAttr(default=None)
    _status_cb: Callable[[str, str], None] | None = PrivateAttr(default=None)

    def __init__(
        self,
        before_tool_callback: Callable[..., Any] | None = None,
        status_callback: Callable[[str, str], None] | None = None,
    ) -> None:
        super().__init__(
            name="Douanier",
            description="Contrôle les fichiers bruts, masque les PII et met en quarantaine les injections.",
        )
        self._before_tool_cb = before_tool_callback
        self._status_cb = status_callback

    def _check_tool(self, tool_name: str, args: dict[str, Any], ctx: InvocationContext) -> bool:
        if self._before_tool_cb is None:
            return True
        from types import SimpleNamespace

        tool_ctx = SimpleNamespace(
            agent_name=self.name,
            state=ctx.session.state,
            actions=SimpleNamespace(escalate=False),
        )
        res = self._before_tool_cb(SimpleNamespace(name=tool_name), args, tool_ctx)
        if res and res.get("violation"):
            return False
        return True

    async def _run_async_impl(self, ctx: InvocationContext) -> AsyncGenerator[Event, None]:
        if self._status_cb:
            self._status_cb(self.name, "en_cours")

        input_files: list[str] = list(ctx.session.state.get("input_files", []))
        mode: str = ctx.session.state.get("mode", "APRES")
        sanitized_docs: list[dict[str, Any]] = []
        quarantined_docs: list[dict[str, Any]] = []

        # Étape 1 : lecture + masquage PII avant toute décision de quarantaine
        staged: list[tuple[Path, str, dict[str, int]]] = []
        for raw_path_str in input_files:
            path = Path(raw_path_str)
            if mode == "AVANT" and _infer_source_type(path.name) == "dit":
                continue

            if not self._check_tool("read_raw_file", {"fichier": path.name}, ctx):
                if self._status_cb:
                    self._status_cb(self.name, "bloqué")
                return
            try:
                raw_text = _read_raw_file(path)
            except Exception as exc:
                q_doc = SanitizedDocument(
                    nom_fichier=path.name,
                    type_source=_infer_source_type(path.name),  # type: ignore[arg-type]
                    contenu_masque="",
                    statut="quarantaine",
                    raison_quarantaine=f"Fichier rejeté: {exc}",
                )
                quarantined_docs.append(q_doc.model_dump())
                continue

            if not self._check_tool("redact_pii", {"fichier": path.name}, ctx):
                return
            redaction = redact_pii(raw_text)
            staged.append((path, redaction["texte_masque"], redaction["masquages"]))
            if not self._check_tool("scan_injection", {"fichier": path.name}, ctx):
                return

        # Étape 2 : scan d'injection en parallèle sans bloquer la boucle asyncio
        scans = list(
            await asyncio.gather(
                *(asyncio.to_thread(scan_injection, item[1], True) for item in staged)
            )
        )

        for (path, masked_text, masquages), scan in zip(staged, scans):
            if scan["suspect"]:
                if not self._check_tool("quarantine_file", {"fichier": path.name}, ctx):
                    return
                q_doc = SanitizedDocument(
                    nom_fichier=path.name,
                    type_source=_infer_source_type(path.name),  # type: ignore[arg-type]
                    contenu_masque=masked_text,
                    masquages=masquages,
                    statut="quarantaine",
                    raison_quarantaine=scan["raison"],
                    extrait_quarantaine=scan.get("extrait_suspect"),
                )
                quarantined_docs.append(q_doc.model_dump())
            else:
                if not self._check_tool("emit_sanitized_doc", {"fichier": path.name}, ctx):
                    return
                s_doc = SanitizedDocument(
                    nom_fichier=path.name,
                    type_source=_infer_source_type(path.name),  # type: ignore[arg-type]
                    contenu_masque=masked_text,
                    masquages=masquages,
                    statut="nettoye",
                )
                sanitized_docs.append(s_doc.model_dump())

        ctx.session.state["sanitized_docs"] = sanitized_docs
        ctx.session.state["quarantined_docs"] = quarantined_docs

        if self._status_cb:
            self._status_cb(self.name, "terminé")

        summary = (
            f"Douanier terminé : {len(sanitized_docs)} document(s) nettoyé(s), "
            f"{len(quarantined_docs)} en quarantaine."
        )
        yield Event(
            author=self.name,
            content=types.Content(role="model", parts=[types.Part(text=summary)]),
            actions=EventActions(
                state_delta={
                    "sanitized_docs": sanitized_docs,
                    "quarantined_docs": quarantined_docs,
                }
            ),
        )
