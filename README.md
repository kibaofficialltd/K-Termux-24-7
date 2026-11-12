# K Termux 24/7 Ultimate

A production-quality personal server management system for Android (Termux):
process supervisor with a smart watchdog, live web dashboard, authenticated
REST API, network monitoring, notifications, schedules, backups and security —
built with real process management and persistent configuration. No fake
metrics, no simulated services.

```
Node.js >= 22.5 (uses built-in SQLite) · Express · WebSocket
Dependencies: express + ws only (both pure JS, Termux-safe)
```

---

## Quick start (Termux)

One command — copy-paste this into Termux:

```bash
pkg install -y git nodejs && git clone https://github.com/kibaofficialltd/K-Termux-24-7.git && cd K-Termux-24-7 && bash install.sh && termux-wake-lock
```

**During the install you choose your own username and password** — that's what
you'll use to sign in to the dashboard (input is hidden while typing, and the
password must be at least 8 characters).

Then open the dashboard: **http://127.0.0.1:7777/**

First-run credentials are printed by the installer and saved to
`data/credentials.txt` (chmod 600). **Change the password in Dashboard →
Security after first login.**

### Stay online 24/7 (Android reality check)

```bash
termux-wake-lock          # keep Termux running in background
bash setup-boot.sh        # autostart after phone reboot (needs Termux:Boot app)
```

Then in Android Settings: **Apps → Termux → Battery → Unrestricted**
(allow background activity). See the [honest limitations](#android-keep-alive-read-this-honestly)
below — a phone can be interrupted by force-stop, reboot, heat or power loss.
For services that absolutely must stay up, a cheap cloud VPS is more reliable;
this system makes a phone as reliable as Android allows.

## Everyday commands

| Command | What it does |
|---|---|
| `bash start.sh` | Start the server in the background (takes wake-lock) |
| `bash stop.sh` | Stop gracefully (SIGTERM → SIGKILL fallback) |
| `bash restart.sh` | Restart |
| `bash status.sh` | Process + API health status |
| `bash backup.sh` | Backup DB + credentials to `data/backups/` |
| `bash setup-boot.sh` | Install Termux:Boot autostart script |
| `npm test` | Run the full automated test suite |

## Architecture

```
src/
  index.js       entry point, boot, graceful shutdown, auto-admin bootstrap
  config.js      .env loader (no dotenv dependency)
  db.js          SQLite (node:sqlite built-in), migrations, backups, retention
  supervisor.js  real child-process manager: spawn/stop/restart, ring-buffer
                 logs + rotated log files, exponential backoff, restart limits
  watchdog.js    liveness + optional HTTP health checks, forced restarts
  netmon.js      internet connectivity, latency history, outage/recovery events
  system.js      CPU/RAM from /proc, per-process CPU/RAM, battery (Termux:API)
  notify.js      Termux:API notifications + Discord webhook (secret never logged)
  scheduler.js   interval / daily-time schedules (restart/stop/start/backup)
  auth.js        scrypt password hashing, DB sessions, hashed API keys,
                 rate limiting, audit log
  api.js         K TERMUX CONTROL API (all endpoints below)
  ws.js          authenticated WebSocket: live events + stats every 5s
public/
  login.html / index.html / style.css / app.js   dark mobile-first dashboard
```

## K TERMUX CONTROL API

All endpoints require auth (dashboard session cookie or `x-api-key` header),
except `GET /api/health`. The server binds to **127.0.0.1** by default.

```
GET    /api/status                    running/stopped counts, uptime, network
GET    /api/system                    CPU, RAM, battery, loadavg
GET    /api/services                  list services (live status)
GET    /api/services/:id              one service
POST   /api/services                  register: {name, group, command, args[],
                                      cwd, env{}, autostart, healthUrl,
                                      maxRestarts, restartWindowMin}
PUT    /api/services/:id              update
DELETE /api/services/:id              remove
POST   /api/services/:id/start        start (409 if already running)
POST   /api/services/:id/stop         stop (graceful SIGTERM, 5s → SIGKILL)
POST   /api/services/:id/restart      restart
POST   /api/services/restart-all      restart everything
GET    /api/services/:id/logs?n=200   live log tail (ring buffer, last 500 lines)
GET    /api/uptime?n=60               health-check history + uptime % per service
GET    /api/monitoring                network history + watchdog config
GET    /api/events?limit=100          event history (crashes, restarts, outages)
GET    /api/apikeys                   list keys (hashed; only prefixes shown)
POST   /api/apikeys                   create key → raw key returned exactly once
DELETE /api/apikeys/:id               revoke/delete
GET    /api/schedules                 list scheduled tasks
POST   /api/schedules                 {serviceId, action, intervalMin | atTime}
DELETE /api/schedules/:id
GET    /api/notifications             config (webhook masked)
POST   /api/notifications             {termuxEnabled, discordWebhook}
POST   /api/notifications/test        send test notification
GET    /api/settings                  settings
POST   /api/settings                  {net_endpoint}
POST   /api/backup                    DB backup (keeps last 10)
GET    /api/backups                   list backups
GET    /api/export/services?env=0     export configs (secrets excluded by default)
GET    /api/audit                     audit log
POST   /api/password                  change password (revokes all sessions)
POST   /api/console                   restricted diagnostics, localhost only,
                                      allowlist: overview, ps, disk, net, uptime
GET    /api/health                    public, minimal info
```

Example:

```bash
KEY=ktermux_xxxx   # create one in Dashboard → API
curl -s -H "x-api-key: $KEY" http://127.0.0.1:7777/api/status
```

## How the watchdog works

1. Every 15s each running service is checked: is the PID alive, and (if a
   **Health URL** is configured) does the URL respond within 5s?
2. 2+ consecutive health-check failures → forced restart (configurable).
3. Any crash (non-zero exit / bad signal) without a manual stop triggers an
   automatic restart with **exponential backoff** (5s → 5min).
4. Restart attempts are limited (default 10 per 10-minute window per service).
   Beyond the limit the service is marked `crashed` and left for manual
   intervention — no infinite restart loops.
5. Every restart, crash, recovery and outage is recorded in the database and
   pushed live to the dashboard and (optionally) to notifications.

## Android keep-alive (read this honestly)

**A phone cannot guarantee 24/7 uptime.** These events can and will interrupt
service, and no app can prevent them:

- **Force-stop / swipe-away** of Termux by the user or the system
- **Battery optimization** killing background apps
- **Device reboot** (mitigated by Termux:Boot)
- **Overheating** thermal shutdowns, **power loss**, **network changes**

What the system does to maximize reliability:

- `termux-wake-lock` (taken by `start.sh`, released on stop)
- Termux:Boot integration via `setup-boot.sh` → autostart after reboot
- Stale-PID detection: after a Termux restart, old "running" states are
  cleaned and `autostart` services are relaunched — no duplicate processes
- Graceful shutdown on SIGTERM/SIGINT (children stopped, state persisted)
- Log rotation (2 MB × 3 files server log, 1 MB × 2 per service) — no
  unbounded growth
- Battery-optimization guidance in `install.sh`

Recommended Android settings: disable battery optimization for Termux,
allow background activity, install **Termux:Boot** and **Termux:API** from the
same source as Termux, and open Termux:Boot once after install.

## Remote access (secure)

Do **not** port-forward the dashboard to the internet. Instead:

- **Cloudflare Tunnel:** `cloudflared tunnel --url http://127.0.0.1:7777`
  (works in Termux via `pkg install cloudflared`)
- **Tailscale/VPN:** install Tailscale in Termux and access the dashboard
  over the tailnet
- **SSH tunnel:** `ssh -L 7777:127.0.0.1:7777 phone` from another device

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE port 7777` | Already running — `bash status.sh`, or `bash stop.sh` first |
| Dashboard shows "offline" websocket | Log in again; session may have expired |
| Service won't start | Check its Logs tab; verify the command exists (`command -v node`) |
| Service keeps restarting | Check crash reason in Logs; raise `maxRestarts` only after fixing the cause |
| No CPU/RAM per service | Some Android kernels restrict `/proc` — metric is labeled n/a |
| No battery data | Install Termux:API app + `pkg install termux-api` |
| No notifications | Same as above; also toggle the channel in Dashboard → Notify |
| Forgot password | Delete `data/k-termux.db*` and re-run `node src/index.js --init` (services config is lost; back up first) |
| After reboot nothing runs | Run `bash setup-boot.sh`; open the Termux:Boot app once; check battery settings |

## Security notes

- Passwords hashed with **scrypt** (built-in `crypto`), sessions in SQLite
  with expiry, `HttpOnly` cookies, `SameSite=Lax`
- **Direct access mode (optional):** Dashboard → Security → *Skip login on
  this phone*. On = opening `http://127.0.0.1:7777/` goes straight in with no
  login. Only localhost is trusted — remote/tunneled access still requires
  login or an API key. Off by default.
- API keys stored **hashed** (SHA-256); raw key shown exactly once at creation
- Rate limits: 240 req/min per IP on the API, 10 login attempts / 15 min
- Audit log for every sensitive action
- Diagnostics console: localhost-only, fixed allowlist, not a shell
- No credentials hardcoded; `.env.example` documents the optional overrides

## Testing

`npm test` boots a real isolated server instance and runs 40 checks:
auth (incl. wrong password, unauthenticated rejection), service
create/start/stop/restart, duplicate-start refusal, live log capture,
crash-loop detection with give-up behavior, watchdog health checks + uptime%,
API keys (incl. no raw-key leakage), schedules, webhook validation, backup,
export-without-secrets, allowlisted console, and persistence across a full
app restart (including stale-PID cleanup). Current result: **40 passed, 0 failed**.
