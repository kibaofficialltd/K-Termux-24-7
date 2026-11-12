// K Termux 24/7 Ultimate - configuration loader (tiny .env parser, no dotenv dependency)
'use strict';
const fs = require('fs');
const path = require('path');

function parseEnvFile(file) {
  const out = {};
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (let line of raw.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
  } catch (_) { /* no .env file - fine */ }
  return out;
}

const envFile = parseEnvFile(path.join(__dirname, '..', '.env'));
const env = Object.assign({}, envFile, process.env);

function num(name, def) {
  const v = parseInt(env[name], 10);
  return Number.isFinite(v) ? v : def;
}
function str(name, def) {
  const v = env[name];
  return v === undefined || v === '' ? def : String(v);
}

const root = path.join(__dirname, '..');
const dataDir = path.resolve(root, str('KTERMUX_DATA_DIR', './data'));

const config = {
  root,
  dataDir,
  logsDir: path.join(dataDir, 'logs'),
  backupsDir: path.join(dataDir, 'backups'),
  dbFile: path.join(dataDir, 'k-termux.db'),
  credentialsFile: path.join(dataDir, 'credentials.txt'),
  host: str('KTERMUX_HOST', '127.0.0.1'),
  port: num('KTERMUX_PORT', 7777),
  sessionTtlDays: num('KTERMUX_SESSION_TTL_DAYS', 7),
  netEndpoint: str('KTERMUX_NET_ENDPOINT', 'https://connectivitycheck.gstatic.com/generate_204'),
  adminPassword: str('KTERMUX_ADMIN_PASSWORD', ''),
  version: '1.0.0',
  startedAt: Date.now(),
};

function ensureDirs() {
  for (const d of [config.dataDir, config.logsDir, config.backupsDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

module.exports = { config, ensureDirs, env };
