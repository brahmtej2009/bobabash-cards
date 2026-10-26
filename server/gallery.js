// Event gallery: logged-in people upload photos, organisers approve them, approved ones show on /gallery.
// Photos live in their own folder and table, not in /files, so a pending photo is only ever visible to the
// person who sent it and to organisers.
const fs = require('node:fs');
const path = require('node:path');

module.exports = function gallery(ctx) {
  const { app, db, U, core, wrap, needOwner, needDesk, needAdmin, session, sniff, DATA_DIR } = ctx;
  const { now, fail } = U;
  const DIR = path.join(DATA_DIR, 'photos');
  fs.mkdirSync(DIR, { recursive: true });
  const IMAGE = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const MAX = 8 * 1024 * 1024;
  const STATES = ['pending', 'approved', 'rejected'];
  const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'Someone';
  const open = () => U.getSettings(db).gallery_open !== '0';
  const pendingCount = () => db.prepare("SELECT COUNT(*) n FROM photos WHERE status = 'pending'").get().n;
  ctx.photosPending = pendingCount;

  const mine = (p) => db.prepare('SELECT id, caption, status, created_at, reviewed_at FROM photos WHERE person_id = ? ORDER BY id DESC').all(p.id)
    .map((x) => ({ ...x, url: `/photo/${x.id}` }));

  // ---------- people ----------
  app.get('/api/me/photos', wrap((req) => ({ open: open(), photos: mine(needOwner(req)) })));

  app.post('/api/me/photos', wrap((req) => {
    const p = needOwner(req);
    if (!open()) fail(400, 'Photo uploads are closed right now.');
    U.mustLimit(db, `photo:${p.id}`, 40, 3600e3, 'That is a lot of photos for one hour. Try again a bit later.');
    if (db.prepare("SELECT COUNT(*) n FROM photos WHERE person_id = ? AND status = 'pending'").get(p.id).n >= 30) fail(400, 'You have 30 photos waiting for approval. Wait for some to be checked.');
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) fail(400, 'Pick a photo first.');
    if (buf.length > MAX) fail(413, 'Keep each photo under 8 MB.');
    const mime = sniff(buf);
    if (!IMAGE.includes(mime)) fail(415, 'Photos only: JPG, PNG, WebP or GIF.');
    // the same picture twice (by anyone, in any state) is refused: exact bytes, or a near-identical fingerprint
    const sha = require('node:crypto').createHash('sha256').update(buf).digest('hex');
    const dh = /^[0-9a-f]{16}$/.test(String(req.get('x-dhash') || '')) ? req.get('x-dhash') : null;
    const twin = db.prepare('SELECT person_id FROM photos WHERE sha = ? LIMIT 1').get(sha) || (dh && findTwin(dh));
    if (twin) fail(409, twin.person_id === p.id ? 'You already uploaded this photo.' : 'This photo is already in the gallery. Someone else shared it first.');
    let caption = '';
    try { caption = decodeURIComponent(req.get('x-caption') || ''); } catch {}
    caption = U.cleanText(caption, 140) || null;
    const id = U.randomHex(12);
    fs.writeFileSync(path.join(DIR, id), buf);
    db.prepare("INSERT INTO photos (id, person_id, mime, size, caption, sha, dhash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
      .run(id, p.id, mime, buf.length, caption, sha, dh, now());
    U.audit(db, `owner:${p.id}`, 'uploaded a photo', { person: p.id }, caption);
    return { ok: true, open: open(), photos: mine(p) };
  }));

  app.post('/api/me/photos/:id/delete', wrap((req) => {
    const p = needOwner(req);
    const ph = db.prepare('SELECT * FROM photos WHERE id = ? AND person_id = ?').get(String(req.params.id), p.id);
    if (!ph) fail(404, 'No such photo.');
    remove(ph.id);
    U.audit(db, `owner:${p.id}`, 'deleted their photo', { person: p.id });
    return { ok: true, open: open(), photos: mine(p) };
  }));

  // fingerprints within a few bits of each other are the same picture (re-saved, re-compressed, resized)
  const SAME = 6;
  function findTwin(dh) {
    const a = BigInt(`0x${dh}`);
    for (const r of db.prepare('SELECT person_id, dhash FROM photos WHERE dhash IS NOT NULL').all()) {
      let x = a ^ BigInt(`0x${r.dhash}`), bits = 0;
      while (x) { bits += Number(x & 1n); x >>= 1n; }
      if (bits <= SAME) return r;
    }
    return null;
  }

  function remove(id) {
    db.prepare('DELETE FROM photos WHERE id = ?').run(id);
    fs.rmSync(path.join(DIR, id), { force: true });
  }

  // ---------- organisers ----------
  app.get('/api/admin/photos', wrap((req) => {
    needDesk(req);
    const status = STATES.includes(req.query.status) ? req.query.status : 'pending';
    const rows = db.prepare(`SELECT ph.id, ph.caption, ph.status, ph.size, ph.created_at, ph.reviewed_by, ph.reviewed_at, p.id person_id, p.name
      FROM photos ph JOIN people p ON p.id = ph.person_id WHERE ph.status = ? ORDER BY ph.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 500`).all(status);
    const counts = Object.fromEntries(STATES.map((s) => [s, db.prepare('SELECT COUNT(*) n FROM photos WHERE status = ?').get(s).n]));
    // who shared the most: approved photos only
    const top = db.prepare("SELECT p.id person_id, p.name, COUNT(*) n FROM photos ph JOIN people p ON p.id = ph.person_id WHERE ph.status = 'approved' GROUP BY p.id ORDER BY n DESC, MIN(ph.created_at) ASC LIMIT 5").all();
    return { open: open(), counts, top, photos: rows.map((x) => ({ ...x, url: `/photo/${x.id}` })) };
  }));

  app.post('/api/admin/photos/:id', wrap((req) => {
    needDesk(req);
    const status = req.body?.status;
    if (!STATES.includes(status)) fail(400, 'Approve or reject.');
    const ph = db.prepare('SELECT * FROM photos WHERE id = ?').get(String(req.params.id));
    if (!ph) fail(404, 'No such photo.');
    db.prepare('UPDATE photos SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(status, req.actor, now(), ph.id);
    U.audit(db, req.actor, status === 'approved' ? 'approved a photo' : status === 'rejected' ? 'rejected a photo' : 'moved a photo back to pending', { person: ph.person_id });
    ctx.bus.emit('person', ph.person_id, 'photo');
    return { ok: true, pending: pendingCount() };
  }));

  app.post('/api/admin/photos/:id/delete', wrap((req) => {
    needDesk(req);
    const ph = db.prepare('SELECT * FROM photos WHERE id = ?').get(String(req.params.id));
    if (!ph) fail(404, 'No such photo.');
    remove(ph.id);
    U.audit(db, req.actor, 'deleted a photo', { person: ph.person_id });
    ctx.bus.emit('person', ph.person_id, 'photo');
    return { ok: true, pending: pendingCount() };
  }));

  app.post('/api/admin/gallery', wrap((req) => {
    needAdmin(req);
    const on = !!req.body?.open;
    U.setSettings(db, { gallery_open: on ? '1' : '0' });
    U.audit(db, req.actor, on ? 'opened photo uploads' : 'closed photo uploads');
    return { open: on };
  }));

  // ---------- everyone ----------
  // ---------- the events site's albums (events.boba-bash.xyz) ----------
  // Same container, so it's asked directly. Only its own photos are taken: ours come back to it under
  // "cards-" ids and are skipped here, so nothing echoes. Videos stay over there.
  const EVENTS_INTERNAL = process.env.EVENTS_INTERNAL || 'http://127.0.0.1:3101';
  const EVENTS_URL = (process.env.EVENTS_URL || 'https://events.boba-bash.xyz').replace(/\/$/, '');
  let eventsPart = { albums: [], photos: [] };
  async function pullEvents() {
    try {
      const r = await fetch(`${EVENTS_INTERNAL}/api/public`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const d = await r.json();
      const evs = new Map((d.events || []).map((e) => [e.id, e]));
      const photos = (d.photos || []).filter((p) => !String(p.id).startsWith('cards-') && p.kind !== 'video' && p.url);
      const albums = (d.categories || []).filter((c) => photos.some((p) => p.categoryId === c.id)).map((c) => {
        const e = evs.get(c.eventId);
        return { id: `ev-${c.id}`, name: c.name, event: e ? e.title : '', date: e ? e.date : '', link: e ? `${EVENTS_URL}/e/${e.id}` : '' };
      });
      eventsPart = {
        albums,
        photos: photos.map((p) => ({
          id: `ev-${p.id}`, album: `ev-${p.categoryId}`, url: `${EVENTS_URL}${p.url}`, thumb: p.thumb ? `${EVENTS_URL}${p.thumb}` : `${EVENTS_URL}${p.url}`,
          caption: p.caption || '', by: '', ts: p.createdAt || 0, w: p.w || null, h: p.h || null,
        })),
      };
    } catch {}
  }
  pullEvents();
  setInterval(pullEvents, 60e3);

  // the event's day (first schedule item, India time), so its album sorts among the events site's ones
  const eventDay = () => ctx.dayKey(db.prepare('SELECT MIN(starts_at) t FROM schedule').get().t || now());

  app.get('/api/gallery', (req, res) => {
    if (!U.limit(db, `gallery:${req.ip_}`, 240, 60e3)) return res.status(429).json({});
    const s = U.getSettings(db);
    const own = db.prepare(`SELECT ph.id, ph.caption, ph.reviewed_at, ph.created_at, p.name FROM photos ph JOIN people p ON p.id = ph.person_id
      WHERE ph.status = 'approved' AND p.disabled = 0 ORDER BY COALESCE(ph.reviewed_at, ph.created_at) DESC LIMIT 1000`).all()
      .map((x) => ({ id: x.id, album: 'gn', url: `/photo/${x.id}`, caption: x.caption || '', by: firstName(x.name), ts: x.created_at }));
    // ?own=1 is what the events site pulls: just the photos people shared here
    if (req.query.own) return res.set('cache-control', 'no-store').json({ event_name: s.event_name, photos: own });
    const albums = [
      ...(own.length ? [{ id: 'gn', name: s.event_name, event: s.event_name, date: eventDay(), link: '' }] : []),
      ...eventsPart.albums,
    ].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    res.set('cache-control', 'no-store').json({ event_name: s.event_name, albums, photos: [...own, ...eventsPart.photos] });
  });

  // a photo: approved = anyone; pending or rejected = only the person who sent it, or an organiser
  app.get('/photo/:id', (req, res) => {
    const ph = /^[a-f0-9]{24}$/.test(req.params.id) && db.prepare('SELECT ph.*, p.disabled FROM photos ph JOIN people p ON p.id = ph.person_id WHERE ph.id = ?').get(req.params.id);
    if (!ph) return res.status(404).type('text').send('Not found');
    const isPublic = ph.status === 'approved' && !ph.disabled;
    if (!isPublic) {
      const o = session(req, 'owner');
      const a = session(req, 'admin');
      if (!(a || (o && Number(o.subject) === ph.person_id))) return res.status(404).type('text').send('Not found');
    }
    res.set({
      'content-type': ph.mime,
      'cache-control': isPublic ? 'public, max-age=300' : 'private, no-store', // short: a photo rejected later shouldn't linger
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    });
    fs.createReadStream(path.join(DIR, ph.id)).on('error', () => res.status(404).end()).pipe(res);
  });
};
