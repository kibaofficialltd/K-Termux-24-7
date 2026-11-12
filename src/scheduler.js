// KIBA 24/7 ULTIMATE - scheduled tasks
// Interval-based and daily-time schedules for service restart/stop/start + backups.
'use strict';
const dbm = require('./db');
const events = require('./events');
const supervisor = require('./supervisor');
const logger = require('./logger');

let timer = null;

function parseInterval(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1 || n > 10080) return null;
  return n;
}

function parseTime(t) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t || ''));
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

function nextDailyRun(hhmm, from = Date.now()) {
  const [h, mi] = hhmm.split(':').map(Number);
  const d = new Date(from);
  const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, mi, 0, 0);
  if (cand.getTime() <= from) cand.setDate(cand.getDate() + 1);
  return cand.getTime();
}

function addSchedule({ serviceId, action, intervalMin, atTime, enabled = true }) {
  const db = dbm.open();
  if (!['restart', 'stop', 'start', 'backup'].includes(action)) throw new Error('Invalid action');
  const interval = parseInterval(intervalMin);
  const time = parseTime(atTime);
  if (!interval && !time) throw new Error('Provide intervalMin (1-10080) or atTime (HH:MM)');
  const nextRun = time ? nextDailyRun(time) : Date.now() + interval * 60 * 1000;
  const r = db.prepare('INSERT INTO schedules (service_id,action,interval_min,at_time,enabled,last_run,next_run) VALUES (?,?,?,?,?,?,?)')
    .run(serviceId ? Number(serviceId) : null, action, interval, time, enabled ? 1 : 0, null, nextRun);
  return Number(r.lastInsertRowid);
}

function listSchedules() {
  const db = dbm.open();
  return db.prepare('SELECT * FROM schedules ORDER BY id').all();
}

function removeSchedule(id) {
  const db = dbm.open();
  const r = db.prepare('DELETE FROM schedules WHERE id=?').run(Number(id));
  return r.changes > 0;
}

function runAction(sc) {
  const db = dbm.open();
  if (sc.action === 'backup') {
    require('./db').backup('scheduled');
    events.emit('schedule.run', 'info', 'Scheduled backup completed', null);
    return;
  }
  if (sc.action === 'start') {
    if (sc.serviceId) supervisor.start(sc.serviceId, { manual: false });
    events.emit('schedule.run', 'info', `Scheduled start executed`, sc.serviceId);
    return;
  }
  if (sc.action === 'stop') {
    if (sc.serviceId) supervisor.stop(sc.serviceId, { manual: true, reason: 'scheduled stop' });
    events.emit('schedule.run', 'info', `Scheduled stop executed`, sc.serviceId);
    return;
  }
  if (sc.action === 'restart') {
    if (sc.serviceId) supervisor.restart(sc.serviceId, 'scheduled restart');
    events.emit('schedule.run', 'info', `Scheduled restart executed`, sc.serviceId);
  }
}

function tick() {
  const db = dbm.open();
  const now = Date.now();
  const due = db.prepare('SELECT * FROM schedules WHERE enabled=1 AND next_run IS NOT NULL AND next_run<=?').all(now);
  for (const sc of due) {
    try {
      runAction(sc);
    } catch (e) {
      logger.warn('scheduler', 'schedule ' + sc.id + ' failed: ' + e.message);
    }
    const next = sc.at_time ? nextDailyRun(sc.at_time, now) : now + sc.interval_min * 60 * 1000;
    db.prepare('UPDATE schedules SET last_run=?, next_run=? WHERE id=?').run(now, next, sc.id);
  }
}

function start(ms) {
  stop();
  // Sanity on startup: any overdue next_run gets rescheduled now+
  try {
    const db = dbm.open();
    db.prepare('UPDATE schedules SET next_run=? WHERE enabled=1 AND next_run IS NOT NULL AND next_run < ?')
      .run(Date.now() + 60 * 1000, Date.now() - 24 * 3600 * 1000);
  } catch (_) {}
  timer = setInterval(tick, ms || 30 * 1000);
  timer.unref();
  logger.info('scheduler', 'started');
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { addSchedule, listSchedules, removeSchedule, start, stop, runAction };
