// People, cards and organisers: the operations shared by the web server and the `cards` terminal command.
const U = require('./util');

const { now, fail } = U;

// last 10 digits, so +91 98xxx and 98xxx match
const phoneDigits = (p) => String(p || '').replace(/\D/g, '').slice(-10) || '';
const cleanTags = (v) => [...new Set(String(Array.isArray(v) ? v.join(',') : v ?? '').split(',').map((t) => t.trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '')).filter(Boolean))].slice(0, 12).join(',');
const nextCardId = (db) => (db.prepare('SELECT MAX(id) AS m FROM cards').get().m || 0) + 1;

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
  U.audit(db, actor, 'edited person', { person: p.id }, f);
  return getPerson(db, p.id);
}

// Give a person a card. cardId empty = make the next number. A card that exists keeps its printed PIN
// unless newPin. A second card for the same person only with allowSecond.
async function issueCard(db, personId, { cardId, newPin = false, allowSecond = false, replace = false } = {}, actor) {
  const person = mustPerson(db, personId);
  const held = cardsOf(db, person.id);
  if (held.length && !allowSecond) fail(409, `${person.name} already has card ${held.map((c) => c.id).join(', ')}. Tick "allow a second card" to give another.`);
  const id = cardId ? U.cardId(cardId) : nextCardId(db);
  let card = getCard(db, id);
  if (card && card.person_id && card.person_id !== person.id) {
    if (!replace) {
      const other = getPerson(db, card.person_id);
      fail(409, `Card ${id} belongs to ${other?.name || 'someone'}.`);
    }
    U.audit(db, actor, 'took card from previous holder', { card: id, person: card.person_id });
  }
  let pin = null;
  if (!card || newPin) {
    pin = U.randomDigits(4);
    const hash = await U.hashSecret(pin);
    if (!card) db.prepare('INSERT INTO cards (id, pin_hash, created_at) VALUES (?, ?, ?)').run(id, hash, now());
    else db.prepare('UPDATE cards SET pin_hash = ?, pin_fails = 0, pin_locked_until = 0 WHERE id = ?').run(hash, id);
  }
  db.prepare("UPDATE cards SET person_id = ?, status = 'active', linked_at = ? WHERE id = ?").run(person.id, now(), id);
  U.audit(db, actor, card ? 'gave card' : 'made and gave card', { card: id, person: person.id }, person.name);
  return { id, pin, made: !card };
}

function unlinkCard(db, cardId, actor) {
  const c = mustCard(db, cardId);
  db.prepare('UPDATE cards SET person_id = NULL, admin_url = NULL, lock_mode = \'global\', skip_override = 0, linked_at = NULL WHERE id = ?').run(c.id);
  U.audit(db, actor, 'took card back', { card: c.id, person: c.person_id });
}

async function newPin(db, id, actor) {
  const c = mustCard(db, id);
  const pin = U.randomDigits(4);
  db.prepare('UPDATE cards SET pin_hash = ?, pin_fails = 0, pin_locked_until = 0 WHERE id = ?').run(await U.hashSecret(pin), c.id);
  U.audit(db, actor, 'issued a new PIN', { card: c.id, person: c.person_id });
  return pin;
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
  phoneDigits, cleanTags, nextCardId, getPerson, getCard, cardsOf, killSessions, mustPerson, mustCard,
  createPerson, updatePerson, issueCard, unlinkCard, newPin, makeBlankCards, setCheckin, addPoints, deletePerson, resetAccount,
  ROLES, randomPassword, createAdmin, setAdminPassword, removeAdmin,
};
