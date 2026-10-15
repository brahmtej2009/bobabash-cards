#!/usr/bin/env bash
# Runs inside LXC 140. Unpacks a bundle made by deploy/sync.sh and switches the dashboard over.
# Data in /var/lib/cards is never touched (it's snapshotted first).
set -euo pipefail
BUNDLE="${1:?bundle path}"
STAGE="$(mktemp -d)"
tar xzf "$BUNDLE" -C "$STAGE" --no-same-owner
rm -f "$BUNDLE"

[ -x /usr/local/bin/cards-backup ] && /usr/local/bin/cards-backup || true

# ---- app ----
cd /var/www/cards
old_lock="$(sha1sum package-lock.json 2>/dev/null | cut -d' ' -f1 || true)"
rm -rf public
cp -a "$STAGE"/server/. /var/www/cards/
# npm ci wipes node_modules first, so only run it when the lockfile changed
if [ "$old_lock" != "$(sha1sum package-lock.json | cut -d' ' -f1)" ] || [ ! -d node_modules/express ]; then
  npm ci --omit=dev --silent --no-audit --no-fund
fi
chown -R root:root /var/www/cards

# ---- node stays internal on 3102, nginx owns 3002 with TLS ----
if grep -q '^CARDS_PORT=3002$' /etc/cards.env; then sed -i 's/^CARDS_PORT=3002$/CARDS_PORT=3102/' /etc/cards.env; fi
grep -q '^CARDS_PORT=' /etc/cards.env || echo 'CARDS_PORT=3102' >> /etc/cards.env

mkdir -p /var/www/cards-down
cp "$STAGE"/deploy/down.html /var/www/cards-down/index.html
if ! cmp -s "$STAGE"/deploy/nginx-cards.conf /etc/nginx/sites-available/cards 2>/dev/null; then
  cp "$STAGE"/deploy/nginx-cards.conf /etc/nginx/sites-available/cards
  ln -sf /etc/nginx/sites-available/cards /etc/nginx/sites-enabled/cards
  nginx_changed=1
fi
rm -rf "$STAGE"

systemctl restart cards
if [ "${nginx_changed:-0}" = 1 ]; then nginx -t && systemctl reload nginx; fi

# wait for the app (this host can be slow to start node)
for _ in $(seq 1 45); do curl -s -o /dev/null http://127.0.0.1:3102/ && break; sleep 2; done
systemctl is-active cards
curl -sk -o /dev/null -w "https check: %{http_code}\n" https://127.0.0.1:3002/
