// Dummy service used by K Termux 24/7 automated tests.
// Modes: serve (default) - tiny HTTP server; crash - exits with code 1 immediately.
'use strict';
const http = require('http');
const mode = process.argv[2] || 'serve';

if (mode === 'crash') {
  console.log('dummy: crashing on purpose');
  process.exit(1);
}

const port = parseInt(process.env.DUMMY_PORT, 10) || 3457;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('k-termux-dummy-ok');
});
server.listen(port, '127.0.0.1', () => {
  console.log(`dummy listening on ${port}`);
});
setInterval(() => {}, 60000); // keep alive
