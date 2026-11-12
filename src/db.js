// K Termux 24/7 Ultimate - SQLite layer using node:sqlite (built into Node >= 22.5)
'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { config, ensureDirs } = require('./config');
const logger = require('./logger');

ensureDirs();

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  key_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  group_name TEXT NOT NULL DEFAULT 'Other',
  command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  cwd TEXT NOT NULL DEFAULT '',
  env TEXT NOT NULL DEFAULT '{}',
  autostart INTEGER NOT NULL DEFAULT 0,
  health_url TEXT NOT NULL DEFAULT '',
  max_restarts INTEGER NOT NULL DEFAULT 10,
  restart_window_min INTEGER NOT NULL DEFAULT 10,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS service_state (
  service_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'stopped',
  pid INTEGER,
  started_at INTEGER,
  stopped_at INTEGER,
  restart_count INTEGER NOT NULL DEFAULT 0,
  crash_count INTEGER NOT NULL DEFAULT 0,
  last_exit_code INTEGER,
  last_exit_signal TEXT,
  last_exit_at INTEGER
);
CREATE TABLE IF NOT EXISTS restart_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL,
  reason TEXT,
  at INTEGER NOT NULL,
  exit_code INTEGER,
  exit_signal TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  service_id INTEGER,
  message TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS uptime_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  latency_ms INTEGER,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS net_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ok INTEGER NOT NULL,
  latency_ms INTEGER,
  endpoint TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER,
  action TEXT NOT NULL,
  interval_min INTEGER,
  at_time TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run INTEGER,
  next_run INTEGER
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT, action TEXT, detail TEXT, ip TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at DESC);
CREATE INDEX IF NOT EXISTS idx_uptime_service ON uptime_checks(service_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_net_at ON net_checks(at DESC);
`;

function open() {
  if (db) return db;
  db = new DatabaseSync(config.dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  const ver = db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version');
  if (!ver) {
    db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('schema_version', '1');
    logger.info('db', 'database initialized at ' + config.dbFile);
  }
  return db;
}

function close() {
  if (db) { try { db.close(); } catch (_) {} db = null; }
}

// Simple backup: copy the db file (WAL checkpointed first) into backups dir.
function backup(reason = 'manual') {
  ensureDirs();
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch (_) {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(config.backupsDir, `k-termux-${stamp}-${reason}.db`);
  try { fs.copyFileSync(config.dbFile, dest); } catch (e) {
    logger.error('db', 'backup failed: ' + e.message);
    return null;
  }
  // retention: keep last 10
  try {
    const files = fs.readdirSync(config.backupsDir).filter(f => f.endsWith('.db')).sort();
    while (files.length > 10) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(config.backupsDir, old)); } catch (_) {}
    }
  } catch (_) {}
  logger.info('db', 'backup created: ' + dest);
  return dest;
}

module.exports = { open, close, backup };
