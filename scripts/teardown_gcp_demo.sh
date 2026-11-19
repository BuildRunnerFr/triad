#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
SA_NAME="triad-auditor"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
ROLE_ID="triadMetadataAuditor"

if [[ -z "$PROJECT_ID" ]]; then
  echo "ERREUR: PROJECT_ID non défini."
  exit 1
fi

echo "=== Suppression infra démo TRIAD sur ${PROJECT_ID} ==="

gcloud compute firewall-rules delete allow-ssh-anywhere --project="$PROJECT_ID" --quiet 2>/dev/null || true

for suffix in export-radiologie backups-dpi archives-pacs; do
  gcloud storage rm -r "gs://${PROJECT_ID}-${suffix}" --project="$PROJECT_ID" --quiet 2>/dev/null || true
done

for role in "projects/${PROJECT_ID}/roles/${ROLE_ID}" "roles/compute.viewer" "roles/iam.securityReviewer"; do
  gcloud projects remove-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" --role="$role" --quiet >/dev/null 2>&1 || true
done

gcloud iam service-accounts delete "$SA_EMAIL" --project="$PROJECT_ID" --quiet 2>/dev/null || true
gcloud iam roles delete "$ROLE_ID" --project="$PROJECT_ID" --quiet 2>/dev/null || true

echo "=== Nettoyage terminé ==="
