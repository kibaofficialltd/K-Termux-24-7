// K Termux 24/7 Ultimate - network monitoring
// Internet connectivity, latency history, outage detection & recovery.
'use strict';
const http = require('https');
const dbm = require('./db');
const events = require('./events');
const logger = require('./logger');
const { config } = require('./config');

let timer = null;
let online = null; // null = unknown yet
let lastCheckAt = null;

function probe(endpoint, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(endpoint); } catch (_) { return resolve({ ok: false, error: 'bad endpoint', ms: 0 }); }
    const start = Date.now();
    const req = http.request(u, { method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 500, code: res.statusCode, ms: Date.now() - start });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', ms: Date.now() - start }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message, ms: Date.now() - start }));
    req.end();
  });
}

function record(ok, latencyMs, endpoint) {
  try {
    const db = dbm.open();
    db.prepare('INSERT INTO net_checks (ok,latency_ms,endpoint,at) VALUES (?,?,?,?)')
      .run(ok ? 1 : 0, latencyMs ?? null, endpoint, Date.now());
    db.prepare('DELETE FROM net_checks WHERE id <= (SELECT id FROM net_checks ORDER BY id DESC LIMIT 1 OFFSET 5000)').run();
  } catch (_) {}
}

async function tick() {
  lastCheckAt = Date.now();
  const endpoint = settingsEndpoint() || config.netEndpoint;
  const res = await probe(endpoint);
  record(res.ok, res.ms, endpoint);
  const was = online;
  online = res.ok;
  if (was === false && online === true) {
    events.emit('network.online', 'info', `Network reconnected (${res.ms}ms)`, null);
    logger.info('netmon', 'network back online');
  } else if (was === true && online === false) {
    events.emit('network.offline', 'error', 'Network connection lost', null);
    logger.warn('netmon', 'network offline');
  } else if (was === null && online === false) {
    events.emit('network.offline', 'error', 'Network appears offline at startup', null);
  }
}

function settingsEndpoint() {
  try {
    const db = dbm.open();
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get('net_endpoint');
    return r && r.value ? r.value : null;
  } catch (_) { return null; }
}

function status() {
  return { online, lastCheckAt, endpoint: settingsEndpoint() || config.netEndpoint };
}

function history(limit = 200) {
  const db = dbm.open();
  const rows = db.prepare('SELECT ok,latency_ms AS latencyMs,at FROM net_checks ORDER BY at DESC LIMIT ?').all(Math.max(1, Math.min(limit, 1000)));
  return rows.reverse();
}

function start(ms) {
  stop();
  tick();
  timer = setInterval(tick, ms || 30 * 1000);
  timer.unref();
  logger.info('netmon', 'started');
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, status, history, probe };
