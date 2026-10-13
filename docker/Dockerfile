# Build from the repository root:
#   docker build -f docker/Dockerfile -t bruce-js-emulator .
FROM python:3.12-slim

# Only the files the emulator needs at runtime (no docs, screenshots or git data).
WORKDIR /app
COPY start-server.py index.html favicon.ico style.css config.js devices.js app.js \
     emulator-worker.js pixel-renderer.js ./

# The container always provides /proxy, so enable the "HTTP: proxy" option whatever the
# repository's config.js says (it may be set to false for static hosting).
RUN sed -i 's/serverProxy: *false/serverProxy: true/' config.js  && grep -q 'serverProxy: true' config.js

# start-server.py serves the emulator with the cross-origin isolation headers it needs and
# provides the /proxy endpoint. Listen on all interfaces so the published port is reachable.
ENV HOST=0.0.0.0 \
    PORT=8080 \
    PYTHONUNBUFFERED=1
EXPOSE 8080

RUN useradd --system --no-create-home emulator
USER emulator

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ['PORT'] + '/')" || exit 1

CMD ["python", "start-server.py"]
