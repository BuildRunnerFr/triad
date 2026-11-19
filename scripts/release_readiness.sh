#!/usr/bin/env bash
# ==============================================================================
# Banc de Qualification Automatisé « Release Readiness » — TRIAD (sans Docker)
# Chaîne complète de certification pré-livraison :
# 1. make lint, make ci-validate, SBOM CycloneDX 1.5 & Performance Budget JS (< 350 Ko / 358400 octets)
# 2. Suite de tests unitaires, sécurité ADK & API (pytest -k "not live")
# 3. Démarrage éphémère Uvicorn (--timeout-keep-alive 30 --no-server-header) avec AUDIT_SIGNING_SECRET
# 4. Contrôle des sondes (/api/health, /api/health/ready, /api/security/posture, /api/security/sbom)
# 5. Contrôle exhaustif des 12 verrous HTTP 403 -> approbation -> 12 exports 200 OK
#    + vérification cryptographique de l'en-tête X-Triad-Signature sur chaque export
# 6. Double certification CLI hors-ligne :
#    - scripts/verify_bundle.sh sur le Dossier de Preuve v6 (12 pièces)
#    - scripts/verify_snapshot.sh sur le Snapshot de session signé
# 7. Arrêt propre et nettoyage atomique (zéro trace résiduelle dans logs/)
# ==============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

PYTHON_BIN="python3"
if [[ -x "${ROOT_DIR}/.venv/bin/python" ]]; then
  PYTHON_BIN="${ROOT_DIR}/.venv/bin/python"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi

TMP_DIR="$(mktemp -d)"
REL_SID="release-check-$$"
REL_SECRET="triad-release-hmac-$$-$(date +%s)"
UVICORN_PID=""
BASE_URL=""

LOGS_EXISTED=0
SESSIONS_EXISTED=0
[[ -d "${ROOT_DIR}/logs" ]] && LOGS_EXISTED=1
[[ -d "${ROOT_DIR}/logs/sessions" ]] && SESSIONS_EXISTED=1

cleanup() {
  if [[ -n "${UVICORN_PID}" ]] && kill -0 "${UVICORN_PID}" 2>/dev/null; then
    if [[ -n "${BASE_URL}" ]]; then
      curl -fsS -X DELETE "${BASE_URL}/api/sessions/${REL_SID}" >/dev/null 2>&1 || true
    fi
    kill "${UVICORN_PID}" 2>/dev/null || true
    wait "${UVICORN_PID}" 2>/dev/null || true
  fi
  rm -f "${ROOT_DIR}/logs/sessions/${REL_SID}.json" \
        "${ROOT_DIR}/logs/sessions/.${REL_SID}.json.tmp" \
        "${ROOT_DIR}/logs/audit_trail_${REL_SID}.jsonl"
  rm -rf "${ROOT_DIR}/logs/uploads/${REL_SID}" "${TMP_DIR}"
  if [[ "${SESSIONS_EXISTED}" -eq 0 ]]; then
    rmdir "${ROOT_DIR}/logs/sessions" 2>/dev/null || true
  fi
  if [[ "${LOGS_EXISTED}" -eq 0 ]]; then
    rmdir "${ROOT_DIR}/logs/uploads" 2>/dev/null || true
    rmdir "${ROOT_DIR}/logs" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "=== [1/6] Qualification statique : make lint, make ci-validate, SBOM CycloneDX 1.5 & Performance Budget JS (< 350 Ko) ==="
make lint
make ci-validate
bash scripts/generate_sbom.sh --check
"${PYTHON_BIN}" - <<'PY'
import pathlib

budget = 358400
files = sorted(pathlib.Path("src/triad/web/dist/assets").glob("index-*.js"))
assert files, "ERREUR: Aucun bundle d'entrée src/triad/web/dist/assets/index-*.js trouvé"
for f in files:
    sz = f.stat().st_size
    assert 0 < sz < budget, f"ERREUR Performance Budget JS: {f.name} = {sz} octets >= {budget} octets (350 Ko)"
print(f"OK: Performance Budget JS certifié ({files[0].name} = {files[0].stat().st_size} octets < {budget} octets / 350 Ko).")
PY

echo "=== [2/6] Suite de tests backend & sécurité ADK (pytest -k 'not live') ==="
PYTHONPATH=src "${PYTHON_BIN}" -m pytest -v tests/ -k "not live"

FREE_PORT="$("${PYTHON_BIN}" -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
BASE_URL="http://127.0.0.1:${FREE_PORT}"

echo "=== [3/6] Démarrage éphémère Uvicorn signé sur ${BASE_URL} (session=${REL_SID}) ==="
env \
  HOST="127.0.0.1" \
  PORT="${FREE_PORT}" \
  USE_GCP_SNAPSHOT="true" \
  USE_DEMO_CACHE="true" \
  LOG_FORMAT="json" \
  RATE_LIMIT_MAX_REQUESTS="200" \
  AUDIT_SIGNING_SECRET="${REL_SECRET}" \
  PYTHONPATH="src" \
  "${PYTHON_BIN}" -m uvicorn triad.api.app:app \
    --host 127.0.0.1 \
    --port "${FREE_PORT}" \
    --timeout-keep-alive 30 \
    --no-server-header \
    --log-level warning >"${TMP_DIR}/uvicorn.log" 2>&1 &
UVICORN_PID="$!"

READY=0
for _ in $(seq 1 40); do
  if curl -fsS "${BASE_URL}/api/health/ready" >"${TMP_DIR}/ready.json" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 0.25
done

if [[ "${READY}" -ne 1 ]]; then
  echo "ERREUR: /api/health/ready indisponible sur ${BASE_URL}" >&2
  cat "${TMP_DIR}/uvicorn.log" >&2 || true
  exit 1
fi

curl -fsSI "${BASE_URL}/api/health/ready" | head -n1 | grep -q ' 200'
curl -fsS "${BASE_URL}/api/health" >"${TMP_DIR}/health.json"
HEAD_HEALTH="$(curl -fsSI "${BASE_URL}/api/health")"
printf '%s\n' "${HEAD_HEALTH}" | head -n1 | grep -q ' 200'
printf '%s\n' "${HEAD_HEALTH}" | grep -iq '^x-content-type-options:[[:space:]]*nosniff'
! printf '%s\n' "${HEAD_HEALTH}" | grep -iq '^server:'
curl -fsSI "${BASE_URL}/" | head -n1 | grep -q ' 200'
curl -fsS "${BASE_URL}/" | grep -q '<div id="root"></div>'

curl -fsS -H "X-Session-Id: ${REL_SID}" "${BASE_URL}/api/security/posture" >"${TMP_DIR}/posture.json"
curl -fsSD "${TMP_DIR}/sbom.headers" -H "X-Session-Id: ${REL_SID}" \
  "${BASE_URL}/api/security/sbom" -o "${TMP_DIR}/sbom.json"
"${PYTHON_BIN}" - "${TMP_DIR}/health.json" "${TMP_DIR}/ready.json" "${TMP_DIR}/posture.json" \
  "${TMP_DIR}/sbom.headers" "${TMP_DIR}/sbom.json" "${REL_SECRET}" <<'PY'
import hashlib, hmac, json, pathlib, sys

health = json.loads(pathlib.Path(sys.argv[1]).read_text("utf-8"))
ready = json.loads(pathlib.Path(sys.argv[2]).read_text("utf-8"))
posture = json.loads(pathlib.Path(sys.argv[3]).read_text("utf-8"))
sbom_hdrs = pathlib.Path(sys.argv[4]).read_text("utf-8", errors="replace").splitlines()
sbom_bytes = pathlib.Path(sys.argv[5]).read_bytes()
secret = sys.argv[6]
sbom = json.loads(sbom_bytes.decode("utf-8"))

assert health.get("status") == "ok" and health.get("hmac_signing_enabled") is True, f"health invalide: {health}"
assert ready.get("ready") is True and ready.get("hmac_signing_enabled") is True, f"ready invalide: {ready}"
locked = posture.get("locked_exports_count")
if locked is None and isinstance(posture.get("summary"), dict):
    locked = posture["summary"].get("locked_exports_count")
assert locked == 12, f"locked_exports_count attendu=12, reçu={locked}"
assert posture.get("hmac_signing_enabled") is True, f"hmac_signing_enabled attendu=True dans posture"

assert sbom.get("bomFormat") == "CycloneDX" and sbom.get("specVersion") == "1.5", f"SBOM runtime invalide: {sbom.get('bomFormat')} / {sbom.get('specVersion')}"
assert isinstance(sbom.get("components"), list) and len(sbom["components"]) >= 10, "Composants SBOM runtime absents"
sbom_sig = ""
for line in sbom_hdrs:
    if line.lower().startswith("x-triad-signature:"):
        sbom_sig = line.split(":", 1)[1].strip()
        break
assert sbom_sig.startswith("hmac-sha256="), "X-Triad-Signature manquant sur /api/security/sbom"
expected_sbom_hmac = hmac.new(secret.encode("utf-8"), sbom_bytes, hashlib.sha256).hexdigest()
assert hmac.compare_digest(expected_sbom_hmac, sbom_sig.split("=", 1)[1].strip().lower()), "Signature X-Triad-Signature invalide sur /api/security/sbom"
print("OK: Sondes /api/health, /api/health/ready, /api/security/posture (12 verrous) et /api/security/sbom (CycloneDX 1.5 signé) conformes.")
PY

echo "=== [4/6] Contrôle des 12 verrous HTTP 403 avant approbation humaine ==="
EXPORTS=(report mail json playbook csv bundle anssi-draft comex-brief terraform interview-guide risk-register cnil-draft)

for ep in "${EXPORTS[@]}"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "X-Session-Id: ${REL_SID}" "${BASE_URL}/api/export/${ep}")"
  [[ "${code}" == "403" ]] || { echo "ERREUR: Pré-audit /api/export/${ep} attendu 403, reçu ${code}" >&2; exit 1; }
done

curl -fsS -X POST -H "X-Session-Id: ${REL_SID}" "${BASE_URL}/api/demo/load" >/dev/null
curl -fsS -X POST -H "X-Session-Id: ${REL_SID}" -H "Content-Type: application/json" \
  -d '{"mode":"APRES","use_cache":true}' "${BASE_URL}/api/audit/run" >/dev/null

for ep in "${EXPORTS[@]}"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "X-Session-Id: ${REL_SID}" "${BASE_URL}/api/export/${ep}?mode=APRES")"
  [[ "${code}" == "403" ]] || { echo "ERREUR: Post-audit non validé /api/export/${ep} attendu 403, reçu ${code}" >&2; exit 1; }
done
echo "OK: Les 12 routes d'export demeurent strictement verrouillées en HTTP 403 avant validation."

echo "=== [5/6] Approbation humaine & vérification HTTP 200 + X-Triad-Signature sur les 12 livrables ==="
curl -fsS -X POST -H "X-Session-Id: ${REL_SID}" "${BASE_URL}/api/validate?mode=APRES" >/dev/null

for ep in "${EXPORTS[@]}"; do
  hdr_file="${TMP_DIR}/${ep}.headers"
  body_file="${TMP_DIR}/${ep}.bin"
  code="$(curl -sS -D "${hdr_file}" -o "${body_file}" -w '%{http_code}' \
    -H "X-Session-Id: ${REL_SID}" "${BASE_URL}/api/export/${ep}?mode=APRES")"
  [[ "${code}" == "200" ]] || { echo "ERREUR: Post-validation /api/export/${ep} attendu 200, reçu ${code}" >&2; exit 1; }
  "${PYTHON_BIN}" - "${hdr_file}" "${body_file}" "${REL_SECRET}" "${ep}" <<'PY'
import hashlib, hmac, pathlib, sys

hdrs = pathlib.Path(sys.argv[1]).read_text("utf-8", errors="replace").splitlines()
body = pathlib.Path(sys.argv[2]).read_bytes()
secret = sys.argv[3]
ep = sys.argv[4]

assert len(body) > 0, f"Corps vide sur /api/export/{ep}"
sig_hdr = ""
for line in hdrs:
    if line.lower().startswith("x-triad-signature:"):
        sig_hdr = line.split(":", 1)[1].strip()
        break
assert sig_hdr.startswith("hmac-sha256="), f"X-Triad-Signature manquant sur /api/export/{ep}"
expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
actual = sig_hdr.split("=", 1)[1].strip().lower()
assert hmac.compare_digest(expected, actual), f"Signature X-Triad-Signature invalide sur /api/export/{ep}"
PY
done
echo "OK: 12/12 livrables exportés en HTTP 200 OK avec signature X-Triad-Signature vérifiée."

echo "=== [6/6] Double contrôle CLI : verify_bundle.sh (v6, 12 pièces) & verify_snapshot.sh ==="
BUNDLE_ZIP="${TMP_DIR}/bundle.bin"
BUNDLE_OUT="$(AUDIT_SIGNING_SECRET="${REL_SECRET}" bash scripts/verify_bundle.sh "${BUNDLE_ZIP}")"
printf '%s\n' "${BUNDLE_OUT}"
printf '%s\n' "${BUNDLE_OUT}" | grep -q "Inventaire v6 conforme (12 pièces"

curl -fsS -X POST -H "X-Session-Id: ${REL_SID}" \
  -F "file=@${BUNDLE_ZIP};type=application/zip" \
  "${BASE_URL}/api/verify/bundle" >"${TMP_DIR}/api_verify.json"
"${PYTHON_BIN}" - "${TMP_DIR}/api_verify.json" <<'PY'
import json, pathlib, sys
res = json.loads(pathlib.Path(sys.argv[1]).read_text("utf-8"))
assert res.get("authentic") is True, f"Bundle non authentique via API: {res}"
assert res.get("bundle_version") == "v6", f"bundle_version attendu v6, reçu: {res.get('bundle_version')}"
assert res.get("signature_status") == "VERIFIED", f"signature_status attendu VERIFIED, reçu: {res.get('signature_status')}"
print("OK: POST /api/verify/bundle confirme authentic=true, bundle_version=v6, signature_status=VERIFIED.")
PY

SNAP_JSON="${TMP_DIR}/TRIAD_Session_Snapshot_${REL_SID}.json"
SNAP_HDR="${TMP_DIR}/snapshot.headers"
curl -fsSD "${SNAP_HDR}" "${BASE_URL}/api/sessions/${REL_SID}/snapshot" -o "${SNAP_JSON}"
SNAP_SIG="$(awk 'tolower($1)=="x-triad-signature:" {gsub(/\r/,"",$2); print $2}' "${SNAP_HDR}")"
AUDIT_SIGNING_SECRET="${REL_SECRET}" bash scripts/verify_snapshot.sh "${SNAP_JSON}" --signature "${SNAP_SIG}"

curl -fsS -X DELETE "${BASE_URL}/api/sessions/${REL_SID}" >/dev/null
echo "=== CERTIFICATION RELEASE READINESS TRIAD 100 % VALIDÉE ✓ ==="
