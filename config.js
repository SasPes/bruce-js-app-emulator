// Deployment settings, loaded before app.js.
//
// serverProxy: true  - the host provides /proxy (start-server.py or the Cloudflare worker.js),
//                      so the "HTTP: proxy" option is offered.
// serverProxy: false - purely static hosting (GitHub Pages, S3, ...); there is no /proxy, so the
//                      option is hidden. "HTTP: direct" and "HTTP: Corsfix" still work.
window.EMULATOR_CONFIG = {
  serverProxy: false
};
