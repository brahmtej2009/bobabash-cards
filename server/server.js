// Boba Bash cards: the dashboard (host 3). Owns the database, both dashboards, logins, uploads,
// tap counting, the event tools and the sync into the two GitHub Pages repos.
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const U = require('./util');
const core = require('./core');
const gh = require('./github');
const mail = require('./mail');
const { renderProfile, vcard, hasContact } = require('./profile');

const { now, fail, HttpError } = U;
const PORT = Number(process.env.CARDS_PORT || 3002);
const HOST = process.env.CARDS_HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOADS = path.join(DATA_DIR, 'uploads');
const DEV = process.env.DEV === '1';

const db = require('./db').open(DATA_DIR);
fs.mkdirSync(UPLOADS, { recursive: true });

// Sessions slide: every visit pushes the expiry out again, so people only get logged out after
// this long without opening the dashboard at all.
const OWNER_TTL = 180 * 24 * 3600e3;
const ADMIN_TTL = 14 * 24 * 3600e3;
const OTP_TTL = 10 * 60e3;
const COOKIE = { owner: '__Host-bbc_o', admin: '__Host-bbc_a' };
const MAX_UPLOAD = 10 * 1024 * 1024;
const UPLOAD_ROUTES = ['/api/admin/files', '/api/me/avatar'];

const app = express();
app.disable('x-powered-by');
app.set('etag', false);

app.use((req, res, next) => {
  // only cloudflared (same container) reaches us, so its client-ip header is trustworthy
  req.ip_ = req.get('cf-connecting-ip') || req.socket.remoteAddress || '0.0.0.0';
  req.publicHost = req.get('host');
  res.set({
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});

// ---------- helpers shared with the route files ----------
const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.then === 'function') out.then((v) => v !== undefined && !res.headersSent && res.json(v), next);
    else if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) { next(e); }
};

function cookies(req) {
  const out = {};
  for (const part of String(req.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function startSession(req, res, kind, subject) {
  const token = U.randomHex(32);
  const ttl = kind === 'admin' ? ADMIN_TTL : OWNER_TTL;
  db.prepare('INSERT INTO sessions (token_hash, kind, subject, expires_at, created_at, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(U.sha256(token), kind, String(subject), now() + ttl, now(), req.ip_);
  // browsers cap cookies at 400 days; the server-side expiry (sliding) decides when it's really over
  res.append('set-cookie', `${COOKIE[kind]}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${400 * 86400}`);
}
function endSession(req, res, kind) {
  const token = cookies(req)[COOKIE[kind]];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(U.sha256(token));
  res.append('set-cookie', `${COOKIE[kind]}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
function session(req, kind) {
  const token = cookies(req)[COOKIE[kind]];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = U.sha256(token);
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND kind = ?').get(hash, kind);
  if (!row || row.expires_at <= now()) return null;
  // slide the expiry forward (at most once an hour, to keep writes down); the cookie lasts the full TTL
  const ttl = kind === 'admin' ? ADMIN_TTL : OWNER_TTL;
  if (row.expires_at < now() + ttl - 3600e3) db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(now() + ttl, hash);
  return row;
}

function needAdmin(req, role = 'admin') {
  const s = session(req, 'admin');
  const a = s && db.prepare('SELECT email, name, role FROM admins WHERE email = ?').get(s.subject);
  if (!a) fail(401, 'Log in first.');
  if (role === 'admin' && a.role !== 'admin') fail(403, 'Desk accounts can\'t do that. Ask an admin.');
  req.actor = `admin:${a.email}`;
  req.admin = a;
  return a;
}
const needDesk = (req) => needAdmin(req, 'desk');
function needOwner(req) {
  const s = session(req, 'owner');
  const p = s && core.getPerson(db, s.subject);
  if (!p || p.disabled || !p.password_hash) fail(401, 'Log in first.');
  req.actor = `owner:${p.id}`;
  return p;
}

async function sendOtp(kind, subject, email, what, payload = null) {
  U.mustLimit(db, `otp-mail:${email}`, 1, 45e3, 'A code was just sent. Wait a bit before asking again.');
  U.mustLimit(db, `otp-hour:${email}`, 6, 3600e3, 'Too many codes for this email. Try again in an hour.');
  const code = U.randomDigits(6);
  const id = U.randomHex(12);
  db.prepare('DELETE FROM otps WHERE kind = ? AND subject = ?').run(kind, String(subject));
  db.prepare('INSERT INTO otps (id, kind, subject, email, code_hash, payload, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, kind, String(subject), email, U.sha256(`${id}:${code}`), payload, now() + OTP_TTL, now());
  try {
    await mail.sendCode(email, code, what);
  } catch (e) {
    console.error('[mail]', e.message);
    db.prepare('DELETE FROM otps WHERE id = ?').run(id);
    fail(502, 'Couldn\'t send the email. Try again in a minute.');
  }
  return DEV ? code : undefined;
}
function checkOtp(kind, subject, email, code) {
  const row = db.prepare('SELECT * FROM otps WHERE kind = ? AND subject = ?').get(kind, String(subject));
  const bad = () => fail(400, 'That code doesn\'t match. Check the latest email.');
  if (!row || row.email !== email) bad();
  if (row.expires_at < now()) { db.prepare('DELETE FROM otps WHERE id = ?').run(row.id); fail(400, 'That code expired. Ask for a new one.'); }
  if (row.attempts >= 5) { db.prepare('DELETE FROM otps WHERE id = ?').run(row.id); fail(400, 'Too many wrong codes. Ask for a new one.'); }
  if (!U.safeEqual(U.sha256(`${row.id}:${String(code ?? '').trim()}`), row.code_hash)) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    bad();
  }
  db.prepare('DELETE FROM otps WHERE id = ?').run(row.id);
  return row;
}

function sniff(buf) {
  const b = buf.subarray(0, 12);
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}
function saveUpload(req, actor, personId = null) {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) fail(400, 'Pick a file first.');
  const mime = sniff(buf);
  if (!mime) fail(415, 'Only PNG, JPG, WebP, GIF or PDF.');
  const id = U.randomHex(12);
  let name = 'file';
  try { name = decodeURIComponent(req.get('x-filename') || 'file'); } catch {}
  name = U.cleanText(name, 120).replace(/[\\/"]/g, '_') || 'file';
  fs.writeFileSync(path.join(UPLOADS, id), buf);
  db.prepare('INSERT INTO files (id, name, mime, size, added_by, person_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, mime, buf.length, actor, personId, now());
  return { id, name, mime, size: buf.length, url: `/files/${id}` };
}
function deleteFile(id) {
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
  fs.rmSync(path.join(UPLOADS, id), { force: true });
}

// ---------- shared views ----------
const IST = 19800000;
const dayKey = (t) => new Date(t + IST).toISOString().slice(0, 10);
const todayStart = () => Date.parse(`${dayKey(now())}T00:00:00+05:30`);
function device(ua = '') {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows|Macintosh|Linux|CrOS/i.test(ua)) return 'Computer';
  return 'Other';
}
function lastDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(now() - i * 86400e3));
  return out;
}
// taps for a set of cards: 14 days, phones, countries
function tapStats(cardIds) {
  const days = Object.fromEntries(lastDays(14).map((d) => [d, 0]));
  const countries = {}, devices = {};
  let total = 0;
  if (cardIds.length) {
    const qs = cardIds.map(() => '?').join(',');
    total = db.prepare(`SELECT COALESCE(SUM(scans), 0) n FROM cards WHERE id IN (${qs})`).get(...cardIds).n;
    for (const r of db.prepare(`SELECT ts, country, ua FROM scans WHERE card_id IN (${qs}) AND ts > ?`).all(...cardIds, now() - 30 * 86400e3)) {
      const d = dayKey(r.ts);
      if (d in days) days[d]++;
      if (r.country) countries[r.country] = (countries[r.country] || 0) + 1;
      const dv = device(r.ua);
      devices[dv] = (devices[dv] || 0) + 1;
    }
  }
  return { total, days: Object.entries(days).map(([day, n]) => ({ day, n })), countries, devices };
}

// Which notices a person sees: everyone, their team, one of their tags, them, or their check-in state.
function noticeVisible(n, p) {
  switch (n.target_kind) {
    case 'all': return true;
    case 'team': return p.team_id != null && String(p.team_id) === String(n.target);
    case 'tag': return U.tagsOf(p).includes(String(n.target).toLowerCase());
    case 'people': return String(n.target || '').split(',').includes(String(p.id));
    case 'checked_in': return !!p.checked_in_at;
    case 'not_checked_in': return !p.checked_in_at;
    default: return false;
  }
}

const ctx = {
  app, db, U, core, gh, mail, DATA_DIR, UPLOADS, DEV, MAX_UPLOAD,
  wrap, startSession, endSession, needAdmin, needDesk, needOwner, sendOtp, checkOtp, saveUpload, deleteFile,
  dayKey, todayStart, device, lastDays, tapStats, noticeVisible,
  sync: () => gh.schedule(db, DATA_DIR),
  // live updates to people's open dashboards: 'notice' (a message went out), 'person' (something about them changed)
  bus: new (require('node:events'))().setMaxListeners(0),
};

// ---------- public, read-only ----------
app.get('/api/go/:id', (req, res) => {
  const s = U.getSettings(db);
  let origin = '*';
  try { origin = new URL(s.card_base).origin; } catch {}
  res.set({ 'access-control-allow-origin': origin, 'cache-control': 'no-store', vary: 'origin' });
  if (!U.limit(db, `go:${req.ip_}`, 120, 60e3)) return res.status(429).json({ k: 'down' });
  const id = Number(req.params.id);
  const card = Number.isInteger(id) ? core.getCard(db, id) : null;
  const person = card?.person_id ? core.getPerson(db, card.person_id) : null;
  const r = U.resolve(card, person, s);
  if (card) {
    db.prepare('UPDATE cards SET scans = scans + 1, last_scan_at = ? WHERE id = ?').run(now(), id);
    db.prepare('INSERT INTO scans (card_id, ts, reason, dest, country, ua) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, now(), r.reason || r.kind, r.url || null, U.cleanText(req.get('cf-ipcountry'), 4), U.cleanText(req.get('user-agent'), 200));
  }
  res.json(r.kind === 'go' ? { k: 'go', u: r.url, ...(r.msg ? { m: r.msg } : {}) } : { k: r.kind });
});

app.get('/files/:id', (req, res) => {
  const f = /^[a-f0-9]{24}$/.test(req.params.id) && db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).type('text').send('Not found');
  res.set({
    'content-type': f.mime,
    'cache-control': 'public, max-age=86400',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'content-disposition': `inline; filename="${f.name}"`,
  });
  fs.createReadStream(path.join(UPLOADS, f.id)).on('error', () => res.status(404).end()).pipe(res);
});

// live profile preview (the permanent copy is the static page in the redirect repo)
function profileFor(id) {
  const p = Number.isInteger(id) && core.getPerson(db, id);
  const prof = p && !p.disabled && U.parseJson(p.profile, null);
  return prof ? { p, prof } : null;
}
app.get('/p/:id', (req, res) => {
  const id = Number(req.params.id);
  const x = profileFor(id);
  if (!x) return res.status(404).type('text').send('No profile here.');
  const card = core.cardsOf(db, id)[0];
  res.set('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'");
  res.set('x-frame-options', 'SAMEORIGIN');
  res.type('html').send(renderProfile(id, x.prof, {
    projectUrl: card ? U.projectUrl(U.getSettings(db), card.id) : '',
    avatarSrc: x.prof.avatar ? `/files/${x.prof.avatar}` : '',
    contactHref: hasContact(x.prof, x.p) ? `/p/${id}/contact.vcf` : '',
  }));
});
app.get('/p/:id/contact.vcf', (req, res) => {
  const id = Number(req.params.id);
  const x = profileFor(id);
  if (!x || !hasContact(x.prof, x.p)) return res.status(404).type('text').send('Not found');
  res.set({ 'content-type': 'text/vcard; charset=utf-8', 'content-disposition': `attachment; filename="contact-${id}.vcf"` });
  res.send(vcard(id, x.prof, x.p, `${U.getSettings(db).card_base}/p/${id}/`));
});

function publicInfo() {
  const s = U.getSettings(db);
  const { THEMES, SOCIALS } = require('./profile');
  return {
    event_name: s.event_name,
    card_base: s.card_base,
    sites_repo: s.repo,
    instructions_md: s.instructions_md,
    announcement: s.announcement,
    help_open: s.help_open === '1',
    allow_profiles: s.allow_profiles === '1',
    owner_signup: s.owner_signup === '1',
    themes: Object.fromEntries(Object.entries(THEMES).map(([k, t]) => [k, { bg: t.bg, accent: t.accent, ink: t.ink }])),
    socials: SOCIALS,
  };
}
ctx.publicInfo = publicInfo;
app.get('/api/public', (req, res) => res.set('cache-control', 'no-store').json(publicInfo()));

// the big screen: live taps, leaderboards, now/next
app.get('/api/wall', (req, res) => {
  if (!U.limit(db, `wall:${req.ip_}`, 120, 60e3)) return res.status(429).json({});
  const s = U.getSettings(db);
  const first = (p) => {
    if (!p || p.disabled) return null;
    const prof = U.parseJson(p.profile, {});
    if (prof.wall === false) return null;
    return (prof.name || p.name || '').trim().split(/\s+/)[0] || null;
  };
  const people = new Map(db.prepare('SELECT * FROM people').all().map((p) => [p.id, p]));
  const cardOwner = new Map(db.prepare('SELECT id, person_id FROM cards').all().map((c) => [c.id, c.person_id]));
  const teams = db.prepare('SELECT * FROM teams').all();
  const t0 = todayStart();
  const named = (cardId) => first(people.get(cardOwner.get(cardId)));
  const feed = db.prepare('SELECT card_id, ts FROM scans ORDER BY ts DESC LIMIT 14').all().map((r) => ({ card: r.card_id, ts: r.ts, name: named(r.card_id) }));
  const topTaps = db.prepare('SELECT card_id, COUNT(*) n FROM scans WHERE ts > ? GROUP BY card_id ORDER BY n DESC LIMIT 8').all(t0)
    .map((r) => ({ card: r.card_id, n: r.n, name: named(r.card_id) }));
  const all = [...people.values()].filter((p) => !p.disabled);
  const topPeople = all.filter((p) => p.points > 0).sort((a, b) => b.points - a.points).slice(0, 8)
    .map((p) => ({ name: first(p) || `#${p.id}`, points: p.points, team: teams.find((t) => t.id === p.team_id)?.name || null }));
  const teamBoard = teams.map((t) => {
    const members = all.filter((p) => p.team_id === t.id);
    return { name: t.name, color: t.color, members: members.length, points: t.points + members.reduce((a, p) => a + p.points, 0) };
  }).sort((a, b) => b.points - a.points).slice(0, 8);
  const sched = db.prepare('SELECT * FROM schedule ORDER BY starts_at').all();
  const t = now();
  const current = sched.filter((x) => x.starts_at <= t && (x.ends_at ? x.ends_at > t : x.starts_at + 3600e3 > t));
  const next = sched.filter((x) => x.starts_at > t).slice(0, 3);
  const notice = db.prepare("SELECT title, body, ts, urgent FROM notices WHERE target_kind = 'all' ORDER BY ts DESC LIMIT 1").get() || null;
  res.set('cache-control', 'no-store').json({
    event_name: s.event_name, note: s.wall_note, card_base: s.card_base,
    taps_today: db.prepare('SELECT COUNT(*) n FROM scans WHERE ts > ?').get(t0).n,
    taps_total: db.prepare('SELECT COALESCE(SUM(scans), 0) n FROM cards').get().n,
    here: db.prepare('SELECT COUNT(*) n FROM people WHERE checked_in_at IS NOT NULL AND disabled = 0').get().n,
    people: all.length,
    feed, top_taps: topTaps, top_people: topPeople, teams: teamBoard,
    now: current.map(({ title, place, starts_at, ends_at }) => ({ title, place, starts_at, ends_at })),
    next: next.map(({ title, place, starts_at }) => ({ title, place, starts_at })),
    notice,
  });
});

// ---------- API guard: writes must be same-origin ----------
app.use('/api', (req, res, next) => {
  res.set('cache-control', 'no-store');
  if (req.method === 'GET') return next();
  const origin = req.get('origin');
  let ok = false;
  try { ok = origin && new URL(origin).host === req.publicHost; } catch {}
  if (!ok) return res.status(403).json({ error: 'Bad origin.' });
  next();
});
const rawUpload = express.raw({ type: () => true, limit: MAX_UPLOAD });
app.use((req, res, next) => (UPLOAD_ROUTES.includes(req.path) && req.method === 'POST' ? rawUpload(req, res, next) : next()));
app.use(express.json({ limit: '128kb' }));
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'DELETE' || UPLOAD_ROUTES.includes(req.baseUrl + req.path)) return next();
  if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON.' });
  next();
});

require('./owner')(ctx);
require('./admin')(ctx);

// ---------- pages ----------
const pub = path.join(__dirname, 'public');
// Cloudflare and browsers cache scripts and styles hard, so every page links them as /static/x.js?v=<build>,
// where build is a hash of the static files. A deploy that changes any of them changes every link.
const BUILD = (() => {
  const h = require('node:crypto').createHash('sha256');
  const dir = path.join(pub, 'static');
  for (const f of fs.readdirSync(dir).sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex').slice(0, 10);
})();
const pages = new Map();
function page(name) {
  if (!pages.has(name)) pages.set(name, fs.readFileSync(path.join(pub, name), 'utf8').replace(/(["'])\/static\/([^"'?]+)\1/g, `$1/static/$2?v=${BUILD}$1`));
  return pages.get(name);
}
const sendPage = (name) => (req, res) => res.set('cache-control', 'no-store').type('html').send(page(name));
app.use('/static', (req, res, next) => {
  res.set('cache-control', req.query.v === BUILD ? 'public, max-age=31536000, immutable' : 'no-cache');
  next();
});
app.use('/static', express.static(path.join(pub, 'static'), { cacheControl: false, etag: true }));
app.get('/', sendPage('home.html'));
app.get(['/me', '/me/'], sendPage('me.html'));
app.get(['/admin', '/admin/'], sendPage('admin.html'));
app.get(['/wall', '/wall/'], sendPage('wall.html'));
app.get('/api/version', (req, res) => res.set('cache-control', 'no-store').json({ build: BUILD }));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(pub, 'static', 'icon.png')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((req, res) => res.status(404).type('text').send('Not found'));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is over 10 MB.' });
  if (String(err.message || '').includes('UNIQUE constraint failed')) return res.status(409).json({ error: 'That already exists.' });
  console.error(err);
  res.status(500).json({ error: 'Something broke on our side.' });
});

// ---------- housekeeping ----------
setInterval(() => {
  const t = now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM otps WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM limits WHERE reset_at < ?').run(t);
  // avatars uploaded but never saved into a profile
  for (const f of db.prepare('SELECT id, person_id FROM files WHERE person_id IS NOT NULL AND created_at < ?').all(t - 86400e3)) {
    const p = core.getPerson(db, f.person_id);
    if (!p || U.parseJson(p.profile, {}).avatar !== f.id) deleteFile(f.id);
  }
  gh.syncAll(db, DATA_DIR).catch(() => {});
  const repo = U.getSettings(db).repo;
  if (gh.hasToken() && repo) gh.syncPrs(db, repo).catch(() => {});
}, 10 * 60e3).unref();

if (!db.prepare('SELECT 1 FROM admins LIMIT 1').get()) console.log('No organisers yet. Make one with:  cards admin add you@email.com');

app.listen(PORT, HOST, () => {
  console.log(`cards dashboard on http://${HOST}:${PORT}`);
  ctx.sync();
});
