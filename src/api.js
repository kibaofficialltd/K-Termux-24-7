// K Termux 24/7 Ultimate - K TERMUX CONTROL API (Express)
// Auth: session cookie (dashboard) or x-api-key header (programmatic).
// All control endpoints require authentication and are bound to localhost by default.
'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dbm = require('./db');
const auth = require('./auth');
const supervisor = require('./supervisor');
const watchdog = require('./watchdog');
const netmon = require('./netmon');
const sysmon = require('./system');
const events = require('./events');
const schedulerMod = require('./scheduler');
const notify = require('./notify');
const logger = require('./logger');
const { config } = require('./config');

const router = express.Router();
router.use(express.json({ limit: '256kb' }));

// ---------- helpers ----------
function clientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function isLoopback(ip) {
  return /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip);
}

function directAccessEnabled() {
  try { return notify.getSetting('auth_disabled', '0') === '1'; } catch (_) { return false; }
}

function extractToken(req) {
  if (req.headers['x-api-key']) return req.headers['x-api-key'].trim();
  const cookies = req.headers.cookie || '';
  const m = /(?:^|;\s*)ktermux_session=([\w-]+)/.exec(cookies);
  return m ? m[1] : null;
}

// attaches req.user { id, username, via } when authenticated
function authOptional(req, _res, next) {
  // Direct-access mode: trusted localhost requests skip login entirely
  if (directAccessEnabled() && isLoopback(clientIp(req))) {
    req.user = { id: null, name: 'local', via: 'local', role: 'admin' };
    return next();
  }
  const token = extractToken(req);
  if (req.headers['x-api-key']) {
    const k = auth.verifyApiKey(req.headers['x-api-key'].trim());
    if (k) req.user = { id: null, name: 'apikey:' + k.name, via: 'apikey', apiKeyId: k.id };
  } else if (token) {
    const s = auth.getSession(token);
    if (s) {
      const db = dbm.open();
      const u = db.prepare('SELECT id,username,role FROM users WHERE id=?').get(s.user_id);
      if (u) req.user = { id: u.id, name: u.username, role: u.role, via: 'session', sessionToken: token };
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required', hint: 'Log in via /api/login or send x-api-key header' });
  }
  next();
}

function apiRate(req, res, next) {
  if (!auth.rateLimit('api:' + clientIp(req), 240, 60 * 1000)) {
    return res.status(429).json({ error: 'Rate limit exceeded (240 req/min)' });
  }
  next();
}

function loginRate(req, res, next) {
  if (!auth.rateLimit('login:' + clientIp(req), 10, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }
  next();
}

router.use(authOptional, apiRate);

// ---------- health (open, minimal info) ----------
router.get('/health', (_req, res) => {
  res.json({ ok: true, name: 'K Termux 24/7 Ultimate', version: config.version, time: Date.now() });
});

// ---------- auth ----------
router.post('/login', loginRate, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username and password required' });
  }
  const user = auth.authenticate(username, password);
  if (!user) {
    auth.audit(username.slice(0, 60), 'login.failed', 'bad credentials', clientIp(req));
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = auth.createSession(user.id, clientIp(req));
  res.setHeader('Set-Cookie', `ktermux_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
  auth.audit(user.username, 'login.success', 'session created', clientIp(req));
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});

router.post('/logout', requireAuth, (req, res) => {
  if (req.user.sessionToken) auth.destroySession(req.user.sessionToken);
  res.setHeader('Set-Cookie', 'ktermux_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  auth.audit(req.user.name, 'logout', '', clientIp(req));
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, name: req.user.name, via: req.user.via, role: req.user.role || 'admin' } });
});

// ---------- status / system ----------
router.get('/status', requireAuth, (_req, res) => {
  const services = supervisor.listServices();
  res.json({
    running: services.filter((s) => s.status === 'running').length,
    stopped: services.filter((s) => ['stopped', 'crashed', 'backoff', 'stopping'].includes(s.status)).length,
    total: services.length,
    uptimeMs: Date.now() - config.startedAt,
    monitoring: { watchdog: true, network: netmon.status().online !== null },
    network: netmon.status(),
  });
});

router.get('/system', requireAuth, async (_req, res) => {
  const mem = sysmon.memInfo();
  res.json({
    platform: 'android-termux',
    hostname: os.hostname(),
    nodeVersion: process.version,
    appUptimeMs: Date.now() - config.startedAt,
    cpuPercent: sysmon.cpuPercent(), // null until second sample
    cores: sysmon.cpus(),
    memory: mem, // null when /proc/meminfo unreadable
    battery: await sysmon.battery(), // null when Termux:API not installed
    loadavg: os.loadavg(),
    pid: process.pid,
  });
});

// ---------- services CRUD ----------
function serviceBodyError(b) {
  if (!b || typeof b !== 'object') return 'Body required';
  if (!b.name || typeof b.name !== 'string') return 'name required';
  if (!b.command || typeof b.command !== 'string' || b.command.length > 500) return 'command required';
  if (b.args && !Array.isArray(b.args)) return 'args must be an array';
  if (b.env && (typeof b.env !== 'object' || Array.isArray(b.env))) return 'env must be an object';
  if (b.healthUrl && !/^https?:\/\//.test(String(b.healthUrl))) return 'healthUrl must be an http(s) URL';
  return null;
}

router.get('/services', requireAuth, (_req, res) => {
  res.json({ services: supervisor.listServices() });
});

router.get('/services/:id', requireAuth, (req, res) => {
  const s = supervisor.getService(req.params.id);
  if (!s) return res.status(404).json({ error: 'Service not found' });
  res.json({ service: s });
});

router.post('/services', requireAuth, (req, res) => {
  const err = serviceBodyError(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const id = supervisor.register(req.body);
    auth.audit(req.user.name, 'service.create', `id=${id} name=${req.body.name}`, clientIp(req));
    events.emit('service.created', 'info', `Service "${req.body.name}" registered`, id);
    res.status(201).json({ ok: true, id, service: supervisor.getService(id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/services/:id', requireAuth, (req, res) => {
  const err = serviceBodyError(Object.assign({ name: 'x', command: 'x' }, req.body));
  if (err && req.body && req.body.name && req.body.command) return res.status(400).json({ error: err });
  try {
    supervisor.update(req.params.id, req.body);
    auth.audit(req.user.name, 'service.update', `id=${req.params.id}`, clientIp(req));
    res.json({ ok: true, service: supervisor.getService(req.params.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/services/:id', requireAuth, (req, res) => {
  const r = supervisor.remove(req.params.id);
  if (!r.ok) return res.status(404).json(r);
  auth.audit(req.user.name, 'service.delete', `id=${req.params.id}`, clientIp(req));
  res.json(r);
});

router.post('/services/:id/start', requireAuth, (req, res) => {
  const r = supervisor.start(req.params.id, { manual: true });
  auth.audit(req.user.name, 'service.start', `id=${req.params.id}`, clientIp(req));
  if (!r.ok) return res.status(409).json(r);
  res.json(Object.assign({ ok: true }, r));
});

router.post('/services/:id/stop', requireAuth, (req, res) => {
  const r = supervisor.stop(req.params.id, { manual: true, reason: 'api stop' });
  auth.audit(req.user.name, 'service.stop', `id=${req.params.id}`, clientIp(req));
  if (!r.ok) return res.status(409).json(r);
  res.json(Object.assign({ ok: true }, r));
});

router.post('/services/:id/restart', requireAuth, (req, res) => {
  const r = supervisor.restart(req.params.id, 'api restart');
  auth.audit(req.user.name, 'service.restart', `id=${req.params.id}`, clientIp(req));
  if (!r.ok) return res.status(409).json(r);
  res.json(Object.assign({ ok: true }, r));
});

router.post('/services/restart-all', requireAuth, (req, res) => {
  let count = 0;
  for (const s of supervisor.listServices()) {
    if (s.status === 'running') { supervisor.restart(s.id, 'restart-all'); count++; }
    else if (s.enabled) { supervisor.start(s.id, { manual: true }); count++; }
  }
  auth.audit(req.user.name, 'service.restart-all', `${count} services`, clientIp(req));
  res.json({ ok: true, count });
});

router.get('/services/:id/logs', requireAuth, (req, res) => {
  const n = Math.max(1, Math.min(parseInt(req.query.n, 10) || 200, 500));
  const logs = supervisor.getLogs(req.params.id, n);
  if (logs === null) return res.status(404).json({ error: 'Service not found' });
  res.json({ logs, file: supervisor.logFilePath(req.params.id) });
});

// ---------- uptime / monitoring ----------
router.get('/uptime', requireAuth, (req, res) => {
  const db = dbm.open();
  const limit = Math.max(10, Math.min(parseInt(req.query.n, 10) || 60, 500));
  const services = db.prepare('SELECT id,name FROM services ORDER BY id').all();
  const out = services.map((s) => {
    const checks = db.prepare('SELECT ok,latency_ms AS latencyMs,at FROM uptime_checks WHERE service_id=? ORDER BY at DESC LIMIT ?')
      .all(s.id, limit);
    const total = checks.length;
    const okCount = checks.filter((c) => c.ok === 1).length;
    const avgLatency = total ? Math.round(checks.reduce((a, c) => a + (c.latencyMs || 0), 0) / total) : null;
    return {
      serviceId: s.id, name: s.name, healthUrl: (supervisor.getService(s.id) || {}).healthUrl || '',
      checks: checks.reverse(), uptimePercent: total ? Math.round((okCount / total) * 1000) / 10 : null,
      avgLatencyMs: avgLatency,
    };
  });
  res.json({ services: out });
});

router.get('/monitoring', requireAuth, (_req, res) => {
  const db = dbm.open();
  const netHistory = db.prepare('SELECT ok,latency_ms AS latencyMs,at FROM net_checks ORDER BY at DESC LIMIT 200').all().reverse();
  res.json({
    network: Object.assign({ history: netHistory }, netmon.status()),
    watchdogIntervalMs: 15000,
    healthChecks: [...supervisor._state.values()]
      .filter((rt) => rt.spec.healthUrl)
      .map((rt) => ({ serviceId: rt.spec.id, name: rt.spec.name, url: rt.spec.healthUrl, status: rt.state.status })),
  });
});

router.get('/events', requireAuth, (req, res) => {
  const db = dbm.open();
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 500));
  const rows = db.prepare('SELECT id,type,severity,service_id AS serviceId,message,at FROM events ORDER BY at DESC LIMIT ?').all(limit);
  res.json({ events: rows.reverse() });
});

// ---------- api keys ----------
router.get('/apikeys', requireAuth, (_req, res) => {
  res.json({ keys: auth.listApiKeys() });
});

router.post('/apikeys', requireAuth, (req, res) => {
  const name = String((req.body && req.body.name) || '').slice(0, 60);
  const created = auth.createApiKey(name);
  auth.audit(req.user.name, 'apikey.create', `id=${created.id}`, clientIp(req));
  // return the raw key exactly once - never stored in plaintext
  res.status(201).json({ ok: true, id: created.id, name: created.name, prefix: created.prefix, key: created.key });
});

router.delete('/apikeys/:id', requireAuth, (req, res) => {
  auth.revokeApiKey(req.params.id);
  auth.audit(req.user.name, 'apikey.revoke', `id=${req.params.id}`, clientIp(req));
  res.json({ ok: true });
});

// ---------- schedules ----------
router.get('/schedules', requireAuth, (_req, res) => {
  res.json({ schedules: schedulerMod.listSchedules() });
});

router.post('/schedules', requireAuth, (req, res) => {
  try {
    const id = schedulerMod.addSchedule(req.body || {});
    auth.audit(req.user.name, 'schedule.create', `id=${id}`, clientIp(req));
    res.status(201).json({ ok: true, id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/schedules/:id', requireAuth, (req, res) => {
  const ok = schedulerMod.removeSchedule(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Schedule not found' });
  auth.audit(req.user.name, 'schedule.delete', `id=${req.params.id}`, clientIp(req));
  res.json({ ok: true });
});

// ---------- notifications settings ----------
router.get('/notifications', requireAuth, (_req, res) => {
  res.json(Object.assign({ termuxApiAvailable: !!termuxNotificationAvailable() }, notify.maskSettings()));
});

function termuxNotificationAvailable() {
  try { return fs.existsSync('/data/data/com.termux/files/usr/bin/termux-notification'); } catch (_) { return false; }
}

router.post('/notifications', requireAuth, (req, res) => {
  const b = req.body || {};
  if (typeof b.termuxEnabled === 'boolean') notify.setSetting('notify_termux', b.termuxEnabled ? '1' : '0');
  if (typeof b.discordWebhook === 'string') {
    const v = b.discordWebhook.trim();
    if (v && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(v)) {
      return res.status(400).json({ error: 'Webhook must be a discord.com/api/webhooks URL' });
    }
    notify.setSetting('discord_webhook', v);
  }
  auth.audit(req.user.name, 'notifications.update', '', clientIp(req));
  res.json({ ok: true, config: notify.maskSettings() });
});

router.post('/notifications/test', requireAuth, async (_req, res) => {
  await notify.notify('K Termux test notification', 'This is a test from your K Termux dashboard.');
  res.json({ ok: true });
});

// ---------- settings ----------
router.get('/settings', requireAuth, (_req, res) => {
  const db = dbm.open();
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const out = Object.fromEntries(rows.map((r) => [r.key, r.key === 'discord_webhook' ? (r.value ? '(hidden)' : '') : r.value]));
  res.json({ settings: out });
});

router.post('/settings', requireAuth, (req, res) => {
  const b = req.body || {};
  if (b.net_endpoint !== undefined) {
    const v = String(b.net_endpoint).trim();
    if (v && !/^https?:\/\//.test(v)) return res.status(400).json({ error: 'net_endpoint must be an http(s) URL' });
    notify.setSetting('net_endpoint', v);
  }
  if (b.auth_disabled !== undefined) {
    const enable = b.auth_disabled === true || b.auth_disabled === '1' || b.auth_disabled === 1;
    notify.setSetting('auth_disabled', enable ? '1' : '0');
    auth.audit(req.user.name, enable ? 'auth.disabled' : 'auth.enabled',
      enable ? 'login skipped for this phone (localhost only)' : 'login required again', clientIp(req));
  }
  auth.audit(req.user.name, 'settings.update', '', clientIp(req));
  res.json({ ok: true });
});

// ---------- backups / export ----------
router.post('/backup', requireAuth, (req, res) => {
  const dest = dbm.backup((req.body && req.body.reason) || 'api');
  if (!dest) return res.status(500).json({ error: 'Backup failed, see server log' });
  auth.audit(req.user.name, 'backup', path.basename(dest), clientIp(req));
  res.json({ ok: true, file: dest });
});

router.get('/backups', requireAuth, (_req, res) => {
  try {
    const files = fs.readdirSync(config.backupsDir).filter((f) => f.endsWith('.db')).map((f) => {
      const st = fs.statSync(path.join(config.backupsDir, f));
      return { name: f, size: st.size, at: st.mtimeMs };
    }).sort((a, b) => b.at - a.at);
    res.json({ backups: files });
  } catch (e) { res.json({ backups: [] }); }
});

// Export service configs - secrets (env values) excluded by default
router.get('/export/services', requireAuth, (req, res) => {
  const includeEnv = req.query.env === '1';
  const services = supervisor.listServices().map((s) => ({
    name: s.name, group: s.group, command: s.command, args: s.args, cwd: s.cwd,
    env: includeEnv ? s.env : undefined, autostart: s.autostart, healthUrl: s.healthUrl,
    maxRestarts: s.maxRestarts, restartWindowMin: s.restartWindowMin, enabled: s.enabled,
  }));
  res.setHeader('Content-Disposition', 'attachment; filename="k-termux-services.json"');
  res.json({ exportedAt: new Date().toISOString(), envIncluded: !!includeEnv, services });
});

// ---------- security ----------
router.get('/audit', requireAuth, (req, res) => {
  const db = dbm.open();
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 500));
  const rows = db.prepare('SELECT id,user,action,detail,ip,at FROM audit_log ORDER BY at DESC LIMIT ?').all(limit);
  res.json({ audit: rows.reverse() });
});

router.post('/password', requireAuth, (req, res) => {
  if (!req.user.id) return res.status(400).json({ error: 'API-key identities cannot change passwords' });
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'currentPassword and newPassword (min 8 chars) required' });
  }
  const db = dbm.open();
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!auth.verifyPassword(currentPassword, u.salt, u.password_hash)) {
    return res.status(401).json({ error: 'Current password is wrong' });
  }
  auth.changePassword(req.user.id, newPassword);
  auth.destroyUserSessions(req.user.id);
  auth.audit(u.username, 'password.change', 'sessions revoked', clientIp(req));
  res.json({ ok: true, note: 'All sessions revoked - log in again' });
});

// ---------- restricted diagnostics console (allowlist only) ----------
// Not a shell. Only fixed diagnostic commands are allowed.
const CONSOLE_COMMANDS = {
  overview: () => supervisor.listServices().map((s) => `${s.id}\t${s.status}\t${s.name}\t${s.pid || '-'}`),
  ps: () => { try { return fs.readFileSync('/proc/loadavg', 'utf8').trim(); } catch (_) { return 'unavailable'; } },
  disk: () => { try { const st = fs.statfsSync ? require('fs').statfsSync(config.dataDir) : null; return st ? `${Math.round(st.bsize * st.blocks / 1e9)}GB total / ${Math.round(st.bsize * st.bavail / 1e9)}GB free` : 'unavailable'; } catch (_) { return 'unavailable'; } },
  net: () => JSON.stringify(netmon.status()),
  uptime: () => `k-termux-uptime=${Math.round((Date.now() - config.startedAt) / 1000)}s`,
};

router.post('/console', requireAuth, (req, res) => {
  const cmd = String((req.body && req.body.command) || '').trim().split(/\s+/)[0];
  if (!CONSOLE_COMMANDS[cmd]) {
    return res.status(400).json({ error: 'Command not allowed', allowed: Object.keys(CONSOLE_COMMANDS) });
  }
  // console is restricted to local (loopback) sessions
  const ip = clientIp(req);
  if (!isLoopback(ip)) {
    return res.status(403).json({ error: 'Console restricted to localhost sessions' });
  }
  let out;
  try { out = CONSOLE_COMMANDS[cmd](); } catch (e) { out = 'error: ' + e.message; }
  auth.audit(req.user.name, 'console.' + cmd, '', ip);
  res.json({ ok: true, output: Array.isArray(out) ? out.join('\n') : String(out) });
});

// ---------- server log tail ----------
router.get('/serverlog', requireAuth, (req, res) => {
  const n = Math.max(1, Math.min(parseInt(req.query.n, 10) || 150, 400));
  res.json({ lines: logger.tail(n) });
});

// ---------- reset crash window ----------
router.post('/services/:id/reset-restarts', requireAuth, (req, res) => {
  supervisor.clearWindow(req.params.id);
  events.emit('service.window-reset', 'info', `Restart window reset`, Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
