// Opens the database and creates the tables. Shared by server.js and cli.js.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Columns added after a table first shipped: { table: { column: type } }.
// Applied before schema.sql, because the schema's indexes reference them.
const MIGRATIONS = {
  log: { person_id: 'INTEGER', team_id: 'INTEGER' },
  files: { person_id: 'INTEGER' },
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
  return db;
}

module.exports = { open };
