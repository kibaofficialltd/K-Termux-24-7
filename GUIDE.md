# K Termux 24/7 — The Complete Guide

Everything from zero to a fully working personal server on your Android phone.
No steps skipped. Copy-paste everything.

---

## Contents

1. [Install](#1-install)
2. [Open the dashboard](#2-open-the-dashboard)
3. [Understand the tabs](#3-understand-the-tabs)
4. [Add your first service (full walkthrough)](#4-add-your-first-service)
5. [Health URLs — the complete chapter](#5-health-urls)
6. [Commands to find & test health URLs](#6-commands-to-find-and-test-health-urls)
7. [Register services with commands only (no dashboard)](#7-register-services-with-commands)
8. [Real examples: bots, APIs, Python, AI agents](#8-real-examples)
9. [Make it run 24/7](#9-make-it-run-247)
10. [Keep it healthy: watchdog rules](#10-watchdog-rules)
11. [Remote access from another device](#11-remote-access)
12. [Troubleshooting — every common problem](#12-troubleshooting)

---

## 1. Install

Open Termux and paste **one** command:

```bash
pkg install -y git nodejs && git clone https://github.com/kibaofficialltd/K-Termux-24-7.git && cd K-Termux-24-7 && bash install.sh && termux-wake-lock
```

What happens automatically:
- installs git + Node.js (if missing)
- downloads the project
- installs the 2 npm packages (express + ws)
- creates the SQLite database
- creates a hidden recovery admin (saved in `data/credentials.txt`, only needed if you ever enable login)
- starts the server
- verifies everything works

**Nothing is asked. No username. No password.**

---

## 2. Open the dashboard

Open any browser **on the same phone**:

```
http://127.0.0.1:7777/
```

It opens directly — no login screen. (Direct access only works on the phone itself; remote connections still need credentials.)

---

## 3. Understand the tabs

| Tab | What it shows |
|---|---|
| **Overview** | Running/stopped counts, app uptime, CPU, RAM, network status, recent events |
| **Processes** | Your services — add, start, stop, restart, edit, delete, live logs |
| **Uptime** | Health-check history bars + uptime % per service |
| **Network** | Internet connectivity, latency chart |
| **API** | API keys for scripts/automation + endpoint list |
| **System** | Phone CPU, RAM, battery (Termux:API), per-service CPU/RAM |
| **Logs** | Server log + per-service logs, follow mode |
| **Notify** | Android notifications (Termux:API) + Discord webhook |
| **Settings** | Connectivity endpoint, scheduled tasks, backups, export, diagnostics console |
| **Security** | Direct-access toggle, change password, audit log |

---

## 4. Add your first service

**Processes tab → + Add service**

| Field | Meaning |
|---|---|
| Name | Any label, e.g. `hello-web` |
| Group | Bots / APIs / AI Agents / Minecraft / Other (for organizing) |
| Command | The program only: `node`, `python`, `bash` — never a whole shell string |
| Arguments | Each argument on its own line |
| Working directory | Where your project lives, e.g. `/data/data/com.termux/files/home/mybot` |
| Environment variables | `KEY=value` per line, e.g. `PORT=3000` |
| Health URL | Optional — see chapter 5 |
| Start automatically | Starts again after Termux/phone restarts |
| Max restarts / window | Crash-loop protection (default 10 in 10 min) |

### Ready-made example #1 (already inside the repo!)

| Field | Value |
|---|---|
| Name | `hello-web` |
| Group | APIs |
| Command | `node` |
| Arguments | `examples/hello-web.js` ⏎ `3457` |
| Health URL | `http://127.0.0.1:3457/health` |
| Start automatically | ✅ |

Save → **Start** → green status with a PID. Open `http://127.0.0.1:3457/` in the browser to see it working.

### Ready-made example #2 (Python)

| Field | Value |
|---|---|
| Name | `py-bot` |
| Group | Bots |
| Command | `python` |
| Arguments | `examples/py-bot.py` ⏎ `3458` |
| Health URL | `http://127.0.0.1:3458/health` |

---

## 5. Health URLs

A Health URL is your service's own web address. The watchdog opens it every
15 seconds — if it answers within 5s, the service counts as healthy. If it
fails 2-3 times in a row, the watchdog restarts the service.

### 5.1 Which services need one?

| Your service | Health URL needed? |
|---|---|
| Web server, API, panel, website | ✅ Use its own address |
| Discord/WhatsApp bot with no web part | ❌ Leave empty (process check is enough) |
| Script you want "deep" monitoring on | ✅ Add a tiny health endpoint (below) |

### 5.2 If your service already listens on a port

Just use it. Common patterns:

```
http://127.0.0.1:3000/          # most web apps
http://127.0.0.1:3000/health    # if it has a health route
http://127.0.0.1:5000/          # Flask default
http://127.0.0.1:8000/          # FastAPI / Django default
http://127.0.0.1:8080/          # common alt port
```

Test it in the phone browser first — **anything** that loads (even the app's
own error page) counts as a valid health URL.

### 5.3 If your script has no web server — add 2 lines

**Node.js** — add at the top of your bot's main file:

```js
require('http').createServer((q, s) => s.end('ok')).listen(3457);
```

**Python** — add near the top:

```python
import http.server, threading
threading.Thread(target=http.server.HTTPServer(('127.0.0.1', 3457),
    http.server.SimpleHTTPRequestHandler).serve_forever, daemon=True).start()
```

Then Health URL = `http://127.0.0.1:3457/`

**Bash script** — easiest: make the script a Node wrapper, or use the
one-line trick from chapter 6.4.

### 5.4 The rules

- Always `127.0.0.1` (local) — never your public IP
- **Every service needs its own port** (3457, 3458, 3459, …)
- Response must come within 5 seconds; any 200–399 reply = healthy
- Wrong URL → the watchdog will force-restart your service — test first!

---

## 6. Commands to find and test health URLs

All inside Termux. These are for when you want to check things quickly
from the command line.

### 6.1 Test a health URL (the #1 command)

```bash
curl -s http://127.0.0.1:3457/health
```

- Prints the response → URL works ✅
- `curl: (7) Failed to connect` → nothing listening on that port ❌
- Add `-w "\nHTTP %{http_code} in %{time_total}s\n"` to see code + speed:

```bash
curl -s -w "\nHTTP %{http_code} in %{time_total}s\n" http://127.0.0.1:3457/health
```

### 6.2 Find which ports your services already use

```bash
pkg install -y iproute2     # once
ss -tlnp | grep node        # all node ports
ss -tlnp | grep python      # all python ports
ss -tlnp                    # everything listening
```

Any port in the output → `http://127.0.0.1:THAT_PORT/` is a candidate
health URL.

### 6.3 Ask the dashboard itself (API way)

```bash
curl -s http://127.0.0.1:7777/api/services
```

Shows every registered service with its `healthUrl`, status, PID, ports.

### 6.4 Give ANY project a health URL with one command (no code changes)

If your project has no web server and you don't want to edit its files, run
this tiny sidecar server as a separate service — it just proves the phone
and port are alive:

```bash
node -e "require('http').createServer((q,s)=>s.end('ok')).listen(3459)"
```

But the better way — a sidecar that pings your real service:

```bash
# Register this as a service named "health-sidecar":
# Command: node  Arguments: -e ⏎ (the line below)
require('http').createServer((q,s)=>{require('http').get('http://127.0.0.1:TARGET_PORT/',r=>s.end('up:'+r.statusCode)).on('error',()=>{s.writeHead(500);s.end('down')})}).listen(3459)
```

Replace `TARGET_PORT` with your bot's actual port. Health URL =
`http://127.0.0.1:3459/` — it answers "up:200" only when your real bot
answers too.

### 6.5 Check a service's logs from the terminal

```bash
tail -f ~/K-Termux-24-7/data/logs/hello-web-1.log
```

---

## 7. Register services with commands

Everything the dashboard does, the API does too — useful for automation.

### 7.1 Register a service

```bash
curl -s -X POST http://127.0.0.1:7777/api/services \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "hello-web",
    "group": "APIs",
    "command": "node",
    "args": ["examples/hello-web.js", "3457"],
    "healthUrl": "http://127.0.0.1:3457/health",
    "autostart": true
  }'
```

### 7.2 Control it

```bash
curl -s -X POST http://127.0.0.1:7777/api/services/1/start
curl -s -X POST http://127.0.0.1:7777/api/services/1/stop
curl -s -X POST http://127.0.0.1:7777/api/services/1/restart
curl -s http://127.0.0.1:7777/api/services/1/logs?n=50
curl -s http://127.0.0.1:7777/api/status
```

(The `1` is the service id — find it with `/api/services`.)

### 7.3 Create an API key (for scripts outside the phone)

Dashboard → **API** → **+ New key** → copy the `ktermux_...` key
(shown only once!). Then:

```bash
curl -s -H "x-api-key: ktermux_YOUR_KEY" http://127.0.0.1:7777/api/status
```

---

## 8. Real examples

### 8.1 Node bot living in its own folder

Say your bot is at `~/mybot/index.js` and uses port 3000:

| Field | Value |
|---|---|
| Name | `my-bot` |
| Group | Bots |
| Command | `node` |
| Arguments | `index.js` |
| Working directory | `/data/data/com.termux/files/home/mybot` |
| Health URL | `http://127.0.0.1:3000/` |

### 8.2 Python bot

| Field | Value |
|---|---|
| Command | `python` |
| Arguments | `bot.py` |
| Working directory | `/data/data/com.termux/files/home/mybot` |
| Health URL | empty, or the 2-line trick from 5.3 |

### 8.3 Discord.js bot with token in env

| Field | Value |
|---|---|
| Command | `node` |
| Arguments | `index.js` |
| Environment variables | `DISCORD_TOKEN=your-token` (never commit this!) |
| Health URL | empty (process check only) |

### 8.4 Long-running script with auto-restart on crash

Leave the Health URL empty, keep default restart limits — if it crashes,
the watchdog restarts it with backoff automatically.

---

## 9. Make it run 24/7

A phone cannot promise 100% uptime (force-stop, reboot, heat, battery), but
this is the maximum reliability Android allows:

1. **Wake-lock** (already taken by start.sh, but make it sure):
   ```bash
   termux-wake-lock
   ```
2. **Battery settings** — Android Settings → Apps → **Termux** → Battery →
   **Unrestricted** (also allow "Run in background")
3. **Auto-start after reboot:**
   - Install the **Termux:Boot** app (same source as Termux)
   - Open it once
   - Then:
   ```bash
   cd ~/K-Termux-24-7 && bash setup-boot.sh
   ```
4. **Keep Termux's notification** — swiping it away may kill the session
5. **Charging** — for true 24/7, keep the phone on power
6. **Backups** — Settings tab → "Create backup now" (or `bash backup.sh`)

---

## 10. Watchdog rules

- Process check every **15s**: is the PID alive?
- Health URL check every **15s** (only if set): does it answer in 5s?
- Crash (non-zero exit) → **auto-restart with backoff**: 5s, 10s, 20s… up to 5min
- More than **10 restarts in 10 minutes** → it gives up and marks the
  service `crashed` — fix the real problem, then press Start
- Every crash/restart/recovery is recorded: **Overview → Recent events**

---

## 11. Remote access

The dashboard is localhost-only by design. To reach it from another device:

**Cloudflare Tunnel (easiest):**
```bash
pkg install -y cloudflared
cloudflared tunnel --url http://127.0.0.1:7777
```
→ gives you a public https link. Remote visitors must authenticate, so
first enable login: Dashboard → Security → untick "Skip login" → set a
password there.

**Tailscale / VPN** — private network between your devices.

**Same Wi-Fi:** set `KTERMUX_HOST=0.0.0.0` in `.env`, run `bash restart.sh`,
then others open `http://YOUR_PHONE_IP:7777` — they will be asked for
credentials (localhost-only trust is enforced in code).

⚠️ Never port-forward 7777 to the public internet without a tunnel.

---

## 12. Troubleshooting

| Problem | Fix |
|---|---|
| `bash start.sh` → No such file | You're outside the folder: `cd ~/K-Termux-24-7` first |
| `EADDRINUSE port 7777` | Already running → `bash status.sh`, or `bash stop.sh` then start |
| Dashboard doesn't open | `bash status.sh` — if "NOT running": `bash start.sh` |
| Service won't start | Check its Logs tab; verify command exists: `command -v node` |
| Service keeps restarting | Real crash — read Logs; fix the error; press Start |
| Health bars all red | Wrong Health URL — test with `curl -s URL` |
| "n/a" CPU/RAM/battery | Android restricts /proc, or install Termux:API app + `pkg install termux-api` |
| No notifications | Same as above; toggle channel in Notify tab |
| Forgot/lost login | You don't have one (direct access). If you enabled login and forgot it: delete `data/k-termux.db*`, run `node src/index.js --init`, then `bash restart.sh` |
| After phone reboot nothing runs | `bash setup-boot.sh` + open Termux:Boot once + battery unrestricted |
| Two copies on the phone | Keep one! Delete the other; only one can use port 7777 |
