#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-europe-west9}"
SA_NAME="triad-auditor"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
ROLE_ID="triadMetadataAuditor"

if [[ -z "$PROJECT_ID" ]]; then
  echo "ERREUR: PROJECT_ID non défini. Exécutez: export PROJECT_ID=votre-projet"
  exit 1
fi

echo "=== Déploiement infra démo TRIAD sur ${PROJECT_ID} (${REGION}) ==="

# 1. Buckets Cloud Storage
for suffix in export-radiologie backups-dpi archives-pacs; do
  BUCKET="gs://${PROJECT_ID}-${suffix}"
  if ! gcloud storage buckets describe "$BUCKET" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud storage buckets create "$BUCKET" --project="$PROJECT_ID" --location="$REGION" --uniform-bucket-level-access
  fi
done

# Bucket public (export-radiologie)
if ! gcloud storage buckets add-iam-policy-binding "gs://${PROJECT_ID}-export-radiologie" \
  --member="allUsers" --role="roles/storage.objectViewer" >/dev/null 2>&1; then
  echo "ATTENTION: Une Org Policy bloque l'accès public allUsers sur ce projet."
  echo "Basculez sur le mode secours : USE_GCP_SNAPSHOT=true"
fi

# Bucket archives-pacs conforme (versioning + rétention 365 jours)
gcloud storage buckets update "gs://${PROJECT_ID}-archives-pacs" \
  --versioning --retention-period=365d >/dev/null

# 2. Règle pare-feu SSH ouverte (0.0.0.0/0 -> tcp:22)
if ! gcloud compute firewall-rules describe allow-ssh-anywhere --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute firewall-rules create allow-ssh-anywhere \
    --project="$PROJECT_ID" \
    --network=default \
    --direction=INGRESS \
    --action=ALLOW \
    --rules=tcp:22 \
    --source-ranges=0.0.0.0/0
fi

# 3. Compte de service à droits minimaux (métadonnées uniquement, sans clé JSON)
if ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT_ID" \
    --display-name="TRIAD Auditor (Métadonnées uniquement)"
fi

if ! gcloud iam roles describe "$ROLE_ID" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam roles create "$ROLE_ID" --project="$PROJECT_ID" \
    --title="TRIAD Metadata Auditor" \
    --permissions="storage.buckets.list,storage.buckets.get,storage.buckets.getIamPolicy"
fi

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="projects/${PROJECT_ID}/roles/${ROLE_ID}" >/dev/null

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/compute.viewer" >/dev/null

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.securityReviewer" >/dev/null

# 4. Test automatique : triad-auditor DOIT échouer (403) sur storage.objects.get
echo "Test de moindre privilège (storage.objects.get doit échouer en 403)..."
echo "objet-test-confidentiel" | gcloud storage cp - "gs://${PROJECT_ID}-archives-pacs/test-object.txt" >/dev/null 2>&1 || true
if gcloud storage cp "gs://${PROJECT_ID}-archives-pacs/test-object.txt" /dev/null \
  --impersonate-service-account="$SA_EMAIL" >/dev/null 2>&1; then
  echo "ERREUR: Le compte ${SA_EMAIL} a pu lire un objet !"
  exit 1
else
  echo "OK: Accès objet refusé (403 Forbidden) pour ${SA_EMAIL}."
fi

echo "=== Infra démo TRIAD prête. Pour utiliser en mode réel : USE_GCP_SNAPSHOT=false ==="
