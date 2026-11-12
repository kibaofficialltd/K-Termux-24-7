// K Termux 24/7 Ultimate - rotating logger
// Writes to data/logs/k-termux-server.log with size-based rotation + in-memory tail.
'use strict';
const fs = require('fs');
const path = require('path');
const { config, ensureDirs } = require('./config');

ensureDirs();

const LOG_FILE = path.join(config.logsDir, 'k-termux-server.log');
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB per file
const KEEP = 3;
const TAIL = 400;

const buffer = []; // last TAIL lines
let writes = 0;
let size = 0;
try { size = fs.statSync(LOG_FILE).size; } catch (_) {}

function rotate() {
  try {
    for (let i = KEEP - 1; i > 0; i--) {
      const from = `${LOG_FILE}.${i}`;
      const to = `${LOG_FILE}.${i + 1}`;
      if (fs.existsSync(from)) {
        try { fs.unlinkSync(to); } catch (_) {}
        try { fs.renameSync(from, to); } catch (_) {}
      }
    }
    try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch (_) {}
    size = 0;
  } catch (e) { /* ignore rotation errors */ }
}

function stamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function write(level, ns, msg) {
  const line = `[${stamp()}] [${level}] [${ns}] ${msg}`;
  buffer.push(line);
  if (buffer.length > TAIL) buffer.splice(0, buffer.length - TAIL);
  // Mask anything that looks like a webhook secret token in query strings
  const safe = line.replace(/(discord|webhook)[^\s]*\/([\w-]{10,})/gi, (m) => m.slice(0, 40) + '***');
  try {
    fs.appendFileSync(LOG_FILE, safe + '\n');
    size += safe.length + 1;
    if (++writes % 50 === 0 && size > MAX_BYTES) rotate();
  } catch (_) { /* disk issues must never crash the app */ }
}

module.exports = {
  info: (ns, msg) => write('INFO', ns, msg),
  warn: (ns, msg) => write('WARN', ns, msg),
  error: (ns, msg) => write('ERROR', ns, msg),
  debug: (ns, msg) => { if (process.env.KTERMUX_DEBUG) write('DEBUG', ns, msg); },
  tail: (n = 100) => buffer.slice(-Math.max(1, Math.min(n, TAIL))),
  file: LOG_FILE,
};
