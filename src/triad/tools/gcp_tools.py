"""Outils Google Cloud en lecture seule (mode snapshot ou API réelles parallélisées)."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

from triad.config import DATA_DIR, get_settings

SENSITIVE_PORTS = {"22", "3389", "all"}
OVERPRIVILEGED_ROLES = {"roles/owner", "roles/editor"}
MAX_SA_KEY_AGE_DAYS = 90
MAX_KMS_ROTATION_DAYS = 90
MIN_AUDIT_LOG_RETENTION_DAYS = 365


def _load_snapshot() -> dict[str, Any]:
    path = DATA_DIR / "gcp_snapshot.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _get_authorized_session() -> Any:
    """Construit une session HTTP Google Cloud authentifiée en lecture seule."""
    import google.auth
    from google.auth.transport.requests import AuthorizedSession

    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform.read-only"]
    )
    return AuthorizedSession(credentials)


def gcp_check_public_buckets() -> list[dict[str, Any]]:
    """Lit l'IAM de chaque bucket et signale allUsers / allAuthenticatedUsers."""
    settings = get_settings()
    if settings.use_gcp_snapshot or not settings.project_id:
        return _load_snapshot().get("public_buckets", [])

    from google.cloud import storage

    client = storage.Client(project=settings.project_id)
    results: list[dict[str, Any]] = []
    for bucket in client.list_buckets():
        policy = bucket.get_iam_policy(requested_policy_version=3)
        public_members: list[str] = []
        bindings_list: list[dict[str, Any]] = []
        for binding in policy.bindings:
            members = list(binding.get("members", []))
            exposed = [m for m in members if m in {"allUsers", "allAuthenticatedUsers"}]
            if exposed:
                public_members.extend(exposed)
                bindings_list.append({"role": binding.get("role"), "members": exposed})
        results.append(
            {
                "bucket": f"gs://{bucket.name}",
                "location": bucket.location,
                "public": bool(public_members),
                "public_members": sorted(set(public_members)),
                "bindings": bindings_list,
            }
        )
    return results


def _ports_are_sensitive(allowed_entry: dict[str, Any]) -> list[str]:
    protocol = str(allowed_entry.get("IPProtocol", "")).lower()
    ports = [str(p) for p in allowed_entry.get("ports", [])]
    if protocol == "all" or not ports:
        return ["all"]
    exposed: list[str] = []
    for port in ports:
        if port in SENSITIVE_PORTS:
            exposed.append(port)
        elif "-" in port:
            try:
                start_s, end_s = port.split("-", 1)
                start_p, end_p = int(start_s), int(end_s)
                if start_p <= 22 <= end_p:
                    exposed.append("22")
                if start_p <= 3389 <= end_p:
                    exposed.append("3389")
            except ValueError:
                continue
    return exposed


def gcp_check_open_firewall() -> list[dict[str, Any]]:
    """Signale les règles pare-feu ingress 0.0.0.0/0 sur les ports 22, 3389 ou all."""
    settings = get_settings()
    if settings.use_gcp_snapshot or not settings.project_id:
        return _load_snapshot().get("open_firewall", [])

    from google.cloud import compute_v1

    client = compute_v1.FirewallsClient()
    results: list[dict[str, Any]] = []
    for fw in client.list(project=settings.project_id):
        if fw.disabled or fw.direction != "INGRESS":
            continue
        source_ranges = list(fw.source_ranges or [])
        if "0.0.0.0/0" not in source_ranges:
            continue
        allowed_dicts = [
            {"IPProtocol": a.I_p_protocol, "ports": list(a.ports or [])}
            for a in (fw.allowed or [])
        ]
        exposed: list[str] = []
        for entry in allowed_dicts:
            exposed.extend(_ports_are_sensitive(entry))
        if exposed:
            results.append(
                {
                    "name": fw.name,
                    "network": (fw.network or "").split("/")[-1],
                    "direction": fw.direction,
                    "priority": fw.priority,
                    "source_ranges": source_ranges,
                    "allowed": allowed_dicts,
                    "exposed_sensitive_ports": sorted(set(exposed)),
                    "non_conforme": True,
                }
            )
    return results


def gcp_check_backup_protection() -> list[dict[str, Any]]:
    """Vérifie versioning et politique de rétention des buckets backup/archive."""
    settings = get_settings()
    if settings.use_gcp_snapshot or not settings.project_id:
        return _load_snapshot().get("backup_protection", [])

    from google.cloud import storage

    client = storage.Client(project=settings.project_id)
    results: list[dict[str, Any]] = []
    for bucket in client.list_buckets():
        name_lower = bucket.name.lower()
        if "backup" not in name_lower and "archive" not in name_lower:
            continue
        bucket.reload()
        versioning = bool(bucket.versioning_enabled)
        retention_sec = bucket.retention_period
        retention_locked = bool(bucket.retention_policy_locked)
        protege = versioning and (retention_sec is not None and retention_sec > 0)
        results.append(
            {
                "bucket": f"gs://{bucket.name}",
                "versioning_enabled": versioning,
                "retention_policy_seconds": retention_sec,
                "retention_locked": retention_locked,
                "protege": protege,
            }
        )
    return results


def gcp_check_iam_privileges() -> dict[str, Any]:
    """Détecte les rôles primitifs excessifs (owner/editor) et clés SA non tournées (NIS2 Art. 21 §2 i/j)."""
    settings = get_settings()
    if settings.use_gcp_snapshot or not settings.project_id:
        return _load_snapshot().get(
            "iam_privileges",
            {
                "overprivileged_bindings": [],
                "stale_service_account_keys": [],
                "non_conforme": False,
            },
        )

    session = _get_authorized_session()
    project_id = settings.project_id
    overprivileged: list[dict[str, Any]] = []
    stale_keys: list[dict[str, Any]] = []

    crm_url = f"https://cloudresourcemanager.googleapis.com/v1/projects/{project_id}:getIamPolicy"
    crm_resp = session.post(
        crm_url,
        json={"options": {"requestedPolicyVersion": 3}},
        timeout=15,
    )
    if crm_resp.ok:
        policy = crm_resp.json()
        for binding in policy.get("bindings", []):
            role = str(binding.get("role", ""))
            if role in OVERPRIVILEGED_ROLES:
                for member in binding.get("members", []):
                    overprivileged.append(
                        {
                            "role": role,
                            "member": member,
                            "non_conforme": True,
                            "raison": f"Rôle primitif excessif ({role}) accordé sur le projet",
                        }
                    )

    sa_url = f"https://iam.googleapis.com/v1/projects/{project_id}/serviceAccounts"
    sa_resp = session.get(sa_url, timeout=15)
    if sa_resp.ok:
        now_utc = datetime.now(timezone.utc)
        for sa in sa_resp.json().get("accounts", []):
            email = sa.get("email")
            if not email:
                continue
            keys_url = (
                f"https://iam.googleapis.com/v1/projects/{project_id}"
                f"/serviceAccounts/{email}/keys?keyTypes=USER_MANAGED"
            )
            keys_resp = session.get(keys_url, timeout=15)
            if not keys_resp.ok:
                continue
            for key in keys_resp.json().get("keys", []):
                valid_after = key.get("validAfterTime")
                if not valid_after:
                    continue
                try:
                    created_dt = datetime.fromisoformat(
                        str(valid_after).replace("Z", "+00:00")
                    )
                    age_days = max(0, (now_utc - created_dt).days)
                except ValueError:
                    continue
                if age_days > MAX_SA_KEY_AGE_DAYS:
                    key_id = str(key.get("name", "")).rsplit("/", 1)[-1]
                    stale_keys.append(
                        {
                            "service_account": email,
                            "key_id": key_id,
                            "key_type": key.get("keyType", "USER_MANAGED"),
                            "age_days": age_days,
                            "max_age_days": MAX_SA_KEY_AGE_DAYS,
                            "non_conforme": True,
                        }
                    )

    return {
        "overprivileged_bindings": overprivileged,
        "stale_service_account_keys": stale_keys,
        "non_conforme": bool(overprivileged or stale_keys),
    }


def gcp_check_kms_and_logging() -> dict[str, Any]:
    """Vérifie la rotation des clés Cloud KMS et la rétention Cloud Audit Logs (NIS2 Art. 21 §2 h & Art. 23)."""
    settings = get_settings()
    if settings.use_gcp_snapshot or not settings.project_id:
        return _load_snapshot().get(
            "kms_and_logging",
            {
                "kms_keys": [],
                "audit_log_buckets": [],
                "non_conforme": False,
            },
        )

    session = _get_authorized_session()
    project_id = settings.project_id
    kms_keys: list[dict[str, Any]] = []
    audit_log_buckets: list[dict[str, Any]] = []

    locations = list(
        dict.fromkeys(["europe-west9", settings.vertex_location or "europe-west9", "global"])
    )
    for loc in locations:
        kr_url = (
            f"https://cloudkms.googleapis.com/v1/projects/{project_id}"
            f"/locations/{loc}/keyRings"
        )
        kr_resp = session.get(kr_url, timeout=15)
        if not kr_resp.ok:
            continue
        for kr in kr_resp.json().get("keyRings", []):
            kr_name = kr.get("name")
            if not kr_name:
                continue
            ck_url = f"https://cloudkms.googleapis.com/v1/{kr_name}/cryptoKeys"
            ck_resp = session.get(ck_url, timeout=15)
            if not ck_resp.ok:
                continue
            for ck in ck_resp.json().get("cryptoKeys", []):
                purpose = str(ck.get("purpose", "ENCRYPT_DECRYPT"))
                rp_raw = ck.get("rotationPeriod")
                if rp_raw and str(rp_raw).endswith("s"):
                    try:
                        rot_days: int | None = round(float(str(rp_raw)[:-1]) / 86400)
                    except ValueError:
                        rot_days = None
                else:
                    rot_days = None
                rot_enabled = rot_days is not None
                non_conforme = (
                    purpose == "ENCRYPT_DECRYPT"
                    and (rot_days is None or rot_days > MAX_KMS_ROTATION_DAYS)
                )
                kms_keys.append(
                    {
                        "name": ck.get("name", ""),
                        "purpose": purpose,
                        "rotation_period_days": rot_days,
                        "rotation_enabled": rot_enabled,
                        "non_conforme": non_conforme,
                    }
                )

    data_access_logs_enabled = False
    crm_url = f"https://cloudresourcemanager.googleapis.com/v1/projects/{project_id}:getIamPolicy"
    crm_resp = session.post(
        crm_url,
        json={"options": {"requestedPolicyVersion": 3}},
        timeout=15,
    )
    if crm_resp.ok:
        for ac in crm_resp.json().get("auditConfigs", []):
            for alc in ac.get("auditLogConfigs", []):
                if alc.get("logType") in {"DATA_READ", "DATA_WRITE"}:
                    data_access_logs_enabled = True
                    break

    log_url = f"https://logging.googleapis.com/v2/projects/{project_id}/locations/-/buckets"
    log_resp = session.get(log_url, timeout=15)
    if log_resp.ok:
        for b in log_resp.json().get("buckets", []):
            bucket_name = str(b.get("name", ""))
            if bucket_name.endswith("/_Required"):
                continue
            retention_days = int(b.get("retentionDays", 30))
            locked = bool(b.get("locked", False))
            non_conforme = (
                retention_days < MIN_AUDIT_LOG_RETENTION_DAYS
                or not data_access_logs_enabled
            )
            audit_log_buckets.append(
                {
                    "bucket": bucket_name,
                    "retention_days": retention_days,
                    "required_retention_days": MIN_AUDIT_LOG_RETENTION_DAYS,
                    "locked": locked,
                    "data_access_logs_enabled": data_access_logs_enabled,
                    "non_conforme": non_conforme,
                }
            )

    has_nc = any(k["non_conforme"] for k in kms_keys) or any(
        b["non_conforme"] for b in audit_log_buckets
    )
    return {
        "kms_keys": kms_keys,
        "audit_log_buckets": audit_log_buckets,
        "non_conforme": has_nc,
    }


def gcp_run_all_checks() -> dict[str, Any]:
    """Exécute en parallèle les 5 vérifications GCP lecture seule."""
    with ThreadPoolExecutor(max_workers=5) as executor:
        fut_buckets = executor.submit(gcp_check_public_buckets)
        fut_fw = executor.submit(gcp_check_open_firewall)
        fut_backups = executor.submit(gcp_check_backup_protection)
        fut_iam = executor.submit(gcp_check_iam_privileges)
        fut_kms_log = executor.submit(gcp_check_kms_and_logging)
        return {
            "public_buckets": fut_buckets.result(),
            "open_firewall": fut_fw.result(),
            "backup_protection": fut_backups.result(),
            "iam_privileges": fut_iam.result(),
            "kms_and_logging": fut_kms_log.result(),
        }
