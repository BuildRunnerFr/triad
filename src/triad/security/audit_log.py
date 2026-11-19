"""Journal d'audit JSONL infalsifiable chaîné par SHA-256 (append-only multi-exécutions)."""

from __future__ import annotations

import hashlib
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from triad.security.structured_log import (
    emit_structured_audit_event,
    infer_session_id_from_log_path,
)

GENESIS_HASH = "0" * 64
_LISTENERS_LOCK = threading.Lock()
_ENTRY_LISTENERS: list[Callable[[dict[str, Any]], None]] = []
_PATH_LOCKS_GUARD = threading.Lock()
_PATH_LOCKS: dict[Path, threading.Lock] = {}


def _get_path_lock(log_path: Path) -> threading.Lock:
    resolved = log_path.resolve()
    with _PATH_LOCKS_GUARD:
        lock = _PATH_LOCKS.get(resolved)
        if lock is None:
            lock = threading.Lock()
            _PATH_LOCKS[resolved] = lock
        return lock


def register_audit_listener(fn: Callable[[dict[str, Any]], None]) -> None:
    """Enregistre un écouteur temps réel appelé à chaque nouveau bloc SHA-256."""
    with _LISTENERS_LOCK:
        if fn not in _ENTRY_LISTENERS:
            _ENTRY_LISTENERS.append(fn)


def unregister_audit_listener(fn: Callable[[dict[str, Any]], None]) -> None:
    """Retire un écouteur temps réel."""
    with _LISTENERS_LOCK:
        if fn in _ENTRY_LISTENERS:
            _ENTRY_LISTENERS.remove(fn)


def _compute_hash(payload: dict[str, Any], prev_hash: str) -> str:
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    digest_input = f"{canonical}{prev_hash}".encode("utf-8")
    return hashlib.sha256(digest_input).hexdigest()


class AuditLogger:
    """Écrivain thread-safe append-only pour le journal d'audit chaîné par SHA-256."""

    def __init__(
        self,
        log_path: Path,
        run_id: str | None = None,
        mode: str | None = None,
        session_id: str | None = None,
    ) -> None:
        self.log_path = log_path
        self.run_id = run_id
        self.mode = mode
        self.session_id = infer_session_id_from_log_path(log_path, session_id)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = _get_path_lock(self.log_path)
        with self._lock:
            self._last_hash = self._recover_last_hash()

    def _recover_last_hash(self) -> str:
        if not self.log_path.exists():
            return GENESIS_HASH
        lines = [
            line.strip()
            for line in self.log_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        if not lines:
            return GENESIS_HASH
        try:
            last = json.loads(lines[-1])
            return str(last.get("hash", GENESIS_HASH))
        except Exception:
            return GENESIS_HASH

    def reset(self) -> None:
        """Réinitialise explicitement le journal pour une nouvelle session de démo."""
        with self._lock:
            if self.log_path.exists():
                self.log_path.unlink()
            self._last_hash = GENESIS_HASH

    def append(
        self,
        agent: str,
        action: str,
        details: dict[str, Any] | str | None = None,
        *,
        run_id: str | None = None,
        mode: str | None = None,
    ) -> dict[str, Any]:
        """Ajoute une entrée signée par hash chaîné (incluant run_id et mode) dans le fichier JSONL."""
        effective_run_id = run_id if run_id is not None else self.run_id
        effective_mode = mode if mode is not None else self.mode

        with self._lock:
            prev_hash = self._recover_last_hash()
            core: dict[str, Any] = {
                "ts": datetime.now(timezone.utc).isoformat(),
                "run_id": effective_run_id,
                "mode": effective_mode,
                "agent": agent,
                "action": action,
                "details": details if details is not None else {},
            }
            entry_hash = _compute_hash(core, prev_hash)
            full_entry = {**core, "prev_hash": prev_hash, "hash": entry_hash}
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with self.log_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(full_entry, ensure_ascii=False) + "\n")
            self._last_hash = entry_hash

        emit_structured_audit_event(full_entry, session_id=self.session_id)

        with _LISTENERS_LOCK:
            listeners = list(_ENTRY_LISTENERS)
        for fn in listeners:
            try:
                fn(full_entry)
            except Exception:
                pass
        return full_entry

    def read_entries(self, run_id: str | None = None) -> list[dict[str, Any]]:
        """Lit toutes les entrées du journal (ou filtre par run_id si spécifié)."""
        with self._lock:
            if not self.log_path.exists():
                return []
            raw_text = self.log_path.read_text(encoding="utf-8")
        entries: list[dict[str, Any]] = []
        for line in raw_text.splitlines():
            stripped = line.strip()
            if stripped:
                parsed = json.loads(stripped)
                if run_id is None or parsed.get("run_id") == run_id:
                    entries.append(parsed)
        return entries


def verify_entries_chain(entries: list[Any]) -> dict[str, Any]:
    """Vérifie en mémoire l'intégrité cryptographique d'une séquence d'entrées SHA-256."""
    if not isinstance(entries, list):
        return {
            "valide": False,
            "nb_entrees": 0,
            "erreur": "Le journal d'audit doit être une liste d'entrées.",
        }

    expected_prev = GENESIS_HASH
    required_keys = {"ts", "agent", "action", "details", "prev_hash", "hash"}

    for idx, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict) or not required_keys.issubset(entry.keys()):
            return {
                "valide": False,
                "nb_entrees": len(entries),
                "erreur": f"Structure d'entrée invalide à l'entrée {idx}.",
            }
        if entry.get("prev_hash") != expected_prev:
            return {
                "valide": False,
                "nb_entrees": len(entries),
                "erreur": f"Rupture de chaîne prev_hash à l'entrée {idx}.",
            }
        core = {k: v for k, v in entry.items() if k not in ("prev_hash", "hash")}
        recomputed = _compute_hash(core, expected_prev)
        if entry.get("hash") != recomputed:
            return {
                "valide": False,
                "nb_entrees": len(entries),
                "erreur": f"Empreinte SHA-256 altérée à l'entrée {idx}.",
            }
        expected_prev = recomputed

    return {"valide": True, "nb_entrees": len(entries), "erreur": None}


def verify_chain(log_path: Path) -> dict[str, Any]:
    """Vérifie l'intégrité complète de la chaîne de hash du journal JSONL."""
    lock = _get_path_lock(log_path)
    with lock:
        if not log_path.exists():
            return {"valide": True, "nb_entrees": 0, "erreur": None}
        raw_lines = log_path.read_text(encoding="utf-8").splitlines()

    lines = [line.strip() for line in raw_lines if line.strip()]
    expected_prev = GENESIS_HASH
    required_keys = {"ts", "agent", "action", "details"}

    for idx, line in enumerate(lines, start=1):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as exc:
            return {
                "valide": False,
                "nb_entrees": idx - 1,
                "erreur": f"Ligne {idx} JSON invalide: {exc}",
            }

        if not isinstance(entry, dict) or not required_keys.issubset(entry.keys()):
            return {
                "valide": False,
                "nb_entrees": len(lines),
                "erreur": f"Structure d'entrée invalide à l'entrée {idx}.",
            }

        if entry.get("prev_hash") != expected_prev:
            return {
                "valide": False,
                "nb_entrees": len(lines),
                "erreur": f"Rupture de chaîne prev_hash à l'entrée {idx}.",
            }

        core = {k: v for k, v in entry.items() if k not in ("prev_hash", "hash")}
        recomputed = _compute_hash(core, expected_prev)
        if entry.get("hash") != recomputed:
            return {
                "valide": False,
                "nb_entrees": len(lines),
                "erreur": f"Empreinte SHA-256 altérée à l'entrée {idx}.",
            }
        expected_prev = recomputed

    return {"valide": True, "nb_entrees": len(lines), "erreur": None}


def archive_to_worm_bucket(
    *,
    bucket_name: str,
    use_gcp_snapshot: bool,
    project_id: str,
    session_id: str,
    mode: str,
    run_id: str | None,
    synthesis: dict[str, Any],
    log_path: Path,
) -> dict[str, Any]:
    """Archive de manière immuable (WORM objectCreator) le dossier validé dans GCS si configuré."""
    cleaned_bucket = bucket_name.removeprefix("gs://").strip().strip("/")
    if not cleaned_bucket or use_gcp_snapshot:
        return {
            "archived": False,
            "reason": "disabled_or_snapshot",
            "bucket": cleaned_bucket or None,
            "object_uri": None,
        }

    logger = AuditLogger(log_path)
    entries = logger.read_entries()
    chain_info = verify_chain(log_path)
    head_hash = entries[-1]["hash"] if entries else GENESIS_HASH
    now = datetime.now(timezone.utc)
    ts_compact = now.strftime("%Y%m%dT%H%M%SZ")
    run_tag = run_id or "manual"
    object_name = (
        f"audits/{session_id}/{mode}_{run_tag}_{ts_compact}_{head_hash[:12]}.json"
    )

    bundle = {
        "schema_version": "1.0",
        "archived_at": now.isoformat(),
        "session_id": session_id,
        "mode": mode,
        "run_id": run_id,
        "synthesis": synthesis,
        "integrity": {
            "algorithm": "SHA-256",
            "chain": chain_info,
            "genesis_hash": GENESIS_HASH,
            "head_hash": head_hash,
            "nb_entrees": len(entries),
        },
        "audit_log": entries,
    }

    try:
        from google.cloud import storage

        client = storage.Client(project=project_id or None)
        bucket = client.bucket(cleaned_bucket)
        blob = bucket.blob(object_name)
        blob.upload_from_string(
            json.dumps(bundle, ensure_ascii=False, indent=2),
            content_type="application/json",
            if_generation_match=0,
        )
        return {
            "archived": True,
            "reason": "uploaded_worm",
            "bucket": cleaned_bucket,
            "object_uri": f"gs://{cleaned_bucket}/{object_name}",
            "head_hash": head_hash,
        }
    except Exception as exc:
        return {
            "archived": False,
            "reason": f"gcs_error: {type(exc).__name__}",
            "bucket": cleaned_bucket,
            "object_uri": None,
        }
