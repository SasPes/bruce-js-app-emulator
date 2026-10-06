from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os


class EmulatorRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(Path(__file__).resolve().parent)
    print("Bruce LILYGO T-Embed CC1101 emulator: http://localhost:8080")
    ThreadingHTTPServer(("127.0.0.1", 8080), EmulatorRequestHandler).serve_forever()
