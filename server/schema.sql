-- Boba Bash cards + event. Times are unix ms.

-- A person at the event. May or may not hold a card.
CREATE TABLE IF NOT EXISTS people (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,                        -- login id; null for people who never log in
  phone         TEXT,
  github        TEXT,
  note          TEXT,                               -- organisers only
  tags          TEXT,                               -- comma separated, e.g. attendee,volunteer
  team_id       INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  password_hash TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  claimed_at    INTEGER,                            -- set up their account
  pw_fails      INTEGER NOT NULL DEFAULT 0,
  pw_locked_until INTEGER NOT NULL DEFAULT 0,
  checked_in_at INTEGER,
  points        INTEGER NOT NULL DEFAULT 0,
  -- what their card(s) open, their choice
  mode          TEXT NOT NULL DEFAULT 'project',    -- project | profile | custom
  custom_url    TEXT,
  splash_msg    TEXT,                               -- line under the logo while a card loads
  profile       TEXT,                               -- json
  disabled      INTEGER NOT NULL DEFAULT 0,         -- can't log in
  created_by    TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS people_team ON people(team_id);

-- A physical card. The number is the chip URL.
CREATE TABLE IF NOT EXISTS cards (
  id            INTEGER PRIMARY KEY,
  pin_hash      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',     -- active | disabled
  person_id     INTEGER REFERENCES people(id) ON DELETE SET NULL,
  admin_url     TEXT,                               -- organiser override for this card only
  lock_mode     TEXT NOT NULL DEFAULT 'global',     -- global | locked | open
  skip_override INTEGER NOT NULL DEFAULT 0,         -- ignore the all-cards link
  pin_fails     INTEGER NOT NULL DEFAULT 0,
  pin_locked_until INTEGER NOT NULL DEFAULT 0,
  scans         INTEGER NOT NULL DEFAULT 0,
  last_scan_at  INTEGER,
  linked_at     INTEGER,
  crew          TEXT,                               -- printed on the card (Club, Spade, Heart...); holders join that team
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_person ON cards(person_id);

CREATE TABLE IF NOT EXISTS teams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT,
  place      TEXT,                                  -- table / room
  note       TEXT,                                  -- shown to members
  points     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  target_kind TEXT NOT NULL,                        -- all | team | tag | person | checked_in | not_checked_in
  target      TEXT,
  urgent      INTEGER NOT NULL DEFAULT 0,
  emailed     INTEGER NOT NULL DEFAULT 0,
  by          TEXT
);
CREATE TABLE IF NOT EXISTS notice_reads (
  notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (notice_id, person_id)
);

CREATE TABLE IF NOT EXISTS schedule (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  starts_at INTEGER NOT NULL,
  ends_at   INTEGER,
  title     TEXT NOT NULL,
  place     TEXT,
  note      TEXT
);

CREATE TABLE IF NOT EXISTS help (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  INTEGER REFERENCES people(id) ON DELETE CASCADE,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,                         -- tech | card | food | medical | other
  message    TEXT,
  status     TEXT NOT NULL DEFAULT 'open',          -- open | claimed | done
  claimed_by TEXT,
  reply      TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,                  -- e.g. T-shirt, Dinner, Stickers
  stock      INTEGER,                               -- how many we have in total; NULL = not counted
  emoji      TEXT,                                  -- shown on the tile
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS handouts (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  ts        INTEGER NOT NULL,                       -- last time they got one
  by        TEXT,
  qty       INTEGER NOT NULL DEFAULT 1,             -- boba can go out more than once
  PRIMARY KEY (person_id, item_id)
);
-- every single give, so the counter can show a feed and undo a mistake
CREATE TABLE IF NOT EXISTS handout_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  card_id   INTEGER,
  qty_after INTEGER NOT NULL,
  by        TEXT,
  undone    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS handout_log_item ON handout_log (item_id, id);

CREATE TABLE IF NOT EXISTS points_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
  team_id   INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  delta     INTEGER NOT NULL,
  reason    TEXT,
  by        TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS admins (
  email    TEXT PRIMARY KEY,
  name     TEXT,
  role     TEXT NOT NULL DEFAULT 'admin',            -- admin | desk
  password_hash TEXT,
  pw_fails INTEGER NOT NULL DEFAULT 0,
  pw_locked_until INTEGER NOT NULL DEFAULT 0,
  added_by TEXT,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                          -- admin | owner
  subject    TEXT NOT NULL,                          -- admin email or person id
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS sessions_subject ON sessions(kind, subject);

CREATE TABLE IF NOT EXISTS otps (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  subject    TEXT NOT NULL,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  payload    TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS otps_subject ON otps(kind, subject);

CREATE TABLE IF NOT EXISTS limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scans (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  ts      INTEGER NOT NULL,
  reason  TEXT,
  dest    TEXT,
  country TEXT,
  ua      TEXT
);
CREATE INDEX IF NOT EXISTS scans_card ON scans(card_id, ts);
CREATE INDEX IF NOT EXISTS scans_ts ON scans(ts);

CREATE TABLE IF NOT EXISTS log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  actor     TEXT NOT NULL,                           -- admin:<email> | owner:<person> | cli:<user> | system
  action    TEXT NOT NULL,
  card_id   INTEGER,
  person_id INTEGER,
  team_id   INTEGER,
  detail    TEXT
);
CREATE INDEX IF NOT EXISTS log_card ON log(card_id, ts);
CREATE INDEX IF NOT EXISTS log_team ON log(team_id, ts);

-- organisers' own notes on a team, newest first
CREATE TABLE IF NOT EXISTS team_notes (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  ts      INTEGER NOT NULL,
  by      TEXT,
  text    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS log_person ON log(person_id, ts);

CREATE TABLE IF NOT EXISTS prs (
  number     INTEGER PRIMARY KEY,
  title      TEXT,
  author     TEXT,
  state      TEXT,
  merged     INTEGER NOT NULL DEFAULT 0,
  approved   INTEGER NOT NULL DEFAULT 0,
  url        TEXT,
  card_id    INTEGER,
  folders    TEXT,
  outside    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS prs_card ON prs(card_id);

CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  added_by   TEXT,
  person_id  INTEGER,                                -- set for an owner's avatar
  created_at INTEGER NOT NULL
);

-- server-only secrets (SMTP password). Never sent to a browser, never in exports or backups downloads.
CREATE TABLE IF NOT EXISTS secrets (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- event gallery: people upload, organisers approve, approved ones are public at /gallery
CREATE TABLE IF NOT EXISTS photos (
  id          TEXT PRIMARY KEY,                       -- also the file name in DATA_DIR/photos
  person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  caption     TEXT,
  sha         TEXT,                                   -- sha256 of the file: exact re-uploads
  dhash       TEXT,                                   -- 64-bit visual fingerprint (hex): the same picture re-compressed
  status      TEXT NOT NULL DEFAULT 'pending',        -- pending | approved | rejected
  reviewed_by TEXT,
  reviewed_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_status ON photos(status, created_at);
CREATE INDEX IF NOT EXISTS photos_sha ON photos(sha);
