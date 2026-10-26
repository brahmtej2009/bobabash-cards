// Likes and comments on the event gallery, which lives on the events site (events.boba-bash.xyz/gallery).
// People are who they are here (their cards login), so the events page calls these endpoints with the
// login cookie. Only that one origin is allowed, only for these endpoints, and nothing else about an
// account can be read or changed from there: just "who am I (first name)", likes and comments.
module.exports = function social(ctx) {
  const { app, db, U, core, session } = ctx;
  const { now, fail } = U;
  const EVENTS_ORIGIN = new URL(process.env.EVENTS_URL || 'https://events.boba-bash.xyz').origin;
  const KEY = /^[A-Za-z0-9-]{1,48}$/;
  const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'Someone';
  const commentsOpen = () => U.getSettings(db).comments_open !== '0';

  // CORS for the events origin is set up in server.js, next to the same-origin guard it relaxes

  // logged in? (owner session cookie: same-site, so the events subdomain's requests carry it)
  function who(req) {
    const s = session(req, 'owner');
    const p = s && core.getPerson(db, s.subject);
    return p && !p.disabled && p.password_hash ? p : null;
  }
  function mustWho(req) {
    const p = who(req);
    if (!p) fail(401, 'Log in on the cards dashboard first.');
    return p;
  }

  // which photo keys exist: the events site's photo ids (its own and the "cards-" ones it copied from here)
  let known = new Set(), knownAt = 0;
  async function refreshKnown(force) {
    if (!force && now() - knownAt < 60e3) return;
    try {
      const r = await fetch(`${process.env.EVENTS_INTERNAL || 'http://127.0.0.1:3101'}/api/public`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { known = new Set(((await r.json()).photos || []).map((p) => String(p.id))); knownAt = now(); }
    } catch {}
  }
  refreshKnown(true);
  async function mustKey(key) {
    if (!KEY.test(key)) fail(404, 'No such photo.');
    if (!known.has(key)) await refreshKnown(true);
    if (!known.has(key)) fail(404, 'No such photo.');
    return key;
  }

  const counts = () => {
    const out = {};
    for (const r of db.prepare('SELECT photo_key k, COUNT(*) n FROM photo_likes GROUP BY photo_key').all()) (out[r.k] ||= { likes: 0, comments: 0 }).likes = r.n;
    for (const r of db.prepare('SELECT photo_key k, COUNT(*) n FROM photo_comments WHERE hidden = 0 GROUP BY photo_key').all()) (out[r.k] ||= { likes: 0, comments: 0 }).comments = r.n;
    return out;
  };

  // everything the gallery page needs up front: who's looking, and counts per photo
  app.get('/api/social', (req, res) => {
    if (!U.limit(db, `social:${req.ip_}`, 240, 60e3)) return res.status(429).json({});
    const p = who(req);
    const liked = p ? db.prepare('SELECT photo_key FROM photo_likes WHERE person_id = ?').all(p.id).map((r) => r.photo_key) : [];
    res.set('cache-control', 'no-store').json({ me: p ? { name: firstName(p.name) } : null, comments_open: commentsOpen(), counts: counts(), liked });
  });

  // one photo's comments
  app.get('/api/social/photo/:key', ctx.wrap(async (req) => {
    if (!U.limit(db, `social:${req.ip_}`, 240, 60e3)) fail(429, 'Slow down a little.');
    const key = await mustKey(String(req.params.key));
    const p = who(req);
    return {
      comments: db.prepare('SELECT c.id, c.body, c.ts, c.person_id, pe.name FROM photo_comments c JOIN people pe ON pe.id = c.person_id WHERE c.photo_key = ? AND c.hidden = 0 ORDER BY c.ts').all(key)
        .map((c) => ({ id: c.id, body: c.body, ts: c.ts, by: firstName(c.name), mine: !!p && c.person_id === p.id })),
      likes: db.prepare('SELECT COUNT(*) n FROM photo_likes WHERE photo_key = ?').get(key).n,
      liked: !!p && !!db.prepare('SELECT 1 FROM photo_likes WHERE photo_key = ? AND person_id = ?').get(key, p.id),
    };
  }));

  app.post('/api/social/photo/:key/like', ctx.wrap(async (req) => {
    const p = mustWho(req);
    U.mustLimit(db, `like:${p.id}`, 300, 3600e3);
    const key = await mustKey(String(req.params.key));
    if (req.body?.on === false) db.prepare('DELETE FROM photo_likes WHERE photo_key = ? AND person_id = ?').run(key, p.id);
    else db.prepare('INSERT OR IGNORE INTO photo_likes (photo_key, person_id, ts) VALUES (?, ?, ?)').run(key, p.id, now());
    return { likes: db.prepare('SELECT COUNT(*) n FROM photo_likes WHERE photo_key = ?').get(key).n, liked: req.body?.on !== false };
  }));

  app.post('/api/social/photo/:key/comment', ctx.wrap(async (req) => {
    const p = mustWho(req);
    if (!commentsOpen()) fail(400, 'Comments are closed right now.');
    U.mustLimit(db, `comment:${p.id}`, 20, 10 * 60e3, 'That is a lot of comments. Take a breather.');
    const key = await mustKey(String(req.params.key));
    const body = U.cleanText(req.body?.body, 300);
    if (!body || body.length < 2) fail(400, 'Write a comment first.');
    if (/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|xyz|io|in|me|ly|gg)\b/i.test(body)) fail(400, 'No links in comments, please.');
    const id = Number(db.prepare('INSERT INTO photo_comments (photo_key, person_id, body, ts) VALUES (?, ?, ?, ?)').run(key, p.id, body, now()).lastInsertRowid);
    U.audit(db, `owner:${p.id}`, 'commented on a photo', { person: p.id }, body);
    return { id };
  }));

  // people delete their own comments; organisers delete anyone's (admin route below)
  app.post('/api/social/comment/:id/delete', ctx.wrap((req) => {
    const p = mustWho(req);
    const c = db.prepare('SELECT * FROM photo_comments WHERE id = ?').get(Number(req.params.id));
    if (!c || c.person_id !== p.id) fail(404, 'No such comment.');
    db.prepare('DELETE FROM photo_comments WHERE id = ?').run(c.id);
    return { ok: true };
  }));

  // ---------- organisers ----------
  app.get('/api/admin/comments', ctx.wrap((req) => {
    ctx.needDesk(req);
    return {
      open: commentsOpen(),
      comments: db.prepare(`SELECT c.id, c.photo_key, c.body, c.ts, c.hidden, pe.id person_id, pe.name FROM photo_comments c JOIN people pe ON pe.id = c.person_id ORDER BY c.ts DESC LIMIT 300`).all(),
      likes: db.prepare('SELECT COUNT(*) n FROM photo_likes').get().n,
    };
  }));
  app.post('/api/admin/comments/:id/delete', ctx.wrap((req) => {
    ctx.needDesk(req);
    const c = db.prepare('SELECT * FROM photo_comments WHERE id = ?').get(Number(req.params.id));
    if (!c) fail(404, 'Already gone.');
    db.prepare('DELETE FROM photo_comments WHERE id = ?').run(c.id);
    U.audit(db, req.actor, 'deleted a gallery comment', { person: c.person_id }, c.body);
    return { ok: true };
  }));
  app.post('/api/admin/comments-open', ctx.wrap((req) => {
    ctx.needAdmin(req);
    U.setSettings(db, { comments_open: req.body?.open ? '1' : '0' });
    U.audit(db, req.actor, req.body?.open ? 'opened gallery comments' : 'closed gallery comments');
    return { open: !!req.body?.open };
  }));
};
