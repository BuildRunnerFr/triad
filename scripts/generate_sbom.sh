#!/usr/bin/env bash
# ==============================================================================
# Générateur & Validateur Reproductible SBOM CycloneDX 1.5 — TRIAD (NIS2 Art. 21 §2 d)
# Sources souveraines : pyproject.toml (Python) & frontend/package-lock.json (npm)
# Modes :
#   --check            Génère en mémoire/tmpfs, vérifie le schéma CycloneDX 1.5 et
#                      la reproductibilité déterministe SHA-256 sans polluer le dépôt
#   --output <fichier> Écrit le SBOM CycloneDX 1.5 JSON validé à l'emplacement choisi
#   --stdout           Émet uniquement le JSON CycloneDX 1.5 sur la sortie standard
# ==============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="python3"
if [[ -x "${ROOT_DIR}/.venv/bin/python" ]]; then
  PYTHON_BIN="${ROOT_DIR}/.venv/bin/python"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi

MODE="check"
OUT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      MODE="check"
      shift
      ;;
    --stdout)
      MODE="stdout"
      shift
      ;;
    --output|-o)
      [[ $# -ge 2 ]] || { echo "ERREUR: --output requiert un chemin de fichier." >&2; exit 1; }
      MODE="output"
      OUT_PATH="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      MODE="output"
      OUT_PATH="$1"
      shift
      ;;
  esac
done

exec "${PYTHON_BIN}" - "${ROOT_DIR}" "${MODE}" "${OUT_PATH}" <<'PY'
import base64
import binascii
import hashlib
import json
import pathlib
import re
import sys
import tempfile
import tomllib
import uuid

ROOT = pathlib.Path(sys.argv[1]).resolve()
MODE = sys.argv[2]
OUT_ARG = sys.argv[3]

PYPROJECT_PATH = ROOT / "pyproject.toml"
NPMLOCK_PATH = ROOT / "frontend" / "package-lock.json"

if not PYPROJECT_PATH.is_file():
    raise SystemExit(f"ERREUR: Fichier introuvable : {PYPROJECT_PATH}")
if not NPMLOCK_PATH.is_file():
    raise SystemExit(f"ERREUR: Fichier introuvable : {NPMLOCK_PATH}")

REQ_RE = re.compile(r"^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(?:(?:>=|==|~=|>|<|<=)\s*([0-9A-Za-z_.-]+))?")
UUID_URN_RE = re.compile(r"^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def normalize_pypi_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name.strip()).lower()


def npm_purl(pkg_name: str, version: str) -> str:
    if pkg_name.startswith("@") and "/" in pkg_name:
        scope, short = pkg_name.split("/", 1)
        return f"pkg:npm/%40{scope[1:]}/{short}@{version}"
    return f"pkg:npm/{pkg_name}@{version}"


def npm_pkg_name_from_lock_key(key: str, meta: dict) -> str:
    explicit = meta.get("name")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    marker = "node_modules/"
    idx = key.rfind(marker)
    return key[idx + len(marker):] if idx >= 0 else key


def sri_to_cyclonedx_hashes(integrity: str) -> list[dict]:
    hashes = []
    for token in integrity.split():
        if "-" not in token:
            continue
        alg_raw, b64_val = token.split("-", 1)
        alg_map = {"sha512": "SHA-512", "sha384": "SHA-384", "sha256": "SHA-256", "sha1": "SHA-1"}
        cdx_alg = alg_map.get(alg_raw.lower())
        if not cdx_alg:
            continue
        try:
            raw = base64.b64decode(b64_val)
            hashes.append({"alg": cdx_alg, "content": binascii.hexlify(raw).decode("ascii")})
        except Exception:
            continue
    return hashes


def build_sbom() -> tuple[dict, dict]:
    pyproject_bytes = PYPROJECT_PATH.read_bytes()
    npmlock_bytes = NPMLOCK_PATH.read_bytes()
    py_sha = hashlib.sha256(pyproject_bytes).hexdigest()
    npm_sha = hashlib.sha256(npmlock_bytes).hexdigest()

    py_data = tomllib.loads(pyproject_bytes.decode("utf-8"))
    npm_data = json.loads(npmlock_bytes.decode("utf-8"))

    proj = py_data.get("project", {})
    app_name = str(proj.get("name", "triad"))
    app_version = str(proj.get("version", "0.1.0"))
    app_desc = str(proj.get("description", ""))
    app_ref = f"pkg:generic/{app_name}@{app_version}"

    serial_uuid = uuid.uuid5(uuid.NAMESPACE_URL, f"https://triad.cyber.deloitte.fr/sbom/{py_sha}/{npm_sha}")

    components_by_ref: dict[str, dict] = {}
    deps_by_ref: dict[str, set[str]] = {app_ref: set()}

    py_runtime_count = 0
    py_dev_count = 0

    def add_py_dep(spec: str, scope: str) -> None:
        nonlocal py_runtime_count, py_dev_count
        m = REQ_RE.match(spec.strip())
        if not m:
            return
        norm_name = normalize_pypi_name(m.group(1))
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
            if scope == "required":
                py_runtime_count += 1
            else:
                py_dev_count += 1
        elif scope == "required":
            components_by_ref[purl]["scope"] = "required"
        deps_by_ref[app_ref].add(purl)
        deps_by_ref.setdefault(purl, set())

    for spec in proj.get("dependencies", []):
        if isinstance(spec, str):
            add_py_dep(spec, "required")

    for group_specs in proj.get("optional-dependencies", {}).values():
        if isinstance(group_specs, list):
            for spec in group_specs:
                if isinstance(spec, str):
                    add_py_dep(spec, "optional")

    packages = npm_data.get("packages", {})
    root_pkg = packages.get("", {}) if isinstance(packages, dict) else {}
    fe_name = str(root_pkg.get("name") or npm_data.get("name") or "triad-frontend")
    fe_ver = str(root_pkg.get("version") or npm_data.get("version") or "0.1.0")
    fe_ref = npm_purl(fe_name, fe_ver)
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
    npm_count = 0

    if isinstance(packages, dict):
        for lock_key in sorted(packages.keys()):
            if not lock_key:
                continue
            meta = packages[lock_key]
            if not isinstance(meta, dict):
                continue
            pkg_name = npm_pkg_name_from_lock_key(lock_key, meta)
            pkg_ver = str(meta.get("version") or "").strip()
            if not pkg_name or not pkg_ver:
                continue
            purl = npm_purl(pkg_name, pkg_ver)
            is_dev = bool(meta.get("dev", False))
            scope = "optional" if is_dev else "required"

            if lock_key == f"node_modules/{pkg_name}" or pkg_name not in npm_name_to_primary_ref:
                npm_name_to_primary_ref[pkg_name] = purl

            if purl in components_by_ref:
                if scope == "required":
                    components_by_ref[purl]["scope"] = "required"
                continue

            comp: dict = {
                "bom-ref": purl,
                "type": "library",
                "name": pkg_name,
                "version": pkg_ver,
                "scope": scope,
                "purl": purl,
            }
            integrity = meta.get("integrity")
            if isinstance(integrity, str) and integrity.strip():
                hashes = sri_to_cyclonedx_hashes(integrity.strip())
                if hashes:
                    comp["hashes"] = hashes
            lic = meta.get("license")
            if isinstance(lic, str) and lic.strip():
                comp["licenses"] = [{"license": {"name": lic.strip()}}]
            components_by_ref[purl] = comp
            deps_by_ref.setdefault(purl, set())
            npm_count += 1

        # Résolution déterministe des arêtes de dépendances npm
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
            pkg_name = npm_pkg_name_from_lock_key(lock_key, meta)
            pkg_ver = str(meta.get("version") or "").strip()
            if not pkg_name or not pkg_ver:
                continue
            src_ref = npm_purl(pkg_name, pkg_ver)
            sub_deps = meta.get("dependencies", {})
            if isinstance(sub_deps, dict):
                for child_name in sorted(sub_deps.keys()):
                    nested_key = f"{lock_key}/node_modules/{child_name}"
                    nested_meta = packages.get(nested_key)
                    if isinstance(nested_meta, dict) and nested_meta.get("version"):
                        target_ref = npm_purl(child_name, str(nested_meta["version"]).strip())
                    else:
                        target_ref = npm_name_to_primary_ref.get(child_name, "")
                    if target_ref and target_ref in components_by_ref and target_ref != src_ref:
                        deps_by_ref[src_ref].add(target_ref)

    sorted_components = [components_by_ref[k] for k in sorted(components_by_ref.keys())]
    sorted_dependencies = [
        {"ref": ref_key, "dependsOn": sorted(deps_by_ref[ref_key])}
        for ref_key in sorted(deps_by_ref.keys())
    ]

    license_text = "Proprietary"
    if isinstance(proj.get("license"), dict) and proj["license"].get("text"):
        license_text = str(proj["license"]["text"])

    sbom = {
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
    stats = {
        "total_components": len(sorted_components),
        "pypi_runtime": py_runtime_count,
        "pypi_dev": py_dev_count,
        "npm_packages": npm_count,
    }
    return sbom, stats


def validate_cyclonedx_15(sbom: dict) -> None:
    assert sbom.get("bomFormat") == "CycloneDX", "bomFormat != CycloneDX"
    assert sbom.get("specVersion") == "1.5", "specVersion != 1.5"
    serial = str(sbom.get("serialNumber", ""))
    assert UUID_URN_RE.match(serial), f"serialNumber URN UUIDv5 invalide: {serial}"
    assert sbom.get("version") == 1, "version != 1"

    meta = sbom.get("metadata", {})
    root_comp = meta.get("component", {})
    root_ref = root_comp.get("bom-ref")
    assert isinstance(root_ref, str) and root_ref, "metadata.component.bom-ref manquant"

    comps = sbom.get("components")
    assert isinstance(comps, list) and len(comps) >= 20, "Liste components trop courte ou invalide"

    seen_refs: set[str] = {root_ref}
    pypi_seen = 0
    npm_seen = 0
    hashed_npm = 0

    for c in comps:
        ref = c.get("bom-ref")
        assert isinstance(ref, str) and ref, f"bom-ref manquant: {c}"
        assert ref not in seen_refs, f"bom-ref dupliqué interdit en CycloneDX 1.5: {ref}"
        seen_refs.add(ref)
        assert c.get("type") in {"library", "application", "framework"}, f"type invalide: {c.get('type')}"
        purl = str(c.get("purl", ""))
        assert purl.startswith("pkg:"), f"purl invalide: {purl}"
        if purl.startswith("pkg:pypi/"):
            pypi_seen += 1
        elif purl.startswith("pkg:npm/"):
            npm_seen += 1
            if c.get("hashes"):
                hashed_npm += 1

    assert pypi_seen >= 10, f"Composants PyPI insuffisants ({pypi_seen})"
    assert npm_seen >= 10, f"Composants npm insuffisants ({npm_seen})"
    assert hashed_npm >= 10, f"Empreintes SHA-512 npm manquantes ({hashed_npm})"

    deps = sbom.get("dependencies")
    assert isinstance(deps, list) and len(deps) == len(seen_refs), "Graphe dependencies incomplet"
    for d in deps:
        assert d.get("ref") in seen_refs, f"Référence dépendance inconnue: {d.get('ref')}"
        for child in d.get("dependsOn", []):
            assert child in seen_refs, f"Cible dependsOn inconnue: {child}"


sbom_doc, stats = build_sbom()
validate_cyclonedx_15(sbom_doc)
serialized_1 = (json.dumps(sbom_doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8")

if MODE == "stdout":
    sys.stdout.buffer.write(serialized_1)
elif MODE == "output":
    out_file = pathlib.Path(OUT_ARG)
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_bytes(serialized_1)
    sha = hashlib.sha256(serialized_1).hexdigest()
    print(
        f"OK: SBOM CycloneDX 1.5 écrit dans {out_file} "
        f"({stats['total_components']} composants : {stats['pypi_runtime']}+{stats['pypi_dev']} PyPI, "
        f"{stats['npm_packages']} npm, sha256={sha[:16]}...)."
    )
else:
    # Mode --check : génération éphémère double sans fichier résiduel dans le dépôt
    sbom_doc_2, _ = build_sbom()
    serialized_2 = (json.dumps(sbom_doc_2, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    sha1 = hashlib.sha256(serialized_1).hexdigest()
    sha2 = hashlib.sha256(serialized_2).hexdigest()
    assert sha1 == sha2, f"SBOM non déterministe ({sha1} != {sha2})"
    with tempfile.TemporaryDirectory() as td:
        tmp_sbom = pathlib.Path(td) / "triad.cdx.json"
        tmp_sbom.write_bytes(serialized_1)
        reloaded = json.loads(tmp_sbom.read_text("utf-8"))
        validate_cyclonedx_15(reloaded)
    print(
        f"OK: SBOM CycloneDX 1.5 valide et déterministe "
        f"({stats['total_components']} composants : {stats['pypi_runtime']} PyPI runtime, "
        f"{stats['pypi_dev']} PyPI dev, {stats['npm_packages']} npm, sha256={sha1[:16]}...)."
    )
PY
