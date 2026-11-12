// K Termux 24/7 - wake timer
// Lets the user choose how long the phone stays awake: termux-wake-lock now,
// automatic termux-wake-unlock after N seconds. Timer survives server restarts.
'use strict';
const { spawn } = require('child_process');
const notify = require('./notify');
const events = require('./events');
const logger = require('./logger');

const MAX_SECONDS = 31 * 24 * 3600; // 31 days cap
const MAX_TIMEOUT_MS = 2147483000; // Node setTimeout limit (~24.8 days) -> chunk longer timers
let timer = null;

function runCmd(cmd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, [], { timeout: 4000 });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

function human(sec) {
  if (sec >= 86400) return (Math.round((sec / 86400) * 10) / 10) + ' day(s)';
  if (sec >= 3600) return (Math.round((sec / 3600) * 10) / 10) + ' hour(s)';
  if (sec >= 60) return Math.round(sec / 60) + ' minute(s)';
  return sec + ' second(s)';
}

async function expire() {
  timer = null;
  notify.setSetting('wake_until', '');
  const ok = await runCmd('termux-wake-unlock');
  events.emit('wake.expired', 'info', 'Wake timer expired - wake lock released' + (ok ? '' : ' (unlock command unavailable)'), null);
}

function schedule(until) {
  if (timer) { clearTimeout(timer); timer = null; }
  const ms = until - Date.now();
  if (ms <= 0) { expire(); return; }
  if (ms > MAX_TIMEOUT_MS) {
    // longer than setTimeout allows -> sleep in chunks, then finish
    timer = setTimeout(() => { timer = null; schedule(until); }, MAX_TIMEOUT_MS);
  } else {
    timer = setTimeout(expire, ms);
  }
}

async function set(seconds) {
  const s = parseInt(seconds, 10);
  if (!Number.isFinite(s) || s < 1) {
    throw new Error('seconds required (1 to ' + MAX_SECONDS + ')');
  }
  const capped = Math.min(s, MAX_SECONDS);
  const until = Date.now() + capped * 1000;
  notify.setSetting('wake_until', String(until));
  await runCmd('termux-wake-lock');
  schedule(until);
  events.emit('wake.set', 'info', `Wake timer set: phone stays awake for ${human(capped)}`, null);
  return status();
}

async function cancel() {
  if (timer) { clearTimeout(timer); timer = null; }
  notify.setSetting('wake_until', '');
  await runCmd('termux-wake-unlock');
  events.emit('wake.cancelled', 'info', 'Wake timer cancelled - wake lock released', null);
  return status();
}

// Called at boot: re-acquire the lock and re-arm the remaining time, so the
// timer survives server restarts (e.g. after Termux restarts).
async function restoreOnBoot() {
  const until = parseInt(notify.getSetting('wake_until', ''), 10);
  if (Number.isFinite(until) && until > Date.now()) {
    await runCmd('termux-wake-lock');
    schedule(until);
    logger.info('wake', 'wake timer restored, expires ' + new Date(until).toISOString());
  } else if (Number.isFinite(until)) {
    notify.setSetting('wake_until', '');
  }
}

function status() {
  const until = parseInt(notify.getSetting('wake_until', ''), 10);
  const active = Number.isFinite(until) && until > Date.now();
  return {
    timerActive: active,
    wakeUntil: active ? until : null,
    remainingSec: active ? Math.max(1, Math.round((until - Date.now()) / 1000)) : 0,
    remainingHuman: active ? human(Math.max(1, Math.round((until - Date.now()) / 1000))) : null,
    maxSeconds: MAX_SECONDS,
  };
}

module.exports = { set, cancel, status, restoreOnBoot, human, MAX_SECONDS };
