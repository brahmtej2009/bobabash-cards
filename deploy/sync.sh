#!/usr/bin/env bash
# Push the dashboard code into LXC 140 and restart it. /var/lib/cards (database, uploads) is never touched,
# but it is snapshotted first.
#   bash deploy/sync.sh
set -euo pipefail
cd "$(dirname "$0")/../server"
PVE="${PVE:-root@192.168.1.64}"
CTID="${CTID:-140}"
TMP="$(mktemp -d)"

tar czf "$TMP/cards.tgz" --owner=0 --group=0 *.js schema.sql package.json package-lock.json public
scp -q "$TMP/cards.tgz" "$PVE:/tmp/cards.tgz"
ssh "$PVE" "pct push $CTID /tmp/cards.tgz /tmp/cards.tgz && rm /tmp/cards.tgz && pct exec $CTID -- bash -c '
  set -e
  /usr/local/bin/cards-backup
  cd /var/www/cards
  old=\$(sha1sum package-lock.json 2>/dev/null | cut -d\" \" -f1)
  rm -rf public
  tar xzf /tmp/cards.tgz --no-same-owner
  rm /tmp/cards.tgz
  # only reinstall packages when the lockfile changed (npm ci wipes node_modules first)
  if [ \"\$old\" != \"\$(sha1sum package-lock.json | cut -d\" \" -f1)\" ] || [ ! -d node_modules/express ]; then npm ci --omit=dev --silent --no-audit --no-fund; fi
  chown -R root:root /var/www/cards
  systemctl restart cards
  sleep 8
  systemctl is-active cards
  curl -s -o /dev/null -w \"local check: %{http_code}\n\" http://127.0.0.1:3002/
'"
rm -rf "$TMP"
