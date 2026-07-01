/**
 * Hub CLI entry point. Starts the WebSocket broker (:7777) and the HTTP
 * asset/REST server (:8080) with env-overridable paths/ports. The actual wiring
 * lives in `server.ts`'s `startHub()` so it can also be embedded in-process.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHub } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

startHub({
  wsPort: Number(process.env.WEBVIZ_WS_PORT ?? 7777),
  httpPort: Number(process.env.WEBVIZ_HTTP_PORT ?? 8080),
  webDir: process.env.WEBVIZ_WEB_DIR ?? path.join(repoRoot, 'packages/app/dist'),
  // Defaults to the repo root so any bundled assets are reachable at
  // /assets/<dir>/... out of the box; override in production.
  assetsDir: process.env.WEBVIZ_ASSETS_DIR ?? repoRoot,
  dataDir: process.env.WEBVIZ_DATA_DIR ?? path.join(repoRoot, 'data/layouts'),
  allowedOrigins: process.env.ALLOWED_ORIGINS,
}).then((hub) => {
  console.log(`[webviz-hub] WebSocket broker  ws://localhost:${hub.wsPort}`);
  console.log(`[webviz-hub] HTTP/asset server http://localhost:${hub.httpPort}`);
});
