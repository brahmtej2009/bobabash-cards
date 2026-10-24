// Start fresh: wipe every person, card, team, message, tap and upload, so testing data never reaches the event.
// Organisers always stay (or nobody could log in afterwards). A full JSON backup is written first.
const fs = require('node:fs');
const path = require('node:path');
const U = require('./util');

const PHRASE = 'RESET BOBA BASH';

// Order matters: children before parents.
const TABLES = ['photos', 'notice_reads', 'notices', 'team_notes', 'handout_log', 'handouts', 'items', 'points_log', 'help', 'schedule', 'scans', 'prs', 'cards', 'people', 'teams', 'files', 'otps', 'limits', 'log'];

function counts(db) {
  const n = (sql) => db.prepare(sql).get().n;
  return {
    people: n('SELECT COUNT(*) n FROM people'),
    cards: n('SELECT COUNT(*) n FROM cards'),
    teams: n('SELECT COUNT(*) n FROM teams'),
    messages: n('SELECT COUNT(*) n FROM notices'),
    schedule: n('SELECT COUNT(*) n FROM schedule'),
    help: n('SELECT COUNT(*) n FROM help'),
    handout_items: n('SELECT COUNT(*) n FROM items'),
    taps: n('SELECT COUNT(*) n FROM scans'),
    uploads: n('SELECT COUNT(*) n FROM files'),
    photos: n('SELECT COUNT(*) n FROM photos'),
    log_entries: n('SELECT COUNT(*) n FROM log'),
  };
}

function backup(db, dataDir) {
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const dump = { exported_at: U.now(), reason: 'before reset' };
  for (const t of [...TABLES, 'settings', 'admins']) dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
  const file = path.join(dir, `pre-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(dump));
  return file;
}

// Settings that describe the setup (hosts, repos, texts) can stay; the live switches always go back to safe defaults.
const RUNTIME = { override_on: '0', override_url: '', override_from: '', override_until: '', lock_on: '0', unlock_at: '', tag_overrides: '{}', announcement: '', wall_note: '', last_pr_sync: '0', last_publish: '0', last_publish_error: '' };

function wipe(db, dataDir, { keepSettings = true, actor }) {
  const before = counts(db);
  const file = backup(db, dataDir);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const t of TABLES) db.exec(`DELETE FROM ${t}`);
    db.exec("DELETE FROM sessions WHERE kind = 'owner'");
    db.exec(`DELETE FROM sqlite_sequence WHERE name IN (${TABLES.map((t) => `'${t}'`).join(',')})`);
    if (keepSettings) U.setSettings(db, RUNTIME);
    else db.exec('DELETE FROM settings');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec("DELETE FROM settings WHERE key = 'boba_seeded'");
  require('./db').seedBoba(db);
  for (const dir of ['uploads', 'photos'].map((d) => path.join(dataDir, d))) for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) fs.rmSync(path.join(dir, f), { force: true });
  U.audit(db, actor, 'reset everything to fresh', {}, { removed: before, backup: path.basename(file), kept_settings: keepSettings });
  return { removed: before, backup: file };
}

module.exports = { PHRASE, counts, wipe };
