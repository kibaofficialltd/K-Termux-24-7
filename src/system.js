// K Termux 24/7 Ultimate - system resources (CPU, RAM, per-service usage)
// Reads /proc directly - works without root. Unavailable metrics are labeled null.
'use strict';
const fs = require('fs');
const logger = require('./logger');

let lastTotal = null; // { idle, total, at }
const lastPidTicks = new Map(); // pid -> { ticks, at }

function readCpu() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = stat.replace(/^cpu\s+/, '').trim().split(/\s+/).map(Number);
    if (parts.length < 5 || parts.some(isNaN)) return null;
    const [user, nice, system, idle, iowait] = parts;
    const totalIdle = idle + (iowait || 0);
    const total = user + nice + system + idle + (iowait || 0) + (parts[5] || 0) + (parts[6] || 0) + (parts[7] || 0);
    return { idle: totalIdle, total };
  } catch (_) { return null; }
}

// Sampled CPU% (average since last call, ~interval of watchdog/metrics ticks)
function cpuPercent() {
  const now = readCpu();
  if (!now) return null;
  if (!lastTotal) { lastTotal = now; return null; }
  const dIdle = now.idle - lastTotal.idle;
  const dTotal = now.total - lastTotal.total;
  lastTotal = now;
  if (dTotal <= 0) return null;
  const pct = (1 - dIdle / dTotal) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

function memInfo() {
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (key) => {
      const m = raw.match(new RegExp('^' + key + ':\\s+(\\d+) kB', 'm'));
      return m ? Number(m[1]) : null;
    };
    const total = get('MemTotal'), available = get('MemAvailable'), buffers = get('Buffers'), cached = get('Cached');
    if (!total) return null;
    const used = total - (available ?? ((buffers || 0) + (cached || 0)));
    return { totalKb: total, usedKb: used, availableKb: available ?? (total - used), usedPercent: Math.round((used / total) * 1000) / 10 };
  } catch (_) { return null; }
}

// Per-process CPU% (delta of utime+stime from /proc/<pid>/stat)
function procCpu(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // field 14 = utime, 15 = stime (after comm in parens - handle spaces in comm)
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const utime = Number(after[11]), stime = Number(after[12]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    const ticks = utime + stime;
    const prev = lastPidTicks.get(pid);
    lastPidTicks.set(pid, { ticks, at: Date.now() });
    if (!prev) return null;
    const dTicks = ticks - prev.ticks;
    const dMs = Date.now() - prev.at;
    if (dTicks < 0 || dMs <= 0) return null;
    const hz = 100; // Android USER_HZ is 100
    const pct = (dTicks / hz) / (dMs / 1000) * 100;
    const cores = cpus();
    return Math.max(0, Math.min(100 * cores, Math.round(pct * 10) / 10));
  } catch (_) {
    lastPidTicks.delete(pid);
    return null;
  }
}

function procMem(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = raw.match(/^VmRSS:\s+(\d+) kB/m);
    return m ? Number(m[1]) : null;
  } catch (_) { return null; }
}

function cpus() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    return (stat.match(/^cpu\d+\s/mg) || []).length || 1;
  } catch (_) { return 1; }
}

// Termux:API battery (optional)
function battery() {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const p = spawn('termux-battery-status', [], { timeout: 4000 });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      if (code !== 0) return resolve(null);
      try {
        const j = JSON.parse(out);
        resolve({ percent: j.percentage, status: j.status, plugged: j.plugged });
      } catch (_) { resolve(null); }
    });
  });
}

module.exports = { cpuPercent, memInfo, procCpu, procMem, cpus, battery };
