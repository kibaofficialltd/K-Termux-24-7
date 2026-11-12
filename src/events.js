// K Termux 24/7 Ultimate - event bus: records events in DB, broadcasts to WebSocket clients
'use strict';
const dbm = require('./db');
const logger = require('./logger');

const listeners = new Set();

function emit(type, severity, message, serviceId = null) {
  const at = Date.now();
  let id = null;
  try {
    const db = dbm.open();
    const r = db.prepare('INSERT INTO events (type,severity,service_id,message,at) VALUES (?,?,?,?,?)')
      .run(type, severity, serviceId, message, at);
    id = Number(r.lastInsertRowid);
    // retention: keep last 5000 events
    db.prepare('DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET 5000)').run();
  } catch (e) {
    logger.error('events', 'failed to store event: ' + e.message);
  }
  const event = { id, type, severity, serviceId, message, at };
  for (const fn of listeners) {
    try { fn(event); } catch (_) {}
  }
  return event;
}

function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

module.exports = { emit, subscribe };
