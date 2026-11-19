# syntax=docker/dockerfile:1
# ==============================================================================
# Stage 1 — Compilation du frontend React 19 + TypeScript + Vite + Tailwind v4
# ==============================================================================
FROM node:20-alpine AS ui-builder

WORKDIR /app/frontend

# Installation déterministe des dépendances npm (couche mise en cache)
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Copie des sources frontend et build de production vers /app/src/triad/web/dist
COPY frontend/index.html frontend/tsconfig*.json frontend/vite.config.* ./
COPY frontend/src/ ./src/
RUN npm run build

# ==============================================================================
# Stage 2 — Runtime Python 3.11 minimal & non-privilégié (Cloud Run / Uvicorn)
# ==============================================================================
FROM python:3.11-slim AS runtime

LABEL org.opencontainers.image.title="TRIAD — Audit Cyber Contradictoire NIS2" \
      org.opencontainers.image.description="Plateforme d'audit NIS2 (Dit / Écrit / Réel) sur Google Cloud Run & Vertex AI" \
      org.opencontainers.image.vendor="Deloitte Risk Advisory Cyber"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app/src \
    USE_GCP_SNAPSHOT=true \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app

# Création d'un compte applicatif non-root (moindre privilège conteneur)
RUN groupadd --system --gid 10001 triad \
    && useradd --system --uid 10001 --gid triad --home-dir /app --no-create-home triad \
    && mkdir -p /app/logs \
    && chown -R triad:triad /app

# Dépendances Python (couche mise en cache)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Code backend, métadonnées SBOM CycloneDX 1.5, référentiels NIS2 / cas démo et point d'entrée
COPY --chown=triad:triad pyproject.toml ./
COPY --chown=triad:triad src/ ./src/
COPY --chown=triad:triad data/ ./data/
COPY --chown=triad:triad run_demo.py ./

# Injection propre du bundle React compilé et du lockfile npm (attestation /api/security/sbom)
RUN rm -rf ./src/triad/web/dist
COPY --from=ui-builder --chown=triad:triad /app/frontend/package-lock.json ./frontend/package-lock.json
COPY --from=ui-builder --chown=triad:triad /app/src/triad/web/dist/ ./src/triad/web/dist/

USER triad

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", \"8080\")}/api/health', timeout=3)" || exit 1

CMD ["sh", "-c", "exec python -m uvicorn triad.api.app:app --host \"${HOST:-0.0.0.0}\" --port \"${PORT:-8080}\" --timeout-keep-alive 30 --no-server-header --proxy-headers --forwarded-allow-ips='*'"]
