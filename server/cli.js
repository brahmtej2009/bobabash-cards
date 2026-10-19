#!/usr/bin/env node
// `cards`: run the event from a terminal. Talks to the same database as the dashboard.
const path = require('node:path');
const readline = require('node:readline');
const U = require('./util');
const core = require('./core');
const gh = require('./github');
const mail = require('./mail');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const db = require('./db').open(DATA_DIR);
mail.use(db);
const ACTOR = `cli:${process.env.SUDO_USER || process.env.USER || 'root'}`;

const HELP = `cards: Boba Bash event control

Organisers
  cards admin add <email> [--name "Riya"] [--role admin|desk] [--set]   new organiser (prints a password; --set to type one)
  cards admin passwd <email> [--set] | admin role <email> admin|desk | admin rm <email> | admin list

People
  cards add "<name>" [--email x] [--phone x] [--github x] [--tags a,b] [--team <id>] [--card next|<n>] [--pin 4821] [--checkin] [--allow-dupes]
  cards people [--here|--away|--nocard]
  cards show <person#>                  cards show card:<n>
  cards edit <person#> --name x --email x --phone x --github x --tags a,b --team <id|none>
  cards checkin <person#> | cards checkout <person#>
  cards points <person#> <+/-n> ["reason"]
  cards reset-account <person#>         they set up again
  cards passwd <person#> [--set]        set their password (prints one, --set to type it)
  cards disable <person#> | cards enable <person#> | cards delete <person#>

Cards
  cards give <person#> [<card#>|next] [--pin 4821] [--new-pin] [--second] [--replace]
  cards card add <card#> <pin>          a printed card from the box, not given yet
  cards import cards.csv [--overwrite]  many printed cards, one "card,pin" per line
  cards take <card#>                    unlink from its holder
  cards blanks <count>                  make blank cards, prints PINs
  cards pin <card#> [newpin] | cards off <card#> | cards on <card#> | cards unlock <card#>

Teams
  cards team add "<name>" [--place "Table 4"] | team list | team rm <id>
  cards team set <person#> <team id|none>
  cards team auto --size 4 [--scope unassigned|checked_in|tag:x] [--prefix Team]
  cards team points <team id> <+/-n> ["reason"]

Notifications
  cards notify <all|team:<id>|tag:<x>|people:<1,2,3>|checked_in|not_checked_in> "<title>" ["<body>"] [--email] [--urgent]

Event controls
  cards override <url> [--from "2026-10-24 18:00"] [--until "2026-10-24 22:00"] | cards override off
  cards lock [--until "2026-10-24 22:00"] | cards unlock-links
  cards tagroute <tag> <url|off>
  cards help-desk                       open help requests

Setup and status
  cards set <key> <value>    event_name, dashboard_url, card_base, redirect_repo, repo, project_template, splash_ms, inactive_url, announcement, wall_note
  cards settings | cards stats | cards sync | cards prs

Start fresh (once, right before the event)
  cards reset [--github] [--wipe-settings]   erases every person, card, team, message, tap and upload; organisers stay
`;

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[k] = next; i++; } else flags[k] = true;
  } else pos.push(a);
}

const out = (...a) => console.log(...a);
const ist = (t) => (t ? new Date(Number(t)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '-');
function when(v) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) throw new U.HttpError(400, 'Times look like "2026-10-24 22:00" (India time).');
  return Date.parse(`${m[1]}T${m[2].padStart(2, '0')}:${m[3]}:00+05:30`);
}
function ask(q, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}
async function typedPassword() {
  const a = await ask('Password: ', true);
  const b = await ask('Again: ', true);
  if (a !== b) throw new U.HttpError(400, 'Those don\'t match.');
  return U.cleanPassword(a);
}
const personId = (v) => core.mustPerson(db, Number(String(v || '').replace(/^#/, ''))).id;
const cardNo = (v) => core.mustCard(db, Number(String(v || '').replace(/^#/, ''))).id;
let dirty = false;

const SETTABLE = {
  event_name: (v) => U.cleanText(v, 80),
  dashboard_url: (v) => U.cleanUrl(v).replace(/\/$/, ''),
  card_base: (v) => U.cleanUrl(v).replace(/\/$/, ''),
  redirect_repo: (v) => v,
  repo: (v) => v,
  project_template: (v) => { if (!v.includes('{id}')) throw new U.HttpError(400, 'Needs {id} in it.'); return v; },
  splash_ms: (v) => String(Math.max(0, Math.min(15000, Math.round(Number(v)) || 0))),
  inactive_url: (v) => U.cleanUrl(v),
  announcement: (v) => U.cleanText(v, 300),
  wall_note: (v) => U.cleanText(v, 200),
};

function showPerson(id) {
  const p = core.mustPerson(db, id);
  const s = U.getSettings(db);
  const team = p.team_id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(p.team_id)?.name : null;
  out(`#${p.id} ${p.name}${p.disabled ? ' (disabled)' : ''}`);
  for (const [k, v] of Object.entries({ email: p.email, phone: p.phone, github: p.github, tags: p.tags, team, note: p.note })) if (v) out(`  ${k.padEnd(9)} ${v}`);
  out(`  account   ${p.password_hash ? `set up ${ist(p.claimed_at)}` : 'not set up'}`);
  out(`  here      ${p.checked_in_at ? `checked in ${ist(p.checked_in_at)}` : 'no'}`);
  out(`  points    ${p.points}`);
  for (const c of core.cardsOf(db, p.id)) {
    const r = U.resolve(c, p, s);
    out(`  card ${c.id}   ${c.status}, ${c.scans} taps → ${r.url || r.kind} (${r.reason || r.kind})`);
  }
  const got = db.prepare('SELECT i.name FROM handouts h JOIN items i ON i.id = h.item_id WHERE h.person_id = ?').all(p.id).map((r) => r.name);
  if (got.length) out(`  got       ${got.join(', ')}`);
}

async function main() {
  const [cmd, a1, a2, a3] = pos;
  switch (cmd) {
    case 'admin': {
      if (a1 === 'add') {
        const r = await core.createAdmin(db, { email: a2, name: flags.name, role: flags.role || 'admin', password: flags.set ? await typedPassword() : null }, ACTOR);
        out(`Added ${r.email} (${flags.role || 'admin'}).`);
        if (r.password) out(`Password: ${r.password}\nLog in at /admin and change it under Organisers.`);
      } else if (a1 === 'passwd') {
        const pw = await core.setAdminPassword(db, a2, flags.set ? await typedPassword() : null, ACTOR);
        out(pw ? `New password: ${pw}` : 'Password changed.');
      } else if (a1 === 'role') {
        if (!core.ROLES.includes(a3)) throw new U.HttpError(400, 'Role is admin or desk.');
        db.prepare('UPDATE admins SET role = ? WHERE email = ?').run(a3, U.cleanEmail(a2));
        U.audit(db, ACTOR, 'changed organiser role', {}, `${a2}: ${a3}`);
        out('Done.');
      } else if (a1 === 'rm') { core.removeAdmin(db, a2, ACTOR); out('Removed.'); }
      else if (a1 === 'list') {
        const rows = db.prepare('SELECT email, name, role FROM admins ORDER BY added_at').all();
        if (!rows.length) out('No organisers yet.');
        for (const r of rows) out(`${r.role.padEnd(6)} ${r.email}${r.name ? `  (${r.name})` : ''}`);
      } else out(HELP);
      return;
    }
    case 'add': {
      const id = core.createPerson(db, { name: a1, email: flags.email, phone: flags.phone, github: flags.github, tags: flags.tags, team_id: flags.team }, ACTOR, { allowDupes: !!flags['allow-dupes'] });
      out(`Added #${id} ${a1}`);
      if (flags.card) {
        const r = await core.issueCard(db, id, { cardId: flags.card === 'next' || flags.card === true ? null : flags.card, pin: flags.pin }, ACTOR);
        out(`Card ${r.id}, ${r.pin ? `PIN ${r.pin}` : 'PIN as printed'}, chip URL ${U.getSettings(db).card_base}/${r.id}`);
      }
      if (flags.checkin) core.setCheckin(db, id, true, ACTOR);
      dirty = true;
      break;
    }
    case 'people': {
      let rows = db.prepare('SELECT * FROM people ORDER BY id').all();
      if (flags.here) rows = rows.filter((p) => p.checked_in_at);
      if (flags.away) rows = rows.filter((p) => !p.checked_in_at);
      const cards = db.prepare('SELECT id, person_id FROM cards WHERE person_id IS NOT NULL').all();
      if (flags.nocard) rows = rows.filter((p) => !cards.some((c) => c.person_id === p.id));
      for (const p of rows) {
        const mine = cards.filter((c) => c.person_id === p.id).map((c) => c.id).join(',') || '-';
        out(`#${String(p.id).padEnd(4)} ${p.name.slice(0, 24).padEnd(24)} card ${mine.padEnd(6)} ${p.checked_in_at ? 'here' : '    '}  ${p.password_hash ? 'set up' : '      '}  ${String(p.points).padStart(4)} pts  ${p.tags || ''}`);
      }
      out(`${rows.length} people`);
      return;
    }
    case 'show': {
      if (String(a1).startsWith('card:')) {
        const c = core.mustCard(db, Number(a1.slice(5)));
        if (!c.person_id) { out(`Card ${c.id}: blank, ${c.scans} taps`); return; }
        showPerson(c.person_id);
      } else showPerson(personId(a1));
      return;
    }
    case 'edit': {
      const input = {};
      for (const k of ['name', 'email', 'phone', 'github', 'tags']) if (flags[k] !== undefined) input[k] = flags[k];
      if (flags.team !== undefined) input.team_id = flags.team === 'none' ? null : flags.team;
      core.updatePerson(db, personId(a1), input, ACTOR, { allowDupes: !!flags['allow-dupes'] });
      dirty = true;
      showPerson(personId(a1));
      break;
    }
    case 'checkin': core.setCheckin(db, personId(a1), true, ACTOR); out('Checked in.'); return;
    case 'checkout': core.setCheckin(db, personId(a1), false, ACTOR); out('Check-in undone.'); return;
    case 'points': core.addPoints(db, { personId: personId(a1) }, a2, a3, ACTOR); out(`Points now ${core.getPerson(db, personId(a1)).points}.`); return;
    case 'reset-account': core.resetAccount(db, personId(a1), ACTOR); out('They can set up again (card PIN, or the email the desk has).'); return;
    case 'passwd': {
      const id = personId(a1);
      const pw = flags.set ? await typedPassword() : core.randomPassword();
      db.prepare('UPDATE people SET password_hash = ?, claimed_at = COALESCE(claimed_at, ?), pw_fails = 0, pw_locked_until = 0 WHERE id = ?').run(await U.hashSecret(pw), U.now(), id);
      core.killSessions(db, id);
      U.audit(db, ACTOR, 'set their password', { person: id });
      out(flags.set ? 'Password set.' : `New password: ${pw}`);
      return;
    }
    case 'disable': { const id = personId(a1); db.prepare('UPDATE people SET disabled = 1 WHERE id = ?').run(id); core.killSessions(db, id); U.audit(db, ACTOR, 'disabled person', { person: id }); out('Disabled.'); return; }
    case 'enable': { const id = personId(a1); db.prepare('UPDATE people SET disabled = 0 WHERE id = ?').run(id); U.audit(db, ACTOR, 'enabled person', { person: id }); out('Enabled.'); return; }
    case 'delete': core.deletePerson(db, personId(a1), ACTOR); dirty = true; out('Deleted.'); break;
    case 'give': {
      const r = await core.issueCard(db, personId(a1), { cardId: a2 && a2 !== 'next' ? a2 : null, pin: flags.pin, newPin: !!flags['new-pin'], allowSecond: !!flags.second, replace: !!flags.replace }, ACTOR);
      out(`Card ${r.id} → #${personId(a1)}. ${r.pin ? `PIN ${r.pin}` : 'PIN as printed'}. Chip URL ${U.getSettings(db).card_base}/${r.id}`);
      dirty = true;
      break;
    }
    case 'take': core.unlinkCard(db, cardNo(a1), ACTOR); dirty = true; out('Card is blank again.'); break;
    case 'blanks': {
      const made = await core.makeBlankCards(db, Math.max(1, Math.min(300, Math.round(Number(a1)) || 0)), ACTOR);
      out('card,pin');
      for (const m of made) out(`${m.id},${m.pin}`);
      dirty = true;
      break;
    }
    case 'pin': out(`Card ${a1} PIN is now ${await core.newPin(db, cardNo(a1), ACTOR, a2)}`); return;
    case 'card': {
      if (a1 !== 'add') { out(HELP); return; }
      out(`Card ${await core.addCard(db, a2, pos[3], ACTOR)} added with its PIN.`);
      dirty = true;
      break;
    }
    case 'import': {
      const text = require('node:fs').readFileSync(a1, 'utf8');
      const r = await core.importCards(db, text, ACTOR, { overwrite: !!flags.overwrite });
      out(`${r.added.length} added, ${r.updated.length} PINs updated, ${r.skipped.length} already existed, ${r.errors.length} lines not understood`);
      for (const e of r.errors.slice(0, 10)) out(`  ? ${e}`);
      dirty = true;
      break;
    }
    case 'on':
    case 'off': {
      const id = cardNo(a1);
      db.prepare('UPDATE cards SET status = ? WHERE id = ?').run(cmd === 'on' ? 'active' : 'disabled', id);
      U.audit(db, ACTOR, cmd === 'on' ? 'switched card on' : 'switched card off', { card: id });
      dirty = true;
      out(cmd === 'on' ? 'Live.' : 'Switched off.');
      break;
    }
    case 'unlock': { const id = cardNo(a1); db.prepare('UPDATE cards SET pin_fails = 0, pin_locked_until = 0 WHERE id = ?').run(id); out('PIN lockout cleared.'); return; }
    case 'team': {
      if (a1 === 'add') {
        const id = Number(db.prepare('INSERT INTO teams (name, place, created_at) VALUES (?, ?, ?)').run(U.cleanText(a2, 60), U.cleanText(flags.place, 80) || null, U.now()).lastInsertRowid);
        U.audit(db, ACTOR, 'made team', {}, a2);
        out(`Team ${id}: ${a2}`);
      } else if (a1 === 'list') {
        for (const t of db.prepare('SELECT t.*, (SELECT COUNT(*) FROM people p WHERE p.team_id = t.id) n FROM teams t ORDER BY name').all()) out(`${String(t.id).padEnd(4)} ${t.name.padEnd(24)} ${t.n} people  ${t.points} pts  ${t.place || ''}`);
      } else if (a1 === 'rm') {
        db.prepare('UPDATE people SET team_id = NULL WHERE team_id = ?').run(Number(a2));
        db.prepare('DELETE FROM teams WHERE id = ?').run(Number(a2));
        out('Removed.');
      } else if (a1 === 'set') {
        core.updatePerson(db, personId(a2), { team_id: a3 === 'none' ? null : a3 }, ACTOR, { allowDupes: true });
        out('Done.');
      } else if (a1 === 'points') {
        core.addPoints(db, { teamId: Number(a2) }, a3, pos[4], ACTOR);
        out('Done.');
      } else if (a1 === 'auto') {
        let pool = db.prepare('SELECT * FROM people WHERE disabled = 0').all();
        const scope = String(flags.scope || 'unassigned');
        if (scope === 'unassigned') pool = pool.filter((p) => !p.team_id);
        else if (scope === 'checked_in') pool = pool.filter((p) => p.checked_in_at && !p.team_id);
        else if (scope.startsWith('tag:')) pool = pool.filter((p) => U.tagsOf(p).includes(scope.slice(4)) && !p.team_id);
        const size = Math.max(1, Number(flags.size) || 4);
        const count = Math.ceil(pool.length / size);
        if (!count) { out('Nobody to split.'); return; }
        const ids = [];
        for (let i = 1; ids.length < count; i++) {
          const name = `${flags.prefix || 'Team'} ${i}`;
          if (db.prepare('SELECT 1 FROM teams WHERE name = ?').get(name)) continue;
          ids.push(Number(db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run(name, U.now()).lastInsertRowid));
        }
        pool.sort(() => Math.random() - 0.5).forEach((p, i) => db.prepare('UPDATE people SET team_id = ? WHERE id = ?').run(ids[i % ids.length], p.id));
        U.audit(db, ACTOR, 'auto-split teams', {}, `${pool.length} people into ${ids.length} teams`);
        out(`${pool.length} people into ${ids.length} teams.`);
      } else out(HELP);
      return;
    }
    case 'notify': {
      const [kind, target] = String(a1 || '').includes(':') ? [a1.split(':')[0], a1.split(':').slice(1).join(':')] : [a1, null];
      if (!['all', 'team', 'tag', 'people', 'checked_in', 'not_checked_in'].includes(kind)) throw new U.HttpError(400, 'Who: all, team:<id>, tag:<x>, people:<1,2>, checked_in, not_checked_in');
      if (!a2) throw new U.HttpError(400, 'Give a title.');
      const id = Number(db.prepare('INSERT INTO notices (ts, title, body, target_kind, target, urgent, by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(U.now(), U.cleanText(a2, 140), a3 || null, kind, target, flags.urgent ? 1 : 0, ACTOR).lastInsertRowid);
      U.audit(db, ACTOR, 'sent notification', {}, a2);
      out(`Notification ${id} posted.`);
      if (flags.email) {
        const { noticeVisible } = { noticeVisible: (n, p) => ({ all: true, team: String(p.team_id) === String(n.target), tag: U.tagsOf(p).includes(String(n.target)), people: String(n.target).split(',').includes(String(p.id)), checked_in: !!p.checked_in_at, not_checked_in: !p.checked_in_at })[n.target_kind] };
        const to = db.prepare('SELECT * FROM people WHERE disabled = 0 AND email IS NOT NULL').all().filter((p) => noticeVisible({ target_kind: kind, target }, p));
        const link = U.getSettings(db).dashboard_url ? `${U.getSettings(db).dashboard_url}/me` : '';
        let sent = 0;
        for (const p of to) { try { await mail.sendNotice(p.email, a2, a3, link); sent++; } catch (e) { out(`  mail to ${p.email} failed: ${e.message}`); } }
        db.prepare('UPDATE notices SET emailed = ? WHERE id = ?').run(sent, id);
        out(`Emailed ${sent} of ${to.length}.`);
      }
      return;
    }
    case 'help-desk': {
      const rows = db.prepare("SELECT h.*, p.name FROM help h LEFT JOIN people p ON p.id = h.person_id WHERE h.status != 'done' ORDER BY h.ts").all();
      if (!rows.length) out('No open requests.');
      for (const h of rows) out(`${String(h.id).padEnd(4)} ${ist(h.ts)}  ${h.status.padEnd(7)} #${h.person_id} ${h.name}  [${h.kind}] ${h.message || ''}`);
      return;
    }
    case 'override': {
      if (a1 === 'off') U.setSettings(db, { override_on: '0' });
      else U.setSettings(db, { override_on: '1', override_url: U.cleanUrl(a1), override_from: flags.from ? when(flags.from) : '', override_until: flags.until ? when(flags.until) : '' });
      U.audit(db, ACTOR, a1 === 'off' ? 'all-cards link off' : 'all-cards link on', {}, a1);
      dirty = true;
      out(a1 === 'off' ? 'Override off.' : `Every card → ${U.cleanUrl(a1)}${flags.from ? ` from ${flags.from}` : ''}${flags.until ? ` until ${flags.until}` : ''}`);
      break;
    }
    case 'lock': U.setSettings(db, { lock_on: '1', unlock_at: flags.until ? when(flags.until) : '' }); U.audit(db, ACTOR, 'locked owner links'); dirty = true; out(`Owner links locked${flags.until ? ` until ${flags.until}` : ''}.`); break;
    case 'unlock-links': U.setSettings(db, { lock_on: '0' }); U.audit(db, ACTOR, 'opened owner links'); dirty = true; out('Owners can change their links now.'); break;
    case 'tagroute': {
      const rules = U.parseJson(U.getSettings(db).tag_overrides, {});
      const tag = core.cleanTags(a1);
      if (!tag) throw new U.HttpError(400, 'Give a tag.');
      if (a2 === 'off') delete rules[tag]; else rules[tag] = U.cleanUrl(a2);
      U.setSettings(db, { tag_overrides: JSON.stringify(rules) });
      U.audit(db, ACTOR, 'changed tag route', {}, `${tag}: ${a2}`);
      dirty = true;
      out(a2 === 'off' ? `Cards tagged ${tag} follow their own links again.` : `Cards tagged ${tag} → ${rules[tag]}`);
      break;
    }
    case 'set': {
      if (!SETTABLE[a1]) throw new U.HttpError(400, `Settable: ${Object.keys(SETTABLE).join(', ')}`);
      const v = SETTABLE[a1](pos.slice(2).join(' '));
      U.setSettings(db, { [a1]: v });
      U.audit(db, ACTOR, 'changed settings', {}, { [a1]: v });
      dirty = true;
      out(`${a1} = ${v}`);
      break;
    }
    case 'settings': {
      const s = U.getSettings(db);
      for (const k of ['event_name', 'card_base', 'redirect_repo', 'repo', 'project_template', 'dashboard_url', 'splash_ms', 'inactive_url', 'announcement']) out(`${k.padEnd(17)} ${s[k] || '-'}`);
      out(`${'override'.padEnd(17)} ${U.overrideActive(s) ? `ON → ${s.override_url}` : s.override_on === '1' ? `scheduled → ${s.override_url} (${ist(s.override_from)} to ${ist(s.override_until)})` : 'off'}`);
      out(`${'owner links'.padEnd(17)} ${U.globalLocked(s) ? `locked${s.unlock_at ? ` until ${ist(s.unlock_at)}` : ''}` : 'open'}`);
      out(`${'tag routes'.padEnd(17)} ${s.tag_overrides}`);
      out(`${'github'.padEnd(17)} last sync ${ist(s.last_publish)}${s.last_publish_error ? `, problem: ${s.last_publish_error}` : ''}`);
      return;
    }
    case 'stats': {
      const n = (sql, ...a) => db.prepare(sql).get(...a).n;
      out(`people      ${n('SELECT COUNT(*) n FROM people')}`);
      out(`here        ${n('SELECT COUNT(*) n FROM people WHERE checked_in_at IS NOT NULL')}`);
      out(`set up      ${n('SELECT COUNT(*) n FROM people WHERE password_hash IS NOT NULL')}`);
      out(`cards       ${n('SELECT COUNT(*) n FROM cards')} (${n('SELECT COUNT(*) n FROM cards WHERE person_id IS NULL')} blank)`);
      out(`teams       ${n('SELECT COUNT(*) n FROM teams')}`);
      out(`help open   ${n("SELECT COUNT(*) n FROM help WHERE status != 'done'")}`);
      out(`taps 24h    ${n('SELECT COUNT(*) n FROM scans WHERE ts > ?', U.now() - 86400e3)}`);
      out(`taps total  ${n('SELECT COALESCE(SUM(scans),0) n FROM cards')}`);
      return;
    }
    case 'reset': {
      const reset = require('./reset');
      if (!process.stdin.isTTY) throw new U.HttpError(400, 'Run this in a real terminal. It asks questions.');
      const c = reset.counts(db);
      out('START FRESH');
      out(`This erases ${c.people} people, ${c.cards} cards, ${c.teams} teams, ${c.messages} messages, ${c.schedule} schedule items,`);
      out(`${c.help} help requests, ${c.handout_items} handout items, ${c.taps} taps, ${c.uploads} uploads and ${c.log_entries} log entries.`);
      out(`Organisers stay. ${flags['wipe-settings'] ? 'Settings are wiped too.' : 'Setup (hosts, repos, texts) stays.'} ${flags.github ? 'GitHub card pages, profiles and card folders get deleted.' : 'GitHub is left alone (add --github to clean it).'}`);
      out('A backup is written to /var/lib/cards/backups first.\n');
      if ((await ask(`Type ${reset.PHRASE} to continue: `)).trim() !== reset.PHRASE) { out('Not reset.'); return; }
      if ((await ask('Really? Type erase: ')).trim() !== 'erase') { out('Not reset.'); return; }
      const r = reset.wipe(db, DATA_DIR, { keepSettings: !flags['wipe-settings'], actor: ACTOR });
      out(`Done. Backup: ${r.backup}`);
      if (flags.github) out(`GitHub: ${JSON.stringify(await gh.clearRepos(db))}`);
      return;
    }
    case 'sync': out(JSON.stringify(await gh.syncAll(db, DATA_DIR), null, 1)); return;
    case 'prs': out(JSON.stringify(await gh.syncPrs(db, U.getSettings(db).repo))); return;
    default: out(HELP); return;
  }
  if (dirty && gh.hasToken()) {
    const r = await gh.syncAll(db, DATA_DIR);
    out(r.errors?.length ? `GitHub sync problem: ${r.errors.join(' ')}` : 'Pushed to GitHub.');
  }
}

main().catch((e) => {
  console.error(e instanceof U.HttpError ? e.message : e);
  process.exit(1);
});
