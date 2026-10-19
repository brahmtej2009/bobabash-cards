#!/usr/bin/env bash
# One-time setup of the cards dashboard inside LXC 140 on paid6. Safe to re-run: never touches data or the env file.
#   bash deploy/setup-server.sh
set -euo pipefail
PVE="${PVE:-$(cat "$(dirname "$0")/.host" 2>/dev/null)}"; [ -n "$PVE" ] || { echo "Put root@<proxmox-host> in deploy/.host (gitignored) or set PVE"; exit 1; }
CTID="${CTID:-140}"

ssh "$PVE" "pct exec $CTID -- bash -s" <<'REMOTE'
set -euo pipefail
id cards >/dev/null 2>&1 || useradd --system --home /var/lib/cards --shell /usr/sbin/nologin cards
mkdir -p /var/www/cards /var/lib/cards /var/backups/cards
chown cards:cards /var/lib/cards
chmod 750 /var/lib/cards

if [ ! -f /etc/cards.env ]; then
  umask 077
  cat > /etc/cards.env <<'ENV'
CARDS_PORT=3102
CARDS_HOST=127.0.0.1
DATA_DIR=/var/lib/cards
# Gmail: an App Password (Google account > Security > App passwords), not the real password.
SMTP_USER=
SMTP_PASS=
# Fine-grained token for the bobabash org: Contents + Pull requests read/write on the two repos.
GITHUB_TOKEN=
ENV
  echo "Wrote /etc/cards.env. Fill in SMTP_* and GITHUB_TOKEN."
fi

cat > /etc/systemd/system/cards.service <<'UNIT'
[Unit]
Description=Boba Bash cards dashboard
After=network-online.target

[Service]
EnvironmentFile=/etc/cards.env
WorkingDirectory=/var/www/cards
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
User=cards
Group=cards
Restart=always
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/cards
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=yes

[Install]
WantedBy=multi-user.target
UNIT

# `cards` terminal command: runs as the service user with the same config
cat > /usr/local/bin/cards <<'SH'
#!/bin/sh
set -a; . /etc/cards.env; set +a
exec runuser -u cards -- /usr/bin/node --disable-warning=ExperimentalWarning /var/www/cards/cli.js "$@"
SH
chmod 755 /usr/local/bin/cards
ln -sf /usr/local/bin/cards /usr/bin/cards

# nightly consistent snapshot, last 30 kept
cat > /usr/local/bin/cards-backup <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ -f /var/lib/cards/cards.db ] || exit 0
out=/var/backups/cards/cards-$(date +%F-%H%M).db
runuser -u cards -- node --disable-warning=ExperimentalWarning -e "new (require('node:sqlite').DatabaseSync)('/var/lib/cards/cards.db').exec(\"VACUUM INTO '/var/lib/cards/.snapshot.db'\")"
mv /var/lib/cards/.snapshot.db "$out"
tar czf "${out%.db}-uploads.tgz" -C /var/lib/cards uploads 2>/dev/null || true
ls -1t /var/backups/cards/cards-*.db | tail -n +31 | xargs -r rm --
ls -1t /var/backups/cards/cards-*-uploads.tgz 2>/dev/null | tail -n +31 | xargs -r rm --
SH
chmod 755 /usr/local/bin/cards-backup
cat > /etc/systemd/system/cards-backup.service <<'UNIT'
[Unit]
Description=Snapshot the cards database
[Service]
Type=oneshot
ExecStart=/usr/local/bin/cards-backup
UNIT
cat > /etc/systemd/system/cards-backup.timer <<'UNIT'
[Unit]
Description=Nightly cards snapshot
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable cards cards-backup.timer >/dev/null
systemctl start cards-backup.timer
echo "Setup done."
REMOTE
