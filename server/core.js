// People, cards and organisers: the operations shared by the web server and the `cards` terminal command.
const U = require('./util');

const { now, fail } = U;

// last 10 digits, so +91 98xxx and 98xxx match
const phoneDigits = (p) => String(p || '').replace(/\D/g, '').slice(-10) || '';
const cleanTags = (v) => [...new Set(String(Array.isArray(v) ? v.join(',') : v ?? '').split(',').map((t) => t.trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '')).filter(Boolean))].slice(0, 12).join(',');
const nextCardId = (db) => (db.prepare('SELECT MAX(id) AS m FROM cards').get().m || 0) + 1;

// The number the desk hands out next: the smallest card nobody holds yet
// (a printed card already in the system, or one that isn't in it yet). Switched-off cards are skipped.
function nextFreeCard(db) {
  const taken = new Set(db.prepare("SELECT id FROM cards WHERE person_id IS NOT NULL OR status = 'disabled'").all().map((r) => r.id));
  let n = 1;
  while (taken.has(n)) n++;
  return n;
}

const getPerson = (db, id) => db.prepare('SELECT * FROM people WHERE id = ?').get(Number(id));
const getCard = (db, id) => db.prepare('SELECT * FROM cards WHERE id = ?').get(Number(id));
const cardsOf = (db, personId) => db.prepare('SELECT * FROM cards WHERE person_id = ? ORDER BY id').all(personId);
const killSessions = (db, personId) => db.prepare("DELETE FROM sessions WHERE kind = 'owner' AND subject = ?").run(String(personId));

function mustPerson(db, id) {
  const p = getPerson(db, id);
  if (!p) fail(404, `No person #${id}.`);
  return p;
}
function mustCard(db, id) {
  const c = getCard(db, id);
  if (!c) fail(404, `Card ${id} doesn't exist.`);
  return c;
}

// One person, one identity: the same email always blocks (it's the login), phone and GitHub block unless allowed.
function checkDupes(db, { email, phone, github }, exceptId, allow) {
  if (email) {
    const p = db.prepare('SELECT id, name FROM people WHERE email = ? AND id IS NOT ?').get(email, exceptId ?? null);
    if (p) fail(409, `${p.name} (#${p.id}) already uses that email.`);
  }
  if (allow) return;
  const key = phoneDigits(phone);
  if (key) {
    const p = db.prepare('SELECT id, name, phone FROM people WHERE phone IS NOT NULL AND id IS NOT ?').all(exceptId ?? null).find((r) => phoneDigits(r.phone) === key);
    if (p) fail(409, `${p.name} (#${p.id}) already has that phone. Tick "allow duplicates" if that's right.`);
  }
  if (github) {
    const p = db.prepare('SELECT id, name FROM people WHERE lower(github) = lower(?) AND id IS NOT ?').get(github, exceptId ?? null);
    if (p) fail(409, `${p.name} (#${p.id}) already has that GitHub. Tick "allow duplicates" if that's right.`);
  }
}

function personFields(input, partial) {
  const f = {};
  const has = (k) => !partial || k in input;
  if (has('name')) {
    f.name = U.cleanText(input.name, 120);
    if (!f.name) fail(400, 'Add a name.');
  }
  if (has('email')) f.email = U.cleanEmail(input.email) || null;
  if (has('phone')) f.phone = U.cleanText(input.phone, 40) || null;
  if (has('github')) f.github = U.cleanGithub(input.github) || null;
  if (has('note')) f.note = U.cleanText(input.note, 1000) || null;
  if (has('tags')) f.tags = cleanTags(input.tags) || null;
  if (has('team_id')) {
    f.team_id = input.team_id ? Number(input.team_id) : null;
    if (f.team_id && !Number.isInteger(f.team_id)) fail(400, 'Bad team.');
  }
  return f;
}

function createPerson(db, input, actor, { allowDupes = false } = {}) {
  const f = personFields(input, false);
  checkDupes(db, f, null, allowDupes);
  const r = db.prepare(`INSERT INTO people (name, email, phone, github, note, tags, team_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(f.name, f.email, f.phone, f.github, f.note, f.tags, f.team_id, actor, now());
  const id = Number(r.lastInsertRowid);
  U.audit(db, actor, 'added person', { person: id }, f.name);
  return id;
}

function updatePerson(db, id, input, actor, { allowDupes = false } = {}) {
  const p = mustPerson(db, id);
  const f = personFields(input, true);
  checkDupes(db, { email: f.email, phone: 'phone' in f ? f.phone : null, github: 'github' in f ? f.github : null }, p.id, allowDupes);
  if ('email' in f && f.email !== p.email) { f.email_verified = 0; killSessions(db, p.id); }
  const keys = Object.keys(f);
  if (!keys.length) return p;
  db.prepare(`UPDATE people SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), p.id);
  const teamMoved = 'team_id' in f && (f.team_id ?? null) !== (p.team_id ?? null);
  const rest = { ...f };
  delete rest.team_id;
  if (Object.keys(rest).length) U.audit(db, actor, 'edited person', { person: p.id }, rest);
  if (teamMoved) {
    const name = (tid) => db.prepare('SELECT name FROM teams WHERE id = ?').get(tid)?.name || `team ${tid}`;
    if (p.team_id) U.audit(db, actor, `left ${name(p.team_id)}`, { person: p.id, team: p.team_id }, p.name);
    if (f.team_id) U.audit(db, actor, `joined ${name(f.team_id)}`, { person: p.id, team: f.team_id }, p.name);
  }
  return getPerson(db, p.id);
}

// PINs are printed on the cards; organisers can also pick their own. 4 to 8 digits.
function cleanPin(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{4,8}$/.test(s)) fail(400, 'A PIN is 4 to 8 digits.');
  return s;
}

async function setPinHash(db, id, pin) {
  db.prepare('UPDATE cards SET pin_hash = ?, pin_fails = 0, pin_locked_until = 0 WHERE id = ?').run(await U.hashSecret(pin), id);
}

// Give a person a card. cardId empty = the next number. pin = the PIN printed on the card (or one you choose);
// without it a new card gets a random PIN and an existing card keeps the one it has (unless newPin).
// A second card for the same person only with allowSecond.
async function issueCard(db, personId, { cardId, pin: wanted, newPin = false, allowSecond = false, replace = false } = {}, actor) {
  const person = mustPerson(db, personId);
  const held = cardsOf(db, person.id);
  if (held.length && !allowSecond) fail(409, `${person.name} already has card ${held.map((c) => c.id).join(', ')}. Tick "allow a second card" to give another.`);
  const id = cardId ? U.cardId(cardId) : nextFreeCard(db);
  let card = getCard(db, id);
  if (card && card.person_id && card.person_id !== person.id) {
    if (!replace) {
      const other = getPerson(db, card.person_id);
      fail(409, `Card ${id} belongs to ${other?.name || 'someone'}.`);
    }
    U.audit(db, actor, 'took card from previous holder', { card: id, person: card.person_id });
  }
  const pinGiven = wanted != null && String(wanted).trim() !== '';
  const pin = pinGiven ? cleanPin(wanted) : !card || newPin ? U.randomDigits(4) : null;
  if (!card) db.prepare('INSERT INTO cards (id, pin_hash, created_at) VALUES (?, ?, ?)').run(id, await U.hashSecret(pin), now());
  else if (pin) await setPinHash(db, id, pin);
  db.prepare("UPDATE cards SET person_id = ?, status = 'active', linked_at = ? WHERE id = ?").run(person.id, now(), id);
  U.audit(db, actor, card ? 'gave card' : 'made and gave card', { card: id, person: person.id }, `${person.name}${pinGiven ? ', PIN as printed' : ''}`);
  const crew = joinCrew(db, person.id, getCard(db, id).crew, actor);
  return { id, pin, made: !card, pin_from_card: pinGiven, crew };
}

const CREW_COLORS = { club: '#3f9b6b', spade: '#3d4a8f', heart: '#e0435a', diamond: '#f08a24', sol: '#f2c14e', luna: '#7a8fd6', jester: '#9b59b6' };
// The crew printed on a card is a team: the holder joins it unless an organiser already put them on one.
function joinCrew(db, personId, crew, actor) {
  if (!crew) return null;
  const p = getPerson(db, personId);
  let team = db.prepare('SELECT * FROM teams WHERE lower(name) = lower(?)').get(crew);
  if (!team) {
    const color = CREW_COLORS[crew.toLowerCase()] || null;
    const id = Number(db.prepare('INSERT INTO teams (name, color, created_at) VALUES (?, ?, ?)').run(crew, color, now()).lastInsertRowid);
    team = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
    U.audit(db, actor, 'made crew team', { team: team.id }, crew);
  }
  if (!p.team_id) {
    db.prepare('UPDATE people SET team_id = ? WHERE id = ?').run(team.id, p.id);
    U.audit(db, actor, `joined ${team.name} (crew on their card)`, { person: p.id, team: team.id });
  }
  return team.name;
}

// Wrong card handed out, or a lost one replaced: move the person from one card number to another.
async function swapCard(db, personId, fromId, toId, pin, actor) {
  const person = mustPerson(db, personId);
  const from = mustCard(db, fromId);
  if (from.person_id !== person.id) fail(400, `Card ${from.id} isn't ${person.name}'s.`);
  if (Number(toId) === from.id) fail(400, 'That\'s the same card.');
  const r = await issueCard(db, person.id, { cardId: toId, pin, allowSecond: true }, actor);
  unlinkCard(db, from.id, actor);
  U.audit(db, actor, `moved from card ${from.id} to card ${r.id}`, { person: person.id, card: r.id });
  return r;
}

function unlinkCard(db, cardId, actor) {
  const c = mustCard(db, cardId);
  db.prepare('UPDATE cards SET person_id = NULL, admin_url = NULL, lock_mode = \'global\', skip_override = 0, linked_at = NULL WHERE id = ?').run(c.id);
  U.audit(db, actor, 'took card back', { card: c.id, person: c.person_id });
}

// pin given = set exactly that; empty = a random one. Returns the PIN.
async function newPin(db, id, actor, wanted) {
  const c = mustCard(db, id);
  const chosen = wanted != null && String(wanted).trim() !== '';
  const pin = chosen ? cleanPin(wanted) : U.randomDigits(4);
  await setPinHash(db, c.id, pin);
  U.audit(db, actor, chosen ? 'set the PIN' : 'issued a new PIN', { card: c.id, person: c.person_id });
  return pin;
}

// A pre-printed card from the box, not given to anyone yet.
async function addCard(db, id, pin, actor) {
  id = U.cardId(id);
  pin = cleanPin(pin);
  if (getCard(db, id)) fail(409, `Card ${id} already exists. Change its PIN from the card's panel.`);
  db.prepare('INSERT INTO cards (id, pin_hash, created_at) VALUES (?, ?, ?)').run(id, await U.hashSecret(pin), now());
  U.audit(db, actor, 'added a printed card', { card: id });
  return id;
}

// Paste "card,pin" lines (commas, tabs or spaces). New cards are added; existing ones are skipped,
// or get the pasted PIN when overwrite is on.
async function importCards(db, text, actor, { overwrite = false } = {}) {
  const out = { added: [], updated: [], skipped: [], errors: [] };
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2000);
  for (const line of lines) {
    // "7,1987" or "grn07,1987,Club" (the crew is optional)
    const m = /^(?:grn|#)?0*(\d{1,5})[\s,;\t]+(\d{4,8})(?:[\s,;\t]+([A-Za-z][A-Za-z0-9 _-]{0,30}))?$/i.exec(line);
    if (!m) { if (!/^(card|id)/i.test(line)) out.errors.push(line); continue; } // header rows are fine
    const id = Number(m[1]);
    const crew = m[3] ? m[3].trim() : null;
    if (getCard(db, id)) {
      if (!overwrite) { if (crew) db.prepare('UPDATE cards SET crew = ? WHERE id = ? AND crew IS NULL').run(crew, id); out.skipped.push(id); continue; }
      await setPinHash(db, id, m[2]);
      if (crew) db.prepare('UPDATE cards SET crew = ? WHERE id = ?').run(crew, id);
      out.updated.push(id);
    } else {
      db.prepare('INSERT INTO cards (id, pin_hash, crew, created_at) VALUES (?, ?, ?, ?)').run(id, await U.hashSecret(m[2]), crew, now());
      out.added.push(id);
    }
  }
  if (out.added.length || out.updated.length) U.audit(db, actor, 'imported printed cards', {}, `${out.added.length} added, ${out.updated.length} PINs updated`);
  return out;
}

async function makeBlankCards(db, count, actor) {
  const start = nextCardId(db);
  const made = [];
  for (let id = start; id < start + count; id++) {
    const pin = U.randomDigits(4);
    db.prepare('INSERT INTO cards (id, pin_hash, created_at) VALUES (?, ?, ?)').run(id, await U.hashSecret(pin), now());
    made.push({ id, pin });
  }
  U.audit(db, actor, 'made blank cards', {}, `${start} to ${start + count - 1}`);
  return made;
}

function setCheckin(db, personId, on, actor) {
  const p = mustPerson(db, personId);
  db.prepare('UPDATE people SET checked_in_at = ? WHERE id = ?').run(on ? p.checked_in_at || now() : null, p.id);
  U.audit(db, actor, on ? 'checked in' : 'undid check-in', { person: p.id });
}

function addPoints(db, { personId, teamId }, delta, reason, actor) {
  delta = Math.round(Number(delta));
  if (!Number.isFinite(delta) || !delta || Math.abs(delta) > 100000) fail(400, 'Points must be a whole number.');
  if (personId) {
    const p = mustPerson(db, personId);
    db.prepare('UPDATE people SET points = points + ? WHERE id = ?').run(delta, p.id);
  } else {
    if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) fail(404, 'No such team.');
    db.prepare('UPDATE teams SET points = points + ? WHERE id = ?').run(delta, teamId);
  }
  db.prepare('INSERT INTO points_log (ts, person_id, team_id, delta, reason, by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(now(), personId || null, personId ? null : teamId, delta, U.cleanText(reason, 120) || null, actor);
  U.audit(db, actor, `${delta > 0 ? 'gave' : 'took'} ${Math.abs(delta)} points`, { person: personId || null }, U.cleanText(reason, 120) || (teamId ? `team ${teamId}` : null));
}

function deletePerson(db, id, actor) {
  const p = mustPerson(db, id);
  for (const c of cardsOf(db, p.id)) unlinkCard(db, c.id, actor);
  killSessions(db, p.id);
  db.prepare('DELETE FROM people WHERE id = ?').run(p.id);
  U.audit(db, actor, 'deleted person', {}, `#${p.id} ${p.name}`);
}

function resetAccount(db, id, actor) {
  const p = mustPerson(db, id);
  db.prepare('UPDATE people SET password_hash = NULL, claimed_at = NULL, email_verified = 0, pw_fails = 0, pw_locked_until = 0 WHERE id = ?').run(p.id);
  killSessions(db, p.id);
  U.audit(db, actor, 'cleared account, they set it up again', { person: p.id });
}

// ---------- organisers ----------
const ROLES = ['admin', 'desk'];
const randomPassword = () => U.randomHex(9).match(/.{6}/g).join('-');

async function createAdmin(db, { email, name, role = 'admin', password }, actor) {
  email = U.cleanEmail(email);
  if (!email) fail(400, 'Add an email.');
  if (!ROLES.includes(role)) fail(400, 'Role is admin or desk.');
  if (db.prepare('SELECT 1 FROM admins WHERE email = ?').get(email)) fail(409, 'That organiser already exists.');
  const pw = password ? U.cleanPassword(password) : randomPassword();
  db.prepare('INSERT INTO admins (email, name, role, password_hash, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(email, U.cleanText(name, 80) || null, role, await U.hashSecret(pw), actor, now());
  U.audit(db, actor, 'added organiser', {}, `${email} (${role})`);
  return { email, password: password ? null : pw };
}

async function setAdminPassword(db, email, password, actor) {
  email = U.cleanEmail(email);
  if (!db.prepare('SELECT 1 FROM admins WHERE email = ?').get(email)) fail(404, 'No organiser with that email.');
  const pw = password ? U.cleanPassword(password) : randomPassword();
  db.prepare('UPDATE admins SET password_hash = ?, pw_fails = 0, pw_locked_until = 0 WHERE email = ?').run(await U.hashSecret(pw), email);
  db.prepare("DELETE FROM sessions WHERE kind = 'admin' AND subject = ?").run(email);
  U.audit(db, actor, 'set organiser password', {}, email);
  return password ? null : pw;
}

function removeAdmin(db, email, actor) {
  email = U.cleanEmail(email);
  const me = db.prepare('SELECT role FROM admins WHERE email = ?').get(email);
  if (!me) fail(404, 'No organiser with that email.');
  const left = db.prepare("SELECT COUNT(*) n FROM admins WHERE role = 'admin' AND email != ?").get(email).n;
  if (me.role === 'admin' && left === 0) fail(400, 'That\'s the last admin. Add another first.');
  db.prepare('DELETE FROM admins WHERE email = ?').run(email);
  db.prepare("DELETE FROM sessions WHERE kind = 'admin' AND subject = ?").run(email);
  U.audit(db, actor, 'removed organiser', {}, email);
}

module.exports = {
  phoneDigits, cleanTags, nextCardId, nextFreeCard, swapCard, getPerson, getCard, cardsOf, killSessions, mustPerson, mustCard,
  createPerson, updatePerson, cleanPin, issueCard, unlinkCard, newPin, addCard, importCards, makeBlankCards, setCheckin, addPoints, deletePerson, resetAccount,
  ROLES, randomPassword, createAdmin, setAdminPassword, removeAdmin,
};
