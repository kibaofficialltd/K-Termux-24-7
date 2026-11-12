#!/data/data/com.termux/files/usr/bin/env python
# K Termux 24/7 - example service #2: Python bot skeleton with built-in health endpoint
# Register it in the dashboard:
#   Name: py-bot   Group: Bots   Command: python
#   Arguments (one per line):  examples/py-bot.py   3458
#   Health URL: http://127.0.0.1:3458/health
#
# Put your real bot logic inside run_bot() below.
import sys
import threading
import time
import http.server
from http.server import BaseHTTPRequestHandler

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3458
START = time.time()


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            body = f'{{"status":"ok","uptimeSec":{int(time.time() - START)}}}'.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'py-bot is alive')

    def log_message(self, *args):
        pass  # keep the dashboard log clean


def start_health_server():
    server = http.server.HTTPServer(('127.0.0.1', PORT), HealthHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f'py-bot health endpoint on http://127.0.0.1:{PORT}/health')


def run_bot():
    # ===== your real bot logic goes here =====
    while True:
        print('py-bot is doing bot things...')
        time.sleep(30)


if __name__ == '__main__':
    start_health_server()
    try:
        run_bot()
    except KeyboardInterrupt:
        pass
