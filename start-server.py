from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import json
import os
import urllib.error
import urllib.request

DROPPED_RESPONSE_HEADERS = {
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "set-cookie",
}


class EmulatorRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def proxy(self):
        """Relay wifi.httpFetch() requests when "Proxy" is selected; browsers block most cross-origin requests."""
        target = (parse_qs(urlparse(self.path).query).get("url") or [""])[0]
        if urlparse(target).scheme not in ("http", "https"):
            self.send_error(400, "Invalid url")
            return
        try:
            headers = json.loads(self.headers.get("X-Proxy-Headers") or "{}")
        except ValueError:
            headers = {}
        # Some hosts (e.g. Cloudflare) reject urllib's default User-Agent.
        if not any(name.lower() == "user-agent" for name in headers):
            headers["User-Agent"] = "Mozilla/5.0 (compatible; BruceEmulator)"
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        request = urllib.request.Request(
            target, data=body, headers=headers, method=self.command
        )
        try:
            upstream = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error:
            upstream = error
        except Exception as error:
            print(f"proxy: {target} failed: {error!r}")
            self.send_response(502)
            self.send_header("X-Proxy-Error", "1")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        data = upstream.read()
        self.send_response(
            upstream.status if hasattr(upstream, "status") else upstream.code
        )
        for name, value in upstream.headers.items():
            if name.lower() not in DROPPED_RESPONSE_HEADERS:
                self.send_header(name, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_method(self):
        if urlparse(self.path).path == "/proxy":
            self.proxy()
        elif self.command in ("GET", "HEAD"):
            getattr(SimpleHTTPRequestHandler, "do_" + self.command)(self)
        else:
            self.send_error(405)

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_PATCH = handle_method


if __name__ == "__main__":
    os.chdir(Path(__file__).resolve().parent)
    # HOST/PORT can be overridden, e.g. HOST=0.0.0.0 inside a container.
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8080"))
    print(f"Bruce JS Interpreter emulator: http://{host}:{port}")
    ThreadingHTTPServer((host, port), EmulatorRequestHandler).serve_forever()
