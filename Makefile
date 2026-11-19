.DEFAULT_GOAL := help
.PHONY: help lint build-ui test test-live demo tf-validate sbom-check ci-validate check-all release-check verify-bundle verify-snapshot docker-build docker-smoke deploy deploy-check

PYTHON        := $(shell if [ -x .venv/bin/python ]; then echo .venv/bin/python; else echo python3; fi)
GCLOUD        := $(shell command -v gcloud 2>/dev/null || echo /home/farouk/google-cloud-sdk/bin/gcloud)
CONTAINER_CLI := $(shell command -v docker 2>/dev/null || command -v podman 2>/dev/null || echo docker)

PROJECT_ID      ?= $(shell if [ -f .env ]; then sed -n 's/^PROJECT_ID=//p' .env | head -n1; fi)
REGION          ?= europe-west9
VERTEX_LOCATION ?= global
GEMINI_MODEL    ?= gemini-4-hydrogen
SERVICE_NAME    ?= triad
SA_NAME      ?= triad-auditor
ALLOW_UNAUTH ?= false
SMOKE_PORT   ?= 18080
BUNDLE       ?=
SNAPSHOT     ?=
SIGNATURE    ?=
SBOM_OUT     ?=
JS_ENTRY_BUDGET_BYTES ?= 358400
TF_DIR       := infra/terraform

AUTH_FLAG    := $(if $(filter true 1 yes,$(ALLOW_UNAUTH)),--allow-unauthenticated,--no-allow-unauthenticated)

help: ## Affiche les commandes disponibles pour construire, tester et déployer TRIAD
	@printf "\n\033[1;32mTRIAD — Commandes Make (Build, QA, CI/CD & Cloud Run IaC)\033[0m\n\n"
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf "\n"

lint: ## Compilation bytecode Python (src, tests) et vérification syntaxique AST / TOML / JSON
	$(PYTHON) -m compileall -q src tests run_demo.py
	@$(PYTHON) -c "import ast, json, pathlib, tomllib; \
tomllib.loads(pathlib.Path('pyproject.toml').read_text('utf-8')); \
py_files = sorted([pathlib.Path('run_demo.py'), *pathlib.Path('src').rglob('*.py'), *pathlib.Path('tests').rglob('*.py')]); \
[ast.parse(p.read_text('utf-8'), filename=str(p)) for p in py_files]; \
json_files = sorted(pathlib.Path('data').glob('*.json')); \
[json.loads(p.read_text('utf-8')) for p in json_files]; \
print(f'OK: {len(py_files)} fichiers Python compilés/vérifiés, pyproject.toml et {len(json_files)} référentiels JSON valides.')"

build-ui: ## Compile le frontend React 19 + TypeScript + Vite vers src/triad/web/dist/
	cd frontend && (test -d node_modules || npm ci) && npx tsc --noEmit && npm run build

test: ## Exécute la suite de tests backend et sécurité (hors appels Vertex AI live)
	PYTHONPATH=src $(PYTHON) -m pytest -v tests/ -k "not live"

test-live: ## Exécute l'intégralité des tests incluant le pipeline Vertex AI réel
	PYTHONPATH=src $(PYTHON) -m pytest -v tests/

demo: ## Démarre TRIAD localement sur http://localhost:8080 (mode snapshot GCP)
	USE_GCP_SNAPSHOT=true $(PYTHON) run_demo.py

tf-validate: ## Vérifie le formatage et la validité de l'IaC Terraform (infra/terraform/)
	@if command -v terraform >/dev/null 2>&1; then \
		echo "Validation via Terraform CLI..."; \
		terraform -chdir=$(TF_DIR) fmt -check -recursive && \
		terraform -chdir=$(TF_DIR) init -backend=false -input=false && \
		terraform -chdir=$(TF_DIR) validate; \
	elif command -v tofu >/dev/null 2>&1; then \
		echo "Validation via OpenTofu CLI..."; \
		tofu -chdir=$(TF_DIR) fmt -check -recursive && \
		tofu -chdir=$(TF_DIR) init -backend=false -input=false && \
		tofu -chdir=$(TF_DIR) validate; \
	else \
		echo "CLI terraform/tofu absente — vérification structurelle HCL & références ($(TF_DIR))..."; \
		$(PYTHON) -c "import pathlib, re; tf = pathlib.Path('$(TF_DIR)'); req = ['main.tf', 'variables.tf', 'outputs.tf', 'README.md']; miss = [f for f in req if not (tf / f).is_file()]; assert not miss, f'Manquants: {miss}'; files = sorted(tf.glob('*.tf')); txts = {p.name: p.read_text('utf-8') for p in files}; [(_ for _ in ()).throw(AssertionError(f'Délimiteurs déséquilibrés dans {k}')) for k, v in txts.items() for c in [re.sub(r'#.*', '', re.sub(r'\"(?:\\\\.|[^\"\\\\])*\"', '\"\"', v))] if c.count('{') != c.count('}') or c.count('[') != c.count(']') or c.count('(') != c.count(')')]; dvars = {m for v in txts.values() for m in re.findall(r'variable\s+\"(\w+)\"', v)}; uvars = {m for v in txts.values() for m in re.findall(r'\bvar\.(\w+)\b', v)}; assert not (uvars - dvars), f'Variables non déclarées: {sorted(uvars - dvars)}'; print(f'OK: {len(files)} fichiers HCL valides ({len(dvars)} variables déclarées, 0 référence orpheline).')"; \
	fi

sbom-check: ## Génère et valide de manière déterministe le SBOM CycloneDX 1.5 JSON (sans polluer le dépôt ; SBOM_OUT=... optionnel)
	@if [ -n "$(SBOM_OUT)" ]; then \
		bash scripts/generate_sbom.sh --output "$(SBOM_OUT)"; \
	else \
		bash scripts/generate_sbom.sh --check; \
	fi

ci-validate: lint tf-validate ## Valide le lint, l'IaC Terraform, YAML CI/CD, SBOM CycloneDX 1.5, Performance Budget JS (< 350 Ko) et scripts forensiques
	@$(PYTHON) -c "import pathlib, yaml; files = ['cloudbuild.yaml', '.github/workflows/ci.yml']; [yaml.safe_load(pathlib.Path(f).read_text('utf-8')) for f in files]; print(f'OK: {len(files)} fichiers CI/CD YAML valides ({files}).')"
	@bash scripts/predeploy_check.sh
	@bash scripts/generate_sbom.sh --check
	@$(PYTHON) -c "import pathlib; budget = int('$(JS_ENTRY_BUDGET_BYTES)'); files = sorted(pathlib.Path('src/triad/web/dist/assets').glob('index-*.js')); assert files, 'ERREUR: Bundle src/triad/web/dist/assets/index-*.js introuvable (exécutez make build-ui)'; [(_ for _ in ()).throw(AssertionError(f'ERREUR Performance Budget JS: {f.name} = {f.stat().st_size} octets >= plafond {budget} octets (350 Ko)')) for f in files if f.stat().st_size <= 0 or f.stat().st_size >= budget]; print(f'OK: Performance Budget JS respecté ({files[0].name} = {files[0].stat().st_size / 1024:.1f} Ko / {files[0].stat().st_size} octets < 350.0 Ko / {budget} octets).')"
	@$(PYTHON) -c "import hashlib, hmac, json, pathlib, subprocess, tempfile; \
state = {'session_id': 'ci', 'files': ['PSSI_CH_Valmont.md'], 'mode': 'APRES', 'results_by_mode': {'AVANT': {'validated': False}, 'APRES': {'validated': True}}, 'security_alert': None, 'updated_at': '2026-11-19T12:00:00Z'}; \
core = {'ts': '2026-11-19T12:00:00Z', 'run_id': 'r1', 'mode': 'APRES', 'agent': 'ConsultantDeloitte', 'action': 'HUMAN_VALIDATION', 'details': {'mode': 'APRES'}}; \
prev = '0' * 64; \
eh = hashlib.sha256((json.dumps(core, sort_keys=True, ensure_ascii=False, separators=(',', ':')) + prev).encode()).hexdigest(); \
st_sha = hashlib.sha256(json.dumps({k: v for k, v in state.items() if k != 'session_id'}, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest(); \
snap = {'schema_version': '1.0', 'session_id': 'ci', 'state': state, 'integrity': {'algorithm': 'SHA-256', 'genesis_hash': prev, 'head_hash': eh, 'nb_entrees': 1, 'state_sha256': st_sha}, 'audit_log': [{**core, 'prev_hash': prev, 'hash': eh}]}; \
raw = (json.dumps(snap, ensure_ascii=False, indent=2) + '\n').encode(); \
sig = hmac.new(b'ci-key', raw, hashlib.sha256).hexdigest(); \
td = tempfile.TemporaryDirectory(); p = pathlib.Path(td.name) / 'TRIAD_Session_Snapshot_ci.json'; p.write_bytes(raw); \
subprocess.run(['bash', 'scripts/verify_snapshot.sh', str(p), '--secret', 'ci-key', '--signature', f'hmac-sha256={sig}'], check=True, stdout=subprocess.DEVNULL); \
bad = subprocess.run(['bash', 'scripts/verify_snapshot.sh', str(p), '--secret', 'wrong-key', '--signature', sig], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); \
assert bad.returncode != 0; td.cleanup(); \
print('OK: Auto-test cryptographique scripts/verify_snapshot.sh (SHA-256 + state_sha256 + HMAC) validé.')"

check-all: lint test build-ui ci-validate ## Pré-vol complet : lint, pytest, build-ui, ci-validate (SBOM + IaC/YAML) et scan anti-fuite secrets
	@echo "=== PRÉ-VOL COMPLET TRIAD RÉUSSI (lint + test + build-ui + ci-validate + SBOM CycloneDX 1.5 + anti-fuite secrets) ==="

release-check: ## Banc de qualification Release Readiness sans Docker (lint, SBOM, pytest, Uvicorn éphémère, /api/security/sbom, 12 verrous 403->200 HMAC, bundle v6 & snapshot)
	@bash scripts/release_readiness.sh

verify-bundle: ## Vérifie un Dossier de Preuve ZIP exporté (usage: BUNDLE=dossier.zip make verify-bundle)
	@if [ -z "$(BUNDLE)" ]; then \
		echo "ERREUR: Spécifiez l'archive à vérifier (ex: BUNDLE=TRIAD_Dossier_Preuve_NIS2.zip make verify-bundle)"; \
		exit 1; \
	fi
	@bash scripts/verify_bundle.sh "$(BUNDLE)"

verify-snapshot: ## Vérifie hors-ligne un Snapshot JSON de session (usage: SNAPSHOT=snap.json [SIGNATURE=...] make verify-snapshot)
	@if [ -z "$(SNAPSHOT)" ]; then \
		echo "ERREUR: Spécifiez le snapshot JSON à vérifier (ex: SNAPSHOT=TRIAD_Session_Snapshot_default.json make verify-snapshot)"; \
		exit 1; \
	fi
	@if [ -n "$(SIGNATURE)" ]; then \
		bash scripts/verify_snapshot.sh "$(SNAPSHOT)" --signature "$(SIGNATURE)"; \
	else \
		bash scripts/verify_snapshot.sh "$(SNAPSHOT)"; \
	fi

docker-build: ## Construit l'image conteneur multi-stage localement (Docker / Podman)
	$(CONTAINER_CLI) build -t $(SERVICE_NAME):local .

docker-smoke: docker-build ## Smoke-test E2E conteneur (--read-only) : HEAD/GET /api/health/ready, /api/security/sbom, 12 verrous 403, audit + verify_bundle.sh (v6) & verify_snapshot.sh
	@CONTAINER_NAME="$(SERVICE_NAME)-smoke-$$$$"; \
	SMOKE_ZIP="/tmp/triad_smoke_bundle_$$$$.zip"; \
	SMOKE_SNAP="/tmp/triad_smoke_snapshot_$$$$.json"; \
	SMOKE_SBOM="/tmp/triad_smoke_sbom_$$$$.json"; \
	SMOKE_SID="ci-smoke-$$$$"; \
	SMOKE_SECRET="smoke-hmac-$$$$"; \
	BASE_URL="http://127.0.0.1:$(SMOKE_PORT)"; \
	trap 'rm -f "$$SMOKE_ZIP" "$$SMOKE_SNAP" "$$SMOKE_SBOM"; $(CONTAINER_CLI) rm -f "$$CONTAINER_NAME" >/dev/null 2>&1 || true' EXIT; \
	$(CONTAINER_CLI) run -d --name "$$CONTAINER_NAME" \
		--read-only --tmpfs /tmp:rw,noexec,nosuid,mode=1777 --tmpfs /app/logs:rw,nosuid,mode=1777 \
		-p "127.0.0.1:$(SMOKE_PORT):8080" \
		-e USE_GCP_SNAPSHOT=true -e USE_DEMO_CACHE=true -e LOG_FORMAT=json -e AUDIT_SIGNING_SECRET="$$SMOKE_SECRET" \
		$(SERVICE_NAME):local >/dev/null; \
	READY=0; \
	for i in $$(seq 1 30); do \
		if curl -fsS "$$BASE_URL/api/health/ready" >/dev/null 2>&1; then READY=1; break; fi; \
		sleep 1; \
	done; \
	if [ "$$READY" -ne 1 ]; then echo "ERREUR: /api/health/ready indisponible sur $$BASE_URL"; $(CONTAINER_CLI) logs "$$CONTAINER_NAME"; exit 1; fi; \
	curl -fsS "$$BASE_URL/api/health" | grep -q '"status":"ok"'; \
	HEAD_HEADERS=$$(curl -fsSI "$$BASE_URL/api/health"); \
	printf '%s\n' "$$HEAD_HEADERS" | head -n1 | grep -q ' 200'; \
	printf '%s\n' "$$HEAD_HEADERS" | grep -iq '^x-content-type-options:[[:space:]]*nosniff'; \
	curl -fsSI "$$BASE_URL/api/health/ready" | head -n1 | grep -q ' 200'; \
	curl -fsS "$$BASE_URL/api/health/ready" >/dev/null; \
	SBOM_SIG=$$(curl -fsSD - "$$BASE_URL/api/security/sbom" -o "$$SMOKE_SBOM" | awk 'tolower($$1)=="x-triad-signature:" {gsub(/\r/,"",$$2); print $$2}'); \
	$(PYTHON) -c "import hashlib, hmac, json, pathlib, sys; b = pathlib.Path(sys.argv[1]).read_bytes(); d = json.loads(b); assert d.get('bomFormat') == 'CycloneDX' and d.get('specVersion') == '1.5'; exp = hmac.new(sys.argv[2].encode(), b, hashlib.sha256).hexdigest(); assert sys.argv[3].startswith('hmac-sha256=') and hmac.compare_digest(exp, sys.argv[3].split('=', 1)[1].lower())" "$$SMOKE_SBOM" "$$SMOKE_SECRET" "$$SBOM_SIG"; \
	curl -fsSI "$$BASE_URL/" | head -n1 | grep -q ' 200'; \
	curl -fsS "$$BASE_URL/" | grep -q '<div id="root"></div>'; \
	for ep in report mail json playbook csv bundle anssi-draft comex-brief terraform interview-guide risk-register cnil-draft; do \
		code=$$(curl -s -o /dev/null -w '%{http_code}' -H "X-Session-Id: $$SMOKE_SID" "$$BASE_URL/api/export/$$ep"); \
		test "$$code" = "403" || { echo "ERREUR: /api/export/$$ep attendu 403, reçu $$code"; exit 1; }; \
	done; \
	curl -fsS -X POST -H "X-Session-Id: $$SMOKE_SID" "$$BASE_URL/api/demo/load" >/dev/null; \
	curl -fsS -X POST -H "X-Session-Id: $$SMOKE_SID" -H "Content-Type: application/json" -d '{"mode":"APRES","use_cache":true}' "$$BASE_URL/api/audit/run" >/dev/null; \
	for ep in bundle anssi-draft comex-brief terraform interview-guide risk-register cnil-draft; do \
		test "$$(curl -s -o /dev/null -w '%{http_code}' -H "X-Session-Id: $$SMOKE_SID" "$$BASE_URL/api/export/$$ep?mode=APRES")" = "403"; \
	done; \
	curl -fsS -X POST -H "X-Session-Id: $$SMOKE_SID" "$$BASE_URL/api/validate?mode=APRES" >/dev/null; \
	curl -fsS -H "X-Session-Id: $$SMOKE_SID" "$$BASE_URL/api/export/anssi-draft?mode=APRES" >/dev/null; \
	curl -fsS -H "X-Session-Id: $$SMOKE_SID" "$$BASE_URL/api/export/comex-brief?mode=APRES" >/dev/null; \
	curl -fsS -H "X-Session-Id: $$SMOKE_SID" "$$BASE_URL/api/export/terraform?mode=APRES" >/dev/null; \
	curl -fsS -H "X-Session-Id: $$SMOKE_SID" "$$BASE_URL/api/export/interview-guide?mode=APRES" >/dev/null; \
	curl -fsS -H "X-Session-Id: $$SMOKE_SID" "$$BASE_URL/api/export/risk-register?mode=APRES" >/dev/null; \
	curl -fsS -H "X-Session-Id: $$SMOKE_SID" "$$BASE_URL/api/export/cnil-draft?mode=APRES" >/dev/null; \
	curl -fsS -H "X-Session-Id: $$SMOKE_SID" "$$BASE_URL/api/export/bundle?mode=APRES" -o "$$SMOKE_ZIP"; \
	AUDIT_SIGNING_SECRET="$$SMOKE_SECRET" bash scripts/verify_bundle.sh "$$SMOKE_ZIP"; \
	SNAP_SIG=$$(curl -fsSD - "$$BASE_URL/api/sessions/$$SMOKE_SID/snapshot" -o "$$SMOKE_SNAP" | awk 'tolower($$1)=="x-triad-signature:" {gsub(/\r/,"",$$2); print $$2}'); \
	AUDIT_SIGNING_SECRET="$$SMOKE_SECRET" bash scripts/verify_snapshot.sh "$$SMOKE_SNAP" --signature "$$SNAP_SIG"; \
	echo "OK: Smoke-test E2E conteneur --read-only réussi sur $$BASE_URL (HEAD/GET health+ready, SBOM CycloneDX 1.5, 12 verrous 403 -> validation -> 12 pièces v6 + snapshot signés)."

deploy: ## Déploie TRIAD sur Cloud Run (europe-west9) via Cloud Build & Dockerfile multi-stage
	@bash scripts/predeploy_check.sh
	@if [ -z "$(PROJECT_ID)" ]; then \
		echo "ERREUR: PROJECT_ID requis (ex: PROJECT_ID=mon-projet make deploy)"; \
		exit 1; \
	fi
	@SA_EMAIL="$(SA_NAME)@$(PROJECT_ID).iam.gserviceaccount.com"; \
	SA_FLAG=""; \
	if $(GCLOUD) iam service-accounts describe "$$SA_EMAIL" --project "$(PROJECT_ID)" >/dev/null 2>&1; then \
		SA_FLAG="--service-account $$SA_EMAIL"; \
	else \
		echo "INFO: Compte de service $$SA_EMAIL absent ou inaccessible — déploiement avec le compte de service Cloud Run par défaut."; \
	fi; \
	$(GCLOUD) run deploy $(SERVICE_NAME) \
		--source . \
		--project "$(PROJECT_ID)" \
		--region "$(REGION)" \
		--port 8080 \
		--cpu-boost \
		$$SA_FLAG \
		--set-env-vars "PROJECT_ID=$(PROJECT_ID),VERTEX_LOCATION=$(VERTEX_LOCATION),GEMINI_MODEL=$(GEMINI_MODEL),LOG_FORMAT=json" \
		$(AUTH_FLAG)

deploy-check: ## Vérifie la santé HTTP (accès public direct prioritaire puis IAM ID_TOKEN) du service Cloud Run déployé
	@if [ -z "$(PROJECT_ID)" ]; then \
		echo "ERREUR: PROJECT_ID requis (ex: PROJECT_ID=mon-projet make deploy-check)"; \
		exit 1; \
	fi
	@SERVICE_URL=$$($(GCLOUD) run services describe $(SERVICE_NAME) --project "$(PROJECT_ID)" --region "$(REGION)" --format="value(status.url)"); \
	if [ -z "$$SERVICE_URL" ]; then \
		echo "ERREUR: Aucun service Cloud Run '$(SERVICE_NAME)' trouvé dans $(PROJECT_ID) ($(REGION))."; \
		exit 1; \
	fi; \
	IS_UNAUTH="$(if $(filter true 1 yes,$(ALLOW_UNAUTH)),1,0)"; \
	echo "Vérification du service Cloud Run : $$SERVICE_URL ..."; \
	PUBLIC_CODE="000"; \
	MAX_TRIES=$$(if [ "$$IS_UNAUTH" = "1" ]; then echo 5; else echo 1; fi); \
	for attempt in $$(seq 1 $$MAX_TRIES); do \
		PUBLIC_CODE=$$(curl -s -o /dev/null -w '%{http_code}' "$$SERVICE_URL/api/health" || echo 000); \
		if [ "$$PUBLIC_CODE" = "200" ]; then break; fi; \
		if [ "$$attempt" -lt "$$MAX_TRIES" ]; then sleep 2; fi; \
	done; \
	if [ "$$PUBLIC_CODE" = "200" ]; then \
		HEAD_HDRS=$$(curl -fsSI "$$SERVICE_URL/api/health"); \
		printf '%s\n' "$$HEAD_HDRS" | head -n1 | grep -q ' 200'; \
		printf '%s\n' "$$HEAD_HDRS" | grep -iq '^x-content-type-options:[[:space:]]*nosniff'; \
		curl -fsS "$$SERVICE_URL/api/health" | grep -q '"status":"ok"'; \
		curl -fsS "$$SERVICE_URL/api/health/ready" | grep -q '"ready":true'; \
		echo "OK: Cloud Run opérationnel en accès public direct sur $$SERVICE_URL (HEAD/GET /api/health + /api/health/ready + nosniff)."; \
	elif [ "$$IS_UNAUTH" = "1" ]; then \
		echo "ERREUR: ALLOW_UNAUTH=true spécifié mais l'accès public sans jeton à $$SERVICE_URL/api/health a répondu HTTP $$PUBLIC_CODE."; \
		exit 1; \
	else \
		ID_TOKEN=$$($(GCLOUD) auth print-identity-token --audiences="$$SERVICE_URL" 2>/dev/null || $(GCLOUD) auth print-identity-token 2>/dev/null || true); \
		if [ -z "$$ID_TOKEN" ]; then \
			echo "ERREUR: Service protégé (HTTP $$PUBLIC_CODE sans jeton) et aucun ID_TOKEN gcloud disponible."; \
			exit 1; \
		fi; \
		HEAD_HDRS=$$(curl -fsSI -H "Authorization: Bearer $$ID_TOKEN" "$$SERVICE_URL/api/health"); \
		printf '%s\n' "$$HEAD_HDRS" | head -n1 | grep -q ' 200'; \
		printf '%s\n' "$$HEAD_HDRS" | grep -iq '^x-content-type-options:[[:space:]]*nosniff'; \
		curl -fsS -H "Authorization: Bearer $$ID_TOKEN" "$$SERVICE_URL/api/health" | grep -q '"status":"ok"'; \
		curl -fsS -H "Authorization: Bearer $$ID_TOKEN" "$$SERVICE_URL/api/health/ready" | grep -q '"ready":true'; \
		echo "OK: Cloud Run opérationnel en accès authentifié IAM sur $$SERVICE_URL (HEAD/GET /api/health + /api/health/ready + nosniff)."; \
	fi
