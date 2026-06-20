/**
 * Hub entry point. Starts the WebSocket broker (:7777) and the HTTP asset/REST
 * server (:8080), wired to share one channel registry.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Broker } from './broker.js';
import { createAssetServer } from './asset_server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

const WS_PORT = Number(process.env.WEBVIZ_WS_PORT ?? 7777);
const HTTP_PORT = Number(process.env.WEBVIZ_HTTP_PORT ?? 8080);

const broker = new Broker({ port: WS_PORT });

const httpServer = createAssetServer({
  broker,
  webDir: process.env.WEBVIZ_WEB_DIR ?? path.join(repoRoot, 'packages/app/dist'),
  // Defaults to the repo root so robot description assets (e.g. ur_description/)
  // are reachable at /assets/<dir>/... out of the box; override in production.
  assetsDir: process.env.WEBVIZ_ASSETS_DIR ?? repoRoot,
  dataDir: process.env.WEBVIZ_DATA_DIR ?? path.join(repoRoot, 'data/layouts'),
  allowedOrigins: process.env.ALLOWED_ORIGINS,
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`[webviz-hub] WebSocket broker  ws://localhost:${WS_PORT}`);
  console.log(`[webviz-hub] HTTP/asset server http://localhost:${HTTP_PORT}`);
});
