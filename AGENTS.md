# Guide pour Agents IA — TRIAD (Hackathon Deloitte × Google Cloud)

Ce dépôt contient **TRIAD**, une plateforme d'audit de conformité **NIS2** propulsée par **Google Cloud Vertex AI & ADK**, conçue dans le cadre du **Hackathon Deloitte × Google Cloud**.

## Contexte Métier & Architecture Applicative
- **Scénario de démonstration (`data/`)** : Audit NIS2 du Centre Hospitalier de Valmont en deux phases comparatives (`AVANT` / `APRÈS` entretiens contradictoires), croisant le **Dit** (`notes_entretien_DSI.md`), l'**Écrit** (`PSSI_CH_Valmont.md`, `PV_test_restauration.md`, `annexe_fournisseur_maintenance.md`) et le **Réel** (`gcp_snapshot.json` / sondes GCP lecture seule).
- **Pipeline ADK 4 agents (`src/triad/agents/`)** :
  1. `douanier.py` : contrôle documentaire, détection d'injection de prompt et masquage PII/DLP.
  2. `garde_du_corps.py` : 5 sondes GCP strictement en **lecture seule** (`storage`, `firewall`, `backup`, `iam_privileges`, `kms_and_logging`).
  3. `analyste.py` : croisement NIS2 Art. 21 & 23, matrices de couverture, risque tiers (Art. 21 §2 d), continuité RTO/RPO (Art. 21 §2 c) et correspondance HDS / ISO 27001 / RGPD.
  4. `contre_auditeur.py` : contre-audit critique, vérification des citations exactes et cohérence `AVANT` / `APRÈS`.
- **12 Livrables sous verrou humain `HTTP 403` (`src/triad/api/app.py`)** : `report`, `mail`, `json`, `playbook`, `csv`, `bundle` (archive `.zip` v6 à 12 pièces + `MANIFEST_SHA256.txt`), `anssi-draft` (Art. 23), `comex-brief` (Art. 20), `terraform` (GitOps `.tf`), `interview-guide`, `risk-register` (GRC) et `cnil-draft` (RGPD Art. 33/34). Débloqués uniquement après `POST /api/validate` (et re-verrouillés si un arbitrage GRC est modifié via `PATCH /api/findings/{id}/decision`).

## Structure du Dépôt
- `src/triad/` : Backend FastAPI, agents ADK (`agents/`), outils (`tools/`).
  - `api/app.py` : routes HTTP fines (sessions, verrou 403, signatures `X-Triad-Signature`, ETag) ; `api/session_store.py` (persistance disque) ; `api/observability.py` (rate-limit, métriques, rendu Prometheus).
  - `reporting/` : calculs **purs** sans état HTTP — `renderers.py` (rendu des 12 livrables), `scoring.py` (score NIS2 & simulation de remédiation), `nis2_views.py` (vues supply-chain Art. 21 §2 d, continuité §2 c, crosswalk HDS/ISO/RGPD).
  - `security/` : chaîne SHA-256 & logs structurés, `bundle_verify.py` (spécification v1..v6 + vérification forensique ZIP, secret HMAC injecté en paramètre), `sbom.py` (CycloneDX 1.5 en cache mémoire).
  - Convention : les modules `reporting/` et `security/bundle_verify.py` n'appellent jamais `get_settings()` ; `app.py` leur passe les valeurs (les tests patchent `triad.api.app.get_settings`).
- `frontend/` : React 19 + TypeScript + Vite + Tailwind CSS + Three.js WebGL (mode Deloitte `#86BC25` × `#07090F`, 100 % français, code-splitting `React.lazy`, bascule Densité `Confort`/`Compact`). Build dans `src/triad/web/dist/`.
  - Mouvement : GSAP (`src/motion/gsap.ts`, jetons `DURATION`/`EASE_OUT`), Lenis (`src/motion/SmoothScroll.tsx`, chargé en différé, désactivé en `prefers-reduced-motion`, ignoré dans les conteneurs `overflow-*`). Les deux vivent dans le chunk `vendor-gsap` (hors budget `index-*.js`).
  - React Bits (MIT + Commons Clause, usage applicatif) vendorisé dans `src/components/reactbits/` (`CountUp`, `DecryptedText`, `SpotlightCard`, imports `framer-motion`).
  - Validation : plus de signature en un clic. `ValidationSeal.tsx` impose une attestation (récapitulatif + case à cocher) puis joue la cérémonie de scellement une seule fois par signature.
  - Couleur : vert plein réservé à l'action principale et aux états validés ; sélection neutre via `.seg-active`, bordures teintées via `.edge-*` (pas de bande latérale).
  - **Système visuel de référence : [DESIGN.md](./DESIGN.md)** (monde « étude de cabinet » : papier vert-gris, rail encre, Schibsted Grotesk, rubans de concordance Dit/Écrit/Réel) et [PRODUCT.md](./PRODUCT.md). Toute nouvelle interface s'y conforme.
- `infra/terraform/` : IaC GCP complète (`main.tf`, `variables.tf`, `outputs.tf`, `terraform.tfvars.example`).
- `scripts/` : `release_readiness.sh`, `verify_bundle.sh` (v1..v6), `verify_snapshot.sh`, `generate_sbom.sh` (CycloneDX 1.5), `predeploy_check.sh`.
- `tests/` : `62` tests `pytest` hors-ligne + `1` test `live` Vertex AI.
- `Dockerfile`, `cloudbuild.yaml`, `.github/workflows/ci.yml`, `Makefile` : Build multi-stage (`uvicorn` PID 1, `--timeout-keep-alive 30 --no-server-header`), CI/CD et déploiement.

## État Actuel Cloud Run & Infra GCP
- **Projet GCP cible** : `deloitteinnov26par-595` (à configurer en local via `.env` copié depuis `.env.example`, jamais commité).
- **Service Cloud Run déployé** : `triad` dans `europe-west9` (`PORT=8080`, `--cpu-boost`, `LOG_FORMAT=json`), URL publique actuelle : `https://triad-311153381291.europe-west9.run.app`.
- **Vertex AI** : `VERTEX_LOCATION=global`, `GEMINI_MODEL=gemini-4-hydrogen`.
- **Compte de service & Terraform (`infra/terraform/`)** :
  - `Makefile` (`deploy`) vérifie si `triad-auditor@<PROJECT_ID>.iam.gserviceaccount.com` existe/est accessible et bascule sinon sur le compte de service Cloud Run par défaut.
  - `infra/terraform/` provisionne Cloud Run v2 (`startup_cpu_boost`, sondes `/api/health/ready`), Secret Manager (`AUDIT_SIGNING_SECRET` + rotation optionnelle `enable_secret_rotation`), bucket GCS `audit_logs` (WORM + lifecycle `COLDLINE` 90j / `ARCHIVE` 365j), Cloud Monitoring (Uptime, 5xx, P95, 429, logs structurés), et options désactivées par défaut pour compatibilité sandbox : `enable_cloud_armor`, `enable_eu_geofencing`, `enable_org_policies`, `enable_vpc_egress`.
  - **Prochaines pistes infra possibles** : appliquer `infra/terraform/` (création du SA dédié `triad-auditor` moindre privilège + Secret Manager `AUDIT_SIGNING_SECRET` monté sur Cloud Run), configurer un backend GCS pour le state Terraform, activer `enable_cloud_armor` + domaine personnalisé.

## Commandes Essentielles
```bash
# 1. Build Frontend (obligatoire après toute modification dans frontend/)
cd frontend && npx tsc --noEmit && npm run build

# 2. Vérifications statiques, HCL/YAML, anti-fuite secrets, budget JS (< 350 Ko) & SBOM
make lint && make ci-validate && make sbom-check

# 3. Tests backend & sécurité (hors appels Vertex AI live)
PYTHONPATH=src .venv/bin/pytest -v tests/ -k "not live"

# 4. Certification E2E complète sans Docker
make release-check

# 5. Déploiement Cloud Run (europe-west9)
ALLOW_UNAUTH=true make deploy && make deploy-check   # accès public démo
make deploy && make deploy-check                   # accès privé IAM
```

## Règles Non-Négociables
1. **Zéro exécution corrective GCP** : les sondes GCP sont strictement en **lecture seule**. Ne jamais exécuter de commandes `gcloud` de remédiation depuis l'application.
2. **Verrou humain `HTTP 403`** : les **12 routes d'export** (`/api/export/*`) doivent rester bloquées en `HTTP 403` avant `POST /api/validate`.
3. **Intégrité forensique** : préserver la chaîne SHA-256 append-only, la rétrocompatibilité `verify_bundle` **v1 (6) à v6 (12 pièces)** et `X-Triad-Signature` (HMAC-SHA256).
4. **Sécurité Frontend & CSP** : zéro `dangerouslySetInnerHTML`, zéro `<script>` inline, UI 100 % en français, budget JS initial `src/triad/web/dist/assets/index-*.js` `< 358 400` octets.
5. **Zéro fuite de secrets** : ne jamais commiter `.env`, clés JSON, jetons GCP, `.venv/`, `node_modules/` ou `logs/`.
