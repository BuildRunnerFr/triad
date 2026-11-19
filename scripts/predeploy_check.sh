#!/usr/bin/env bash
# ==============================================================================
# Contrôle pré-vol de sécurité & d'hygiène de déploiement — TRIAD
# Vérifie l'exclusion des secrets (.gitignore / .gcloudignore / Cloud Build)
# et l'absence de clés privées ou jetons codés en dur dans les sources.
# ==============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

echo "=== Contrôle pré-vol anti-fuite de secrets (TRIAD) ==="

# 1. Vérification des règles critiques dans .gitignore et .gcloudignore
REQUIRED_GITIGNORE=(".env" ".env.*" "*.json.key" "*credentials*.json" ".venv/" "logs/" "frontend/node_modules/")
for pattern in "${REQUIRED_GITIGNORE[@]}"; do
  if ! grep -Fqx "${pattern}" .gitignore; then
    echo "ERREUR: Motif obligatoire '${pattern}' manquant dans .gitignore"
    exit 1
  fi
done

REQUIRED_GCLOUDIGNORE=(".env" ".env.*" "*.json.key" "*credentials*.json" ".venv/" "logs/" "frontend/node_modules/" ".terraform/" "*.tfstate")
for pattern in "${REQUIRED_GCLOUDIGNORE[@]}"; do
  if ! grep -Fqx "${pattern}" .gcloudignore; then
    echo "ERREUR: Motif obligatoire '${pattern}' manquant dans .gcloudignore"
    exit 1
  fi
done
echo "OK: Règles d'exclusion .gitignore & .gcloudignore conformes."

# 2. Vérification du manifeste réel Cloud Build (si gcloud est disponible)
GCLOUD_BIN="$(command -v gcloud 2>/dev/null || true)"
if [[ -z "${GCLOUD_BIN}" && -x "/home/farouk/google-cloud-sdk/bin/gcloud" ]]; then
  GCLOUD_BIN="/home/farouk/google-cloud-sdk/bin/gcloud"
fi

if [[ -n "${GCLOUD_BIN}" ]]; then
  UPLOAD_LIST="$("${GCLOUD_BIN}" meta list-files-for-upload)"
  if printf '%s\n' "${UPLOAD_LIST}" | grep -Eq '(^|/)\.env($|\.)|\.tfstate|credentials.*\.json$|\.json\.key$|^logs/|^frontend/node_modules/|^\.venv/'; then
    echo "ERREUR: Fichier sensible ou artefact interdit détecté dans le payload Cloud Build !"
    exit 1
  fi
  if ! printf '%s\n' "${UPLOAD_LIST}" | grep -Eq '^frontend/src/'; then
    echo "ERREUR: frontend/src/ absent du payload Cloud Build !"
    exit 1
  fi
  echo "OK: Manifeste Cloud Build vérifié ($(printf '%s\n' "${UPLOAD_LIST}" | wc -l | tr -d ' ') fichiers sûrs)."
fi

# 3. Validation syntaxique des scripts shell d'exploitation et de vérification
for sh_file in scripts/*.sh; do
  bash -n "${sh_file}"
done
echo "OK: Syntaxe Bash validée sur scripts/*.sh."

# 4. Scan d'absence de clés privées ou secrets GCP codés en dur dans les sources
SCAN_PATHS=(src frontend/src infra/terraform Dockerfile cloudbuild.yaml .github/workflows Makefile run_demo.py)
SECRET_REGEX='-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]+'
if grep -RInE "${SECRET_REGEX}" "${SCAN_PATHS[@]}" >/dev/null 2>&1; then
  echo "ERREUR: Empreinte de clé privée ou jeton GCP détectée dans le code source !"
  exit 1
fi
echo "OK: Aucune clé privée ni jeton GCP codé en dur détecté."
