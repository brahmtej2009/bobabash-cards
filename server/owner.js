// /api/me: everything a person at the event does on their own laptop or phone.
module.exports = function owner(ctx) {
  const { app, db, U, core, wrap, startSession, endSession, needOwner, sendOtp, checkOtp, tapStats, noticeVisible, publicInfo, sync } = ctx;
  const { now, fail } = U;
  const mask = (e) => e.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => a + '*'.repeat(Math.min(b.length, 6)) + c);

  // PIN check with a per-card lockout (5 wrong = 15 minutes)
  async function checkCardPin(card, pin) {
    if (card.pin_locked_until > now()) fail(429, 'This card is locked after too many wrong tries. Try again in 15 minutes.');
    const ok = /^\d{4,8}$/.test(String(pin ?? '').trim()) && (await U.checkSecret(String(pin).trim(), card.pin_hash));
    if (!ok) {
      const fails = card.pin_fails + 1;
      if (fails >= 5) {
        db.prepare('UPDATE cards SET pin_fails = 0, pin_locked_until = ? WHERE id = ?').run(now() + 15 * 60e3, card.id);
        U.audit(db, 'system', 'card locked after 5 wrong PINs', { card: card.id, person: card.person_id });
      } else db.prepare('UPDATE cards SET pin_fails = ? WHERE id = ?').run(fails, card.id);
    } else db.prepare('UPDATE cards SET pin_fails = 0 WHERE id = ?').run(card.id);
    return ok;
  }

  // ---------- first setup ----------
  // With a card: card number + PIN + email. Without: the email the desk registered (or a fresh signup if allowed).
  // With a card: card number + PIN (printed on it) + the email given at the desk + a password, typed twice.
  // That's proof enough, so they're logged straight in. No card: we email a code first (there's no PIN to prove it's them).
  app.post('/api/me/setup/start', wrap(async (req, res) => {
    U.mustLimit(db, `me-setup:${req.ip_}`, 20, 15 * 60e3);
    const email = U.cleanEmail(req.body.email);
    if (!email) fail(400, 'Add your email.');
    const password = U.cleanPassword(req.body.password);
    if (req.body.password2 !== undefined && req.body.password2 !== req.body.password) fail(400, 'The two passwords don\'t match.');
    let person = null;
    if (req.body.card) {
      const card = core.getCard(db, U.cardId(req.body.card));
      const nope = 'Card number or PIN don\'t match.';
      if (!card) fail(400, nope);
      if (!(await checkCardPin(card, req.body.pin))) fail(400, nope);
      if (card.status === 'disabled') fail(400, 'This card is switched off. Talk to an organiser.');
      if (!card.person_id) fail(400, 'This card isn\'t registered to anyone yet. Find an organiser at the desk.');
      person = core.getPerson(db, card.person_id);
      if (person.email && person.email !== email) fail(400, `That's not the email the desk has for this card. Use the one you gave there (${mask(person.email)}).`);
      if (person.password_hash) fail(409, 'This card is already set up. Log in instead, or reset your password.');
      if (person.disabled) fail(400, 'This account is switched off. Talk to an organiser.');
      if (db.prepare('SELECT 1 FROM people WHERE email = ? AND id != ?').get(email, person.id)) fail(409, 'That email is already used by someone else.');
      db.prepare('UPDATE people SET email = ?, password_hash = ?, claimed_at = ?, pw_fails = 0, pw_locked_until = 0 WHERE id = ?').run(email, await U.hashSecret(password), now(), person.id);
      U.audit(db, `owner:${person.id}`, 'set up their account with their card', { person: person.id, card: card.id }, email);
      startSession(req, res, 'owner', person.id);
      return { ok: true, done: true };
    } else {
      person = db.prepare('SELECT * FROM people WHERE email = ?').get(email);
      if (!person && U.getSettings(db).owner_signup !== '1') fail(400, 'No registration with that email. Use your card, or find the desk.');
      if (!person && !U.cleanText(req.body.name, 120)) fail(400, 'Add your name.');
    }
    if (person?.password_hash) fail(409, 'You\'re already set up. Log in instead, or reset your password.');
    if (person?.disabled) fail(400, 'This account is switched off. Talk to an organiser.');
    if (person) {
      const other = db.prepare('SELECT id FROM people WHERE email = ? AND id != ?').get(email, person.id);
      if (other) fail(409, 'That email is already used by someone else.');
    }
    const payload = JSON.stringify({ hash: await U.hashSecret(password), person: person?.id || null, name: person ? null : U.cleanText(req.body.name, 120) });
    const dev = await sendOtp('setup', email, email, 'account setup', payload);
    return { ok: true, to: mask(email), dev };
  }));

  app.post('/api/me/setup/verify', wrap((req, res) => {
    U.mustLimit(db, `me-verify:${req.ip_}`, 30, 15 * 60e3);
    const email = U.cleanEmail(req.body.email);
    const otp = checkOtp('setup', email, email, req.body.code);
    const data = JSON.parse(otp.payload);
    let id = data.person;
    if (id) {
      const p = core.getPerson(db, id);
      if (!p || p.password_hash) fail(400, 'Start again from the setup page.');
      db.prepare('UPDATE people SET email = ?, email_verified = 1, password_hash = ?, claimed_at = ? WHERE id = ?').run(email, data.hash, now(), id);
    } else {
      if (db.prepare('SELECT 1 FROM people WHERE email = ?').get(email)) fail(409, 'Start again from the setup page.');
      id = Number(db.prepare('INSERT INTO people (name, email, email_verified, password_hash, claimed_at, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)')
        .run(data.name, email, data.hash, now(), 'self signup', now()).lastInsertRowid);
    }
    U.audit(db, `owner:${id}`, 'set up their account', { person: id }, email);
    startSession(req, res, 'owner', id);
    return { ok: true };
  }));

  // ---------- login + recovery ----------
  app.post('/api/me/login', wrap(async (req, res) => {
    U.mustLimit(db, `me-login:${req.ip_}`, 30, 15 * 60e3);
    const login = String(req.body.login ?? '').trim().toLowerCase();
    let p = null;
    if (U.parseCard(login) != null) {
      const c = core.getCard(db, U.parseCard(login));
      p = c?.person_id ? core.getPerson(db, c.person_id) : null;
    } else p = db.prepare('SELECT * FROM people WHERE email = ?').get(login);
    const nope = 'Login or password don\'t match.';
    if (!p || !p.password_hash) fail(400, nope);
    if (p.pw_locked_until > now()) fail(429, 'Too many wrong passwords. Try again in 15 minutes, or reset it.');
    if (!(await U.checkSecret(String(req.body.password ?? ''), p.password_hash))) {
      const fails = p.pw_fails + 1;
      db.prepare('UPDATE people SET pw_fails = ?, pw_locked_until = ? WHERE id = ?').run(fails >= 8 ? 0 : fails, fails >= 8 ? now() + 15 * 60e3 : 0, p.id);
      fail(400, nope);
    }
    if (p.disabled) fail(400, 'This account is switched off. Talk to an organiser.');
    db.prepare('UPDATE people SET pw_fails = 0 WHERE id = ?').run(p.id);
    startSession(req, res, 'owner', p.id);
    U.audit(db, `owner:${p.id}`, 'logged in', { person: p.id });
    return { ok: true };
  }));

  app.post('/api/me/forgot/start', wrap(async (req) => {
    U.mustLimit(db, `me-forgot:${req.ip_}`, 10, 15 * 60e3);
    const email = U.cleanEmail(req.body.email);
    if (!email) fail(400, 'Add your email.');
    const p = db.prepare('SELECT id FROM people WHERE email = ? AND password_hash IS NOT NULL AND disabled = 0').get(email);
    let dev;
    if (p) dev = await sendOtp('reset', email, email, 'password reset');
    return { ok: true, dev }; // same answer either way
  }));

  app.post('/api/me/forgot/verify', wrap(async (req, res) => {
    U.mustLimit(db, `me-forgot-v:${req.ip_}`, 30, 15 * 60e3);
    const email = U.cleanEmail(req.body.email);
    const password = U.cleanPassword(req.body.password);
    if (req.body.password2 !== undefined && req.body.password2 !== req.body.password) fail(400, 'The two passwords do not match.');
    checkOtp('reset', email, email, req.body.code);
    const p = db.prepare('SELECT * FROM people WHERE email = ?').get(email);
    if (!p) fail(400, 'Start again.');
    db.prepare('UPDATE people SET password_hash = ?, pw_fails = 0, pw_locked_until = 0 WHERE id = ?').run(await U.hashSecret(password), p.id);
    core.killSessions(db, p.id);
    U.audit(db, `owner:${p.id}`, 'reset password by email', { person: p.id });
    startSession(req, res, 'owner', p.id);
    return { ok: true };
  }));

  // holding the card is enough to take the account back
  app.post('/api/me/pin-reset', wrap(async (req, res) => {
    U.mustLimit(db, `me-pinreset:${req.ip_}`, 15, 15 * 60e3);
    const password = U.cleanPassword(req.body.password);
    if (req.body.password2 !== undefined && req.body.password2 !== req.body.password) fail(400, 'The two passwords do not match.');
    const card = core.getCard(db, U.cardId(req.body.card));
    if (!card || !(await checkCardPin(card, req.body.pin))) fail(400, 'Card number or PIN don\'t match.');
    const p = card.person_id && core.getPerson(db, card.person_id);
    if (!p) fail(400, 'This card isn\'t registered to anyone yet.');
    if (!p.password_hash) fail(400, 'Not set up yet. Use "Set up my account".');
    if (p.disabled) fail(400, 'This account is switched off. Talk to an organiser.');
    db.prepare('UPDATE people SET password_hash = ?, pw_fails = 0, pw_locked_until = 0 WHERE id = ?').run(await U.hashSecret(password), p.id);
    core.killSessions(db, p.id);
    U.audit(db, `owner:${p.id}`, 'reset password with card PIN', { person: p.id, card: card.id });
    startSession(req, res, 'owner', p.id);
    return { ok: true };
  }));

  app.post('/api/me/logout', wrap((req, res) => { endSession(req, res, 'owner'); return { ok: true }; }));
  app.post('/api/me/logout-all', wrap((req, res) => {
    const p = needOwner(req);
    core.killSessions(db, p.id);
    endSession(req, res, 'owner');
    return { ok: true };
  }));

  // ---------- live: one event stream per open dashboard ----------
  // 'notice' = a message for them just went out (shown + ding), 'refresh' = something about them changed.
  const streams = new Map(); // person id -> Set(res)
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  app.get('/api/me/stream', (req, res, next) => {
    let p;
    try { p = needOwner(req); } catch (e) { return next(e); }
    const mine = streams.get(p.id) || new Set();
    if (mine.size >= 6) return res.status(429).json({ error: 'Too many open tabs.' });
    res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    mine.add(res);
    streams.set(p.id, mine);
    // comments keep nginx and Cloudflare from closing an idle stream
    const beat = setInterval(() => res.write(': hi\n\n'), 25000);
    req.on('close', () => {
      clearInterval(beat);
      mine.delete(res);
      if (!mine.size) streams.delete(p.id);
    });
  });
  ctx.bus.on('notice', (n) => {
    for (const [pid, set] of streams) {
      const p = core.getPerson(db, pid);
      if (!p || p.disabled || !noticeVisible(n, p)) continue;
      for (const res of set) send(res, 'notice', { id: n.id, ts: n.ts, title: n.title, body: n.body, urgent: !!n.urgent, read: false });
    }
  });
  ctx.bus.on('person', (pid, what) => {
    for (const res of streams.get(Number(pid)) || []) send(res, 'refresh', { what });
  });
  ctx.bus.on('everyone', (what) => {
    for (const set of streams.values()) for (const res of set) send(res, 'refresh', { what });
  });

  // ---------- the whole dashboard in one call ----------
  function view(p) {
    const s = U.getSettings(db);
    const cards = core.cardsOf(db, p.id).map((c) => {
      const r = U.resolve(c, p, s);
      return {
        id: c.id, status: c.status, scans: c.scans, last_scan_at: c.last_scan_at,
        url: `${s.card_base.replace(/\/$/, '')}/${c.id}`,
        project_url: U.projectUrl(s, c.id),
        now_url: r.url || '', now_reason: r.reason || r.kind,
        locked: U.cardLocked(c, s),
      };
    });
    const team = p.team_id ? db.prepare('SELECT * FROM teams WHERE id = ?').get(p.team_id) : null;
    const members = team ? db.prepare('SELECT id, name, github, points FROM people WHERE team_id = ? AND disabled = 0 ORDER BY name').all(team.id).map((m) => ({
      id: m.id, name: m.name, github: m.github, me: m.id === p.id, points: m.points,
      cards: core.cardsOf(db, m.id).map((c) => c.id),
    })) : [];
    const read = new Set(db.prepare('SELECT notice_id FROM notice_reads WHERE person_id = ?').all(p.id).map((r) => r.notice_id));
    const notices = db.prepare('SELECT id, ts, title, body, urgent, target_kind, target FROM notices ORDER BY ts DESC LIMIT 300').all()
      .filter((n) => noticeVisible(n, p))
      .map((n) => ({ id: n.id, ts: n.ts, title: n.title, body: n.body, urgent: !!n.urgent, read: read.has(n.id) }));
    const items = db.prepare('SELECT i.id, i.name, i.emoji, h.ts, h.qty FROM items i LEFT JOIN handouts h ON h.item_id = i.id AND h.person_id = ? ORDER BY i.id').all(p.id);
    const lockedAll = cards.length > 0 && cards.every((c) => c.locked);
    return {
      id: p.id, name: p.name, email: p.email, github: p.github, tags: U.tagsOf(p),
      checked_in_at: p.checked_in_at, points: p.points,
      mode: p.mode, custom_url: p.custom_url || '', splash_msg: p.splash_msg || '',
      cards, locked: lockedAll,
      unlock_at: s.lock_on === '1' ? Number(s.unlock_at || 0) || null : null,
      team: team ? { name: team.name, color: team.color, place: team.place, note: team.note, points: team.points + members.reduce((a, m) => a + m.points, 0), members } : null,
      notices, unread: notices.filter((n) => !n.read).length,
      schedule: db.prepare('SELECT id, starts_at, ends_at, title, place, note FROM schedule ORDER BY starts_at').all(),
      help: db.prepare('SELECT id, ts, kind, message, status, reply, updated_at FROM help WHERE person_id = ? ORDER BY ts DESC LIMIT 20').all(p.id),
      items: items.map((i) => ({ name: i.name, emoji: i.emoji || '', got: !!i.ts, qty: i.qty || 0, ts: i.ts })),
      prs: cards.length ? db.prepare(`SELECT number, title, state, merged, approved, url, card_id FROM prs WHERE card_id IN (${cards.map(() => '?').join(',')}) ORDER BY number DESC`).all(...cards.map((c) => c.id)) : [],
      sites_repo: s.repo,
      public: publicInfo(),
    };
  }
  app.get('/api/me', wrap((req) => view(needOwner(req))));

  // ---------- card choices ----------
  app.post('/api/me/destination', wrap((req) => {
    const p = needOwner(req);
    const s = U.getSettings(db);
    const cards = core.cardsOf(db, p.id);
    if (cards.length && cards.every((c) => U.cardLocked(c, s))) fail(423, 'Cards are locked right now. You can change this once organisers unlock them.');
    U.mustLimit(db, `me-dest:${p.id}`, 60, 3600e3);
    const mode = req.body.mode;
    if (mode === 'project') db.prepare("UPDATE people SET mode = 'project' WHERE id = ?").run(p.id);
    else if (mode === 'custom') {
      const url = U.cleanUrl(req.body.url);
      if (!url) fail(400, 'Paste a link first.');
      db.prepare("UPDATE people SET mode = 'custom', custom_url = ? WHERE id = ?").run(url, p.id);
    } else fail(400, 'Pick your project or a link.');
    U.audit(db, `owner:${p.id}`, `pointed their card to ${mode}`, { person: p.id }, mode === 'custom' ? U.cleanUrl(req.body.url) : null);
    sync();
    return view(core.getPerson(db, p.id));
  }));

  app.post('/api/me/splash', wrap((req) => {
    const p = needOwner(req);
    const msg = U.cleanText(req.body.msg, 60);
    db.prepare('UPDATE people SET splash_msg = ? WHERE id = ?').run(msg || null, p.id);
    U.audit(db, `owner:${p.id}`, 'changed splash line', { person: p.id }, msg);
    sync();
    return view(core.getPerson(db, p.id));
  }));

  // their GitHub username: a pull request from that account to their card's folder merges by itself
  app.post('/api/me/github', wrap((req) => {
    const p = needOwner(req);
    U.mustLimit(db, `me-github:${p.id}`, 20, 3600e3);
    core.updatePerson(db, p.id, { github: req.body?.github ?? '' }, `owner:${p.id}`);
    return view(core.getPerson(db, p.id));
  }));

  // Asked by the projects repo's GitHub Action: does this GitHub account hold this card?
  // Only yes/no comes back, never whose card it is or their username.
  app.get('/api/github-check', (req, res) => {
    if (!U.limit(db, `ghcheck:${req.ip_}`, 120, 60e3)) return res.status(429).json({});
    const n = U.parseCard(req.query.card);
    const card = n == null ? null : core.getCard(db, n);
    const p = card?.person_id ? core.getPerson(db, card.person_id) : null;
    const login = String(req.query.login || '').trim().toLowerCase();
    const gh = String(p?.github || '').trim().toLowerCase();
    const live = !!p && !p.disabled && card.status === 'active';
    res.set('cache-control', 'no-store').json({ card: !!card, held: live, has_github: live && !!gh, match: live && !!gh && !!login && gh === login });
  });

  app.get('/api/me/stats', wrap((req) => {
    const p = needOwner(req);
    return tapStats(core.cardsOf(db, p.id).map((c) => c.id));
  }));

  // ---------- event ----------
  app.post('/api/me/notices/read', wrap((req) => {
    const p = needOwner(req);
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 500);
    const ins = db.prepare('INSERT OR IGNORE INTO notice_reads (notice_id, person_id, ts) VALUES (?, ?, ?)');
    for (const id of ids) if (db.prepare('SELECT 1 FROM notices WHERE id = ?').get(id)) ins.run(id, p.id, now());
    return { ok: true };
  }));

  const HELP_KINDS = ['tech', 'card', 'food', 'medical', 'lost', 'other'];
  app.post('/api/me/help', wrap((req) => {
    const p = needOwner(req);
    if (U.getSettings(db).help_open !== '1') fail(400, 'The help desk is closed right now. Find an organiser.');
    U.mustLimit(db, `me-help:${p.id}`, 10, 3600e3, 'That\'s a lot of requests. An organiser will get to you.');
    const kind = HELP_KINDS.includes(req.body.kind) ? req.body.kind : 'other';
    const message = U.cleanText(req.body.message, 500);
    if (!message && kind === 'other') fail(400, 'Say what you need.');
    if (db.prepare("SELECT COUNT(*) n FROM help WHERE person_id = ? AND status != 'done'").get(p.id).n >= 3) fail(400, 'You already have 3 open requests. Wait for one to close.');
    const id = Number(db.prepare('INSERT INTO help (person_id, ts, kind, message, updated_at) VALUES (?, ?, ?, ?, ?)').run(p.id, now(), kind, message || null, now()).lastInsertRowid);
    U.audit(db, `owner:${p.id}`, `asked for help (${kind})`, { person: p.id }, message);
    return view(core.getPerson(db, p.id));
  }));
  app.post('/api/me/help/:id/cancel', wrap((req) => {
    const p = needOwner(req);
    db.prepare("UPDATE help SET status = 'done', reply = COALESCE(reply, 'Cancelled by you'), updated_at = ? WHERE id = ? AND person_id = ? AND status != 'done'").run(now(), Number(req.params.id), p.id);
    return view(core.getPerson(db, p.id));
  }));

  // ---------- account ----------
  app.post('/api/me/password', wrap(async (req) => {
    const p = needOwner(req);
    if (!(await U.checkSecret(String(req.body.current ?? ''), p.password_hash))) fail(400, 'Current password is wrong.');
    const pw = U.cleanPassword(req.body.password);
    db.prepare('UPDATE people SET password_hash = ? WHERE id = ?').run(await U.hashSecret(pw), p.id);
    U.audit(db, `owner:${p.id}`, 'changed password', { person: p.id });
    return { ok: true };
  }));
};
