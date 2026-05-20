#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# deploy.sh — Deploy automatico invocato dal webhook GitHub
#
# Il bot gira dentro un container Docker con il volume ./prod/app:/app,
# quindi il git pull aggiorna direttamente i sorgenti. Per ricaricare:
#
#   - Se è cambiato SOLO il codice JS/HTML: basta un restart del container
#   - Se è cambiato package.json / Dockerfile: serve rebuild
#
# Entrambe le operazioni vengono delegate a un file "flag" che viene
# monitorato dall'host con docker-deploy-watcher.sh (vedi README)
# ═══════════════════════════════════════════════════════════════════════

set -e
cd "$(dirname "$0")"

echo "==> $(date '+%F %T') Inizio deploy PROD"

# 1. Backup .env per sicurezza
if [ -f .env ]; then
  cp .env .env.backup
fi

# 2. Pull dal repository
echo "==> git fetch & reset origin/main"
git fetch --all
git reset --hard origin/main 2>/dev/null || git reset --hard origin/master

# 3. Ripristina .env
if [ -f .env.backup ]; then
  mv .env.backup .env
fi

# 4. Determina se serve rebuild
NEEDS_REBUILD="no"
if git diff HEAD@{1} HEAD --name-only 2>/dev/null | grep -qE "package\.json|package-lock\.json|Dockerfile"; then
  NEEDS_REBUILD="yes"
fi

# 5. Crea file flag che il watcher sull'host legge
FLAG_FILE=".deploy-requested"
cat > "$FLAG_FILE" <<EOT
timestamp=$(date +%s)
commit=$(git rev-parse --short HEAD 2>/dev/null || echo "?")
rebuild=$NEEDS_REBUILD
EOT

echo "==> Flag deploy creato: rebuild=$NEEDS_REBUILD"
echo "==> $(date '+%F %T') Deploy delegato al watcher sull'host"
