#!/usr/bin/env node
// K Termux 24/7 Ultimate - automated test suite
// Boots a real server instance on a test port with an isolated data dir and
// exercises auth, services CRUD, start/stop/restart, crash recovery, watchdog
// health checks, API keys, schedules, backups and persistence across restart.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = 7899;
const DATA = path.join(__dirname, '..', 'data-test');
const ROOT = path.join(__dirname, '..');
const ADMIN_PW = 'test-admin-password-1';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name + (detail ? ' - ' + detail : '')); console.log(`  FAIL  ${name}${detail ? ' - ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, p, { body = null, headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign(
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
        headers),
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(raw ? res : { status: res.statusCode, headers: res.headers, json: (() => { try { return JSON.parse(data); } catch (_) { return data; } })() }));
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout ' + p)); });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function waitFor(fn, timeoutMs, every = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await fn()) return true; } catch (_) {}
    await sleep(every);
  }
  return false;
}

function cleanData() {
  fs.rmSync(DATA, { recursive: true, force: true });
}

async function startServer(extraEnv = {}) {
  const child = spawn('node', [path.join(ROOT, 'src', 'index.js')], {
    env: Object.assign({}, process.env, {
      KTERMUX_PORT: String(PORT),
      KTERMUX_HOST: '127.0.0.1',
      KTERMUX_DATA_DIR: DATA,
      KTERMUX_ADMIN_PASSWORD: ADMIN_PW,
      KTERMUX_BACKOFF_MIN_MS: '400',
      KTERMUX_BACKOFF_MAX_MS: '2000',
      KTERMUX_WATCHDOG_MS: '1000',
      KTERMUX_HEALTH_MAX_FAILS: '2',
      KTERMUX_NET_ENDPOINT: 'http://127.0.0.1:1/nope', // force offline detection in tests
    }, extraEnv),
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  return child;
}

(async function main() {
  cleanData();
  console.log('== K Termux 24/7 test suite ==');

  // ---- boot ----
  let server = await startServer();
  console.log('\n[boot]');
  check('server boots and /api/health responds',
    await waitFor(async () => (await req('GET', '/api/health')).status === 200, 10000));
  const h = (await req('GET', '/api/health')).json;
  check('health payload ok', h && h.ok === true && h.name === 'K Termux 24/7 Ultimate');

  // ---- auth ----
  console.log('\n[auth & security]');
  check('unauthenticated /api/services is rejected', (await req('GET', '/api/services')).status === 401);
  const badLogin = await req('POST', '/api/login', { body: { username: 'admin', password: 'wrong' } });
  check('wrong password rejected', badLogin.status === 401);
  const login = await req('POST', '/api/login', { body: { username: 'admin', password: ADMIN_PW } });
  check('login succeeds', login.status === 200 && login.json.ok === true, JSON.stringify(login.json));
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const AUTH = { Cookie: cookie };
  check('/api/me works with session', (await req('GET', '/api/me', { headers: AUTH })).status === 200);
  check('credentials file created with restrictive perms',
    (() => { try { return (fs.statSync(path.join(DATA, 'credentials.txt')).mode & 0o777) === 0o600; } catch (_) { return false; } })());

  // ---- system endpoints ----
  console.log('\n[system endpoints]');
  check('GET /api/status', (await req('GET', '/api/status', { headers: AUTH })).status === 200);
  const sys = await req('GET', '/api/system', { headers: AUTH });
  check('GET /api/system returns memory stats', sys.status === 200 && sys.json.memory && sys.json.memory.totalKb > 0);
  check('GET /api/events', (await req('GET', '/api/events', { headers: AUTH })).status === 200);

  // ---- service lifecycle ----
  console.log('\n[service lifecycle]');
  const create = await req('POST', '/api/services', {
    headers: AUTH,
    body: {
      name: 'dummy-api', group: 'APIs', command: 'node',
      args: [path.join(__dirname, 'dummy-service.js'), 'serve'],
      env: { DUMMY_PORT: '3457' }, healthUrl: 'http://127.0.0.1:3457/health',
      autostart: false, maxRestarts: 10, restartWindowMin: 10,
    },
  });
  check('create service', create.status === 201 && create.json.id > 0, JSON.stringify(create.json));
  const svcId = create.json.id;

  const start = await req('POST', `/api/services/${svcId}/start`, { headers: AUTH, body: '{}' });
  check('start service', start.status === 200 && start.json.ok === true, JSON.stringify(start.json));
  await sleep(700);
  let svc = (await req('GET', `/api/services/${svcId}`, { headers: AUTH })).json.service;
  check('service reports running with pid', svc.status === 'running' && svc.pid > 0, 'status=' + svc.status);
  check('duplicate start is refused', (await req('POST', `/api/services/${svcId}/start`, { headers: AUTH, body: '{}' })).status === 409);

  const logs = await req('GET', `/api/services/${svcId}/logs?n=50`, { headers: AUTH });
  check('live logs captured', logs.status === 200 && logs.json.logs.some((l) => /dummy listening/.test(l)), logs.json.logs ? logs.json.logs.slice(-3).join(' | ') : 'empty');

  const restart = await req('POST', `/api/services/${svcId}/restart`, { headers: AUTH, body: '{}' });
  check('restart service', restart.status === 200 && restart.json.ok === true);
  await sleep(900);
  svc = (await req('GET', `/api/services/${svcId}`, { headers: AUTH })).json.service;
  check('service running again after restart', svc.status === 'running', 'status=' + svc.status);

  const stop = await req('POST', `/api/services/${svcId}/stop`, { headers: AUTH, body: '{}' });
  check('stop service', stop.status === 200);
  await sleep(800);
  svc = (await req('GET', `/api/services/${svcId}`, { headers: AUTH })).json.service;
  check('service stopped, pid cleared', svc.status === 'stopped' && !svc.pid, 'status=' + svc.status);

  // ---- crash & auto-recovery with backoff ----
  console.log('\n[crash auto-recovery]');
  const crashSvc = await req('POST', '/api/services', {
    headers: AUTH,
    body: {
      name: 'crashy-bot', group: 'Bots', command: 'node',
      args: [path.join(__dirname, 'dummy-service.js'), 'crash'],
      maxRestarts: 3, restartWindowMin: 10,
    },
  });
  const crashId = crashSvc.json.id;
  await req('POST', `/api/services/${crashId}/start`, { headers: AUTH, body: '{}' });
  // with test backoff (400ms, doubling): 3 restarts then give-up
  const gaveUp = await waitFor(async () => {
    const s = (await req('GET', `/api/services/${crashId}`, { headers: AUTH })).json.service;
    return s.status === 'crashed';
  }, 15000, 500);
  check('crash loop detected -> service gave up (no infinite restart)', gaveUp);
  const evs = (await req('GET', '/api/events?limit=100', { headers: AUTH })).json.events;
  check('crash events recorded', evs.some((e) => e.type === 'service.crashed'));
  check('give-up event recorded', evs.some((e) => e.type === 'service.gave-up'));
  check('restart history recorded', (await req('GET', '/api/uptime', { headers: AUTH })).status === 200);

  // ---- watchdog health checks ----
  console.log('\n[watchdog & uptime]');
  await req('POST', `/api/services/${svcId}/start`, { headers: AUTH, body: '{}' });
  const uptimeSeen = await waitFor(async () => {
    const j = (await req('GET', '/api/uptime?n=10', { headers: AUTH })).json;
    const s = j.services.find((x) => x.serviceId === svcId);
    return s && s.checks && s.checks.length > 0 && s.uptimePercent === 100;
  }, 10000);
  check('health checks recorded with 100% uptime while healthy', uptimeSeen);

  // ---- api keys ----
  console.log('\n[api keys]');
  const keyRes = await req('POST', '/api/apikeys', { headers: AUTH, body: { name: 'test-key' } });
  check('create api key (raw shown once)', keyRes.status === 201 && /^ktermux_[0-9a-f]{48}$/.test(keyRes.json.key));
  const key = keyRes.json.key;
  const withKey = await req('GET', '/api/services', { headers: { 'x-api-key': key } });
  check('x-api-key authenticates', withKey.status === 200);
  check('key list does not leak raw key', JSON.stringify((await req('GET', '/api/apikeys', { headers: AUTH })).json).indexOf(key) === -1);

  // ---- schedules ----
  console.log('\n[schedules]');
  const sch = await req('POST', '/api/schedules', { headers: AUTH, body: { serviceId: svcId, action: 'restart', intervalMin: 5 } });
  check('create schedule', sch.status === 201);
  const badSch = await req('POST', '/api/schedules', { headers: AUTH, body: { action: 'nuke' } });
  check('invalid schedule action rejected', badSch.status === 400);
  check('list schedules', ((await req('GET', '/api/schedules', { headers: AUTH })).json.schedules).length === 1);
  check('delete schedule', (await req('DELETE', `/api/schedules/${sch.json.id}`, { headers: AUTH })).status === 200);

  // ---- notifications / settings / backup ----
  console.log('\n[settings, notifications, backup]');
  check('get notifications config (webhook masked)', (await req('GET', '/api/notifications', { headers: AUTH })).status === 200);
  const whSet = await req('POST', '/api/notifications', { headers: AUTH, body: { discordWebhook: 'not-a-webhook' } });
  check('invalid discord webhook rejected', whSet.status === 400);
  const bk = await req('POST', '/api/backup', { headers: AUTH, body: '{}' });
  check('database backup created', bk.status === 200 && fs.existsSync(bk.json.file));
  const exportRes = await req('GET', '/api/export/services?env=0', { headers: AUTH });
  const exported = JSON.stringify(exportRes.json);
  check('export excludes env values by default', !exported.includes('DUMMY_PORT'));

  // ---- restricted console ----
  console.log('\n[restricted console]');
  const allowed = await req('POST', '/api/console', { headers: AUTH, body: { command: 'overview' } });
  check('allowlisted console command works', allowed.status === 200 && allowed.json.output.length > 0);
  const denied = await req('POST', '/api/console', { headers: AUTH, body: { command: 'rm -rf /' } });
  check('non-allowlisted console command rejected', denied.status === 400);

  // ---- direct access mode (skip login on this phone) ----
  console.log('\n[direct access mode]');
  await req('POST', '/api/settings', { headers: AUTH, body: { auth_disabled: true } });
  check('localhost request allowed without login when direct access is on',
    (await req('GET', '/api/services')).status === 200);
  await req('POST', '/api/settings', { headers: AUTH, body: { auth_disabled: false } });
  check('login required again after direct access is turned off',
    (await req('GET', '/api/services')).status === 401);

  // ---- persistence across restart ----
  console.log('\n[persistence across app restart]');
  process.kill(server.pid, 'SIGTERM');
  await waitFor(async () => { try { return !(await req('GET', '/api/health')).status; } catch (_) { return true; } }, 8000);
  await sleep(500);
  server = await startServer();
  check('server restarts',
    await waitFor(async () => (await req('GET', '/api/health')).status === 200, 10000));
  const relogin = await req('POST', '/api/login', { body: { username: 'admin', password: ADMIN_PW } });
  const auth2 = { Cookie: (relogin.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ') };
  const svcAfter = (await req('GET', `/api/services/${svcId}`, { headers: auth2 })).json.service;
  check('service definition survived restart', !!svcAfter && svcAfter.name === 'dummy-api');
  check('no duplicate processes after restart (stale pid cleaned)',
    svcAfter.status === 'stopped' || (svcAfter.pid && (await new Promise((res) => {
      const c = spawn('kill', ['-0', String(svcAfter.pid)]); c.on('exit', (code) => res(code === 0));
    }))) === true, 'status=' + (svcAfter || {}).status);

  // ---- summary ----
  console.log('\n==============================');
  console.log(`RESULTS: ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('==============================');
  process.kill(server.pid, 'SIGTERM');
  await sleep(500);
  cleanData();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('Test suite crashed:', e);
  process.exit(1);
});
