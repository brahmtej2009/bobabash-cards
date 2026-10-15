// Shared helpers: errors, crypto, input cleaning, settings, rate limits, audit log.
const crypto = require('node:crypto');

const now = () => Date.now();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// ---------- crypto ----------
const randomHex = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

function randomDigits(n) {
  let out = '';
  for (let i = 0; i < n; i++) out += crypto.randomInt(0, 10);
  return out;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Async scrypt runs on the libuv pool, so hashing never blocks card scans.
const SCRYPT = { N: 16384, r: 8, p: 1 };
const scrypt = (pin, salt) => new Promise((ok, no) => crypto.scrypt(String(pin), salt, 32, SCRYPT, (e, k) => (e ? no(e) : ok(k))));

async function hashSecret(pin) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await scrypt(pin, salt)).toString('hex')}`;
}

async function checkSecret(pin, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt') return false;
  const got = await scrypt(pin, Buffer.from(salt, 'hex'));
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- input ----------
function cleanEmail(e) {
  const s = String(e ?? '').trim().toLowerCase();
  if (!s) return '';
  if (s.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail(400, 'That email looks off.');
  return s;
}

function cleanUrl(u) {
  let s = String(u ?? '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  let url;
  try { url = new URL(s); } catch { fail(400, 'That link looks off.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(400, 'Links have to start with http or https.');
  if (url.username || url.password) fail(400, 'Links can\'t carry a username or password.');
  if (!url.hostname.includes('.')) fail(400, 'That link looks off.');
  const out = url.toString();
  if (out.length > 2000) fail(400, 'That link is too long.');
  return out;
}

const cleanText = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function cleanGithub(s) {
  const v = String(s ?? '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\/.*$/, '');
  if (!v) return '';
  if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(v)) fail(400, 'That GitHub username looks off.');
  return v;
}

function cleanPassword(p) {
  const s = String(p ?? '');
  if (s.length < 8) fail(400, 'Passwords need at least 8 characters.');
  if (s.length > 200) fail(400, 'That password is too long.');
  return s;
}

function cardId(v) {
  const n = Number(String(v ?? '').trim());
  if (!Number.isInteger(n) || n < 1 || n > 99999) fail(400, 'Card numbers are whole numbers.');
  return n;
}

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  override_on: '0',
  override_url: '',
  lock_on: '1',
  unlock_at: '',
  // host 1: the link on the chip, a GitHub Pages repo of redirect pages
  card_base: 'https://bobabash.github.io',
  redirect_repo: 'bobabash/bobabash.github.io',
  // host 2: everyone's projects, one folder per card
  repo: 'bobabash/sites',
  project_template: 'https://bobabash.github.io/sites/{id}/',
  // host 3: this dashboard, as the world reaches it (the redirect pages ask it live)
  dashboard_url: '',
  inactive_url: '',
  splash_ms: '5000',
  instructions_md: '',
  announcement: '',
  event_name: 'Boba Bash Greater Noida',
  wall_note: '',
  help_open: '1',
  owner_signup: '0',
  override_from: '',
  override_until: '',
  tag_overrides: '{}',
  allow_profiles: '0', // profile pages were removed; kept so old databases read cleanly
  last_pr_sync: '0',
  last_publish: '0',
  last_publish_error: '',
};

function getSettings(db) {
  const s = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) s[r.key] = r.value ?? '';
  return s;
}

function setSettings(db, patch) {
  const st = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) st.run(k, String(v ?? ''));
}

function globalLocked(s, t = now()) {
  if (s.lock_on !== '1') return false;
  const at = Number(s.unlock_at || 0);
  return !(at && t >= at);
}

function cardLocked(card, s) {
  if (card.lock_mode === 'locked') return true;
  if (card.lock_mode === 'open') return false;
  return globalLocked(s);
}

const projectUrl = (s, cardId) => String(s.project_template || '').replaceAll('{id}', String(cardId));
// profiles belong to a person, so a person with a replaced card keeps the same profile link
const profileUrl = (s, personId) => `${String(s.card_base || '').replace(/\/$/, '')}/p/${personId}/`;

const tagsOf = (row) => String(row?.tags || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

function parseJson(v, fallback) {
  try { const x = JSON.parse(v || ''); return x ?? fallback; } catch { return fallback; }
}

// The all-cards link can be limited to a time window.
function overrideActive(s, t = now()) {
  if (s.override_on !== '1' || !s.override_url) return false;
  const from = Number(s.override_from || 0), until = Number(s.override_until || 0);
  return !(from && t < from) && !(until && t >= until);
}

// Where a tap on this card goes right now. person = the card's holder (or null). First match wins.
function resolve(card, person, s, t = now()) {
  if (!card) return { kind: 'missing' };
  const msg = person?.splash_msg || undefined;
  if (overrideActive(s, t) && !card.skip_override) return { kind: 'go', url: s.override_url, reason: 'override', msg };
  if (card.status === 'disabled') return { kind: 'disabled' };
  if (!person) return s.inactive_url ? { kind: 'go', url: s.inactive_url, reason: 'inactive' } : { kind: 'inactive' };
  if (card.admin_url) return { kind: 'go', url: card.admin_url, reason: 'admin', msg };
  const tagRules = parseJson(s.tag_overrides, {});
  for (const tag of tagsOf(person)) if (tagRules[tag]) return { kind: 'go', url: tagRules[tag], reason: `tag:${tag}`, msg };
  if (!cardLocked(card, s)) {
    if (person.mode === 'custom' && person.custom_url) return { kind: 'go', url: person.custom_url, reason: 'custom', msg };
  }
  return { kind: 'go', url: projectUrl(s, card.id), reason: 'project', msg };
}

// ---------- rate limits (fixed window) ----------
function limit(db, key, max, windowMs) {
  const t = now();
  const row = db.prepare('SELECT count, reset_at FROM limits WHERE key = ?').get(key);
  if (!row || row.reset_at <= t) {
    db.prepare('INSERT INTO limits (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at').run(key, t + windowMs);
    return true;
  }
  if (row.count >= max) return false;
  db.prepare('UPDATE limits SET count = count + 1 WHERE key = ?').run(key);
  return true;
}

function mustLimit(db, key, max, windowMs, msg = 'Too many tries. Give it a few minutes.') {
  if (!limit(db, key, max, windowMs)) fail(429, msg);
}

// ---------- audit ----------
// who did what. ref = { card, person } (either optional)
function audit(db, actor, action, ref = {}, detail = null) {
  db.prepare('INSERT INTO log (ts, actor, action, card_id, person_id, team_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(now(), actor, action, ref?.card ?? null, ref?.person ?? null, ref?.team ?? null, detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail));
}

module.exports = {
  now, HttpError, fail, randomHex, randomDigits, sha256, hashSecret, checkSecret, safeEqual, cleanPassword,
  hashPin: hashSecret, checkPin: checkSecret,
  cleanEmail, cleanUrl, cleanText, cleanGithub, cardId,
  DEFAULT_SETTINGS, getSettings, setSettings, globalLocked, cardLocked, projectUrl, profileUrl, tagsOf, parseJson, overrideActive, resolve,
  limit, mustLimit, audit,
};
