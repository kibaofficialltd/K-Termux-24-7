// KIBA 24/7 ULTIMATE - process supervisor
// Real child-process management: spawn, stop, restart, crash detection with
// exponential backoff, restart limits, live logs (ring buffer + rotated files).
// Never concatenates untrusted input into a shell: always uses spawn(cmd, args).
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbm = require('./db');
const events = require('./events');
const logger = require('./logger');
const { config, ensureDirs } = require('./config');

ensureDirs();

// runtime state: serviceId -> {proc, spec, state, logs: [], logStream, restarts: [{at}], backoffMs, pendingTimer}
const S = new Map();
const LOG_RING = 500;
const LOG_MAX_BYTES = 1 * 1024 * 1024;
const LOG_KEEP = 2;
const BACKOFF_MIN = parseInt(process.env.KIBA_BACKOFF_MIN_MS, 10) || 5 * 1000;
const BACKOFF_MAX = parseInt(process.env.KIBA_BACKOFF_MAX_MS, 10) || 5 * 60 * 1000;

function safeSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40) || 'service';
}

function logFileFor(serviceId, name) {
  return path.join(config.logsDir, `${safeSlug(name)}-${serviceId}.log`);
}

function openLogStream(serviceId) {
  const rt = S.get(serviceId);
  if (!rt) return;
  const file = logFileFor(serviceId, rt.spec.name);
  try {
    rt.logStream = fs.createWriteStream(file, { flags: 'a' });
    rt.logFile = file;
    try { rt.logSize = fs.statSync(file).size; } catch (_) { rt.logSize = 0; }
  } catch (e) {
    rt.logStream = null;
    logger.warn('supervisor', 'cannot open log stream for ' + rt.spec.name + ': ' + e.message);
  }
}

function appendLog(serviceId, line, level) {
  const rt = S.get(serviceId);
  if (!rt) return;
  const stamped = `${new Date().toISOString()} ${level} ${line}`;
  rt.logs.push(stamped);
  if (rt.logs.length > LOG_RING) rt.logs.splice(0, rt.logs.length - LOG_RING);
  if (rt.logStream) {
    try {
      rt.logStream.write(stamped + '\n');
      rt.logSize += stamped.length + 1;
      if (rt.logSize > LOG_MAX_BYTES) rotateLog(serviceId);
    } catch (_) {}
  }
}

function rotateLog(serviceId) {
  const rt = S.get(serviceId);
  if (!rt || !rt.logFile) return;
  try {
    rt.logStream.end();
    const base = rt.logFile;
    try { fs.unlinkSync(base + '.2'); } catch (_) {}
    try { fs.renameSync(base + '.1', base + '.2'); } catch (_) {}
    fs.renameSync(base, base + '.1');
    rt.logStream = fs.createWriteStream(base, { flags: 'a' });
    rt.logSize = 0;
  } catch (e) {
    logger.warn('supervisor', 'log rotation failed for ' + rt.spec.name + ': ' + e.message);
    openLogStream(serviceId);
  }
}

// ---------- DB helpers ----------
function loadSpecs() {
  const db = dbm.open();
  const rows = db.prepare('SELECT * FROM services ORDER BY id').all();
  const specs = [];
  for (const r of rows) {
    let args = [], env = {};
    try { args = JSON.parse(r.args || '[]'); } catch (_) {}
    try { env = JSON.parse(r.env || '{}'); } catch (_) {}
    specs.push({
      id: r.id, name: r.name, group: r.group_name, command: r.command,
      args, cwd: r.cwd || '', env, autostart: !!r.autostart, healthUrl: r.health_url || '',
      maxRestarts: r.max_restarts, restartWindowMin: r.restart_window_min,
      enabled: !!r.enabled,
    });
  }
  return specs;
}

function saveState(serviceId, patch) {
  try {
    const db = dbm.open();
    const cur = db.prepare('SELECT * FROM service_state WHERE service_id=?').get(serviceId);
    if (!cur) {
      db.prepare('INSERT INTO service_state (service_id) VALUES (?)').run(serviceId);
    }
    const s = db.prepare('SELECT * FROM service_state WHERE service_id=?').get(serviceId);
    const merged = Object.assign({}, s, patch);
    db.prepare(`UPDATE service_state SET status=?, pid=?, started_at=?, stopped_at=?,
      restart_count=?, crash_count=?, last_exit_code=?, last_exit_signal=?, last_exit_at=?
      WHERE service_id=?`).run(
      merged.status, merged.pid || null, merged.started_at || null, merged.stopped_at || null,
      merged.restart_count || 0, merged.crash_count || 0, merged.last_exit_code ?? null,
      merged.last_exit_signal || null, merged.last_exit_at || null, serviceId);
  } catch (e) {
    logger.error('supervisor', 'state save failed: ' + e.message);
  }
}

function recordRestart(serviceId, reason, code, signal) {
  try {
    const db = dbm.open();
    db.prepare('INSERT INTO restart_history (service_id,reason,at,exit_code,exit_signal) VALUES (?,?,?,?,?)')
      .run(serviceId, reason, Date.now(), code ?? null, signal || null);
  } catch (_) {}
}

// ---------- public API ----------
function getService(id) {
  const rt = S.get(Number(id));
  return rt ? publicView(rt) : null;
}

function listServices() {
  const out = [];
  for (const [, rt] of S) out.push(publicView(rt));
  return out.sort((a, b) => a.id - b.id);
}

function publicView(rt) {
  return {
    id: rt.spec.id,
    name: rt.spec.name,
    group: rt.spec.group,
    command: rt.spec.command,
    args: rt.spec.args,
    cwd: rt.spec.cwd,
    env: rt.spec.env,
    autostart: rt.spec.autostart,
    healthUrl: rt.spec.healthUrl,
    maxRestarts: rt.spec.maxRestarts,
    restartWindowMin: rt.spec.restartWindowMin,
    enabled: rt.spec.enabled,
    status: rt.state.status,
    pid: rt.state.pid,
    startedAt: rt.state.startedAt,
    stoppedAt: rt.state.stoppedAt,
    restartCount: rt.state.restartCount,
    crashCount: rt.state.crashCount,
    lastExitCode: rt.state.lastExitCode,
    lastExitSignal: rt.state.lastExitSignal,
    lastExitAt: rt.state.lastExitAt,
    cpuPercent: rt.cpuPercent ?? null,
    memRssKb: rt.memRssKb ?? null,
    logFile: rt.logFile || logFileFor(rt.spec.id, rt.spec.name),
  };
}

function isAlive(rt) {
  try {
    if (!rt.state.pid || rt.state.status !== 'running') return false;
    process.kill(rt.state.pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours -> treat as alive-ish
  }
}

function start(id, { manual = true } = {}) {
  const rt = S.get(Number(id));
  if (!rt) return { ok: false, error: 'Service not found' };
  if (rt.state.status === 'running') return { ok: false, error: 'Already running' };
  const spec = rt.spec;
  if (spec.cwd && !fs.existsSync(spec.cwd)) {
    return { ok: false, error: 'Working directory does not exist: ' + spec.cwd };
  }
  rt.pendingTimer && clearTimeout(rt.pendingTimer);
  rt.pendingTimer = null;

  const env = Object.assign({}, process.env, spec.env);
  const opts = { env, stdio: ['ignore', 'pipe', 'pipe'] };
  if (spec.cwd) opts.cwd = spec.cwd;
  try {
    openLogStream(spec.id);
    const proc = spawn(spec.command, spec.args, opts);
    rt.proc = proc;
    rt.state.status = 'running';
    rt.state.pid = proc.pid;
    rt.state.startedAt = Date.now();
    rt.state.lastExitCode = null;
    rt.state.lastExitSignal = null;
    saveState(spec.id, rt.state);
    appendLog(spec.id, `--- start (pid ${proc.pid}, manual=${manual}) ---`, 'sys');
    logger.info('supervisor', `started "${spec.name}" (pid ${proc.pid})`);

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    const lineBuf = { out: '', err: '' };
    proc.stdout.on('data', (d) => pumpLines(spec.id, lineBuf, 'out', d, 'out'));
    proc.stderr.on('data', (d) => pumpLines(spec.id, lineBuf, 'err', d, 'err'));
    proc.on('error', (e) => {
      appendLog(spec.id, 'spawn error: ' + e.message, 'err');
      rt.state.status = 'stopped';
      rt.state.pid = null;
      saveState(spec.id, rt.state);
      events.emit('service.error', 'error', `Service "${spec.name}" failed to spawn: ${e.message}`, spec.id);
    });
    proc.on('exit', (code, signal) => onExit(rt, code, signal, manual));

    events.emit('service.started', 'info', `Service "${spec.name}" started (pid ${proc.pid})`, spec.id);
    return { ok: true, pid: proc.pid };
  } catch (e) {
    rt.state.status = 'stopped';
    saveState(spec.id, rt.state);
    return { ok: false, error: 'Spawn failed: ' + e.message };
  }
}

function pumpLines(serviceId, lineBuf, which, chunk, level) {
  lineBuf[which] += chunk;
  const parts = lineBuf[which].split(/\r?\n|\r/);
  lineBuf[which] = parts.pop() || '';
  for (const line of parts) if (line !== '') appendLog(serviceId, line, level);
}

function stop(id, { manual = true, reason = 'manual stop' } = {}) {
  const rt = S.get(Number(id));
  if (!rt) return { ok: false, error: 'Service not found' };
  rt.pendingTimer && clearTimeout(rt.pendingTimer);
  rt.pendingTimer = null;
  rt.manualStop = manual;
  if (rt.state.status !== 'running' || !isAlive(rt)) {
    rt.state.status = 'stopped';
    rt.state.pid = null;
    rt.state.stoppedAt = Date.now();
    saveState(rt.spec.id, rt.state);
    if (manual) events.emit('service.stopped', 'info', `Service "${rt.spec.name}" stopped (${reason})`, rt.spec.id);
    return { ok: true, note: 'was not running' };
  }
  const pid = rt.state.pid;
  appendLog(rt.spec.id, `--- stop requested (${reason}) ---`, 'sys');
  try { process.kill(pid, 'SIGTERM'); } catch (_) {}
  // hard-kill fallback after 5s if still alive
  rt.killTimer && clearTimeout(rt.killTimer);
  rt.killTimer = setTimeout(() => {
    try { process.kill(pid, 'SIGKILL'); } catch (_) {}
  }, 5000);
  rt.state.status = 'stopping';
  saveState(rt.spec.id, rt.state);
  logger.info('supervisor', `stopping "${rt.spec.name}" (pid ${pid})`);
  return { ok: true };
}

function restart(id, reason = 'manual restart') {
  const rt = S.get(Number(id));
  if (!rt) return { ok: false, error: 'Service not found' };
  if (rt.state.status === 'running') {
    rt.pendingRestart = { reason };
    const r = stop(id, { manual: true, reason });
    if (!r.ok) return r;
    // onExit handler performs the restart (pendingRestart)
    return { ok: true, note: 'restart scheduled after stop' };
  }
  events.emit('service.restart', 'info', `Service "${rt.spec.name}" restart: ${reason}`, rt.spec.id);
  recordRestart(rt.spec.id, reason, null, null);
  rt.state.restartCount += 1;
  const r = start(id, { manual: true });
  return r;
}

function onExit(rt, code, signal, manual) {
  const wasRunning = rt.state.status;
  rt.killTimer && clearTimeout(rt.killTimer);
  rt.state.status = 'stopped';
  rt.state.pid = null;
  rt.state.stoppedAt = Date.now();
  rt.state.lastExitCode = code ?? null;
  rt.state.lastExitSignal = signal || null;
  rt.state.lastExitAt = Date.now();
  appendLog(rt.spec.id, `--- exit (code=${code}, signal=${signal}) ---`, 'sys');

  const crashed = (code !== 0 && code !== null) || (signal && signal !== 'SIGTERM');
  if (crashed) {
    rt.state.crashCount += 1;
    events.emit('service.crashed', 'error',
      `Service "${rt.spec.name}" crashed (code=${code}, signal=${signal})`, rt.spec.id);
  } else if (wasRunning === 'running') {
    events.emit('service.stopped', 'info', `Service "${rt.spec.name}" exited (code=${code})`, rt.spec.id);
  }
  saveState(rt.spec.id, rt.state);

  if (rt.pendingRestart) {
    const reason = rt.pendingRestart.reason;
    rt.pendingRestart = null;
    setTimeout(() => start(rt.spec.id, { manual: true }), 300);
    return;
  }
  if (rt.manualStop) {
    rt.manualStop = false;
    saveState(rt.spec.id, rt.state);
    return;
  }
  // Automatic recovery: crashed without a manual stop -> schedule restart with backoff
  scheduleAutoRestart(rt, code, signal);
}

function restartsInWindow(rt) {
  const now = Date.now();
  const winMs = (rt.spec.restartWindowMin || 10) * 60 * 1000;
  rt.window = (rt.window || []).filter((t) => now - t < winMs);
  return rt.window.length;
}

function scheduleAutoRestart(rt, code, signal) {
  if (!rt.spec.enabled) return;
  const used = restartsInWindow(rt);
  if (used >= (rt.spec.maxRestarts || 10)) {
    rt.state.status = 'crashed';
    saveState(rt.spec.id, rt.state);
    events.emit('service.gave-up', 'error',
      `Service "${rt.spec.name}" gave up after ${used} restarts in ${rt.spec.restartWindowMin} min. Manual intervention needed.`,
      rt.spec.id);
    require('./notify').notify('KIBA: service crashed repeatedly',
      `${rt.spec.name} gave up after ${used} restarts. Check the dashboard.`);
    return;
  }
  rt.backoffMs = Math.min((rt.backoffMs || BACKOFF_MIN) * (rt.window && rt.window.length ? 2 : 1), BACKOFF_MAX);
  if (!rt.window) rt.window = [];
  rt.window.push(Date.now());
  const delay = rt.backoffMs;
  rt.state.status = 'backoff';
  saveState(rt.spec.id, rt.state);
  events.emit('service.restart-scheduled', 'warn',
    `Service "${rt.spec.name}" restart scheduled in ${Math.round(delay / 1000)}s (auto-recovery)`, rt.spec.id);
  recordRestart(rt.spec.id, 'auto-recovery', code, signal);
  rt.state.restartCount += 1;
  rt.pendingTimer = setTimeout(() => {
    rt.pendingTimer = null;
    rt.backoffMs = BACKOFF_MIN;
    start(rt.spec.id, { manual: false });
  }, delay);
}

// Called by watchdog when a health check says the service is unresponsive.
function forceRestart(rt, reason) {
  events.emit('service.health-restart', 'warn', `Service "${rt.spec.name}" restart forced: ${reason}`, rt.spec.id);
  recordRestart(rt.spec.id, reason, null, null);
  rt.state.restartCount += 1;
  if (rt.state.pid) {
    try { process.kill(rt.state.pid, 'SIGKILL'); } catch (_) {}
  }
}

// ---------- registration / config ----------
function register(specIn) {
  const db = dbm.open();
  const now = Date.now();
  const name = String(specIn.name || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,60}$/.test(name)) throw new Error('Invalid service name (use letters, numbers, spaces, - _)');
  if (!specIn.command || typeof specIn.command !== 'string') throw new Error('Command is required');
  const args = Array.isArray(specIn.args) ? specIn.args.map(String) : [];
  const env = (specIn.env && typeof specIn.env === 'object' && !Array.isArray(specIn.env))
    ? Object.fromEntries(Object.entries(specIn.env).map(([k, v]) => [String(k), String(v)])) : {};
  const group = ['Bots', 'APIs', 'AI Agents', 'Minecraft', 'Other'].includes(specIn.group) ? specIn.group : 'Other';
  const info = db.prepare('INSERT INTO services (name,group_name,command,args,cwd,env,autostart,health_url,max_restarts,restart_window_min,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(name, group, String(specIn.command), JSON.stringify(args), String(specIn.cwd || ''),
      JSON.stringify(env), specIn.autostart ? 1 : 0, String(specIn.healthUrl || specIn.health_url || ''),
      clampInt(specIn.maxRestarts, 1, 100, 10), clampInt(specIn.restartWindowMin, 1, 1440, 10),
      specIn.enabled === false ? 0 : 1, now, now);
  const id = Number(info.lastInsertRowid);
  loadOne(id);
  return id;
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function update(id, specIn) {
  const db = dbm.open();
  const row = db.prepare('SELECT * FROM services WHERE id=?').get(Number(id));
  if (!row) throw new Error('Service not found');
  const now = Date.now();
  const env = (specIn.env && typeof specIn.env === 'object')
    ? Object.fromEntries(Object.entries(specIn.env).map(([k, v]) => [String(k), String(v)]))
    : (() => { try { return JSON.parse(row.env || '{}'); } catch (_) { return {}; } })();
  db.prepare(`UPDATE services SET name=?, group_name=?, command=?, args=?, cwd=?, env=?, autostart=?,
    health_url=?, max_restarts=?, restart_window_min=?, enabled=?, updated_at=? WHERE id=?`)
    .run(String(specIn.name || row.name), ['Bots', 'APIs', 'AI Agents', 'Minecraft', 'Other'].includes(specIn.group) ? specIn.group : row.group_name,
      String(specIn.command || row.command),
      JSON.stringify(Array.isArray(specIn.args) ? specIn.args.map(String) : (() => { try { return JSON.parse(row.args); } catch (_) { return []; } })()),
      String(specIn.cwd ?? row.cwd), JSON.stringify(env),
      specIn.autostart === undefined ? row.autostart : (specIn.autostart ? 1 : 0),
      String(specIn.healthUrl ?? specIn.health_url ?? row.health_url),
      clampInt(specIn.maxRestarts ?? row.max_restarts, 1, 100, 10),
      clampInt(specIn.restartWindowMin ?? row.restart_window_min, 1, 1440, 10),
      specIn.enabled === undefined ? row.enabled : (specIn.enabled ? 1 : 0),
      now, Number(id));
  // Reload spec; runtime keeps running process as-is.
  loadOne(Number(id));
  return true;
}

function remove(id) {
  const rt = S.get(Number(id));
  if (!rt) return { ok: false, error: 'Service not found' };
  if (rt.state.status === 'running') stop(Number(id), { manual: true, reason: 'service removed' });
  S.delete(Number(id));
  const db = dbm.open();
  db.prepare('DELETE FROM services WHERE id=?').run(Number(id));
  db.prepare('DELETE FROM service_state WHERE service_id=?').run(Number(id));
  db.prepare('DELETE FROM restart_history WHERE service_id=?').run(Number(id));
  db.prepare('DELETE FROM uptime_checks WHERE service_id=?').run(Number(id));
  db.prepare('DELETE FROM schedules WHERE service_id=?').run(Number(id));
  events.emit('service.removed', 'info', `Service "${rt.spec.name}" removed`, null);
  return { ok: true };
}

function loadOne(id) {
  const db = dbm.open();
  const r = db.prepare('SELECT * FROM services WHERE id=?').get(Number(id));
  if (!r) return;
  let args = [], env = {};
  try { args = JSON.parse(r.args || '[]'); } catch (_) {}
  try { env = JSON.parse(r.env || '{}'); } catch (_) {}
  const existing = S.get(Number(id));
  const spec = {
    id: r.id, name: r.name, group: r.group_name, command: r.command, args, cwd: r.cwd || '',
    env, autostart: !!r.autostart, healthUrl: r.health_url || '', maxRestarts: r.max_restarts,
    restartWindowMin: r.restart_window_min, enabled: !!r.enabled,
  };
  if (existing) {
    existing.spec = spec;
  } else {
    const st = db.prepare('SELECT * FROM service_state WHERE service_id=?').get(Number(id)) || {};
    S.set(Number(id), {
      spec,
      proc: null,
      logs: [],
      logStream: null,
      logFile: null,
      logSize: 0,
      state: {
        status: st.status && st.status !== 'running' ? st.status : 'stopped',
        pid: st.pid || null,
        startedAt: st.started_at || null,
        stoppedAt: st.stopped_at || null,
        restartCount: st.restart_count || 0,
        crashCount: st.crash_count || 0,
        lastExitCode: st.last_exit_code ?? null,
        lastExitSignal: st.last_exit_signal || null,
        lastExitAt: st.last_exit_at || null,
      },
      window: [],
      backoffMs: BACKOFF_MIN,
    });
  }
}

function loadAll() {
  const db = dbm.open();
  const rows = db.prepare('SELECT id FROM services ORDER BY id').all();
  for (const r of rows) loadOne(r.id);
  // Recovery: if state says "running" but no process survived a Termux restart,
  // it is stale. Avoid duplicate processes by never trusting stale pids.
  for (const [, rt] of S) {
    if (rt.state.status === 'running' && !isAlive(rt)) {
      rt.state.status = 'stopped';
      rt.state.pid = null;
      saveState(rt.spec.id, rt.state);
      logger.warn('supervisor', `stale running state cleared for "${rt.spec.name}"`);
    }
  }
}

function restoreAutoStart() {
  for (const [, rt] of S) {
    if (rt.spec.autostart && rt.spec.enabled && rt.state.status !== 'running') {
      logger.info('supervisor', `autostart: ${rt.spec.name}`);
      start(rt.spec.id, { manual: false });
    }
  }
}

function getLogs(id, n = 200) {
  const rt = S.get(Number(id));
  if (!rt) return null;
  return rt.logs.slice(-Math.max(1, Math.min(n, LOG_RING)));
}

function logFilePath(id) {
  const rt = S.get(Number(id));
  return rt ? (rt.logFile || logFileFor(rt.spec.id, rt.spec.name)) : null;
}

function clearWindow(id) {
  const rt = S.get(Number(id));
  if (rt) { rt.window = []; rt.backoffMs = BACKOFF_MIN; }
}

module.exports = {
  loadAll, loadOne, restoreAutoStart, start, stop, restart, remove, register, update,
  listServices, getService, getLogs, logFilePath, publicView, isAlive, forceRestart,
  clearWindow, saveState, _state: S,
};
