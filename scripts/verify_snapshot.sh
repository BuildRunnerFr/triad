#!/usr/bin/env bash
# ==============================================================================
# Vérificateur Forensique Hors-Ligne — Snapshot de Session TRIAD (.json)
# Contrôle de façon autonome et sans serveur :
# 1. Validité structurelle JSON & absence de fuite de chemins locaux absolus
# 2. Intégrité cryptographique intégrale de la chaîne SHA-256 (`prev_hash` -> `hash`)
# 3. Concordance exacte de `state_sha256`, `head_hash`, `genesis_hash` & `nb_entrees`
# 4. Invariant d'approbation humaine (`HUMAN_VALIDATION`) sur tout mode `validated`
# 5. Authentification HMAC-SHA256 optionnelle (`AUDIT_SIGNING_SECRET` / `--secret` / `--signature`)
# ==============================================================================
set -euo pipefail

if [[ $# -lt 1 || -z "${1:-}" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<USAGE
Usage: $0 <TRIAD_Session_Snapshot_*.json> [--signature <hmac-sha256=... | hex>] [--secret <secret>]

Variables d'environnement optionnelles :
  AUDIT_SIGNING_SECRET   Clé secrète HMAC-SHA256 (alternative à --secret)
  TRIAD_SIGNATURE        Signature attendue de l'en-tête X-Triad-Signature (alternative à --signature)
USAGE
  [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && exit 0 || exit 1
fi

PYTHON_BIN="python3"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -x "${ROOT_DIR}/.venv/bin/python" ]]; then
  PYTHON_BIN="${ROOT_DIR}/.venv/bin/python"
fi

exec "${PYTHON_BIN}" - "$@" <<'PY'
import argparse
import hashlib
import hmac
import json
import os
import pathlib
import re
import sys

GENESIS_HASH = "0" * 64
HEX64_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("snapshot_path")
    parser.add_argument("positional_signature", nargs="?", default="")
    parser.add_argument("--signature", "-s", dest="signature", default="")
    parser.add_argument("--secret", "-k", dest="secret", default="")
    parser.add_argument("--require-signature", action="store_true")
    return parser.parse_args(argv)


def normalize_sig(raw: str) -> str:
    txt = raw.strip()
    if txt.lower().startswith("hmac-sha256="):
        txt = txt.split("=", 1)[1].strip()
    return txt.lower()


def compute_entry_hash(payload: dict, prev_hash: str) -> str:
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(f"{canonical}{prev_hash}".encode("utf-8")).hexdigest()


def compute_portable_state_sha256(state_obj: dict) -> str:
    core = {k: v for k, v in state_obj.items() if k != "session_id"}
    canonical = json.dumps(core, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def fail(msg: str) -> "None":
    print(f"ERREUR: {msg}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    ns = parse_args(sys.argv[1:])
    snap_path = pathlib.Path(ns.snapshot_path)
    if not snap_path.is_file():
        fail(f"Fichier snapshot introuvable : {snap_path}")

    print(f"=== Vérification forensique du Snapshot : {snap_path.name} ===")
    raw_bytes = snap_path.read_bytes()
    if not raw_bytes.strip():
        fail("Snapshot JSON vide.")

    try:
        parsed = json.loads(raw_bytes.decode("utf-8"))
    except Exception as exc:
        fail(f"Snapshot JSON malformé ou encodage UTF-8 invalide : {exc}")

    if not isinstance(parsed, dict):
        fail("La racine du snapshot doit être un objet JSON.")

    snap = parsed["snapshot"] if isinstance(parsed.get("snapshot"), dict) else parsed

    raw_state = snap.get("state")
    if not isinstance(raw_state, dict):
        fail("Champ obligatoire 'state' (objet) absent du snapshot.")

    entries = snap.get("audit_log")
    if not isinstance(entries, list):
        fail("Champ obligatoire 'audit_log' (liste) absent du snapshot.")

    integrity = snap.get("integrity")
    if not isinstance(integrity, dict):
        fail("Champ obligatoire 'integrity' (objet) absent du snapshot.")

    # 1. Contrôle anti-fuite de chemins absolus dans state.files
    raw_files = raw_state.get("files", [])
    if isinstance(raw_files, list):
        for fp in raw_files:
            if isinstance(fp, str) and (fp.startswith("/") or "\\" in fp or ".." in pathlib.PurePosixPath(fp).parts):
                fail(f"Chemin local non assaini détecté dans state.files : {fp!r}")

    # 2. Recalcul intégral de la chaîne SHA-256 (prev_hash -> hash)
    expected_prev = GENESIS_HASH
    required_keys = {"ts", "agent", "action", "details"}
    for idx, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict) or not required_keys.issubset(entry.keys()):
            fail(f"Structure d'entrée invalide à l'entrée #{idx} de audit_log.")
        prev_key = "prev_hash" if "prev_hash" in entry else ("previous_hash" if "previous_hash" in entry else None)
        hash_key = "hash" if "hash" in entry else ("entry_hash" if "entry_hash" in entry else None)
        if prev_key is None or hash_key is None:
            fail(f"Champs prev_hash/hash manquants à l'entrée #{idx}.")
        recorded_prev = entry.get(prev_key)
        recorded_hash = entry.get(hash_key)
        if recorded_prev != expected_prev:
            fail(f"Rupture de chaîne {prev_key} à l'entrée #{idx} (attendu {expected_prev[:16]}..., reçu {str(recorded_prev)[:16]}...).")
        core = {k: v for k, v in entry.items() if k not in {prev_key, hash_key}}
        recomputed = compute_entry_hash(core, expected_prev)
        if recorded_hash != recomputed:
            fail(f"Empreinte SHA-256 falsifiée à l'entrée #{idx} (attendu {recomputed[:16]}..., reçu {str(recorded_hash)[:16]}...).")
        expected_prev = recomputed

    computed_head = expected_prev

    # 3. Concordance stricte du bloc integrity (genesis_hash, head_hash, nb_entrees, state_sha256)
    exp_genesis = integrity.get("genesis_hash")
    if exp_genesis is not None and exp_genesis != GENESIS_HASH:
        fail(f"genesis_hash invalide dans integrity : {exp_genesis!r}")

    exp_head = integrity.get("head_hash")
    if not isinstance(exp_head, str) or exp_head != computed_head:
        fail(f"Discordance head_hash (déclaré={exp_head!r}, recalculé={computed_head!r}).")

    exp_nb = integrity.get("nb_entrees")
    if exp_nb != len(entries):
        fail(f"Discordance nb_entrees (déclaré={exp_nb!r}, réel={len(entries)}).")

    exp_state_sha = integrity.get("state_sha256")
    if not isinstance(exp_state_sha, str) or not HEX64_RE.match(exp_state_sha.strip()):
        fail("Empreinte integrity.state_sha256 absente ou malformée.")

    actual_state_sha = compute_portable_state_sha256(raw_state)
    if actual_state_sha != exp_state_sha.strip().lower():
        fail(f"État de session altéré : state_sha256 discordant (attendu {exp_state_sha.strip().lower()[:16]}..., recalculé {actual_state_sha[:16]}...).")

    # 4. Invariant défense en profondeur : tout mode validé requiert HUMAN_VALIDATION dans la chaîne
    results_by_mode = raw_state.get("results_by_mode")
    if isinstance(results_by_mode, dict):
        for mode_key in ("AVANT", "APRES"):
            slot = results_by_mode.get(mode_key)
            if isinstance(slot, dict) and bool(slot.get("validated")):
                has_proof = any(
                    e.get("action") == "HUMAN_VALIDATION"
                    and (
                        e.get("mode") in {None, mode_key}
                        or (isinstance(e.get("details"), dict) and e["details"].get("mode") == mode_key)
                    )
                    for e in entries
                )
                if not has_proof:
                    fail(f"Mode {mode_key} marqué validated=true sans preuve HUMAN_VALIDATION dans audit_log.")

    # 5. Vérification optionnelle du sceau émetteur HMAC-SHA256
    secret = ns.secret or os.environ.get("AUDIT_SIGNING_SECRET", "")
    raw_sig = (
        ns.signature
        or ns.positional_signature
        or os.environ.get("TRIAD_SIGNATURE", "")
        or os.environ.get("X_TRIAD_SIGNATURE", "")
    )
    sidecar = pathlib.Path(f"{snap_path}.sig")
    if not raw_sig and sidecar.is_file():
        raw_sig = sidecar.read_text("utf-8").strip()
    embedded_hmac = integrity.get("hmac_sha256")
    if not raw_sig and isinstance(embedded_hmac, str) and embedded_hmac.strip():
        raw_sig = embedded_hmac.strip()

    expected_sig = normalize_sig(raw_sig) if raw_sig else ""
    hmac_status = "UNSIGNED"

    if expected_sig:
        if not HEX64_RE.match(expected_sig):
            fail(f"Format de signature HMAC-SHA256 invalide : {raw_sig!r}")
        if not secret:
            fail("Signature HMAC fournie mais AUDIT_SIGNING_SECRET / --secret non renseigné.")
        computed_hmac = hmac.new(secret.encode("utf-8"), raw_bytes, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(computed_hmac, expected_sig):
            fail("Sceau HMAC-SHA256 invalide (signature_status=INVALID) : fichier ou clé discordant.")
        hmac_status = f"VERIFIED ({computed_hmac[:16]}...)"
    elif secret:
        if ns.require_signature:
            fail("Signature HMAC requise (--require-signature) mais absente.")
        computed_hmac = hmac.new(secret.encode("utf-8"), raw_bytes, hashlib.sha256).hexdigest()
        hmac_status = f"CALCULATED (hmac-sha256={computed_hmac[:16]}...)"
    elif ns.require_signature:
        fail("Signature HMAC requise (--require-signature) mais absente.")

    sid = snap.get("session_id") or raw_state.get("session_id") or "inconnu"
    print(f"OK: Chaîne SHA-256 intègre ({len(entries)} entrées, head={computed_head[:16]}...).")
    print(f"OK: Empreinte portable state_sha256 vérifiée ({actual_state_sha[:16]}...).")
    print(f"OK: Sceau émetteur HMAC-SHA256 : {hmac_status} (session={sid}).")
    print("=== SNAPSHOT DE SESSION TRIAD AUTHENTIFIÉ AVEC SUCCÈS ✓ ===")


if __name__ == "__main__":
    main()
PY
