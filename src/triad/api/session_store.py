"""Persistance disque atomique et résiliente par session (`logs/sessions/<session_id>.json`)."""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from triad.config import LOGS_DIR

DEFAULT_SESSION_ID = "default"
SESSIONS_DIR = LOGS_DIR / "sessions"
AGENT_NAMES = ("Douanier", "AnalysteConformite", "ContreAuditeur", "GardeDuCorps")
VALID_AGENT_STATUSES = {"en_attente", "en_cours", "terminé", "bloqué"}
VALID_GRC_DECISIONS: dict[str, str] = {
    "a_corriger": "À corriger prioritairement",
    "mesure_compensatoire": "Mesure compensatoire validée",
    "risque_accepte": "Risque accepté temporairement",
    "a_approfondir": "À approfondir",
}


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso_utc(raw: Any) -> datetime | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    txt = raw.strip()
    if txt.endswith("Z"):
        txt = txt[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(txt)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def sanitize_session_id(raw: str | None) -> str:
    """Normalise un identifiant de session pour éviter toute traversée de chemin."""
    if not raw or not raw.strip():
        return DEFAULT_SESSION_ID
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "_", raw.strip())[:64]
    return cleaned or DEFAULT_SESSION_ID


def default_agent_statuses() -> dict[str, str]:
    return {
        "Douanier": "en_attente",
        "AnalysteConformite": "en_attente",
        "ContreAuditeur": "en_attente",
        "GardeDuCorps": "en_attente",
    }


def empty_mode_slot() -> dict[str, Any]:
    return {
        "agent_statuses": default_agent_statuses(),
        "timings_ms": {},
        "decisions": {},
        "synthesis": None,
        "validated": False,
        "elapsed_seconds": None,
        "source": None,
        "run_id": None,
    }


def _sanitize_decision_record(fid: str, mode: str, raw_dec: Any) -> dict[str, Any] | None:
    if not isinstance(raw_dec, dict):
        return None
    dec_key = str(raw_dec.get("decision") or "").strip()
    if dec_key not in VALID_GRC_DECISIONS:
        return None
    updated = raw_dec.get("updated_at")
    return {
        "finding_id": fid,
        "mode": mode if mode in ("AVANT", "APRES") else "APRES",
        "decision": dec_key,
        "decision_label": VALID_GRC_DECISIONS[dec_key],
        "porteur": str(raw_dec.get("porteur") or "").strip()[:160],
        "echeance": str(raw_dec.get("echeance") or "").strip()[:64],
        "commentaire": str(raw_dec.get("commentaire") or "").strip()[:2000],
        "updated_at": (
            str(updated).strip()
            if isinstance(updated, str) and updated.strip()
            else _utc_now_iso()
        ),
    }


def new_session_state(session_id: str) -> dict[str, Any]:
    return {
        "session_id": session_id,
        "files": [],
        "mode": "APRES",
        "results_by_mode": {
            "AVANT": empty_mode_slot(),
            "APRES": empty_mode_slot(),
        },
        "security_alert": None,
        "updated_at": _utc_now_iso(),
    }


def _sanitize_synthesis(raw_syn: Any, mode: str, validated: bool) -> dict[str, Any] | None:
    if not isinstance(raw_syn, dict):
        return None
    raw_findings = raw_syn.get("findings", [])
    if not isinstance(raw_findings, list):
        return None
    clean_findings = [f for f in raw_findings if isinstance(f, dict)]

    def _str_list(val: Any) -> list[str]:
        if not isinstance(val, list):
            return []
        return [str(x) for x in val if isinstance(x, (str, int, float))]

    def _doc_list(val: Any) -> list[dict[str, Any]]:
        if not isinstance(val, list):
            return []
        return [d for d in val if isinstance(d, dict) and isinstance(d.get("nom_fichier"), str)]

    client_val = raw_syn.get("client")
    mail_val = raw_syn.get("mail_suivi")
    return {
        **raw_syn,
        "client": str(client_val) if isinstance(client_val, str) and client_val.strip() else "Centre Hospitalier de Valmont",
        "mode": mode if raw_syn.get("mode") not in ("AVANT", "APRES") else raw_syn["mode"],
        "statut_validation": "VALIDÉ" if validated else "EN ATTENTE DE VALIDATION",
        "findings": clean_findings,
        "top_3_risques": _str_list(raw_syn.get("top_3_risques")),
        "questions_entretien": _str_list(raw_syn.get("questions_entretien")),
        "mail_suivi": str(mail_val) if isinstance(mail_val, str) else "",
        "documents_nettoyes": _doc_list(raw_syn.get("documents_nettoyes")),
        "documents_quarantaine": _doc_list(raw_syn.get("documents_quarantaine")),
    }


def _hydrate_slot(raw_slot: Any, mode: str) -> dict[str, Any]:
    base = empty_mode_slot()
    if not isinstance(raw_slot, dict):
        return base

    statuses = default_agent_statuses()
    raw_statuses = raw_slot.get("agent_statuses")
    if isinstance(raw_statuses, dict):
        for k in statuses:
            candidate = raw_statuses.get(k)
            if isinstance(candidate, str) and candidate in VALID_AGENT_STATUSES:
                statuses[k] = candidate
    base["agent_statuses"] = statuses

    timings: dict[str, int] = {}
    raw_timings = raw_slot.get("timings_ms")
    if isinstance(raw_timings, dict):
        for ag in AGENT_NAMES:
            val = raw_timings.get(ag)
            if isinstance(val, (int, float)) and not isinstance(val, bool) and val >= 0:
                timings[ag] = int(round(val))
    base["timings_ms"] = timings

    raw_validated = bool(raw_slot.get("validated", False))
    hydrated_syn = _sanitize_synthesis(raw_slot.get("synthesis"), mode=mode, validated=raw_validated)

    decisions: dict[str, dict[str, Any]] = {}
    raw_decisions = raw_slot.get("decisions")
    if isinstance(raw_decisions, dict):
        for raw_fid, raw_dec in raw_decisions.items():
            fid = str(raw_fid or "").strip().upper()
            if not fid:
                continue
            clean_dec = _sanitize_decision_record(fid, mode, raw_dec)
            if clean_dec is not None:
                decisions[fid] = clean_dec

    if hydrated_syn is not None:
        for finding in hydrated_syn.get("findings", []):
            fid = str(finding.get("id") or "").strip().upper()
            if not fid:
                continue
            if fid not in decisions and isinstance(finding.get("decision_grc"), dict):
                embedded = _sanitize_decision_record(fid, mode, finding.get("decision_grc"))
                if embedded is not None:
                    decisions[fid] = embedded
            if fid in decisions:
                finding["decision_grc"] = decisions[fid]

    base["decisions"] = decisions
    base["synthesis"] = hydrated_syn
    # Invariant strict : une session sans synthèse valide ne peut pas être marquée validée
    base["validated"] = raw_validated if hydrated_syn is not None else False

    elapsed = raw_slot.get("elapsed_seconds")
    if isinstance(elapsed, (int, float)) and not isinstance(elapsed, bool) and elapsed >= 0:
        base["elapsed_seconds"] = float(elapsed)

    source = raw_slot.get("source")
    if isinstance(source, str) and source.strip():
        base["source"] = source.strip()

    run_id = raw_slot.get("run_id")
    if isinstance(run_id, str) and run_id.strip():
        base["run_id"] = run_id.strip()

    return base


def _hydrate_state(session_id: str, raw_data: Any) -> dict[str, Any]:
    state = new_session_state(session_id)
    if not isinstance(raw_data, dict):
        return state

    raw_files = raw_data.get("files")
    if isinstance(raw_files, list):
        state["files"] = [str(p) for p in raw_files if isinstance(p, str) and p.strip()]

    if raw_data.get("mode") in ("AVANT", "APRES"):
        state["mode"] = raw_data["mode"]

    raw_results = raw_data.get("results_by_mode")
    if isinstance(raw_results, dict):
        state["results_by_mode"]["AVANT"] = _hydrate_slot(raw_results.get("AVANT"), mode="AVANT")
        state["results_by_mode"]["APRES"] = _hydrate_slot(raw_results.get("APRES"), mode="APRES")

    alert = raw_data.get("security_alert")
    state["security_alert"] = str(alert) if isinstance(alert, str) and alert.strip() else None

    updated_at = raw_data.get("updated_at")
    if isinstance(updated_at, str) and updated_at.strip():
        state["updated_at"] = updated_at.strip()
    return state


class SessionStore:
    """Gestionnaire thread-safe des sessions d'audit avec sauvegarde JSON résiliente sur disque."""

    def __init__(self, sessions_dir: Path | None = None) -> None:
        self.sessions_dir = sessions_dir or SESSIONS_DIR
        self._lock = threading.RLock()
        self._cache: dict[str, dict[str, Any]] = {}

    def session_file(self, session_id: str = DEFAULT_SESSION_ID) -> Path:
        sid = sanitize_session_id(session_id)
        return self.sessions_dir / f"{sid}.json"

    def get(self, session_id: str = DEFAULT_SESSION_ID) -> dict[str, Any]:
        """Récupère l'état en RAM ou le recharge depuis le disque avec repli sain si corrompu."""
        sid = sanitize_session_id(session_id)
        with self._lock:
            cached = self._cache.get(sid)
            if cached is not None:
                return cached

            disk_path = self.session_file(sid)
            if disk_path.exists():
                try:
                    raw_text = disk_path.read_text(encoding="utf-8")
                    raw = json.loads(raw_text)
                    if not isinstance(raw, dict):
                        raise ValueError("La racine du fichier de session doit être un objet JSON.")
                    state = _hydrate_state(sid, raw)
                    if not raw.get("updated_at"):
                        mtime = disk_path.stat().st_mtime
                        state["updated_at"] = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
                except Exception:
                    # Fichier tronqué, binaire ou JSON invalide : repli sain sans planter l'API
                    state = new_session_state(sid)
            else:
                state = new_session_state(sid)

            self._cache[sid] = state
            return state

    def save(self, session_id: str = DEFAULT_SESSION_ID) -> Path:
        """Écrit de manière atomique l'état de la session dans logs/sessions/<session_id>.json."""
        sid = sanitize_session_id(session_id)
        with self._lock:
            state = self.get(sid)
            state["updated_at"] = _utc_now_iso()
            self.sessions_dir.mkdir(parents=True, exist_ok=True)
            target = self.session_file(sid)
            tmp_target = self.sessions_dir / f".{sid}.json.tmp"
            payload = json.dumps(state, ensure_ascii=False, indent=2)
            tmp_target.write_text(payload, encoding="utf-8")
            os.replace(tmp_target, target)
            return target

    def list_sessions(self) -> list[dict[str, Any]]:
        """Liste les métadonnées des sessions persistées sur disque sans exposer de contenu sensible."""
        with self._lock:
            if not self.sessions_dir.exists():
                return []
            summaries: list[dict[str, Any]] = []
            for disk_path in self.sessions_dir.glob("*.json"):
                if disk_path.name.startswith("."):
                    continue
                sid = sanitize_session_id(disk_path.stem)
                if disk_path != self.session_file(sid):
                    continue
                state = self.get(sid)
                avant_slot = state["results_by_mode"]["AVANT"]
                apres_slot = state["results_by_mode"]["APRES"]
                avant_syn = avant_slot.get("synthesis")
                apres_syn = apres_slot.get("synthesis")
                client_name = (
                    (apres_syn.get("client") if isinstance(apres_syn, dict) else None)
                    or (avant_syn.get("client") if isinstance(avant_syn, dict) else None)
                    or "Centre Hospitalier de Valmont"
                )
                updated_at = state.get("updated_at")
                if not isinstance(updated_at, str) or not updated_at.strip():
                    try:
                        mtime = disk_path.stat().st_mtime
                        updated_at = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
                    except OSError:
                        updated_at = _utc_now_iso()
                summaries.append(
                    {
                        "session_id": sid,
                        "client": client_name,
                        "mode": state.get("mode", "APRES"),
                        "files_count": len(state.get("files", [])),
                        "modes_ready": {
                            "AVANT": isinstance(avant_syn, dict),
                            "APRES": isinstance(apres_syn, dict),
                        },
                        "modes_validated": {
                            "AVANT": bool(avant_slot.get("validated")),
                            "APRES": bool(apres_slot.get("validated")),
                        },
                        "updated_at": updated_at,
                    }
                )
            summaries.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
            return summaries

    def delete_session(self, session_id: str = DEFAULT_SESSION_ID) -> bool:
        """Supprime une session du cache RAM et de logs/sessions/<session_id>.json."""
        sid = sanitize_session_id(session_id)
        with self._lock:
            had_cache = self._cache.pop(sid, None) is not None
            target = self.session_file(sid)
            had_disk = False
            try:
                if target.exists():
                    target.unlink()
                    had_disk = True
            except OSError:
                pass
            return had_disk or had_cache

    def reset(self, session_id: str = DEFAULT_SESSION_ID) -> dict[str, Any]:
        """Réinitialise la session en mémoire et supprime sa sauvegarde disque."""
        sid = sanitize_session_id(session_id)
        with self._lock:
            fresh = new_session_state(sid)
            self._cache[sid] = fresh
            target = self.session_file(sid)
            try:
                if target.exists():
                    target.unlink()
            except OSError:
                pass
            return fresh

    def clear_memory_cache(self) -> None:
        """Vide uniquement le cache RAM (utile pour simuler un redémarrage serveur en test)."""
        with self._lock:
            self._cache.clear()

    def exists(self, session_id: str = DEFAULT_SESSION_ID) -> bool:
        """Indique si la session existe en RAM ou sur disque."""
        sid = sanitize_session_id(session_id)
        with self._lock:
            return sid in self._cache or self.session_file(sid).exists()

    def export_state(self, session_id: str = DEFAULT_SESSION_ID) -> dict[str, Any]:
        """Retourne une copie portable de l'état complet de la session (sans chemins locaux absolus)."""
        sid = sanitize_session_id(session_id)
        with self._lock:
            state = json.loads(json.dumps(self.get(sid), ensure_ascii=False))
            state["session_id"] = sid
            state["files"] = [
                Path(p).name
                for p in state.get("files", [])
                if isinstance(p, str) and Path(p).name not in {"", ".", ".."}
            ]
            return state

    def import_state(
        self,
        session_id: str,
        raw_state: dict[str, Any],
        data_dir: Path | None = None,
    ) -> dict[str, Any]:
        """Hydrate, assainit les chemins de fichiers et persiste atomiquement une session importée."""
        sid = sanitize_session_id(session_id)
        with self._lock:
            hydrated = _hydrate_state(sid, raw_state)
            hydrated["session_id"] = sid
            safe_files: list[str] = []
            for raw_p in hydrated.get("files", []):
                bname = Path(str(raw_p)).name.strip()
                if not bname or bname in {".", ".."}:
                    continue
                if data_dir is not None and (data_dir / bname).is_file():
                    safe_files.append(str(data_dir / bname))
                else:
                    safe_files.append(bname)
            hydrated["files"] = safe_files
            self._cache[sid] = hydrated
            self.save(sid)
            return hydrated

    def find_expired_sessions(
        self,
        ttl_hours: float,
        now: datetime | None = None,
    ) -> list[str]:
        """Retourne les identifiants des sessions secondaires expirées (protège toujours 'default')."""
        now_utc = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        ttl_seconds = max(0.0, float(ttl_hours) * 3600.0)
        expired: list[str] = []
        seen: set[str] = set()

        with self._lock:
            if self.sessions_dir.exists():
                for disk_path in sorted(self.sessions_dir.glob("*.json")):
                    if disk_path.name.startswith("."):
                        continue
                    sid = sanitize_session_id(disk_path.stem)
                    if sid == DEFAULT_SESSION_ID or disk_path != self.session_file(sid):
                        continue
                    seen.add(sid)
                    updated_dt: datetime | None = None
                    cached_state = self._cache.get(sid)
                    if isinstance(cached_state, dict):
                        updated_dt = _parse_iso_utc(cached_state.get("updated_at"))
                    if updated_dt is None:
                        try:
                            raw = json.loads(disk_path.read_text(encoding="utf-8"))
                            if isinstance(raw, dict):
                                updated_dt = _parse_iso_utc(raw.get("updated_at"))
                        except Exception:
                            updated_dt = None
                    if updated_dt is None:
                        try:
                            mtime = disk_path.stat().st_mtime
                            updated_dt = datetime.fromtimestamp(mtime, tz=timezone.utc)
                        except OSError:
                            updated_dt = now_utc
                    if (now_utc - updated_dt).total_seconds() >= ttl_seconds:
                        expired.append(sid)

            for sid, cached_state in list(self._cache.items()):
                if sid == DEFAULT_SESSION_ID or sid in seen:
                    continue
                updated_dt = _parse_iso_utc(cached_state.get("updated_at"))
                if updated_dt is None:
                    continue
                if (now_utc - updated_dt).total_seconds() >= ttl_seconds:
                    expired.append(sid)

        return sorted(set(expired))
