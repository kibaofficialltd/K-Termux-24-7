// K Termux 24/7 Ultimate - authentication & security
// scrypt password hashing, DB-backed sessions, hashed API keys, rate limiting, audit log.
'use strict';
const crypto = require('crypto');
const dbm = require('./db');
const logger = require('./logger');

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  try {
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash));
  } catch (_) { return false; }
}

function createUser(username, password) {
  const db = dbm.open();
  const { salt, hash } = hashPassword(password);
  const r = db.prepare('INSERT INTO users (username,password_hash,salt,role,created_at) VALUES (?,?,?,?,?)')
    .run(username, hash, salt, 'admin', Date.now());
  return Number(r.lastInsertRowid);
}

function countUsers() {
  const db = dbm.open();
  const r = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  return r.c;
}

function authenticate(username, password) {
  const db = dbm.open();
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username));
  if (!u) return null;
  if (!verifyPassword(password, u.salt, u.password_hash)) return null;
  return u;
}

function changePassword(userId, newPassword) {
  const db = dbm.open();
  const { salt, hash } = hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hash, salt, Number(userId));
}

function createSession(userId, ip) {
  const db = dbm.open();
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token,user_id,created_at,expires_at,ip) VALUES (?,?,?,?,?)')
    .run(token, userId, Date.now(), Date.now() + SESSION_TTL_MS, ip || '');
  return token;
}

function getSession(token) {
  if (!token || typeof token !== 'string' || token.length > 128) return null;
  const db = dbm.open();
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token=?').run(token);
    return null;
  }
  return s;
}

function destroySession(token) {
  const db = dbm.open();
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}

function destroyUserSessions(userId) {
  const db = dbm.open();
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(Number(userId));
}

function createApiKey(name) {
  const db = dbm.open();
  const raw = 'ktermux_' + crypto.randomBytes(24).toString('hex');
  const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 9) + '…';
  const r = db.prepare('INSERT INTO api_keys (name,key_hash,key_prefix,created_at) VALUES (?,?,?,?)')
    .run(String(name || 'unnamed').slice(0, 60), keyHash, prefix, Date.now());
  // The raw key is returned ONCE. Only its hash is stored.
  return { id: Number(r.lastInsertRowid), key: raw, prefix, name: String(name || 'unnamed') };
}

function verifyApiKey(raw) {
  if (!raw || typeof raw !== 'string' || raw.length > 200 || !raw.startsWith('ktermux_')) return null;
  const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
  const db = dbm.open();
  const k = db.prepare('SELECT * FROM api_keys WHERE key_hash=? AND revoked=0').get(keyHash);
  if (!k) return null;
  db.prepare('UPDATE api_keys SET last_used=? WHERE id=?').run(Date.now(), k.id);
  return k;
}

function listApiKeys() {
  const db = dbm.open();
  return db.prepare('SELECT id,name,key_prefix,created_at,last_used,revoked FROM api_keys ORDER BY id DESC').all();
}

function revokeApiKey(id) {
  const db = dbm.open();
  db.prepare('UPDATE api_keys SET revoked=1 WHERE id=?').run(Number(id));
}

function deleteApiKey(id) {
  const db = dbm.open();
  db.prepare('DELETE FROM api_keys WHERE id=?').run(Number(id));
}

// ---------- rate limiting (in-memory, per IP) ----------
const buckets = new Map(); // ip -> { count, resetAt }
function rateLimit(ip, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(ip, b);
  }
  b.count += 1;
  // periodic cleanup
  if (buckets.size > 500) {
    for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
  }
  return b.count <= limit;
}

function audit(user, action, detail, ip) {
  try {
    const db = dbm.open();
    db.prepare('INSERT INTO audit_log (user,action,detail,ip,at) VALUES (?,?,?,?,?)')
      .run(String(user || 'system').slice(0, 60), String(action).slice(0, 60),
        String(detail || '').slice(0, 300), String(ip || ''), Date.now());
    db.prepare('DELETE FROM audit_log WHERE id <= (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET 2000)').run();
  } catch (e) { logger.warn('auth', 'audit failed: ' + e.message); }
}

module.exports = {
  hashPassword, verifyPassword, createUser, countUsers, authenticate, changePassword,
  createSession, getSession, destroySession, destroyUserSessions,
  createApiKey, verifyApiKey, listApiKeys, revokeApiKey, deleteApiKey,
  rateLimit, audit,
};
