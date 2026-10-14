# Boba Bash cards + event HQ

NFC cards whose link never changes, plus everything needed to run the event, from one dashboard.

```
phone taps card ──> bobabash.github.io/17            host 1: redirect repo (GitHub Pages), on the chip forever
                      │  logo for 5 s
                      ├─ asks the dashboard live: where does 17 go?   host 3: this server, LXC 140 on paid6
                      └─ dashboard unreachable? reads map.json from the same repo
                      ▼
                    bobabash.github.io/sites/17/       host 2: sites repo, everyone's project (default)
                    bobabash.github.io/p/<person>/     their profile page (if they picked it)
                    any other link                     their own link / organiser override
```

## What's in the dashboard

**People, not just cards.** A person can be registered with or without a card, get a card later, swap a lost one, or (admin exception) hold two. Email is the login and is unique. Phone and GitHub are unique unless an admin ticks "allow duplicates".

| Organisers (`/admin`) | People (`/me`) |
| --- | --- |
| Desk: register + card + check-in + handouts in one form, quick check-in search | Set up with card + PIN, or with the email the desk registered |
| People table with filters and bulk actions (check in, team, tags, handouts, points, disable) | Home: now/next, card, team, points, what they've collected, inbox |
| Person drawer: details, cards, routing, handouts, points, account, help, messages, taps, history | Card: project / profile / own link, splash line, QR, tap stats, PR status |
| Teams: create, colour, table, notes, random split, team points | Profile page: photo, bio, 12 links, socials, 6 themes, "Save my contact" vCard |
| Notify: everyone, checked in, a team, a tag, or picked people; urgent pinning; email copy; read counts | Team: name, table, note, members with profiles |
| Schedule (IST), help desk queue, handout tracking with stock | Schedule, inbox, help requests with replies, guide, account |
| Cards: routing, PINs, lockouts, bulk; Control: all-cards link with window, lock, tag routes | |
| Stats, PRs (merge/close), instructions with uploads, activity log, CSV/JSON export | |

`/wall` is the projector screen: live taps, people here, now/next, team leaderboard, latest announcement.

## Where a tap goes (first match wins)

1. All-cards link inside its time window, unless the card ignores it
2. Card switched off
3. Card has no holder → "Not live yet" or the blank-cards link
4. Organiser override on that card
5. Tag route for one of the holder's tags
6. Links unlocked and the holder picked profile or own link
7. Project page `bobabash.github.io/sites/<card>/`

## Running locally

```bash
cd server && npm install && cd ..
node server/cli.js admin add you@example.com
node dev.cjs
```

http://localhost:3002/admin. Without mail settings, codes print in the terminal and fill themselves in.

## Deploying (LXC 140 on paid6)

```bash
bash deploy/setup-server.sh   # once: user, service, `cards` command, nightly backups
bash deploy/sync.sh           # every change
```

Then in the container: fill `/etc/cards.env` (Gmail app password, GitHub token), `systemctl restart cards`, `cards admin add you@email.com --set`. The tunnel points the dashboard domain at `http://localhost:3002`. Run `cards` for every terminal command.
