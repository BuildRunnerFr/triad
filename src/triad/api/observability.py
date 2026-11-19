"""Observabilité API : limiteur de débit à fenêtre glissante, collecteur de métriques et rendu Prometheus."""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from typing import Any

from triad.api.session_store import (
    sanitize_session_id,
)


class SlidingWindowRateLimiter:
    """Limiteur de débit glissant en mémoire par couple (session_id, IP)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._buckets: dict[str, deque[float]] = {}

    def check(self, key: str, max_requests: int, window_seconds: int) -> tuple[bool, int]:
        if max_requests <= 0 or window_seconds <= 0:
            return True, 0
        now = time.monotonic()
        cutoff = now - window_seconds
        with self._lock:
            q = self._buckets.setdefault(key, deque())
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= max_requests:
                retry_after = max(1, math.ceil(window_seconds - (now - q[0])))
                return False, retry_after
            q.append(now)
            return True, 0

    def clear_session(self, session_id: str) -> None:
        prefix = f"{sanitize_session_id(session_id)}:"
        with self._lock:
            for k in [k for k in self._buckets if k.startswith(prefix)]:
                self._buckets.pop(k, None)


class ApiMetricsCollector:
    """Collecteur léger et thread-safe des compteurs d'exécution, blocages et latences."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._started_at = time.monotonic()
        self.requests_total = 0
        self.requests_by_method: dict[str, int] = {}
        self.responses_by_status: dict[str, int] = {}
        self.blocked_codes: dict[str, int] = {"400": 0, "403": 0, "413": 0, "429": 0}
        self.security_violations = 0
        self.audits_executed = 0
        self.audits_by_mode: dict[str, int] = {"AVANT": 0, "APRES": 0}
        self.validations_total = 0
        self.uploads_total = 0
        self.exports_total = 0
        self.bundle_verifications_total = 0
        self._req_latency_sum_ms = 0.0
        self._req_latency_count = 0
        self._audit_latency_sum_ms = 0.0
        self._audit_latency_count = 0
        self._agent_sums_ms: dict[str, float] = {
            "Douanier": 0.0,
            "AnalysteConformite": 0.0,
            "ContreAuditeur": 0.0,
            "GardeDuCorps": 0.0,
        }
        self._agent_counts: dict[str, int] = {
            "Douanier": 0,
            "AnalysteConformite": 0,
            "ContreAuditeur": 0,
            "GardeDuCorps": 0,
        }

    def record_http(self, method: str, path: str, status_code: int, duration_ms: float) -> None:
        code_str = str(status_code)
        with self._lock:
            self.requests_total += 1
            self.requests_by_method[method] = self.requests_by_method.get(method, 0) + 1
            self.responses_by_status[code_str] = self.responses_by_status.get(code_str, 0) + 1
            if code_str in self.blocked_codes:
                self.blocked_codes[code_str] += 1
            if path.startswith("/api/export/") and status_code == 200:
                self.exports_total += 1
            if path != "/api/audit/stream":
                self._req_latency_sum_ms += duration_ms
                self._req_latency_count += 1

    def record_audit(
        self, mode: str, elapsed_seconds: float, timings_ms: dict[str, int]
    ) -> None:
        with self._lock:
            self.audits_executed += 1
            if mode in self.audits_by_mode:
                self.audits_by_mode[mode] += 1
            self._audit_latency_sum_ms += max(0.0, float(elapsed_seconds) * 1000.0)
            self._audit_latency_count += 1
            for ag, val in timings_ms.items():
                if ag in self._agent_sums_ms and isinstance(val, (int, float)):
                    self._agent_sums_ms[ag] += float(val)
                    self._agent_counts[ag] += 1

    def record_validation(self) -> None:
        with self._lock:
            self.validations_total += 1

    def record_upload(self) -> None:
        with self._lock:
            self.uploads_total += 1

    def record_bundle_verification(self) -> None:
        with self._lock:
            self.bundle_verifications_total += 1

    def record_security_violation(self) -> None:
        with self._lock:
            self.security_violations += 1

    def snapshot(self, active_sessions: int, max_req: int, window_sec: int) -> dict[str, Any]:
        with self._lock:
            avg_req = (
                round(self._req_latency_sum_ms / self._req_latency_count, 2)
                if self._req_latency_count
                else 0.0
            )
            avg_audit = (
                round(self._audit_latency_sum_ms / self._audit_latency_count, 2)
                if self._audit_latency_count
                else 0.0
            )
            avg_agents: dict[str, float | None] = {
                ag: (
                    round(self._agent_sums_ms[ag] / self._agent_counts[ag], 2)
                    if self._agent_counts[ag]
                    else None
                )
                for ag in self._agent_sums_ms
            }
            blocked_copy = dict(self.blocked_codes)
            total_blocked = sum(blocked_copy.values()) + self.security_violations
            return {
                "status": "ok",
                "uptime_seconds": round(time.monotonic() - self._started_at, 2),
                "requests_total": self.requests_total,
                "requests_by_method": dict(self.requests_by_method),
                "responses_by_status": dict(self.responses_by_status),
                "audits_executed": self.audits_executed,
                "audits_by_mode": dict(self.audits_by_mode),
                "validations_total": self.validations_total,
                "uploads_total": self.uploads_total,
                "exports_total": self.exports_total,
                "bundle_verifications_total": self.bundle_verifications_total,
                "blocked": {
                    **blocked_copy,
                    "security_violations": self.security_violations,
                    "total": total_blocked,
                },
                "latency_ms": {
                    "avg_request_ms": avg_req,
                    "avg_audit_ms": avg_audit,
                    "avg_agent_timings_ms": avg_agents,
                },
                "active_persisted_sessions": active_sessions,
                "rate_limit": {
                    "max_requests": max_req,
                    "window_seconds": window_sec,
                },
            }


def _prom_escape_label(val: str) -> str:
    return val.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def render_prometheus_metrics(snap: dict[str, Any]) -> str:
    """Sérialise l'instantané de télémétrie au format texte Prometheus 0.0.4 / OpenMetrics."""
    lines: list[str] = [
        "# HELP triad_uptime_seconds Duree de fonctionnement du service TRIAD en secondes.",
        "# TYPE triad_uptime_seconds gauge",
        f"triad_uptime_seconds {snap['uptime_seconds']}",
        "# HELP triad_http_requests_total Nombre total de requetes HTTP traitees.",
        "# TYPE triad_http_requests_total counter",
        f"triad_http_requests_total {snap['requests_total']}",
        "# HELP triad_http_requests_by_method_total Nombre de requetes HTTP par methode.",
        "# TYPE triad_http_requests_by_method_total counter",
    ]
    for method, count in sorted(snap.get("requests_by_method", {}).items()):
        lines.append(
            f'triad_http_requests_by_method_total{{method="{_prom_escape_label(str(method))}"}} {count}'
        )

    lines.extend(
        [
            "# HELP triad_http_responses_total Nombre de reponses HTTP par code statut.",
            "# TYPE triad_http_responses_total counter",
        ]
    )
    for status, count in sorted(snap.get("responses_by_status", {}).items()):
        lines.append(
            f'triad_http_responses_total{{status="{_prom_escape_label(str(status))}"}} {count}'
        )

    lines.extend(
        [
            "# HELP triad_audits_executed_total Nombre total d'audits NIS2 executes.",
            "# TYPE triad_audits_executed_total counter",
            f"triad_audits_executed_total {snap['audits_executed']}",
            "# HELP triad_audits_by_mode_total Nombre d'audits executes par mode (AVANT/APRES).",
            "# TYPE triad_audits_by_mode_total counter",
        ]
    )
    for mode_key, count in sorted(snap.get("audits_by_mode", {}).items()):
        lines.append(
            f'triad_audits_by_mode_total{{mode="{_prom_escape_label(str(mode_key))}"}} {count}'
        )

    lines.extend(
        [
            "# HELP triad_validations_total Nombre de validations humaines (Garde du Corps).",
            "# TYPE triad_validations_total counter",
            f"triad_validations_total {snap['validations_total']}",
            "# HELP triad_uploads_total Nombre de televersements documentaires valides.",
            "# TYPE triad_uploads_total counter",
            f"triad_uploads_total {snap['uploads_total']}",
            "# HELP triad_exports_total Nombre d'exports scelles servis apres validation.",
            "# TYPE triad_exports_total counter",
            f"triad_exports_total {snap['exports_total']}",
            "# HELP triad_bundle_verifications_total Nombre de dossiers ZIP verifies via l'API forensique.",
            "# TYPE triad_bundle_verifications_total counter",
            f"triad_bundle_verifications_total {snap.get('bundle_verifications_total', 0)}",
            "# HELP triad_blocked_requests_total Nombre de requetes bloquees par motif de securite.",
            "# TYPE triad_blocked_requests_total counter",
        ]
    )
    blocked = snap.get("blocked", {})
    for reason in ("400", "403", "413", "429", "security_violations"):
        lines.append(
            f'triad_blocked_requests_total{{reason="{reason}"}} {blocked.get(reason, 0)}'
        )

    lat = snap.get("latency_ms", {})
    lines.extend(
        [
            "# HELP triad_request_latency_avg_ms Latence moyenne des requetes HTTP en millisecondes.",
            "# TYPE triad_request_latency_avg_ms gauge",
            f"triad_request_latency_avg_ms {lat.get('avg_request_ms', 0.0)}",
            "# HELP triad_audit_latency_avg_ms Latence moyenne d'execution du pipeline d'audit en millisecondes.",
            "# TYPE triad_audit_latency_avg_ms gauge",
            f"triad_audit_latency_avg_ms {lat.get('avg_audit_ms', 0.0)}",
            "# HELP triad_agent_latency_avg_ms Latence moyenne par agent ADK en millisecondes.",
            "# TYPE triad_agent_latency_avg_ms gauge",
        ]
    )
    for agent_name, avg_val in sorted((lat.get("avg_agent_timings_ms") or {}).items()):
        num_val = float(avg_val) if isinstance(avg_val, (int, float)) else 0.0
        lines.append(
            f'triad_agent_latency_avg_ms{{agent="{_prom_escape_label(str(agent_name))}"}} {num_val}'
        )

    rl = snap.get("rate_limit", {})
    lines.extend(
        [
            "# HELP triad_active_persisted_sessions Nombre de sessions persistees sur disque.",
            "# TYPE triad_active_persisted_sessions gauge",
            f"triad_active_persisted_sessions {snap['active_persisted_sessions']}",
            "# HELP triad_rate_limit_config Parametres du limiteur de debit anti-abus.",
            "# TYPE triad_rate_limit_config gauge",
            f'triad_rate_limit_config{{param="max_requests"}} {rl.get("max_requests", 0)}',
            f'triad_rate_limit_config{{param="window_seconds"}} {rl.get("window_seconds", 0)}',
        ]
    )
    return "\n".join(lines) + "\n"
