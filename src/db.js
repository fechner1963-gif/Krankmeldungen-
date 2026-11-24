'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name          TEXT NOT NULL,
      email         TEXT,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee','admin')),
      vacation_days REAL NOT NULL DEFAULT 30,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS requests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type          TEXT NOT NULL CHECK (type IN ('sick','vacation','time')),
      start_date    TEXT NOT NULL,
      end_date      TEXT NOT NULL,
      days          REAL NOT NULL DEFAULT 0,
      data          TEXT NOT NULL DEFAULT '{}',
      note          TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','cancelled')),
      admin_comment TEXT NOT NULL DEFAULT '',
      decided_by    INTEGER REFERENCES users(id),
      decided_at    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_requests_user ON requests(user_id, type, start_date);
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
  `);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return db;
}

/** Legt beim ersten Start einen Admin an und gibt ggf. das Startpasswort zurück. */
function ensureAdmin(db, password) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return null;
  const pw = password || crypto.randomBytes(6).toString('base64url');
  db.prepare(
    `INSERT INTO users (username, name, password_hash, role, must_change_password)
     VALUES ('admin', 'Administrator', ?, 'admin', 1)`
  ).run(hashPassword(pw));
  return pw;
}

module.exports = { openDb, ensureAdmin, hashPassword, verifyPassword };
