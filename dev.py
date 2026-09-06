#!/usr/bin/env python3
"""Static file server for local development.

The hub is a static site now — there is no backend to run. This exists only so
the pages are served over http:// rather than file://, which Google sign-in and
ES modules both require.

Port 5173 is the default deliberately: it is Vite's, which means it is almost
certainly already listed under "Authorized JavaScript origins" on the OAuth
client this project shares with _PGHubTech. Serving from an unregistered origin
makes Google reject the sign-in popup with origin_mismatch.

Run:  python3 dev.py          then open http://localhost:5173/
      python3 dev.py 5174     (must also be a registered origin)
"""
import errno
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "5173"))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # Everything here is edited live; never serve a stale module.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def do_GET(self):
        if self.path == "/favicon.ico":
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        return super().do_GET()

    def log_message(self, fmt, *args):
        # Quiet the per-asset noise; surface only failures.
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("  %s %s\n" % (args[1], args[0]))


if __name__ == "__main__":
    HTTPServer.allow_reuse_address = True
    try:
        httpd = HTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
        sys.exit(
            f"\n  Port {PORT} is already in use — something else is serving on it.\n"
            f"  Pick another with:  python3 dev.py <port>\n"
            f"  Remember to add http://localhost:<port> to the OAuth client's\n"
            f"  authorized JavaScript origins, or Google will refuse sign-in.\n"
        )
    print(f"  SysDsgHub  →  http://localhost:{PORT}/")
    print("  (sign in with the Google account that owns the Drive folder)\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.")
