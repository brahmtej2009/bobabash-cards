// /api/admin: everything organisers do. Desk accounts can register, look up, check in and hand things out;
// everything else needs an admin.
module.exports = function admin(ctx) {
  const { app, db, U, core, gh, mail, DATA_DIR, wrap, startSession, endSession, needAdmin, needDesk, saveUpload, deleteFile, tapStats, noticeVisible, dayKey, todayStart, device, lastDays, sync } = ctx;
  const { now, fail, HttpError } = U;
  const IST = 19800000;

  // ---------- auth ----------
  app.post('/api/admin/login', wrap(async (req, res) => {
    U.mustLimit(db, `admin-login:${req.ip_}`, 20, 15 * 60e3);
    const email = U.cleanEmail(req.body.email);
    const a = email && db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
    const nope = 'Email or password don\'t match.';
    if (!a || !a.password_hash) { await U.hashSecret('timing'); fail(400, nope); }
    if (a.pw_locked_until > now()) fail(429, 'Too many wrong passwords. Try again in 15 minutes.');
    if (!(await U.checkSecret(String(req.body.password ?? ''), a.password_hash))) {
      const fails = a.pw_fails + 1;
      db.prepare('UPDATE admins SET pw_fails = ?, pw_locked_until = ? WHERE email = ?').run(fails >= 8 ? 0 : fails, fails >= 8 ? now() + 15 * 60e3 : 0, email);
      if (fails >= 8) U.audit(db, 'system', 'organiser locked after 8 wrong passwords', {}, email);
      fail(400, nope);
    }
    db.prepare('UPDATE admins SET pw_fails = 0 WHERE email = ?').run(email);
    startSession(req, res, 'admin', email);
    U.audit(db, `admin:${email}`, 'logged in');
    return { ok: true };
  }));
  app.post('/api/admin/logout', wrap((req, res) => { endSession(req, res, 'admin'); return { ok: true }; }));
  app.get('/api/admin/me', wrap((req) => needDesk(req)));
  app.post('/api/admin/password', wrap(async (req) => {
    const a = needDesk(req);
    const row = db.prepare('SELECT password_hash FROM admins WHERE email = ?').get(a.email);
    if (!(await U.checkSecret(String(req.body.current ?? ''), row.password_hash))) fail(400, 'Current password is wrong.');
    await core.setAdminPassword(db, a.email, req.body.password, req.actor);
    return { ok: true };
  }));

  // ---------- views ----------
  function prBest() {
    const out = new Map();
    const rank = (x) => (x.merged ? 3 : x.state === 'open' ? 2 : 1);
    for (const p of db.prepare('SELECT * FROM prs WHERE card_id IS NOT NULL ORDER BY number DESC').all()) {
      const cur = out.get(p.card_id);
      if (!cur || rank(p) > rank(cur)) out.set(p.card_id, p);
    }
    return out;
  }
  const prView = (pr) => (pr ? { number: pr.number, state: pr.merged ? 'merged' : pr.state, approved: !!pr.approved, author: pr.author, url: pr.url } : null);

  function cardView(c, person, s, prs) {
    const r = U.resolve(c, person, s);
    const { pin_hash, ...rest } = c;
    return {
      ...rest,
      person: person ? { id: person.id, name: person.name } : null,
      locked: U.cardLocked(c, s),
      locked_out: c.pin_locked_until > now(),
      now_url: r.url || '', now_reason: r.reason || r.kind,
      url: `${s.card_base.replace(/\/$/, '')}/${c.id}`,
      pr: prView(prs.get(c.id)),
    };
  }

  function peopleList() {
    const s = U.getSettings(db);
    const prs = prBest();
    const cards = db.prepare('SELECT * FROM cards ORDER BY id').all();
    const byPerson = new Map();
    for (const c of cards) if (c.person_id) (byPerson.get(c.person_id) || byPerson.set(c.person_id, []).get(c.person_id)).push(c);
    const got = new Map();
    for (const h of db.prepare('SELECT person_id, item_id FROM handouts').all()) (got.get(h.person_id) || got.set(h.person_id, []).get(h.person_id)).push(h.item_id);
    const openHelp = new Map(db.prepare("SELECT person_id, COUNT(*) n FROM help WHERE status != 'done' GROUP BY person_id").all().map((r) => [r.person_id, r.n]));
    return db.prepare('SELECT * FROM people ORDER BY id').all().map((p) => {
      const mine = byPerson.get(p.id) || [];
      const first = mine[0];
      const r = first ? U.resolve(first, p, s) : null;
      return {
        id: p.id, name: p.name, email: p.email, phone: p.phone, github: p.github, tags: U.tagsOf(p), team_id: p.team_id,
        note: p.note, checked_in_at: p.checked_in_at, claimed: !!p.password_hash, points: p.points, disabled: !!p.disabled,
        has_profile: !!p.profile, mode: p.mode, created_at: p.created_at,
        cards: mine.map((c) => c.id),
        scans: mine.reduce((a, c) => a + c.scans, 0),
        last_scan_at: Math.max(0, ...mine.map((c) => c.last_scan_at || 0)) || null,
        now_url: r?.url || '', now_reason: r ? r.reason || r.kind : '',
        locked_out: p.pw_locked_until > now() || mine.some((c) => c.pin_locked_until > now()),
        items: got.get(p.id) || [],
        help_open: openHelp.get(p.id) || 0,
        pr: first ? prView(prs.get(first.id)) : null,
      };
    });
  }

  function personFull(id) {
    const p = core.mustPerson(db, id);
    const s = U.getSettings(db);
    const prs = prBest();
    const cards = core.cardsOf(db, p.id);
    const { password_hash, ...rest } = p;
    const team = p.team_id ? db.prepare('SELECT * FROM teams WHERE id = ?').get(p.team_id) : null;
    const notices = db.prepare('SELECT n.*, r.ts read_at FROM notices n LEFT JOIN notice_reads r ON r.notice_id = n.id AND r.person_id = ? ORDER BY n.ts DESC LIMIT 200').all(p.id)
      .filter((n) => noticeVisible(n, p)).slice(0, 30);
    return {
      person: { ...rest, tags: U.tagsOf(p), claimed: !!password_hash, profile: U.parseJson(p.profile, null), locked_out: p.pw_locked_until > now() },
      team,
      cards: cards.map((c) => cardView(c, p, s, prs)),
      items: db.prepare('SELECT i.id, i.name, h.ts, h.by FROM items i LEFT JOIN handouts h ON h.item_id = i.id AND h.person_id = ? ORDER BY i.id').all(p.id),
      help: db.prepare('SELECT * FROM help WHERE person_id = ? ORDER BY ts DESC LIMIT 20').all(p.id),
      notices: notices.map((n) => ({ id: n.id, ts: n.ts, title: n.title, read_at: n.read_at, target_kind: n.target_kind })),
      points: db.prepare('SELECT * FROM points_log WHERE person_id = ? ORDER BY ts DESC LIMIT 20').all(p.id),
      stats: tapStats(cards.map((c) => c.id)),
      scans: cards.length ? db.prepare(`SELECT card_id, ts, reason, country, ua FROM scans WHERE card_id IN (${cards.map(() => '?').join(',')}) ORDER BY ts DESC LIMIT 25`).all(...cards.map((c) => c.id)).map((x) => ({ ...x, device: device(x.ua) })) : [],
      log: db.prepare('SELECT ts, actor, action, detail, card_id FROM log WHERE person_id = ? ORDER BY ts DESC LIMIT 50').all(p.id),
      profile_url: p.profile ? U.profileUrl(s, p.id) : null,
    };
  }

  app.get('/api/admin/state', wrap((req) => {
    const me = needDesk(req);
    const s = U.getSettings(db);
    return {
      me, settings: s,
      global_locked: U.globalLocked(s), override_active: U.overrideActive(s),
      next_card: core.nextCardId(db),
      teams: db.prepare('SELECT t.*, (SELECT COUNT(*) FROM people p WHERE p.team_id = t.id) members, (SELECT COALESCE(SUM(points),0) FROM people p WHERE p.team_id = t.id) member_points FROM teams t ORDER BY name').all(),
      items: db.prepare('SELECT i.*, (SELECT COUNT(*) FROM handouts h WHERE h.item_id = i.id) given FROM items i ORDER BY id').all(),
      admins: db.prepare('SELECT email, name, role, added_by, added_at FROM admins ORDER BY added_at').all(),
      counts: {
        people: db.prepare('SELECT COUNT(*) n FROM people').get().n,
        here: db.prepare('SELECT COUNT(*) n FROM people WHERE checked_in_at IS NOT NULL').get().n,
        claimed: db.prepare('SELECT COUNT(*) n FROM people WHERE password_hash IS NOT NULL').get().n,
        cards: db.prepare('SELECT COUNT(*) n FROM cards').get().n,
        free_cards: db.prepare('SELECT COUNT(*) n FROM cards WHERE person_id IS NULL').get().n,
        help_open: db.prepare("SELECT COUNT(*) n FROM help WHERE status != 'done'").get().n,
        taps_24h: db.prepare('SELECT COUNT(*) n FROM scans WHERE ts > ?').get(now() - 86400e3).n,
      },
      github: { token: gh.hasToken(), last_sync: Number(s.last_publish || 0), problem: s.last_publish_error },
      smtp: mail.ready(),
    };
  }));

  app.get('/api/admin/search', wrap((req) => {
    needDesk(req);
    const q = String(req.query.q || '').trim().toLowerCase().replace(/^#/, '');
    if (!q) return { people: [], cards: [] };
    const like = `%${q}%`;
    const people = db.prepare(`SELECT id, name, email, tags FROM people WHERE lower(name) LIKE ? OR lower(email) LIKE ? OR lower(github) LIKE ? OR phone LIKE ? OR lower(tags) LIKE ? OR CAST(id AS TEXT) = ? ORDER BY name LIMIT 12`)
      .all(like, like, like, like, like, q);
    const cards = /^\d+$/.test(q) ? db.prepare('SELECT c.id, c.person_id, p.name FROM cards c LEFT JOIN people p ON p.id = c.person_id WHERE c.id = ?').all(Number(q)) : [];
    return { people, cards };
  }));

  // ---------- people ----------
  app.get('/api/admin/people', wrap((req) => { needDesk(req); return { people: peopleList() }; }));
  app.get('/api/admin/people/:id', wrap((req) => { needDesk(req); return personFull(Number(req.params.id)); }));

  // Desk registration: a person, optionally a card, check-in and handouts in one go.
  app.post('/api/admin/people', wrap(async (req) => {
    needDesk(req);
    U.mustLimit(db, `register:${req.actor}`, 300, 3600e3);
    const b = req.body || {};
    const isAdmin = req.admin.role === 'admin';
    const allowDupes = !!b.allow_dupes && isAdmin;
    const id = core.createPerson(db, b, req.actor, { allowDupes });
    let card = null;
    try {
      if (b.card && b.card !== 'none') card = await core.issueCard(db, id, { cardId: b.card === 'next' ? null : b.card, newPin: !!b.new_pin, replace: !!b.replace && isAdmin }, req.actor);
    } catch (e) {
      // keep the person, tell the desk the card part failed
      if (e instanceof HttpError) return { person_id: id, card: null, card_error: e.message };
      throw e;
    }
    if (b.checkin) core.setCheckin(db, id, true, req.actor);
    for (const item of (Array.isArray(b.items) ? b.items : []).map(Number)) {
      if (db.prepare('SELECT 1 FROM items WHERE id = ?').get(item)) db.prepare('INSERT OR IGNORE INTO handouts (person_id, item_id, ts, by) VALUES (?, ?, ?, ?)').run(id, item, now(), req.actor);
    }
    sync();
    const s = U.getSettings(db);
    return { person_id: id, card: card ? { ...card, url: `${s.card_base.replace(/\/$/, '')}/${card.id}` } : null };
  }));

  app.patch('/api/admin/people/:id', wrap((req) => {
    needAdmin(req);
    const id = Number(req.params.id);
    const b = req.body || {};
    core.updatePerson(db, id, b, req.actor, { allowDupes: !!b.allow_dupes });
    const set = {};
    if ('mode' in b) { if (!['project', 'profile', 'custom'].includes(b.mode)) fail(400, 'Bad mode.'); set.mode = b.mode; }
    if ('custom_url' in b) set.custom_url = U.cleanUrl(b.custom_url) || null;
    if ('splash_msg' in b) set.splash_msg = U.cleanText(b.splash_msg, 60) || null;
    if ('disabled' in b) { set.disabled = b.disabled ? 1 : 0; if (b.disabled) core.killSessions(db, id); }
    if ('clear_profile' in b && b.clear_profile) set.profile = null;
    const keys = Object.keys(set);
    if (keys.length) {
      db.prepare(`UPDATE people SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), id);
      U.audit(db, req.actor, 'edited person', { person: id }, set);
    }
    sync();
    return personFull(id);
  }));

  app.post('/api/admin/people/:id/card', wrap(async (req) => {
    needDesk(req);
    const isAdmin = req.admin.role === 'admin';
    const b = req.body || {};
    if ((b.allow_second || b.replace) && !isAdmin) fail(403, 'Only admins can give a second card or take a card from someone.');
    const r = await core.issueCard(db, Number(req.params.id), { cardId: b.card || null, newPin: !!b.new_pin, allowSecond: !!b.allow_second, replace: !!b.replace }, req.actor);
    sync();
    const s = U.getSettings(db);
    return { ...r, url: `${s.card_base.replace(/\/$/, '')}/${r.id}`, full: personFull(Number(req.params.id)) };
  }));

  app.post('/api/admin/people/:id/checkin', wrap((req) => {
    needDesk(req);
    core.setCheckin(db, Number(req.params.id), req.body.on !== false, req.actor);
    return personFull(Number(req.params.id));
  }));

  app.post('/api/admin/people/:id/items/:item', wrap((req) => {
    needDesk(req);
    const pid = core.mustPerson(db, Number(req.params.id)).id;
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(req.params.item));
    if (!item) fail(404, 'No such item.');
    if (req.body.on === false) db.prepare('DELETE FROM handouts WHERE person_id = ? AND item_id = ?').run(pid, item.id);
    else db.prepare('INSERT OR IGNORE INTO handouts (person_id, item_id, ts, by) VALUES (?, ?, ?, ?)').run(pid, item.id, now(), req.actor);
    U.audit(db, req.actor, req.body.on === false ? `took back ${item.name}` : `handed out ${item.name}`, { person: pid });
    return personFull(pid);
  }));

  app.post('/api/admin/people/:id/points', wrap((req) => {
    needAdmin(req);
    core.addPoints(db, { personId: Number(req.params.id) }, req.body.delta, req.body.reason, req.actor);
    return personFull(Number(req.params.id));
  }));

  app.post('/api/admin/people/:id/:action', wrap((req) => {
    needAdmin(req);
    const id = Number(req.params.id);
    const p = core.mustPerson(db, id);
    switch (req.params.action) {
      case 'reset-account': core.resetAccount(db, id, req.actor); break;
      case 'kick': core.killSessions(db, id); U.audit(db, req.actor, 'logged them out', { person: id }); break;
      case 'unlock': db.prepare('UPDATE people SET pw_fails = 0, pw_locked_until = 0 WHERE id = ?').run(id); U.audit(db, req.actor, 'cleared login lockout', { person: id }); break;
      default: fail(404, 'Unknown action.');
    }
    return personFull(p.id);
  }));

  app.delete('/api/admin/people/:id', wrap((req) => {
    needAdmin(req);
    core.deletePerson(db, Number(req.params.id), req.actor);
    sync();
    return { ok: true };
  }));

  const PEOPLE_BULK = {
    tag_add: { desk: false, run: (p, v, actor) => core.updatePerson(db, p.id, { tags: [...U.tagsOf(p), v] }, actor, { allowDupes: true }) },
    tag_remove: { desk: false, run: (p, v, actor) => core.updatePerson(db, p.id, { tags: U.tagsOf(p).filter((t) => t !== String(v).toLowerCase()) }, actor, { allowDupes: true }) },
    team: { desk: false, run: (p, v, actor) => core.updatePerson(db, p.id, { team_id: v || null }, actor, { allowDupes: true }) },
    checkin: { desk: true, run: (p, v, actor) => core.setCheckin(db, p.id, true, actor) },
    checkout: { desk: true, run: (p, v, actor) => core.setCheckin(db, p.id, false, actor) },
    item: { desk: true, run: (p, v, actor) => db.prepare('INSERT OR IGNORE INTO handouts (person_id, item_id, ts, by) VALUES (?, ?, ?, ?)').run(p.id, Number(v), now(), actor) },
    points: { desk: false, run: (p, v, actor, reason) => core.addPoints(db, { personId: p.id }, v, reason, actor) },
    disable: { desk: false, run: (p) => { db.prepare('UPDATE people SET disabled = 1 WHERE id = ?').run(p.id); core.killSessions(db, p.id); } },
    enable: { desk: false, run: (p) => db.prepare('UPDATE people SET disabled = 0 WHERE id = ?').run(p.id) },
    mode_project: { desk: false, run: (p) => db.prepare("UPDATE people SET mode = 'project' WHERE id = ?").run(p.id) },
  };
  app.post('/api/admin/people/bulk', wrap((req) => {
    needDesk(req);
    const op = PEOPLE_BULK[req.body.action];
    if (!op) fail(400, 'Unknown action.');
    if (!op.desk && req.admin.role !== 'admin') fail(403, 'Desk accounts can\'t do that. Ask an admin.');
    if (req.body.action === 'item' && !db.prepare('SELECT 1 FROM items WHERE id = ?').get(Number(req.body.value))) fail(404, 'No such item.');
    if (req.body.action === 'team' && req.body.value && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(Number(req.body.value))) fail(404, 'No such team.');
    const ids = [...new Set((req.body.ids || []).map(Number).filter(Number.isInteger))].slice(0, 2000);
    if (!ids.length) fail(400, 'Select some people first.');
    let n = 0;
    for (const id of ids) {
      const p = core.getPerson(db, id);
      if (!p) continue;
      op.run(p, req.body.value, req.actor, req.body.reason);
      n++;
    }
    U.audit(db, req.actor, `bulk ${req.body.action}`, {}, `${n} people${req.body.value != null ? `: ${req.body.value}` : ''}`);
    sync();
    return { ok: true, count: n };
  }));

  // ---------- cards ----------
  app.get('/api/admin/cards', wrap((req) => {
    needDesk(req);
    const s = U.getSettings(db);
    const prs = prBest();
    const people = new Map(db.prepare('SELECT * FROM people').all().map((p) => [p.id, p]));
    return { cards: db.prepare('SELECT * FROM cards ORDER BY id').all().map((c) => cardView(c, people.get(c.person_id) || null, s, prs)) };
  }));
  app.get('/api/admin/cards/:id', wrap((req) => {
    needDesk(req);
    const c = core.mustCard(db, Number(req.params.id));
    const person = c.person_id ? core.getPerson(db, c.person_id) : null;
    const s = U.getSettings(db);
    return {
      card: cardView(c, person, s, prBest()),
      stats: tapStats([c.id]),
      scans: db.prepare('SELECT ts, reason, dest, country, ua FROM scans WHERE card_id = ? ORDER BY ts DESC LIMIT 25').all(c.id).map((x) => ({ ...x, device: device(x.ua) })),
      log: db.prepare('SELECT ts, actor, action, detail FROM log WHERE card_id = ? ORDER BY ts DESC LIMIT 40').all(c.id),
      prs: db.prepare('SELECT * FROM prs ORDER BY number DESC').all().filter((p) => p.card_id === c.id || U.parseJson(p.folders, []).includes(c.id)),
    };
  }));
  app.patch('/api/admin/cards/:id', wrap((req) => {
    needAdmin(req);
    const c = core.mustCard(db, Number(req.params.id));
    const b = req.body || {};
    const set = {};
    if ('status' in b) { if (!['active', 'disabled'].includes(b.status)) fail(400, 'Bad status.'); set.status = b.status; }
    if ('admin_url' in b) set.admin_url = U.cleanUrl(b.admin_url) || null;
    if ('lock_mode' in b) { if (!['global', 'locked', 'open'].includes(b.lock_mode)) fail(400, 'Bad lock.'); set.lock_mode = b.lock_mode; }
    if ('skip_override' in b) set.skip_override = b.skip_override ? 1 : 0;
    const keys = Object.keys(set);
    if (keys.length) {
      db.prepare(`UPDATE cards SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), c.id);
      U.audit(db, req.actor, 'edited card', { card: c.id, person: c.person_id }, set);
      sync();
    }
    return { ok: true };
  }));
  app.post('/api/admin/cards/generate', wrap(async (req) => {
    needAdmin(req);
    const count = Math.round(Number(req.body.count));
    if (!(count >= 1 && count <= 300)) fail(400, 'Make 1 to 300 at a time.');
    const made = await core.makeBlankCards(db, count, req.actor);
    sync();
    return { made };
  }));
  app.post('/api/admin/cards/:id/pin', wrap(async (req) => {
    needAdmin(req);
    return { id: Number(req.params.id), pin: await core.newPin(db, Number(req.params.id), req.actor) };
  }));
  app.post('/api/admin/cards/:id/unlock', wrap((req) => {
    needDesk(req);
    const c = core.mustCard(db, Number(req.params.id));
    db.prepare('UPDATE cards SET pin_fails = 0, pin_locked_until = 0 WHERE id = ?').run(c.id);
    U.audit(db, req.actor, 'cleared PIN lockout', { card: c.id, person: c.person_id });
    return { ok: true };
  }));
  app.post('/api/admin/cards/:id/unlink', wrap((req) => {
    needAdmin(req);
    core.unlinkCard(db, Number(req.params.id), req.actor);
    sync();
    return { ok: true };
  }));
  const CARD_BULK = {
    status: (v) => { if (!['active', 'disabled'].includes(v)) fail(400, 'Bad status.'); return { status: v }; },
    lock_mode: (v) => { if (!['global', 'locked', 'open'].includes(v)) fail(400, 'Bad lock.'); return { lock_mode: v }; },
    skip_override: (v) => ({ skip_override: v ? 1 : 0 }),
    admin_url: (v) => ({ admin_url: U.cleanUrl(v) || null }),
  };
  app.post('/api/admin/cards/bulk', wrap((req) => {
    needAdmin(req);
    const fn = CARD_BULK[req.body.action];
    if (!fn) fail(400, 'Unknown action.');
    const set = fn(req.body.value);
    const ids = [...new Set((req.body.ids || []).map(Number).filter(Number.isInteger))].slice(0, 2000);
    const keys = Object.keys(set);
    const st = db.prepare(`UPDATE cards SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`);
    for (const id of ids) st.run(...keys.map((k) => set[k]), id);
    U.audit(db, req.actor, `bulk cards ${req.body.action}`, {}, `${ids.length} cards`);
    sync();
    return { ok: true, count: ids.length };
  }));

  // ---------- teams ----------
  const teamFields = (b) => {
    const f = {};
    if ('name' in b) { f.name = U.cleanText(b.name, 60); if (!f.name) fail(400, 'Name the team.'); }
    if ('color' in b) f.color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : null;
    if ('place' in b) f.place = U.cleanText(b.place, 80) || null;
    if ('note' in b) f.note = String(b.note || '').replace(/\r/g, '').slice(0, 1000) || null;
    return f;
  };
  app.get('/api/admin/teams', wrap((req) => {
    needDesk(req);
    return { teams: db.prepare('SELECT * FROM teams ORDER BY name').all().map((t) => ({ ...t, members: db.prepare('SELECT id, name, points, checked_in_at FROM people WHERE team_id = ? ORDER BY name').all(t.id) })) };
  }));
  app.post('/api/admin/teams', wrap((req) => {
    needAdmin(req);
    const f = teamFields({ name: '', ...req.body });
    const id = Number(db.prepare('INSERT INTO teams (name, color, place, note, created_at) VALUES (?, ?, ?, ?, ?)').run(f.name, f.color ?? null, f.place ?? null, f.note ?? null, now()).lastInsertRowid);
    U.audit(db, req.actor, 'made team', {}, f.name);
    return { id };
  }));
  app.patch('/api/admin/teams/:id', wrap((req) => {
    needAdmin(req);
    const f = teamFields(req.body || {});
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE teams SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), Number(req.params.id));
    U.audit(db, req.actor, 'edited team', {}, f);
    return { ok: true };
  }));
  app.delete('/api/admin/teams/:id', wrap((req) => {
    needAdmin(req);
    const t = db.prepare('SELECT * FROM teams WHERE id = ?').get(Number(req.params.id));
    if (!t) fail(404, 'No such team.');
    db.prepare('UPDATE people SET team_id = NULL WHERE team_id = ?').run(t.id);
    db.prepare('DELETE FROM teams WHERE id = ?').run(t.id);
    U.audit(db, req.actor, 'deleted team', {}, t.name);
    return { ok: true };
  }));
  app.post('/api/admin/teams/:id/points', wrap((req) => {
    needAdmin(req);
    core.addPoints(db, { teamId: Number(req.params.id) }, req.body.delta, req.body.reason, req.actor);
    return { ok: true };
  }));
  // Split people into teams at random. scope: all | unassigned | checked_in | tag:<tag>
  app.post('/api/admin/teams/auto', wrap((req) => {
    needAdmin(req);
    const b = req.body || {};
    let pool = db.prepare('SELECT * FROM people WHERE disabled = 0').all();
    const scope = String(b.scope || 'unassigned');
    if (scope === 'unassigned') pool = pool.filter((p) => !p.team_id);
    else if (scope === 'checked_in') pool = pool.filter((p) => p.checked_in_at && !p.team_id);
    else if (scope.startsWith('tag:')) pool = pool.filter((p) => U.tagsOf(p).includes(scope.slice(4).toLowerCase()) && !p.team_id);
    if (!pool.length) fail(400, 'Nobody to split in that group.');
    const size = Math.round(Number(b.size || 0));
    let count = Math.round(Number(b.count || 0));
    if (!count && size >= 1) count = Math.ceil(pool.length / size);
    if (!(count >= 1 && count <= 200)) fail(400, 'Give a team size or a number of teams.');
    const prefix = U.cleanText(b.prefix, 40) || 'Team';
    const COLORS = ['#ec3750', '#ff8c37', '#f1c40f', '#33d6a6', '#5bc0de', '#338eda', '#a633d6', '#8492a6'];
    const teams = [];
    for (let i = 1; teams.length < count; i++) {
      const name = `${prefix} ${i}`;
      const existing = db.prepare('SELECT id FROM teams WHERE name = ?').get(name);
      if (existing && !b.fill_existing) continue;
      const id = existing ? existing.id : Number(db.prepare('INSERT INTO teams (name, color, created_at) VALUES (?, ?, ?)').run(name, COLORS[(i - 1) % COLORS.length], now()).lastInsertRowid);
      teams.push(id);
    }
    // shuffle, then deal out round-robin
    for (let i = pool.length - 1; i > 0; i--) { const j = require('node:crypto').randomInt(0, i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const st = db.prepare('UPDATE people SET team_id = ? WHERE id = ?');
    pool.forEach((p, i) => st.run(teams[i % teams.length], p.id));
    U.audit(db, req.actor, 'auto-split teams', {}, `${pool.length} people into ${teams.length} teams (${scope})`);
    return { people: pool.length, teams: teams.length };
  }));

  // ---------- notifications ----------
  function recipients(kind, target) {
    return db.prepare('SELECT * FROM people WHERE disabled = 0').all().filter((p) => noticeVisible({ target_kind: kind, target }, p));
  }
  const KINDS = ['all', 'team', 'tag', 'people', 'checked_in', 'not_checked_in'];
  app.get('/api/admin/notices', wrap((req) => {
    needDesk(req);
    const people = db.prepare('SELECT * FROM people WHERE disabled = 0').all();
    const teams = new Map(db.prepare('SELECT id, name FROM teams').all().map((t) => [String(t.id), t.name]));
    return {
      notices: db.prepare('SELECT * FROM notices ORDER BY ts DESC LIMIT 200').all().map((n) => ({
        ...n,
        audience: people.filter((p) => noticeVisible(n, p)).length,
        reads: db.prepare('SELECT COUNT(*) n FROM notice_reads WHERE notice_id = ?').get(n.id).n,
        target_label: n.target_kind === 'team' ? teams.get(String(n.target)) || 'deleted team' : n.target_kind === 'people' ? `${String(n.target).split(',').length} people` : n.target,
      })),
    };
  }));
  app.post('/api/admin/notices/preview', wrap((req) => {
    needAdmin(req);
    const r = recipients(req.body.target_kind, String(req.body.target ?? ''));
    return { count: r.length, with_email: r.filter((p) => p.email).length };
  }));
  app.post('/api/admin/notices', wrap(async (req) => {
    needAdmin(req);
    const b = req.body || {};
    const title = U.cleanText(b.title, 140);
    if (!title) fail(400, 'Give it a title.');
    const body = String(b.body || '').replace(/\r/g, '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').slice(0, 3000) || null;
    if (!KINDS.includes(b.target_kind)) fail(400, 'Pick who gets it.');
    let target = null;
    if (b.target_kind === 'team') { target = String(Number(b.target)); if (!db.prepare('SELECT 1 FROM teams WHERE id = ?').get(Number(target))) fail(404, 'No such team.'); }
    if (b.target_kind === 'tag') { target = core.cleanTags(b.target); if (!target || target.includes(',')) fail(400, 'Give one tag.'); }
    if (b.target_kind === 'people') {
      const ids = [...new Set((Array.isArray(b.target) ? b.target : String(b.target || '').split(',')).map(Number).filter(Number.isInteger))];
      if (!ids.length) fail(400, 'Pick at least one person.');
      target = ids.join(',');
    }
    const to = recipients(b.target_kind, target);
    if (!to.length) fail(400, 'Nobody matches that. Nothing sent.');
    const id = Number(db.prepare('INSERT INTO notices (ts, title, body, target_kind, target, urgent, emailed, by) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .run(now(), title, body, b.target_kind, target, b.urgent ? 1 : 0, req.actor).lastInsertRowid);
    U.audit(db, req.actor, 'sent notification', {}, `${title} → ${to.length} people`);
    let emailing = 0;
    if (b.email) {
      const s = U.getSettings(db);
      const link = s.dashboard_url ? `${s.dashboard_url}/me` : '';
      const list = to.filter((p) => p.email);
      emailing = list.length;
      // send in the background; a slow mail server shouldn't hold the dashboard
      (async () => {
        let sent = 0;
        for (const p of list) {
          try { await mail.sendNotice(p.email, title, body, link); sent++; } catch (e) { console.error('[notice mail]', p.email, e.message); }
        }
        db.prepare('UPDATE notices SET emailed = ? WHERE id = ?').run(sent, id);
      })();
    }
    return { id, count: to.length, emailing };
  }));
  app.delete('/api/admin/notices/:id', wrap((req) => {
    needAdmin(req);
    db.prepare('DELETE FROM notices WHERE id = ?').run(Number(req.params.id));
    U.audit(db, req.actor, 'deleted notification', {}, req.params.id);
    return { ok: true };
  }));

  // ---------- schedule ----------
  const schedFields = (b) => {
    const starts = Number(b.starts_at);
    if (!Number.isFinite(starts) || starts <= 0) fail(400, 'Give a start time.');
    const ends = b.ends_at ? Number(b.ends_at) : null;
    if (ends && ends <= starts) fail(400, 'It has to end after it starts.');
    const title = U.cleanText(b.title, 120);
    if (!title) fail(400, 'Give it a title.');
    return { starts_at: starts, ends_at: ends, title, place: U.cleanText(b.place, 80) || null, note: U.cleanText(b.note, 300) || null };
  };
  app.get('/api/admin/schedule', wrap((req) => { needDesk(req); return { schedule: db.prepare('SELECT * FROM schedule ORDER BY starts_at').all() }; }));
  app.post('/api/admin/schedule', wrap((req) => {
    needAdmin(req);
    const f = schedFields(req.body || {});
    db.prepare('INSERT INTO schedule (starts_at, ends_at, title, place, note) VALUES (?, ?, ?, ?, ?)').run(f.starts_at, f.ends_at, f.title, f.place, f.note);
    U.audit(db, req.actor, 'added to schedule', {}, f.title);
    return { ok: true };
  }));
  app.patch('/api/admin/schedule/:id', wrap((req) => {
    needAdmin(req);
    const f = schedFields(req.body || {});
    db.prepare('UPDATE schedule SET starts_at = ?, ends_at = ?, title = ?, place = ?, note = ? WHERE id = ?').run(f.starts_at, f.ends_at, f.title, f.place, f.note, Number(req.params.id));
    U.audit(db, req.actor, 'changed schedule', {}, f.title);
    return { ok: true };
  }));
  app.delete('/api/admin/schedule/:id', wrap((req) => {
    needAdmin(req);
    db.prepare('DELETE FROM schedule WHERE id = ?').run(Number(req.params.id));
    U.audit(db, req.actor, 'removed from schedule', {}, req.params.id);
    return { ok: true };
  }));

  // ---------- help desk ----------
  app.get('/api/admin/help', wrap((req) => {
    needDesk(req);
    return {
      help: db.prepare(`SELECT h.*, p.name, p.team_id, (SELECT GROUP_CONCAT(id) FROM cards c WHERE c.person_id = h.person_id) cards
        FROM help h LEFT JOIN people p ON p.id = h.person_id ORDER BY (h.status = 'done'), h.ts DESC LIMIT 300`).all(),
    };
  }));
  app.patch('/api/admin/help/:id', wrap((req) => {
    needDesk(req);
    const h = db.prepare('SELECT * FROM help WHERE id = ?').get(Number(req.params.id));
    if (!h) fail(404, 'No such request.');
    const status = ['open', 'claimed', 'done'].includes(req.body.status) ? req.body.status : h.status;
    const reply = 'reply' in req.body ? U.cleanText(req.body.reply, 300) || null : h.reply;
    db.prepare('UPDATE help SET status = ?, reply = ?, claimed_by = ?, updated_at = ? WHERE id = ?')
      .run(status, reply, status === 'open' ? null : h.claimed_by || req.admin.name || req.admin.email, now(), h.id);
    U.audit(db, req.actor, `help request ${status}`, { person: h.person_id }, reply);
    return { ok: true };
  }));

  // ---------- handout items ----------
  app.post('/api/admin/items', wrap((req) => {
    needAdmin(req);
    const name = U.cleanText(req.body.name, 60);
    if (!name) fail(400, 'Name the item.');
    const stock = req.body.stock ? Math.max(0, Math.round(Number(req.body.stock))) : null;
    db.prepare('INSERT INTO items (name, stock, created_at) VALUES (?, ?, ?)').run(name, stock, now());
    U.audit(db, req.actor, 'added handout item', {}, name);
    return { ok: true };
  }));
  app.patch('/api/admin/items/:id', wrap((req) => {
    needAdmin(req);
    const name = U.cleanText(req.body.name, 60);
    if (!name) fail(400, 'Name the item.');
    db.prepare('UPDATE items SET name = ?, stock = ? WHERE id = ?').run(name, req.body.stock ? Math.max(0, Math.round(Number(req.body.stock))) : null, Number(req.params.id));
    return { ok: true };
  }));
  app.delete('/api/admin/items/:id', wrap((req) => {
    needAdmin(req);
    const it = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(req.params.id));
    if (!it) fail(404, 'No such item.');
    db.prepare('DELETE FROM items WHERE id = ?').run(it.id);
    U.audit(db, req.actor, 'removed handout item', {}, it.name);
    return { ok: true };
  }));

  app.get('/api/admin/points', wrap((req) => {
    needDesk(req);
    return {
      log: db.prepare(`SELECT l.*, p.name person_name, t.name team_name FROM points_log l LEFT JOIN people p ON p.id = l.person_id LEFT JOIN teams t ON t.id = l.team_id ORDER BY l.ts DESC LIMIT 200`).all(),
    };
  }));

  // ---------- stats ----------
  app.get('/api/admin/stats', wrap((req) => {
    needDesk(req);
    const rows = db.prepare('SELECT card_id, ts, country, ua FROM scans WHERE ts > ?').all(now() - 30 * 86400e3);
    const days = Object.fromEntries(lastDays(14).map((d) => [d, 0]));
    const hours = Array.from({ length: 24 }, (_, i) => ({ hour: i, n: 0 }));
    const countries = {}, devices = {}, perCard = {};
    const dayAgo = now() - 86400e3;
    for (const r of rows) {
      const d = dayKey(r.ts);
      if (d in days) days[d]++;
      if (r.ts > dayAgo) hours[new Date(r.ts + IST).getUTCHours()].n++;
      if (r.country) countries[r.country] = (countries[r.country] || 0) + 1;
      const dv = device(r.ua);
      devices[dv] = (devices[dv] || 0) + 1;
      perCard[r.card_id] = (perCard[r.card_id] || 0) + 1;
    }
    const n = (sql, ...a) => db.prepare(sql).get(...a).n;
    const checkins = db.prepare('SELECT checked_in_at FROM people WHERE checked_in_at IS NOT NULL').all();
    const arrivals = Array.from({ length: 24 }, (_, i) => ({ hour: i, n: 0 }));
    const t0 = todayStart();
    for (const c of checkins) if (c.checked_in_at >= t0) arrivals[new Date(c.checked_in_at + IST).getUTCHours()].n++;
    return {
      totals: {
        people: n('SELECT COUNT(*) n FROM people'),
        here: n('SELECT COUNT(*) n FROM people WHERE checked_in_at IS NOT NULL'),
        set_up: n('SELECT COUNT(*) n FROM people WHERE password_hash IS NOT NULL'),
        with_card: n('SELECT COUNT(DISTINCT person_id) n FROM cards WHERE person_id IS NOT NULL'),
        cards: n('SELECT COUNT(*) n FROM cards'),
        free_cards: n('SELECT COUNT(*) n FROM cards WHERE person_id IS NULL'),
        teams: n('SELECT COUNT(*) n FROM teams'),
        profiles: n('SELECT COUNT(*) n FROM people WHERE profile IS NOT NULL'),
        own_links: n("SELECT COUNT(*) n FROM people WHERE mode = 'custom'"),
        sites_merged: n('SELECT COUNT(DISTINCT card_id) n FROM prs WHERE merged = 1 AND card_id IS NOT NULL'),
        help_open: n("SELECT COUNT(*) n FROM help WHERE status != 'done'"),
        taps_30d: rows.length,
        taps_all: n('SELECT COALESCE(SUM(scans), 0) n FROM cards'),
      },
      days: Object.entries(days).map(([day, c]) => ({ day, n: c })),
      hours, arrivals,
      countries: Object.entries(countries).sort((a, b) => b[1] - a[1]).slice(0, 8),
      devices,
      top: Object.entries(perCard).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, c]) => {
        const card = core.getCard(db, Number(id));
        const p = card?.person_id ? core.getPerson(db, card.person_id) : null;
        return { card: Number(id), n: c, person_id: p?.id || null, name: p?.name || '' };
      }),
      items: db.prepare('SELECT i.name, i.stock, (SELECT COUNT(*) FROM handouts h WHERE h.item_id = i.id) given FROM items i ORDER BY i.id').all(),
    };
  }));

  // ---------- settings ----------
  app.patch('/api/admin/settings', wrap((req) => {
    needAdmin(req);
    const b = req.body || {};
    const set = {};
    const ms = (v, label) => {
      if (!v) return '';
      const t = Number(v);
      if (!Number.isFinite(t)) fail(400, `Bad ${label}.`);
      return String(t);
    };
    const repo = (v) => {
      const r = String(v || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$|\/$/g, '');
      if (r && !/^[\w.-]+\/[\w.-]+$/.test(r)) fail(400, 'Write repos as owner/name.');
      return r;
    };
    const flag = (k) => { if (k in b) set[k] = b[k] ? '1' : '0'; };
    flag('override_on'); flag('lock_on'); flag('allow_profiles'); flag('help_open'); flag('owner_signup');
    if ('override_url' in b) set.override_url = U.cleanUrl(b.override_url);
    if ('override_from' in b) set.override_from = ms(b.override_from, 'start time');
    if ('override_until' in b) set.override_until = ms(b.override_until, 'end time');
    if ('unlock_at' in b) set.unlock_at = ms(b.unlock_at, 'unlock time');
    if ('project_template' in b) {
      const t = String(b.project_template || '').trim();
      if (!t.includes('{id}')) fail(400, 'The project link needs {id} in it, where the card number goes.');
      U.cleanUrl(t.replaceAll('{id}', '1'));
      set.project_template = t;
    }
    if ('card_base' in b) set.card_base = U.cleanUrl(b.card_base).replace(/\/$/, '');
    if ('dashboard_url' in b) {
      set.dashboard_url = U.cleanUrl(b.dashboard_url).replace(/\/$/, '');
      if (set.dashboard_url && !set.dashboard_url.startsWith('https://')) fail(400, 'The dashboard link has to be https.');
    }
    if ('redirect_repo' in b) set.redirect_repo = repo(b.redirect_repo);
    if ('repo' in b) set.repo = repo(b.repo);
    if ('inactive_url' in b) set.inactive_url = U.cleanUrl(b.inactive_url);
    if ('splash_ms' in b) {
      const n = Math.round(Number(b.splash_ms));
      if (!(n >= 0 && n <= 15000)) fail(400, 'Splash time is 0 to 15000 ms.');
      set.splash_ms = String(n);
    }
    if ('event_name' in b) set.event_name = U.cleanText(b.event_name, 80) || 'Boba Bash';
    if ('announcement' in b) set.announcement = U.cleanText(b.announcement, 300);
    if ('wall_note' in b) set.wall_note = U.cleanText(b.wall_note, 200);
    if ('instructions_md' in b) set.instructions_md = String(b.instructions_md || '').replace(/\r/g, '').slice(0, 50000);
    if ('tag_overrides' in b) {
      const out = {};
      for (const [tag, url] of Object.entries(b.tag_overrides || {})) {
        const t = core.cleanTags(tag);
        const u = U.cleanUrl(url);
        if (t && u) out[t] = u;
      }
      set.tag_overrides = JSON.stringify(out);
    }
    if (set.override_on === '1' && !(set.override_url ?? U.getSettings(db).override_url)) fail(400, 'Add the link all cards should go to.');
    U.setSettings(db, set);
    const logged = { ...set };
    if (logged.instructions_md) logged.instructions_md = `${logged.instructions_md.length} characters`;
    U.audit(db, req.actor, 'changed settings', {}, logged);
    sync();
    const s = U.getSettings(db);
    return { settings: s, global_locked: U.globalLocked(s), override_active: U.overrideActive(s) };
  }));

  // ---------- GitHub ----------
  app.post('/api/admin/github/sync', wrap(async (req) => {
    needAdmin(req);
    U.mustLimit(db, 'gh-sync', 10, 60e3, 'Syncing too often. Wait a minute.');
    const r = await gh.syncAll(db, DATA_DIR);
    U.audit(db, req.actor, 'synced GitHub', {}, r.errors?.length ? r.errors.join(' ') : r.error || 'ok');
    return r;
  }));
  app.post('/api/admin/prs/sync', wrap(async (req) => {
    needDesk(req);
    U.mustLimit(db, 'pr-sync', 6, 60e3, 'Syncing too often. Wait a minute.');
    try { return await gh.syncPrs(db, U.getSettings(db).repo); } catch (e) { fail(502, String(e.message || e)); }
  }));
  app.get('/api/admin/prs', wrap((req) => {
    needDesk(req);
    const cards = new Map(db.prepare('SELECT c.id, p.id pid, p.name, p.github FROM cards c LEFT JOIN people p ON p.id = c.person_id').all().map((c) => [c.id, c]));
    return {
      last_sync: Number(U.getSettings(db).last_pr_sync || 0),
      prs: db.prepare('SELECT * FROM prs ORDER BY number DESC').all().map((p) => {
        const folders = U.parseJson(p.folders, []);
        const owner = p.card_id ? cards.get(p.card_id) : null;
        const flags = [];
        if (folders.length > 1) flags.push(`touches ${folders.length} card folders`);
        if (p.outside) flags.push('edits files outside card folders');
        if (!folders.length) flags.push('no card folder');
        if (p.card_id && !owner) flags.push('card doesn\'t exist');
        if (owner?.github && owner.github.toLowerCase() !== String(p.author).toLowerCase()) flags.push(`card ${p.card_id} belongs to @${owner.github}`);
        return { ...p, folders, owner_name: owner?.name || '', person_id: owner?.pid || null, flags };
      }),
    };
  }));
  app.post('/api/admin/prs/:n/:action', wrap(async (req) => {
    needAdmin(req);
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1) fail(400, 'Bad PR number.');
    const repo = U.getSettings(db).repo;
    const pr = db.prepare('SELECT * FROM prs WHERE number = ?').get(n);
    try {
      if (req.params.action === 'merge') await gh.mergePr(repo, n, `${pr?.title || `PR #${n}`} (#${n})`);
      else if (req.params.action === 'close') await gh.closePr(repo, n);
      else fail(400, 'Merge or close.');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      fail(502, e.status === 403 ? 'The GitHub token can\'t write to the sites repo.' : String(e.message || e));
    }
    U.audit(db, req.actor, `${req.params.action === 'merge' ? 'merged' : 'closed'} PR #${n}`, { card: pr?.card_id ?? null });
    await gh.syncPrs(db, repo).catch(() => {});
    return { ok: true };
  }));

  // ---------- files ----------
  app.get('/api/admin/files', wrap((req) => {
    needDesk(req);
    return { files: db.prepare('SELECT * FROM files WHERE person_id IS NULL ORDER BY created_at DESC').all() };
  }));
  app.post('/api/admin/files', wrap((req) => {
    needAdmin(req);
    const f = saveUpload(req, req.actor);
    U.audit(db, req.actor, 'uploaded file', {}, f.name);
    return f;
  }));
  app.delete('/api/admin/files/:id', wrap((req) => {
    needAdmin(req);
    const f = db.prepare('SELECT * FROM files WHERE id = ? AND person_id IS NULL').get(req.params.id);
    if (!f) fail(404, 'No such file.');
    deleteFile(f.id);
    U.audit(db, req.actor, 'deleted file', {}, f.name);
    return { ok: true };
  }));

  // ---------- organisers ----------
  app.post('/api/admin/admins', wrap(async (req) => {
    needAdmin(req);
    return core.createAdmin(db, { email: req.body.email, name: req.body.name, role: req.body.role || 'admin' }, req.actor);
  }));
  app.patch('/api/admin/admins/:email', wrap((req) => {
    const me = needAdmin(req);
    const email = U.cleanEmail(req.params.email);
    if (!core.ROLES.includes(req.body.role)) fail(400, 'Role is admin or desk.');
    if (email === me.email) fail(400, 'You can\'t change your own role.');
    db.prepare('UPDATE admins SET role = ? WHERE email = ?').run(req.body.role, email);
    U.audit(db, req.actor, 'changed organiser role', {}, `${email}: ${req.body.role}`);
    return { ok: true };
  }));
  app.post('/api/admin/admins/:email/reset', wrap(async (req) => {
    needAdmin(req);
    return { password: await core.setAdminPassword(db, req.params.email, null, req.actor) };
  }));
  app.delete('/api/admin/admins/:email', wrap((req) => {
    const me = needAdmin(req);
    if (U.cleanEmail(req.params.email) === me.email) fail(400, 'You can\'t remove yourself.');
    core.removeAdmin(db, req.params.email, req.actor);
    return { ok: true };
  }));

  // ---------- start fresh (two steps, password twice, typed phrase) ----------
  const reset = require('./reset');
  const resetTokens = new Map(); // token -> { email, expires }
  async function mustPassword(req) {
    const row = db.prepare('SELECT password_hash FROM admins WHERE email = ?').get(req.admin.email);
    if (!(await U.checkSecret(String(req.body.password ?? ''), row.password_hash))) fail(400, 'Wrong password.');
  }
  app.post('/api/admin/reset/prepare', wrap(async (req) => {
    needAdmin(req);
    U.mustLimit(db, `reset:${req.admin.email}`, 10, 15 * 60e3, 'Too many reset attempts. Wait 15 minutes.');
    await mustPassword(req);
    const token = U.randomHex(16);
    resetTokens.set(token, { email: req.admin.email, expires: now() + 3 * 60e3 });
    U.audit(db, req.actor, 'started a reset (not done yet)');
    return { token, phrase: reset.PHRASE, counts: reset.counts(db), github: gh.hasToken(), expires_in: 180 };
  }));
  app.post('/api/admin/reset', wrap(async (req) => {
    needAdmin(req);
    U.mustLimit(db, `reset:${req.admin.email}`, 10, 15 * 60e3, 'Too many reset attempts. Wait 15 minutes.');
    const t = resetTokens.get(String(req.body.token || ''));
    resetTokens.delete(String(req.body.token || ''));
    if (!t || t.email !== req.admin.email || t.expires < now()) fail(400, 'This reset expired. Start again.');
    await mustPassword(req);
    if (String(req.body.phrase || '').trim() !== reset.PHRASE) fail(400, `Type ${reset.PHRASE} exactly.`);
    if (req.body.confirm_backup !== true) fail(400, 'Tick that you have a backup.');
    const result = reset.wipe(db, DATA_DIR, { keepSettings: req.body.keep_settings !== false, actor: req.actor });
    const github = req.body.github ? await gh.clearRepos(db) : null;
    if (github) U.audit(db, req.actor, 'cleared GitHub repos', {}, github);
    return { ok: true, removed: result.removed, backup: require('node:path').basename(result.backup), github };
  }));

  // ---------- log + exports ----------
  app.get('/api/admin/log', wrap((req) => {
    needDesk(req);
    const before = Number(req.query.before) || now() + 1;
    return { log: db.prepare('SELECT l.*, p.name person_name FROM log l LEFT JOIN people p ON p.id = l.person_id WHERE l.ts < ? ORDER BY l.ts DESC LIMIT 100').all(before) };
  }));
  app.get('/api/admin/export.json', wrap((req, res) => {
    needAdmin(req);
    U.audit(db, req.actor, 'exported backup');
    const dump = {};
    for (const t of ['people', 'cards', 'teams', 'notices', 'notice_reads', 'schedule', 'help', 'items', 'handouts', 'points_log', 'settings', 'admins', 'prs', 'log', 'scans', 'files']) {
      dump[t] = db.prepare(`SELECT * FROM ${t}`).all().map(({ pin_hash, password_hash, ...r }) => r);
    }
    res.set('content-disposition', `attachment; filename="bobabash-${dayKey(now())}.json"`);
    return { exported_at: now(), ...dump };
  }));
  app.get('/api/admin/export.csv', (req, res, next) => {
    try {
      needDesk(req);
      const teams = new Map(db.prepare('SELECT id, name FROM teams').all().map((t) => [t.id, t.name]));
      const items = db.prepare('SELECT * FROM items ORDER BY id').all();
      const cols = ['person', 'name', 'email', 'phone', 'github', 'tags', 'team', 'cards', 'checked_in', 'set_up', 'points', 'destination', 'taps', ...items.map((i) => i.name)];
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [cols.map(q).join(',')];
      for (const p of peopleList()) {
        lines.push([p.id, p.name, p.email, p.phone, p.github, p.tags.join(' '), teams.get(p.team_id) || '', p.cards.join(' '),
          p.checked_in_at ? new Date(p.checked_in_at).toISOString() : '', p.claimed ? 'yes' : 'no', p.points, p.now_url, p.scans,
          ...items.map((i) => (p.items.includes(i.id) ? 'yes' : ''))].map(q).join(','));
      }
      res.set({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="people-${dayKey(now())}.csv"`, 'cache-control': 'no-store' });
      res.send(lines.join('\n'));
    } catch (e) { next(e); }
  });
};
