# Guide pour Agents IA — TRIAD (Hackathon Deloitte × Google Cloud)

Ce dépôt contient **TRIAD**, une plateforme d'audit de conformité **NIS2** propulsée par **Google Cloud Vertex AI & ADK**, conçue dans le cadre du **Hackathon Deloitte × Google Cloud**.

## Architecture du Dépôt
- `src/triad/` : Backend FastAPI + agents ADK (`agents/`), sécurité & chaîne SHA-256 (`security/`), sondes GCP lecture seule & outils documentaires (`tools/`), API & gestion de sessions (`api/`).
- `frontend/` : Interface React 19 + TypeScript + Vite + Tailwind + Three.js WebGL. Le build de production est généré dans `src/triad/web/dist/` (servi directement par FastAPI).
- `infra/terraform/` : Infrastructure as Code GCP (Cloud Run v2, Secret Manager, Cloud Armor optionnel, Monitoring, IAM, politiques optionnelles de souveraineté/VPC egress).
- `scripts/` : Outils CLI autonomes (`release_readiness.sh`, `verify_bundle.sh`, `verify_snapshot.sh`, `generate_sbom.sh`, `predeploy_check.sh`).
- `tests/` : Suite de tests `pytest` (`62` tests hors-ligne + `1` test `live` Vertex AI).
- `Dockerfile`, `cloudbuild.yaml`, `.github/workflows/ci.yml`, `Makefile` : Build multi-stage, CI/CD et déploiement Cloud Run.

## Commandes Essentielles
```bash
# 1. Build Frontend (obligatoire après toute modification dans frontend/)
cd frontend && npx tsc --noEmit && npm run build

# 2. Vérifications statiques, Terraform/YAML, anti-fuite secrets, budget JS (< 350 Ko) & SBOM
make lint && make ci-validate && make sbom-check

# 3. Tests backend & sécurité (hors appels Vertex AI live)
PYTHONPATH=src .venv/bin/pytest -v tests/ -k "not live"

# 4. Certification E2E complète sans Docker (lint + tests + Uvicorn signé + 12 verrous 403->200 + bundle v6 + snapshot)
make release-check

# 5. Déploiement Cloud Run (europe-west9)
ALLOW_UNAUTH=true make deploy && make deploy-check   # accès public démo
make deploy && make deploy-check                   # accès privé IAM
```

## Contexte Cloud Run & Vertex AI
- Région Cloud Run : `europe-west9` (`PORT=8080`, `--cpu-boost` actif).
- Vertex AI : `VERTEX_LOCATION=global`, `GEMINI_MODEL=gemini-4-hydrogen` (configurés dans `.env` local ou variables Cloud Run ; ne jamais commiter `.env`).
- `Makefile` (`deploy`) vérifie si `triad-auditor@<PROJECT_ID>.iam.gserviceaccount.com` est accessible et bascule sinon sur le compte de service Cloud Run par défaut.

## Règles Non-Négociables
1. **Zéro exécution corrective GCP** : les sondes GCP sont strictement en **lecture seule**. Ne jamais exécuter de commandes `gcloud` de remédiation depuis l'application.
2. **Verrou humain `HTTP 403`** : les **12 routes d'export** (`/api/export/*`) doivent rester bloquées en `HTTP 403` tant que `POST /api/validate` n'a pas été approuvé (et re-verrouillées si un arbitrage GRC est modifié).
3. **Intégrité forensique** : préserver la chaîne SHA-256 append-only (`audit_log.py`), la rétrocompatibilité de vérification de bundle **v1 (6 pièces) à v6 (12 pièces)**, et la signature optionnelle `AUDIT_SIGNING_SECRET` (`X-Triad-Signature`).
4. **Sécurité Frontend & CSP** : zéro `dangerouslySetInnerHTML`, zéro `<script>` inline, UI 100 % en français (style cabinet Deloitte `#86BC25` × `#07090F`), et respect du budget JS initial (`src/triad/web/dist/assets/index-*.js` `< 358 400` octets).
5. **Zéro fuite de secrets** : ne jamais commiter `.env`, clés JSON, jetons GCP, `.venv/`, `node_modules/` ou `logs/`.
