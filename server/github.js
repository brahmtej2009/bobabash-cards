// Everything the dashboard does on GitHub.
//   redirect repo (host 1): writes map.json + <n>/index.html copied from the repo's own card.html
//   sites repo    (host 2): writes <n>/index.html from template/index.html for new cards, reads PRs, merges/closes
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { now, getSettings, setSettings, resolve, projectUrl, parseJson, DEFAULT_SETTINGS } = require('./util');
const { renderProfile, vcard, hasContact } = require('./profile');

const API = 'https://api.github.com';
// The token can be pasted in Setup (kept in the server-only secrets table) or set as GITHUB_TOKEN in /etc/cards.env.
let DB = null;
const use = (db) => { DB = db; };
function token() {
  try { const t = DB && DB.prepare("SELECT v FROM secrets WHERE k = 'github'").get()?.v; if (t) return t; } catch {}
  return process.env.GITHUB_TOKEN || '';
}
const tokenSource = () => { try { if (DB && DB.prepare("SELECT 1 FROM secrets WHERE k = 'github'").get()) return 'dashboard'; } catch {} return process.env.GITHUB_TOKEN ? 'env' : 'none'; };
const hasToken = () => !!token();

async function gh(path, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'bobabash-cards', 'x-github-api-version': '2022-11-28' };
  const t = token();
  if (t) headers.authorization = `Bearer ${t}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status} on ${method} ${path}: ${data?.message || ''}`.trim());
    err.status = res.status;
    throw err;
  }
  return data;
}

const validRepo = (r) => /^[\w.-]+\/[\w.-]+$/.test(r || '');
// git's own blob id, so we can tell whether a file already has the content we want without downloading it
const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

async function repoState(repo) {
  const info = await gh(`/repos/${repo}`);
  const branch = info.default_branch;
  const ref = await gh(`/repos/${repo}/git/ref/heads/${branch}`);
  const tree = await gh(`/repos/${repo}/git/trees/${ref.object.sha}?recursive=1`);
  const files = new Map(tree.tree.filter((t) => t.type === 'blob').map((t) => [t.path, t.sha]));
  return { branch, head: ref.object.sha, files };
}

async function readBlob(repo, sha) {
  const b = await gh(`/repos/${repo}/git/blobs/${sha}`);
  return Buffer.from(b.content, b.encoding === 'base64' ? 'base64' : 'utf8');
}

// One commit with many files, through the git data API. A null buffer deletes that file.
async function commit(repo, state, files, message) {
  const tree = [];
  for (const [path, buf] of Object.entries(files)) {
    if (buf === null) { tree.push({ path, mode: '100644', type: 'blob', sha: null }); continue; }
    const blob = await gh(`/repos/${repo}/git/blobs`, { method: 'POST', body: { content: buf.toString('base64'), encoding: 'base64' } });
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const base = await gh(`/repos/${repo}/git/commits/${state.head}`);
  const t = await gh(`/repos/${repo}/git/trees`, { method: 'POST', body: { base_tree: base.tree.sha, tree } });
  const c = await gh(`/repos/${repo}/git/commits`, { method: 'POST', body: { message, tree: t.sha, parents: [state.head] } });
  await gh(`/repos/${repo}/git/refs/heads/${state.branch}`, { method: 'PATCH', body: { sha: c.sha } });
  return c.sha;
}

function buildMap(db, s = getSettings(db)) {
  const cards = {};
  const people = new Map(db.prepare('SELECT * FROM people').all().map((p) => [p.id, p]));
  for (const c of db.prepare('SELECT * FROM cards ORDER BY id').all()) {
    const r = resolve(c, people.get(c.person_id) || null, s);
    cards[c.id] = r.kind === 'go' ? { k: 'go', u: r.url, ...(r.msg ? { m: r.msg } : {}) } : { k: r.kind };
  }
  return { s: Number(s.splash_ms) || 0, live: s.dashboard_url || DEFAULT_SETTINGS.dashboard_url, cards };
}

// ---------- host 1 ----------
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

// Static profile pages for every person that has one: p/<person>/index.html (+ avatar, + contact.vcf).
function profileFiles(db, s, dataDir) {
  const out = {};
  for (const c of db.prepare('SELECT * FROM people WHERE profile IS NOT NULL AND disabled = 0').all()) {
    const p = parseJson(c.profile, null);
    if (!p) continue;
    let avatarSrc = '';
    if (p.avatar) {
      const f = db.prepare('SELECT * FROM files WHERE id = ?').get(p.avatar);
      const file = f && path.join(dataDir, 'uploads', f.id);
      if (f && EXT[f.mime] && fs.existsSync(file)) {
        avatarSrc = `avatar.${EXT[f.mime]}`;
        out[`p/${c.id}/${avatarSrc}`] = fs.readFileSync(file);
      }
    }
    const card = db.prepare('SELECT id FROM cards WHERE person_id = ? ORDER BY id LIMIT 1').get(c.id);
    const contact = hasContact(p, c);
    if (contact) out[`p/${c.id}/contact.vcf`] = Buffer.from(vcard(c.id, p, c, `${s.card_base}/p/${c.id}/`));
    out[`p/${c.id}/index.html`] = Buffer.from(renderProfile(c.id, p, { projectUrl: card ? projectUrl(s, card.id) : '', avatarSrc, contactHref: contact ? 'contact.vcf' : '' }));
  }
  return out;
}

async function syncRedirectRepo(db, s, dataDir) {
  const repo = s.redirect_repo;
  if (!validRepo(repo)) throw new Error('Set the redirect repo as owner/name under Control.');
  const st = await repoState(repo);
  const want = {};
  const mapBuf = Buffer.from(JSON.stringify(buildMap(db, s), null, 1) + '\n');
  if (st.files.get('map.json') !== blobSha(mapBuf)) want['map.json'] = mapBuf;
  let profiles = 0;
  for (const [p, buf] of Object.entries(profileFiles(db, s, dataDir))) {
    if (st.files.get(p) === blobSha(buf)) continue;
    want[p] = buf;
    if (p.endsWith('index.html')) profiles++;
  }

  const tplSha = st.files.get('card.html');
  let pages = 0;
  if (tplSha) {
    let tpl = null;
    for (const { id } of db.prepare('SELECT id FROM cards ORDER BY id').all()) {
      // identical content = identical blob id, so stale or missing pages are the ones whose id differs
      if (st.files.get(`${id}/index.html`) === tplSha) continue;
      tpl = tpl || (await readBlob(repo, tplSha));
      want[`${id}/index.html`] = tpl;
      pages++;
    }
  }
  if (!Object.keys(want).length) return { repo, changed: 0, note: tplSha ? '' : 'No card.html in the repo yet, so no card pages were made.' };
  const parts = [want['map.json'] ? 'map' : '', pages ? `${pages} card page${pages === 1 ? '' : 's'}` : '', profiles ? `${profiles} profile${profiles === 1 ? '' : 's'}` : ''].filter(Boolean).join(' + ') || 'avatars';
  await commit(repo, st, want, `Cards: update ${parts}`);
  return { repo, changed: Object.keys(want).length, note: tplSha ? '' : 'No card.html in the repo yet, so no card pages were made.' };
}

// ---------- host 2 ----------
async function syncSitesRepo(db, s) {
  const repo = s.repo;
  if (!validRepo(repo)) throw new Error('Set the sites repo as owner/name under Control.');
  const st = await repoState(repo);
  const tplSha = st.files.get('template/index.html');
  if (!tplSha) return { repo, changed: 0, note: 'No template/index.html in the sites repo yet, so no folders were made.' };
  const have = new Set([...st.files.keys()].map((p) => p.split('/')[0]));
  const missing = db.prepare("SELECT id FROM cards WHERE status = 'active' AND person_id IS NOT NULL ORDER BY id").all().map((r) => r.id).filter((id) => !have.has(String(id)));
  const want = {};
  if (missing.length) {
    const tpl = (await readBlob(repo, tplSha)).toString('utf8');
    for (const id of missing) want[`${id}/index.html`] = Buffer.from(tpl.replaceAll('{{id}}', String(id)));
  }
  // The printed QR codes open sites/<n> (no slash). <n>.html answers that address: the logo, then it asks the
  // dashboard where the card goes, so QR scans follow the same settings as taps. The project stays in <n>/.
  const loaderSha = st.files.get('loader.html');
  let loaders = 0;
  if (loaderSha) {
    for (const { id } of db.prepare('SELECT id FROM cards ORDER BY id').all()) {
      if (st.files.get(`${id}.html`) !== loaderSha) { want[`${id}.html`] = 'loader'; loaders++; }
    }
    if (loaders) { const buf = await readBlob(repo, loaderSha); for (const k of Object.keys(want)) if (want[k] === 'loader') want[k] = buf; }
  }
  if (!Object.keys(want).length) return { repo, changed: 0, note: loaderSha ? '' : 'No loader.html in the sites repo, so QR codes open the project folder directly.' };
  await commit(repo, st, want, [missing.length ? `start folder${missing.length === 1 ? '' : 's'} ${missing.join(', ')}` : '', loaders ? `${loaders} QR loader${loaders === 1 ? '' : 's'}` : ''].filter(Boolean).join(' + ').replace(/^/, 'Cards: '));
  return { repo, changed: Object.keys(want).length, note: '' };
}

// ---------- sync both, debounced ----------
let timer = null;
let unlockTimer = null;
let running = null;

async function syncAll(db, dataDir) {
  if (running) return running;
  running = (async () => {
    const s = getSettings(db);
    fs.writeFileSync(path.join(dataDir, 'map.json'), JSON.stringify(buildMap(db, s), null, 1));
    if (!hasToken()) {
      setSettings(db, { last_publish_error: 'No GITHUB_TOKEN on the server. Only a local map.json was written.' });
      return { error: 'No GITHUB_TOKEN on the server.' };
    }
    const out = {};
    const errors = [];
    for (const [k, fn] of [['redirect', syncRedirectRepo], ['sites', syncSitesRepo]]) {
      try { out[k] = await fn(db, s, dataDir); } catch (e) { errors.push(String(e.message || e)); }
    }
    const notes = [out.redirect?.note, out.sites?.note].filter(Boolean);
    setSettings(db, { last_publish: now(), last_publish_error: [...errors, ...notes].join(' ') });
    return { ...out, errors };
  })();
  try { return await running; } finally { running = null; }
}

// GitHub Pages redeploys on each commit, so bursts of edits become one commit.
function schedule(db, dataDir, delay = 8000) {
  clearTimeout(timer);
  timer = setTimeout(() => syncAll(db, dataDir).catch((e) => console.error('[github sync]', e)), delay);
  clearTimeout(unlockTimer);
  const at = Number(getSettings(db).unlock_at || 0);
  const wait = at - now() + 2000;
  if (at && wait > 0 && wait < 2 ** 31 - 1) unlockTimer = setTimeout(() => syncAll(db, dataDir).catch(() => {}), wait);
}

// ---------- pull requests ----------
async function syncPrs(db, repo) {
  if (!validRepo(repo)) throw new Error('Set the sites repo as owner/name first.');
  const prs = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(`/repos/${repo}/pulls?state=all&per_page=100&page=${page}`);
    prs.push(...batch);
    if (batch.length < 100) break;
  }
  const known = new Map(db.prepare('SELECT number, updated_at FROM prs').all().map((r) => [r.number, r.updated_at]));
  const upsert = db.prepare(`INSERT INTO prs (number, title, author, state, merged, approved, url, card_id, folders, outside, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(number) DO UPDATE SET title=excluded.title, author=excluded.author, state=excluded.state, merged=excluded.merged,
      approved=excluded.approved, url=excluded.url, card_id=excluded.card_id, folders=excluded.folders, outside=excluded.outside, updated_at=excluded.updated_at`);
  let changed = 0;
  for (const pr of prs) {
    if (known.get(pr.number) === pr.updated_at) continue;
    const files = await gh(`/repos/${repo}/pulls/${pr.number}/files?per_page=100`);
    const folders = new Set();
    let outside = 0;
    for (const f of files) {
      for (const name of [f.filename, f.previous_filename].filter(Boolean)) {
        const m = /^(\d+)\//.exec(name);
        if (m) folders.add(Number(m[1])); else outside = 1;
      }
    }
    const reviews = await gh(`/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`);
    const latest = new Map();
    for (const r of reviews) if (r.state !== 'COMMENTED') latest.set(r.user?.login, r.state);
    const approved = [...latest.values()].includes('APPROVED') ? 1 : 0;
    const list = [...folders].sort((a, b) => a - b);
    upsert.run(pr.number, pr.title, pr.user?.login || '', pr.state, pr.merged_at ? 1 : 0, approved, pr.html_url,
      list.length === 1 ? list[0] : null, JSON.stringify(list), outside, pr.updated_at);
    changed++;
  }
  setSettings(db, { last_pr_sync: now() });
  return { total: prs.length, changed };
}

// Reset: remove every card page, profile and card folder the event made, and empty map.json.
// The repos' own files (card.html, index.html, template/, go.js, README, workflows) stay.
async function clearRepos(db) {
  if (!hasToken()) return { error: 'No GITHUB_TOKEN on the server, GitHub left as it was.' };
  const s = getSettings(db);
  const out = {};
  for (const [key, repo, match] of [
    ['redirect', s.redirect_repo, (p) => /^\d+\//.test(p) || p.startsWith('p/')],
    ['sites', s.repo, (p) => /^\d+\//.test(p)],
  ]) {
    try {
      if (!validRepo(repo)) throw new Error(`Repo not set (${key}).`);
      const st = await repoState(repo);
      const want = {};
      for (const p of st.files.keys()) if (match(p)) want[p] = null;
      if (key === 'redirect') want['map.json'] = Buffer.from(JSON.stringify({ s: Number(s.splash_ms) || 0, live: s.dashboard_url || DEFAULT_SETTINGS.dashboard_url, cards: {} }, null, 1) + '\n');
      const removed = Object.values(want).filter((v) => v === null).length;
      if (removed || key === 'redirect') await commit(repo, st, want, `Cards: start fresh (${removed} files removed)`);
      out[key] = { repo, removed };
    } catch (e) { out[key] = { repo, error: String(e.message || e) }; }
  }
  return out;
}

const mergePr = (repo, n, title) => gh(`/repos/${repo}/pulls/${n}/merge`, { method: 'PUT', body: { merge_method: 'squash', commit_title: title } });
const closePr = (repo, n) => gh(`/repos/${repo}/pulls/${n}`, { method: 'PATCH', body: { state: 'closed' } });

// can this token write to a repo? (used when a token is pasted in Setup)
async function canPush(repo) {
  const r = await gh(`/repos/${repo}`);
  return !!r?.permissions?.push;
}

module.exports = { use, tokenSource, canPush, buildMap, profileFiles, syncAll, schedule, syncPrs, mergePr, closePr, clearRepos, hasToken, EXT };
