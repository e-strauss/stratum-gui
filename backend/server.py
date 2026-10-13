"""Loopback-only optimizer service. Start with the source checkout's Python."""
from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading

from backend.service import MAX_REQUEST_BYTES, run_submission, validate_request, warm_workers


class Server(ThreadingHTTPServer):
    daemon_threads = False

    def __init__(self, port, timeout, worker_context=None):
        super().__init__(("127.0.0.1", port), Handler)
        self.worker_timeout = timeout
        self.worker_context = worker_context
        self.slot = threading.BoundedSemaphore(1)
        self.stopping = threading.Event()

    def server_close(self):
        self.stopping.set()
        super().server_close()


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def respond(self, status, body):
        encoded = json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        self.respond(200 if self.path == "/health" else 404,
                     {"status": "ready"} if self.path == "/health" else {"message": "Not found."})

    def do_POST(self):
        if self.path != "/optimize":
            self.respond(404, {"message": "Not found."})
            return
        # Browsers use the same-origin Next.js proxy; do not expose a CORS API.
        if self.headers.get("Origin") is not None:
            self.respond(403, {"message": "Use the inspector's same-origin API."})
            return
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            self.respond(415, {"message": "Expected application/json."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_REQUEST_BYTES:
                self.respond(413, {"message": "Request must be between 1 byte and 64 KiB."})
                return
            request = validate_request(json.loads(self.rfile.read(length)))
        except (ValueError, UnicodeError):
            self.respond(400, {"message": "Invalid code request or optimizer options."})
            return
        if not self.server.slot.acquire(blocking=False):
            self.respond(429, {"message": "The optimizer is busy. Try again after the current submission finishes."})
            return
        try:
            self.respond(200, run_submission(request, timeout=self.server.worker_timeout,
                                            stopping=self.server.stopping,
                                            worker_context=self.server.worker_context))
        except Exception:
            self.respond(500, {"message": "Could not start or collect the optimizer worker."})
        finally:
            self.server.slot.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3101)
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    if not 0 < args.timeout <= 90:
        parser.error("timeout must be between 0 and 90 seconds")
    print("Loading optimizer dependencies…", flush=True)
    with warm_workers() as worker_context, Server(args.port, args.timeout, worker_context) as server:
        print(f"Optimizer playground backend: http://127.0.0.1:{args.port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
