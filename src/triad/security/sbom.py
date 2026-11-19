"""Attestation logicielle SBOM CycloneDX 1.5 déterministe, calculée en mémoire et mise en cache."""

from __future__ import annotations

import base64
import binascii
import hashlib
import importlib.metadata
import json
import re
import threading
import tomllib
import uuid
from pathlib import Path
from typing import Any

DIST_DIR = Path(__file__).resolve().parents[1] / "web" / "dist"

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


def compute_runtime_cyclonedx_sbom_uncached(root: Path) -> dict[str, Any]:
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


def get_cached_runtime_sbom_bundle(
    repo_root: Path | None = None,
) -> tuple[dict[str, Any], bytes, str]:
    """Retourne depuis le cache mémoire (objet CycloneDX 1.5, octets JSON, ETag SHA-256) sans relire le disque."""
    root = (repo_root or Path(__file__).resolve().parents[3]).resolve()
    cache_key = str(root)
    with _SBOM_CACHE_LOCK:
        cached = _SBOM_MEMORY_CACHE.get(cache_key)
        if cached is not None:
            return cached

    sbom_obj = compute_runtime_cyclonedx_sbom_uncached(root)
    sbom_bytes = (json.dumps(sbom_obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    sbom_etag = f'"{hashlib.sha256(sbom_bytes).hexdigest()}"'
    bundle = (sbom_obj, sbom_bytes, sbom_etag)
    with _SBOM_CACHE_LOCK:
        _SBOM_MEMORY_CACHE[cache_key] = bundle
    return bundle


def build_runtime_cyclonedx_sbom(repo_root: Path | None = None) -> dict[str, Any]:
    """Retourne l'objet SBOM déterministe CycloneDX 1.5 mémorisé en cache mémoire."""
    return get_cached_runtime_sbom_bundle(repo_root=repo_root)[0]
