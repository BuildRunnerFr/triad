"""Backend FastAPI pour TRIAD — API REST multi-sessions persistée et service de l'interface unique."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import re
import shutil
import tempfile
import threading
import time
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
from triad.api.observability import (
    ApiMetricsCollector,
    SlidingWindowRateLimiter,
    render_prometheus_metrics,
)
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
from triad.reporting.nis2_views import (
    build_continuity_view,
    build_crosswalk_view,
    build_supply_chain_view,
)
from triad.reporting.renderers import (
    build_sealed_json_payload,
    render_anssi_draft_markdown,
    render_cnil_draft_markdown,
    render_comex_brief_markdown,
    render_csv_bytes,
    render_interview_guide_markdown,
    render_playbook_script,
    render_report_markdown,
    render_risk_register_markdown,
    render_terraform_remediation_hcl,
)
from triad.reporting.scoring import (
    compute_nis2_score,
    compute_remediation_simulation,
)
from triad.security.audit_log import (
    GENESIS_HASH,
    AuditLogger,
    archive_to_worm_bucket,
    register_audit_listener,
    verify_chain,
    verify_entries_chain,
)
from triad.security.bundle_verify import (
    compute_hmac_sha256_hex,
    verify_evidence_bundle_bytes,
)
from triad.security.callbacks import simulate_unauthorized_action
from triad.security.permissions import PERMISSIONS
from triad.security.sbom import (
    get_cached_runtime_sbom_bundle,
)
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
UPLOAD_CHUNK_BYTES = 64 * 1024
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


def _build_export_signature_headers(
    payload: bytes, base_headers: dict[str, str] | None = None
) -> dict[str, str]:
    """Ajoute l'en-tête X-Triad-Signature (HMAC-SHA256) lorsque AUDIT_SIGNING_SECRET est configuré."""
    headers = dict(base_headers or {})
    secret = get_settings().audit_signing_secret
    if secret:
        sig = compute_hmac_sha256_hex(payload, secret)
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


RATE_LIMITER = SlidingWindowRateLimiter()
METRICS = ApiMetricsCollector()

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
        prom_body = render_prometheus_metrics(snap)
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

    score_avant: int | None = compute_nis2_score(avant_findings) if avant_ready else None
    score_apres: int | None = compute_nis2_score(apres_findings) if apres_ready else None
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


@app.get("/api/nis2/supply-chain")
def get_nis2_supply_chain(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    """Registre d'évaluation du risque tiers & chaîne d'approvisionnement (NIS2 Art. 21 §2 d)."""
    return build_supply_chain_view(_get_session_state(session_id), session_id, mode)


@app.get("/api/nis2/continuity")
def get_nis2_continuity(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    """Tableau de bord Continuité Clinique PCA/PRA, RTO/RPO & Exposition Rançongiciel (NIS2 Art. 21 §2 c)."""
    return build_continuity_view(_get_session_state(session_id), session_id, mode)


@app.get("/api/nis2/crosswalk")
def get_nis2_crosswalk(
    mode: AuditMode | None = None,
    session_id: str = Depends(_resolve_session_id),
) -> dict[str, Any]:
    """Table de correspondance multi-référentiels Santé : NIS2 ↔ HDS v2.0 ↔ ISO/IEC 27001:2022 ↔ RGPD Art. 32/33."""
    return build_crosswalk_view(_get_session_state(session_id), session_id, mode)


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
    return compute_remediation_simulation(
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
    return compute_remediation_simulation(
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
    report_md = render_report_markdown(slot["synthesis"])
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
    draft_md = render_anssi_draft_markdown(
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
    brief_md = render_comex_brief_markdown(
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
    settings = get_settings()
    hcl_text = render_terraform_remediation_hcl(
        session_id=session_id,
        active_mode=active_mode,
        slot=slot,
        syn=syn,
        chain_info=chain_info,
        head_hash=head_hash,
        project_id=settings.project_id,
        region=settings.vertex_location,
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
    guide_md = render_interview_guide_markdown(
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
    register_md = render_risk_register_markdown(
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
    cnil_md = render_cnil_draft_markdown(
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
    payload = build_sealed_json_payload(session_id, active_mode, slot, entries, chain_info)
    json_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return Response(
        content=json_bytes,
        media_type="application/json",
        headers=_build_export_signature_headers(json_bytes),
    )


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
    csv_bytes = render_csv_bytes(slot["synthesis"], active_mode, head_hash)
    return Response(
        content=csv_bytes,
        media_type="text/csv; charset=utf-8",
        headers=_build_export_signature_headers(
            csv_bytes,
            {"Content-Disposition": f'attachment; filename="TRIAD_Matrice_NIS2_{active_mode}.csv"'},
        ),
    )


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
    script = render_playbook_script(session_id, active_mode, slot, syn, chain_info, head_hash)
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

    report_bytes = (render_report_markdown(syn) + "\n").encode("utf-8")
    csv_bytes = render_csv_bytes(syn, active_mode, head_hash)
    json_payload = build_sealed_json_payload(session_id, active_mode, slot, entries, chain_info)
    json_bytes = (json.dumps(json_payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    playbook_bytes = render_playbook_script(
        session_id, active_mode, slot, syn, chain_info, head_hash
    ).encode("utf-8")
    mail_raw = str(syn.get("mail_suivi") or "")
    mail_bytes = (mail_raw.rstrip("\n") + "\n" if mail_raw else "").encode("utf-8")
    audit_jsonl_bytes = log_path.read_bytes() if log_path.exists() else b""
    anssi_draft_bytes = (
        render_anssi_draft_markdown(
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
        render_comex_brief_markdown(
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
        render_terraform_remediation_hcl(
            session_id=session_id,
            active_mode=active_mode,
            slot=slot,
            syn=syn,
            chain_info=chain_info,
            head_hash=head_hash,
            project_id=get_settings().project_id,
            region=get_settings().vertex_location,
        ).rstrip("\n")
        + "\n"
    ).encode("utf-8")
    interview_guide_bytes = (
        render_interview_guide_markdown(
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
        render_risk_register_markdown(
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
        render_cnil_draft_markdown(
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
        manifest_hmac = compute_hmac_sha256_hex(manifest_core.encode("utf-8"), signing_secret)
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
    return verify_evidence_bundle_bytes(
        buf.getvalue(), safe_name, signing_secret=get_settings().audit_signing_secret
    )


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


@app.api_route("/api/security/sbom", methods=["GET", "HEAD"])
def get_security_sbom(request: Request) -> Response:
    """Expose depuis le cache mémoire l'attestation logicielle SBOM CycloneDX 1.5 signée avec support ETag / HTTP 304."""
    _, sbom_bytes, sbom_etag = get_cached_runtime_sbom_bundle()
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
