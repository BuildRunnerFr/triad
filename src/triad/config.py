"""Configuration centralisée de TRIAD (variables d'environnement et chemins)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "data"
LOGS_DIR = BASE_DIR / "logs"

load_dotenv(BASE_DIR / ".env")

if os.getenv("PROJECT_ID"):
    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "TRUE")
    os.environ.setdefault("GOOGLE_CLOUD_PROJECT", os.getenv("PROJECT_ID", ""))
    os.environ.setdefault("GOOGLE_CLOUD_LOCATION", os.getenv("VERTEX_LOCATION", "global"))


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "oui"}


@dataclass(frozen=True)
class Settings:
    """Paramètres d'exécution de TRIAD."""

    project_id: str = os.getenv("PROJECT_ID", "")
    vertex_location: str = os.getenv("VERTEX_LOCATION", "europe-west9")
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    gemini_fallback_model: str = os.getenv("GEMINI_FALLBACK_MODEL", "gemini-2.5-flash")
    use_gcp_snapshot: bool = _as_bool(os.getenv("USE_GCP_SNAPSHOT"), default=True)
    use_demo_cache: bool = _as_bool(os.getenv("USE_DEMO_CACHE"), default=False)
    use_dlp_api: bool = _as_bool(os.getenv("USE_DLP_API"), default=False)
    audit_logs_bucket: str = os.getenv("AUDIT_LOGS_BUCKET", "")
    audit_signing_secret: str = os.getenv("AUDIT_SIGNING_SECRET", "")
    rate_limit_max_requests: int = int(os.getenv("RATE_LIMIT_MAX_REQUESTS", "30"))
    rate_limit_window_seconds: int = int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "60"))
    session_ttl_hours: float = float(os.getenv("SESSION_TTL_HOURS", "24"))
    log_format: str = os.getenv("LOG_FORMAT", "auto")
    host: str = os.getenv("HOST", "0.0.0.0")
    port: int = int(os.getenv("PORT", "8080"))
    data_dir: Path = DATA_DIR
    logs_dir: Path = LOGS_DIR


def get_settings() -> Settings:
    """Retourne les paramètres courants relus depuis l'environnement."""
    return Settings(
        project_id=os.getenv("PROJECT_ID", ""),
        vertex_location=os.getenv("VERTEX_LOCATION", "europe-west9"),
        gemini_model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
        gemini_fallback_model=os.getenv("GEMINI_FALLBACK_MODEL", "gemini-2.5-flash"),
        use_gcp_snapshot=_as_bool(os.getenv("USE_GCP_SNAPSHOT"), default=True),
        use_demo_cache=_as_bool(os.getenv("USE_DEMO_CACHE"), default=False),
        use_dlp_api=_as_bool(os.getenv("USE_DLP_API"), default=False),
        audit_logs_bucket=os.getenv("AUDIT_LOGS_BUCKET", "").strip(),
        audit_signing_secret=os.getenv("AUDIT_SIGNING_SECRET", "").strip(),
        rate_limit_max_requests=int(os.getenv("RATE_LIMIT_MAX_REQUESTS", "30")),
        rate_limit_window_seconds=int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "60")),
        session_ttl_hours=float(os.getenv("SESSION_TTL_HOURS", "24")),
        log_format=os.getenv("LOG_FORMAT", "auto").strip().lower() or "auto",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8080")),
    )
