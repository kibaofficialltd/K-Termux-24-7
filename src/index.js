#!/usr/bin/env node
// KIBA 24/7 ULTIMATE - main entry point
'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { config, ensureDirs, env } = require('./config');
const logger = require('./logger');
const dbm = require('./db');
const auth = require('./auth');
const supervisor = require('./supervisor');
const watchdog = require('./watchdog');
const netmon = require('./netmon');
const sysmon = require('./system');
const events = require('./events');
const schedulerMod = require('./scheduler');
const notify = require('./notify');
const apiRouter = require('./api');
const ws = require('./ws');

ensureDirs();

// ---------------- CLI: --init ----------------
function initDb() {
  dbm.open();
  const count = auth.countUsers();
  if (count > 0) {
    console.log('Database already initialized (admin user exists). Nothing to do.');
    return;
  }
  const username = 'admin';
  let password = config.adminPassword;
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(12).toString('base64url').slice(0, 16);
    generated = true;
  }
  auth.createUser(username, password);
  const creds = `KIBA 24/7 ULTIMATE - Dashboard credentials\nURL:      http://${config.host}:${config.port}/\nUsername: ${username}\nPassword: ${password}\nCreated:  ${new Date().toISOString()}\n(Change this password in Dashboard -> Security after first login.)\n`;
  try {
    fs.writeFileSync(config.credentialsFile, creds, { mode: 0o600 });
    fs.chmodSync(config.credentialsFile, 0o600);
  } catch (_) {}
  if (generated) {
    console.log('========================================================');
    console.log(' Admin user created.');
    console.log(` Username: ${username}`);
    console.log(` Password: ${password}`);
    console.log(` Also saved to: ${config.credentialsFile}`);
    console.log('========================================================');
  } else {
    console.log(`Admin user created with password from KIBA_ADMIN_PASSWORD.`);
  }
}

if (process.argv.includes('--init')) { initDb(); process.exit(0); }

// ---------------- app ----------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// static dashboard (login page open, app requires session)
app.use(express.static(path.join(config.root, 'public'), { index: false, maxAge: '1h' }));

app.use('/api', apiRouter);

app.get('/login', (_req, res) => res.sendFile(path.join(config.root, 'public', 'login.html')));
app.get('/', (_req, res) => res.sendFile(path.join(config.root, 'public', 'index.html')));

// error handler
app.use((err, _req, res, _next) => {
  logger.error('http', 'request error: ' + err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const server = http.createServer(app);
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`FATAL: port ${config.port} already in use (is KIBA already running?).`);
    logger.error('main', 'EADDRINUSE port ' + config.port);
    process.exit(1);
  }
  console.error('Server error: ' + e.message);
});
ws.attach(server);

// ---------------- graceful shutdown ----------------
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('main', `shutdown (${signal}) - stopping services gracefully`);
  events.emit('app.shutdown', 'warn', `KIBA shutting down (${signal})`, null);
  watchdog.stop();
  netmon.stop();
  schedulerMod.stop();
  for (const [, rt] of supervisor._state) {
    if (rt.state.status === 'running') {
      try { process.kill(rt.state.pid, 'SIGTERM'); } catch (_) {}
      rt.state.status = 'stopped';
      rt.state.pid = null;
      rt.state.stoppedAt = Date.now();
      supervisor.saveState(rt.spec.id, rt.state);
    }
    try { rt.logStream && rt.logStream.end(); } catch (_) {}
  }
  ws.close();
  server.close(() => {
    dbm.close();
    process.exit(0);
  });
  setTimeout(() => { dbm.close(); process.exit(0); }, 4000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => {
  logger.error('main', 'uncaughtException: ' + (e.stack || e.message));
});
process.on('unhandledRejection', (e) => {
  logger.error('main', 'unhandledRejection: ' + (e && e.message ? e.message : String(e)));
});

// ---------------- boot ----------------
function boot() {
  dbm.open();
  if (auth.countUsers() === 0) {
    logger.info('main', 'No admin user found - creating one automatically');
    initDb();
  }
  supervisor.loadAll();
  supervisor.restoreAutoStart();
  watchdog.start(15000);
  netmon.start(30000);
  schedulerMod.start(30000);
  notify.notify('KIBA 24/7 started', `Dashboard running on ${config.host}:${config.port}`, 'app-boot', 10 * 60 * 1000);

  // periodic per-service CPU/mem sampling into runtime views
  setInterval(() => {
    for (const [, rt] of supervisor._state) {
      if (rt.state.status === 'running' && rt.state.pid) {
        rt.cpuPercent = sysmon.procCpu(rt.state.pid);
        rt.memRssKb = sysmon.procMem(rt.state.pid);
      } else {
        rt.cpuPercent = null;
        rt.memRssKb = null;
      }
    }
  }, 3000).unref();

  // resource protection warnings (never auto-kills user processes)
  setInterval(() => {
    const mem = sysmon.memInfo();
    if (mem && mem.usedPercent > 90) {
      events.emit('system.resource', 'warn',
        `High RAM usage: ${mem.usedPercent}% (${Math.round(mem.usedKb / 1024)} MB used)`, null);
      notify.notify('KIBA: high RAM usage', `RAM at ${mem.usedPercent}%`, 'resource-ram', 15 * 60 * 1000);
    }
  }, 60 * 1000).unref();

  server.listen(config.port, config.host, () => {
    const msg = `KIBA 24/7 ULTIMATE v${config.version} listening on http://${config.host}:${config.port}`;
    console.log(msg);
    logger.info('main', msg);
    if (config.host !== '127.0.0.1') {
      logger.warn('main', 'API is bound beyond localhost - make sure you use a secure tunnel or VPN');
    }
  });
}

boot();

module.exports = { app, server };
