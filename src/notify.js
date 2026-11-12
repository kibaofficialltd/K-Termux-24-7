// K Termux 24/7 Ultimate - notifications
// Android notifications via Termux:API (optional) + Discord webhook (optional).
// Webhook secrets are stored in DB settings and never logged or echoed.
'use strict';
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const dbm = require('./db');
const logger = require('./logger');

function getSetting(key, def = '') {
  try {
    const db = dbm.open();
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return r && r.value ? r.value : def;
  } catch (_) { return def; }
}

function setSetting(key, value) {
  const db = dbm.open();
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value);
}

function termuxNotify(title, body) {
  if (getSetting('notify_termux', '0') !== '1') return;
  spawn('termux-notification', ['--title', title, '--content', body], { timeout: 5000 })
    .on('error', (e) => logger.warn('notify', 'termux-notification failed: ' + e.message));
}

function postJson(url, data) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve(false); }
    const mod = u.protocol === 'http:' ? http : https;
    const payload = Buffer.from(JSON.stringify(data));
    const req = mod.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      timeout: 8000,
    }, (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end(payload);
  });
}

let lastSent = new Map(); // dedupe: key -> at (avoid notification storms)
function throttled(key, ms) {
  const now = Date.now();
  const last = lastSent.get(key) || 0;
  if (now - last < ms) return false;
  lastSent.set(key, now);
  return true;
}

async function notify(title, body, dedupeKey = null, dedupeMs = 60 * 1000) {
  if (dedupeKey && !throttled(dedupeKey, dedupeMs)) return;
  logger.info('notify', `notification: ${title} | ${body}`);
  termuxNotify(title, body);
  const webhook = getSetting('discord_webhook', '');
  if (webhook) {
    const ok = await postJson(webhook, {
      username: 'K Termux 24/7',
      embeds: [{ title, description: body, color: 0xe5484d, footer: { text: 'K Termux 24/7 Ultimate' } }],
    });
    if (!ok) logger.warn('notify', 'discord webhook delivery failed (url hidden)');
  }
}

function maskSettings() {
  const webhook = getSetting('discord_webhook', '');
  let masked = null;
  if (webhook) {
    try {
      const u = new URL(webhook);
      masked = `${u.protocol}//${u.host}${u.pathname.slice(0, 12)}…`;
    } catch (_) { masked = '(set)'; }
  }
  return { termuxEnabled: getSetting('notify_termux', '0') === '1', discordWebhookMasked: masked };
}

module.exports = { notify, getSetting, setSetting, maskSettings };
