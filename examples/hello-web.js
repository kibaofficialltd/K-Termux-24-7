// K Termux 24/7 - example service #1: tiny web server with built-in health endpoint
// Register it in the dashboard:
//   Name: hello-web   Group: APIs   Command: node
//   Arguments (one per line):  examples/hello-web.js   3457
//   Health URL: http://127.0.0.1:3457/health
//   Start automatically: yes
'use strict';
const http = require('http');
const port = parseInt(process.argv[2], 10) || 3457;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', uptimeSec: Math.round(process.uptime()) }));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h1>Hello from K Termux 24/7!</h1><p>This service is managed by your dashboard.</p>');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`hello-web listening on http://127.0.0.1:${port} (health: /health)`);
});

// graceful shutdown
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
