#!/usr/bin/env bash
# ==============================================================================
# Vérificateur Forensique Indépendant — Dossier de Preuve Scellé NIS2 (.zip)
# 1. Extraction sécurisée (anti-ZipSlip) dans un répertoire éphémère
# 2. Contrôle rétrocompatible de l'inventaire réglementaire :
#    - v1 (6 pièces  : 01..06)
#    - v2 (8 pièces  : 01..08 avec ANSSI Art. 23 & Brief COMEX Art. 20)
#    - v3 (9 pièces  : 01..09 avec Manifeste GitOps 09_Remediation_GitOps.tf)
#    - v4 (10 pièces : 01..10 avec 10_Guide_Entretien_Contradictoire.md)
#    - v5 (11 pièces : 01..11 avec 11_Registre_Arbitrages_GRC.md)
#    - v6 (12 pièces : 01..12 avec 12_Evaluation_CNIL_RGPD_Art33.md)
# 3. Contrôle d'intégrité strict via `sha256sum -c MANIFEST_SHA256.txt` (+ HMAC)
# 4. Recalcul indépendant de la chaîne SHA-256 (`06_Audit_Chain.jsonl`) et
#    concordance avec `03_Synthese_Scellee.json`
# ==============================================================================
set -euo pipefail

if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "Usage: $0 <chemin/vers/TRIAD_Dossier_Preuve_NIS2.zip>"
  exit 1
fi

BUNDLE_PATH="$1"
if [[ ! -f "${BUNDLE_PATH}" ]]; then
  echo "ERREUR: Fichier introuvable : ${BUNDLE_PATH}"
  exit 1
fi

PYTHON_BIN="python3"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -x "${ROOT_DIR}/.venv/bin/python" ]]; then
  PYTHON_BIN="${ROOT_DIR}/.venv/bin/python"
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "=== Vérification forensique du Dossier de Preuve : $(basename "${BUNDLE_PATH}") ==="

# 1. Extraction sécurisée (protection stricte contre toute traversée de chemin ZipSlip)
"${PYTHON_BIN}" - "${BUNDLE_PATH}" "${WORK_DIR}" <<'PY'
import pathlib, sys, zipfile

bundle = pathlib.Path(sys.argv[1])
dest = pathlib.Path(sys.argv[2]).resolve()

with zipfile.ZipFile(bundle, "r") as zf:
    bad = zf.testzip()
    if bad is not None:
        raise SystemExit(f"ERREUR: Entrée ZIP corrompue : {bad}")
    for member in zf.infolist():
        target = (dest / member.filename).resolve()
        if dest not in target.parents and target != dest:
            raise SystemExit(f"ERREUR: Chemin ZIP suspect bloqué (ZipSlip) : {member.filename}")
    zf.extractall(dest)
print(f"OK: Archive ZIP intègre ({len(zf.namelist())} fichiers extraits).")
PY

# 2. Contrôle de présence de MANIFEST_SHA256.txt et inventaire rétrocompatible v1..v6
if [[ ! -f "${WORK_DIR}/MANIFEST_SHA256.txt" ]]; then
  echo "ERREUR: MANIFEST_SHA256.txt absent de l'archive !"
  exit 1
fi

"${PYTHON_BIN}" - "${WORK_DIR}" <<'PY'
import hashlib, hmac, os, pathlib, re, sys

work = pathlib.Path(sys.argv[1])
manifest_path = work / "MANIFEST_SHA256.txt"
manifest_text = manifest_path.read_text("utf-8")

v1_pieces = [
    "01_Rapport_NIS2.md",
    "02_Matrice_GRC.csv",
    "03_Synthese_Scellee.json",
    "04_Playbook_DryRun.sh",
    "05_Mail_DSI.txt",
    "06_Audit_Chain.jsonl",
]
v2_extra = [
    "07_PreNotification_ANSSI_Art23.md",
    "08_Brief_COMEX_Art20.md",
]
v3_extra = [
    "09_Remediation_GitOps.tf",
]
v4_extra = [
    "10_Guide_Entretien_Contradictoire.md",
]
v5_extra = [
    "11_Registre_Arbitrages_GRC.md",
]
v6_extra = [
    "12_Evaluation_CNIL_RGPD_Art33.md",
]

missing_base = [p for p in v1_pieces if not (work / p).is_file()]
if missing_base:
    raise SystemExit(f"ERREUR: Pièces socle v1 obligatoires manquantes dans l'archive : {missing_base}")

present_v2 = [p for p in v2_extra if (work / p).is_file()]
present_v3 = [p for p in v3_extra if (work / p).is_file()]
present_v4 = [p for p in v4_extra if (work / p).is_file()]
present_v5 = [p for p in v5_extra if (work / p).is_file()]
present_v6 = [p for p in v6_extra if (work / p).is_file()]

if (
    len(present_v2) == 0
    and len(present_v3) == 0
    and len(present_v4) == 0
    and len(present_v5) == 0
    and len(present_v6) == 0
):
    bundle_version = "v1"
    expected_pieces = v1_pieces
elif (
    len(present_v2) == len(v2_extra)
    and len(present_v3) == 0
    and len(present_v4) == 0
    and len(present_v5) == 0
    and len(present_v6) == 0
):
    bundle_version = "v2"
    expected_pieces = v1_pieces + v2_extra
elif (
    len(present_v2) == len(v2_extra)
    and len(present_v3) == len(v3_extra)
    and len(present_v4) == 0
    and len(present_v5) == 0
    and len(present_v6) == 0
):
    bundle_version = "v3"
    expected_pieces = v1_pieces + v2_extra + v3_extra
elif (
    len(present_v2) == len(v2_extra)
    and len(present_v3) == len(v3_extra)
    and len(present_v4) == len(v4_extra)
    and len(present_v5) == 0
    and len(present_v6) == 0
):
    bundle_version = "v4"
    expected_pieces = v1_pieces + v2_extra + v3_extra + v4_extra
elif (
    len(present_v2) == len(v2_extra)
    and len(present_v3) == len(v3_extra)
    and len(present_v4) == len(v4_extra)
    and len(present_v5) == len(v5_extra)
    and len(present_v6) == 0
):
    bundle_version = "v5"
    expected_pieces = v1_pieces + v2_extra + v3_extra + v4_extra + v5_extra
elif (
    len(present_v2) == len(v2_extra)
    and len(present_v3) == len(v3_extra)
    and len(present_v4) == len(v4_extra)
    and len(present_v5) == len(v5_extra)
    and len(present_v6) == len(v6_extra)
):
    bundle_version = "v6"
    expected_pieces = v1_pieces + v2_extra + v3_extra + v4_extra + v5_extra + v6_extra
else:
    found_opt = present_v2 + present_v3 + present_v4 + present_v5 + present_v6
    raise SystemExit(
        "ERREUR: Format d'archive incomplet — attendu v1 (6 pièces), v2 (8 pièces), "
        f"v3 (9 pièces), v4 (10 pièces), v5 (11 pièces) ou v6 (12 pièces), pièces optionnelles trouvées : {found_opt}"
    )

manifest_files = []
manifest_core_lines = []
hmac_seal = None
hmac_line_seen = False

for raw in manifest_text.splitlines():
    line = raw.strip()
    if not line:
        continue
    if line.startswith("#"):
        if re.match(r"^#\s*TRIAD-HMAC-SHA256:", line, flags=re.IGNORECASE):
            hmac_line_seen = True
            m = re.match(r"^#\s*TRIAD-HMAC-SHA256:\s*([0-9a-fA-F]{64})\s*$", line)
            if not m:
                raise SystemExit(f"ERREUR: Empreinte TRIAD-HMAC-SHA256 malformée : {raw!r}")
            hmac_seal = m.group(1).lower()
        continue
    parts = line.split(None, 1)
    if len(parts) != 2:
        raise SystemExit(f"ERREUR: Ligne MANIFEST_SHA256.txt invalide : {raw!r}")
    manifest_files.append(parts[1].lstrip("*").strip())
    manifest_core_lines.append(raw)

missing_in_manifest = [p for p in expected_pieces if p not in manifest_files]
if missing_in_manifest:
    raise SystemExit(f"ERREUR: Pièces absentes de MANIFEST_SHA256.txt : {missing_in_manifest}")

sig_file = work / "MANIFEST_HMAC.sig"
if hmac_seal is None and not hmac_line_seen and sig_file.is_file():
    hmac_seal = sig_file.read_text("utf-8").strip().lower()

secret = os.environ.get("AUDIT_SIGNING_SECRET", "")
if hmac_seal and secret and hmac_line_seen:
    manifest_core = "\n".join(manifest_core_lines) + "\n"
    expected_hmac = hmac.new(secret.encode("utf-8"), manifest_core.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_hmac, hmac_seal):
        raise SystemExit("ERREUR: Sceau HMAC-SHA256 du manifeste invalide (INVALID) !")
    seal_label = f"HMAC-SHA256 VERIFIED ({hmac_seal[:16]}...)"
elif hmac_seal:
    seal_label = f"HMAC-SHA256 présent ({hmac_seal[:16]}...)"
else:
    seal_label = "non signé (UNSIGNED)"

print(f"OK: Inventaire {bundle_version} conforme ({len(expected_pieces)} pièces probatoires couvertes, sceau: {seal_label}).")
PY

# 3. Vérification stricte des empreintes SHA-256 via sha256sum -c MANIFEST_SHA256.txt
(
  cd "${WORK_DIR}"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c MANIFEST_SHA256.txt
  elif command -v shasum >/dev/null 2>&1; then
    grep -v '^[[:space:]]*#' MANIFEST_SHA256.txt | shasum -a 256 -c -
  else
    "${PYTHON_BIN}" - <<'PY'
import hashlib, pathlib

for raw in pathlib.Path("MANIFEST_SHA256.txt").read_text("utf-8").splitlines():
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    expected, fname = line.split(None, 1)
    fname = fname.lstrip("*").strip()
    actual = hashlib.sha256(pathlib.Path(fname).read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f"ÉCHEC SHA-256 sur {fname}: attendu {expected}, obtenu {actual}")
    print(f"{fname}: OK")
PY
  fi
)

# 4. Recalcul cryptographique indépendant de la chaîne JSONL et concordance JSON scellé
"${PYTHON_BIN}" - "${WORK_DIR}" <<'PY'
import hashlib, json, pathlib, sys

work = pathlib.Path(sys.argv[1])
chain_file = work / "06_Audit_Chain.jsonl"
sealed_file = work / "03_Synthese_Scellee.json"

if chain_file.is_file() and sealed_file.is_file():
    prev = "0" * 64
    count = 0
    for idx, line in enumerate(chain_file.read_text("utf-8").splitlines(), 1):
        if not line.strip():
            continue
        entry = json.loads(line)
        recorded_hash = entry["hash"]
        assert entry["prev_hash"] == prev, f"Rupture prev_hash au bloc #{idx}"
        payload = {k: v for k, v in entry.items() if k not in {"prev_hash", "hash"}}
        canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        computed = hashlib.sha256((canonical + prev).encode("utf-8")).hexdigest()
        assert computed == recorded_hash, f"Empreinte falsifiée au bloc #{idx}"
        prev = recorded_hash
        count += 1

    sealed = json.loads(sealed_file.read_text("utf-8"))
    expected_head = sealed.get("integrity", {}).get("head_hash")
    if expected_head:
        assert prev == expected_head, f"head_hash discordant ({prev} != {expected_head})"
    print(f"OK: Chaîne cryptographique SHA-256 vérifiée ({count} blocs, head={prev[:16]}...).")
PY

echo "=== DOSSIER DE PREUVE NIS2 AUTHENTIFIÉ AVEC SUCCÈS ✓ ==="
