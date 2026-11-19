# Instructions Claude Code — TRIAD

Consulte [AGENTS.md](./AGENTS.md) pour l'architecture complète, les commandes `make`, le déploiement Cloud Run (`europe-west9`) et les règles de sécurité non-négociables du projet **TRIAD** (Hackathon Deloitte × Google Cloud).

Rappel rapide avant tout commit/push :
1. Si `frontend/` a été modifié : `cd frontend && npx tsc --noEmit && npm run build`
2. Validation complète : `make release-check`
3. Déploiement Cloud Run public : `ALLOW_UNAUTH=true make deploy && make deploy-check`
