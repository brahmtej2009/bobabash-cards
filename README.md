# Boba Bash cards + event HQ

NFC cards whose link never changes, plus everything needed to run a hackathon from one dashboard. Built for Hack Club's Boba Bash Greater Noida (24 Oct 2026).

Live at **[cards.boba-bash.xyz](https://cards.boba-bash.xyz)**: `/me` for attendees, `/admin` for organisers, `/wall` for the projector.

## How a tap works

```
phone taps card ──> bobabash.github.io/17           host 1: redirect repo (GitHub Pages), on the chip forever
                      │  Boba Bash logo for 5 s
                      ├─ asks the dashboard live: where does 17 go?   host 3: this server (self-hosted)
                      └─ dashboard unreachable? reads map.json from the same repo
                      ▼
                    bobabash.github.io/sites/17/       host 2: sites repo, everyone's project (default)
                    any other link                     the holder's own link, or an organiser override
```

| Host | Repo | What lives there |
| --- | --- | --- |
| 1 | [bobabash/bobabash.github.io](https://github.com/bobabash/bobabash.github.io) | `card.html`, `go.js`, `map.json`, one `<n>/index.html` per card. Written by the dashboard. |
| 2 | [bobabash/sites](https://github.com/bobabash/sites) | One folder per card. Attendees send PRs that touch only their own folder (a check enforces it). |
| 3 | this repo | The dashboard: Node 22 + SQLite, self-hosted behind nginx and a Cloudflare tunnel. |

The chip only ever holds `bobabash.github.io/<n>`, so a card can be repointed, switched off or handed to someone else without rewriting it.

### Where a tap goes (first match wins)

1. All-cards link inside its time window, unless the card ignores it
2. Card switched off
3. Card has no holder → "Not live yet", or the blank-cards link
4. Organiser override on that card
5. Tag route for one of the holder's tags
6. Links unlocked and the holder picked their own link
7. Project page `bobabash.github.io/sites/<card>/`

## Features

**People, not just cards.** A person can be registered with or without a card, get one later, swap a lost one, or (admin exception) hold two. Email is the login and is unique; phone and GitHub are unique unless an admin ticks "allow duplicates". Cards are printed in advance with a number and PIN; the desk types both in while registering someone.

| Organisers (`/admin`) | Attendees (`/me`) |
| --- | --- |
| Desk: register + card + PIN + check-in + handouts in one form, next free card filled in | Set up with card number + PIN + email, or with just the email the desk registered |
| People table with filters and bulk actions; person drawer with cards, routing, password reset, history | Home: their card and QR on the left, live notifications on the right |
| Cards: add printed cards one by one or in bulk, set any PIN, give a card to someone, lockouts | Live messages with a ding and browser pop-ups |
| Teams: members, colours, tables, notes, history, points, message a team, clear all teams | My card: project or any link, the line shown while loading, QR downloads, tap stats, PR status |
| Notify everyone, a team, a tag, checked-in people or picked people; urgent pinning; email copy | Team, schedule, help requests with replies, guide, password |
| Schedule (IST), help desk queue, handouts with stock, points | |
| Control: send every card somewhere for a while, lock links, tag routes | |
| Stats, PRs (merge/close), instructions with uploads, activity log, CSV/JSON export | |
| Setup: the three hosts, GitHub sync, outgoing mail (SMTP), guarded "Start fresh" reset | |

`/wall` is the projector screen: live taps, people here, now/next, team leaderboard, latest announcement.

## Running locally

```bash
cd server && npm install && cd ..
node server/cli.js admin add you@example.com
node dev.cjs
```

Open http://localhost:3002/admin. Without mail settings, codes print in the terminal and fill themselves in.

## Deploying

The dashboard runs in a Linux container (LXC) on a Proxmox host. Put `root@<proxmox-host>` in `deploy/.host` (gitignored), then:

```bash
bash deploy/setup-server.sh   # once: user, systemd service, nginx, `cards` command, nightly backups
bash deploy/sync.sh           # every change: copies the code in, restarts, checks health
```

In the container:

- `/etc/cards.env` holds `GITHUB_TOKEN` (fine-grained, Contents + Pull requests read/write on the two repos). It can also hold `SMTP_HOST/PORT/USER/PASS`, but mail is easier to set in **Setup → Outgoing mail**.
- `cards admin add you@email.com --set` makes the first organiser.
- nginx serves HTTPS on 3002 with a Cloudflare origin certificate; node listens on 127.0.0.1:3102. The tunnel points the public domain at `https://localhost:3002` (No TLS Verify).
- Run `cards` for every terminal command (people, cards, notify, admins, backups).

### Mail

Setup → Outgoing mail takes any SMTP account. For Zoho: server `smtp.zoho.in` (or `.com` / `.eu`, matching where the account lives), port 465, the full address as login, and an app password from Zoho → Security → App passwords. The password is stored server-side only and is never sent back to the browser or included in exports.

## Security notes

- Sessions are random tokens stored hashed; cookies are `__Host-`, HttpOnly, Secure, SameSite=Lax.
- PINs and passwords are scrypt-hashed. Wrong PINs and passwords lock out for 15 minutes; every public endpoint is rate limited.
- CSRF: an Origin check plus JSON-only bodies. Strict CSP, no inline scripts, and all page content is built as DOM text, never HTML strings.
- No secrets live in this repo. Tokens and passwords sit in `/etc/cards.env` or the server database, both outside git.

## Layout

```
server/
  server.js   infra, sessions, public routes, wall
  owner.js    /api/me (attendees), live event stream
  admin.js    /api/admin (organisers)
  core.js     people, cards and organiser operations shared with the CLI
  github.js   commits to the two repos through the git data API
  mail.js     SMTP
  cli.js      the `cards` command
  public/     pages and static files
deploy/       container setup, sync, nginx config
```
