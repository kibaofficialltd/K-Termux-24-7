// KIBA 24/7 ULTIMATE - watchdog
// Detects dead processes and unresponsive HTTP services; restarts with limits.
'use strict';
const http = require('http');
const https = require('https');
const dbm = require('./db');
const events = require('./events');
const supervisor = require('./supervisor');
const logger = require('./logger');

let timer = null;
let intervalMs = parseInt(process.env.KIBA_WATCHDOG_MS, 10) || 15 * 1000;
const HEALTH_TIMEOUT = 5000;
const HEALTH_MAX_CONSECUTIVE = parseInt(process.env.KIBA_HEALTH_MAX_FAILS, 10) || 3;
// serviceId -> { consecutiveFailures, lastOkAt }
const healthState = new Map();

function checkHttp(url) {
  return new Promise((resolve) => {
    let mod, u;
    try { u = new URL(url); } catch (_) { return resolve({ ok: false, error: 'bad url' }); }
    if (u.protocol === 'http:') mod = http; else if (u.protocol === 'https:') mod = https;
    else return resolve({ ok: false, error: 'unsupported protocol' });
    const req = mod.request(u, { method: 'GET', timeout: HEALTH_TIMEOUT }, (res) => {
      res.resume();
      const ok = res.statusCode >= 200 && res.statusCode < 400;
      resolve({ ok, code: res.statusCode, ms: Date.now() - start });
    });
    const start = Date.now();
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

function recordUptime(serviceId, ok, latencyMs) {
  try {
    const db = dbm.open();
    db.prepare('INSERT INTO uptime_checks (service_id,ok,latency_ms,at) VALUES (?,?,?,?)')
      .run(serviceId, ok ? 1 : 0, latencyMs ?? null, Date.now());
    db.prepare('DELETE FROM uptime_checks WHERE id <= (SELECT id FROM uptime_checks ORDER BY id DESC LIMIT 1 OFFSET 5000)').run();
  } catch (_) {}
}

async function checkService(rt) {
  if (rt.state.status !== 'running' || !rt.spec.healthUrl) {
    if (rt.spec.healthUrl && rt.state.status !== 'running') healthState.delete(rt.spec.id);
    return;
  }
  const res = await checkHttp(rt.spec.healthUrl);
  recordUptime(rt.spec.id, res.ok, res.ms);
  let hs = healthState.get(rt.spec.id) || { consecutiveFailures: 0, lastOkAt: null };
  if (res.ok) {
    if (hs.consecutiveFailures >= HEALTH_MAX_CONSECUTIVE) {
      events.emit('service.recovered', 'info', `Service "${rt.spec.name}" is responding again`, rt.spec.id);
    }
    hs.consecutiveFailures = 0;
    hs.lastOkAt = Date.now();
  } else {
    hs.consecutiveFailures += 1;
    if (hs.consecutiveFailures === HEALTH_MAX_CONSECUTIVE) {
      events.emit('service.unresponsive', 'error',
        `Service "${rt.spec.name}" failed ${HEALTH_MAX_CONSECUTIVE} health checks - forcing restart`, rt.spec.id);
      supervisor.forceRestart(rt, 'health check failed ' + HEALTH_MAX_CONSECUTIVE + 'x');
    }
  }
  healthState.set(rt.spec.id, hs);
}

// Liveness: status says running but process is gone -> recover state & restart
function checkLiveness(rt) {
  if (rt.state.status !== 'running') return;
  const alive = supervisor.isAlive(rt);
  if (!alive) {
    events.emit('service.dead', 'error',
      `Watchdog: "${rt.spec.name}" process disappeared unexpectedly - recovering`, rt.spec.id);
    rt.state.status = 'stopped';
    rt.state.pid = null;
    supervisor.saveState(rt.spec.id, rt.state);
    setTimeout(() => supervisor.start(rt.spec.id, { manual: false }), 1000);
  }
}

function tick() {
  for (const [, rt] of supervisor._state) {
    try { checkLiveness(rt); checkService(rt); } catch (e) {
      logger.warn('watchdog', 'check error for ' + rt.spec.name + ': ' + e.message);
    }
  }
}

function start(ms) {
  intervalMs = ms || intervalMs;
  stop();
  timer = setInterval(tick, intervalMs);
  timer.unref();
  logger.info('watchdog', 'started, interval ' + intervalMs + 'ms');
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, checkHttp };
