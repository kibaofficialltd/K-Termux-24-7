/* KIBA 24/7 ULTIMATE - dashboard client */
'use strict';

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  if (r.status === 401 && !path.startsWith('/login')) { location.href = '/login'; throw new Error('unauthorized'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function toast(msg, cls = 'info', ms = 3500) {
  const t = document.createElement('div');
  t.className = 'toast ' + cls;
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function fmtBytes(kb) {
  if (kb == null) return '–';
  if (kb > 1024 * 1024) return (kb / 1048576).toFixed(1) + ' GB';
  if (kb > 1024) return (kb / 1024).toFixed(0) + ' MB';
  return kb + ' KB';
}
function fmtUptime(ms) {
  if (ms == null || isNaN(ms)) return '–';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm';
}
function fmtTime(at) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function badge(status) {
  const cls = { running: 'running', crashed: 'crashed', backoff: 'backoff', stopping: 'backoff' }[status] || 'info';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

// ---------- tabs ----------
const VIEWS = ['overview', 'processes', 'uptime', 'network', 'api', 'system', 'logs', 'notifications', 'settings', 'security'];
function switchView(name) {
  VIEWS.forEach((v) => {
    $('view-' + v).classList.toggle('active', v === name);
  });
  document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  const loaders = {
    overview: loadOverview, processes: loadProcesses, uptime: loadUptime, network: loadNetwork,
    api: loadApi, system: loadSystem, logs: loadLogs, notifications: loadNotify,
    settings: loadSettings, security: loadSecurity,
  };
  loaders[name] && loaders[name]();
}
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) switchView(b.dataset.view);
});

// ---------- websocket live updates ----------
let ws = null, wsTimer = null;
let latestServices = [];

function connectWs() {
  if (ws) { try { ws.close(); } catch (_) {} }
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  const setState = (t) => { $('wsState').textContent = t; };
  ws.onopen = () => setState('live');
  ws.onclose = () => { setState('offline'); wsTimer = setTimeout(connectWs, 4000); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.kind === 'event') {
      pushEventUI(msg.event);
      if (msg.event.severity === 'error' || msg.event.severity === 'warn') {
        toast(msg.event.message, msg.event.severity);
      }
    } else if (msg.kind === 'stats') {
      updateStats(msg);
    }
  };
}

// ---------- overview ----------
function updateStats(msg) {
  if (msg.services) {
    latestServices = msg.services;
    const running = msg.services.filter((s) => s.status === 'running').length;
    const stopped = msg.services.length - running;
    $('ovRunning').textContent = running;
    $('ovStopped').textContent = stopped;
    const crashes = msg.services.reduce((a, s) => a + (s.crashCount || 0), 0);
    const restarts = msg.services.reduce((a, s) => a + (s.restartCount || 0), 0);
    $('ovCrashes').textContent = crashes;
    $('ovRestarts').textContent = restarts;
    $('ovServices').classList.remove('empty');
    $('ovServices').innerHTML = msg.services.length
      ? msg.services.map((s) => `<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)"><span>${esc(s.name)}</span>${badge(s.status)}<span class="muted small mono">${s.cpuPercent != null ? s.cpuPercent + '% cpu' : ''} ${s.memRssKb != null ? fmtBytes(s.memRssKb) : ''}</span></div>`).join('')
      : 'No services registered yet.';
  }
  if (msg.cpuPercent != null) $('ovCpu').textContent = msg.cpuPercent + '%';
  if (msg.memory) {
    $('ovRam').textContent = msg.memory.usedPercent + '%';
    $('ovRamDetail').textContent = fmtBytes(msg.memory.usedKb) + ' / ' + fmtBytes(msg.memory.totalKb);
  }
  if (msg.network && msg.network.online !== null) {
    $('ovNet').textContent = msg.network.online ? 'online' : 'OFFLINE';
    $('netDot').className = 'net-dot ' + (msg.network.online ? 'online' : 'offline');
  }
}

async function loadOverview() {
  try {
    const st = await api('/status');
    $('ovUptime').textContent = fmtUptime(st.uptimeMs);
    $('ovUptimeSince').textContent = 'since ' + new Date(Date.now() - st.uptimeMs).toLocaleString();
    $('ovMonitoring').textContent = st.monitoring.watchdog ? 'active' : 'off';
    const events = (await api('/events?limit=15')).events;
    $('ovEvents').querySelector('tbody').innerHTML = events.map((ev) =>
      `<tr><td style="width:70px" class="muted small">${fmtTime(ev.at)}</td><td><span class="badge ${esc(ev.severity)}">${esc(ev.type)}</span></td><td class="small">${esc(ev.message)}</td></tr>`
    ).join('') || '<tr><td class="muted">No events yet</td></tr>';
    const sys = await api('/system');
    $('ovCores').textContent = sys.cores + ' core(s)';
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- process manager ----------
function svcRow(s) {
  const running = s.status === 'running';
  return `<div class="svc" data-id="${s.id}">
    <div class="info">
      <div class="name">${esc(s.name)} <span class="group">${esc(s.group)}</span> ${badge(s.status)}</div>
      <div class="meta mono">${esc(s.command)} ${esc((s.args || []).join(' '))}${s.pid ? ' · pid ' + s.pid : ''}${s.restartCount ? ' · ' + s.restartCount + ' restarts' : ''}${s.crashCount ? ' · ' + s.crashCount + ' crashes' : ''}</div>
    </div>
    <div class="ops">
      <button class="small primary" data-act="start" ${running || !s.enabled ? 'disabled' : ''}>Start</button>
      <button class="small" data-act="stop" ${!running ? 'disabled' : ''}>Stop</button>
      <button class="small" data-act="restart">Restart</button>
      <button class="small" data-act="logs">Logs</button>
      <button class="small" data-act="edit">Edit</button>
      <button class="small danger" data-act="delete">Del</button>
    </div>
    <div class="svc-detail"><div class="logbox" id="svclog-${s.id}">…</div></div>
  </div>`;
}

async function loadProcesses() {
  const { services } = await api('/services');
  latestServices = services;
  $('svcList').innerHTML = services.map(svcRow).join('') || '<div class="empty">No services yet. Tap “+ Add service”.</div>';
}

$('svcList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('.svc');
  const id = row.dataset.id;
  const act = btn.dataset.act;
  try {
    if (act === 'start' || act === 'stop' || act === 'restart') {
      const r = await api(`/services/${id}/${act}`, { method: 'POST', body: '{}' });
      toast(r.note ? r.note : 'Done', 'info');
      setTimeout(loadProcesses, 400);
    } else if (act === 'logs') {
      const det = row.querySelector('.svc-detail');
      const open = det.classList.toggle('open');
      if (open) {
        const { logs } = await api(`/services/${id}/logs?n=100`);
        $('svclog-' + id).innerHTML = logs.map((l) => {
          const cls = / err /.test(l) ? 'l-err' : / sys /.test(l) ? 'l-sys' : 'l-out';
          return `<span class="${cls}">${esc(l)}</span>`;
        }).join('\n') || 'No log output yet.';
      }
    } else if (act === 'edit') {
      openServiceModal(id);
    } else if (act === 'delete') {
      if (!confirm('Delete this service definition?')) return;
      await api('/services/' + id, { method: 'DELETE' });
      toast('Service deleted');
      loadProcesses();
    }
  } catch (err) { toast(err.message, 'error'); }
});

$('restartAllBtn').addEventListener('click', async () => {
  if (!confirm('Restart all services?')) return;
  const r = await api('/services/restart-all', { method: 'POST', body: '{}' });
  toast('Restarted ' + r.count + ' services');
  setTimeout(loadProcesses, 600);
});

// ---------- service modal ----------
let editingId = null;
function openServiceModal(id = null) {
  editingId = id;
  $('svcModalTitle').textContent = id ? 'Edit service' : 'Add service';
  ['fName', 'fCommand', 'fCwd', 'fEnv', 'fArgs', 'fHealth'].forEach((x) => { $(x).value = ''; });
  $('fAuto').checked = false;
  $('fMaxRestarts').value = 10;
  $('fWindowMin').value = 10;
  if (id) {
    api('/services/' + id).then(({ service }) => {
      $('fName').value = service.name;
      $('fGroup').value = service.group;
      $('fCommand').value = service.command;
      $('fArgs').value = (service.args || []).join('\n');
      $('fCwd').value = service.cwd || '';
      $('fEnv').value = Object.entries(service.env || {}).map(([k, v]) => k + '=' + v).join('\n');
      $('fHealth').value = service.healthUrl || '';
      $('fAuto').checked = !!service.autostart;
      $('fMaxRestarts').value = service.maxRestarts;
      $('fWindowMin').value = service.restartWindowMin;
    }).catch((e) => toast(e.message, 'error'));
  }
  $('svcModal').classList.add('open');
}
$('addSvcBtn').addEventListener('click', () => openServiceModal());
$('svcCancelBtn').addEventListener('click', () => $('svcModal').classList.remove('open'));

$('svcSaveBtn').addEventListener('click', async () => {
  const body = {
    name: $('fName').value.trim(),
    group: $('fGroup').value,
    command: $('fCommand').value.trim(),
    args: $('fArgs').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
    cwd: $('fCwd').value.trim(),
    env: Object.fromEntries($('fEnv').value.split(/\r?\n/).map((l) => l.split('=',)).filter((p) => p.length >= 2 && p[0].trim()).map((p) => [p[0].trim(), p.slice(1).join('=')])),
    healthUrl: $('fHealth').value.trim(),
    autostart: $('fAuto').checked,
    maxRestarts: parseInt($('fMaxRestarts').value, 10) || 10,
    restartWindowMin: parseInt($('fWindowMin').value, 10) || 10,
  };
  try {
    if (editingId) await api('/services/' + editingId, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/services', { method: 'POST', body: JSON.stringify(body) });
    $('svcModal').classList.remove('open');
    toast('Service saved');
    loadProcesses();
  } catch (e) { toast(e.message, 'error'); }
});

// ---------- uptime ----------
async function loadUptime() {
  const { services } = await api('/uptime?n=60');
  $('uptimeList').innerHTML = services.length ? services.map((s) => {
    const bars = s.checks.map((c) => `<div class="bar ${c.ok ? '' : 'fail'}" title="${new Date(c.at).toLocaleTimeString()} ${c.ok ? c.latencyMs + 'ms' : 'FAIL'}"></div>`).join('')
      || '<div class="bar none" style="flex:20"></div>';
    return `<div class="svc" style="display:block">
      <div class="row" style="justify-content:space-between">
        <div class="name" style="font-weight:600">${esc(s.name)}</div>
        <div class="small muted">${s.healthUrl ? esc(s.healthUrl) : 'no health URL configured'}</div>
        <div><span class="badge ${s.uptimePercent == null ? 'info' : s.uptimePercent >= 99 ? 'running' : s.uptimePercent >= 90 ? 'backoff' : 'crashed'}">${s.uptimePercent == null ? 'no data' : s.uptimePercent + '%'}</span></div>
      </div>
      <div class="uptime-bars">${bars}</div>
      <div class="small muted" style="margin-top:5px">${s.avgLatencyMs != null ? 'avg latency ' + s.avgLatencyMs + ' ms' : ''}</div>
    </div>`;
  }).join('') : '<div class="empty">No services with health checks yet.</div>';
}
$('uptimeRefreshBtn').addEventListener('click', loadUptime);

// ---------- network ----------
function drawSpark(canvas, points, okColor, failColor) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.offsetWidth * 2;
  const h = canvas.height = 140;
  ctx.clearRect(0, 0, w, h);
  if (!points.length) return;
  const maxLat = Math.max(...points.map((p) => p.latencyMs || 0), 100);
  const bw = w / points.length;
  points.forEach((p, i) => {
    const bh = Math.max(3, ((p.latencyMs || 0) / maxLat) * (h - 10));
    ctx.fillStyle = p.ok ? okColor : failColor;
    ctx.globalAlpha = p.ok ? .8 : 1;
    ctx.fillRect(i * bw, h - bh, Math.max(2, bw - 2), bh);
  });
  ctx.globalAlpha = 1;
}

async function loadNetwork() {
  const { history, status } = (await api('/monitoring')).network;
  $('netStatus').textContent = status.online === null ? 'unknown' : (status.online ? 'online' : 'OFFLINE');
  $('netEndpoint').textContent = status.endpoint.replace(/^https?:\/\//, '').slice(0, 40);
  const last = history.filter((h) => h.ok).pop();
  $('netLatency').textContent = last ? last.latencyMs + ' ms' : '–';
  drawSpark($('netChart'), history, '#46a758', '#e5484d');
}
$('netRefreshBtn').addEventListener('click', loadNetwork);

// ---------- api manager ----------
const ENDPOINT_LIST = [
  'GET  /api/status', 'GET  /api/system', 'GET  /api/services', 'GET  /api/services/:id',
  'POST /api/services', 'PUT  /api/services/:id', 'DELETE /api/services/:id',
  'POST /api/services/:id/start', 'POST /api/services/:id/stop', 'POST /api/services/:id/restart',
  'POST /api/services/restart-all', 'GET  /api/services/:id/logs', 'GET  /api/uptime',
  'GET  /api/monitoring', 'GET  /api/events', 'GET  /api/health (public)',
  'GET/POST /api/apikeys', 'GET/POST /api/schedules', 'POST /api/backup',
  'GET  /api/export/services', 'GET  /api/audit', 'POST /api/password', 'POST /api/console (localhost only)',
];
$('apiEndpoints').textContent = ENDPOINT_LIST.join('\n');

async function loadApi() {
  const { keys } = await api('/apikeys');
  $('keyTable').querySelector('tbody').innerHTML = keys.length ? keys.map((k) =>
    `<tr><td>${esc(k.name)}</td><td class="mono">${esc(k.key_prefix)}</td>
     <td class="small muted">${new Date(k.created_at).toLocaleDateString()}</td>
     <td class="small muted">${k.last_used ? new Date(k.last_used).toLocaleString() : 'never'}</td>
     <td><button class="small danger" data-key="${k.id}">${k.revoked ? 'Delete' : 'Revoke'}</button></td></tr>`
  ).join('') : '<tr><td colspan="5" class="muted">No API keys</td></tr>';
}
$('keyTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-key]');
  if (!btn) return;
  const id = btn.dataset.key;
  try {
    const del = btn.textContent === 'Delete';
    if (del) { if (!confirm('Delete key permanently?')) return; await api('/apikeys/' + id, { method: 'DELETE' }); }
    else await api('/apikeys/' + id, { method: 'DELETE' });
    toast('Key ' + (del ? 'deleted' : 'revoked'));
    loadApi();
  } catch (err) { toast(err.message, 'error'); }
});
$('addKeyBtn').addEventListener('click', async () => {
  const name = prompt('Key name (e.g. my-script):');
  if (!name) return;
  try {
    const { key } = await api('/apikeys', { method: 'POST', body: JSON.stringify({ name }) });
    $('newKeyBox').innerHTML = `<div class="key-display">Save this key now - it will never be shown again:<br><br>${esc(key)}</div>`;
    loadApi();
  } catch (e) { toast(e.message, 'error'); }
});

// ---------- system ----------
async function loadSystem() {
  const sys = await api('/system');
  $('sysCpu').textContent = sys.cpuPercent != null ? sys.cpuPercent + '%' : 'n/a';
  $('sysCpu').nextElementSibling && null;
  if (sys.memory) {
    $('sysRam').textContent = sys.memory.usedPercent + '%';
    $('sysRamDetail').textContent = fmtBytes(sys.memory.usedKb) + ' / ' + fmtBytes(sys.memory.totalKb);
  } else {
    $('sysRam').textContent = 'n/a';
    $('sysRamDetail').textContent = 'unavailable on this device';
  }
  if (sys.battery) {
    $('sysBattery').textContent = sys.battery.percent + '%';
    $('sysBatteryDetail').textContent = sys.battery.status || '';
  } else {
    $('sysBattery').textContent = 'n/a';
    $('sysBatteryDetail').textContent = 'install Termux:API app + pkg install termux-api';
  }
  $('sysLoad').textContent = sys.loadavg.map((x) => x.toFixed(2)).join(' / ');
  $('sysSvcTable').querySelector('tbody').innerHTML = latestServices.length ? latestServices.map((s) =>
    `<tr><td>${esc(s.name)}</td><td>${badge(s.status)}</td><td class="mono">${s.pid || '–'}</td>
     <td>${s.cpuPercent != null ? s.cpuPercent + '%' : 'n/a'}</td><td>${s.memRssKb != null ? fmtBytes(s.memRssKb) : 'n/a'}</td></tr>`
  ).join('') : '<tr><td colspan="5" class="muted">No services</td></tr>';
}

// ---------- logs ----------
let logPoll = null;
async function loadLogs() {
  const sel = $('logSource');
  if (sel.options.length <= 1) {
    try {
      const { services } = await api('/services');
      for (const s of services) {
        const o = document.createElement('option');
        o.value = 'svc:' + s.id;
        o.textContent = s.name;
        sel.appendChild(o);
      }
    } catch (_) {}
  }
  refreshLog();
}
async function refreshLog() {
  const v = $('logSource').value;
  try {
    if (v === 'server') {
      const r = await fetch('/api/health').catch(() => null);
      // server log needs auth; reuse events? Use dedicated fetch of tail via /api/audit? Instead:
      // server log tail is exposed through /api/events? No - dedicated endpoint below.
      const j = await api('/serverlog?n=150');
      $('logBox').textContent = j.lines.join('\n') || '(empty)';
    } else {
      const id = v.split(':')[1];
      const { logs } = await api(`/services/${id}/logs?n=200`);
      $('logBox').innerHTML = logs.map((l) => {
        const cls = / err /.test(l) ? 'l-err' : / sys /.test(l) ? 'l-sys' : 'l-out';
        return `<span class="${cls}">${esc(l)}</span>`;
      }).join('\n') || 'No output yet.';
    }
  } catch (e) { $('logBox').textContent = 'Error: ' + e.message; }
}
$('logSource').addEventListener('change', refreshLog);
$('logRefreshBtn').addEventListener('click', refreshLog);
$('logLive').addEventListener('change', (e) => {
  clearInterval(logPoll);
  if (e.target.checked) logPoll = setInterval(refreshLog, 3000);
});

// ---------- notifications ----------
async function loadNotify() {
  const cfg = await api('/notifications');
  $('ntTermux').checked = !!cfg.termuxEnabled;
  $('ntWebhook').value = '';
  if (cfg.discordWebhookMasked) $('ntWebhook').placeholder = 'configured: ' + cfg.discordWebhookMasked;
}
$('ntSaveBtn').addEventListener('click', async () => {
  try {
    const body = { termuxEnabled: $('ntTermux').checked };
    const wh = $('ntWebhook').value.trim();
    if (wh) body.discordWebhook = wh;
    await api('/notifications', { method: 'POST', body: JSON.stringify(body) });
    toast('Notification settings saved');
    loadNotify();
  } catch (e) { toast(e.message, 'error'); }
});
$('ntTestBtn').addEventListener('click', async () => {
  try { await api('/notifications/test', { method: 'POST', body: '{}' }); toast('Test notification sent'); }
  catch (e) { toast(e.message, 'error'); }
});

// ---------- settings ----------
async function loadSettings() {
  const { settings } = await api('/settings');
  $('setEndpoint').value = settings.net_endpoint || '';
  // schedules
  const [{ schedules }, { services }] = await Promise.all([api('/schedules'), api('/services')]);
  const sel = $('schSvc');
  sel.innerHTML = '<option value="">All services / none</option>' + services.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('schTable').querySelector('tbody').innerHTML = schedules.length ? schedules.map((s) =>
    `<tr><td>${s.id}</td><td><span class="badge info">${esc(s.action)}</span></td>
     <td>${s.service_id ? esc((services.find((x) => x.id === s.service_id) || {}).name || s.service_id) : '—'}</td>
     <td class="small">${s.at_time ? 'daily ' + esc(s.at_time) : 'every ' + s.interval_min + ' min'}</td>
     <td class="small muted">${s.next_run ? new Date(s.next_run).toLocaleString() : '–'}</td>
     <td><button class="small danger" data-sch="${s.id}">Del</button></td></tr>`
  ).join('') : '<tr><td colspan="6" class="muted">No scheduled tasks</td></tr>';
  // backups
  const { backups } = await api('/backups');
  $('backupTable').querySelector('tbody').innerHTML = backups.length ? backups.map((b) =>
    `<tr><td class="mono small">${esc(b.name)}</td><td class="small">${fmtBytes(Math.round(b.size / 1024))}</td><td class="small muted">${new Date(b.at).toLocaleString()}</td></tr>`
  ).join('') : '<tr><td colspan="3" class="muted">No backups yet</td></tr>';
}
$('schTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-sch]');
  if (!btn) return;
  await api('/schedules/' + btn.dataset.sch, { method: 'DELETE' });
  toast('Schedule removed');
  loadSettings();
});
$('schAddBtn').addEventListener('click', async () => {
  try {
    await api('/schedules', {
      method: 'POST',
      body: JSON.stringify({
        serviceId: $('schSvc').value || null,
        action: $('schAction').value,
        intervalMin: $('schInterval').value || undefined,
        atTime: $('schTime').value || undefined,
      }),
    });
    toast('Schedule added');
    loadSettings();
  } catch (e) { toast(e.message, 'error'); }
});
$('setSaveBtn').addEventListener('click', async () => {
  try {
    await api('/settings', { method: 'POST', body: JSON.stringify({ net_endpoint: $('setEndpoint').value.trim() }) });
    toast('Settings saved');
  } catch (e) { toast(e.message, 'error'); }
});
$('backupBtn').addEventListener('click', async () => {
  try { const r = await api('/backup', { method: 'POST', body: '{}' }); toast('Backup created: ' + r.file.split('/').pop()); loadSettings(); }
  catch (e) { toast(e.message, 'error'); }
});
$('conRunBtn').addEventListener('click', async () => {
  try {
    const r = await api('/console', { method: 'POST', body: JSON.stringify({ command: $('conCmd').value.trim() }) });
    $('conOut').textContent = r.output;
  } catch (e) { $('conOut').textContent = 'Error: ' + e.message; }
});

// ---------- security ----------
async function loadSecurity() {
  const { audit } = await api('/audit?limit=80');
  $('auditTable').querySelector('tbody').innerHTML = audit.length ? audit.reverse().map((a) =>
    `<tr><td class="small muted">${new Date(a.at).toLocaleString()}</td><td>${esc(a.user)}</td>
     <td><span class="badge info">${esc(a.action)}</span></td><td class="small">${esc(a.detail)}</td><td class="small muted mono">${esc(a.ip)}</td></tr>`
  ).join('') : '<tr><td colspan="5" class="muted">No audit entries</td></tr>';
}
$('secSaveBtn').addEventListener('click', async () => {
  try {
    await api('/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: $('secCur').value, newPassword: $('secNew').value }),
    });
    toast('Password changed - log in again', 'info');
    setTimeout(() => location.href = '/login', 1200);
  } catch (e) { toast(e.message, 'error'); }
});

// ---------- logout ----------
$('logoutBtn').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST', body: '{}' }); } catch (_) {}
  location.href = '/login';
});

// ---------- boot ----------
(async function boot() {
  try {
    await api('/me');
  } catch (_) { location.href = '/login'; return; }
  $('app').style.display = 'block';
  // warn when not on localhost
  if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname)) {
    $('noHttpsNotice').classList.remove('hidden');
  }
  connectWs();
  loadOverview();
  setInterval(() => { if (document.querySelector('#view-overview.active')) loadOverview(); }, 30000);
})();
