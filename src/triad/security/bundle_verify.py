"""Spécification (v1..v6) et vérification forensique hors-ligne des Dossiers de Preuve ZIP scellés."""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from triad.security.audit_log import (
    GENESIS_HASH,
)

MAX_BUNDLE_UNCOMPRESSED_BYTES = 50 * 1024 * 1024  # 50 Mo (protection ZipBomb)


MAX_BUNDLE_MEMBERS = 64


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


def compute_hmac_sha256_hex(payload: bytes, secret: str) -> str:
    """Calcule la signature HMAC-SHA256 hexadécimale d'une charge utile binaire."""
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$", flags=re.IGNORECASE)


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


def verify_evidence_bundle_bytes(raw_bytes: bytes, filename: str, signing_secret: str = "") -> dict[str, Any]:
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
                    if not SHA256_HEX_RE.match(exp_hash):
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
        elif not SHA256_HEX_RE.match(claimed_hmac):
            signature_status = "INVALID"
            signature_hmac = None
            errors.append("Sceau d'authenticité HMAC-SHA256 malformé dans MANIFEST_SHA256.txt.")
        else:
            signature_hmac = claimed_hmac.lower()
            if not signing_secret:
                signature_status = "INVALID"
                errors.append(
                    "Sceau HMAC-SHA256 présent dans l'archive mais aucun secret AUDIT_SIGNING_SECRET n'est configuré."
                )
            else:
                manifest_core = ("\n".join(manifest_data_lines) + "\n") if manifest_data_lines else ""
                expected_hmac = compute_hmac_sha256_hex(
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
