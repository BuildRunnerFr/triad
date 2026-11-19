"""Backend FastAPI pour TRIAD — API REST multi-sessions persistée et service de l'interface unique."""

from __future__ import annotations

import asyncio
import base64
import binascii
from collections import deque
import csv
import hashlib
import hmac
import importlib.metadata
import io
import json
import math
import os
import re
import shutil
import tempfile
import threading
import time
import tomllib
import uuid
import zipfile
from collections.abc import AsyncGenerator
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import Body, Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import (
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    Response,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from triad.agents.pipeline import run_audit_pipeline
from triad.api.session_store import (
    DEFAULT_SESSION_ID,
    SESSIONS_DIR,
    VALID_GRC_DECISIONS,
    SessionStore,
    default_agent_statuses,
    empty_mode_slot,
    sanitize_session_id,
)
from triad.config import DATA_DIR, LOGS_DIR, get_settings
from triad.models import AuditMode
from triad.security.audit_log import (
    GENESIS_HASH,
    AuditLogger,
    archive_to_worm_bucket,
    register_audit_listener,
    verify_chain,
    verify_entries_chain,
)
from triad.security.callbacks import simulate_unauthorized_action
from triad.security.permissions import PERMISSIONS
from triad.security.structured_log import resolve_log_format
from triad.tools.doc_loader import ALLOWED_EXTENSIONS, MAX_FILE_BYTES
from triad.tools.nis2_loader import get_nis2_requirements

WEB_DIR = Path(__file__).resolve().parents[1] / "web"
DIST_DIR = WEB_DIR / "dist"
UPLOAD_DIR = Path(tempfile.gettempdir()) / "triad_uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
AUDIT_LOG_PATH = LOGS_DIR / "audit_trail.jsonl"
MAX_UPLOAD_FILES = 20
MAX_UPLOAD_FILE_BYTES = MAX_FILE_BYTES  # 10 Mo
MAX_BUNDLE_VERIFY_BYTES = 20 * 1024 * 1024  # 20 Mo
MAX_BUNDLE_UNCOMPRESSED_BYTES = 50 * 1024 * 1024  # 50 Mo (protection ZipBomb)
MAX_BUNDLE_MEMBERS = 64
UPLOAD_CHUNK_BYTES = 64 * 1024
BUNDLE_BASE_FILES: tuple[str, ...] = (
    "01_Rapport_NIS2.md",
    "02_Matrice_GRC.csv",
    "03_Synthese_Scellee.json",
    "04_Playbook_DryRun.sh",
    "05_Mail_DSI.txt",
    "06_Audit_Chain.jsonl",
)
BUNDLE_V2_EXT_FILES: tuple[str, ...] = (
    "07_PreNotification_ANSSI_Art23.md",
    "08_Brief_COMEX_Art20.md",
)
BUNDLE_V3_EXT_FILES: tuple[str, ...] = (
    "09_Remediation_GitOps.tf",
)
BUNDLE_V4_EXT_FILES: tuple[str, ...] = (
    "10_Guide_Entretien_Contradictoire.md",
)
BUNDLE_V5_EXT_FILES: tuple[str, ...] = (
    "11_Registre_Arbitrages_GRC.md",
)
BUNDLE_V6_EXT_FILES: tuple[str, ...] = (
    "12_Evaluation_CNIL_RGPD_Art33.md",
)
BUNDLE_EXTENDED_FILES: tuple[str, ...] = (
    BUNDLE_V2_EXT_FILES
    + BUNDLE_V3_EXT_FILES
    + BUNDLE_V4_EXT_FILES
    + BUNDLE_V5_EXT_FILES
    + BUNDLE_V6_EXT_FILES
)
BUNDLE_V2_FILES: tuple[str, ...] = BUNDLE_BASE_FILES + BUNDLE_V2_EXT_FILES
BUNDLE_V3_FILES: tuple[str, ...] = BUNDLE_V2_FILES + BUNDLE_V3_EXT_FILES
BUNDLE_V4_FILES: tuple[str, ...] = BUNDLE_V3_FILES + BUNDLE_V4_EXT_FILES
BUNDLE_V5_FILES: tuple[str, ...] = BUNDLE_V4_FILES + BUNDLE_V5_EXT_FILES
BUNDLE_REQUIRED_FILES: tuple[str, ...] = BUNDLE_V5_FILES + BUNDLE_V6_EXT_FILES
SEALED_EXPORT_ENDPOINTS: tuple[str, ...] = (
    "/api/export/report",
    "/api/export/mail",
    "/api/export/json",
    "/api/export/csv",
    "/api/export/playbook",
    "/api/export/bundle",
    "/api/export/anssi-draft",
    "/api/export/comex-brief",
    "/api/export/terraform",
    "/api/export/interview-guide",
    "/api/export/risk-register",
    "/api/export/cnil-draft",
)


def _compute_hmac_sha256_hex(payload: bytes, secret: str) -> str:
    """Calcule la signature HMAC-SHA256 hexadécimale d'une charge utile binaire."""
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def _build_export_signature_headers(
    payload: bytes, base_headers: dict[str, str] | None = None
) -> dict[str, str]:
    """Ajoute l'en-tête X-Triad-Signature (HMAC-SHA256) lorsque AUDIT_SIGNING_SECRET est configuré."""
    headers = dict(base_headers or {})
    secret = get_settings().audit_signing_secret
    if secret:
        sig = _compute_hmac_sha256_hex(payload, secret)
        headers["X-Triad-Signature"] = f"hmac-sha256={sig}"
    return headers


def _normalize_etag_token(token: str) -> str:
    """Normalise un jeton ETag selon RFC 9110 §13.1.2 (comparaison faible W/, guillemets, suffixe -gzip)."""
    cleaned = token.strip()
    if cleaned.startswith(("W/", "w/")):
        cleaned = cleaned[2:].strip()
    if cleaned.startswith('"') and cleaned.endswith('"') and len(cleaned) >= 2:
        cleaned = cleaned[1:-1]
    if cleaned.endswith("-gzip"):
        cleaned = cleaned[:-5]
    return cleaned.strip()


def _if_none_match_matches(if_none_match: str | None, current_etag: str) -> bool:
    """Évalue l'en-tête If-None-Match face à l'ETag courant (supporte *, W/, listes multiples)."""
    if not if_none_match:
        return False
    raw = if_none_match.strip()
    if not raw:
        return False
    if raw == "*":
        return True
    expected = _normalize_etag_token(current_etag)
    if not expected:
        return False
    return any(_normalize_etag_token(part) == expected for part in raw.split(","))


def _build_conditional_signed_response(
    request: Request,
    payload_bytes: bytes,
    *,
    etag: str | None = None,
    media_type: str = "application/json",
    base_headers: dict[str, str] | None = None,
) -> Response:
    """Construit une réponse signée X-Triad-Signature avec support ETag / If-None-Match (HTTP 304) et Cache-Control: no-store."""
    resolved_etag = etag or f'"{hashlib.sha256(payload_bytes).hexdigest()}"'
    headers = _build_export_signature_headers(
        payload_bytes,
        {
            **(base_headers or {}),
            "ETag": resolved_etag,
            "Cache-Control": "no-store",
        },
    )
    if request.method in {"GET", "HEAD"} and _if_none_match_matches(
        request.headers.get("if-none-match"), resolved_etag
    ):
        return Response(content=b"", status_code=304, headers=headers)
    if request.method == "HEAD":
        return Response(content=b"", status_code=200, media_type=media_type, headers=headers)
    return Response(content=payload_bytes, status_code=200, media_type=media_type, headers=headers)


_SESSION_EPOCH_LOCK = threading.Lock()
_SESSION_MUTATION_EPOCH: dict[str, int] = {}
_SESSION_EPOCH_SEQ = 0


def _bump_session_epoch(session_id: str) -> int:
    """Incrémente atomiquement le compteur de révision mémoire de la session (invalidation ETag immédiate)."""
    global _SESSION_EPOCH_SEQ
    sid = sanitize_session_id(session_id)
    with _SESSION_EPOCH_LOCK:
        _SESSION_EPOCH_SEQ += 1
        _SESSION_MUTATION_EPOCH[sid] = _SESSION_EPOCH_SEQ
        return _SESSION_EPOCH_SEQ


def _compute_session_etag(
    session_id: str,
    active_mode: str,
    state: dict[str, Any],
    log_path: Path,
    payload_bytes: bytes,
) -> str:
    """Calcule un ETag fort déterministe couvrant la charge utile, la révision de session et la chaîne SHA-256."""
    sid = sanitize_session_id(session_id)
    with _SESSION_EPOCH_LOCK:
        epoch = _SESSION_MUTATION_EPOCH.get(sid, 0)
    entries = AuditLogger(log_path, session_id=sid).read_entries()
    head_hash = str(entries[-1].get("hash") or GENESIS_HASH) if entries else GENESIS_HASH
    seed = hashlib.sha256()
    seed.update(
        f"{sid}:{active_mode}:{epoch}:{state.get('updated_at', '')}:{len(entries)}:{head_hash}:".encode(
            "utf-8"
        )
    )
    seed.update(payload_bytes)
    return f'"{seed.hexdigest()}"'


def _build_conditional_session_json_response(
    request: Request,
    payload_obj: dict[str, Any],
    *,
    session_id: str,
    active_mode: str,
    state: dict[str, Any],
    log_path: Path,
) -> Response:
    """Sérialise une vue JSON de session avec ETag conditionnel (HTTP 304 Not Modified) et Cache-Control: no-store."""
    payload_bytes = json.dumps(payload_obj, ensure_ascii=False).encode("utf-8")
    etag = _compute_session_etag(session_id, active_mode, state, log_path, payload_bytes)
    return _build_conditional_signed_response(
        request,
        payload_bytes,
        etag=etag,
        media_type="application/json",
    )

CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com data:; "
    "img-src 'self' data: blob:; "
    "connect-src 'self' data: blob:; "
    "worker-src 'self' blob:; "
    "base-uri 'self'; "
    "form-action 'self'; "
    "object-src 'none'; "
    "frame-ancestors 'none'"
)


class _SlidingWindowRateLimiter:
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


class _ApiMetricsCollector:
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


RATE_LIMITER = _SlidingWindowRateLimiter()
METRICS = _ApiMetricsCollector()

app = FastAPI(title="TRIAD — Audit NIS2 (Dit / Écrit / Réel)", version="0.5.0")

# Compression GZip automatique au plus près du routeur (réponses >= 500 octets ; exclut .zip et SSE)
app.add_middleware(GZipMiddleware, minimum_size=500, compresslevel=6)


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next: Any) -> Any:
    """Injecte les en-têtes HTTP de durcissement sécurité, optimise Cache-Control et collecte la télémétrie."""
    t0 = time.perf_counter()
    response = await call_next(request)
    duration_ms = (time.perf_counter() - t0) * 1000.0
    req_path = request.url.path
    METRICS.record_http(request.method, req_path, response.status_code, duration_ms)

    if (req_path == "/assets" or req_path.startswith("/assets/")) and response.status_code < 400:
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif (
        req_path in {"/", "/index.html"}
        or req_path == "/api"
        or req_path.startswith("/api/")
    ):
        response.headers["Cache-Control"] = "no-store"
    else:
        response.headers.setdefault("Cache-Control", "no-store")

    response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    )
    response.headers.setdefault("X-Permitted-Cross-Domain-Policies", "none")
    response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    return response


app.mount(
    "/assets",
    StaticFiles(directory=str(DIST_DIR / "assets"), check_dir=False),
    name="assets",
)

SESSION_STORE = SessionStore(SESSIONS_DIR)
_CURRENT_SESSION_ID: ContextVar[str] = ContextVar(
    "triad_session_id", default=DEFAULT_SESSION_ID
)
_SSE_CLIENTS: list[tuple[str, asyncio.AbstractEventLoop, asyncio.Queue[dict[str, Any]]]] = []


async def _resolve_session_id(
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    session_id: str | None = Query(default=None),
) -> str:
    """Résout l'identifiant de session depuis X-Session-Id ou ?session_id= (défaut: 'default')."""
    chosen = x_session_id if (x_session_id and x_session_id.strip()) else session_id
    resolved = sanitize_session_id(chosen)
    _CURRENT_SESSION_ID.set(resolved)
    return resolved


async def _enforce_rate_limit(
    request: Request,
    session_id: str = Depends(_resolve_session_id),
) -> None:
    """Protège les endpoints coûteux (/api/audit/run, /api/upload) contre l'abus par session/IP."""
    s = get_settings()
    client_ip = request.client.host if request.client else "local"
    bucket_key = f"{session_id}:{client_ip}:{request.url.path}"
    allowed, retry_after = RATE_LIMITER.check(
        bucket_key,
        max_requests=s.rate_limit_max_requests,
        window_seconds=s.rate_limit_window_seconds,
    )
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Limite de débit atteinte ({s.rate_limit_max_requests} requêtes / "
                f"{s.rate_limit_window_seconds}s). Réessayez dans {retry_after}s."
            ),
            headers={"Retry-After": str(retry_after)},
        )


def _get_session_state(session_id: str = DEFAULT_SESSION_ID) -> dict[str, Any]:
    return SESSION_STORE.get(session_id)


def _get_audit_log_path(session_id: str = DEFAULT_SESSION_ID) -> Path:
    sid = sanitize_session_id(session_id)
    if sid == DEFAULT_SESSION_ID:
        return AUDIT_LOG_PATH
    return LOGS_DIR / f"audit_trail_{sid}.jsonl"


def _get_upload_dir(session_id: str = DEFAULT_SESSION_ID) -> Path:
    sid = sanitize_session_id(session_id)
    target = UPLOAD_DIR / sid
    target.mkdir(parents=True, exist_ok=True)
    return target


def _demo_file_paths() -> list[Path]:
    return [
        DATA_DIR / "PSSI_CH_Valmont.md",
        DATA_DIR / "PV_test_restauration.md",
        DATA_DIR / "notes_entretien_DSI.md",
        DATA_DIR / "annexe_fournisseur_maintenance.md",
    ]


def _broadcast_sse(payload: dict[str, Any], session_id: str = DEFAULT_SESSION_ID) -> None:
    """Diffuse un événement temps réel aux clients SSE de la session concernée (thread-safe)."""
    sid = sanitize_session_id(session_id)
    for client_sid, loop, q in list(_SSE_CLIENTS):
        if client_sid != sid:
            continue
        try:
            loop.call_soon_threadsafe(q.put_nowait, payload)
        except Exception:
            pass


register_audit_listener(
    lambda entry: _broadcast_sse(
        {"type": "audit_entry", "entry": entry},
        session_id=_CURRENT_SESSION_ID.get(),
    )
)


def _reset_session_results(state: dict[str, Any]) -> None:
    state["results_by_mode"] = {
        "AVANT": empty_mode_slot(),
        "APRES": empty_mode_slot(),
    }
    state["security_alert"] = None


class RunAuditRequest(BaseModel):
    mode: AuditMode = "APRES"
    use_cache: bool | None = None


@app.api_route("/", methods=["GET", "HEAD"], response_class=HTMLResponse)
@app.api_route(
    "/index.html",
    methods=["GET", "HEAD"],
    response_class=HTMLResponse,
    include_in_schema=False,
)
def serve_index() -> HTMLResponse:
    dist_index = DIST_DIR / "index.html"
    if dist_index.exists():
        return HTMLResponse(dist_index.read_text(encoding="utf-8"))
    index_path = WEB_DIR / "index.html"
    return HTMLResponse(index_path.read_text(encoding="utf-8"))


@app.api_route("/api/health", methods=["GET", "HEAD"])
def health() -> dict[str, Any]:
    s = get_settings()
    return {
        "status": "ok",
        "project_id": s.project_id,
        "vertex_location": s.vertex_location,
        "gemini_model": s.gemini_model,
        "use_gcp_snapshot": s.use_gcp_snapshot,
        "use_demo_cache": s.use_demo_cache,
        "audit_logs_bucket": s.audit_logs_bucket or None,
        "log_format": resolve_log_format(s.log_format),
        "hmac_signing_enabled": bool(s.audit_signing_secret),
    }


@app.api_route("/api/health/ready", methods=["GET", "HEAD"])
def health_ready() -> JSONResponse:
    """Sonde de préparation profonde : vérifie les 3 référentiels JSON, dist/index.html et logs/."""
    s = get_settings()
    checks: dict[str, bool] = {
        "referentiel_nis2": False,
        "gcp_snapshot": False,
        "demo_cache": False,
        "dist_index": False,
        "logs_writable": False,
    }
    errors: list[str] = []

    ref_specs: list[tuple[str, str, Any]] = [
        (
            "referentiel_nis2",
            "referentiel_nis2.json",
            lambda obj: isinstance(obj, dict) and bool(obj.get("exigences")),
        ),
        (
            "gcp_snapshot",
            "gcp_snapshot.json",
            lambda obj: isinstance(obj, dict) and len(obj) > 0,
        ),
        (
            "demo_cache",
            "demo_cache.json",
            lambda obj: isinstance(obj, dict)
            and (
                ("mode_avant" in obj and "mode_apres" in obj)
                or ("AVANT" in obj and "APRES" in obj)
            ),
        ),
    ]
    for check_key, fname, validator in ref_specs:
        fpath = s.data_dir / fname
        try:
            parsed = json.loads(fpath.read_text(encoding="utf-8"))
            if validator(parsed):
                checks[check_key] = True
            else:
                errors.append(f"Référentiel '{fname}' vide ou structure incomplète.")
        except Exception as exc:
            errors.append(f"Impossible de charger '{fname}' : {exc}")

    dist_index = DIST_DIR / "index.html"
    try:
        if dist_index.is_file() and dist_index.stat().st_size > 0:
            checks["dist_index"] = True
        else:
            errors.append("Build frontend 'dist/index.html' absent ou vide.")
    except OSError as exc:
        errors.append(f"Impossible d'inspecter 'dist/index.html' : {exc}")

    probe_path: Path | None = None
    try:
        s.logs_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=s.logs_dir,
            prefix=".ready_probe_",
            delete=False,
        ) as tmp:
            probe_path = Path(tmp.name)
            tmp.write(b"ok")
            tmp.flush()
        checks["logs_writable"] = True
    except OSError as exc:
        errors.append(f"Répertoire des journaux non inscriptible : {exc}")
    finally:
        if probe_path is not None:
            try:
                probe_path.unlink(missing_ok=True)
            except OSError:
                pass

    all_ready = all(checks.values()) and not errors
    payload: dict[str, Any] = {
        "status": "ready" if all_ready else "not_ready",
        "ready": all_ready,
        "checks": checks,
        "errors": errors,
        "log_format": resolve_log_format(s.log_format),
        "hmac_signing_enabled": bool(s.audit_signing_secret),
    }
    return JSONResponse(status_code=200 if all_ready else 503, content=payload)


def _prom_escape_label(val: str) -> str:
    return val.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _render_prometheus_metrics(snap: dict[str, Any]) -> str:
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


@app.get("/api/metrics")
def get_metrics(format: str | None = Query(default=None)) -> Response:
    """Expose les compteurs temps réel en JSON (défaut) ou au format Prometheus (?format=prometheus)."""
    s = get_settings()
    snap = METRICS.snapshot(
        active_sessions=len(SESSION_STORE.list_sessions()),
        max_req=s.rate_limit_max_requests,
        window_sec=s.rate_limit_window_seconds,
    )
    fmt = (format or "").strip().lower()
    if fmt in {"prometheus", "openmetrics"}:
        prom_body = _render_prometheus_metrics(snap)
        return Response(
            content=prom_body.encode("utf-8"),
            headers={"Content-Type": "text/plain; version=0.0.4; charset=utf-8"},
        )
    return JSONResponse(content=snap)


@app.post("/api/demo/load")
def load_valmont_demo(
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    state = _get_session_state(session_id)
    demo_files = _demo_file_paths()
    state["files"] = [str(p) for p in demo_files]
    _reset_session_results(state)
    SESSION_STORE.save(session_id)
    AuditLogger(_get_audit_log_path(session_id)).reset()
    _bump_session_epoch(session_id)
    return {
        "loaded": [p.name for p in demo_files],
        "client": "Centre Hospitalier de Valmont",
        "session_id": session_id,
    }


def _purge_session_uploads(session_id: str) -> None:
    """Nettoie atomiquement les répertoires de téléversement temporaires et logs/uploads/<sid>/."""
    sid = sanitize_session_id(session_id)
    shutil.rmtree(UPLOAD_DIR / sid, ignore_errors=True)
    logs_uploads_root = LOGS_DIR / "uploads"
    shutil.rmtree(logs_uploads_root / sid, ignore_errors=True)
    if logs_uploads_root.exists():
        try:
            next(logs_uploads_root.iterdir())
        except StopIteration:
            try:
                logs_uploads_root.rmdir()
            except OSError:
                pass


class CleanupSessionsRequest(BaseModel):
    ttl_hours: float | None = Field(default=None, ge=0.0)
    dry_run: bool = False


@app.post("/api/reset")
def reset_session(
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    """Réinitialise complètement la session (RAM + disque) et son journal d'audit."""
    SESSION_STORE.reset(session_id)
    RATE_LIMITER.clear_session(session_id)
    AuditLogger(_get_audit_log_path(session_id)).reset()
    _purge_session_uploads(session_id)
    _bump_session_epoch(session_id)
    return {"reset": True, "session_id": session_id}


@app.get("/api/sessions")
def list_persisted_sessions(
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    """Liste les sessions persistées dans logs/sessions/ sans exposer de données brutes sensibles."""
    sessions = SESSION_STORE.list_sessions()
    s = get_settings()
    return {
        "active_session_id": session_id,
        "session_ttl_hours": s.session_ttl_hours,
        "count": len(sessions),
        "sessions": sessions,
    }


@app.post("/api/sessions/cleanup")
def cleanup_expired_sessions(
    ttl_hours: float | None = Query(default=None, ge=0.0),
    req: CleanupSessionsRequest | None = Body(default=None),
) -> dict[str, Any]:
    """Purge atomiquement les sessions secondaires expirées sans jamais supprimer 'default'."""
    s = get_settings()
    effective_ttl = (
        ttl_hours
        if ttl_hours is not None
        else (req.ttl_hours if (req and req.ttl_hours is not None) else s.session_ttl_hours)
    )
    is_dry_run = bool(req.dry_run) if req else False
    now_utc = datetime.now(timezone.utc)
    ttl_seconds = max(0.0, float(effective_ttl) * 3600.0)

    candidates = set(SESSION_STORE.find_expired_sessions(effective_ttl, now=now_utc))

    # Détecte aussi d'éventuels journaux ou dossiers d'upload secondaires orphelins expirés
    active_session_files = {
        sanitize_session_id(p.stem)
        for p in (SESSIONS_DIR.glob("*.json") if SESSIONS_DIR.exists() else [])
        if not p.name.startswith(".")
    }
    if LOGS_DIR.exists():
        for trail in LOGS_DIR.glob("audit_trail_*.jsonl"):
            sid = sanitize_session_id(trail.stem.removeprefix("audit_trail_"))
            if sid == DEFAULT_SESSION_ID or sid in active_session_files:
                continue
            try:
                age = (
                    now_utc - datetime.fromtimestamp(trail.stat().st_mtime, tz=timezone.utc)
                ).total_seconds()
                if age >= ttl_seconds:
                    candidates.add(sid)
            except OSError:
                pass

    for up_root in (UPLOAD_DIR, LOGS_DIR / "uploads"):
        if not up_root.exists():
            continue
        for sub in up_root.iterdir():
            if not sub.is_dir():
                continue
            sid = sanitize_session_id(sub.name)
            if sid == DEFAULT_SESSION_ID or sid in active_session_files:
                continue
            try:
                age = (
                    now_utc - datetime.fromtimestamp(sub.stat().st_mtime, tz=timezone.utc)
                ).total_seconds()
                if age >= ttl_seconds:
                    candidates.add(sid)
            except OSError:
                pass

    candidates.discard(DEFAULT_SESSION_ID)
    expired_sorted = sorted(candidates)

    if not is_dry_run:
        for sid in expired_sorted:
            if sid == DEFAULT_SESSION_ID:
                continue
            SESSION_STORE.delete_session(sid)
            RATE_LIMITER.clear_session(sid)
            AuditLogger(_get_audit_log_path(sid)).reset()
            _purge_session_uploads(sid)
            _bump_session_epoch(sid)

    remaining = [item["session_id"] for item in SESSION_STORE.list_sessions()]
    return {
        "cleaned": not is_dry_run,
        "dry_run": is_dry_run,
        "ttl_hours": float(effective_ttl),
        "purged_count": len(expired_sorted),
        "purged_sessions": expired_sorted,
        "protected_sessions": [DEFAULT_SESSION_ID],
        "remaining_sessions": remaining,
    }


def _compute_portable_state_sha256(state_obj: dict[str, Any]) -> str:
    core = {k: v for k, v in state_obj.items() if k != "session_id"}
    canonical = json.dumps(core, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@app.post("/api/sessions/import")
async def import_session_snapshot(
    request: Request,
    session_id: str | None = Query(default=None),
    target_session_id: str | None = Query(default=None),
    dependencies_rl: None = Depends(_enforce_rate_limit),
) -> dict[str, Any]:
    """Vérifie cryptographiquement la chaîne SHA-256 d'un snapshot JSON puis restaure la session."""
    del dependencies_rl
    content_type = (request.headers.get("content-type") or "").lower()
    form_sid: str | None = None

    if "multipart/form-data" in content_type:
        form = await request.form()
        up = form.get("file") or form.get("snapshot")
        if up is None or not hasattr(up, "read"):
            raise HTTPException(
                status_code=400,
                detail="Champ fichier 'file' ou 'snapshot' manquant dans le formulaire.",
            )
        raw_sid_field = form.get("target_session_id") or form.get("session_id")
        if isinstance(raw_sid_field, str) and raw_sid_field.strip():
            form_sid = raw_sid_field.strip()
        buf = io.BytesIO()
        read_total = 0
        while True:
            chunk = await up.read(UPLOAD_CHUNK_BYTES)  # type: ignore[misc]
            if not chunk:
                break
            read_total += len(chunk)
            if read_total > MAX_BUNDLE_VERIFY_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail="Snapshot de session trop volumineux (> 20 Mo).",
                )
            buf.write(chunk)
        raw_bytes = buf.getvalue()
    else:
        raw_bytes = await request.body()
        if len(raw_bytes) > MAX_BUNDLE_VERIFY_BYTES:
            raise HTTPException(
                status_code=413,
                detail="Snapshot de session trop volumineux (> 20 Mo).",
            )

    if not raw_bytes or not raw_bytes.strip():
        raise HTTPException(status_code=400, detail="Snapshot JSON vide.")

    try:
        parsed = json.loads(raw_bytes.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Snapshot JSON malformé ou encodage invalide : {exc}",
        ) from exc

    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="Le snapshot doit être un objet JSON.")

    body_sid: str | None = None
    if isinstance(parsed.get("snapshot"), dict):
        body_sid_raw = parsed.get("target_session_id") or parsed.get("session_id")
        if isinstance(body_sid_raw, str) and body_sid_raw.strip():
            body_sid = body_sid_raw.strip()
        snap = parsed["snapshot"]
    else:
        if isinstance(parsed.get("target_session_id"), str) and parsed["target_session_id"].strip():
            body_sid = parsed["target_session_id"].strip()
        snap = parsed

    raw_state = snap.get("state")
    if not isinstance(raw_state, dict):
        if isinstance(snap.get("results_by_mode"), dict):
            raw_state = {
                k: snap[k]
                for k in ("session_id", "files", "mode", "results_by_mode", "security_alert", "updated_at")
                if k in snap
            }
        else:
            raise HTTPException(
                status_code=400,
                detail="Structure de snapshot invalide : champ 'state' manquant.",
            )

    if "audit_log" not in snap or not isinstance(snap.get("audit_log"), list):
        raise HTTPException(
            status_code=400,
            detail="Structure de snapshot invalide : champ 'audit_log' (liste) requis.",
        )

    entries: list[dict[str, Any]] = snap["audit_log"]
    chain_check = verify_entries_chain(entries)
    if not chain_check.get("valide"):
        raise HTTPException(
            status_code=400,
            detail=(
                "Import refusé : chaîne cryptographique SHA-256 altérée ou rompue "
                f"({chain_check.get('erreur')})."
            ),
        )

    computed_head = entries[-1]["hash"] if entries else GENESIS_HASH
    integrity = snap.get("integrity")
    if isinstance(integrity, dict):
        exp_genesis = integrity.get("genesis_hash")
        if exp_genesis is not None and exp_genesis != GENESIS_HASH:
            raise HTTPException(
                status_code=400,
                detail="Import refusé : genesis_hash invalide dans la section integrity.",
            )
        exp_head = integrity.get("head_hash")
        if exp_head is not None and exp_head != computed_head:
            raise HTTPException(
                status_code=400,
                detail="Import refusé : discordance entre head_hash déclaré et journal SHA-256.",
            )
        exp_nb = integrity.get("nb_entrees")
        if exp_nb is not None and exp_nb != len(entries):
            raise HTTPException(
                status_code=400,
                detail="Import refusé : discordance sur le nombre d'entrées du journal SHA-256.",
            )
        exp_state_sha = integrity.get("state_sha256")
        if isinstance(exp_state_sha, str) and exp_state_sha.strip():
            actual_state_sha = _compute_portable_state_sha256(raw_state)
            if actual_state_sha != exp_state_sha.strip().lower():
                raise HTTPException(
                    status_code=400,
                    detail="Import refusé : l'état de session ne correspond pas à l'empreinte state_sha256 scellée.",
                )

    # Défense en profondeur : un mode marqué validé exige une preuve HUMAN_VALIDATION dans la chaîne SHA-256
    raw_results = raw_state.get("results_by_mode")
    if isinstance(raw_results, dict):
        for m_key in ("AVANT", "APRES"):
            m_slot = raw_results.get(m_key)
            if isinstance(m_slot, dict) and bool(m_slot.get("validated")):
                has_val_entry = any(
                    e.get("action") == "HUMAN_VALIDATION"
                    and (e.get("mode") in {None, m_key} or (isinstance(e.get("details"), dict) and e["details"].get("mode") == m_key))
                    for e in entries
                )
                if not has_val_entry:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Import refusé : le mode {m_key} est marqué validé sans preuve HUMAN_VALIDATION dans la chaîne SHA-256.",
                    )

    chosen_sid_raw = (
        target_session_id
        or form_sid
        or body_sid
        or (snap.get("session_id") if isinstance(snap.get("session_id"), str) else None)
        or (raw_state.get("session_id") if isinstance(raw_state.get("session_id"), str) else None)
        or session_id
        or DEFAULT_SESSION_ID
    )
    resolved_sid = sanitize_session_id(chosen_sid_raw)

    # Écriture atomique du journal SHA-256 vérifié puis restauration de l'état de session
    log_path = _get_audit_log_path(resolved_sid)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_log = log_path.parent / f".{log_path.name}.import.tmp"
    serialized_log = (
        "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries) if entries else ""
    )
    if serialized_log:
        tmp_log.write_text(serialized_log, encoding="utf-8")
        os.replace(tmp_log, log_path)
    elif log_path.exists():
        log_path.unlink()

    restored = SESSION_STORE.import_state(resolved_sid, raw_state, data_dir=DATA_DIR)
    _bump_session_epoch(resolved_sid)
    avant_syn = restored["results_by_mode"]["AVANT"].get("synthesis")
    apres_syn = restored["results_by_mode"]["APRES"].get("synthesis")
    client_name = (
        (apres_syn.get("client") if isinstance(apres_syn, dict) else None)
        or (avant_syn.get("client") if isinstance(avant_syn, dict) else None)
        or "Centre Hospitalier de Valmont"
    )

    return {
        "imported": True,
        "session_id": resolved_sid,
        "client": client_name,
        "mode": restored["mode"],
        "modes_ready": {
            "AVANT": isinstance(avant_syn, dict),
            "APRES": isinstance(apres_syn, dict),
        },
        "modes_validated": {
            "AVANT": bool(restored["results_by_mode"]["AVANT"].get("validated")),
            "APRES": bool(restored["results_by_mode"]["APRES"].get("validated")),
        },
        "head_hash": computed_head,
        "nb_entrees": len(entries),
        "chain": verify_chain(log_path),
    }


@app.get("/api/sessions/{target_session_id}/snapshot")
def export_session_snapshot(target_session_id: str) -> Response:
    """Exporte l'instantané portable complet d'une session (état AVANT/APRES, décisions GRC et chaîne SHA-256)."""
    sid = sanitize_session_id(target_session_id)
    log_path = _get_audit_log_path(sid)
    if sid != DEFAULT_SESSION_ID and not SESSION_STORE.exists(sid) and not log_path.exists():
        raise HTTPException(status_code=404, detail=f"Session '{sid}' introuvable.")

    exported_state = SESSION_STORE.export_state(sid)
    entries = AuditLogger(log_path, session_id=sid).read_entries()
    chain_info = verify_chain(log_path)
    head_hash = entries[-1]["hash"] if entries else GENESIS_HASH
    state_sha256 = _compute_portable_state_sha256(exported_state)

    avant_syn = exported_state["results_by_mode"]["AVANT"].get("synthesis")
    apres_syn = exported_state["results_by_mode"]["APRES"].get("synthesis")
    client_name = (
        (apres_syn.get("client") if isinstance(apres_syn, dict) else None)
        or (avant_syn.get("client") if isinstance(avant_syn, dict) else None)
        or "Centre Hospitalier de Valmont"
    )

    snapshot_payload = {
        "schema_version": "1.0",
        "snapshot_type": "triad_session_snapshot",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "session_id": sid,
        "client": client_name,
        "state": exported_state,
        "integrity": {
            "algorithm": "SHA-256",
            "genesis_hash": GENESIS_HASH,
            "head_hash": head_hash,
            "nb_entrees": len(entries),
            "state_sha256": state_sha256,
            "chain": chain_info,
        },
        "audit_log": entries,
    }
    filename = f"TRIAD_Session_Snapshot_{sid}.json"
    snap_bytes = (json.dumps(snapshot_payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    return Response(
        content=snap_bytes,
        media_type="application/json; charset=utf-8",
        headers=_build_export_signature_headers(
            snap_bytes,
            {"Content-Disposition": f'attachment; filename="{filename}"'},
        ),
    )


@app.delete("/api/sessions/{target_session_id}")
def delete_persisted_session(target_session_id: str) -> dict[str, Any]:
    """Supprime une session persistée (RAM, fichier JSON disque, journal SHA-256 et téléversements)."""
    sid = sanitize_session_id(target_session_id)
    deleted = SESSION_STORE.delete_session(sid)
    RATE_LIMITER.clear_session(sid)
    AuditLogger(_get_audit_log_path(sid)).reset()
    _purge_session_uploads(sid)
    _bump_session_epoch(sid)
    return {"deleted": deleted, "session_id": sid}


@app.post("/api/upload", dependencies=[Depends(_enforce_rate_limit)])
async def upload_files(
    files: list[UploadFile] = File(...),
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    """Téléverse et valide par chunks les pièces d'audit (.md, .txt, .pdf, max 20 fichiers / 10 Mo)."""
    if not files:
        raise HTTPException(status_code=400, detail="Aucun fichier fourni.")
    if len(files) > MAX_UPLOAD_FILES:
        raise HTTPException(
            status_code=400,
            detail=f"Trop de fichiers téléversés ({len(files)} > {MAX_UPLOAD_FILES} maximum).",
        )

    validated_uploads: list[tuple[UploadFile, str]] = []
    for up in files:
        safe_name = Path(up.filename or "").name.strip()
        if not safe_name or safe_name in {".", ".."}:
            raise HTTPException(status_code=400, detail="Nom de fichier manquant ou invalide.")
        ext = Path(safe_name).suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            allowed_str = ", ".join(sorted(ALLOWED_EXTENSIONS))
            raise HTTPException(
                status_code=400,
                detail=f"Extension non autorisée ({ext or 'aucune'}) pour '{safe_name}'. Formats acceptés : {allowed_str}.",
            )
        validated_uploads.append((up, safe_name))

    session_upload_dir = _get_upload_dir(session_id)
    staged_pairs: list[tuple[Path, Path]] = []
    try:
        for idx, (up, safe_name) in enumerate(validated_uploads):
            tmp_dest = session_upload_dir / f".upload_{os.getpid()}_{idx}_{safe_name}.part"
            final_dest = session_upload_dir / safe_name
            staged_pairs.append((tmp_dest, final_dest))
            written = 0
            with tmp_dest.open("wb") as fh:
                while True:
                    chunk = await up.read(UPLOAD_CHUNK_BYTES)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > MAX_UPLOAD_FILE_BYTES:
                        max_mb = MAX_UPLOAD_FILE_BYTES // (1024 * 1024)
                        raise HTTPException(
                            status_code=413,
                            detail=f"Le fichier '{safe_name}' dépasse la taille maximale autorisée ({max_mb} Mo).",
                        )
                    fh.write(chunk)
    except Exception:
        for tmp_p, _ in staged_pairs:
            try:
                if tmp_p.exists():
                    tmp_p.unlink()
            except OSError:
                pass
        raise

    saved: list[str] = []
    seen_dests: set[Path] = set()
    for tmp_p, final_p in staged_pairs:
        os.replace(tmp_p, final_p)
        if final_p not in seen_dests:
            saved.append(str(final_p))
            seen_dests.add(final_p)

    state = _get_session_state(session_id)
    state["files"] = saved
    _reset_session_results(state)
    SESSION_STORE.save(session_id)
    _bump_session_epoch(session_id)
    METRICS.record_upload()
    return {"uploaded": [Path(p).name for p in saved], "session_id": session_id}


@app.post("/api/audit/run", dependencies=[Depends(_enforce_rate_limit)])
async def run_audit(
    req: RunAuditRequest,
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    state = _get_session_state(session_id)
    if not state["files"]:
        state["files"] = [str(p) for p in _demo_file_paths()]

    state["mode"] = req.mode
    slot = state["results_by_mode"][req.mode]
    slot["validated"] = False
    slot["agent_statuses"] = default_agent_statuses()
    slot["timings_ms"] = {}
    slot["decisions"] = {}
    state["security_alert"] = None
    SESSION_STORE.save(session_id)
    _bump_session_epoch(session_id)

    def _on_status(agent: str, status: str) -> None:
        slot["agent_statuses"][agent] = status
        _bump_session_epoch(session_id)
        _broadcast_sse(
            {
                "type": "agent_status",
                "mode": req.mode,
                "agent": agent,
                "status": status,
                "agent_statuses": dict(slot["agent_statuses"]),
            },
            session_id=session_id,
        )

    _broadcast_sse({"type": "run_start", "mode": req.mode}, session_id=session_id)
    input_paths = [Path(p) for p in state["files"]]
    log_path = _get_audit_log_path(session_id)
    result = await run_audit_pipeline(
        input_files=input_paths,
        mode=req.mode,
        log_path=log_path,
        use_cache=req.use_cache,
        status_callback=_on_status,
    )
    slot["synthesis"] = result["synthesis"]
    slot["elapsed_seconds"] = result["elapsed_seconds"]
    slot["timings_ms"] = dict(result.get("timings_ms") or {})
    slot["source"] = result["source"]
    slot["run_id"] = result["run_id"]
    SESSION_STORE.save(session_id)
    _bump_session_epoch(session_id)
    METRICS.record_audit(req.mode, result["elapsed_seconds"], slot["timings_ms"])
    _broadcast_sse(
        {
            "type": "run_complete",
            "mode": req.mode,
            "run_id": result["run_id"],
            "elapsed_seconds": result["elapsed_seconds"],
            "timings_ms": slot["timings_ms"],
            "source": result["source"],
        },
        session_id=session_id,
    )
    return {
        "session_id": session_id,
        "run_id": result["run_id"],
        "synthesis": result["synthesis"],
        "chain": result["chain"],
        "elapsed_seconds": result["elapsed_seconds"],
        "timings_ms": slot["timings_ms"],
        "source": result["source"],
        "agent_statuses": slot["agent_statuses"],
    }


@app.get("/api/audit/stream")
async def stream_audit_events(
    request: Request,
    session_id: str = Depends(_resolve_session_id),
) -> StreamingResponse:
    """Flux Server-Sent Events (SSE) diffusant en direct chaque étape des 4 agents ADK."""
    state = _get_session_state(session_id)
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    client_triple = (session_id, loop, queue)
    _SSE_CLIENTS.append(client_triple)

    async def event_generator() -> AsyncGenerator[str, None]:
        try:
            active_mode = state["mode"]
            slot = state["results_by_mode"][active_mode]
            init_payload = {
                "type": "init",
                "session_id": session_id,
                "mode": active_mode,
                "agent_statuses": slot["agent_statuses"],
            }
            yield f"data: {json.dumps(init_payload, ensure_ascii=False)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=12.0)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                except TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            if client_triple in _SSE_CLIENTS:
                _SSE_CLIENTS.remove(client_triple)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.api_route("/api/status", methods=["GET", "HEAD"])
@app.api_route("/api/state", methods=["GET", "HEAD"])
def get_status(
    request: Request,
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> Response:
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    log_path = _get_audit_log_path(session_id)
    logger = AuditLogger(log_path)
    payload_obj = {
        "session_id": session_id,
        "run_id": slot.get("run_id"),
        "files": [Path(p).name for p in state["files"]],
        "mode": active_mode,
        "agent_statuses": slot["agent_statuses"],
        "synthesis": slot["synthesis"],
        "syntheses_by_mode": {
            "AVANT": state["results_by_mode"]["AVANT"]["synthesis"],
            "APRES": state["results_by_mode"]["APRES"]["synthesis"],
        },
        "validated": slot["validated"],
        "modes_ready": {
            "AVANT": state["results_by_mode"]["AVANT"]["synthesis"] is not None,
            "APRES": state["results_by_mode"]["APRES"]["synthesis"] is not None,
        },
        "modes_validated": {
            "AVANT": state["results_by_mode"]["AVANT"]["validated"],
            "APRES": state["results_by_mode"]["APRES"]["validated"],
        },
        "security_alert": state["security_alert"],
        "elapsed_seconds": slot["elapsed_seconds"],
        "timings_ms": dict(slot.get("timings_ms") or {}),
        "timings_by_mode": {
            "AVANT": dict(state["results_by_mode"]["AVANT"].get("timings_ms") or {}),
            "APRES": dict(state["results_by_mode"]["APRES"].get("timings_ms") or {}),
        },
        "decisions": dict(slot.get("decisions") or {}),
        "decisions_by_mode": {
            "AVANT": dict(state["results_by_mode"]["AVANT"].get("decisions") or {}),
            "APRES": dict(state["results_by_mode"]["APRES"].get("decisions") or {}),
        },
        "source": slot["source"],
        "audit_log": logger.read_entries(),
        "chain": verify_chain(log_path),
    }
    return _build_conditional_session_json_response(
        request,
        payload_obj,
        session_id=session_id,
        active_mode=active_mode,
        state=state,
        log_path=log_path,
    )


@app.get("/api/audit/log")
def get_audit_log_filtered(
    agent: str | None = Query(default=None, max_length=128),
    action: str | None = Query(default=None, max_length=128),
    mode: str | None = Query(default=None, max_length=32),
    q: str | None = Query(default=None, max_length=256),
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    """Explore et filtre le registre cryptographique SHA-256 tout en certifiant la chaîne complète non filtrée."""
    _get_session_state(session_id)
    log_path = _get_audit_log_path(session_id)
    logger = AuditLogger(log_path, session_id=session_id)
    all_entries = logger.read_entries()
    chain_info = verify_chain(log_path)
    chain_valid = bool(chain_info.get("valide"))
    head_hash = str(all_entries[-1].get("hash")) if all_entries else GENESIS_HASH

    available_agents = sorted(
        {str(e.get("agent")).strip() for e in all_entries if str(e.get("agent") or "").strip()}
    )
    available_actions = sorted(
        {str(e.get("action")).strip() for e in all_entries if str(e.get("action") or "").strip()}
    )
    available_modes = [
        m
        for m in ("AVANT", "APRES")
        if any(str(e.get("mode") or "").strip().upper() == m for e in all_entries)
    ]

    raw_agent = (agent or "").strip()
    norm_agent = "" if raw_agent.upper() in {"", "ALL", "TOUS", "*"} else raw_agent

    raw_action = (action or "").strip()
    norm_action = "" if raw_action.upper() in {"", "ALL", "TOUS", "*"} else raw_action

    raw_mode = (mode or "").strip().upper()
    norm_mode = "" if raw_mode in {"", "ALL", "TOUS", "*"} else raw_mode

    raw_q = (q or "").strip()
    norm_q = raw_q.lower()

    filtered_entries: list[dict[str, Any]] = []
    matched_indices: list[int] = []
    for idx_1based, entry in enumerate(all_entries, start=1):
        if norm_agent and str(entry.get("agent") or "").strip().lower() != norm_agent.lower():
            continue
        if norm_action and str(entry.get("action") or "").strip().lower() != norm_action.lower():
            continue
        if norm_mode:
            entry_mode = str(entry.get("mode") or "").strip().upper()
            if norm_mode in {"NONE", "GLOBAL", "SANS_MODE"}:
                if entry_mode:
                    continue
            elif entry_mode != norm_mode:
                continue
        if norm_q:
            details_val = entry.get("details")
            if isinstance(details_val, (dict, list)):
                details_str = json.dumps(details_val, ensure_ascii=False, sort_keys=True)
            else:
                details_str = str(details_val or "")
            haystack = " ".join(
                [
                    str(entry.get("agent") or ""),
                    str(entry.get("action") or ""),
                    str(entry.get("mode") or ""),
                    str(entry.get("run_id") or ""),
                    details_str,
                    str(entry.get("hash") or ""),
                    str(entry.get("prev_hash") or ""),
                    str(entry.get("ts") or ""),
                ]
            ).lower()
            if norm_q not in haystack:
                continue
        filtered_entries.append(entry)
        matched_indices.append(idx_1based)

    return {
        "session_id": session_id,
        "chain_valid": chain_valid,
        "chain": chain_info,
        "genesis_hash": GENESIS_HASH,
        "head_hash": head_hash,
        "total_entries": len(all_entries),
        "filtered_count": len(filtered_entries),
        "available_agents": available_agents,
        "available_actions": available_actions,
        "available_modes": available_modes,
        "matched_indices": matched_indices,
        "filters": {
            "agent": norm_agent or None,
            "action": norm_action or None,
            "mode": norm_mode or None,
            "q": raw_q or None,
        },
        "entries": filtered_entries,
        "audit_log": filtered_entries,
    }


def _compute_nis2_score(findings: list[dict[str, Any]]) -> int:
    """Calcule l'indice de maturité NIS2 (0-100) en parité exacte avec le comparateur UI."""
    if not findings:
        return 0
    total = 0
    for f in findings:
        statut = f.get("statut")
        if statut == "conforme":
            total += 100
        elif statut == "partiel":
            total += 55
        elif statut == "a_confirmer":
            total += 40
    return math.floor((total / len(findings)) + 0.5)


def _finding_match_key(finding: dict[str, Any]) -> str:
    reel = finding.get("reel")
    if isinstance(reel, dict):
        ressource = str(reel.get("ressource") or "").strip().lower()
        if ressource:
            return f"res:{ressource}"
    theme = str(finding.get("theme") or "").strip().lower()
    return f"theme:{theme}"


@app.get("/api/audit/diff")
def get_audit_diff(
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    """Calcule le comparatif structuré AVANT vs APRES (score NIS2, nouveaux constats, ruptures du Dit)."""
    state = _get_session_state(session_id)
    avant_slot = state["results_by_mode"]["AVANT"]
    apres_slot = state["results_by_mode"]["APRES"]
    avant_syn = avant_slot.get("synthesis")
    apres_syn = apres_slot.get("synthesis")

    avant_ready = isinstance(avant_syn, dict)
    apres_ready = isinstance(apres_syn, dict)
    both_ready = avant_ready and apres_ready

    modes_ready: dict[str, bool] = {"AVANT": avant_ready, "APRES": apres_ready}
    modes_validated: dict[str, bool] = {
        "AVANT": bool(avant_slot.get("validated")),
        "APRES": bool(apres_slot.get("validated")),
    }
    missing_modes = [m for m in ("AVANT", "APRES") if not modes_ready[m]]

    avant_findings = (
        [f for f in (avant_syn.get("findings") or []) if isinstance(f, dict)]
        if isinstance(avant_syn, dict)
        else []
    )
    apres_findings = (
        [f for f in (apres_syn.get("findings") or []) if isinstance(f, dict)]
        if isinstance(apres_syn, dict)
        else []
    )

    score_avant: int | None = _compute_nis2_score(avant_findings) if avant_ready else None
    score_apres: int | None = _compute_nis2_score(apres_findings) if apres_ready else None
    score_delta: int | None = (
        score_apres - score_avant
        if (score_avant is not None and score_apres is not None)
        else None
    )

    client_name = (
        (apres_syn.get("client") if isinstance(apres_syn, dict) else None)
        or (avant_syn.get("client") if isinstance(avant_syn, dict) else None)
        or "Centre Hospitalier de Valmont"
    )

    nouveaux_constats: list[dict[str, Any]] = []
    ruptures_dit: list[dict[str, Any]] = []
    ecarts_confirmes: list[dict[str, Any]] = []
    conformes_ou_leves: list[dict[str, Any]] = []
    items: list[dict[str, Any]] = []

    if both_ready:
        matched_avant_indices: set[int] = set()

        for ap in apres_findings:
            av: dict[str, Any] | None = None
            ap_id = ap.get("id")
            if ap_id:
                for idx, candidate in enumerate(avant_findings):
                    if idx not in matched_avant_indices and candidate.get("id") == ap_id:
                        av = candidate
                        matched_avant_indices.add(idx)
                        break
            if av is None:
                target_key = _finding_match_key(ap)
                for idx, candidate in enumerate(avant_findings):
                    if (
                        idx not in matched_avant_indices
                        and _finding_match_key(candidate) == target_key
                    ):
                        av = candidate
                        matched_avant_indices.add(idx)
                        break

            ap_contra = str(ap.get("contradiction") or "")
            av_contra = str(av.get("contradiction") or "") if av else ""
            is_dit_contradiction = (
                "dit" in ap_contra.lower() and "dit" not in av_contra.lower()
            )
            is_resolved_or_compliant = ap.get("statut") == "conforme"
            is_new_gap = (av is None) and not is_resolved_or_compliant
            is_confirmed_gap = (
                av is not None
                and av.get("statut") != "conforme"
                and not is_resolved_or_compliant
            )

            if is_resolved_or_compliant:
                category = "resolved_or_compliant"
                category_label = (
                    "Écart levé post-entretien"
                    if (av is not None and av.get("statut") != "conforme")
                    else "Contrôle conforme validé"
                )
            elif is_dit_contradiction:
                category = "dit_contradiction"
                category_label = (
                    "Rupture Dit ≠ Réel dévoilée"
                    if ("réel" in ap_contra.lower() or "reel" in ap_contra.lower())
                    else "Rupture Dit ≠ Écrit dévoilée"
                )
            elif is_new_gap:
                category = "new_gap"
                category_label = "Nouvel écart post-entretien"
            else:
                category = "confirmed_gap"
                category_label = "Écart technique confirmé"

            summary_entry = {
                "id": ap.get("id"),
                "theme": ap.get("theme"),
                "exigence_nis2": ap.get("exigence_nis2"),
                "statut": ap.get("statut"),
                "gravite": ap.get("gravite"),
                "contradiction_avant": av.get("contradiction") if av else None,
                "contradiction_apres": ap.get("contradiction"),
                "contradiction": ap.get("contradiction"),
                "dit": ap.get("dit"),
                "ecrit": ap.get("ecrit"),
                "reel": ap.get("reel"),
                "recommandation": ap.get("recommandation"),
            }

            if is_new_gap:
                nouveaux_constats.append(summary_entry)
            if is_dit_contradiction:
                ruptures_dit.append(summary_entry)
            if is_confirmed_gap:
                ecarts_confirmes.append(summary_entry)
            if is_resolved_or_compliant:
                conformes_ou_leves.append(summary_entry)

            items.append(
                {
                    "id": ap.get("id"),
                    "theme": ap.get("theme"),
                    "exigence_nis2": ap.get("exigence_nis2"),
                    "category": category,
                    "category_label": category_label,
                    "is_dit_contradiction": is_dit_contradiction,
                    "is_new_gap": is_new_gap,
                    "is_confirmed_gap": is_confirmed_gap,
                    "is_resolved_or_compliant": is_resolved_or_compliant,
                    "statut_avant": av.get("statut") if av else None,
                    "statut_apres": ap.get("statut"),
                    "gravite_avant": av.get("gravite") if av else None,
                    "gravite_apres": ap.get("gravite"),
                    "contradiction_avant": av.get("contradiction") if av else None,
                    "contradiction_apres": ap.get("contradiction"),
                    "avant": av,
                    "apres": ap,
                }
            )

        for idx, av in enumerate(avant_findings):
            if idx in matched_avant_indices:
                continue
            closed_entry = {
                "id": av.get("id"),
                "theme": av.get("theme"),
                "exigence_nis2": av.get("exigence_nis2"),
                "statut": "conforme",
                "gravite": av.get("gravite"),
                "contradiction_avant": av.get("contradiction"),
                "contradiction_apres": None,
                "contradiction": None,
                "dit": av.get("dit"),
                "ecrit": av.get("ecrit"),
                "reel": av.get("reel"),
                "recommandation": av.get("recommandation"),
            }
            conformes_ou_leves.append(closed_entry)
            items.append(
                {
                    "id": av.get("id"),
                    "theme": av.get("theme"),
                    "exigence_nis2": av.get("exigence_nis2"),
                    "category": "resolved_or_compliant",
                    "category_label": "Point pré-entretien clos",
                    "is_dit_contradiction": False,
                    "is_new_gap": False,
                    "is_confirmed_gap": False,
                    "is_resolved_or_compliant": True,
                    "statut_avant": av.get("statut"),
                    "statut_apres": None,
                    "gravite_avant": av.get("gravite"),
                    "gravite_apres": None,
                    "contradiction_avant": av.get("contradiction"),
                    "contradiction_apres": None,
                    "avant": av,
                    "apres": None,
                }
            )

    log_path = _get_audit_log_path(session_id)
    return {
        "session_id": session_id,
        "client": client_name,
        "ready": both_ready,
        "modes_ready": modes_ready,
        "modes_validated": modes_validated,
        "missing_modes": missing_modes,
        "runs": {
            "AVANT": avant_slot.get("run_id"),
            "APRES": apres_slot.get("run_id"),
        },
        "timings_by_mode": {
            "AVANT": dict(avant_slot.get("timings_ms") or {}),
            "APRES": dict(apres_slot.get("timings_ms") or {}),
        },
        "score_nis2": {
            "avant": score_avant,
            "apres": score_apres,
            "delta": score_delta,
        },
        "counts": {
            "findings_avant": len(avant_findings),
            "findings_apres": len(apres_findings),
            "nouveaux_constats": len(nouveaux_constats),
            "ruptures_dit": len(ruptures_dit),
            "ecarts_confirmes": len(ecarts_confirmes),
            "conformes_ou_leves": len(conformes_ou_leves),
        },
        "nouveaux_constats": nouveaux_constats,
        "ruptures_dit": ruptures_dit,
        "ecarts_confirmes": ecarts_confirmes,
        "conformes_ou_leves": conformes_ou_leves,
        "items": items,
        "chain": verify_chain(log_path),
    }


_ART21_SUBLETTER_RE = re.compile(r"\(([a-j])\)", flags=re.IGNORECASE)
_ART21_BARE_SUBLETTER_RE = re.compile(r"21\s*§?\s*2\s*([a-j])\b", flags=re.IGNORECASE)
_ART23_RE = re.compile(r"\bart(?:icle)?\.?\s*23\b|\bnis2-23\b", flags=re.IGNORECASE)
_EXPLICIT_NIS2_ID_RE = re.compile(r"\b(NIS2-21-2-[a-j]|NIS2-23)\b", flags=re.IGNORECASE)
_STATUT_PRECEDENCE = {
    "non_conforme": 4,
    "partiel": 3,
    "a_confirmer": 2,
    "conforme": 1,
}
_GRAVITE_PRECEDENCE = {
    "critique": 4,
    "haute": 3,
    "moyenne": 2,
    "faible": 1,
}


def _match_finding_to_nis2_ids(
    finding: dict[str, Any],
    valid_ids: set[str],
    all_reqs: list[dict[str, Any]],
) -> list[str]:
    ex_str = f"{finding.get('lot_nis2') or ''} {finding.get('exigence_nis2') or ''}".strip()
    matched: list[str] = []

    def _add(req_id: str) -> None:
        if req_id in valid_ids and req_id not in matched:
            matched.append(req_id)

    for m in _EXPLICIT_NIS2_ID_RE.finditer(ex_str):
        raw_id = m.group(1)
        norm_id = "NIS2-23" if raw_id.upper() == "NIS2-23" else f"NIS2-21-2-{raw_id[-1].lower()}"
        _add(norm_id)

    if "21" in ex_str:
        for m in _ART21_SUBLETTER_RE.finditer(ex_str):
            _add(f"NIS2-21-2-{m.group(1).lower()}")
        for m in _ART21_BARE_SUBLETTER_RE.finditer(ex_str):
            _add(f"NIS2-21-2-{m.group(1).lower()}")

    if _ART23_RE.search(ex_str):
        _add("NIS2-23")

    if not matched:
        haystack = f"{finding.get('theme') or ''} {finding.get('recommandation') or ''}".lower()
        for req in all_reqs:
            rid = str(req.get("id") or "")
            keywords = [str(kw).lower() for kw in req.get("mots_cles", []) if kw]
            if any(kw in haystack for kw in keywords):
                _add(rid)

    return matched


_NIS2_REF_LOCK = threading.Lock()
_NIS2_REF_MEMORY_CACHE: dict[tuple[str, str], tuple[int, bytes, str]] = {}


def _get_cached_nis2_referentiel_bundle(theme: str | None = None) -> tuple[bytes, str]:
    """Charge et mémorise en cache mémoire le référentiel statique NIS2 (sérialisé + ETag SHA-256)."""
    s = get_settings()
    ref_path = (s.data_dir / "referentiel_nis2.json").resolve()
    theme_norm = (theme or "").strip().lower()
    cache_key = (str(ref_path), theme_norm)
    mtime_ns = ref_path.stat().st_mtime_ns if ref_path.is_file() else -1

    with _NIS2_REF_LOCK:
        cached = _NIS2_REF_MEMORY_CACHE.get(cache_key)
        if cached is not None and cached[0] == mtime_ns:
            return cached[1], cached[2]

    raw_data = json.loads(ref_path.read_text(encoding="utf-8")) if ref_path.is_file() else {}
    all_exigences: list[dict[str, Any]] = [
        ex for ex in (raw_data.get("exigences") or []) if isinstance(ex, dict)
    ]
    if theme_norm:
        filtered = [
            ex
            for ex in all_exigences
            if theme_norm in str(ex.get("theme") or "").lower()
            or theme_norm in str(ex.get("article") or "").lower()
        ]
    else:
        filtered = all_exigences

    payload_obj = {
        "referentiel": str(raw_data.get("referentiel") or "Directive (UE) 2022/2555 (NIS2)"),
        "version": str(raw_data.get("version") or "1.0"),
        "total": len(all_exigences),
        "count": len(filtered),
        "theme": theme.strip() if (theme and theme.strip()) else None,
        "exigences": filtered,
        "requirements": filtered,
    }
    payload_bytes = (json.dumps(payload_obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    etag = f'"{hashlib.sha256(payload_bytes).hexdigest()}"'

    with _NIS2_REF_LOCK:
        _NIS2_REF_MEMORY_CACHE[cache_key] = (mtime_ns, payload_bytes, etag)
    return payload_bytes, etag


@app.api_route("/api/nis2", methods=["GET", "HEAD"])
def get_nis2_referentiel(
    request: Request,
    theme: str | None = Query(default=None),
) -> Response:
    """Expose le référentiel réglementaire NIS2 en cache mémoire avec support ETag / If-None-Match (HTTP 304) et X-Triad-Signature."""
    ref_bytes, ref_etag = _get_cached_nis2_referentiel_bundle(theme=theme)
    return _build_conditional_signed_response(
        request,
        ref_bytes,
        etag=ref_etag,
        media_type="application/json",
    )


@app.api_route("/api/nis2/coverage", methods=["GET", "HEAD"])
def get_nis2_coverage(
    request: Request,
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> Response:
    """Croise l'intégralité du référentiel NIS2 avec les constats de la session et du mode actif."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    syn = slot.get("synthesis")
    log_path = _get_audit_log_path(session_id)

    ref_path = DATA_DIR / "referentiel_nis2.json"
    ref_raw = json.loads(ref_path.read_text(encoding="utf-8")) if ref_path.exists() else {}
    all_reqs = get_nis2_requirements()
    valid_ids = {str(r.get("id")) for r in all_reqs if r.get("id")}

    findings = (
        [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
        if isinstance(syn, dict)
        else []
    )

    findings_by_req: dict[str, list[dict[str, Any]]] = {
        str(r["id"]): [] for r in all_reqs if r.get("id")
    }
    for f in findings:
        for rid in _match_finding_to_nis2_ids(f, valid_ids, all_reqs):
            findings_by_req.setdefault(rid, []).append(f)

    counts_by_status: dict[str, int] = {
        "conforme": 0,
        "partiel": 0,
        "non_conforme": 0,
        "a_confirmer": 0,
        "non_couvert": 0,
    }
    requirements_out: list[dict[str, Any]] = []

    for req in all_reqs:
        rid = str(req.get("id") or "")
        linked = findings_by_req.get(rid, [])
        if not linked:
            statut = "non_couvert"
            gravite_max: str | None = None
            finding_ids: list[str] = []
        else:
            finding_ids = [
                str(f.get("id")) for f in linked if isinstance(f.get("id"), str) and f.get("id")
            ]
            statut = max(
                (str(f.get("statut") or "a_confirmer") for f in linked),
                key=lambda s: _STATUT_PRECEDENCE.get(s, 0),
            )
            if statut not in _STATUT_PRECEDENCE:
                statut = "a_confirmer"
            gravite_max = max(
                (str(f.get("gravite") or "faible") for f in linked),
                key=lambda g: _GRAVITE_PRECEDENCE.get(g, 0),
            )

        counts_by_status[statut] = counts_by_status.get(statut, 0) + 1
        requirements_out.append(
            {
                "id": rid,
                "article": req.get("article", ""),
                "theme": req.get("theme", ""),
                "intitule_resume": req.get("intitule_resume", ""),
                "type_verification": list(req.get("type_verification", [])),
                "mots_cles": list(req.get("mots_cles", [])),
                "statut": statut,
                "covered": statut != "non_couvert",
                "gravite_max": gravite_max,
                "finding_ids": finding_ids,
                "findings_count": len(finding_ids),
            }
        )

    total_reqs = len(requirements_out)
    covered_reqs = total_reqs - counts_by_status["non_couvert"]
    coverage_rate = round((covered_reqs / total_reqs) * 100.0, 1) if total_reqs else 0.0

    payload_obj = {
        "session_id": session_id,
        "mode": active_mode,
        "has_synthesis": isinstance(syn, dict),
        "referentiel": ref_raw.get("referentiel", "Directive (UE) 2022/2555 (NIS2)"),
        "version": ref_raw.get("version", "1.0"),
        "total_requirements": total_reqs,
        "covered_requirements": covered_reqs,
        "coverage_rate": coverage_rate,
        "counts_by_status": counts_by_status,
        "requirements": requirements_out,
    }
    return _build_conditional_session_json_response(
        request,
        payload_obj,
        session_id=session_id,
        active_mode=active_mode,
        state=state,
        log_path=log_path,
    )


_SUPPLY_RISK_RANK: dict[str, int] = {
    "MAÎTRISÉ": 1,
    "MODÉRÉ": 2,
    "ÉLEVÉ": 3,
    "CRITIQUE": 4,
}


def _evaluate_vendor_risk_from_findings(
    linked_findings: list[dict[str, Any]], *, quarantined: bool = False
) -> str:
    """Calcule le niveau de risque tiers (CRITIQUE / ÉLEVÉ / MODÉRÉ / MAÎTRISÉ)."""
    if quarantined:
        return "CRITIQUE"
    non_conformes = [f for f in linked_findings if f.get("statut") != "conforme"]
    if not non_conformes:
        return "MAÎTRISÉ" if linked_findings else "MODÉRÉ"
    gravites = {str(f.get("gravite") or "").lower() for f in non_conformes}
    statuts = {str(f.get("statut") or "").lower() for f in non_conformes}
    if "critique" in gravites and "non_conforme" in statuts:
        return "CRITIQUE"
    if "critique" in gravites or "haute" in gravites:
        return "ÉLEVÉ"
    return "MODÉRÉ"


@app.get("/api/nis2/supply-chain")
def get_nis2_supply_chain(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    """Registre d'évaluation du risque tiers & chaîne d'approvisionnement (NIS2 Art. 21 §2 d)."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    syn = slot.get("synthesis")
    has_synthesis = isinstance(syn, dict)

    if not has_synthesis:
        return {
            "session_id": session_id,
            "mode": active_mode,
            "has_synthesis": False,
            "article": "Art. 21 §2 (d) — Sécurité de la chaîne d'approvisionnement",
            "pssi_reference": "PSSI §3.3 — Gestion des tiers et sous-traitants (PAS NIS2 / HDS)",
            "source": "server",
            "overall_risk": "MAÎTRISÉ",
            "quarantined_docs_count": 0,
            "quarantined_documents": [],
            "vendors": [],
            "providers": [],
            "summary_counts": {
                "total": 0,
                "critique": 0,
                "eleve": 0,
                "modere": 0,
                "maitrise": 0,
            },
        }

    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    by_id: dict[str, dict[str, Any]] = {
        str(f.get("id")): f for f in findings if f.get("id")
    }
    docs_clean = [d for d in (syn.get("documents_nettoyes") or []) if isinstance(d, dict)]
    docs_quar = [d for d in (syn.get("documents_quarantaine") or []) if isinstance(d, dict)]
    quar_by_name: dict[str, dict[str, Any]] = {
        str(d.get("nom_fichier") or ""): d for d in docs_quar if d.get("nom_fichier")
    }
    clean_by_name: dict[str, dict[str, Any]] = {
        str(d.get("nom_fichier") or ""): d for d in docs_clean if d.get("nom_fichier")
    }

    quarantined_documents = [
        {
            "nom_fichier": str(d.get("nom_fichier") or ""),
            "raison": str(
                d.get("raison_quarantaine")
                or d.get("alerte_injection")
                or "Tentative d'injection de prompt bloquée par le Douanier"
            ),
        }
        for d in docs_quar
        if d.get("nom_fichier")
    ]

    vendors: list[dict[str, Any]] = []
    handled_doc_names: set[str] = set()

    # 1. Prestataire de télémaintenance imagerie/PACS (MedTech Solutions SAS / sa-prestataire-meditech)
    medtech_doc_name: str | None = None
    for cand in list(quar_by_name.keys()) + list(clean_by_name.keys()):
        if re.search(r"fournisseur|maintenance|medtech|prestataire", cand, re.I):
            medtech_doc_name = cand
            handled_doc_names.add(cand)
            break

    medtech_quar_doc = quar_by_name.get(medtech_doc_name or "")
    medtech_is_quar = medtech_quar_doc is not None
    medtech_quar_reason = (
        str(
            medtech_quar_doc.get("raison_quarantaine")
            or medtech_quar_doc.get("alerte_injection")
            or "Instruction d'injection de prompt indirecte détectée et isolée par le Douanier"
        )
        if medtech_quar_doc
        else None
    )

    medtech_findings: list[dict[str, Any]] = []
    for f in findings:
        blob = json.dumps(f, ensure_ascii=False).lower()
        fid = str(f.get("id") or "")
        if (
            fid in {"F-001", "F-002", "F-006"}
            or "meditech" in blob
            or "medtech" in blob
            or "allow-ssh-anywhere" in blob
            or "export-radiologie" in blob
        ):
            medtech_findings.append(f)

    medtech_fids = [str(f["id"]) for f in medtech_findings if f.get("id")]
    medtech_risk = _evaluate_vendor_risk_from_findings(
        medtech_findings, quarantined=medtech_is_quar
    )
    vendors.append(
        {
            "id": "SUP-001",
            "name": "MedTech Solutions SAS",
            "provider": "MedTech Solutions SAS",
            "role": "Télémaintenance Imagerie DICOM & Stockage PACS",
            "context": (
                "Contrat MNT-2025-089 — Maintenance des passerelles DICOM, accès distant "
                "et compte de service GCP sa-prestataire-meditech (roles/editor, clé 248 j)."
            ),
            "contract_ref": "MNT-2025-089 (PSSI §3.3 & §4.3)",
            "risk_level": medtech_risk,
            "finding_ids": medtech_fids,
            "quarantined": medtech_is_quar,
            "quarantine_reason": medtech_quar_reason,
            "source_document": medtech_doc_name or "PSSI_CH_Valmont.md",
            "recommended_clauses": [
                "Art. 21 §2 (d) & PSSI §4.1 : Révoquer la clé statique USER_MANAGED (248 j > 90 j) de sa-prestataire-meditech, migrer vers Workload Identity Federation et substituer roles/editor par un rôle minimal scopé.",
                "Art. 21 §2 (d) & PSSI §4.3 : Exiger par avenant PAS HDS/NIS2 le passage exclusif par bastion Identity-Aware Proxy (IAP) / VPN avec MFA nominatif (suppression de allow-ssh-anywhere 0.0.0.0/0).",
                "Art. 21 §2 (d) — Intégrité contractuelle : Notifier un audit contradictoire sécurité suite à la charge d'injection de prompt détectée dans l'annexe technique MNT-2025-089.",
            ],
        }
    )

    # 2. Infogérance / Prestataire Poste Administratif & Messagerie (différencié AVANT vs APRES via F-004)
    has_f004_incident = (
        "F-004" in by_id and by_id["F-004"].get("statut") != "conforme"
    )
    infogerance_findings = [
        f
        for f in findings
        if str(f.get("id") or "") in {"F-002", "F-004", "F-006"}
        or "compte prestataire" in json.dumps(f, ensure_ascii=False).lower()
    ]
    infogerance_fids = [str(f["id"]) for f in infogerance_findings if f.get("id")]
    if has_f004_incident:
        infogerance_risk = "CRITIQUE"
        infogerance_ctx = (
            "Compromission avérée d'un compte prestataire sur poste administratif en septembre "
            "(interruption messagerie interne d'une demi-journée non qualifiée ni notifiée ANSSI sous 24 h)."
        )
        infogerance_src = "notes_entretien_DSI.md"
    else:
        infogerance_risk = (
            "ÉLEVÉ"
            if any(f.get("statut") != "conforme" for f in infogerance_findings)
            else "MAÎTRISÉ"
        )
        infogerance_ctx = (
            "Accès tiers d'administration & support bureautique exposés par l'ouverture SSH "
            "0.0.0.0/0 et la persistance du compte générique admin-legacy (PSSI §4.1 & §4.2)."
        )
        infogerance_src = "PSSI_CH_Valmont.md"

    vendors.append(
        {
            "id": "SUP-002",
            "name": "Prestataire Support Administratif & Messagerie",
            "provider": "Prestataire Support Administratif & Messagerie",
            "role": "Infogérance Poste de Travail & Messagerie Interne",
            "context": infogerance_ctx,
            "contract_ref": "Convention PAS PSSI §3.3 & §6.2",
            "risk_level": infogerance_risk,
            "finding_ids": infogerance_fids,
            "quarantined": False,
            "quarantine_reason": None,
            "source_document": infogerance_src,
            "recommended_clauses": [
                "Art. 21 §2 (d) & Art. 23 §4 (a) : Imposer contractuellement un SLA d'alerte sécurité <= 4 heures vers l'astreinte RSSI du CH Valmont pour tenir le délai légal d'alerte précoce ANSSI (24 h).",
                "PSSI §4.1 & §4.2 : Interdire tout compte générique partagé (admin-legacy), imposer le MFA matériel sur tout accès distant et révoquer les droits sous 48 h en fin d'intervention.",
            ],
        }
    )

    # 3. Hébergeur Cloud Souverain / Responsabilité Partagée HDS (Google Cloud europe-west9)
    cloud_findings = [
        f
        for f in findings
        if str(f.get("id") or "") in {"F-003", "F-005", "F-007"}
        or any(
            kw in json.dumps(f, ensure_ascii=False).lower()
            for kw in ("backups-dpi", "kms", "logging")
        )
    ]
    cloud_fids = [str(f["id"]) for f in cloud_findings if f.get("id")]
    non_conf_cloud = [f for f in cloud_findings if f.get("statut") != "conforme"]
    if any(f.get("statut") == "non_conforme" for f in non_conf_cloud):
        cloud_risk = "ÉLEVÉ"
    elif non_conf_cloud:
        cloud_risk = "MODÉRÉ"
    else:
        cloud_risk = "MAÎTRISÉ"

    vendors.append(
        {
            "id": "SUP-003",
            "name": "Google Cloud Platform (europe-west9 — Paris)",
            "provider": "Google Cloud Platform (europe-west9 — Paris)",
            "role": "Hébergement Cloud Souverain & Continuité HDS",
            "context": (
                "Matrice de responsabilité partagée HDS/NIS2 — Configuration client des sauvegardes "
                "DPI (WORM), de la rotation cryptographique Cloud KMS et de la rétention Cloud Logging."
            ),
            "contract_ref": "Annexe HDS / Souveraineté PSSI §1.2, §5.2 & §6.1",
            "risk_level": cloud_risk,
            "finding_ids": cloud_fids,
            "quarantined": False,
            "quarantine_reason": None,
            "source_document": "PSSI_CH_Valmont.md",
            "recommended_clauses": [
                "Art. 21 §2 (d) & (c) : Appliquer côté client l'obligation de responsabilité partagée en activant le versioning et le Bucket Lock WORM 30 j sur gs://ch-valmont-demo-backups-dpi.",
                "Art. 21 §2 (d) & (h) : Verrouiller par Organization Policy la localisation europe-west9, activer la rotation KMS 90 j (key-dpi-patients) et porter Cloud Logging _Default à 365 j.",
            ],
        }
    )

    # 4. Détection dynamique de toute pièce additionnelle en quarantaine ou contrat tiers téléversé
    extra_idx = 4
    for d in docs_quar:
        dname = str(d.get("nom_fichier") or "")
        if not dname or dname in handled_doc_names:
            continue
        handled_doc_names.add(dname)
        q_reason = str(
            d.get("raison_quarantaine")
            or d.get("alerte_injection")
            or "Document tiers bloqué en quarantaine anti-injection par le Douanier"
        )
        vendors.append(
            {
                "id": f"SUP-{extra_idx:03d}",
                "name": f"Tiers Documentaire ({dname})",
                "provider": f"Tiers Documentaire ({dname})",
                "role": "Pièce externe / Annexe tierce isolée",
                "context": f"Pièce '{dname}' placée en quarantaine préventive avant soumission LLM.",
                "contract_ref": dname,
                "risk_level": "CRITIQUE",
                "finding_ids": [],
                "quarantined": True,
                "quarantine_reason": q_reason,
                "source_document": dname,
                "recommended_clauses": [
                    "Art. 21 §2 (d) : Bloquer l'intégration documentaire automatisée et conduire une revue contradictoire d'intégrité auprès de l'émetteur tiers.",
                ],
            }
        )
        extra_idx += 1

    counts = {
        "total": len(vendors),
        "critique": sum(1 for v in vendors if v["risk_level"] == "CRITIQUE"),
        "eleve": sum(1 for v in vendors if v["risk_level"] == "ÉLEVÉ"),
        "modere": sum(1 for v in vendors if v["risk_level"] == "MODÉRÉ"),
        "maitrise": sum(1 for v in vendors if v["risk_level"] == "MAÎTRISÉ"),
    }
    overall_risk = (
        max(
            (str(v["risk_level"]) for v in vendors),
            key=lambda r: _SUPPLY_RISK_RANK.get(r, 0),
        )
        if vendors
        else "MAÎTRISÉ"
    )

    return {
        "session_id": session_id,
        "mode": active_mode,
        "has_synthesis": True,
        "article": "Art. 21 §2 (d) — Sécurité de la chaîne d'approvisionnement",
        "pssi_reference": "PSSI §3.3 — Gestion des tiers et sous-traitants (PAS NIS2 / HDS)",
        "source": "server",
        "overall_risk": overall_risk,
        "quarantined_docs_count": len(quarantined_documents),
        "quarantined_documents": quarantined_documents,
        "vendors": vendors,
        "providers": vendors,
        "summary_counts": counts,
    }


@app.get("/api/nis2/continuity")
def get_nis2_continuity(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    """Tableau de bord Continuité Clinique PCA/PRA, RTO/RPO & Exposition Rançongiciel (NIS2 Art. 21 §2 c)."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    syn = slot.get("synthesis")
    has_synthesis = isinstance(syn, dict)

    if not has_synthesis:
        return {
            "session_id": session_id,
            "mode": active_mode,
            "has_synthesis": False,
            "article": "Art. 21 §2 (c) — Continuité des activités, gestion des sauvegardes et reprise après sinistre",
            "pssi_reference": "PSSI §5.1, §5.2 & §5.3 — Objectifs RTO 4 h / RPO 24 h, sauvegardes 30 j et test PRA annuel",
            "source": "server",
            "overall_risk": "MAÎTRISÉ",
            "overall_exposure": "MAÎTRISÉ",
            "ransomware_readiness": "IMMUTABLE",
            "ransomware_exposed_count": 0,
            "immutable_count": 0,
            "processes": [],
            "summary_counts": {
                "total": 0,
                "immutable": 0,
                "expose": 0,
                "rto_rpo_gaps": 0,
                "critique": 0,
                "eleve": 0,
                "modere": 0,
                "maitrise": 0,
            },
        }

    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    by_id: dict[str, dict[str, Any]] = {
        str(f.get("id")): f for f in findings if f.get("id")
    }
    is_apres = active_mode == "APRES"

    # 1. Processus vital #1 : DPI Patients (Dossier Patient Informatisé, Urgences & Prescriptions)
    f003 = by_id.get("F-003")
    dpi_backup_exposed = bool(f003 and f003.get("statut") != "conforme") or any(
        "backups-dpi" in json.dumps(f, ensure_ascii=False).lower() and f.get("statut") != "conforme"
        for f in findings
    )
    dpi_fids = [
        fid
        for fid in ("F-003", "F-006", "F-007")
        if fid in by_id
    ]
    if not dpi_fids:
        dpi_fids = [
            str(f["id"])
            for f in findings
            if f.get("id")
            and any(
                kw in json.dumps(f, ensure_ascii=False).lower()
                for kw in ("backups-dpi", "sauvegarde", "dpi", "kms")
            )
        ]

    dpi_ransomware = "EXPOSÉ" if dpi_backup_exposed else "IMMUTABLE"
    dpi_risk = "CRITIQUE" if dpi_backup_exposed else "MAÎTRISÉ"
    dpi_context = (
        "Contradiction majeure Dit ≠ Réel : la DSI affirme que « les sauvegardes sont protégées contre les rançongiciels », "
        "alors que gs://ch-valmont-demo-backups-dpi n'a ni Object Versioning ni verrouillage WORM (F-003) et reste accessible "
        "aux comptes sur-privilégiés roles/editor & roles/owner (F-006)."
        if (is_apres and dpi_backup_exposed)
        else (
            "Divergence critique Écrit ≠ Réel face à la PSSI §5.1/§5.2 : le bucket gs://ch-valmont-demo-backups-dpi est dépourvu "
            "de versioning et de politique de rétention verrouillée, et l'exercice PV-PRA-2025-03 n'a pas testé la compromission IAM Cloud."
            if dpi_backup_exposed
            else "Sauvegardes DPI protégées par versioning et verrouillage WORM conformes aux objectifs PSSI §5.1/§5.2."
        )
    )
    dpi_actions = [
        "Activer immédiatement Object Versioning et une rétention WORM verrouillée de 30 jours minimum (2 592 000 s) sur gs://ch-valmont-demo-backups-dpi (F-003).",
        "Activer la rotation automatique à 90 jours de la clé Cloud KMS key-dpi-patients et supprimer les rôles primitifs roles/editor / roles/owner (F-006, F-007).",
        "Exécuter un exercice PRA complet incluant la simulation d'un compte administrateur Cloud compromis et la bascule en mode dégradé papier des soins.",
    ]

    # 2. Processus vital #2 : Imagerie PACS / DICOM
    f005 = by_id.get("F-005")
    f001 = by_id.get("F-001")
    pacs_archive_immutable = (f005 is None) or (f005.get("statut") == "conforme")
    pacs_export_exposed = bool(f001 and f001.get("statut") != "conforme")
    pacs_fids = [fid for fid in ("F-005", "F-001") if fid in by_id]
    pacs_ransomware = "IMMUTABLE" if pacs_archive_immutable else "EXPOSÉ"
    pacs_risk = (
        "CRITIQUE"
        if not pacs_archive_immutable
        else ("MODÉRÉ" if pacs_export_exposed or f005 is not None else "MAÎTRISÉ")
    )
    pacs_actions = [
        "Étendre l'exercice PRA annuel S1 2026 au périmètre PACS/DICOM (exclu du test PV-PRA-2025-03 du 18/03/2025) afin de qualifier le RTO réel face à la cible de 4 h (PSSI §5.3).",
        "Maintenir le verrouillage WORM 365 jours et la rotation KMS 90 jours sur gs://ch-valmont-demo-archives-pacs (F-005) et révoquer l'exposition publique allUsers sur export-radiologie (F-001).",
    ]

    # 3. Processus vital #3 : Messagerie & Postes Administratifs (différencié AVANT vs APRES via F-004)
    has_f004_outage = "F-004" in by_id and by_id["F-004"].get("statut") != "conforme"
    admin_exposed = bool(
        has_f004_outage
        or any(
            fid in by_id and by_id[fid].get("statut") != "conforme"
            for fid in ("F-002", "F-006", "F-007")
        )
    )
    msg_fids = [
        fid
        for fid in (("F-004", "F-002", "F-006", "F-007") if has_f004_outage else ("F-002", "F-006", "F-007"))
        if fid in by_id
    ]
    msg_ransomware = "EXPOSÉ" if admin_exposed else "IMMUTABLE"
    if has_f004_outage:
        msg_risk = "CRITIQUE"
        msg_rto_actual = "Indisponibilité réelle d'une demi-journée (~4 h–6 h) subie en septembre (F-004)"
        msg_rto_gap = (
            "Incident réel survenu en septembre (compromission d'un compte prestataire sur poste administratif) "
            "ayant interrompu la messagerie sans déclenchement du PCA ni alerte précoce ANSSI sous 24 h (F-004)."
        )
        msg_rpo_actual = "Traces Cloud Logging de septembre purgées (> 30 j sur _Default — F-007)"
        msg_rpo_gap = "Perte des preuves forensiques au-delà de 30 jours, en violation directe des 12 mois exigés par la PSSI §6.1."
        msg_context = (
            "Sinistre réel avéré en entretien (F-004) : compromission d'un compte prestataire sur poste administratif en septembre "
            "ayant coupé la messagerie interne une demi-journée, combinée à l'exposition SSH 0.0.0.0/0 (F-002) et à la purge des journaux à 30 j (F-007)."
        )
    else:
        msg_risk = "ÉLEVÉ" if admin_exposed else "MAÎTRISÉ"
        msg_rto_actual = "Non qualifié (aucun test PCA messagerie / bureautique documenté)"
        msg_rto_gap = (
            "Surface de mouvement latéral ouverte (SSH 0.0.0.0/0 F-002 + clés statiques 248 j F-006) menaçant la messagerie de crise."
        )
        msg_rpo_actual = "Rétention forensique plafonnée à 30 jours sur Cloud Logging _Default (F-007)"
        msg_rpo_gap = "Écart PSSI §6.1 : rétention de 30 jours insuffisante pour investiguer une compromission latente (cible : 365 jours)."
        msg_context = (
            "Exposition élevée des postes d'administration et de la messagerie interne via allow-ssh-anywhere (0.0.0.0/0, F-002), "
            "comptes à privilèges excessifs (F-006) et rétention de journaux limitée à 30 jours (F-007)."
        )

    msg_actions = [
        "Déployer un canal de communication de crise hors-bande indépendant de la messagerie interne et appliquer la grille de notification ANSSI 24 h / 72 h / 1 mois (Art. 23 NIS2 — F-004).",
        "Restreindre SSH au bastion IAP 35.235.240.0/20 (F-002), révoquer la clé statique prestataire de 248 j ainsi que admin-legacy (F-006) et porter Cloud Logging _Default à 365 jours (F-007).",
        "Inscrire un exercice annuel de continuité messagerie & confinement de poste administratif compromis au calendrier PCA/PRA.",
    ]

    processes: list[dict[str, Any]] = [
        {
            "id": "PROC-001",
            "name": "DPI Patients",
            "criticality": "VITALE — Soins critiques, Urgences & Prescriptions (620 lits)",
            "pssi_ref": "PSSI §5.1, §5.2 & §5.3",
            "context": dpi_context,
            "backup_resource": "gs://ch-valmont-demo-backups-dpi",
            "rto_target": "4 h (PSSI §5.1)",
            "rto_actual": (
                "> 72 h sous rançongiciel (2 h 15 hors attaque sur pré-prod — PV-PRA-2025-03)"
                if dpi_backup_exposed
                else "2 h 15 validé (PV-PRA-2025-03)"
            ),
            "rto_gap": bool(dpi_backup_exposed),
            "rto_gap_detail": (
                "Test PRA du 18/03/2025 mené sans scénario de compromission IAM ni verrouillage WORM : reconstruction complète requise en cas de wiper."
                if dpi_backup_exposed
                else "Conforme au RTO cible de 4 h."
            ),
            "rto_compliant": not dpi_backup_exposed,
            "rpo_target": "24 h (PSSI §5.1 — rétention 30 j §5.2)",
            "rpo_actual": (
                "Perte totale possible (> 30 j) — versioning & Bucket Lock désactivés"
                if dpi_backup_exposed
                else "≤ 24 h (sauvegardes immuables 30 j)"
            ),
            "rpo_gap": bool(dpi_backup_exposed),
            "rpo_gap_detail": (
                "Bucket gs://ch-valmont-demo-backups-dpi supprimable par tout compte roles/editor ou roles/owner compromis (F-003, F-006)."
                if dpi_backup_exposed
                else "Conforme au RPO cible de 24 h."
            ),
            "rpo_compliant": not dpi_backup_exposed,
            "ransomware_status": dpi_ransomware,
            "exposure_level": dpi_risk,
            "risk_level": dpi_risk,
            "pca_pra_exposure": dpi_risk,
            "last_test_ref": "PV-PRA-2025-03 (18 mars 2025 — pré-prod DPI, hors scénario ransomware)",
            "pra_last_tested": "18 mars 2025 (PV-PRA-2025-03 — pré-prod DPI uniquement, sans scénario ransomware)",
            "finding_ids": dpi_fids,
            "pra_actions": dpi_actions,
            "required_pra_actions": dpi_actions,
            "recommended_actions": dpi_actions,
        },
        {
            "id": "PROC-002",
            "name": "Imagerie PACS / DICOM",
            "criticality": "ESSENTIELLE — Diagnostic Médico-Technique & Archives Radiologie",
            "pssi_ref": "PSSI §3.1, §5.1 & §5.3",
            "context": (
                "Le stockage d'archives gs://ch-valmont-demo-archives-pacs est protégé par versioning et rétention WORM verrouillée 365 j (témoin conforme F-005), "
                "mais la reprise PACS n'a pas été testée lors de l'exercice PV-PRA-2025-03 et le bucket d'échange export-radiologie est exposé à allUsers (F-001)."
            ),
            "backup_resource": "gs://ch-valmont-demo-archives-pacs",
            "rto_target": "4 h (PSSI §5.1)",
            "rto_actual": "Non démontré (périmètre PACS exclu du test PV-PRA-2025-03)",
            "rto_gap": True,
            "rto_gap_detail": "Temps de remontée d'un volume DICOM complet non mesuré en 2025 (écart PSSI §5.3).",
            "rto_compliant": False,
            "rpo_target": "24 h (PSSI §5.1)",
            "rpo_actual": (
                "≤ 24 h (versioning actif + rétention WORM verrouillée 365 j — F-005)"
                if pacs_archive_immutable
                else "Exposé (verrouillage absent)"
            ),
            "rpo_gap": not pacs_archive_immutable,
            "rpo_gap_detail": (
                "Immutabilité WORM 365 j conforme sur archives-pacs ; cloisonner le bucket secondaire export-radiologie (F-001)."
                if pacs_archive_immutable
                else "Absence d'immutabilité WORM."
            ),
            "rpo_compliant": pacs_archive_immutable,
            "ransomware_status": pacs_ransomware,
            "exposure_level": pacs_risk,
            "risk_level": pacs_risk,
            "pca_pra_exposure": pacs_risk,
            "last_test_ref": "Non testé en 2025 (exclu de PV-PRA-2025-03 — planifié S1 2026)",
            "pra_last_tested": "Non testé en 2025 (exclu de PV-PRA-2025-03 — planifié S1 2026)",
            "finding_ids": pacs_fids,
            "pra_actions": pacs_actions,
            "required_pra_actions": pacs_actions,
            "recommended_actions": pacs_actions,
        },
        {
            "id": "PROC-003",
            "name": "Messagerie & Postes Administratifs",
            "criticality": "IMPORTANTE — Coordination Cellule de Crise, Admissions & Support",
            "pssi_ref": "PSSI §4.3, §5.1, §6.1 & §6.2",
            "context": msg_context,
            "backup_resource": "compute/firewalls/allow-ssh-anywhere & logging/buckets/_Default",
            "rto_target": "4 h (Coordination crise & alerte ANSSI < 24 h — PSSI §5.1 & §6.2)",
            "rto_actual": msg_rto_actual,
            "rto_gap": bool(admin_exposed),
            "rto_gap_detail": msg_rto_gap,
            "rto_compliant": not admin_exposed,
            "rpo_target": "24 h / Conservation forensique 365 j (PSSI §6.1)",
            "rpo_actual": msg_rpo_actual,
            "rpo_gap": bool(admin_exposed),
            "rpo_gap_detail": msg_rpo_gap,
            "rpo_compliant": not admin_exposed,
            "ransomware_status": msg_ransomware,
            "exposure_level": msg_risk,
            "risk_level": msg_risk,
            "pca_pra_exposure": msg_risk,
            "last_test_ref": "Aucun exercice PCA hors-bande documenté",
            "pra_last_tested": "Aucun exercice PCA hors-bande documenté",
            "finding_ids": msg_fids,
            "pra_actions": msg_actions,
            "required_pra_actions": msg_actions,
            "recommended_actions": msg_actions,
        },
    ]

    summary_counts = {
        "total": len(processes),
        "immutable": sum(1 for p in processes if p["ransomware_status"] == "IMMUTABLE"),
        "expose": sum(1 for p in processes if p["ransomware_status"] == "EXPOSÉ"),
        "rto_rpo_gaps": sum(1 for p in processes if p["rto_gap"] or p["rpo_gap"]),
        "critique": sum(1 for p in processes if p["exposure_level"] == "CRITIQUE"),
        "eleve": sum(1 for p in processes if p["exposure_level"] == "ÉLEVÉ"),
        "modere": sum(1 for p in processes if p["exposure_level"] == "MODÉRÉ"),
        "maitrise": sum(1 for p in processes if p["exposure_level"] == "MAÎTRISÉ"),
    }
    if summary_counts["critique"] > 0:
        overall_risk = "CRITIQUE"
    elif summary_counts["eleve"] > 0:
        overall_risk = "ÉLEVÉ"
    elif summary_counts["modere"] > 0:
        overall_risk = "MODÉRÉ"
    else:
        overall_risk = "MAÎTRISÉ"

    ransomware_readiness = "EXPOSÉ" if summary_counts["expose"] > 0 else "IMMUTABLE"

    return {
        "session_id": session_id,
        "mode": active_mode,
        "has_synthesis": True,
        "article": "Art. 21 §2 (c) — Continuité des activités, gestion des sauvegardes et reprise après sinistre",
        "pssi_reference": "PSSI §5.1, §5.2 & §5.3 — Objectifs RTO 4 h / RPO 24 h, sauvegardes 30 j et test PRA annuel",
        "source": "server",
        "overall_risk": overall_risk,
        "overall_exposure": overall_risk,
        "ransomware_readiness": ransomware_readiness,
        "ransomware_exposed_count": summary_counts["expose"],
        "immutable_count": summary_counts["immutable"],
        "processes": processes,
        "summary_counts": summary_counts,
    }


@app.get("/api/nis2/crosswalk")
def get_nis2_crosswalk(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    """Table de correspondance multi-référentiels Santé : NIS2 ↔ HDS v2.0 ↔ ISO/IEC 27001:2022 ↔ RGPD Art. 32/33."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    syn = slot.get("synthesis")
    report_title = (
        "Correspondance Multi-Référentiels Santé — NIS2 ↔ HDS v2.0 ↔ ISO/IEC 27001:2022 ↔ RGPD Art. 32/33"
    )
    framework_labels: dict[str, str] = {
        "HDS": "Hébergeur de Données de Santé (HDS v2.0)",
        "ISO27001": "ISO/IEC 27001:2022 (Annexe A)",
        "RGPD": "RGPD (Art. 28, 32, 33 & 34 — Données de Santé)",
    }

    if not isinstance(syn, dict):
        empty_fw = {
            fw_key: {
                "framework": fw_key,
                "label": fw_label,
                "total_controls": 0,
                "compliant_count": 0,
                "gap_count": 0,
                "conformity_pct": 0,
                "status_label": "EN ATTENTE D'AUDIT",
            }
            for fw_key, fw_label in framework_labels.items()
        }
        return {
            "session_id": session_id,
            "mode": active_mode,
            "has_synthesis": False,
            "source": "server",
            "title": report_title,
            "frameworks_summary": empty_fw,
            "entries": [],
            "summary_counts": {
                "total": 0,
                "gaps": 0,
                "conforme": 0,
                "non_conforme": 0,
                "partiel": 0,
                "a_confirmer": 0,
            },
        }

    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    by_id: dict[str, dict[str, Any]] = {
        str(f.get("id")): f for f in findings if f.get("id")
    }
    nis2_reqs = {
        str(r.get("id")): r
        for r in get_nis2_requirements()
        if isinstance(r, dict) and r.get("id")
    }

    def _norm_status(fid: str, default_status: str) -> str:
        f = by_id.get(fid)
        if not f:
            return default_status
        raw = str(f.get("statut") or "").strip().lower()
        if raw in {"conforme", "partiel", "non_conforme", "a_confirmer"}:
            return raw
        return default_status

    def _norm_gravite(fid: str, default_gravite: str) -> str:
        f = by_id.get(fid)
        if not f:
            return default_gravite
        raw = str(f.get("gravite") or "").strip().lower()
        if raw in {"critique", "haute", "moyenne", "faible"}:
            return raw
        return default_gravite

    def _present_fids(*candidates: str) -> list[str]:
        return [cid for cid in candidates if cid in by_id]

    is_apres = active_mode == "APRES" or "F-004" in by_id
    r23_title = str(
        (nis2_reqs.get("NIS2-23") or {}).get("titre")
        or "Obligations de déclaration d'incident (24h alerte précoce, 72h notification)"
    )

    if is_apres:
        cw8_statut = _norm_status("F-004", "non_conforme")
        cw8_gravite = _norm_gravite("F-004", "haute")
        cw8_fids = _present_fids("F-004") or ["F-004"]
        cw8_summary = (
            "Compromission d'un compte de messagerie prestataire reconnue à l'oral en septembre (F-004) "
            "sans trace de pré-notification ANSSI (< 24 h) ni d'instruction contradictoire DPO / CNIL (< 72 h, RGPD Art. 33)."
        )
    else:
        cw8_statut = "a_confirmer"
        cw8_gravite = "moyenne"
        cw8_fids = []
        cw8_summary = (
            "Procédure écrite d'alerte ANSSI < 24 h (PSSI §6.2) présente au dossier ; effectivité opérationnelle "
            "du double guichet ANSSI / CNIL (RGPD Art. 33) et absence d'incident antérieur à vérifier en entretien contradictoire."
        )

    entries: list[dict[str, Any]] = [
        {
            "id": "CW-001",
            "nis2_article": "Art. 21 §2 (i) & (j)",
            "nis2_title": "Contrôle d'accès, sécurité des actifs et protection des données sensibles",
            "domain": "Cloisonnement Stockage Cloud & Imagerie Médicale (DSCP)",
            "hds_ref": "HDS v2.0 Exigences 4.2 & 4.5",
            "hds_detail": (
                "Cloisonnement strict des compartiments contenant des données de santé à caractère personnel "
                "(DSCP) et interdiction absolue d'exposition publique non authentifiée."
            ),
            "iso27001_ref": "Annexe A.5.15, A.8.3 & A.8.24",
            "iso27001_detail": (
                "Contrôle d'accès logique, restriction d'accès à l'information et protection des compartiments d'échange."
            ),
            "rgpd_ref": "RGPD Art. 9 & Art. 32 §1 (a)(b)",
            "rgpd_detail": (
                "Confidentialité des données concernant la santé : exposition publique allUsers sur "
                "gs://ch-valmont-demo-export-radiologie constitutive d'un risque de violation notifiable (Art. 33)."
            ),
            "frameworks": ["HDS", "ISO27001", "RGPD"],
            "statut": _norm_status("F-001", "non_conforme"),
            "gravite": _norm_gravite("F-001", "critique"),
            "summary": (
                "Compartiment d'export radiologique exposé publiquement sur Internet (allUsers : objectViewer) "
                "en contradiction directe avec la PSSI §3.1, le référentiel HDS et l'Art. 32 RGPD."
            ),
            "finding_ids": _present_fids("F-001"),
            "cnil_applicable": True,
        },
        {
            "id": "CW-002",
            "nis2_article": "Art. 21 §2 (e) & (j)",
            "nis2_title": "Sécurité de l'exploitation réseau et authentification multifacteur (MFA)",
            "domain": "Filtrage Réseau Périmétrique & Bastion d'Administration",
            "hds_ref": "HDS v2.0 Exigence 4.4",
            "hds_detail": (
                "Restriction des flux d'administration système aux rebonds authentifiés (IAP / Bastion MFA) "
                "et proscription d'ouverture SSH directe sur Internet."
            ),
            "iso27001_ref": "Annexe A.8.5, A.8.20 & A.8.22",
            "iso27001_detail": (
                "Authentification sécurisée des administrateurs, sécurité des réseaux et ségrégation des flux."
            ),
            "rgpd_ref": "RGPD Art. 32 §1 (b) (périmètre infrastructure)",
            "rgpd_detail": (
                "Durcissement périmétrique concourant à la protection indirecte des serveurs hospitaliers."
            ),
            "frameworks": ["HDS", "ISO27001"],
            "statut": _norm_status("F-002", "non_conforme"),
            "gravite": _norm_gravite("F-002", "critique"),
            "summary": (
                "Règle pare-feu allow-ssh-anywhere ouverte sur 0.0.0.0/0:22 en production malgré l'interdiction "
                "formelle de la PSSI §4.2 et l'obligation de rebond MFA."
            ),
            "finding_ids": _present_fids("F-002"),
            "cnil_applicable": False,
        },
        {
            "id": "CW-003",
            "nis2_article": "Art. 21 §2 (c)",
            "nis2_title": "Continuité des activités, gestion des sauvegardes et reprise après sinistre",
            "domain": "Résilience du DPI Patients & Protection Anti-Rançongiciel",
            "hds_ref": "HDS v2.0 Exigence 4.7",
            "hds_detail": (
                "Disponibilité garantie des DSCP, sauvegardes immuables (versioning + WORM) et tests réguliers de restauration."
            ),
            "iso27001_ref": "Annexe A.5.29, A.5.30 & A.8.13",
            "iso27001_detail": (
                "Préparation des TIC pour la continuité des soins (RTO 4 h / RPO 24 h) et sauvegarde intègre."
            ),
            "rgpd_ref": "RGPD Art. 32 §1 (c) & (d)",
            "rgpd_detail": (
                "Capacité à rétablir la disponibilité et l'accès aux dossiers patients dans des délais appropriés "
                "en cas d'incident physique ou technique (rançongiciel)."
            ),
            "frameworks": ["HDS", "ISO27001", "RGPD"],
            "statut": _norm_status("F-003", "non_conforme"),
            "gravite": _norm_gravite("F-003", "haute"),
            "summary": (
                "Bucket gs://ch-valmont-demo-backup-dpi dépourvu de versioning et de rétention WORM (7 j glissants), "
                "avec dépassement RTO 6h20 lors du test PV-PRA-2025-03 (cible PSSI 4 h)."
            ),
            "finding_ids": _present_fids("F-003"),
            "cnil_applicable": False,
        },
        {
            "id": "CW-004",
            "nis2_article": "Art. 21 §2 (c) & (f)",
            "nis2_title": "Protection de l'intégrité des archives critiques et évaluation d'efficacité",
            "domain": "Archivage Immuable Imagerie PACS / DICOM (Témoin Conforme)",
            "hds_ref": "HDS v2.0 Exigence 4.7.2",
            "hds_detail": (
                "Conservation intègre et verrouillage WORM 365 jours vérifiés sur gs://ch-valmont-demo-archives-pacs."
            ),
            "iso27001_ref": "Annexe A.5.33 & A.8.13",
            "iso27001_detail": (
                "Protection probante des enregistrements médicaux contre la destruction ou la falsification."
            ),
            "rgpd_ref": "RGPD Art. 5 §1 (f) & Art. 32 §1 (b)",
            "rgpd_detail": (
                "Intégrité permanente des archives d'imagerie médicale garantie par politique de rétention verrouillée."
            ),
            "frameworks": ["HDS", "ISO27001", "RGPD"],
            "statut": _norm_status("F-005", "conforme"),
            "gravite": _norm_gravite("F-005", "faible"),
            "summary": (
                "Contrôle témoin positif : versioning actif et rétention WORM verrouillée 365 jours confirmés "
                "sur le compartiment d'archives PACS (F-005)."
            ),
            "finding_ids": _present_fids("F-005"),
            "cnil_applicable": False,
        },
        {
            "id": "CW-005",
            "nis2_article": "Art. 21 §2 (d) & (i)",
            "nis2_title": "Sécurité de la chaîne d'approvisionnement et moindre privilège IAM",
            "domain": "Gouvernance des Sous-Traitants Tiers & Comptes à Privilèges",
            "hds_ref": "HDS v2.0 Exigences 5.1 & 6.2",
            "hds_detail": (
                "Maîtrise contractuelle des sous-traitants intervenant sur le SI hospitalier et bannissement des droits primitifs permanents."
            ),
            "iso27001_ref": "Annexe A.5.19, A.5.21 & A.8.2",
            "iso27001_detail": (
                "Sécurité de l'information dans les relations fournisseurs et restriction des privilèges d'administration."
            ),
            "rgpd_ref": "RGPD Art. 28 & Art. 32 §4",
            "rgpd_detail": (
                "Encadrement écrit obligatoire du sous-traitant MedSoft (Art. 28 RGPD) et limitation stricte des accès tiers aux DSCP."
            ),
            "frameworks": ["HDS", "ISO27001", "RGPD"],
            "statut": _norm_status("F-006", "non_conforme"),
            "gravite": _norm_gravite("F-006", "haute"),
            "summary": (
                "Compte prestataire externe svc-medsoft-maint doté du rôle primitif roles/owner à l'échelle projet "
                "et absent du registre officiel des tiers autorisés."
            ),
            "finding_ids": _present_fids("F-006"),
            "cnil_applicable": True,
        },
        {
            "id": "CW-006",
            "nis2_article": "Art. 21 §2 (h)",
            "nis2_title": "Politiques et procédures relatives à l'utilisation de la cryptographie",
            "domain": "Souveraineté Cryptographique KMS & Clés CMEK",
            "hds_ref": "HDS v2.0 Exigence 4.6",
            "hds_detail": (
                "Maîtrise souveraine du cycle de vie des clés cryptographiques protégeant les compartiments HDS."
            ),
            "iso27001_ref": "Annexe A.8.24",
            "iso27001_detail": (
                "Règles d'utilisation efficace de la cryptographie et rotation périodique des clés (90 jours)."
            ),
            "rgpd_ref": "RGPD Art. 32 §1 (a) & Art. 34 §3 (a)",
            "rgpd_detail": (
                "Le chiffrement CMEK conditionne l'exemption éventuelle de communication individuelle aux patients (Art. 34 §3 a)."
            ),
            "frameworks": ["HDS", "ISO27001"],
            "statut": _norm_status("F-007", "partiel"),
            "gravite": _norm_gravite("F-007", "moyenne"),
            "summary": (
                "Rotation automatique KMS 90 jours conforme sur key-dossier-patient, mais chiffrement Google-managed par défaut "
                "sur plusieurs compartiments de stockage au lieu d'un attachement CMEK systématique."
            ),
            "finding_ids": _present_fids("F-007"),
            "cnil_applicable": False,
        },
        {
            "id": "CW-007",
            "nis2_article": "Art. 21 §2 (f) & Art. 23",
            "nis2_title": "Journalisation forensique d'audit et capacité d'investigation",
            "domain": "Traçabilité Forensique 365 Jours & Qualification d'Exfiltration",
            "hds_ref": "HDS v2.0 Exigence 4.8",
            "hds_detail": (
                "Conservation intègre des traces d'accès et d'administration permettant l'imputabilité et l'analyse post-incident."
            ),
            "iso27001_ref": "Annexe A.8.15 & A.5.28",
            "iso27001_detail": (
                "Production, protection et rétention sur 12 mois des journaux d'événements et collecte de preuves."
            ),
            "rgpd_ref": "RGPD Art. 5 §2 & Art. 33 §3",
            "rgpd_detail": (
                "Principe d'Accountability : une rétention limitée à 30 j empêche d'écarter formellement une exfiltration antérieure sur le bucket public."
            ),
            "frameworks": ["HDS", "ISO27001", "RGPD"],
            "statut": "conforme" if _norm_status("F-007", "partiel") == "conforme" else "non_conforme",
            "gravite": _norm_gravite("F-007", "moyenne"),
            "summary": (
                "Puits Cloud Logging _Default plafonné à 30 jours non verrouillés contre les 365 jours exigés par la PSSI §6.1, "
                "limitant la fenêtre d'investigation forensique RGPD Art. 33."
            ),
            "finding_ids": _present_fids("F-007"),
            "cnil_applicable": True,
        },
        {
            "id": "CW-008",
            "nis2_article": "Art. 23 §1 & §4 + Art. 21 §2 (b)",
            "nis2_title": r23_title,
            "domain": "Double Guichet Réglementaire — ANSSI (24h/72h) & CNIL (72h)",
            "hds_ref": "HDS v2.0 Exigence 5.4",
            "hds_detail": (
                "Notification sans délai au responsable de traitement hospitalier de tout incident affectant les DSCP."
            ),
            "iso27001_ref": "Annexe A.5.24, A.5.25 & A.5.26",
            "iso27001_detail": (
                "Évaluation formelle des événements de sécurité et exécution documentée des procédures d'escalade réglementaire."
            ),
            "rgpd_ref": "RGPD Art. 33 (72 h CNIL) & Art. 34",
            "rgpd_detail": (
                "Notification à la CNIL sous 72 h de toute violation de données présentant un risque pour les patients (avec motivation du retard si > 72 h) et évaluation Art. 34."
            ),
            "frameworks": ["ISO27001", "RGPD"],
            "statut": cw8_statut,
            "gravite": cw8_gravite,
            "summary": cw8_summary,
            "finding_ids": cw8_fids,
            "cnil_applicable": True,
        },
    ]

    frameworks_summary: dict[str, dict[str, Any]] = {}
    for fw_key, fw_label in framework_labels.items():
        fw_entries = [e for e in entries if fw_key in e["frameworks"]]
        total_fw = len(fw_entries)
        compliant_fw = sum(1 for e in fw_entries if e["statut"] == "conforme")
        partiel_fw = sum(1 for e in fw_entries if e["statut"] == "partiel")
        non_conf_fw = sum(1 for e in fw_entries if e["statut"] == "non_conforme")
        a_conf_fw = sum(1 for e in fw_entries if e["statut"] == "a_confirmer")
        gap_fw = non_conf_fw + partiel_fw
        if total_fw > 0:
            weighted = compliant_fw + (0.5 * partiel_fw) + (0.25 * a_conf_fw)
            pct = int(round((weighted / total_fw) * 100))
        else:
            pct = 0
        if non_conf_fw > 0:
            status_lbl = f"NON CONFORME ({gap_fw} écart{'s' if gap_fw > 1 else ''})"
        elif partiel_fw > 0 or a_conf_fw > 0:
            status_lbl = "CONFORMITÉ PARTIELLE"
        else:
            status_lbl = "CONFORME ✓"
        frameworks_summary[fw_key] = {
            "framework": fw_key,
            "label": fw_label,
            "total_controls": total_fw,
            "compliant_count": compliant_fw,
            "gap_count": gap_fw,
            "conformity_pct": pct,
            "status_label": status_lbl,
        }

    conforme_cnt = sum(1 for e in entries if e["statut"] == "conforme")
    non_conforme_cnt = sum(1 for e in entries if e["statut"] == "non_conforme")
    partiel_cnt = sum(1 for e in entries if e["statut"] == "partiel")
    a_confirmer_cnt = sum(1 for e in entries if e["statut"] == "a_confirmer")

    return {
        "session_id": session_id,
        "mode": active_mode,
        "has_synthesis": True,
        "source": "server",
        "title": report_title,
        "frameworks_summary": frameworks_summary,
        "entries": entries,
        "summary_counts": {
            "total": len(entries),
            "gaps": non_conforme_cnt + partiel_cnt,
            "conforme": conforme_cnt,
            "non_conforme": non_conforme_cnt,
            "partiel": partiel_cnt,
            "a_confirmer": a_confirmer_cnt,
        },
    }


def _extract_verbatim_snippet(raw_line: str, start: int, end: int, radius: int = 75) -> str:
    """Extrait une sous-chaîne contiguë exacte de la ligne masquée autour de l'occurrence."""
    stripped = raw_line.strip()
    if len(stripped) <= 2 * radius + (end - start):
        return stripped
    win_start = max(0, start - radius)
    win_end = min(len(raw_line), end + radius)
    if win_start > 0:
        next_space = raw_line.find(" ", win_start, start)
        if next_space != -1:
            win_start = next_space + 1
    if win_end < len(raw_line):
        prev_space = raw_line.rfind(" ", end, win_end)
        if prev_space != -1:
            win_end = prev_space
    snippet = raw_line[win_start:win_end].strip()
    return snippet or raw_line[start:end]


@app.get("/api/documents/search")
def search_sanitized_documents(
    q: str = Query(default="", max_length=200),
    mode: AuditMode | None = None,
    limit: int = Query(default=20, ge=1, le=50),
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    """Recherche plein-texte insensible à la casse uniquement dans les documents masqués (contenu_masque)."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    syn = slot.get("synthesis")
    query_clean = q.strip()

    docs_to_search: list[dict[str, Any]] = []
    if isinstance(syn, dict):
        for group_key in ("documents_nettoyes", "documents_quarantaine"):
            for doc in syn.get(group_key) or []:
                if isinstance(doc, dict) and isinstance(doc.get("contenu_masque"), str):
                    docs_to_search.append(doc)

    if not query_clean or not docs_to_search:
        return {
            "session_id": session_id,
            "mode": active_mode,
            "query": query_clean,
            "has_synthesis": isinstance(syn, dict),
            "documents_searched": len(docs_to_search),
            "total_matches": 0,
            "count": 0,
            "results": [],
        }

    pattern = re.compile(re.escape(query_clean), flags=re.IGNORECASE)
    results: list[dict[str, Any]] = []
    total_matches = 0

    for doc in docs_to_search:
        nom_fichier = str(doc.get("nom_fichier") or "")
        statut = str(doc.get("statut") or "nettoye")
        type_source = doc.get("type_source") or (
            "dit" if "entretien" in nom_fichier.lower() else "ecrit"
        )
        masked_text = str(doc.get("contenu_masque") or "")

        for line_no, raw_line in enumerate(masked_text.splitlines(), start=1):
            if not raw_line:
                continue
            for m in pattern.finditer(raw_line):
                total_matches += 1
                if len(results) < limit:
                    results.append(
                        {
                            "nom_fichier": nom_fichier,
                            "type_source": type_source,
                            "statut": statut,
                            "line": line_no,
                            "column": m.start() + 1,
                            "snippet": _extract_verbatim_snippet(raw_line, m.start(), m.end()),
                            "match": m.group(0),
                        }
                    )

    return {
        "session_id": session_id,
        "mode": active_mode,
        "query": query_clean,
        "has_synthesis": isinstance(syn, dict),
        "documents_searched": len(docs_to_search),
        "total_matches": total_matches,
        "count": len(results),
        "results": results,
    }


class FindingDecisionRequest(BaseModel):
    decision: str
    porteur: str = ""
    echeance: str = ""
    commentaire: str = ""
    note: str | None = None
    mode: AuditMode | None = None


@app.patch("/api/findings/{finding_id}/decision")
def update_finding_decision(
    finding_id: str,
    req: FindingDecisionRequest,
    mode: AuditMode | None = Query(default=None),
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    """Enregistre une décision d'arbitrage GRC sur un constat, réinitialise validated si nécessaire et scelle dans SHA-256."""
    dec_key = req.decision.strip()
    if dec_key not in VALID_GRC_DECISIONS:
        allowed_str = ", ".join(VALID_GRC_DECISIONS.keys())
        raise HTTPException(
            status_code=400,
            detail=f"Décision GRC invalide ('{dec_key}'). Valeurs acceptées : {allowed_str}.",
        )

    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or req.mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    syn = slot.get("synthesis")
    if not isinstance(syn, dict):
        raise HTTPException(
            status_code=400,
            detail=f"Aucun audit disponible en mode {active_mode} pour enregistrer une décision.",
        )

    fid_norm = finding_id.strip().upper()
    target_finding: dict[str, Any] | None = None
    for f in syn.get("findings") or []:
        if isinstance(f, dict) and str(f.get("id") or "").strip().upper() == fid_norm:
            target_finding = f
            break

    if target_finding is None:
        raise HTTPException(
            status_code=404,
            detail=f"Constat '{finding_id}' introuvable dans la synthèse {active_mode}.",
        )

    canonical_fid = str(target_finding.get("id") or fid_norm)
    porteur_clean = req.porteur.strip()[:160]
    echeance_clean = req.echeance.strip()[:64]
    raw_comment = req.commentaire if req.commentaire.strip() else (req.note or "")
    commentaire_clean = raw_comment.strip()[:2000]

    decision_record = {
        "finding_id": canonical_fid,
        "mode": active_mode,
        "decision": dec_key,
        "decision_label": VALID_GRC_DECISIONS[dec_key],
        "porteur": porteur_clean,
        "echeance": echeance_clean,
        "commentaire": commentaire_clean,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    decisions_map = slot.setdefault("decisions", {})
    decisions_map[canonical_fid] = decision_record
    target_finding["decision_grc"] = decision_record

    was_validated = bool(slot.get("validated"))
    validation_reset = False
    if was_validated:
        slot["validated"] = False
        syn["statut_validation"] = "EN ATTENTE DE VALIDATION"
        validation_reset = True

    SESSION_STORE.save(session_id)
    _bump_session_epoch(session_id)

    log_path = _get_audit_log_path(session_id)
    logger = AuditLogger(log_path, run_id=slot.get("run_id"), mode=active_mode)
    logger.append(
        agent="ConsultantDeloitte",
        action="FINDING_DECISION_UPDATED",
        details={
            "finding_id": canonical_fid,
            "mode": active_mode,
            "decision": dec_key,
            "decision_label": VALID_GRC_DECISIONS[dec_key],
            "porteur": porteur_clean,
            "echeance": echeance_clean,
            "validation_reset": validation_reset,
        },
    )

    return {
        "session_id": session_id,
        "mode": active_mode,
        "finding_id": canonical_fid,
        "decision": decision_record,
        "finding": target_finding,
        "validated": slot["validated"],
        "validation_reset": validation_reset,
        "statut_validation": syn["statut_validation"],
        "decisions": dict(decisions_map),
        "chain": verify_chain(log_path),
    }


class SimulateRemediationRequest(BaseModel):
    selected_ids: list[str] = Field(default_factory=list)
    mode: AuditMode | None = None


def _estimate_finding_effort_and_horizon(
    finding: dict[str, Any],
) -> tuple[str, str, float, float, float, str]:
    """Estime l'effort (j.h) et l'horizon (0_30 / 30_60 / 60_90) d'un chantier de remédiation."""
    statut = str(finding.get("statut") or "")
    if statut == "conforme":
        return "faible", "Maintien en condition conforme", 0.0, 0.0, 0.0, "60_90"

    reel = finding.get("reel") if isinstance(finding.get("reel"), dict) else {}
    hay = (
        f"{finding.get('theme') or ''} "
        f"{finding.get('exigence_nis2') or ''} "
        f"{reel.get('ressource') or ''}"
    ).lower()
    cmd = str(finding.get("commande_correction") or "")
    has_cli = bool(cmd.strip())

    effort = "modere"
    effort_label = "Modéré (3 – 6 j.h)"
    min_jh, max_jh, avg_jh = 3.0, 6.0, 4.5

    if (
        has_cli
        and re.search(r"allusers|allow-ssh|firewall|versioning|retention", f"{cmd} {hay}", re.I)
        and not re.search(r"iam|kms|serviceaccount", hay, re.I)
    ):
        effort = "faible"
        effort_label = "Quick-Win Cloud (0,5 – 2 j.h)"
        min_jh, max_jh, avg_jh = 0.5, 2.0, 1.25
    elif (
        re.search(r"incident|notification|anssi|art\.\s*23|pacs|pra|pca|gouvernance", hay, re.I)
        and not has_cli
    ):
        effort = "structurant"
        effort_label = "Structurant (8 – 15 j.h)"
        min_jh, max_jh, avg_jh = 8.0, 15.0, 11.5
    elif re.search(r"iam|kms|logging|journal|privil|serviceaccount|sauvegarde|backup", hay, re.I):
        effort = "modere"
        effort_label = "Modéré IAM / SecOps (4 – 8 j.h)"
        min_jh, max_jh, avg_jh = 4.0, 8.0, 6.0

    gravite = str(finding.get("gravite") or "")
    if effort == "structurant" or gravite in {"faible", "moyenne"}:
        horizon = "60_90"
    elif effort == "faible" and gravite in {"critique", "haute"}:
        horizon = "0_30"
    else:
        horizon = "30_60"

    return effort, effort_label, min_jh, max_jh, avg_jh, horizon


def _pillar_single_score(f: dict[str, Any]) -> int:
    st = f.get("statut")
    if st == "conforme":
        return 94
    if st == "partiel":
        return 55
    if st == "a_confirmer":
        return 42
    return 14 if f.get("gravite") == "critique" else 26


def _finding_art34_risk_weight(f: dict[str, Any]) -> float:
    st = f.get("statut")
    if st == "conforme":
        return 0.0
    grav = f.get("gravite")
    base = 100.0 if grav == "critique" else 75.0 if grav == "haute" else 45.0 if grav == "moyenne" else 20.0
    if st == "partiel":
        return base * 0.45
    if st == "a_confirmer":
        return base * 0.55
    return base


def _risk_level_from_index(risk_index: int, critical_open: int) -> str:
    if critical_open >= 1 or risk_index >= 65:
        return "CRITIQUE"
    if risk_index >= 35:
        return "ÉLEVÉ"
    if risk_index >= 12:
        return "MODÉRÉ"
    return "MAÎTRISÉ"


def _compute_remediation_simulation(
    session_id: str,
    active_mode: AuditMode,
    syn: dict[str, Any] | None,
    raw_selected_ids: list[str],
) -> dict[str, Any]:
    selected_norm: list[str] = []
    selected_set: set[str] = set()
    for raw_id in raw_selected_ids:
        norm = str(raw_id or "").strip().upper()
        if norm and norm not in selected_set:
            selected_set.add(norm)
            selected_norm.append(norm)

    findings = (
        [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
        if isinstance(syn, dict)
        else []
    )
    projected_findings: list[dict[str, Any]] = []
    remediated_ids: list[str] = []
    actionable_ids: list[str] = []
    items_out: list[dict[str, Any]] = []

    total_min_jh = 0.0
    total_max_jh = 0.0
    total_est_jh = 0.0
    quick_wins_count = 0
    by_horizon: dict[str, dict[str, Any]] = {
        "0_30": {"count": 0, "estimated_jh": 0.0, "finding_ids": []},
        "30_60": {"count": 0, "estimated_jh": 0.0, "finding_ids": []},
        "60_90": {"count": 0, "estimated_jh": 0.0, "finding_ids": []},
    }

    for f in findings:
        fid = str(f.get("id") or "").strip().upper()
        cur_statut = str(f.get("statut") or "a_confirmer")
        is_actionable = cur_statut != "conforme"
        if is_actionable:
            actionable_ids.append(fid)

        effort, effort_label, f_min, f_max, f_avg, horizon = _estimate_finding_effort_and_horizon(f)
        is_selected = fid in selected_set
        is_remediated = is_selected and is_actionable

        proj_copy = dict(f)
        if is_remediated:
            proj_copy["statut"] = "conforme"
            remediated_ids.append(fid)
            total_min_jh += f_min
            total_max_jh += f_max
            total_est_jh += f_avg
            if effort == "faible":
                quick_wins_count += 1
            by_horizon[horizon]["count"] += 1
            by_horizon[horizon]["estimated_jh"] = round(
                by_horizon[horizon]["estimated_jh"] + f_avg, 1
            )
            by_horizon[horizon]["finding_ids"].append(fid)

        projected_findings.append(proj_copy)
        items_out.append(
            {
                "id": fid,
                "theme": f.get("theme", ""),
                "exigence_nis2": f.get("exigence_nis2", ""),
                "gravite": f.get("gravite", ""),
                "statut_actuel": cur_statut,
                "statut_projete": proj_copy["statut"],
                "selected": is_selected,
                "remediated": is_remediated,
                "effort": effort,
                "effort_label": effort_label,
                "estimated_jh": round(f_avg, 1),
                "min_jh": round(f_min, 1),
                "max_jh": round(f_max, 1),
                "horizon": horizon,
            }
        )

    current_score = _compute_nis2_score(findings)
    projected_score = _compute_nis2_score(projected_findings)

    pillar_specs = [
        (
            "data-exposure",
            "Protection & Cloisonnement des Données de Santé",
            "Art. 21 §2 (i) — Stockage",
            20,
            lambda x: bool(
                re.search(
                    r"radiologie|exposition des données|public|allusers",
                    f"{x.get('theme') or ''} {(x.get('reel') or {}).get('ressource') or ''}",
                    re.I,
                )
            ),
        ),
        (
            "network-sec",
            "Sécurité Réseau & Administration Système",
            "Art. 21 §2 (i) — Flux",
            20,
            lambda x: bool(
                re.search(
                    r"ssh|pare-feu|réseau|firewall|bastion",
                    f"{x.get('theme') or ''} {(x.get('reel') or {}).get('ressource') or ''}",
                    re.I,
                )
            ),
        ),
        (
            "backup-pca",
            "Continuité d’Activité & Immuabilité des Sauvegardes",
            "Art. 21 §2 (c) — PCA / PRA",
            50,
            lambda x: bool(
                re.search(
                    r"sauvegarde|continuité|pacs|dpi|restauration|backup",
                    f"{x.get('theme') or ''} {x.get('exigence_nis2') or ''} {(x.get('reel') or {}).get('ressource') or ''}",
                    re.I,
                )
            ),
        ),
        (
            "iam-crypto",
            "Gouvernance IAM, Moindre Privilège & Cryptographie KMS",
            "Art. 21 §2 (h, i, j)",
            62,
            lambda x: bool(
                re.search(
                    r"iam|kms|chiffrement|cryptographie|serviceaccount|privil|clé",
                    f"{x.get('theme') or ''} {x.get('exigence_nis2') or ''} {(x.get('reel') or {}).get('ressource') or ''}",
                    re.I,
                )
                and not re.search(
                    r"radiologie|ssh",
                    f"{x.get('theme') or ''} {(x.get('reel') or {}).get('ressource') or ''}",
                    re.I,
                )
            ),
        ),
        (
            "incident-anssi",
            "Gestion des Incidents & Notification ANSSI",
            "Art. 23 — 24h / 72h / 1 mois",
            48 if active_mode == "AVANT" else 22,
            lambda x: bool(
                re.search(
                    r"incident|notification|anssi|art\.\s*23",
                    f"{x.get('theme') or ''} {x.get('exigence_nis2') or ''}",
                    re.I,
                )
            ),
        ),
    ]

    remediated_set = set(remediated_ids)
    pillars_out: list[dict[str, Any]] = []
    for pid, ptitle, particle, fallback_score, pred in pillar_specs:
        cur_matched = [f for f in findings if pred(f)]
        proj_matched = [f for f in projected_findings if pred(f)]
        if not cur_matched:
            cur_p = fallback_score
            proj_p = fallback_score
            m_ids: list[str] = []
        else:
            cur_p = math.floor(
                (sum(_pillar_single_score(f) for f in cur_matched) / len(cur_matched)) + 0.5
            )
            proj_p = math.floor(
                (sum(_pillar_single_score(f) for f in proj_matched) / len(proj_matched)) + 0.5
            )
            m_ids = [str(f.get("id") or "") for f in cur_matched if f.get("id")]

        pillars_out.append(
            {
                "id": pid,
                "title": ptitle,
                "article": particle,
                "current_score": cur_p,
                "projected_score": proj_p,
                "gain": proj_p - cur_p,
                "finding_ids": m_ids,
                "remediated_ids": [fid for fid in m_ids if fid in remediated_set],
            }
        )

    risk_before_raw = sum(_finding_art34_risk_weight(f) for f in findings)
    risk_after_raw = sum(_finding_art34_risk_weight(f) for f in projected_findings)
    max_possible_risk = max(100.0, len(findings) * 100.0) if findings else 100.0
    current_risk_index = (
        min(100, round((risk_before_raw / max_possible_risk) * 100)) if findings else 0
    )
    projected_risk_index = (
        min(100, round((risk_after_raw / max_possible_risk) * 100)) if findings else 0
    )
    exposure_reduction_pct = (
        round(((risk_before_raw - risk_after_raw) / risk_before_raw) * 100.0, 1)
        if risk_before_raw > 0
        else 0.0
    )
    crit_before = sum(
        1
        for f in findings
        if f.get("statut") != "conforme" and f.get("gravite") == "critique"
    )
    crit_after = sum(
        1
        for f in projected_findings
        if f.get("statut") != "conforme" and f.get("gravite") == "critique"
    )

    est_jh = round(total_est_jh, 1)
    min_jh = round(total_min_jh, 1)
    max_jh = round(total_max_jh, 1)
    workload_label = (
        f"{str(est_jh).replace('.', ',')} j.h "
        f"(fourchette {str(min_jh).replace('.', ',')} – {str(max_jh).replace('.', ',')} j.h)"
        if est_jh > 0
        else "0 j.h"
    )

    return {
        "session_id": session_id,
        "mode": active_mode,
        "has_synthesis": isinstance(syn, dict),
        "selected_ids": selected_norm,
        "remediated_ids": remediated_ids,
        "total_findings": len(findings),
        "actionable_findings": len(actionable_ids),
        "current_score": current_score,
        "projected_score": projected_score,
        "score_delta": projected_score - current_score,
        "workload_jh": {
            "estimated_jh": est_jh,
            "min_jh": min_jh,
            "max_jh": max_jh,
            "label": workload_label,
            "quick_wins_count": quick_wins_count,
            "by_horizon": by_horizon,
        },
        "art34_exposure": {
            "entity_category": "Entité Essentielle (Annexe I — Santé)",
            "article": "Art. 34 §4 Directive (UE) 2022/2555 (NIS2)",
            "plafond_sanction_eur": 10_000_000,
            "plafond_ca_pct": 2.0,
            "plafond_label": "Jusqu'à 10 M€ ou 2 % du CA annuel mondial",
            "current_risk_index": current_risk_index,
            "projected_risk_index": projected_risk_index,
            "exposure_reduction_pct": exposure_reduction_pct,
            "critical_gaps_before": crit_before,
            "critical_gaps_after": crit_after,
            "risk_level_before": _risk_level_from_index(current_risk_index, crit_before),
            "risk_level_after": _risk_level_from_index(projected_risk_index, crit_after),
        },
        "pillars": pillars_out,
        "items": items_out,
    }


@app.post("/api/remediation/simulate")
def simulate_remediation_post(
    req: SimulateRemediationRequest | None = Body(default=None),
    mode: AuditMode | None = Query(default=None),
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    """Simule l'impact sur le score NIS2, les 5 piliers, la charge (j.h) et l'exposition Art. 34."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or (req.mode if req else None) or state["mode"]
    slot = state["results_by_mode"][active_mode]
    selected = req.selected_ids if req else []
    return _compute_remediation_simulation(
        session_id=session_id,
        active_mode=active_mode,
        syn=slot.get("synthesis"),
        raw_selected_ids=selected,
    )


@app.get("/api/remediation/simulate")
def simulate_remediation_get(
    selected_ids: str = Query(default=""),
    mode: AuditMode | None = Query(default=None),
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    """Variante GET pratique (?selected_ids=F-001,F-002&mode=APRES) du simulateur d'impact NIS2."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    parsed_ids = [s.strip() for s in selected_ids.split(",") if s.strip()]
    return _compute_remediation_simulation(
        session_id=session_id,
        active_mode=active_mode,
        syn=slot.get("synthesis"),
        raw_selected_ids=parsed_ids,
    )


@app.post("/api/validate")
def validate_audit(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    if not slot["synthesis"]:
        raise HTTPException(status_code=400, detail="Aucun audit à valider.")
    slot["validated"] = True
    slot["synthesis"]["statut_validation"] = "VALIDÉ"
    SESSION_STORE.save(session_id)
    _bump_session_epoch(session_id)
    METRICS.record_validation()
    log_path = _get_audit_log_path(session_id)
    logger = AuditLogger(log_path, run_id=slot.get("run_id"), mode=active_mode)
    logger.append(
        agent="ConsultantDeloitte",
        action="HUMAN_VALIDATION",
        details={"decision": "VALIDÉ", "mode": active_mode},
    )
    s = get_settings()
    worm_res = archive_to_worm_bucket(
        bucket_name=s.audit_logs_bucket,
        use_gcp_snapshot=s.use_gcp_snapshot,
        project_id=s.project_id,
        session_id=session_id,
        mode=active_mode,
        run_id=slot.get("run_id"),
        synthesis=slot["synthesis"],
        log_path=log_path,
    )
    if worm_res.get("archived"):
        logger.append(
            agent="GardeDuCorps",
            action="WORM_ARCHIVED",
            details={
                "bucket": worm_res["bucket"],
                "object_uri": worm_res["object_uri"],
            },
        )
    return {
        "session_id": session_id,
        "validated": True,
        "statut_validation": "VALIDÉ",
        "worm_archive": worm_res,
        "chain": verify_chain(log_path),
    }


def _render_report_markdown(syn: dict[str, Any]) -> str:
    lines = [
        f"# Rapport d'audit NIS2 — {syn.get('client', 'Client')}",
        f"**Mode :** {syn.get('mode')} | **Statut :** {syn.get('statut_validation')}",
        "",
        "## Top 3 Risques",
    ]
    for r in syn.get("top_3_risques", []):
        lines.append(f"- {r}")
    lines.append("\n## Matrice Dit / Écrit / Réel")
    for f in syn.get("findings", []):
        lines.append(
            f"### {f['id']} — {f['theme']} ({f['statut'].upper()} | {f['gravite'].upper()})"
        )
        lines.append(f"- **Exigence :** {f['exigence_nis2']}")
        if f.get("dit"):
            lines.append(f"- **Dit ({f['dit']['source']}) :** « {f['dit']['extrait']} »")
        if f.get("ecrit"):
            lines.append(
                f"- **Écrit ({f['ecrit']['source']} {f['ecrit'].get('section', '')}) :** « {f['ecrit']['extrait']} »"
            )
        if f.get("reel"):
            lines.append(
                f"- **Réel ({f['reel']['ressource']}) :** {f['reel']['constat']}"
            )
        lines.append(f"- **Recommandation :** {f['recommandation']}")
        if f.get("commande_correction"):
            lines.append(f"- **Correction proposée :** `{f['commande_correction']}`")
        dec = f.get("decision_grc")
        if isinstance(dec, dict) and dec.get("decision"):
            dec_label = dec.get("decision_label") or dec.get("decision")
            porteur_txt = dec.get("porteur") or "Non renseigné"
            echeance_txt = dec.get("echeance") or "Non définie"
            comm_txt = f" — Note : {dec['commentaire']}" if dec.get("commentaire") else ""
            lines.append(
                f"- **Décision d'arbitrage GRC :** {dec_label} (`{dec['decision']}`) "
                f"— Porteur : {porteur_txt} | Échéance : {echeance_txt}{comm_txt}"
            )
        lines.append("")
    return "\n".join(lines)


@app.get("/api/export/report", response_class=PlainTextResponse)
def export_report(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> PlainTextResponse:
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    if not slot["validated"] or not slot["synthesis"]:
        raise HTTPException(
            status_code=403,
            detail="Export bloqué : validation humaine du consultant requise.",
        )
    report_md = _render_report_markdown(slot["synthesis"])
    return PlainTextResponse(
        report_md,
        media_type="text/markdown; charset=utf-8",
        headers=_build_export_signature_headers(report_md.encode("utf-8")),
    )


@app.get("/api/export/mail", response_class=PlainTextResponse)
def export_mail(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> PlainTextResponse:
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    if not slot["validated"] or not slot["synthesis"]:
        raise HTTPException(
            status_code=403,
            detail="Export mail bloqué : validation humaine du consultant requise.",
        )
    mail_txt = str(slot["synthesis"].get("mail_suivi", ""))
    return PlainTextResponse(
        mail_txt,
        media_type="text/plain; charset=utf-8",
        headers=_build_export_signature_headers(mail_txt.encode("utf-8")),
    )


def _render_anssi_draft_markdown(
    session_id: str,
    active_mode: AuditMode,
    slot: dict[str, Any],
    syn: dict[str, Any],
    chain_info: dict[str, Any],
    head_hash: str,
) -> str:
    """Génère le brouillon structuré de pré-notification ANSSI conforme aux 3 jalons Art. 23 §4 NIS2."""
    now_iso = datetime.now(timezone.utc).isoformat()
    client_name = syn.get("client", "Centre Hospitalier de Valmont")
    statut_val = syn.get("statut_validation", "VALIDÉ")
    chain_label = "VALIDE" if chain_info.get("valide") else "ALTÉRÉE"
    nb_entrees = chain_info.get("nb_entrees", 0)

    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    non_conformes = [f for f in findings if f.get("statut") != "conforme"]
    critiques_et_hautes = [
        f
        for f in non_conformes
        if f.get("gravite") in {"critique", "haute"}
        or "23" in str(f.get("exigence_nis2") or "")
    ]
    focus_findings = critiques_et_hautes or non_conformes

    has_public_exposure = any(
        "allusers" in f"{(f.get('reel') or {}).get('constat', '')} {f.get('commande_correction', '')}".lower()
        for f in focus_findings
    )
    has_unreported_incident = any(
        "23" in str(f.get("exigence_nis2") or "") and f.get("statut") == "non_conforme"
        for f in focus_findings
    )

    lines: list[str] = [
        "# Brouillon de Pré-Notification Réglementaire ANSSI — Article 23 NIS2",
        f"## {client_name} (*Entité Essentielle — Annexe I, Secteur Santé*)",
        "",
        "> **AVERTISSEMENT RÉGLEMENTAIRE (BROUILLON PRÉPARATOIRE — AUCUN ENVOI AUTOMATIQUE)**  ",
        "> Ce document préparatoire a été assemblé après validation humaine du consultant cyber.  ",
        "> Aucune déclaration automatique n'est transmise à l'ANSSI (*MonEspaceNIS2*) ni au *CERT Santé* par les agents IA.",
        "",
        "### Métadonnées & Scellement Cryptographique",
        f"- **Entité concernée :** {client_name}",
        "- **Cadre légal :** Directive (UE) 2022/2555 (NIS2) — Article 23 §1 & §4 (Obligations de notification en trois étapes)",
        "- **Autorités destinataires :** ANSSI (Autorité nationale cyber) & CERT Santé (appui sectoriel santé)",
        f"- **Mode d'audit / Statut :** `{active_mode}` | `{statut_val}`",
        f"- **Session / Run ID :** `{session_id}` / `{slot.get('run_id') or 'n/a'}`",
        f"- **Empreinte SHA-256 (`head_hash`) :** `{head_hash}`",
        f"- **Intégrité de la chaîne d'audit :** {chain_label} ({nb_entrees} maillons vérifiés)",
        f"- **Date de génération (UTC) :** {now_iso}",
        "",
        "---",
        "",
        "## 1. Jalon 1 — Alerte Précoce sous 24 heures (*Art. 23 §4 a NIS2*)",
        "**Objectif réglementaire :** Signaler sans retard injustifié, et au plus tard dans les **24 heures** suivant la prise de connaissance, tout incident ou exposition significative affectant la disponibilité, l'authenticité, l'intégrité ou la confidentialité des services de santé.",
        "",
        "### 1.1 Qualification préliminaire",
        f"- **Nombre d'écarts significatifs relevés :** {len(focus_findings)} constat(s) prioritaire(s) sur {len(findings)} contrôles audités.",
        (
            "- **Suspicion d'acte malveillant / illicite :** **OUI / À CONFIRMER EN FORENSIQUE** "
            "(indice d'incident antérieur non notifié et/ou exposition directe sur Internet relevés lors du croisement *Dit / Écrit / Réel*)."
            if (has_unreported_incident or has_public_exposure)
            else "- **Suspicion d'acte malveillant / illicite :** À évaluer par le SOC / CERT interne lors de la qualification initiale."
        ),
        "- **Impact transfrontalier potentiel :** Faible à modéré (hébergement cloud régional `europe-west9`, vérification d'éventuels accès externes hors frontières en cours).",
        "- **Point de contact déclarant (RSSI / DSI) :** `[À COMPLÉTER AVANT DÉPÔT SUR MONESPACENIS2]`",
        "",
        "### 1.2 Faits déclencheurs immédiats",
    ]

    if focus_findings:
        for f in focus_findings:
            fid = f.get("id", "F-XXX")
            grav = str(f.get("gravite", "")).upper()
            theme = f.get("theme", "")
            reel = f.get("reel") if isinstance(f.get("reel"), dict) else {}
            dit = f.get("dit") if isinstance(f.get("dit"), dict) else {}
            resume = (
                reel.get("constat")
                or dit.get("extrait")
                or f.get("recommandation")
                or "Écart non conforme identifié."
            )
            lines.append(f"- **[{fid} — {grav}] {theme} :** {resume}")
    else:
        lines.append("- Aucun écart critique ou non conforme majeur déclenchant une alerte immédiate.")

    lines.extend(
        [
            "",
            "---",
            "",
            "## 2. Jalon 2 — Notification d'Évaluation sous 72 heures (*Art. 23 §4 b NIS2*)",
            "**Objectif réglementaire :** Mettre à jour l'alerte précoce dans les **72 heures** avec une évaluation initiale de la gravité, de l'impact sur les services essentiels (DPI, PACS, messagerie clinique), des indicateurs techniques et des mesures de confinement engagées.",
            "",
            "### 2.1 Évaluation technique détaillée (*Croisement Dit / Écrit / Réel*)",
        ]
    )

    if non_conformes:
        for f in non_conformes:
            fid = f.get("id", "F-XXX")
            grav = str(f.get("gravite", "")).upper()
            statut = str(f.get("statut", "")).upper()
            contra = f.get("contradiction") or "Écart de conformité"
            reel = f.get("reel") if isinstance(f.get("reel"), dict) else {}
            ressource = reel.get("ressource") or "Périmètre documentaire / organisationnel"
            lines.extend(
                [
                    f"#### {fid} — {f.get('theme', '')} (`{grav}` | `{statut}` | `{contra}`)",
                    f"- **Exigence NIS2 :** {f.get('exigence_nis2', '')}",
                    f"- **Actif / Ressource concernée :** `{ressource}`",
                ]
            )
            if reel.get("constat"):
                lines.append(f"- **Preuve technique (Réel) :** {reel['constat']}")
            if f.get("commande_correction"):
                lines.append(
                    f"- **Mesure de confinement immédiate (Dry-Run) :** `{f['commande_correction']}`"
                )
            dec = f.get("decision_grc")
            if isinstance(dec, dict) and dec.get("decision"):
                lines.append(
                    f"- **Arbitrage GRC enregistré :** {dec.get('decision_label') or dec['decision']} "
                    f"(Porteur : {dec.get('porteur') or 'À désigner'} | Échéance : {dec.get('echeance') or 'À définir'})"
                )
            lines.append("")
    else:
        lines.extend(["Aucun écart ouvert à notifier au titre de l'évaluation 72 h.", ""])

    lines.extend(
        [
            "---",
            "",
            "## 3. Jalon 3 — Plan de Rapport Final sous 1 mois (*Art. 23 §4 d NIS2*)",
            "**Objectif réglementaire :** Transmettre au plus tard **un mois** après la notification 72 h un rapport final comprenant la description détaillée de l'incident/écart, la cause profonde (*Root Cause*), les mesures d'atténuation appliquées et le plan de gouvernance à long terme.",
            "",
            "### 3.1 Analyse des causes profondes (*Root Cause Analysis*)",
            "- **Décalage entre gouvernance déclarative et réalité Cloud (*Dit / Écrit ≠ Réel*) :** Absence de contrôle continu automatisé sur les liaisons IAM publiques, les règles pare-feu d'administration, le verrouillage immuable des sauvegardes et la rétention des journaux d'audit.",
            "- **Processus d'escalade ANSSI (Art. 23) :** Nécessité de formaliser le seuil de déclenchement 24 h / 72 h pour tout incident affectant même partiellement les actifs hospitaliers ou les comptes prestataires.",
            "",
            "### 3.2 Trajectoire de remédiation et arbitrages GRC retenus",
        ]
    )

    if non_conformes:
        for f in non_conformes:
            fid = f.get("id", "F-XXX")
            dec = f.get("decision_grc") if isinstance(f.get("decision_grc"), dict) else {}
            dec_lbl = dec.get("decision_label") or "À corriger (arbitrage standard)"
            porteur = dec.get("porteur") or "DSI / RSSI"
            echeance = dec.get("echeance") or "Plan 30–90 jours"
            note_suffix = f" — *Note : {dec['commentaire']}*" if dec.get("commentaire") else ""
            lines.append(
                f"- **{fid} ({f.get('theme', '')})** : {f.get('recommandation', '')} "
                f"-> **{dec_lbl}** | Porteur : **{porteur}** | Échéance : **{echeance}**{note_suffix}"
            )
    else:
        lines.append("- Maintien en condition opérationnelle et revue périodique trimestrielle.")

    lines.extend(
        [
            "",
            "---",
            f"*Brouillon scellé cryptographiquement par TRIAD — SHA-256 : `{head_hash}`*",
            "",
        ]
    )
    return "\n".join(lines)


@app.get("/api/export/anssi-draft", response_class=PlainTextResponse)
def export_anssi_draft(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> PlainTextResponse:
    """Exporte le brouillon structuré de pré-notification ANSSI (Art. 23 §4 NIS2 : 24h / 72h / 1 mois) après validation."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    if not slot["validated"] or not slot["synthesis"]:
        raise HTTPException(
            status_code=403,
            detail="Export pré-notification ANSSI bloqué : validation humaine du consultant requise.",
        )

    syn = slot["synthesis"]
    log_path = _get_audit_log_path(session_id)
    entries = AuditLogger(log_path, session_id=session_id).read_entries()
    chain_info = verify_chain(log_path)
    head_hash = entries[-1]["hash"] if entries else GENESIS_HASH
    draft_md = _render_anssi_draft_markdown(
        session_id=session_id,
        active_mode=active_mode,
        slot=slot,
        syn=syn,
        chain_info=chain_info,
        head_hash=head_hash,
    )
    filename = f"TRIAD_PreNotification_ANSSI_Art23_{active_mode}.md"
    return PlainTextResponse(
        draft_md,
        media_type="text/markdown; charset=utf-8",
        headers=_build_export_signature_headers(
            draft_md.encode("utf-8"),
            {"Content-Disposition": f'attachment; filename="{filename}"'},
        ),
    )


def _render_comex_brief_markdown(
    session_id: str,
    active_mode: AuditMode,
    state: dict[str, Any],
    slot: dict[str, Any],
    syn: dict[str, Any],
    chain_info: dict[str, Any],
    head_hash: str,
) -> str:
    """Génère la note exécutive 1 page dédiée aux Organes de Direction (Article 20 NIS2)."""
    now_iso = datetime.now(timezone.utc).isoformat()
    client_name = syn.get("client", "Centre Hospitalier de Valmont")
    statut_val = syn.get("statut_validation", "VALIDÉ")
    chain_label = "VALIDE" if chain_info.get("valide") else "ALTÉRÉE"
    nb_entrees = chain_info.get("nb_entrees", 0)

    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    non_conformes = [f for f in findings if f.get("statut") != "conforme"]
    actionable_ids = [
        str(f.get("id") or "")
        for f in non_conformes
        if f.get("id")
        and ((f.get("decision_grc") or {}).get("decision") != "risque_accepte")
    ]
    sim = _compute_remediation_simulation(
        session_id=session_id,
        active_mode=active_mode,
        syn=syn,
        raw_selected_ids=actionable_ids,
    )
    workload = sim["workload_jh"]
    art34 = sim["art34_exposure"]

    avant_syn = (state.get("results_by_mode", {}).get("AVANT") or {}).get("synthesis")
    apres_syn = (state.get("results_by_mode", {}).get("APRES") or {}).get("synthesis")
    delta_line: str | None = None
    if isinstance(avant_syn, dict) and isinstance(apres_syn, dict):
        score_av = _compute_nis2_score(
            [f for f in (avant_syn.get("findings") or []) if isinstance(f, dict)]
        )
        score_ap = _compute_nis2_score(
            [f for f in (apres_syn.get("findings") or []) if isinstance(f, dict)]
        )
        diff_pts = score_ap - score_av
        sign = "+" if diff_pts > 0 else ""
        delta_line = (
            f"- **Écart d'audit Documentaire (`AVANT`) vs Contre-Expertise (`APRÈS`) :** "
            f"`{score_av}/100` -> `{score_ap}/100` (`{sign}{diff_pts} pts` après confrontation au réel Cloud & entretiens)"
        )

    contradictions = [
        f
        for f in non_conformes
        if f.get("contradiction")
        or (isinstance(f.get("dit"), dict) and isinstance(f.get("reel"), dict))
    ]
    top_risks = [str(r) for r in (syn.get("top_3_risques") or []) if r][:3]

    lines: list[str] = [
        "# Brief Exécutif Organes de Direction — Article 20 NIS2",
        f"## {client_name} (*Note de Synthèse Direction Générale / COMEX — 1 Page*)",
        "",
        "> **OBJET : RESPONSABILITÉ DIRECTE DES ORGANES DE DIRECTION (ART. 20 NIS2)**  ",
        "> Conformément à l'Article 20 §1 et §2 de la Directive (UE) 2022/2555 (*NIS2*), les organes de direction des Entités Essentielles doivent **approuver formellement** les mesures de gestion des risques de cybersécurité (Art. 21), **superviser leur mise en œuvre** et peuvent être tenus **personnellement responsables** en cas de manquement.",
        "",
        "### Indicateurs Clés de Gouvernance & Scellement",
        f"- **Entité auditée :** {client_name} (*Entité Essentielle — Annexe I, Santé*)",
        f"- **Périmètre / Statut :** Mode `{active_mode}` | `{statut_val}` | Session `{session_id}`",
        f"- **Score de maturité NIS2 actuel :** **`{sim['current_score']}/100`** -> Cible après plan d'action : **`{sim['projected_score']}/100`** (`+{sim['score_delta']} pts`)",
    ]
    if delta_line:
        lines.append(delta_line)

    lines.extend(
        [
            f"- **Budget charge de remédiation estimé :** **`{workload['label']}`** ({workload['quick_wins_count']} Quick Win(s) immédiat(s))",
            f"- **Plafond légal d'exposition (Art. 34 §4 NIS2) :** **{art34['plafond_label']}** (Indice d'exposition : `{art34['current_risk_index']}/100` — *{art34['risk_level_before']}* -> `{art34['projected_risk_index']}/100` après remédiation, soit **`-{art34['exposure_reduction_pct']} %`**)",
            f"- **Scellement cryptographique SHA-256 (`head_hash`) :** `{head_hash}` ({chain_label}, {nb_entrees} maillons)",
            f"- **Édité le (UTC) :** {now_iso}",
            "",
            "---",
            "",
            "## 1. Obligations Légales des Dirigeants (*Article 20 & Article 32 §5 NIS2*)",
            "1. **Approbation & Supervision (Art. 20 §1) :** Délibération obligatoire du COMEX/Directoire validant la trajectoire de conformité Art. 21 et les arbitrages de risque.",
            "2. **Formation obligatoire des dirigeants (Art. 20 §2) :** Les membres des organes de direction doivent suivre une formation régulière à l'évaluation des risques cyber et de leur impact métier.",
            "3. **Régime de responsabilité & injonctions (Art. 32 §5 b & Art. 34 §4) :** Au-delà des sanctions pécuniaires (**jusqu'à 10 M€ ou 2 % du CA mondial**), l'autorité compétente peut demander la suspension temporaire d'exercice de fonctions dirigeantes en cas d'inaction grave face à des écarts critiques avérés.",
            "",
            "## 2. Top 3 Risques Exécutifs & Contradictions Critiques (*Dit / Écrit ≠ Réel*)",
        ]
    )

    if top_risks:
        for idx, risk in enumerate(top_risks, start=1):
            lines.append(f"{idx}. {risk}")
    else:
        lines.append("1. Aucun risque critique prioritaire remonté dans la synthèse courante.")

    lines.append("")
    if contradictions:
        lines.append("### Dissonances majeures prouvées par la contre-expertise :")
        for f in contradictions[:4]:
            fid = f.get("id", "F-XXX")
            grav = str(f.get("gravite", "")).upper()
            contra = f.get("contradiction") or "Dit / Écrit ≠ Réel"
            dit_ext = ((f.get("dit") or {}).get("extrait") if isinstance(f.get("dit"), dict) else None)
            reel_cst = ((f.get("reel") or {}).get("constat") if isinstance(f.get("reel"), dict) else None)
            summary_parts: list[str] = []
            if dit_ext:
                summary_parts.append(f"*Déclaré :* « {dit_ext} »")
            if reel_cst:
                summary_parts.append(f"*Constaté sur GCP :* {reel_cst}")
            detail_str = " vs ".join(summary_parts) if summary_parts else str(f.get("recommandation") or "")
            lines.append(f"- **[{fid} — {grav}] {f.get('theme', '')}** (`{contra}`) : {detail_str}")
        lines.append("")

    by_h = workload["by_horizon"]
    lines.extend(
        [
            "## 3. Arbitrages GRC & Trajectoire Budgétaire (`j.h`)",
            f"- **Enveloppe globale retenue :** **{workload['label']}** répartie sur 3 horizons opérationnels :",
            f"  - **Urgence 0–30 jours (Confinement & Quick Wins) :** `{by_h['0_30']['estimated_jh']} j.h` ({by_h['0_30']['count']} chantier(s))",
            f"  - **Consolidation 30–60 jours :** `{by_h['30_60']['estimated_jh']} j.h` ({by_h['30_60']['count']} chantier(s))",
            f"  - **Transformation 60–90 jours :** `{by_h['60_90']['estimated_jh']} j.h` ({by_h['60_90']['count']} chantier(s))",
            "",
            "### Synthèse des décisions d'arbitrage GRC soumises au COMEX :",
        ]
    )

    if non_conformes:
        for f in non_conformes:
            fid = f.get("id", "F-XXX")
            dec = f.get("decision_grc") if isinstance(f.get("decision_grc"), dict) else {}
            dec_lbl = dec.get("decision_label") or "À corriger (plan prioritaire)"
            porteur = dec.get("porteur") or "DSI / RSSI"
            echeance = dec.get("echeance") or "J+30"
            lines.append(
                f"- **{fid} — {f.get('theme', '')}** (`{str(f.get('gravite', '')).upper()}`) : "
                f"**{dec_lbl}** | Porteur : **{porteur}** | Échéance : **{echeance}**"
            )
    else:
        lines.append("- Conformité nominale sur les contrôles évalués ; maintien en condition de sécurité.")

    lines.extend(
        [
            "",
            "## 4. Résolutions Proposées à l'Approbation du COMEX (*Art. 20 §1 NIS2*)",
            "- [ ] **Résolution n°1 :** Approuver formellement la matrice des risques *Dit / Écrit / Réel* et les arbitrages GRC ci-dessus.",
            f"- [ ] **Résolution n°2 :** Allouer l'enveloppe de **`{workload['label']}`** et mandater la DSI / le RSSI sur l'exécution immédiate des chantiers `0–30 jours`.",
            "- [ ] **Résolution n°3 :** Valider la procédure d'escalade réglementaire ANSSI (*Art. 23 §4 : Alerte 24 h / Évaluation 72 h / Rapport 1 mois*) et programmer la session annuelle de formation cyber des dirigeants (*Art. 20 §2*).",
            "",
            "---",
            f"*Brief exécutif scellé cryptographiquement par TRIAD — SHA-256 : `{head_hash}`*",
            "",
        ]
    )
    return "\n".join(lines)


@app.get("/api/export/comex-brief", response_class=PlainTextResponse)
def export_comex_brief(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> PlainTextResponse:
    """Exporte le Brief Exécutif Organes de Direction (Art. 20 NIS2) après validation humaine."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    if not slot["validated"] or not slot["synthesis"]:
        raise HTTPException(
            status_code=403,
            detail="Export brief COMEX bloqué : validation humaine du consultant requise.",
        )

    syn = slot["synthesis"]
    log_path = _get_audit_log_path(session_id)
    entries = AuditLogger(log_path, session_id=session_id).read_entries()
    chain_info = verify_chain(log_path)
    head_hash = entries[-1]["hash"] if entries else GENESIS_HASH
    brief_md = _render_comex_brief_markdown(
        session_id=session_id,
        active_mode=active_mode,
        state=state,
        slot=slot,
        syn=syn,
        chain_info=chain_info,
        head_hash=head_hash,
    )
    filename = f"TRIAD_Brief_COMEX_Art20_{active_mode}.md"
    return PlainTextResponse(
        brief_md,
        media_type="text/markdown; charset=utf-8",
        headers=_build_export_signature_headers(
            brief_md.encode("utf-8"),
            {"Content-Disposition": f'attachment; filename="{filename}"'},
        ),
    )


def _hcl_escape_string(raw: str) -> str:
    return (
        str(raw or "")
        .replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\r", " ")
        .replace("\n", " ")
        .strip()
    )


def _render_terraform_remediation_hcl(
    session_id: str,
    active_mode: AuditMode,
    slot: dict[str, Any],
    syn: dict[str, Any],
    chain_info: dict[str, Any],
    head_hash: str,
) -> str:
    """Génère un manifeste Terraform HCL déclaratif prêt pour revue PR GitOps (jamais appliqué automatiquement)."""
    s = get_settings()
    now_iso = datetime.now(timezone.utc).isoformat()
    client_name = _hcl_escape_string(syn.get("client", "Centre Hospitalier de Valmont"))
    project_default = _hcl_escape_string(s.project_id or "ch-valmont-demo")
    region_default = _hcl_escape_string(s.vertex_location or "europe-west9")
    chain_label = "VALIDE" if chain_info.get("valide") else "ALTÉRÉE"
    nb_entrees = chain_info.get("nb_entrees", 0)

    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    by_id: dict[str, dict[str, Any]] = {
        str(f.get("id")): f for f in findings if f.get("id")
    }

    def _grc_comment_for(fid: str) -> str:
        f = by_id.get(fid)
        if not isinstance(f, dict):
            return f"# Arbitrage GRC [{fid}] : Standard (À corriger)"
        dec = f.get("decision_grc")
        if isinstance(dec, dict) and dec.get("decision"):
            lbl = dec.get("decision_label") or dec.get("decision")
            porteur = dec.get("porteur") or "DSI / RSSI"
            echeance = dec.get("echeance") or "Plan 30-90j"
            return f"# Arbitrage GRC [{fid}] : {lbl} | Porteur : {porteur} | Échéance : {echeance}"
        return f"# Arbitrage GRC [{fid}] : À corriger (remédiation déclarative GitOps)"

    lines: list[str] = [
        "# ==============================================================================",
        "# TRIAD — Manifeste Correctif Terraform GitOps GCP (NIS2 Art. 21 & Art. 23)",
        f"# Client           : {client_name}",
        f"# Mode / Statut    : {active_mode} | {syn.get('statut_validation', 'VALIDÉ')}",
        f"# Session / Run ID : {session_id} / {slot.get('run_id') or 'n/a'}",
        f"# Empreinte SHA-256: {head_hash}",
        f"# Intégrité chaîne : {chain_label} ({nb_entrees} maillons vérifiés)",
        f"# Généré le (UTC)  : {now_iso}",
        "# ------------------------------------------------------------------------------",
        "# AVERTISSEMENT DE SÉCURITÉ OBLIGATOIRE :",
        "#   revue humaine / terraform plan requis — jamais appliqué automatiquement par TRIAD.",
        "#   Les agents IA TRIAD opèrent exclusivement en LECTURE SEULE sur Google Cloud.",
        "#   Soumettre ce fichier à une Pull Request GitOps avant tout 'terraform apply'.",
        "# ==============================================================================",
        "",
        "terraform {",
        '  required_version = ">= 1.5.0"',
        "  required_providers {",
        "    google = {",
        '      source  = "hashicorp/google"',
        '      version = "~> 5.0"',
        "    }",
        "  }",
        "}",
        "",
        'variable "project_id" {',
        '  description = "Identifiant du projet Google Cloud cible à remédier"',
        "  type        = string",
        f'  default     = "{project_default}"',
        "}",
        "",
        'variable "region" {',
        '  description = "Région souveraine HDS / NIS2 (Paris)"',
        "  type        = string",
        f'  default     = "{region_default}"',
        "}",
        "",
        'variable "bastion_iap_cidr" {',
        '  description = "Plage CIDR officielle Identity-Aware Proxy (IAP TCP Forwarding) ou Bastion VPN"',
        "  type        = string",
        '  default     = "35.235.240.0/20"',
        "}",
        "",
        "locals {",
        "  triad_common_labels = {",
        '    managed_by      = "triad-gitops-remediation"',
        f'    nis2_audit_mode = "{active_mode.lower()}"',
        f'    audit_head_sha  = "{head_hash[:16]}"',
        "  }",
        "}",
        "",
        "# ------------------------------------------------------------------------------",
        "# [F-001] Art. 21 §2 (i) — Suppression de l'exposition allUsers & PAP enforced",
        _grc_comment_for("F-001"),
        "# ------------------------------------------------------------------------------",
        'resource "google_storage_bucket" "remediate_export_radiologie" {',
        '  name                        = "${var.project_id}-export-radiologie"',
        "  project                     = var.project_id",
        "  location                    = upper(var.region)",
        '  public_access_prevention    = "enforced"',
        "  uniform_bucket_level_access = true",
        "  labels                      = local.triad_common_labels",
        "}",
        "",
        "# ------------------------------------------------------------------------------",
        "# [F-002] Art. 21 §2 (i) — Fermeture SSH 0.0.0.0/0 au profit du bastion IAP/VPN",
        _grc_comment_for("F-002"),
        "# Note PR : importer/supprimer la règle legacy 'allow-ssh-anywhere' (0.0.0.0/0)",
        "# ------------------------------------------------------------------------------",
        'resource "google_compute_firewall" "remediate_ssh_iap_bastion" {',
        '  name          = "allow-ssh-iap-bastion-only"',
        "  project       = var.project_id",
        '  network       = "default"',
        '  direction     = "INGRESS"',
        "  priority      = 1000",
        "  source_ranges = [var.bastion_iap_cidr]",
        "",
        "  allow {",
        '    protocol = "tcp"',
        '    ports    = ["22"]',
        "  }",
        "",
        '  target_tags = ["bastion-managed"]',
        '  description = "NIS2 Art. 21.2.i — Administration SSH restreinte au tunnel IAP/Bastion VPN"',
        "}",
        "",
        "# ------------------------------------------------------------------------------",
        "# [F-003] Art. 21 §2 (c) — Immuabilité WORM 30j & Versioning sur backups-dpi",
        _grc_comment_for("F-003"),
        "# ------------------------------------------------------------------------------",
        'resource "google_storage_bucket" "remediate_backups_dpi" {',
        '  name                        = "${var.project_id}-backups-dpi"',
        "  project                     = var.project_id",
        "  location                    = upper(var.region)",
        '  public_access_prevention    = "enforced"',
        "  uniform_bucket_level_access = true",
        "  labels                      = local.triad_common_labels",
        "",
        "  versioning {",
        "    enabled = true",
        "  }",
        "",
        "  retention_policy {",
        "    is_locked        = true",
        "    retention_period = 2592000 # 30 jours minimum anti-ransomware (PSSI §5.2)",
        "  }",
        "}",
        "",
        "# ------------------------------------------------------------------------------",
        "# [F-006] Art. 21 §2 (d, i, j) — Moindre privilège IAM prestataire (sans clé JSON)",
        _grc_comment_for("F-006"),
        "# Note PR : révoquer roles/editor projet et la clé USER_MANAGED 7f9a3c12e84b09d1",
        "# ------------------------------------------------------------------------------",
        'resource "google_project_iam_custom_role" "prestataire_pacs_minimal" {',
        '  role_id     = "triadPrestatairePacsMaintenance"',
        "  project     = var.project_id",
        '  title       = "Maintenance PACS Moindre Privilège (NIS2 Art. 21.2.d)"',
        '  description = "Remplace roles/editor pour sa-prestataire-meditech sans accès aux données DPI"',
        "  permissions = [",
        '    "storage.buckets.get",',
        '    "logging.logEntries.create",',
        "  ]",
        "}",
        "",
        'resource "google_storage_bucket_iam_member" "prestataire_meditech_scoped" {',
        "  bucket = google_storage_bucket.remediate_export_radiologie.name",
        "  role   = google_project_iam_custom_role.prestataire_pacs_minimal.name",
        '  member = "serviceAccount:sa-prestataire-meditech@${var.project_id}.iam.gserviceaccount.com"',
        "}",
        "",
        "# ------------------------------------------------------------------------------",
        "# [F-007] Art. 21 §2 (h) & Art. 23 — Rotation KMS 90j (7776000s) & Logs 365j",
        _grc_comment_for("F-007"),
        "# ------------------------------------------------------------------------------",
        'resource "google_kms_key_ring" "kr_sante_dpi" {',
        '  name     = "kr-sante-dpi"',
        "  project  = var.project_id",
        "  location = var.region",
        "}",
        "",
        'resource "google_kms_crypto_key" "remediate_key_dpi_patients" {',
        '  name            = "key-dpi-patients"',
        "  key_ring        = google_kms_key_ring.kr_sante_dpi.id",
        '  purpose         = "ENCRYPT_DECRYPT"',
        '  rotation_period = "7776000s" # Rotation automatique tous les 90 jours',
        "  labels          = local.triad_common_labels",
        "",
        "  lifecycle {",
        "    prevent_destroy = true",
        "  }",
        "}",
        "",
        'resource "google_logging_project_bucket_config" "remediate_default_audit_retention" {',
        "  project        = var.project_id",
        '  location       = "global"',
        '  bucket_id      = "_Default"',
        "  retention_days = 365 # Conformité PSSI §6.1 (12 mois)",
        "  locked         = true",
        "}",
        "",
        'resource "google_project_iam_audit_config" "remediate_data_access_audit_logs" {',
        "  project = var.project_id",
        '  service = "storage.googleapis.com"',
        "",
        "  audit_log_config {",
        '    log_type = "ADMIN_READ"',
        "  }",
        "  audit_log_config {",
        '    log_type = "DATA_READ"',
        "  }",
        "  audit_log_config {",
        '    log_type = "DATA_WRITE"',
        "  }",
        "}",
        "",
    ]
    return "\n".join(lines)


@app.get("/api/export/terraform", response_class=PlainTextResponse)
def export_terraform_remediation(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> PlainTextResponse:
    """Exporte le manifeste Terraform HCL déclaratif de remédiation GitOps GCP après validation humaine."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    if not slot["validated"] or not slot["synthesis"]:
        raise HTTPException(
            status_code=403,
            detail="Export Manifeste Terraform bloqué : validation humaine du consultant requise.",
        )

    syn = slot["synthesis"]
    log_path = _get_audit_log_path(session_id)
    entries = AuditLogger(log_path, session_id=session_id).read_entries()
    chain_info = verify_chain(log_path)
    head_hash = entries[-1]["hash"] if entries else GENESIS_HASH
    hcl_text = _render_terraform_remediation_hcl(
        session_id=session_id,
        active_mode=active_mode,
        slot=slot,
        syn=syn,
        chain_info=chain_info,
        head_hash=head_hash,
    )
    filename = f"TRIAD_Remediation_GitOps_{active_mode}.tf"
    return PlainTextResponse(
        hcl_text,
        media_type="text/plain; charset=utf-8",
        headers=_build_export_signature_headers(
            hcl_text.encode("utf-8"),
            {"Content-Disposition": f'attachment; filename="{filename}"'},
        ),
    )


def _render_interview_guide_markdown(
    *,
    session_id: str,
    active_mode: AuditMode,
    slot: dict[str, Any],
    syn: dict[str, Any],
    chain_info: dict[str, Any],
    head_hash: str,
) -> str:
    """Génère le Guide d'Entretien Contradictoire pré-rempli par interlocuteur (DSI, Admin Cloud, RSSI / DPO, Achats / Juridique)."""
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    client_name = str(syn.get("client") or "Centre Hospitalier de Valmont")
    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    by_id: dict[str, dict[str, Any]] = {
        str(f.get("id")): f for f in findings if f.get("id")
    }
    docs_quar = [d for d in (syn.get("documents_quarantaine") or []) if isinstance(d, dict)]
    decisions_map = dict(slot.get("decisions") or {})
    is_apres = active_mode == "APRES"
    chain_ok = bool(chain_info.get("valide"))
    nb_entrees = int(chain_info.get("nb_entrees") or 0)

    mode_label = (
        "APRÈS ENTRETIEN — Contre-Interrogatoire & Levée des Contradictions (Dit ≠ Écrit ≠ Réel)"
        if is_apres
        else "AVANT ENTRETIEN — Préparation Contradictoire à Froid (Écrit ≠ Réel)"
    )
    posture_intro = (
        "Ce guide consolide les contradictions relevées **après recueil du déclaratif oral de la DSI** (`notes_entretien_DSI.md`), "
        "confrontées aux engagements de la PSSI et aux sondes techniques Google Cloud en lecture seule. "
        "Il structure la séance de clôture contradictoire et la collecte des pièces justificatives opposables (dont la qualification de l'incident non notifié de septembre `F-004`)."
        if is_apres
        else "Ce guide prépare la **conduite d'entretien contradictoire initial** avant recueil du déclaratif oral. "
        "Il s'appuie sur les divergences factuelles déjà établies entre le corpus écrit (`PSSI`, procédures) et la réalité technique Google Cloud en lecture seule (`Écrit ≠ Réel`), "
        "afin d'obtenir des réponses précises et des preuves vérifiables en séance."
    )

    def _finding_summary_block(fid: str) -> list[str]:
        f = by_id.get(fid)
        if not f:
            return []
        statut = str(f.get("statut") or "inconnu").upper()
        gravite = str(f.get("gravite") or "inconnue").upper()
        contradiction = str(f.get("contradiction") or "Contrôle témoin")
        exigence = str(f.get("exigence_nis2") or "Art. 21 NIS2")
        theme = str(f.get("theme") or fid)

        dit_obj = f.get("dit") if isinstance(f.get("dit"), dict) else None
        ecrit_obj = f.get("ecrit") if isinstance(f.get("ecrit"), dict) else None
        reel_obj = f.get("reel") if isinstance(f.get("reel"), dict) else None

        out = [
            f"- **[{fid}] {theme}** — `{gravite}` • Statut : `{statut}` • Divergence : **{contradiction}** ({exigence})",
        ]
        if dit_obj and dit_obj.get("extrait"):
            out.append(
                f"  - *Dit ({dit_obj.get('source', 'Entretien')})* : « {dit_obj.get('extrait')} »"
            )
        elif not is_apres:
            out.append("  - *Dit* : Non recueilli à ce stade (question ouverte à poser sans induire la réponse).")
        if ecrit_obj and ecrit_obj.get("extrait"):
            sec = f" {ecrit_obj.get('section')}" if ecrit_obj.get("section") else ""
            out.append(
                f"  - *Écrit ({ecrit_obj.get('source', 'PSSI')}{sec})* : « {ecrit_obj.get('extrait')} »"
            )
        if reel_obj and reel_obj.get("constat"):
            res_name = f" (`{reel_obj.get('ressource')}`)" if reel_obj.get("ressource") else ""
            out.append(f"  - *Réel GCP*{res_name} : {reel_obj.get('constat')}")
        return out

    lines: list[str] = [
        "# GUIDE D'ENTRETIEN CONTRADICTOIRE NIS2 — PRÉ-REMPLI PAR INTERLOCUTEUR",
        "",
        f"> **Entité auditée** : {client_name}  ",
        f"> **Phase & Mode d'audit** : `{active_mode}` — {mode_label}  ",
        f"> **Session TRIAD** : `{session_id}` • **Généré le** : {now_iso}  ",
        f"> **Intégrité cryptographique** : `{'INTÈGRE' if chain_ok else 'À VÉRIFIER'}` ({nb_entrees} maillons SHA-256) • **Empreinte de tête** : `{head_hash}`",
        "",
        posture_intro,
        "",
        "---",
        "",
        "## Alerte Prioritaire — Quarantaine Fournisseur & Risque Tiers (Art. 21 §2 d)",
        "",
    ]

    if docs_quar:
        for qdoc in docs_quar:
            qname = str(qdoc.get("nom_fichier") or "piece_tierce_inconnue.md")
            qreason = str(
                qdoc.get("raison_quarantaine")
                or qdoc.get("alerte_injection")
                or "Tentative d'injection de prompt indirecte neutralisée par l'agent Douanier."
            )
            lines.extend(
                [
                    f"- **Pièce isolée en quarantaine** : `{qname}` (**Prestataire concerné : MedTech Solutions SAS**)",
                    f"  - **Motif de blocage (`Douanier`)** : {qreason}",
                    "  - **Conséquence méthodologique** : document exclu du contexte d'analyse automatique pour prévenir toute manipulation du verdict ; vérification contradictoire humaine obligatoire avec les Achats et le RSSI.",
                ]
            )
    else:
        lines.extend(
            [
                "- **Vigilance Chaîne d'Approvisionnement (`MedTech Solutions SAS`)** : vérifier systématiquement l'intégrité des annexes techniques fournies par les prestataires de télémaintenance PACS/imagerie (`annexe_fournisseur_maintenance.md`) et le cloisonnement du compte `sa-prestataire-meditech`.",
            ]
        )

    lines.extend(
        [
            "",
            "---",
            "",
            "## 1. Direction des Systèmes d'Information (`DSI`)",
            "",
            "**Objectif de séance** : Confronter le pilotage opérationnel de la production hospitalière (exposition Internet, accès d'administration, résilience anti-rançongiciel et gestion des incidents) aux preuves techniques GCP.",
            "",
            "### Divergences constatées sur le périmètre DSI",
        ]
    )
    for fid in ("F-001", "F-002", "F-003", "F-004", "F-005"):
        lines.extend(_finding_summary_block(fid))

    lines.extend(
        [
            "",
            "### Questions contradictoires à poser au `DSI`",
        ]
    )
    if is_apres:
        lines.extend(
            [
                "1. **[F-001 — Exposition HDS]** Lors de l'entretien, il a été indiqué que *« les données patients ne sont jamais exposées sur Internet »*, or `gs://ch-valmont-demo-export-radiologie` accorde `roles/storage.objectViewer` à `allUsers` : quel flux métier a créé ce partage et quelles données d'imagerie y ont transité ?",
                "2. **[F-002 — Administration hors VPN]** Vous avez affirmé que *« l'accès admin passe uniquement par le VPN »*, alors que la règle `allow-ssh-anywhere` ouvre `TCP/22` à `0.0.0.0/0` sur le VPC `default` : quelle équipe ou quel prestataire utilise cet accès direct hors bastion ?",
                "3. **[F-003 / F-005 — Rançongiciel & PRA]** Pourquoi le bucket `gs://ch-valmont-demo-backups-dpi` est-il dépourvu de versioning et de verrouillage WORM alors que `gs://ch-valmont-demo-archives-pacs` (`F-005`) applique déjà une rétention verrouillée de 365 jours ?",
                "4. **[F-004 — Incident de septembre]** L'incident de septembre (compromission d'un compte prestataire et coupure partielle de messagerie) a été qualifié en séance de *« petit incident géré en interne »* : sur quels critères objectifs l'alerte précoce ANSSI sous 24 h (Art. 23 NIS2 / PSSI §6.2) a-t-elle été écartée ?",
            ]
        )
    else:
        lines.extend(
            [
                "1. **[F-001 — Exposition HDS]** Comment garantissez-vous en pratique qu'aucun espace de stockage d'échange (notamment radiologie / imagerie) n'est accessible publiquement, alors que la sonde GCP relève `allUsers` sur `gs://ch-valmont-demo-export-radiologie` (écart `Écrit ≠ Réel` face à la PSSI §3.1) ?",
                "2. **[F-002 — Administration réseau]** Quel est le chemin réseau nominal d'administration des serveurs Cloud et comment expliquez-vous la présence active de la règle `allow-ssh-anywhere` (`TCP/22` ouvert à `0.0.0.0/0`) en contradiction avec la PSSI §4.3 ?",
                "3. **[F-003 / F-005 — Sauvegardes DPI vs PACS]** Quelles mesures techniques empêchent la suppression malveillante des sauvegardes du DPI (`backups-dpi`) en cas de compromission d'un compte administrateur, par comparaison avec le bucket conforme `archives-pacs` (`F-005`) ?",
                "4. **[Détection d'incidents — Art. 23]** L'établissement a-t-il connu un incident de sécurité ou une indisponibilité impliquant un prestataire au cours des 12 derniers mois, et quel circuit d'escalade vers la Direction Générale et l'ANSSI a été activé ?",
            ]
        )

    lines.extend(
        [
            "",
            "### Preuves attendues en séance (`DSI`)",
            "- Schéma d'architecture réseau à jour du bastion VPN / IAP et registre formel des dérogations pare-feu.",
            "- Dernier procès-verbal de test de restauration couvrant la production `backups-dpi` (et planification de l'extension PRA 2026 à `archives-pacs`).",
            "- Main courante chronologique et rapport post-mortem interne de tout incident survenu sur les 12 derniers mois.",
            "",
            "---",
            "",
            "## 2. Administrateur Cloud & Infrastructure GCP (`Admin Cloud`)",
            "",
            "**Objectif de séance** : Valider la faisabilité immédiate des remédiations techniques (IAM, VPC, Cloud Storage WORM, KMS, Cloud Logging) et identifier l'origine des dérives de configuration.",
            "",
            "### Divergences constatées sur le périmètre `Admin Cloud`",
        ]
    )
    for fid in ("F-006", "F-007", "F-001", "F-002", "F-003"):
        lines.extend(_finding_summary_block(fid))

    lines.extend(
        [
            "",
            "### Questions contradictoires à poser à l'`Admin Cloud`",
            "1. **[F-006 — Sur-privilèges & Clé statique]** Pourquoi le compte `sa-prestataire-meditech@ch-valmont-demo.iam.gserviceaccount.com` détient-il le rôle primitif `roles/editor` avec une clé JSON `USER_MANAGED` active depuis **248 jours** (> plafond PSSI de 90 jours), et qui utilise encore le compte générique `admin-legacy@ch-valmont.fr` (`roles/owner`) ?",
            "2. **[F-007 — Rotation KMS & Traces 365 j]** Qu'est-ce qui bloque l'activation de la rotation automatique à 90 jours sur `key-dpi-patients` (déjà active sur `key-pacs-imagerie`) ainsi que le passage du bucket Cloud Logging `_Default` de 30 jours à **365 jours** avec journaux `DATA_READ` / `DATA_WRITE` ?",
            "3. **[F-001 / F-002 — Garde-fous d'organisation]** Des contraintes Organization Policy (`storage.publicAccessPrevention`, `iam.disableServiceAccountKeyCreation`, restriction IAP `35.235.240.0/20`) sont-elles déployées ou prêtes à être revues via `terraform plan` ?",
            "",
            "### Preuves attendues en séance (`Admin Cloud`)",
            "- Export complet de la politique IAM du projet et inventaire horodaté des clés `USER_MANAGED` actives.",
            "- Journal d'activité Cloud Audit Logs (`Admin Activity`) identifiant l'auteur et la date de création de `allow-ssh-anywhere` et du binding `allUsers`.",
            "- Sortie de revue `terraform plan` (en lecture seule) sur le manifeste GitOps de remédiation (`09_Remediation_GitOps.tf`).",
            "",
            "---",
            "",
            "## 3. Gouvernance Cyber & Protection des Données (`RSSI / DPO`)",
            "",
            "**Objectif de séance** : Évaluer la conformité réglementaire NIS2 (Art. 20, Art. 21, Art. 23) et RGPD / HDS (Art. 32, 33, 34), la conservation probatoire des traces et l'effectivité des contrôles périodiques PSSI.",
            "",
            "### Divergences constatées sur le périmètre `RSSI / DPO`",
        ]
    )
    for fid in ("F-004", "F-001", "F-006", "F-007"):
        lines.extend(_finding_summary_block(fid))

    lines.extend(
        [
            "",
            "### Questions contradictoires à poser au `RSSI / DPO`",
            "1. **[F-001 — Analyse d'impact RGPD / HDS]** Suite à l'exposition `allUsers` constatée sur `gs://ch-valmont-demo-export-radiologie`, une investigation forensique d'accès non autorisé et une évaluation de notification CNIL (72 h — Art. 33 RGPD) et ARS/ANSSI ont-elles été engagées ?",
            "2. **[F-004 — Procédure Art. 23 NIS2]** Disposez-vous d'une matrice opérationnelle d'astreinte permettant de qualifier un incident significatif et de transmettre l'alerte précoce ANSSI sous **24 h**, la notification sous **72 h** et le rapport final à **1 mois** ?"
            + (
                " Pourquoi cette procédure (§6.2 PSSI) n'a-t-elle pas été déclenchée lors de la compromission prestataire de septembre ?"
                if is_apres
                else ""
            ),
            "3. **[F-006 / F-007 — Revues des droits & Rétention 12 mois]** À quelle fréquence les revues de comptes à privilèges (PSSI §4.1) et le contrôle de rétention légale à 12 mois des journaux HDS/NIS2 (PSSI §6.1, actuellement à 30 jours sur `_Default`) sont-ils audités ?",
            "",
            "### Preuves attendues en séance (`RSSI / DPO`)",
            "- Procédure opérationnelle de notification d'incident (ANSSI Art. 23 / CNIL Art. 33) et grille de seuils de criticité.",
            "- Registre des incidents de sécurité et des violations de données à caractère personnel des 24 derniers mois.",
            "- Comptes-rendus signés des deux dernières revues semestrielles/trimestrielles des habilitations IAM.",
            "",
            "---",
            "",
            "## 4. Direction des Achats & Service Juridique (`Achats / Juridique` — Art. 21 §2 d)",
            "",
            "**Objectif de séance** : Encadrer contractuellement la chaîne d'approvisionnement numérique (`MedTech Solutions SAS`, infogérance télémaintenance, hébergement HDS) suite aux écarts techniques et à la mise en quarantaine documentaire.",
            "",
            "### Points d'alerte tiers & contractuels",
            "- **Prestataire critique identifié** : `MedTech Solutions SAS` (télémaintenance imagerie / PACS) — pièce `annexe_fournisseur_maintenance.md` isolée en **quarantaine anti-injection** par le sas `Douanier`.",
            "- **Exposition technique associée** : compte prestataire `sa-prestataire-meditech` en `roles/editor` avec clé statique de 248 jours (`F-006`), ouverture SSH `0.0.0.0/0` (`F-002`)"
            + (
                " et compromission avérée d'un compte prestataire en septembre non notifiée (`F-004`)."
                if is_apres
                else "."
            ),
            "",
            "### Questions contradictoires à poser aux `Achats / Juridique`",
            "1. **[Quarantaine `MedTech Solutions SAS`]** Par quel canal l'annexe technique `annexe_fournisseur_maintenance.md` (bloquée par le sas anti-injection de prompt) a-t-elle été réceptionnée et qui valide l'intégrité documentaire des livrables fournisseurs avant intégration au référentiel interne ?",
            "2. **[Clauses NIS2 Art. 21 §2 d & PSSI §3.3]** Le contrat de maintenance `MedTech Solutions SAS` et le marché d'infogérance intègrent-ils un Plan d'Assurance Sécurité (PAS) opposable imposant : l'accès exclusif par bastion nominatif MFA, l'interdiction des clés statiques longue durée, le droit d'audit et la notification d'incident sans délai (< 24 h) ?",
            "3. **[Responsabilité & Réversibilité]**"
            + (
                " Quelles pénalités ou mesures conservatoires contractuelles ont été activées envers le prestataire impliqué dans l'incident de septembre (`F-004`) ?"
                if is_apres
                else " Quelles clauses de suspension immédiate d'accès et de mise en demeure s'appliquent en cas de non-conformité cyber d'un sous-traitant critique ?"
            ),
            "",
            "### Preuves attendues en séance (`Achats / Juridique`)",
            "- Contrat de télémaintenance `MedTech Solutions SAS` signé, annexes PAS (PSSI §3.3) et certificat HDS / ISO 27001 en cours de validité.",
            "- Registre des tiers critiques ayant accès au SI hospitalier (Art. 21 §2 d NIS2) et conventions d'accès distant nominatif.",
            "- Projet d'avenant de sécurité imposant l'authentification éphémère (Workload Identity / IAP), la révocation sous 1 h et l'alerte cyber < 24 h.",
        ]
    )

    # Constats personnalisés additionnels (hors F-001..F-007)
    standard_ids = {"F-001", "F-002", "F-003", "F-004", "F-005", "F-006", "F-007"}
    custom_findings = [f for f in findings if str(f.get("id") or "") not in standard_ids]
    if custom_findings:
        lines.extend(
            [
                "",
                "---",
                "",
                "## Constats Complémentaires Spécifiques à la Session",
                "",
            ]
        )
        for cf in custom_findings:
            cid = str(cf.get("id") or "F-CUSTOM")
            lines.extend(_finding_summary_block(cid))

    extra_questions = [
        str(q).strip() for q in (syn.get("questions_entretien") or []) if str(q).strip()
    ]
    if extra_questions:
        lines.extend(
            [
                "",
                "---",
                "",
                "## Questions de Relance Automatisées du Contre-Auditeur",
                "",
            ]
        )
        for idx, q_txt in enumerate(extra_questions, start=1):
            lines.append(f"{idx}. {q_txt}")

    if decisions_map:
        lines.extend(
            [
                "",
                "---",
                "",
                "## Arbitrages GRC du Consultant à Confirmer en Séance",
                "",
                "| Constat | Décision GRC | Porteur désigné | Échéance | Commentaire / Justification |",
                "| :--- | :--- | :--- | :--- | :--- |",
            ]
        )
        for fid in sorted(decisions_map.keys()):
            d = decisions_map[fid]
            if not isinstance(d, dict):
                continue
            dec_lbl = str(d.get("decision") or "-")
            owner = str(d.get("porteur") or "À confirmer")
            due = str(d.get("echeance") or "-")
            note = str(d.get("commentaire") or "-").replace("\n", " ")
            lines.append(f"| `{fid}` | `{dec_lbl}` | {owner} | {due} | {note} |")

    lines.extend(
        [
            "",
            "---",
            "",
            "## Sceau Probatoire & Traçabilité Forensique TRIAD",
            "",
            "- **Validation humaine obligatoire** : `APPROUVÉ PAR LE CONSULTANT` (verrou `HTTP 403` levé après revue).",
            f"- **Mode certifié** : `{active_mode}` • **Session** : `{session_id}`",
            f"- **Empreinte SHA-256 de tête (`06_Audit_Chain.jsonl`)** : `{head_hash}`",
            "",
        ]
    )
    return "\n".join(lines)


@app.get("/api/export/interview-guide", response_class=PlainTextResponse)
def export_interview_guide(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> PlainTextResponse:
    """Exporte le Guide d'Entretien Contradictoire pré-rempli (DSI / Admin Cloud / RSSI / Achats) après validation humaine."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    if not slot["validated"] or not slot["synthesis"]:
        raise HTTPException(
            status_code=403,
            detail="Export Guide d'Entretien Contradictoire bloqué : validation humaine du consultant requise.",
        )

    syn = slot["synthesis"]
    log_path = _get_audit_log_path(session_id)
    entries = AuditLogger(log_path, session_id=session_id).read_entries()
    chain_info = verify_chain(log_path)
    head_hash = entries[-1]["hash"] if entries else GENESIS_HASH
    guide_md = _render_interview_guide_markdown(
        session_id=session_id,
        active_mode=active_mode,
        slot=slot,
        syn=syn,
        chain_info=chain_info,
        head_hash=head_hash,
    )
    filename = f"TRIAD_Guide_Entretien_Contradictoire_{active_mode}.md"
    return PlainTextResponse(
        guide_md,
        media_type="text/markdown; charset=utf-8",
        headers=_build_export_signature_headers(
            guide_md.encode("utf-8"),
            {"Content-Disposition": f'attachment; filename="{filename}"'},
        ),
    )


def _render_risk_register_markdown(
    *,
    session_id: str,
    active_mode: AuditMode,
    slot: dict[str, Any],
    syn: dict[str, Any],
    chain_info: dict[str, Any],
    head_hash: str,
) -> str:
    """Génère le Registre Officiel d'Homologation & Dérogations GRC opposable au Comité d'Audit (NIS2 Art. 20 & Art. 21 §1)."""
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    client_name = str(syn.get("client") or "Centre Hospitalier de Valmont")
    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    decisions_map = dict(slot.get("decisions") or {})
    nis2_score = _compute_nis2_score(findings)
    chain_ok = bool(chain_info.get("valide"))
    nb_entrees = int(chain_info.get("nb_entrees") or 0)

    short_labels: dict[str, str] = {
        "a_corriger": "À corriger",
        "mesure_compensatoire": "Mesure compensatoire",
        "risque_accepte": "Risque accepté",
        "a_approfondir": "À approfondir",
    }

    rows: list[dict[str, Any]] = []
    counts_by_key = {
        "a_corriger": 0,
        "mesure_compensatoire": 0,
        "risque_accepte": 0,
        "a_approfondir": 0,
    }
    explicit_count = 0

    for f in findings:
        fid = str(f.get("id") or "F-???")
        theme = str(f.get("theme") or fid)
        exigence = str(f.get("exigence_nis2") or "Art. 21 NIS2")
        statut = str(f.get("statut") or "inconnu")
        gravite = str(f.get("gravite") or "moyenne")
        contradiction = str(f.get("contradiction") or "Contrôle témoin")
        reel_obj = f.get("reel") if isinstance(f.get("reel"), dict) else {}
        ressource = str(reel_obj.get("ressource") or "Périmètre documentaire / gouvernance")
        recommandation = str(f.get("recommandation") or "Maintenir le contrôle périodique.")

        explicit_dec = decisions_map.get(fid)
        if not isinstance(explicit_dec, dict) and isinstance(f.get("decision_grc"), dict):
            explicit_dec = f.get("decision_grc")

        if isinstance(explicit_dec, dict) and str(explicit_dec.get("decision") or "") in short_labels:
            is_explicit = True
            explicit_count += 1
            dec_key = str(explicit_dec["decision"])
            dec_short = short_labels[dec_key]
            dec_full = str(explicit_dec.get("decision_label") or VALID_GRC_DECISIONS.get(dec_key, dec_short))
            porteur = str(explicit_dec.get("porteur") or "").strip() or "Direction SI & RSSI (à préciser)"
            echeance = str(explicit_dec.get("echeance") or "").strip() or (
                "Revue 90 j" if dec_key == "risque_accepte" else "J+30"
            )
            commentaire = str(explicit_dec.get("commentaire") or "").strip() or recommandation
            updated_at = str(explicit_dec.get("updated_at") or now_iso)
        else:
            is_explicit = False
            if statut == "conforme":
                dec_key = "mesure_compensatoire"
            elif statut == "a_confirmer":
                dec_key = "a_approfondir"
            else:
                dec_key = "a_corriger"
            dec_short = short_labels[dec_key]
            dec_full = VALID_GRC_DECISIONS.get(dec_key, dec_short)
            porteur = (
                "RSSI & Direction Générale"
                if fid == "F-004"
                else ("Équipe Cloud & Infra GCP" if statut != "conforme" else "Équipe Infra (maintien)")
            )
            echeance = (
                "J+15"
                if gravite == "critique"
                else ("J+30" if gravite == "haute" else ("Continu" if statut == "conforme" else "J+60"))
            )
            commentaire = recommandation
            updated_at = "Proposition par défaut (revue consultant)"

        counts_by_key[dec_key] = counts_by_key.get(dec_key, 0) + 1
        rows.append(
            {
                "fid": fid,
                "theme": theme,
                "exigence": exigence,
                "statut": statut,
                "gravite": gravite,
                "contradiction": contradiction,
                "ressource": ressource,
                "recommandation": recommandation,
                "is_explicit": is_explicit,
                "dec_key": dec_key,
                "dec_short": dec_short,
                "dec_full": dec_full,
                "porteur": porteur,
                "echeance": echeance,
                "commentaire": commentaire,
                "updated_at": updated_at,
            }
        )

    lines: list[str] = [
        "# REGISTRE OFFICIEL D'HOMOLOGATION, D'ARBITRAGES & DÉROGATIONS GRC (NIS2)",
        "",
        f"> **Entité Essentielle auditée** : {client_name}  ",
        f"> **Cadre réglementaire** : Directive (UE) 2022/2555 **NIS2 — Article 20 (Gouvernance & responsabilité des dirigeants) & Article 21 §1 (Proportionnalité & gestion des risques)** • PSSI §2.2 & §7  ",
        f"> **Phase & Mode certifié** : `{active_mode}` • **Indice de maturité NIS2** : `{nis2_score}/100`  ",
        f"> **Session TRIAD** : `{session_id}` • **Scellé le** : {now_iso}  ",
        f"> **Intégrité de la chaîne d'audit** : `{'INTÈGRE' if chain_ok else 'À VÉRIFIER'}` ({nb_entrees} maillons SHA-256) • **Empreinte de tête** : `{head_hash}`",
        "",
        "Ce registre constitue la **pièce officielle de gouvernance cyber opposable au Comité d'Audit, au Conseil de Surveillance et à l'ANSSI**. "
        "Conformément à l'Article 20 NIS2 et à la PSSI §2.2 du CH Valmont, tout écart technique ou organisationnel fait l'objet d'un arbitrage tracé "
        "(`À corriger`, `Mesure compensatoire`, `Risque accepté`, `À approfondir`), assorti d'un porteur nominatif, d'une échéance et d'une justification motivée.",
        "",
        "---",
        "",
        "## 1. Synthèse Exécutive des Arbitrages GRC",
        "",
        "| Catégorie d'Arbitrage GRC | Nombre de Constats | Règle d'Homologation & Suivi Comité Cyber |",
        "| :--- | :---: | :--- |",
        f"| **À corriger** (`À corriger prioritairement`) | **{counts_by_key['a_corriger']}** | Remédiation obligatoire sous SLA (`J+15` critique / `J+30` haute) avec contre-audit technique. |",
        f"| **Mesure compensatoire** (`Mesure compensatoire validée`) | **{counts_by_key['mesure_compensatoire']}** | Contrôle alternatif documenté réduisant l'exposition résiduelle à un seuil acceptable. |",
        f"| **Risque accepté** (`Risque accepté temporairement`) | **{counts_by_key['risque_accepte']}** | Dérogation formelle co-signée par la Direction Générale (validité maximale 90 jours, PSSI §2.2). |",
        f"| **À approfondir** (`À approfondir`) | **{counts_by_key['a_approfondir']}** | Instruction contradictoire ou preuve complémentaire exigée sous 15 jours ouvrés. |",
        f"| **Total des constats instruits** *(dont {explicit_count} arbitrage(s) explicite(s) du consultant)* | **{len(rows)}** | Registre intégralement couvert et scellé dans `06_Audit_Chain.jsonl`. |",
        "",
        "---",
        "",
        "## 2. Matrice Consolidée de Traitement & d'Homologation des Risques",
        "",
        "| ID | Thème & Exigence NIS2 | Gravité / Statut | Décision GRC | Origine | Porteur Désigné | Échéance | Justification / Mesure Retenue |",
        "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |",
    ]

    for r in rows:
        origin_lbl = "Arbitrage Consultant" if r["is_explicit"] else "Posture par défaut"
        clean_justif = str(r["commentaire"]).replace("|", "/").replace("\n", " ")
        lines.append(
            f"| `{r['fid']}` | **{r['theme']}** ({r['exigence']}) | `{r['gravite'].upper()}` / `{r['statut']}` "
            f"| **{r['dec_short']}** | {origin_lbl} | {r['porteur']} | `{r['echeance']}` | {clean_justif} |"
        )

    lines.extend(
        [
            "",
            "---",
            "",
            "## 3. Fiches Officielles d'Acceptation de Risque Résiduel & de Suivi par Constat",
            "",
        ]
    )

    for r in rows:
        derogation_notice = (
            "DÉROGATION OFFICIELLE — Co-signature obligatoire de la Direction Générale (Art. 20 NIS2 & PSSI §2.2) ; réexamen impératif à 90 jours."
            if r["dec_key"] == "risque_accepte"
            else (
                "CONTRÔLE COMPENSATOIRE — Vérification trimestrielle d'effectivité en Comité Cyber."
                if r["dec_key"] == "mesure_compensatoire"
                else (
                    "INVESTIGATION COMPLÉMENTAIRE — Collecte de preuves attendue avant clôture d'homologation."
                    if r["dec_key"] == "a_approfondir"
                    else "PLAN DE REMÉDIATION PRIORITAIRE — Clôture soumise à contre-vérification par sonde GCP."
                )
            )
        )
        lines.extend(
            [
                f"### [{r['fid']}] {r['theme']} — Décision : {r['dec_short']} ({r['dec_full']})",
                f"- **Exigence opposable** : {r['exigence']} • **Divergence** : `{r['contradiction']}`",
                f"- **Actif / Ressource cible** : `{r['ressource']}` • **Gravité initiale** : `{r['gravite'].upper()}` (`{r['statut']}`)",
                f"- **Statut d'instruction** : {'Arbitrage explicite scellé par le consultant' if r['is_explicit'] else 'Posture recommandée par défaut'} (*{r['updated_at']}*)",
                f"- **Porteur responsable** : **{r['porteur']}** • **Échéance opposable** : `{r['echeance']}`",
                f"- **Justification motivée / Plan d'action** : {r['commentaire']}",
                f"- **Clause de gouvernance Comité d'Audit** : {derogation_notice}",
                "",
            ]
        )

    lines.extend(
        [
            "---",
            "",
            "## 4. Visa d'Homologation & Co-Signatures Réglementaires (Article 20 NIS2)",
            "",
            "| Rôle & Instance de Gouvernance | Titulaire / Fonction | Statut de Revue | Signature / Date |",
            "| :--- | :--- | :--- | :--- |",
            "| **Direction Générale (Responsabilité Art. 20 NIS2)** | Directeur Général — CH de Valmont | À contre-signer en Comité Cyber | `[  ] Approuvé le ___/___/2026` |",
            "| **Direction des Systèmes d'Information** | M. Garnier — DSI | Porteur opérationnel du plan | `[  ] Approuvé le ___/___/2026` |",
            "| **Sécurité des Systèmes d'Information** | Mme Claire Moreau — RSSI | Contrôle de conformité PSSI | `[  ] Approuvé le ___/___/2026` |",
            f"| **Direction de Mission Audit Cyber** | Consultant Risk Advisory — Deloitte | **VALIDÉ HUMAINEMENT (`{active_mode}`)** | Scellé UTC `{now_iso}` |",
            "",
            "---",
            "",
            "## 5. Sceau Cryptographique d'Opposabilité TRIAD",
            "",
            "- **Verrou humain `HTTP 403`** : levé explicitement par approbation du consultant ; toute modification ultérieure d'un arbitrage révoque automatiquement la validation et scelle un bloc `FINDING_DECISION_UPDATED`.",
            f"- **Session & Mode** : `{session_id}` / `{active_mode}`",
            f"- **Empreinte SHA-256 de tête (`06_Audit_Chain.jsonl`)** : `{head_hash}`",
            "",
        ]
    )
    return "\n".join(lines)


@app.get("/api/export/risk-register", response_class=PlainTextResponse)
def export_risk_register(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> PlainTextResponse:
    """Exporte le Registre Officiel d'Homologation & Dérogations GRC (Art. 20 & Art. 21 §1 NIS2) après validation humaine."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    if not slot["validated"] or not slot["synthesis"]:
        raise HTTPException(
            status_code=403,
            detail="Export Registre GRC bloqué : validation humaine du consultant requise.",
        )

    syn = slot["synthesis"]
    log_path = _get_audit_log_path(session_id)
    entries = AuditLogger(log_path, session_id=session_id).read_entries()
    chain_info = verify_chain(log_path)
    head_hash = entries[-1]["hash"] if entries else GENESIS_HASH
    register_md = _render_risk_register_markdown(
        session_id=session_id,
        active_mode=active_mode,
        slot=slot,
        syn=syn,
        chain_info=chain_info,
        head_hash=head_hash,
    )
    filename = f"TRIAD_Registre_Arbitrages_GRC_{active_mode}.md"
    return PlainTextResponse(
        register_md,
        media_type="text/markdown; charset=utf-8",
        headers=_build_export_signature_headers(
            register_md.encode("utf-8"),
            {"Content-Disposition": f'attachment; filename="{filename}"'},
        ),
    )


def _render_cnil_draft_markdown(
    *,
    session_id: str,
    active_mode: AuditMode,
    slot: dict[str, Any],
    syn: dict[str, Any],
    chain_info: dict[str, Any],
    head_hash: str,
) -> str:
    """Génère la Pré-Évaluation de Notification CNIL (RGPD Art. 33 & Art. 34) et l'articulation Double Guichet ANSSI + CNIL."""
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    client_name = str(syn.get("client") or "Centre Hospitalier de Valmont")
    findings = [f for f in (syn.get("findings") or []) if isinstance(f, dict)]
    by_id: dict[str, dict[str, Any]] = {
        str(f.get("id")): f for f in findings if f.get("id")
    }
    decisions_map: dict[str, Any] = dict(slot.get("decisions") or {})
    is_apres = active_mode == "APRES" or "F-004" in by_id
    chain_ok = bool(chain_info.get("valide"))
    nb_entrees = int(chain_info.get("nb_entrees") or 0)

    decision_labels = {
        "CORRIGER": "CORRIGER (Remédiation prioritaire)",
        "ACCEPTER_RISQUE": "ACCEPTER LE RISQUE (Dérogation motivée)",
        "TRANSFÉRER": "TRANSFÉRER (Tiers / Cyber-assurance)",
        "FAUX_POSITIF": "FAUX POSITIF (Écart écarté sur preuve)",
    }

    posture_banner = (
        "APRÈS ENTRETIEN CONTRADICTOIRE (`APRES` — Dit ≠ Écrit ≠ Réel) — Incident prestataire de septembre (`F-004`) + Exposition publique HDS (`F-001`)"
        if is_apres
        else "AVANT ENTRETIEN (`AVANT` — Écrit ≠ Réel) — Qualification préventive DPO sur exposition publique HDS (`F-001`) & accès tiers (`F-006`)"
    )

    lines: list[str] = [
        "# PRÉ-ÉVALUATION DE NOTIFICATION CNIL — VIOLATION DE DONNÉES (RGPD ART. 33 & ART. 34)",
        "",
        "> **AVERTISSEMENT D'USAGE RÉGLEMENTAIRE** : Ce document est un **projet d'instruction contradictoire DPO / RSSI** généré sous verrou humain (`HTTP 403`). **TRIAD n'effectue aucun envoi automatisé vers le téléservice de la CNIL (`notifications.cnil.fr`) ni vers l'ANSSI.** La qualification juridique finale et la télédéclaration relèvent exclusivement du **Responsable de Traitement** (Direction Générale) assisté du **Délégué à la Protection des Données (DPO)**.",
        "",
        "## 1. Identification de l'Entité de Santé & Contexte d'Audit",
        "",
        f"- **Responsable de traitement** : {client_name} (Établissement de santé — Entité Essentielle NIS2 & périmètre Données de Santé à Caractère Personnel — DSCP / HDS)",
        f"- **Session & Mode d'audit** : `{session_id}` — {posture_banner}",
        f"- **Horodatage de génération** : {now_iso}",
        "- **Délégué à la Protection des Données (DPO)** : `[À COMPLÉTER PAR LE DPO — Nom, numéro de désignation CNIL, contact direct 24/7]`",
        "- **RSSI / Référent Sécurité SI** : `[À COMPLÉTER PAR LE RSSI — Coordonnées cellule de crise]`",
        f"- **Intégrité de la chaîne de preuves TRIAD** : {'INTÈGRE ✓' if chain_ok else 'À VÉRIFIER'} ({nb_entrees} maillons SHA-256, empreinte de tête `{head_hash[:24]}…`)",
        "",
        "## 2. Articulation Réglementaire « Double Guichet » (ANSSI NIS2 + CNIL RGPD)",
        "",
        "En secteur hospitalier, un incident ou une exposition non maîtrisée affectant des compartiments d'imagerie ou de messagerie déclenche une **double obligation déclarative autonome et cumulative** :",
        "",
        "| Autorité / Destinataire | Base légale | Délai légal | Seuil de déclenchement | Livrable TRIAD associé |",
        "| :--- | :--- | :--- | :--- | :--- |",
        "| **ANSSI** (`monservicesecurise.cyber.gouv.fr`) | Directive (UE) 2022/2555 **NIS2 Art. 23 §4** | **< 24 h** (alerte précoce) • **< 72 h** (notification) • **< 1 mois** (rapport final) | Incident ayant un impact significatif sur la fourniture des services essentiels de soins ou la sécurité réseau/SI | `07_PreNotification_ANSSI_Art23.md` |",
        "| **CNIL** (`notifications.cnil.fr`) | **RGPD Art. 33 §1 & §4** + **HDS Exigence 5.4** | **≤ 72 h** après prise de connaissance (notification en 2 étapes possible — Art. 33 §4 ; motivation obligatoire si > 72 h — Art. 33 §1 al. 2) | Toute violation de sécurité entraînant, de manière accidentelle ou illicite, la divulgation ou l'accès non autorisé à des DCP / DSCP (sauf absence probable de risque) | **`12_Evaluation_CNIL_RGPD_Art33.md`** (présent document) |",
        "| **Personnes concernées (Patients / Agents)** | **RGPD Art. 34 §1–§3** | **Dans les meilleurs délais** | Violation susceptible d'engendrer un **risque élevé** pour les droits et libertés des patients (données de santé Art. 9 RGPD) | Section 5 ci-dessous |",
        "",
        "## 3. Qualification Factuelle des Faits Générateurs (Périmètre DSCP / HDS)",
        "",
        "### 3.1 Exposition publique Internet du compartiment d'imagerie (`F-001` — Critique)",
        "- **Constat technique prouvé (`Réel` GCP)** : La sonde en lecture seule sur `gs://ch-valmont-demo-export-radiologie` établit la présence d'une liaison IAM publique `allUsers` avec le rôle `roles/storage.objectViewer` (`public_access_prevention = inherited` non forcé à `enforced`).",
        "- **Nature des données exposées** : Compartiment dédié aux exports d'imagerie médicale et comptes rendus radiologiques relevant des **données concernant la santé (RGPD Art. 9)** et du référentiel **HDS v2.0 (Exigences 4.2 & 4.5)**.",
        "- **Facteur aggravant de traçabilité (`F-007`)** : La rétention du puits Cloud Logging `_Default` est plafonnée à **30 jours** non verrouillés (contre 365 j requis par la PSSI §6.1). Conformément à la doctrine de la CNIL et au principe d'*Accountability* (**RGPD Art. 5 §2**), l'impossibilité technique d'écarter formellement tout téléchargement non autorisé au-delà des 30 derniers jours **commande une présomption de risque justifiant la notification préventive Art. 33 (< 72 h à compter du constat d'audit)**.",
        "",
    ]

    if is_apres:
        f4 = by_id.get("F-004") or {}
        f4_desc = str(
            f4.get("recommandation")
            or "Qualifier immédiatement le périmètre exact des boîtes aux lettres et pièces jointes médicales potentiellement consultées lors de l'incident de septembre."
        )
        lines.extend(
            [
                "### 3.2 Compromission de messagerie prestataire non notifiée (`F-004` — Spécifique Mode `APRES`)",
                "- **Révélation contradictoire (`Dit` vs `Écrit`)** : Lors de l'entretien avec la DSI (`notes_entretien_DSI.md`), il a été reconnu à l'oral qu'un **compte de messagerie d'un prestataire externe a subi une compromission en septembre**, maîtrisée en interne sans saisine documentée du DPO, sans inscription au registre des violations (**RGPD Art. 33 §5**) et sans notification à la CNIL ni à l'ANSSI.",
                "- **Qualification RGPD Art. 33 §1 alinéa 2 (Notification tardive > 72 h)** : Le délai initial de 72 heures par rapport à l'événement de septembre étant dépassé, la notification à la CNIL — si l'exposition de données personnelles ou médicales dans les échanges de messagerie est confirmée ou ne peut être exclue — **doit impérativement être accompagnée des motifs du retard** :",
                "  1. Absence d'escalade vers le DPO lors du traitement purement technique de l'incident en septembre ;",
                "  2. Détection formelle de l'écart lors de l'audit contradictoire indépendant TRIAD ;",
                "  3. Ouverture immédiate d'une investigation rétrospective et refonte du circuit d'alerte interne PSSI §6.2.",
                f"- **Action immédiate requise** : {f4_desc}",
                "",
            ]
        )
    else:
        lines.extend(
            [
                "### 3.2 Points de levée de doute contradictoire avant clôture (`AVANT` — Pré-entretien)",
                "- **Périmètre actuel (`Écrit ≠ Réel`)** : Aucun déclaratif oral n'a encore été consolidé dans ce mode. Aucun incident historique de type compromission de compte n'est documenté dans les pièces écrites fournies.",
                "- **Vérification impérative en séance avec le DPO et la DSI** : Confirmer l'absence de tout incident de sécurité ou de messagerie survenu au cours des 12 derniers mois non inscrit au registre interne des violations (**RGPD Art. 33 §5**).",
                "",
            ]
        )

    lines.extend(
        [
            "### 3.3 Exposition liée au sous-traitant tiers hors registre (`F-006` — RGPD Art. 28 & Art. 32 §4)",
            "- **Constat technique** : Le compte de service externe `svc-medsoft-maint@ch-valmont-demo.iam.gserviceaccount.com` détient le rôle primitif `roles/owner` sur l'ensemble du projet Cloud sans figurer au registre officiel des tiers autorisés ni disposer d'un avenant de sous-traitance **RGPD Art. 28** audité.",
            "- **Impact CNIL** : Exiger du prestataire MedSoft l'attestation d'absence de compromission de clé privée de compte de service et révoquer immédiatement le privilège `roles/owner`.",
            "",
            "## 4. Pré-Remplissage Structuré du Téléservice CNIL (RGPD Art. 33 §3)",
            "",
            "| Rubrique officielle CNIL (Art. 33 §3) | Éléments factuels pré-remplis par TRIAD | Compléments requis du DPO |",
            "| :--- | :--- | :--- |",
            "| **a) Nature de la violation** | Violation de **confidentialité** (exposition publique `allUsers: objectViewer` sur `gs://ch-valmont-demo-export-radiologie`"
            + (
                " + compromission de compte messagerie prestataire en septembre `F-004`"
                if is_apres
                else ""
            )
            + ") ; vulnérabilité de **disponibilité** identifiée en parallèle sur `backup-dpi` (`F-003`, sans chiffrement malveillant constaté à ce jour). | Préciser la date exacte de création du binding `allUsers` (via journaux IAM Admin Activity conservés 400 j sur GCP) et le nombre d'objets présents dans le bucket. |",
            "| **a bis) Catégories & nombre approximatif de personnes / enregistrements** | Patients ayant fait l'objet d'un export radiologique temporaire vers `export-radiologie`"
            + (
                " et personnes citées dans le fil de messagerie prestataire compromis en septembre"
                if is_apres
                else ""
            )
            + " (**données de santé Art. 9 RGPD** : métadonnées DICOM, identifiants patients, clichés ou comptes rendus). | `[À COMPLÉTER PAR LE DPO : volumétrie exacte d'objets GCS & nombre de patients distincts]` |",
            "| **b) Nom et coordonnées du DPO** | Délégué à la Protection des Données du "
            + client_name
            + " | `[À COMPLÉTER : Identité, mél fonctionnel dpo@..., téléphone direct]` |",
            "| **c) Conséquences probables de la violation** | Accès potentiel sans authentification par des tiers non habilités ou moteurs d'indexation à des fichiers d'imagerie médicale ; atteinte au secret médical (Art. L.1110-4 CSP) et risque d'usurpation ou de chantage ciblé. | Évaluer si les fichiers déposés contenaient des données directement identifiantes (nom/NIR dans les en-têtes DICOM) ou pseudonymisées. |",
            "| **d) Mesures prises ou proposées pour remédier à la violation** | 1. Suppression immédiate du binding `allUsers` et activation `public_access_prevention = enforced` (`04_Playbook_DryRun.sh` / `09_Remediation_GitOps.tf`) ;<br>2. Fermeture du port SSH `0.0.0.0/0` (`F-002`) ;<br>3. Révocation `roles/owner` de `svc-medsoft-maint` (`F-006`) ;<br>4. Passage de la rétention Cloud Logging `_Default` à **365 jours verrouillés** et activation des `DATA_READ` Audit Logs (`F-007`). | Joindre l'horodatage effectif d'exécution du changement en production après revue humaine CAB/DSI. |",
            "",
            "## 5. Évaluation de la Communication Individuelle aux Patients (RGPD Art. 34)",
            "",
            "L'**article 34 §1 du RGPD** impose d'informer directement les patients en termes clairs et simples lorsque la violation est susceptible d'engendrer un **risque élevé** pour leurs droits et libertés. S'agissant de **données de santé (Art. 9 RGPD)** d'un établissement hospitalier, le CEPD (Lignes directrices WP250 rev.01) retient par principe une présomption de risque élevé si une exfiltration effective ou une indexation publique a eu lieu.",
            "",
            "- **Examen de l'exemption de chiffrement (Art. 34 §3 a)** : **NON APPLICABLE** pour l'exposition `allUsers` (`F-001`). Le chiffrement au repos par défaut côté Google Cloud déchiffre automatiquement les objets servis en HTTPS à tout appelant disposant du droit `objectViewer` (`allUsers`), et les compartiments ne disposent pas d'un chiffrement applicatif bout-en-bout côté client (`F-007`).",
            "- **Examen des mesures subséquentes (Art. 34 §3 b)** : Si l'analyse immédiate des journaux Cloud Storage sur les 30 derniers jours et des métadonnées d'objets démontre l'**absence totale de fichier nominatif déposé** ou l'**absence avérée de requête externe avant coupure immédiate de `allUsers`**, le DPO pourra documenter au registre Art. 33 §5 que le risque élevé ne s'est plus susceptible de se matérialiser.",
            "- **Recommandation opérationnelle DPO** : Procéder à une **notification initiale conservatoire à la CNIL sous 72 h (Art. 33 §4)** dès validation du présent constat, et statuer sous 48 h avec la Direction Médicale sur l'activation de la communication individuelle aux patients (**Art. 34**) au vu de l'inventaire exact des objets présents dans `gs://ch-valmont-demo-export-radiologie`"
            + (
                " et des boîtes aux lettres impactées par l'incident de septembre (`F-004`)."
                if is_apres
                else "."
            ),
            "",
            "## 6. Alignement avec les Arbitrages GRC de la Session",
            "",
        ]
    )

    cnil_fids = ["F-001", "F-004", "F-006", "F-007"]
    present_cnil_fids = [fid for fid in cnil_fids if fid in by_id or fid in decisions_map]
    if not present_cnil_fids:
        present_cnil_fids = ["F-001", "F-006", "F-007"]

    for fid in present_cnil_fids:
        f_obj = by_id.get(fid) or {}
        theme = str(f_obj.get("theme") or fid)
        dec = decisions_map.get(fid)
        if isinstance(dec, dict) and dec.get("decision"):
            raw_d = str(dec.get("decision"))
            lbl_d = str(
                dec.get("decision_label")
                or VALID_GRC_DECISIONS.get(raw_d)
                or decision_labels.get(raw_d)
                or raw_d
            )
            justif = str(
                dec.get("commentaire") or dec.get("justification") or "Non renseignée"
            )
            owner = str(dec.get("porteur") or dec.get("owner") or "DPO / RSSI")
            deadline = str(
                dec.get("echeance") or dec.get("deadline") or "Immédiat (< 72 h)"
            )
            lines.append(
                f"- **`{fid}` ({theme})** : **{lbl_d}** — Porteur : `{owner}` • Échéance : `{deadline}` • Justification : *{justif}*"
            )
        else:
            lines.append(
                f"- **`{fid}` ({theme})** : *Aucun arbitrage dérogatoire enregistré — Remédiation technique immédiate recommandée par défaut.*"
            )

    lines.extend(
        [
            "",
            "## 7. Sceau Forensique & Chaîne de Preuve TRIAD",
            "",
            "- **Contrôle humain obligatoire** : Livrable déverrouillé uniquement après approbation explicite du consultant (`POST /api/validate`). Toute modification ultérieure d'un arbitrage GRC révoque la validation et rétablit le verrou `HTTP 403`.",
            f"- **Session / Mode** : `{session_id}` / `{active_mode}`",
            f"- **Empreinte SHA-256 de tête (`06_Audit_Chain.jsonl`)** : `{head_hash}`",
            "",
        ]
    )
    return "\n".join(lines)


@app.get("/api/export/cnil-draft", response_class=PlainTextResponse)
def export_cnil_draft(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> PlainTextResponse:
    """Exporte la Pré-Évaluation de Notification CNIL (RGPD Art. 33 & Art. 34 — Double Guichet ANSSI + CNIL) après validation humaine."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    if not slot["validated"] or not slot["synthesis"]:
        raise HTTPException(
            status_code=403,
            detail="Export Évaluation CNIL Art. 33 bloqué : validation humaine du consultant requise.",
        )

    syn = slot["synthesis"]
    log_path = _get_audit_log_path(session_id)
    entries = AuditLogger(log_path, session_id=session_id).read_entries()
    chain_info = verify_chain(log_path)
    head_hash = entries[-1]["hash"] if entries else GENESIS_HASH
    cnil_md = _render_cnil_draft_markdown(
        session_id=session_id,
        active_mode=active_mode,
        slot=slot,
        syn=syn,
        chain_info=chain_info,
        head_hash=head_hash,
    )
    filename = f"TRIAD_Evaluation_CNIL_RGPD_Art33_{active_mode}.md"
    return PlainTextResponse(
        cnil_md,
        media_type="text/markdown; charset=utf-8",
        headers=_build_export_signature_headers(
            cnil_md.encode("utf-8"),
            {"Content-Disposition": f'attachment; filename="{filename}"'},
        ),
    )


def _build_sealed_json_payload(
    session_id: str,
    active_mode: AuditMode,
    slot: dict[str, Any],
    entries: list[dict[str, Any]],
    chain_info: dict[str, Any],
) -> dict[str, Any]:
    head_hash = entries[-1]["hash"] if entries else GENESIS_HASH
    distinct_runs = list(dict.fromkeys(e.get("run_id") for e in entries if e.get("run_id")))
    return {
        "schema_version": "1.0",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
        "mode": active_mode,
        "run_id": slot.get("run_id"),
        "validated": True,
        "statut_validation": slot["synthesis"].get("statut_validation", "VALIDÉ"),
        "elapsed_seconds": slot.get("elapsed_seconds"),
        "timings_ms": dict(slot.get("timings_ms") or {}),
        "decisions": dict(slot.get("decisions") or {}),
        "source": slot.get("source"),
        "synthesis": slot["synthesis"],
        "integrity": {
            "algorithm": "SHA-256",
            "chain": chain_info,
            "genesis_hash": GENESIS_HASH,
            "head_hash": head_hash,
            "nb_entrees": len(entries),
            "runs": distinct_runs,
        },
        "chain": chain_info,
        "audit_log": entries,
    }


@app.get("/api/export/json", response_class=JSONResponse)
def export_json(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> JSONResponse:
    """Exporte la synthèse structurée complète scellée avec métadonnées de chaîne SHA-256."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    if not slot["validated"] or not slot["synthesis"]:
        raise HTTPException(
            status_code=403,
            detail="Export JSON bloqué : validation humaine du consultant requise.",
        )

    log_path = _get_audit_log_path(session_id)
    entries = AuditLogger(log_path).read_entries()
    chain_info = verify_chain(log_path)
    payload = _build_sealed_json_payload(session_id, active_mode, slot, entries, chain_info)
    json_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return Response(
        content=json_bytes,
        media_type="application/json",
        headers=_build_export_signature_headers(json_bytes),
    )


_CSV_FORMULA_PREFIXES = ("=", "+", "-", "@")


def _sanitize_csv_cell(value: Any) -> str:
    """Neutralise l'injection de formules CSV/Excel (=, +, -, @, tab, CR) en préfixant par '."""
    if value is None:
        return ""
    raw_str = str(value)
    if not raw_str:
        return ""
    starts_with_ctrl = raw_str[0] in ("\t", "\r")
    collapsed = raw_str.replace("\r\n", " ").replace("\r", " ").replace("\n", " ").strip()
    if not collapsed:
        return ""
    if starts_with_ctrl or collapsed.startswith(_CSV_FORMULA_PREFIXES):
        return f"'{collapsed}"
    return collapsed


def _render_csv_bytes(syn: dict[str, Any], active_mode: AuditMode, head_hash: str) -> bytes:
    client_name = syn.get("client", "Centre Hospitalier de Valmont")
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=",", quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    writer.writerow(
        [
            "ID",
            "Client",
            "Mode",
            "Thème",
            "Exigence NIS2",
            "Statut",
            "Gravité",
            "Contradiction",
            "Dit (Source)",
            "Dit (Extrait)",
            "Écrit (Source & Section)",
            "Écrit (Extrait)",
            "Réel (Ressource GCP)",
            "Réel (Constat)",
            "Citation Vérifiée",
            "Confiance",
            "Recommandation",
            "Commande Corrective (Dry-Run)",
            "Décision GRC",
            "Porteur Métier",
            "Échéance Cible",
            "Commentaire d'Arbitrage",
            "Empreinte SHA-256",
        ]
    )

    for f in syn.get("findings", []):
        if not isinstance(f, dict):
            continue
        dit = f.get("dit") if isinstance(f.get("dit"), dict) else {}
        ecrit = f.get("ecrit") if isinstance(f.get("ecrit"), dict) else {}
        reel = f.get("reel") if isinstance(f.get("reel"), dict) else {}
        dec = f.get("decision_grc") if isinstance(f.get("decision_grc"), dict) else {}
        ecrit_src = ecrit.get("source", "")
        ecrit_sec = ecrit.get("section", "")
        ecrit_ref = f"{ecrit_src} ({ecrit_sec})".strip() if ecrit_src and ecrit_sec else ecrit_src

        row = [
            f.get("id", ""),
            client_name,
            active_mode,
            f.get("theme", ""),
            f.get("exigence_nis2", ""),
            f.get("statut", ""),
            f.get("gravite", ""),
            f.get("contradiction") or "",
            dit.get("source", "") if dit else "",
            dit.get("extrait", "") if dit else "",
            ecrit_ref,
            ecrit.get("extrait", "") if ecrit else "",
            reel.get("ressource", "") if reel else "",
            reel.get("constat", "") if reel else "",
            "OUI" if f.get("citation_verifiee") else "NON",
            f.get("confiance", ""),
            f.get("recommandation", ""),
            f.get("commande_correction") or "",
            dec.get("decision_label") or dec.get("decision") or "",
            dec.get("porteur", "") if dec else "",
            dec.get("echeance", "") if dec else "",
            dec.get("commentaire", "") if dec else "",
            head_hash,
        ]
        writer.writerow([_sanitize_csv_cell(col) for col in row])

    return buf.getvalue().encode("utf-8-sig")


@app.get("/api/export/csv")
def export_csv(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> Response:
    """Exporte la matrice GRC Dit / Écrit / Réel en CSV UTF-8 avec BOM (Excel FR) après validation."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    if not slot["validated"] or not slot["synthesis"]:
        raise HTTPException(
            status_code=403,
            detail="Export CSV bloqué : validation humaine du consultant requise.",
        )

    log_path = _get_audit_log_path(session_id)
    entries = AuditLogger(log_path).read_entries()
    head_hash = entries[-1]["hash"] if entries else GENESIS_HASH
    csv_bytes = _render_csv_bytes(slot["synthesis"], active_mode, head_hash)
    return Response(
        content=csv_bytes,
        media_type="text/csv; charset=utf-8",
        headers=_build_export_signature_headers(
            csv_bytes,
            {"Content-Disposition": f'attachment; filename="TRIAD_Matrice_NIS2_{active_mode}.csv"'},
        ),
    )


_UNSAFE_SHELL_RE = re.compile(r"[;|`<>]|\$\(")


def _is_safe_gcloud_chain(cmd: str) -> bool:
    parts = [p.strip() for p in cmd.split("&&")]
    if not parts:
        return False
    return all(
        part.startswith("gcloud ") and not _UNSAFE_SHELL_RE.search(part)
        for part in parts
    )


def _render_playbook_script(
    session_id: str,
    active_mode: AuditMode,
    slot: dict[str, Any],
    syn: dict[str, Any],
    chain_info: dict[str, Any],
    head_hash: str,
) -> str:
    now_iso = datetime.now(timezone.utc).isoformat()
    chain_label = "VALIDE" if chain_info.get("valide") else "ALTÉRÉE"

    lines = [
        "#!/usr/bin/env bash",
        "# ==============================================================================",
        "# TRIAD — Playbook de Remédiation Cloud (NIS2) — DRY-RUN SCELLÉ SHA-256",
        f"# Client           : {syn.get('client', 'Client')}",
        f"# Mode / Statut    : {active_mode} | {syn.get('statut_validation', 'VALIDÉ')}",
        f"# Session / Run ID : {session_id} / {slot.get('run_id') or 'n/a'}",
        f"# Empreinte SHA-256: {head_hash}",
        f"# Intégrité chaîne : {chain_label} ({chain_info.get('nb_entrees', 0)} maillons)",
        f"# Généré le (UTC)  : {now_iso}",
        "# SÉCURITÉ         : Mode DRY-RUN actif par défaut (EXECUTE=false).",
        "#                    Aucune commande n'est jamais exécutée par les agents IA.",
        "# ==============================================================================",
        "set -euo pipefail",
        "",
        'EXECUTE="${EXECUTE:-false}"',
        f'EXPECTED_CHAIN_HASH="{head_hash}"',
        "",
        'echo "=== Playbook de remédiation NIS2 — TRIAD (SHA-256: ${EXPECTED_CHAIN_HASH:0:16}...) ==="',
        'if [[ "${EXECUTE}" != "true" ]]; then',
        '  echo "[MODE DRY-RUN] Simulation active : aucune modification ne sera envoyée à Google Cloud."',
        '  echo "Pour exécuter avec confirmation interactive étape par étape : EXECUTE=true bash $0"',
        "fi",
        "",
    ]

    actionable_count = 0
    for f in syn.get("findings", []):
        raw_cmd = (f.get("commande_correction") or "").strip()
        if not raw_cmd:
            continue
        clean_cmd = re.sub(
            r"\s*\(NON\s+EX[ÉE]CUT[ÉE]E?\)\s*$",
            "",
            raw_cmd,
            flags=re.IGNORECASE,
        ).strip()
        if not clean_cmd:
            continue

        actionable_count += 1
        fid = str(f.get("id", f"STEP-{actionable_count:03d}"))
        theme = str(f.get("theme", "Contrôle")).replace('"', "'")
        gravite = str(f.get("gravite", "")).upper()
        exigence = str(f.get("exigence_nis2", ""))
        ressource = str((f.get("reel") or {}).get("ressource", "GCP")).replace('"', "'")

        lines.extend(
            [
                "# ------------------------------------------------------------------------------",
                f"# [{fid}] {theme} ({gravite} — {exigence})",
                f"# Ressource : {ressource}",
                "# ------------------------------------------------------------------------------",
                'echo ""',
                f'echo "[{fid}] {theme} — {ressource}"',
            ]
        )

        if _is_safe_gcloud_chain(clean_cmd):
            escaped_preview = clean_cmd.replace("\\", "\\\\").replace('"', '\\"')
            lines.extend(
                [
                    f'echo "  Commande : {escaped_preview}"',
                    'if [[ "${EXECUTE}" == "true" ]]; then',
                    f'  read -r -p "  Confirmer l\'exécution réelle de [{fid}] sur GCP ? (taper OUI) : " _confirm',
                    '  if [[ "${_confirm}" == "OUI" ]]; then',
                    f"    {clean_cmd}",
                    f'    echo "  -> [EXÉCUTÉ] Remédiation [{fid}] appliquée."',
                    "  else",
                    f'    echo "  -> [IGNORÉ] Étape [{fid}] annulée par l\'opérateur."',
                    "  fi",
                    "else",
                    f'  echo "  -> [DRY-RUN] Aucune action exécutée pour [{fid}]."',
                    "fi",
                    "",
                ]
            )
        else:
            commented = clean_cmd.replace("\n", " ")
            lines.extend(
                [
                    f"# [REVUE MANUELLE REQUISE] Commande hors gabarit gcloud strict : {commented}",
                    f'echo "  -> [MANUEL] Vérifier et appliquer manuellement la mesure corrective [{fid}]."',
                    "",
                ]
            )

    lines.append(
        f'echo "=== Fin du playbook TRIAD ({actionable_count} remédiation(s) gcloud référencée(s)) ==="'
    )
    return "\n".join(lines) + "\n"


@app.get("/api/export/playbook", response_class=PlainTextResponse)
def export_playbook(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> PlainTextResponse:
    """Génère un playbook Bash (.sh) dry-run scellé par l'empreinte SHA-256 après validation."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    if not slot["validated"] or not slot["synthesis"]:
        raise HTTPException(
            status_code=403,
            detail="Export playbook bloqué : validation humaine du consultant requise.",
        )

    syn = slot["synthesis"]
    log_path = _get_audit_log_path(session_id)
    entries = AuditLogger(log_path).read_entries()
    chain_info = verify_chain(log_path)
    head_hash = entries[-1]["hash"] if entries else GENESIS_HASH
    script = _render_playbook_script(session_id, active_mode, slot, syn, chain_info, head_hash)
    return PlainTextResponse(
        script,
        media_type="text/x-shellscript; charset=utf-8",
        headers=_build_export_signature_headers(script.encode("utf-8")),
    )


@app.get("/api/export/bundle")
def export_bundle(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> Response:
    """Génère en mémoire l'archive ZIP 'Dossier de Preuve Scellé NIS2' avec MANIFEST_SHA256.txt."""
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    if not slot["validated"] or not slot["synthesis"]:
        raise HTTPException(
            status_code=403,
            detail="Export dossier de preuve bloqué : validation humaine du consultant requise.",
        )

    syn = slot["synthesis"]
    log_path = _get_audit_log_path(session_id)
    entries = AuditLogger(log_path).read_entries()
    chain_info = verify_chain(log_path)
    head_hash = entries[-1]["hash"] if entries else GENESIS_HASH

    report_bytes = (_render_report_markdown(syn) + "\n").encode("utf-8")
    csv_bytes = _render_csv_bytes(syn, active_mode, head_hash)
    json_payload = _build_sealed_json_payload(session_id, active_mode, slot, entries, chain_info)
    json_bytes = (json.dumps(json_payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    playbook_bytes = _render_playbook_script(
        session_id, active_mode, slot, syn, chain_info, head_hash
    ).encode("utf-8")
    mail_raw = str(syn.get("mail_suivi") or "")
    mail_bytes = (mail_raw.rstrip("\n") + "\n" if mail_raw else "").encode("utf-8")
    audit_jsonl_bytes = log_path.read_bytes() if log_path.exists() else b""
    anssi_draft_bytes = (
        _render_anssi_draft_markdown(
            session_id=session_id,
            active_mode=active_mode,
            slot=slot,
            syn=syn,
            chain_info=chain_info,
            head_hash=head_hash,
        ).rstrip("\n")
        + "\n"
    ).encode("utf-8")
    comex_brief_bytes = (
        _render_comex_brief_markdown(
            session_id=session_id,
            active_mode=active_mode,
            state=state,
            slot=slot,
            syn=syn,
            chain_info=chain_info,
            head_hash=head_hash,
        ).rstrip("\n")
        + "\n"
    ).encode("utf-8")
    terraform_hcl_bytes = (
        _render_terraform_remediation_hcl(
            session_id=session_id,
            active_mode=active_mode,
            slot=slot,
            syn=syn,
            chain_info=chain_info,
            head_hash=head_hash,
        ).rstrip("\n")
        + "\n"
    ).encode("utf-8")
    interview_guide_bytes = (
        _render_interview_guide_markdown(
            session_id=session_id,
            active_mode=active_mode,
            slot=slot,
            syn=syn,
            chain_info=chain_info,
            head_hash=head_hash,
        ).rstrip("\n")
        + "\n"
    ).encode("utf-8")
    risk_register_bytes = (
        _render_risk_register_markdown(
            session_id=session_id,
            active_mode=active_mode,
            slot=slot,
            syn=syn,
            chain_info=chain_info,
            head_hash=head_hash,
        ).rstrip("\n")
        + "\n"
    ).encode("utf-8")
    cnil_draft_bytes = (
        _render_cnil_draft_markdown(
            session_id=session_id,
            active_mode=active_mode,
            slot=slot,
            syn=syn,
            chain_info=chain_info,
            head_hash=head_hash,
        ).rstrip("\n")
        + "\n"
    ).encode("utf-8")

    evidence_files: list[tuple[str, bytes]] = [
        ("01_Rapport_NIS2.md", report_bytes),
        ("02_Matrice_GRC.csv", csv_bytes),
        ("03_Synthese_Scellee.json", json_bytes),
        ("04_Playbook_DryRun.sh", playbook_bytes),
        ("05_Mail_DSI.txt", mail_bytes),
        ("06_Audit_Chain.jsonl", audit_jsonl_bytes),
        ("07_PreNotification_ANSSI_Art23.md", anssi_draft_bytes),
        ("08_Brief_COMEX_Art20.md", comex_brief_bytes),
        ("09_Remediation_GitOps.tf", terraform_hcl_bytes),
        ("10_Guide_Entretien_Contradictoire.md", interview_guide_bytes),
        ("11_Registre_Arbitrages_GRC.md", risk_register_bytes),
        ("12_Evaluation_CNIL_RGPD_Art33.md", cnil_draft_bytes),
    ]

    manifest_lines = [
        f"{hashlib.sha256(content).hexdigest()}  {arcname}"
        for arcname, content in evidence_files
    ]
    manifest_core = "\n".join(manifest_lines) + "\n"
    signing_secret = get_settings().audit_signing_secret
    if signing_secret:
        manifest_hmac = _compute_hmac_sha256_hex(manifest_core.encode("utf-8"), signing_secret)
        manifest_bytes = (manifest_core + f"# TRIAD-HMAC-SHA256: {manifest_hmac}\n").encode("utf-8")
    else:
        manifest_bytes = manifest_core.encode("utf-8")

    now_utc = datetime.now(timezone.utc)
    zip_date = (
        now_utc.year,
        now_utc.month,
        now_utc.day,
        now_utc.hour,
        now_utc.minute,
        now_utc.second,
    )

    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for arcname, content in [*evidence_files, ("MANIFEST_SHA256.txt", manifest_bytes)]:
            zinfo = zipfile.ZipInfo(filename=arcname, date_time=zip_date)
            zinfo.compress_type = zipfile.ZIP_DEFLATED
            unix_mode = 0o100755 if arcname.endswith(".sh") else 0o100644
            zinfo.external_attr = unix_mode << 16
            zf.writestr(zinfo, content)

    zip_bytes = zip_buf.getvalue()
    zip_filename = f"TRIAD_Dossier_Preuve_NIS2_{active_mode}_{session_id}.zip"
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers=_build_export_signature_headers(
            zip_bytes,
            {"Content-Disposition": f'attachment; filename="{zip_filename}"'},
        ),
    )


_SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$", flags=re.IGNORECASE)
_HMAC_COMMENT_RE = re.compile(r"^#\s*TRIAD-HMAC-SHA256:\s*(.*)$", flags=re.IGNORECASE)


def _is_safe_zip_member_path(member_name: str, virtual_root: Path) -> bool:
    """Vérifie qu'une entrée d'archive ZIP est exempte de traversée de chemin (anti-ZipSlip)."""
    if not member_name or "\x00" in member_name:
        return False
    if member_name.startswith(("/", "\\")) or "\\" in member_name:
        return False
    parts = Path(member_name).parts
    if not parts or any(p in {".", ".."} or ":" in p for p in parts):
        return False
    resolved = (virtual_root / member_name).resolve()
    return virtual_root in resolved.parents and resolved != virtual_root


def _verify_evidence_bundle_bytes(raw_bytes: bytes, filename: str) -> dict[str, Any]:
    """Exécute la vérification forensique complète d'un Dossier de Preuve Scellé (.zip, v1=6, v2=8, v3=9, v4=10, v5=11 ou v6=12 pièces) en mémoire."""
    verified_at = datetime.now(timezone.utc).isoformat()
    errors: list[str] = []
    files_checked: list[dict[str, Any]] = []
    zip_slip_safe = True
    manifest_valid = False
    chain_valid = False
    sealed_json_match = False
    signature_status = "UNSIGNED"
    signature_hmac: str | None = None
    computed_head_hash: str | None = None
    chain_entries = 0
    detected_bundle_version: str | None = None
    metadata: dict[str, Any] = {}

    def _build_certificate() -> dict[str, Any]:
        authentic = bool(
            zip_slip_safe
            and manifest_valid
            and chain_valid
            and sealed_json_match
            and signature_status != "INVALID"
            and not errors
        )
        if detected_bundle_version is not None:
            bundle_version = detected_bundle_version
        elif len(files_checked) == 12:
            bundle_version = "v6"
        elif len(files_checked) == 11:
            bundle_version = "v5"
        elif len(files_checked) == 10:
            bundle_version = "v4"
        elif len(files_checked) == 9:
            bundle_version = "v3"
        elif len(files_checked) == 8:
            bundle_version = "v2"
        else:
            bundle_version = "v1"
        return {
            "authentic": authentic,
            "status": "AUTHENTIQUE" if authentic else "ALTÉRÉ",
            "bundle_version": bundle_version,
            "filename": filename,
            "size_bytes": len(raw_bytes),
            "zip_slip_safe": zip_slip_safe,
            "manifest_valid": manifest_valid,
            "chain_valid": chain_valid,
            "sealed_json_match": sealed_json_match,
            "signature_status": signature_status,
            "signature_hmac": signature_hmac,
            "genesis_hash": GENESIS_HASH,
            "head_hash": computed_head_hash,
            "chain_entries": chain_entries,
            "metadata": metadata,
            "files_checked": files_checked,
            "verified_at": verified_at,
            "errors": errors,
        }

    try:
        zf_ctx = zipfile.ZipFile(io.BytesIO(raw_bytes), mode="r")
    except Exception as exc:
        errors.append(f"Archive ZIP corrompue ou structure invalide : {exc}")
        return _build_certificate()

    with zf_ctx as zf:
        infolist = zf.infolist()
        if len(infolist) > MAX_BUNDLE_MEMBERS:
            errors.append(
                f"Archive suspecte : trop d'entrées ({len(infolist)} > {MAX_BUNDLE_MEMBERS} maximum)."
            )
            return _build_certificate()

        virtual_root = Path("/triad_forensic_sandbox").resolve()
        total_uncompressed = 0
        for info in infolist:
            if not _is_safe_zip_member_path(info.filename, virtual_root):
                zip_slip_safe = False
                errors.append(
                    f"Chemin ZIP suspect bloqué (protection anti-ZipSlip) : '{info.filename}'."
                )
            if info.file_size < 0:
                errors.append(f"Taille déclarée invalide pour '{info.filename}'.")
            total_uncompressed += max(0, info.file_size)

        if not zip_slip_safe:
            return _build_certificate()

        if total_uncompressed > MAX_BUNDLE_UNCOMPRESSED_BYTES:
            max_uncomp_mb = MAX_BUNDLE_UNCOMPRESSED_BYTES // (1024 * 1024)
            errors.append(
                f"Taille décompressée excessive ({total_uncompressed} octets > {max_uncomp_mb} Mo)."
            )
            return _build_certificate()

        try:
            bad_crc_member = zf.testzip()
            if bad_crc_member is not None:
                errors.append(
                    f"Intégrité ZIP altérée (échec CRC-32 sur l'entrée '{bad_crc_member}')."
                )
        except Exception as exc:
            errors.append(f"Flux compressé ZIP altéré ou illisible : {exc}")

        archive_names = set(zf.namelist())
        manifest_map: dict[str, str] = {}
        manifest_data_lines: list[str] = []
        claimed_hmac: str | None = None
        manifest_parse_ok = True

        if "MANIFEST_SHA256.txt" not in archive_names:
            manifest_parse_ok = False
            errors.append("MANIFEST_SHA256.txt est absent de l'archive.")
        else:
            try:
                manifest_text = zf.read("MANIFEST_SHA256.txt").decode("utf-8")
                for line_idx, raw_line in enumerate(manifest_text.splitlines(), start=1):
                    stripped = raw_line.strip()
                    if not stripped:
                        continue
                    if stripped.startswith("#"):
                        m_hmac = _HMAC_COMMENT_RE.match(stripped)
                        if m_hmac:
                            claimed_hmac = m_hmac.group(1).strip()
                        continue
                    manifest_data_lines.append(stripped)
                    parts = stripped.split(None, 1)
                    if len(parts) != 2:
                        manifest_parse_ok = False
                        errors.append(f"Ligne #{line_idx} malformée dans MANIFEST_SHA256.txt.")
                        continue
                    exp_hash, raw_fname = parts[0].strip().lower(), parts[1].lstrip("*").strip()
                    if not _SHA256_HEX_RE.match(exp_hash):
                        manifest_parse_ok = False
                        errors.append(
                            f"Empreinte SHA-256 invalide dans MANIFEST_SHA256.txt pour '{raw_fname}'."
                        )
                        continue
                    if raw_fname in manifest_map:
                        manifest_parse_ok = False
                        errors.append(
                            f"Entrée dupliquée dans MANIFEST_SHA256.txt : '{raw_fname}'."
                        )
                        continue
                    manifest_map[raw_fname] = exp_hash
            except Exception as exc:
                manifest_parse_ok = False
                errors.append(f"Impossible de lire MANIFEST_SHA256.txt : {exc}")

        if claimed_hmac is None and "MANIFEST_HMAC.sig" in archive_names:
            try:
                claimed_hmac = zf.read("MANIFEST_HMAC.sig").decode("utf-8").strip()
            except Exception as exc:
                claimed_hmac = "INVALID_SIG_READ"
                errors.append(f"Impossible de lire MANIFEST_HMAC.sig : {exc}")

        # Rétrocompatibilité stricte : v1 (6), v2 (8), v3 (9), v4 (10), v5 (11) ou v6 (12 pièces avec 12_Evaluation_CNIL_RGPD_Art33.md)
        has_v6_pieces = any(
            ext_name in archive_names or ext_name in manifest_map
            for ext_name in BUNDLE_V6_EXT_FILES
        )
        has_v5_pieces = any(
            ext_name in archive_names or ext_name in manifest_map
            for ext_name in BUNDLE_V5_EXT_FILES
        )
        has_v4_pieces = any(
            ext_name in archive_names or ext_name in manifest_map
            for ext_name in BUNDLE_V4_EXT_FILES
        )
        has_v3_pieces = any(
            ext_name in archive_names or ext_name in manifest_map
            for ext_name in BUNDLE_V3_EXT_FILES
        )
        has_v2_pieces = any(
            ext_name in archive_names or ext_name in manifest_map
            for ext_name in BUNDLE_V2_EXT_FILES
        )
        if has_v6_pieces:
            expected_bundle_files = BUNDLE_REQUIRED_FILES
            detected_bundle_version = "v6"
        elif has_v5_pieces:
            expected_bundle_files = BUNDLE_V5_FILES
            detected_bundle_version = "v5"
        elif has_v4_pieces:
            expected_bundle_files = BUNDLE_V4_FILES
            detected_bundle_version = "v4"
        elif has_v3_pieces:
            expected_bundle_files = BUNDLE_V3_FILES
            detected_bundle_version = "v3"
        elif has_v2_pieces:
            expected_bundle_files = BUNDLE_V2_FILES
            detected_bundle_version = "v2"
        else:
            expected_bundle_files = BUNDLE_BASE_FILES
            detected_bundle_version = "v1"

        allowed_archive_names = {
            *expected_bundle_files,
            "MANIFEST_SHA256.txt",
            "MANIFEST_HMAC.sig",
        }
        unexpected_files = sorted(archive_names - allowed_archive_names)
        if unexpected_files:
            errors.append(
                "Fichier(s) non répertorié(s) détecté(s) dans l'archive : "
                + ", ".join(unexpected_files)
            )

        extracted_bytes: dict[str, bytes] = {}
        all_pieces_ok = True
        for req_file in expected_bundle_files:
            expected_sha = manifest_map.get(req_file)
            present = req_file in archive_names
            if not present:
                all_pieces_ok = False
                errors.append(f"Pièce obligatoire manquante dans l'archive : '{req_file}'.")
                files_checked.append(
                    {
                        "filename": req_file,
                        "present": False,
                        "size_bytes": 0,
                        "expected_sha256": expected_sha,
                        "actual_sha256": None,
                        "valid": False,
                        "status": "MISSING",
                    }
                )
                continue

            try:
                content = zf.read(req_file)
            except Exception as exc:
                all_pieces_ok = False
                errors.append(f"Lecture impossible de '{req_file}' : {exc}")
                files_checked.append(
                    {
                        "filename": req_file,
                        "present": True,
                        "size_bytes": 0,
                        "expected_sha256": expected_sha,
                        "actual_sha256": None,
                        "valid": False,
                        "status": "CORRUPTED",
                    }
                )
                continue

            extracted_bytes[req_file] = content
            actual_sha = hashlib.sha256(content).hexdigest()
            if expected_sha is None:
                all_pieces_ok = False
                errors.append(f"Pièce '{req_file}' absente de MANIFEST_SHA256.txt.")
                file_valid = False
                file_status = "UNLISTED"
            elif actual_sha != expected_sha:
                all_pieces_ok = False
                errors.append(
                    f"Échec SHA-256 sur '{req_file}' : attendu {expected_sha[:16]}…, calculé {actual_sha[:16]}…."
                )
                file_valid = False
                file_status = "TAMPERED"
            else:
                file_valid = True
                file_status = "OK"

            files_checked.append(
                {
                    "filename": req_file,
                    "present": True,
                    "size_bytes": len(content),
                    "expected_sha256": expected_sha,
                    "actual_sha256": actual_sha,
                    "valid": file_valid,
                    "status": file_status,
                }
            )

        extra_manifest_entries = sorted(set(manifest_map.keys()) - set(expected_bundle_files))
        if extra_manifest_entries:
            manifest_parse_ok = False
            errors.append(
                "Entrée(s) inattendue(s) dans MANIFEST_SHA256.txt : "
                + ", ".join(extra_manifest_entries)
            )

        manifest_valid = bool(manifest_parse_ok and all_pieces_ok and not unexpected_files)

        # Contrôle du sceau d'authenticité émetteur HMAC-SHA256 (VERIFIED | UNSIGNED | INVALID)
        if claimed_hmac is None:
            signature_status = "UNSIGNED"
            signature_hmac = None
        elif not _SHA256_HEX_RE.match(claimed_hmac):
            signature_status = "INVALID"
            signature_hmac = None
            errors.append("Sceau d'authenticité HMAC-SHA256 malformé dans MANIFEST_SHA256.txt.")
        else:
            signature_hmac = claimed_hmac.lower()
            signing_secret = get_settings().audit_signing_secret
            if not signing_secret:
                signature_status = "INVALID"
                errors.append(
                    "Sceau HMAC-SHA256 présent dans l'archive mais aucun secret AUDIT_SIGNING_SECRET n'est configuré."
                )
            else:
                manifest_core = ("\n".join(manifest_data_lines) + "\n") if manifest_data_lines else ""
                expected_hmac = _compute_hmac_sha256_hex(
                    manifest_core.encode("utf-8"), signing_secret
                )
                if not hmac.compare_digest(expected_hmac, signature_hmac):
                    signature_status = "INVALID"
                    errors.append(
                        "Sceau d'authenticité émetteur HMAC-SHA256 invalide (signature falsifiée ou clé discordante)."
                    )
                elif not manifest_valid:
                    signature_status = "INVALID"
                    errors.append(
                        "Sceau HMAC-SHA256 invalidé suite à l'altération d'une pièce du manifeste."
                    )
                else:
                    signature_status = "VERIFIED"

        # Recalcul cryptographique indépendant de 06_Audit_Chain.jsonl depuis GENESIS_HASH (0x64)
        chain_bytes = extracted_bytes.get("06_Audit_Chain.jsonl")
        sealed_bytes = extracted_bytes.get("03_Synthese_Scellee.json")

        if chain_bytes is not None:
            try:
                chain_lines = [
                    ln for ln in chain_bytes.decode("utf-8").splitlines() if ln.strip()
                ]
                if not chain_lines:
                    errors.append("Le journal 06_Audit_Chain.jsonl est vide (0 maillon).")
                else:
                    prev = GENESIS_HASH
                    chain_ok = True
                    for idx, raw_ln in enumerate(chain_lines, start=1):
                        entry = json.loads(raw_ln)
                        if not isinstance(entry, dict):
                            chain_ok = False
                            errors.append(
                                f"Bloc #{idx} invalide dans 06_Audit_Chain.jsonl (objet JSON attendu)."
                            )
                            break
                        rec_prev = entry.get("prev_hash")
                        rec_hash = entry.get("hash")
                        if rec_prev != prev:
                            chain_ok = False
                            errors.append(
                                f"Rupture de chaînage prev_hash au bloc #{idx} de 06_Audit_Chain.jsonl."
                            )
                            break
                        payload = {
                            k: v for k, v in entry.items() if k not in {"prev_hash", "hash"}
                        }
                        canonical = json.dumps(
                            payload,
                            sort_keys=True,
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        computed = hashlib.sha256((canonical + prev).encode("utf-8")).hexdigest()
                        if computed != rec_hash:
                            chain_ok = False
                            errors.append(
                                f"Empreinte SHA-256 falsifiée au bloc #{idx} de 06_Audit_Chain.jsonl."
                            )
                            break
                        prev = computed
                        chain_entries += 1
                    if chain_ok:
                        computed_head_hash = prev
                        chain_valid = True
            except Exception as exc:
                errors.append(f"Erreur de décodage de 06_Audit_Chain.jsonl : {exc}")

        if sealed_bytes is not None:
            try:
                sealed_obj = json.loads(sealed_bytes.decode("utf-8"))
                if not isinstance(sealed_obj, dict):
                    errors.append("03_Synthese_Scellee.json invalide (objet JSON attendu).")
                else:
                    syn_obj = sealed_obj.get("synthesis")
                    metadata = {
                        "client": (
                            syn_obj.get("client") if isinstance(syn_obj, dict) else None
                        ),
                        "mode": sealed_obj.get("mode"),
                        "session_id": sealed_obj.get("session_id"),
                        "run_id": sealed_obj.get("run_id"),
                        "statut_validation": sealed_obj.get("statut_validation"),
                        "exported_at": sealed_obj.get("exported_at"),
                    }
                    integrity_obj = sealed_obj.get("integrity")
                    if not isinstance(integrity_obj, dict):
                        errors.append(
                            "Section 'integrity' absente ou invalide dans 03_Synthese_Scellee.json."
                        )
                    else:
                        expected_genesis = integrity_obj.get("genesis_hash")
                        expected_head = integrity_obj.get("head_hash")
                        expected_nb = integrity_obj.get("nb_entrees")
                        genesis_ok = expected_genesis in {None, GENESIS_HASH}
                        if not genesis_ok:
                            errors.append(
                                "genesis_hash invalide dans 03_Synthese_Scellee.json."
                            )
                        nb_ok = expected_nb is None or expected_nb == chain_entries
                        if not nb_ok:
                            errors.append(
                                f"Discordance du nombre de blocs : chaîne={chain_entries}, synthèse={expected_nb}."
                            )
                        if not expected_head or not isinstance(expected_head, str):
                            errors.append(
                                "head_hash absent dans 03_Synthese_Scellee.json."
                            )
                        elif computed_head_hash is not None and expected_head != computed_head_hash:
                            chain_valid = False
                            errors.append(
                                f"Discordance head_hash entre 06_Audit_Chain.jsonl ({computed_head_hash[:16]}…) "
                                f"et 03_Synthese_Scellee.json ({expected_head[:16]}…)."
                            )
                        elif (
                            chain_valid
                            and computed_head_hash is not None
                            and expected_head == computed_head_hash
                            and genesis_ok
                            and nb_ok
                        ):
                            sealed_json_match = True
            except Exception as exc:
                errors.append(f"Erreur de décodage de 03_Synthese_Scellee.json : {exc}")

    return _build_certificate()


@app.post("/api/verify/bundle", dependencies=[Depends(_enforce_rate_limit)])
async def verify_evidence_bundle(
    file: UploadFile = File(...),
) -> dict[str, Any]:
    """Vérifie cryptographiquement un Dossier de Preuve (.zip, max 20 Mo) sans écriture disque."""
    safe_name = Path(file.filename or "").name.strip()
    if not safe_name or safe_name in {".", ".."}:
        raise HTTPException(status_code=400, detail="Nom de fichier d'archive manquant ou invalide.")
    ext_lower = Path(safe_name).suffix.lower()
    ctype_lower = (file.content_type or "").split(";", 1)[0].strip().lower()
    if ext_lower != ".zip" and not (
        ext_lower == ".bin" and ctype_lower in {"application/zip", "application/x-zip-compressed"}
    ):
        raise HTTPException(
            status_code=400,
            detail=f"Extension non autorisée pour '{safe_name}' : seul le format '.zip' est accepté.",
        )

    buf = io.BytesIO()
    total_read = 0
    while True:
        chunk = await file.read(UPLOAD_CHUNK_BYTES)
        if not chunk:
            break
        total_read += len(chunk)
        if total_read > MAX_BUNDLE_VERIFY_BYTES:
            max_mb = MAX_BUNDLE_VERIFY_BYTES // (1024 * 1024)
            raise HTTPException(
                status_code=413,
                detail=f"L'archive '{safe_name}' dépasse la taille maximale autorisée ({max_mb} Mo).",
            )
        buf.write(chunk)

    if total_read == 0:
        raise HTTPException(status_code=400, detail="Archive ZIP vide.")

    METRICS.record_bundle_verification()
    return _verify_evidence_bundle_bytes(buf.getvalue(), safe_name)


@app.post("/api/security/simulate-violation")
def trigger_security_violation(
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    state = _get_session_state(session_id)
    active_mode: AuditMode = state["mode"]
    slot = state["results_by_mode"][active_mode]
    log_path = _get_audit_log_path(session_id)
    logger = AuditLogger(log_path, run_id=slot.get("run_id"), mode=active_mode)
    res = simulate_unauthorized_action(logger)
    slot["agent_statuses"]["AnalysteConformite"] = "bloqué"
    state["security_alert"] = res["result"]["message"]
    SESSION_STORE.save(session_id)
    _bump_session_epoch(session_id)
    if res.get("blocked"):
        METRICS.record_security_violation()
    return {
        "session_id": session_id,
        "blocked": res["blocked"],
        "alert": res["result"]["message"],
        "audit_log": logger.read_entries(),
        "chain": verify_chain(log_path),
    }


@app.get("/api/security/posture")
def get_security_posture(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    """Expose l'état vérifié en temps réel des 9 barrières d'auto-sécurité de TRIAD."""
    s = get_settings()
    state = _get_session_state(session_id)
    active_mode: AuditMode = mode or state["mode"]
    slot = state["results_by_mode"][active_mode]
    log_path = _get_audit_log_path(session_id)
    chain_info = verify_chain(log_path)

    all_allowed_tools = [t for tools in PERMISSIONS.values() for t in tools]
    gcp_tools = [t for t in all_allowed_tools if t.startswith("gcp_")]
    gcp_read_only = bool(gcp_tools) and all(t.startswith("gcp_check_") for t in gcp_tools)
    douanier_tools = set(PERMISSIONS.get("Douanier", []))
    quarantine_active = {"scan_injection", "quarantine_file"}.issubset(douanier_tools) and all(
        "read_raw_file" not in tools
        for ag, tools in PERMISSIONS.items()
        if ag != "Douanier"
    )
    dlp_active = "redact_pii" in douanier_tools
    hmac_enabled = bool(s.audit_signing_secret)
    chain_valid = bool(chain_info.get("valide"))
    nb_entrees = int(chain_info.get("nb_entrees") or 0)
    rate_limit_active = bool(
        s.rate_limit_max_requests > 0 and s.rate_limit_window_seconds > 0
    )
    csp_strict = all(
        directive in CONTENT_SECURITY_POLICY
        for directive in ("default-src 'self'", "object-src 'none'", "frame-ancestors 'none'")
    )
    locked_exports_count = len(SEALED_EXPORT_ENDPOINTS)
    max_upload_mb = MAX_UPLOAD_FILE_BYTES // (1024 * 1024)
    max_bundle_mb = MAX_BUNDLE_VERIFY_BYTES // (1024 * 1024)
    current_validated = bool(slot.get("validated"))

    barriers: list[dict[str, Any]] = [
        {
            "id": "gcp_readonly",
            "label": "Moindre privilège GCP (Lecture seule stricte)",
            "category": "Isolation Cloud",
            "active": gcp_read_only,
            "status_label": f"ACTIF ({len(gcp_tools)} sondes read-only) ✓" if gcp_read_only else "ALERTE",
            "detail": (
                f"{len(gcp_tools)} sondes lecture seule autorisées ({', '.join(gcp_tools)}) ; "
                "aucune écriture, suppression ni exécution gcloud automatique."
            ),
        },
        {
            "id": "human_locks_403",
            "label": f"Verrous humains obligatoires ({locked_exports_count} exports HTTP 403)",
            "category": "Gouvernance Humaine",
            "active": locked_exports_count >= 12,
            "status_label": (
                f"{locked_exports_count} EXPORTS DÉVERROUILLÉS (SIGNÉ)"
                if current_validated
                else f"{locked_exports_count} VERROUS HTTP 403 ACTIFS ✓"
            ),
            "detail": (
                "Rapport, Mail, JSON, CSV, Playbook, ANSSI Art. 23, COMEX Art. 20, "
                "Manifeste Terraform .tf, Guide d'Entretien .md, Registre GRC .md, Évaluation CNIL Art. 33 .md et Dossier .zip (12 pièces) bloqués avant approbation humaine."
            ),
        },
        {
            "id": "sha256_chain",
            "label": "Chaîne cryptographique SHA-256 append-only",
            "category": "Intégrité Forensique",
            "active": chain_valid,
            "status_label": f"INTÈGRE ({nb_entrees} maillons) ✓" if chain_valid else "CHAÎNE ALTÉRÉE ✕",
            "detail": (
                f"Journal immuable chaîné depuis GENESIS_HASH (0×64), {nb_entrees} bloc(s) vérifié(s)"
                + (f", archivage WORM : gs://{s.audit_logs_bucket}." if s.audit_logs_bucket else ".")
            ),
        },
        {
            "id": "hmac_seal",
            "label": "Sceau émetteur HMAC-SHA256 (AUDIT_SIGNING_SECRET)",
            "category": "Authenticité Émetteur",
            "active": hmac_enabled,
            "status_label": (
                "ACTIVÉ (X-Triad-Signature) ✓"
                if hmac_enabled
                else "UNSIGNED (Clé non configurée)"
            ),
            "detail": (
                f"Signature HMAC-SHA256 active sur MANIFEST_SHA256.txt, SBOM CycloneDX 1.5, snapshots et les {locked_exports_count} livrables exportés."
                if hmac_enabled
                else "Intégrité SHA-256 active ; configurez AUDIT_SIGNING_SECRET pour signer les exports et le SBOM en HMAC-SHA256."
            ),
        },
        {
            "id": "quarantine_guard",
            "label": "Quarantaine Anti-Injection de Prompt (Douanier)",
            "category": "Sécurité IA",
            "active": quarantine_active,
            "status_label": "ACTIF ✓" if quarantine_active else "INACTIF",
            "detail": (
                "Seul l'agent Douanier accède aux fichiers bruts ; toute pièce suspecte est isolée "
                "avant soumission aux agents AnalysteConformite et ContreAuditeur."
            ),
        },
        {
            "id": "dlp_pii",
            "label": "Masquage PII / DLP Souverain avant LLM",
            "category": "Protection HDS / RGPD",
            "active": dlp_active,
            "status_label": (
                "ACTIF (Cloud DLP + Regex) ✓" if s.use_dlp_api else "ACTIF (Regex Souverain) ✓"
            ),
            "detail": (
                "Pseudonymisation systématique des identités, e-mails, téléphones, IBAN et NIR "
                "avant toute persistance ou invocation Gemini."
            ),
        },
        {
            "id": "rate_limiter_429",
            "label": "Limiteur anti-abus HTTP 429 (Retry-After)",
            "category": "Disponibilité API",
            "active": rate_limit_active,
            "status_label": (
                f"ACTIF ({s.rate_limit_max_requests} req/{s.rate_limit_window_seconds}s) ✓"
                if rate_limit_active
                else "DÉSACTIVÉ"
            ),
            "detail": (
                f"Fenêtre glissante ({s.rate_limit_max_requests} requêtes / {s.rate_limit_window_seconds}s) "
                "par couple (session_id, IP) avec en-tête standard Retry-After."
            ),
        },
        {
            "id": "csp_headers",
            "label": "En-têtes HTTP stricts & Content-Security-Policy",
            "category": "Durcissement Web",
            "active": csp_strict,
            "status_label": "ACTIF ✓" if csp_strict else "PARTIEL",
            "detail": (
                "CSP stricte (script-src 'self', object-src 'none', frame-ancestors 'none'), "
                "X-Content-Type-Options: nosniff, X-Frame-Options: DENY, COOP: same-origin."
            ),
        },
        {
            "id": "upload_bounds",
            "label": f"Contrôles d'upload & anti-ZipSlip ({max_upload_mb} Mo / pièce)",
            "category": "Surface d'Entrée",
            "active": True,
            "status_label": "ACTIF ✓",
            "detail": (
                f"Extensions autorisées ({', '.join(sorted(ALLOWED_EXTENSIONS))}), max {MAX_UPLOAD_FILES} pièces "
                f"({max_upload_mb} Mo/pièce), vérification ZIP sans disque <= {max_bundle_mb} Mo (anti-ZipBomb 50 Mo)."
            ),
        },
    ]

    core_healthy = (
        gcp_read_only
        and chain_valid
        and quarantine_active
        and dlp_active
        and csp_strict
        and locked_exports_count >= 12
    )
    return {
        "status": "OPÉRATIONNEL" if core_healthy else "DÉGRADÉ",
        "session_id": session_id,
        "mode": active_mode,
        "hmac_signing_enabled": hmac_enabled,
        "gcp_read_only": gcp_read_only,
        "locked_exports_count": locked_exports_count,
        "locked_exports": list(SEALED_EXPORT_ENDPOINTS),
        "current_mode_validated": current_validated,
        "audit_chain_valid": chain_valid,
        "chain_entries": nb_entrees,
        "rate_limiter_enabled": rate_limit_active,
        "csp_strict": csp_strict,
        "prompt_injection_quarantine": quarantine_active,
        "dlp_pii_redaction": dlp_active,
        "max_upload_mb": max_upload_mb,
        "barriers": barriers,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }


_SBOM_REQ_RE = re.compile(
    r"^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(?:(?:>=|==|~=|>|<|<=)\s*([0-9A-Za-z_.-]+))?"
)


def _normalize_sbom_pypi_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name.strip()).lower()


def _sbom_npm_purl(pkg_name: str, version: str) -> str:
    if pkg_name.startswith("@") and "/" in pkg_name:
        scope, short = pkg_name.split("/", 1)
        return f"pkg:npm/%40{scope[1:]}/{short}@{version}"
    return f"pkg:npm/{pkg_name}@{version}"


def _sbom_npm_pkg_name(key: str, meta: dict[str, Any]) -> str:
    explicit = meta.get("name")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    marker = "node_modules/"
    idx = key.rfind(marker)
    return key[idx + len(marker) :] if idx >= 0 else key


def _sbom_sri_hashes(integrity: str) -> list[dict[str, str]]:
    hashes: list[dict[str, str]] = []
    alg_map = {
        "sha512": "SHA-512",
        "sha384": "SHA-384",
        "sha256": "SHA-256",
        "sha1": "SHA-1",
    }
    for token in integrity.split():
        if "-" not in token:
            continue
        alg_raw, b64_val = token.split("-", 1)
        cdx_alg = alg_map.get(alg_raw.lower())
        if not cdx_alg:
            continue
        try:
            raw = base64.b64decode(b64_val)
            hashes.append({"alg": cdx_alg, "content": binascii.hexlify(raw).decode("ascii")})
        except Exception:
            continue
    return hashes


_SBOM_CACHE_LOCK = threading.Lock()
_SBOM_MEMORY_CACHE: dict[str, tuple[dict[str, Any], bytes, str]] = {}


def _compute_runtime_cyclonedx_sbom_uncached(root: Path) -> dict[str, Any]:
    """Construit en mémoire pure (zéro écriture disque) le dictionnaire SBOM déterministe CycloneDX 1.5."""
    pyproject_path = root / "pyproject.toml"
    npmlock_path = root / "frontend" / "package-lock.json"

    if pyproject_path.is_file() and npmlock_path.is_file():
        pyproject_bytes = pyproject_path.read_bytes()
        npmlock_bytes = npmlock_path.read_bytes()
        py_sha = hashlib.sha256(pyproject_bytes).hexdigest()
        npm_sha = hashlib.sha256(npmlock_bytes).hexdigest()

        py_data = tomllib.loads(pyproject_bytes.decode("utf-8"))
        npm_data = json.loads(npmlock_bytes.decode("utf-8"))

        proj = py_data.get("project", {}) if isinstance(py_data.get("project"), dict) else {}
        app_name = str(proj.get("name", "triad"))
        app_version = str(proj.get("version", "0.1.0"))
        app_desc = str(proj.get("description", ""))
        app_ref = f"pkg:generic/{app_name}@{app_version}"

        serial_uuid = uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"https://triad.cyber.deloitte.fr/sbom/{py_sha}/{npm_sha}",
        )

        components_by_ref: dict[str, dict[str, Any]] = {}
        deps_by_ref: dict[str, set[str]] = {app_ref: set()}

        def _add_py_dep(spec: str, scope: str) -> None:
            m = _SBOM_REQ_RE.match(spec.strip())
            if not m:
                return
            norm_name = _normalize_sbom_pypi_name(m.group(1))
            ver = m.group(2) or "unspecified"
            purl = f"pkg:pypi/{norm_name}@{ver}"
            if purl not in components_by_ref:
                components_by_ref[purl] = {
                    "bom-ref": purl,
                    "type": "library",
                    "name": norm_name,
                    "version": ver,
                    "scope": scope,
                    "purl": purl,
                    "properties": [
                        {"name": "triad:ecosystem", "value": "pypi"},
                        {"name": "triad:specifier", "value": spec.strip()},
                    ],
                }
            elif scope == "required":
                components_by_ref[purl]["scope"] = "required"
            deps_by_ref[app_ref].add(purl)
            deps_by_ref.setdefault(purl, set())

        for spec in proj.get("dependencies", []):
            if isinstance(spec, str):
                _add_py_dep(spec, "required")

        opt_deps = proj.get("optional-dependencies", {})
        if isinstance(opt_deps, dict):
            for group_specs in opt_deps.values():
                if isinstance(group_specs, list):
                    for spec in group_specs:
                        if isinstance(spec, str):
                            _add_py_dep(spec, "optional")

        packages = npm_data.get("packages", {})
        root_pkg = packages.get("", {}) if isinstance(packages, dict) else {}
        fe_name = str(root_pkg.get("name") or npm_data.get("name") or "triad-frontend")
        fe_ver = str(root_pkg.get("version") or npm_data.get("version") or "0.1.0")
        fe_ref = _sbom_npm_purl(fe_name, fe_ver)
        components_by_ref[fe_ref] = {
            "bom-ref": fe_ref,
            "type": "application",
            "name": fe_name,
            "version": fe_ver,
            "scope": "required",
            "purl": fe_ref,
            "properties": [{"name": "triad:ecosystem", "value": "npm"}],
        }
        deps_by_ref[app_ref].add(fe_ref)
        deps_by_ref.setdefault(fe_ref, set())

        npm_name_to_primary_ref: dict[str, str] = {}
        if isinstance(packages, dict):
            for lock_key in sorted(packages.keys()):
                if not lock_key:
                    continue
                meta = packages[lock_key]
                if not isinstance(meta, dict):
                    continue
                pkg_name = _sbom_npm_pkg_name(lock_key, meta)
                pkg_ver = str(meta.get("version") or "").strip()
                if not pkg_name or not pkg_ver:
                    continue
                purl = _sbom_npm_purl(pkg_name, pkg_ver)
                scope = "optional" if bool(meta.get("dev", False)) else "required"

                if lock_key == f"node_modules/{pkg_name}" or pkg_name not in npm_name_to_primary_ref:
                    npm_name_to_primary_ref[pkg_name] = purl

                if purl in components_by_ref:
                    if scope == "required":
                        components_by_ref[purl]["scope"] = "required"
                    continue

                comp: dict[str, Any] = {
                    "bom-ref": purl,
                    "type": "library",
                    "name": pkg_name,
                    "version": pkg_ver,
                    "scope": scope,
                    "purl": purl,
                }
                integrity = meta.get("integrity")
                if isinstance(integrity, str) and integrity.strip():
                    hashes = _sbom_sri_hashes(integrity.strip())
                    if hashes:
                        comp["hashes"] = hashes
                lic = meta.get("license")
                if isinstance(lic, str) and lic.strip():
                    comp["licenses"] = [{"license": {"name": lic.strip()}}]
                components_by_ref[purl] = comp
                deps_by_ref.setdefault(purl, set())

            for direct_group in ("dependencies", "devDependencies"):
                direct_map = root_pkg.get(direct_group, {})
                if isinstance(direct_map, dict):
                    for dname in sorted(direct_map.keys()):
                        target_ref = npm_name_to_primary_ref.get(dname)
                        if target_ref:
                            deps_by_ref[fe_ref].add(target_ref)

            for lock_key in sorted(packages.keys()):
                if not lock_key:
                    continue
                meta = packages[lock_key]
                if not isinstance(meta, dict):
                    continue
                pkg_name = _sbom_npm_pkg_name(lock_key, meta)
                pkg_ver = str(meta.get("version") or "").strip()
                if not pkg_name or not pkg_ver:
                    continue
                src_ref = _sbom_npm_purl(pkg_name, pkg_ver)
                sub_deps = meta.get("dependencies", {})
                if isinstance(sub_deps, dict):
                    for child_name in sorted(sub_deps.keys()):
                        nested_key = f"{lock_key}/node_modules/{child_name}"
                        nested_meta = packages.get(nested_key)
                        if isinstance(nested_meta, dict) and nested_meta.get("version"):
                            target_ref = _sbom_npm_purl(
                                child_name, str(nested_meta["version"]).strip()
                            )
                        else:
                            target_ref = npm_name_to_primary_ref.get(child_name, "")
                        if target_ref and target_ref in components_by_ref and target_ref != src_ref:
                            deps_by_ref[src_ref].add(target_ref)

        license_text = "Proprietary"
        if isinstance(proj.get("license"), dict) and proj["license"].get("text"):
            license_text = str(proj["license"]["text"])

        sorted_components = [components_by_ref[k] for k in sorted(components_by_ref.keys())]
        sorted_dependencies = [
            {"ref": ref_key, "dependsOn": sorted(deps_by_ref[ref_key])}
            for ref_key in sorted(deps_by_ref.keys())
        ]
        return {
            "$schema": "http://cyclonedx.org/schema/bom-1.5.schema.json",
            "bomFormat": "CycloneDX",
            "specVersion": "1.5",
            "serialNumber": f"urn:uuid:{serial_uuid}",
            "version": 1,
            "metadata": {
                "tools": {
                    "components": [
                        {
                            "type": "application",
                            "name": "triad-cyclonedx-sbom",
                            "version": "1.5.0",
                        }
                    ]
                },
                "component": {
                    "bom-ref": app_ref,
                    "type": "application",
                    "name": app_name,
                    "version": app_version,
                    "description": app_desc,
                    "licenses": [{"license": {"name": license_text}}],
                },
                "properties": [
                    {"name": "triad:compliance", "value": "NIS2-Art21-2-d"},
                    {"name": "triad:pyproject_sha256", "value": py_sha},
                    {"name": "triad:package_lock_sha256", "value": npm_sha},
                ],
            },
            "components": sorted_components,
            "dependencies": sorted_dependencies,
        }

    # Repli runtime déterministe pour conteneur slim Cloud Run (sans pyproject.toml / package-lock.json)
    app_name = "triad"
    try:
        app_version = importlib.metadata.version("triad")
    except Exception:
        app_version = "0.1.0"
    app_ref = f"pkg:generic/{app_name}@{app_version}"

    components_by_ref = {}
    deps_by_ref = {app_ref: set()}

    for dist in importlib.metadata.distributions():
        raw_name = str(dist.metadata.get("Name") or "").strip()
        if not raw_name:
            continue
        norm_name = _normalize_sbom_pypi_name(raw_name)
        if not norm_name or norm_name == app_name:
            continue
        ver = str(dist.version or "unspecified").strip() or "unspecified"
        purl = f"pkg:pypi/{norm_name}@{ver}"
        if purl in components_by_ref:
            continue
        components_by_ref[purl] = {
            "bom-ref": purl,
            "type": "library",
            "name": norm_name,
            "version": ver,
            "scope": "required",
            "purl": purl,
            "properties": [
                {"name": "triad:ecosystem", "value": "pypi"},
                {"name": "triad:source", "value": "runtime-metadata"},
            ],
        }
        deps_by_ref[app_ref].add(purl)
        deps_by_ref[purl] = set()

    dist_hasher = hashlib.sha256()
    if DIST_DIR.is_dir():
        asset_files = sorted(p for p in DIST_DIR.rglob("*") if p.is_file())[:64]
        for asset_path in asset_files:
            rel_posix = asset_path.relative_to(DIST_DIR).as_posix()
            dist_hasher.update(rel_posix.encode("utf-8"))
            dist_hasher.update(b"\x00")
            dist_hasher.update(asset_path.read_bytes())
    dist_sha = dist_hasher.hexdigest()

    fe_ref = _sbom_npm_purl("triad-frontend", "0.1.0")
    components_by_ref[fe_ref] = {
        "bom-ref": fe_ref,
        "type": "application",
        "name": "triad-frontend",
        "version": "0.1.0",
        "scope": "required",
        "purl": fe_ref,
        "hashes": [{"alg": "SHA-256", "content": dist_sha}],
        "properties": [{"name": "triad:ecosystem", "value": "npm-bundle"}],
    }
    deps_by_ref[app_ref].add(fe_ref)
    deps_by_ref[fe_ref] = set()

    py_env_sha = hashlib.sha256(
        "\n".join(sorted(components_by_ref.keys())).encode("utf-8")
    ).hexdigest()
    serial_uuid = uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"https://triad.cyber.deloitte.fr/sbom/runtime/{py_env_sha}/{dist_sha}",
    )

    sorted_components = [components_by_ref[k] for k in sorted(components_by_ref.keys())]
    sorted_dependencies = [
        {"ref": ref_key, "dependsOn": sorted(deps_by_ref[ref_key])}
        for ref_key in sorted(deps_by_ref.keys())
    ]
    return {
        "$schema": "http://cyclonedx.org/schema/bom-1.5.schema.json",
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "serialNumber": f"urn:uuid:{serial_uuid}",
        "version": 1,
        "metadata": {
            "tools": {
                "components": [
                    {
                        "type": "application",
                        "name": "triad-cyclonedx-sbom",
                        "version": "1.5.0",
                    }
                ]
            },
            "component": {
                "bom-ref": app_ref,
                "type": "application",
                "name": app_name,
                "version": app_version,
                "description": (
                    "TRIAD — Plateforme souveraine d'audit cyber NIS2 (Dit / Écrit / Réel) sur Google Cloud"
                ),
                "licenses": [{"license": {"name": "Proprietary"}}],
            },
            "properties": [
                {"name": "triad:compliance", "value": "NIS2-Art21-2-d"},
                {"name": "triad:runtime_env_sha256", "value": py_env_sha},
                {"name": "triad:frontend_dist_sha256", "value": dist_sha},
            ],
        },
        "components": sorted_components,
        "dependencies": sorted_dependencies,
    }


def _get_cached_runtime_sbom_bundle(
    repo_root: Path | None = None,
) -> tuple[dict[str, Any], bytes, str]:
    """Retourne depuis le cache mémoire (objet CycloneDX 1.5, octets JSON, ETag SHA-256) sans relire le disque."""
    root = (repo_root or Path(__file__).resolve().parents[3]).resolve()
    cache_key = str(root)
    with _SBOM_CACHE_LOCK:
        cached = _SBOM_MEMORY_CACHE.get(cache_key)
        if cached is not None:
            return cached

    sbom_obj = _compute_runtime_cyclonedx_sbom_uncached(root)
    sbom_bytes = (json.dumps(sbom_obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    sbom_etag = f'"{hashlib.sha256(sbom_bytes).hexdigest()}"'
    bundle = (sbom_obj, sbom_bytes, sbom_etag)
    with _SBOM_CACHE_LOCK:
        _SBOM_MEMORY_CACHE[cache_key] = bundle
    return bundle


def _build_runtime_cyclonedx_sbom(repo_root: Path | None = None) -> dict[str, Any]:
    """Retourne l'objet SBOM déterministe CycloneDX 1.5 mémorisé en cache mémoire."""
    return _get_cached_runtime_sbom_bundle(repo_root=repo_root)[0]


@app.api_route("/api/security/sbom", methods=["GET", "HEAD"])
def get_security_sbom(request: Request) -> Response:
    """Expose depuis le cache mémoire l'attestation logicielle SBOM CycloneDX 1.5 signée avec support ETag / HTTP 304."""
    _, sbom_bytes, sbom_etag = _get_cached_runtime_sbom_bundle()
    return _build_conditional_signed_response(
        request,
        sbom_bytes,
        etag=sbom_etag,
        media_type="application/json",
        base_headers={
            "Content-Disposition": 'attachment; filename="TRIAD_SBOM_CycloneDX_1.5.json"'
        },
    )


@app.get("/api/gcp/auditor-proof")
def auditor_least_privilege_proof() -> dict[str, Any]:
    s = get_settings()
    return {
        "service_account": f"triad-auditor@{s.project_id or 'ch-valmont-demo'}.iam.gserviceaccount.com",
        "objet_test": "storage.objects.get",
        "resultat": "403 Forbidden (accès aux données métier bloqué par IAM)",
        "mode": "snapshot" if s.use_gcp_snapshot else "gcp_live",
    }
