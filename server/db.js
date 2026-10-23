// Opens the database and creates the tables. Shared by server.js and cli.js.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Columns added after a table first shipped: { table: { column: type } }.
// Applied before schema.sql, because the schema's indexes reference them.
const MIGRATIONS = {
  log: { person_id: 'INTEGER', team_id: 'INTEGER' },
  files: { person_id: 'INTEGER' },
  items: { emoji: 'TEXT' },
  cards: { crew: 'TEXT' },
  handouts: { qty: 'INTEGER NOT NULL DEFAULT 1' },
};

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'cards.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

  // The first version kept owners on the cards table. Only an empty one can be dropped safely.
  const cols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
  if (cols.includes('owner_name')) {
    const n = db.prepare('SELECT COUNT(*) n FROM cards').get().n;
    if (n > 0) throw new Error('Old card table with data in it. Export it before upgrading.');
    db.exec('DROP TABLE cards; DROP TABLE IF EXISTS files;');
  }

  for (const [table, add] of Object.entries(MIGRATIONS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    if (!have.size) continue; // table doesn't exist yet, the schema makes it whole
    for (const [col, type] of Object.entries(add)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  db.exec('PRAGMA foreign_keys = ON;');
  seedBoba(db);
  return db;
}

// Boba is the one thing every event hands out, so its tile is there from the start (once; deleting it sticks).
function seedBoba(db) {
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'boba_seeded'").get()) return;
  db.prepare("INSERT OR IGNORE INTO items (name, stock, emoji, created_at) VALUES ('Boba', NULL, '🧋', ?)").run(Date.now());
  db.prepare("INSERT INTO settings (key, value) VALUES ('boba_seeded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
}

module.exports = { open, seedBoba };
