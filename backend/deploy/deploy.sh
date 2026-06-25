#!/usr/bin/env bash
# Run this ON THE VPS to ship a new version of the backend.
# Usage: /opt/v1-agent/backend/deploy/deploy.sh
#
# Safe to re-run any time. Never touches backend/data/ (gitignored, holds
# team.db + backups + usage_log.csv) so existing data always survives.
set -euo pipefail

cd /opt/v1-agent

echo "==> Pulling latest code"
git pull --ff-only

cd backend

echo "==> Installing/updating Python dependencies"
source .venv/bin/activate
pip install -q -r requirements.txt

echo "==> Restarting service"
echo "    (appuser has no passwordless sudo configured — if this fails,"
echo "    run as root instead: systemctl restart phone-lookup-backend)"
sudo systemctl restart phone-lookup-backend
sleep 1
sudo systemctl --no-pager status phone-lookup-backend | head -5

echo "==> Health check"
curl -sf http://127.0.0.1:8000/health && echo " -> OK"
