"""Agent 4 : Garde du Corps (Security Guardian) — Assemble la synthèse et bloque l'export avant validation."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, AsyncGenerator, Callable

from google.adk.agents import BaseAgent
from google.adk.agents.invocation_context import InvocationContext
from google.adk.events import Event, EventActions
from google.genai import types
from pydantic import PrivateAttr

from triad.models import AuditSynthesis, Finding, SanitizedDocument
from triad.security.audit_log import AuditLogger, verify_chain


class GardeDuCorpsAgent(BaseAgent):
    """Assemble la synthèse finale sous statut EN ATTENTE DE VALIDATION."""

    _audit_logger: AuditLogger = PrivateAttr()
    _before_tool_cb: Callable[..., Any] | None = PrivateAttr(default=None)
    _status_cb: Callable[[str, str], None] | None = PrivateAttr(default=None)

    def __init__(
        self,
        audit_logger: AuditLogger,
        before_tool_callback: Callable[..., Any] | None = None,
        status_callback: Callable[[str, str], None] | None = None,
    ) -> None:
        super().__init__(
            name="GardeDuCorps",
            description="Assemble la synthèse finale et verrouille l'export jusqu'à validation humaine.",
        )
        self._audit_logger = audit_logger
        self._before_tool_cb = before_tool_callback
        self._status_cb = status_callback

    def _check_tool(self, tool_name: str, args: dict[str, Any], ctx: InvocationContext) -> bool:
        if self._before_tool_cb is None:
            return True
        tool_ctx = SimpleNamespace(
            agent_name=self.name,
            state=ctx.session.state,
            actions=SimpleNamespace(escalate=False),
        )
        res = self._before_tool_cb(SimpleNamespace(name=tool_name), args, tool_ctx)
        return not (res and res.get("violation"))

    async def _run_async_impl(self, ctx: InvocationContext) -> AsyncGenerator[Event, None]:
        if self._status_cb:
            self._status_cb(self.name, "en_cours")

        if not self._check_tool("assemble_synthesis", {}, ctx):
            if self._status_cb:
                self._status_cb(self.name, "bloqué")
            return

        verified_raw: list[dict[str, Any]] = ctx.session.state.get("verified_findings", [])
        challenge: dict[str, Any] = ctx.session.state.get("challenge_output", {})
        sanitized = [
            SanitizedDocument.model_validate(d)
            for d in ctx.session.state.get("sanitized_docs", [])
        ]
        quarantined = [
            SanitizedDocument.model_validate(d)
            for d in ctx.session.state.get("quarantined_docs", [])
        ]
        findings = [Finding.model_validate(f) for f in verified_raw]

        synthesis = AuditSynthesis(
            client=ctx.session.state.get("client", "Centre Hospitalier de Valmont"),
            mode=ctx.session.state.get("mode", "APRES"),
            statut_validation="EN ATTENTE DE VALIDATION",
            findings=findings,
            top_3_risques=challenge.get("top_3_risques", []),
            questions_entretien=challenge.get("questions_entretien", []),
            mail_suivi=challenge.get("mail_suivi", ""),
            documents_nettoyes=sanitized,
            documents_quarantaine=quarantined,
        )

        if not self._check_tool("verify_chain", {}, ctx):
            if self._status_cb:
                self._status_cb(self.name, "bloqué")
            return

        chain_status = verify_chain(self._audit_logger.log_path)
        self._audit_logger.append(
            agent=self.name,
            action="SYNTHESIS_READY",
            details={
                "statut": synthesis.statut_validation,
                "nb_findings": len(findings),
                "chain_valide": chain_status["valide"],
            },
        )

        ctx.session.state["synthesis"] = synthesis.model_dump()

        if self._status_cb:
            self._status_cb(self.name, "terminé")

        yield Event(
            author=self.name,
            content=types.Content(
                role="model",
                parts=[
                    types.Part(
                        text=f"GardeDuCorps : synthèse assemblée ({synthesis.statut_validation})."
                    )
                ],
            ),
            actions=EventActions(
                state_delta={"synthesis": synthesis.model_dump()}
            ),
        )
