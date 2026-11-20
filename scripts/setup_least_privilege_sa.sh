#!/usr/bin/env bash
# Crée le compte de service à moindre privilège « triad-auditor » (équivalent gcloud
# du bloc 3 de infra/terraform/main.tf). À lancer par un propriétaire du projet :
# l'attribution de rôles exige resourcemanager.projects.setIamPolicy.
# Idempotent. Ensuite, `make deploy` utilise automatiquement ce compte.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
SA_NAME="${SA_NAME:-triad-auditor}"
ROLE_ID="${ROLE_ID:-triadMetadataAuditor}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

[ -n "$PROJECT_ID" ] || { echo "PROJECT_ID manquant" >&2; exit 1; }
echo "Projet : $PROJECT_ID · compte : $SA_EMAIL"

if ! gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT_ID" \
    --display-name "TRIAD Auditor — lecture seule des métadonnées (NIS2)"
fi

PERMS="cloudkms.cryptoKeys.get,cloudkms.cryptoKeys.list,cloudkms.keyRings.list,cloudkms.locations.list,\
compute.firewalls.get,compute.firewalls.list,compute.networks.get,compute.networks.list,\
logging.buckets.get,logging.buckets.list,logging.sinks.get,logging.sinks.list,\
storage.buckets.get,storage.buckets.getIamPolicy,storage.buckets.list"

if gcloud iam roles describe "$ROLE_ID" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam roles update "$ROLE_ID" --project "$PROJECT_ID" --permissions "$PERMS" --quiet >/dev/null
else
  gcloud iam roles create "$ROLE_ID" --project "$PROJECT_ID" --stage GA \
    --title "TRIAD Metadata Auditor (Zero Object Access)" --permissions "$PERMS"
fi

for ROLE in "projects/${PROJECT_ID}/roles/${ROLE_ID}" roles/browser roles/iam.securityReviewer roles/aiplatform.user; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:${SA_EMAIL}" \
    --role "$ROLE" --condition None --quiet >/dev/null
  echo "OK : $ROLE"
done

echo "Terminé. Redéployez : ALLOW_UNAUTH=true make deploy && make deploy-check"
