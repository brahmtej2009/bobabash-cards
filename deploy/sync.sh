#!/usr/bin/env bash
# Push the dashboard (app + nginx config) into LXC 140 and switch over.
# The database in /var/lib/cards is never touched, but it is snapshotted first.
#   bash deploy/sync.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PVE="${PVE:-$(cat "$(dirname "$0")/.host" 2>/dev/null)}"; [ -n "$PVE" ] || { echo "Put root@<proxmox-host> in deploy/.host (gitignored) or set PVE"; exit 1; }
CTID="${CTID:-140}"
TMP="$(mktemp -d)"

tar czf "$TMP/cards.tgz" --owner=0 --group=0 \
  server/*.js server/schema.sql server/package.json server/package-lock.json server/public \
  deploy/install.sh deploy/nginx-cards.conf deploy/down.html
scp -q "$TMP/cards.tgz" deploy/install.sh "$PVE:/tmp/"
ssh "$PVE" "pct push $CTID /tmp/cards.tgz /tmp/cards.tgz && pct push $CTID /tmp/install.sh /tmp/cards-install.sh && rm /tmp/cards.tgz /tmp/install.sh && pct exec $CTID -- bash /tmp/cards-install.sh /tmp/cards.tgz && pct exec $CTID -- rm -f /tmp/cards-install.sh"
rm -rf "$TMP"
