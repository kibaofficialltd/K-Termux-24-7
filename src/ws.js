// KIBA 24/7 ULTIMATE - WebSocket live updates
// Authenticated via session token or API key in query/header; pushes events & stats.
'use strict';
const { WebSocketServer } = require('ws');
const http = require('http');
const auth = require('./auth');
const events = require('./events');
const supervisor = require('./supervisor');
const sysmon = require('./system');
const netmon = require('./netmon');
const logger = require('./logger');

let wss = null;
let statsTimer = null;

function attach(server) {
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    let token = url.searchParams.get('token') || '';
    if (!token) {
      const m = /(?:^|;\s*)kiba_session=([\w-]+)/.exec(req.headers.cookie || '');
      token = m ? m[1] : '';
    }
    const apiKey = req.headers['x-api-key'];
    let authed = false;
    if (apiKey && auth.verifyApiKey(String(apiKey).trim())) authed = true;
    else if (token && auth.getSession(token)) authed = true;
    if (!authed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('close', () => {});
      ws.send(JSON.stringify({ kind: 'hello', at: Date.now() }));
    });
  });

  // heartbeat: drop dead connections
  const hb = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, 30000);
  hb.unref();

  // push events live
  events.subscribe((event) => broadcast({ kind: 'event', event }));

  // periodic stats
  statsTimer = setInterval(() => {
    broadcast({
      kind: 'stats',
      at: Date.now(),
      cpuPercent: sysmon.cpuPercent(),
      memory: sysmon.memInfo(),
      network: netmon.status(),
      services: supervisor.listServices().map((s) => ({
        id: s.id, name: s.name, status: s.status, pid: s.pid,
        cpuPercent: s.cpuPercent, memRssKb: s.memRssKb, restartCount: s.restartCount, crashCount: s.crashCount,
      })),
    });
  }, 5000);
  statsTimer.unref();

  logger.info('ws', 'websocket server attached');
  return wss;
}

function broadcast(msg) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) {
      try { ws.send(data); } catch (_) {}
    }
  }
}

function close() {
  if (statsTimer) clearInterval(statsTimer);
  if (wss) { try { wss.close(); } catch (_) {} }
}

module.exports = { attach, broadcast, close };
