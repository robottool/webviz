/**
 * HTTP server (§5 endpoint summary): serves the built webapp + assets and the
 * REST API for channels, layouts, and one-shot data injection. Implemented with
 * the Node `http` module to keep the hub dependency-light (~the doc's "~300
 * lines, minimal footprint" goal).
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Broker } from './broker.js';
import { SessionStore } from './session_store.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.urdf': 'application/xml',
  '.dae': 'model/vnd.collada+xml',
  '.glb': 'model/gltf-binary',
  '.stl': 'model/stl',
};

export interface AssetServerOptions {
  broker: Broker;
  webDir: string; // built webapp (packages/app/dist)
  assetsDir: string; // URDF / meshes
  dataDir: string; // saved layouts
  allowedOrigins?: string; // CORS, "*" by default
}

export function createAssetServer(opts: AssetServerOptions): http.Server {
  const store = new SessionStore(opts.dataDir);
  const cors = opts.allowedOrigins ?? '*';

  return http.createServer(async (req, res) => {
    const setCors = () => {
      res.setHeader('Access-Control-Allow-Origin', cors);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    };
    setCors();
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;

    try {
      // --- REST API ---
      if (pathname === '/api/channels' && req.method === 'GET') {
        return json(res, 200, {
          channels: opts.broker.registry.list(),
          stats: opts.broker.stats(),
        });
      }

      if (pathname === '/api/layouts' && req.method === 'GET') {
        return json(res, 200, { layouts: await store.list() });
      }

      const layoutMatch = pathname.match(/^\/api\/layouts\/([^/]+)$/);
      if (layoutMatch) {
        const name = decodeURIComponent(layoutMatch[1]);
        if (req.method === 'GET') {
          const layout = await store.get(name);
          return layout
            ? json(res, 200, layout)
            : json(res, 404, { error: 'not found' });
        }
        if (req.method === 'DELETE') {
          const ok = await store.delete(name);
          return json(res, ok ? 200 : 404, { deleted: ok });
        }
      }

      if (pathname === '/api/layouts' && req.method === 'POST') {
        const body = (await readJson(req)) as { name?: string; layout?: unknown };
        if (!body.name) return json(res, 400, { error: 'name required' });
        await store.save(body.name, body.layout ?? {});
        return json(res, 200, { saved: body.name });
      }

      if (pathname === '/api/inject' && req.method === 'POST') {
        const body = (await readJson(req)) as {
          channel?: string;
          schema?: string;
          data?: unknown;
          source_id?: string;
          timestamp?: number;
          latched?: boolean;
        };
        if (!body.channel || !body.schema) {
          return json(res, 400, { error: 'channel and schema required' });
        }
        opts.broker.injectJson(
          body.source_id ?? 'http',
          body.channel,
          body.schema,
          body.timestamp ?? Date.now() / 1000,
          body.data ?? {},
          body.latched ?? false,
        );
        return json(res, 200, { injected: true });
      }

      // --- assets ---
      // The `/assets/` prefix is shared by two roots: robot descriptions and
      // meshes (assetsDir) and the built app's own bundle, which Vite also
      // emits under `/assets/` (webDir/assets/*). Resolve assetsDir first, then
      // fall back to the app bundle, so neither shadows the other.
      if (pathname.startsWith('/assets/')) {
        const rel = pathname.slice('/assets/'.length);
        if (await tryServeFile(res, opts.assetsDir, rel)) return;
        if (await tryServeFile(res, opts.webDir, path.join('assets', rel))) return;
        return json(res, 404, { error: 'not found' });
      }

      // --- static webapp (SPA fallback to index.html) ---
      if (req.method === 'GET') {
        const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
        const served = await tryServeFile(res, opts.webDir, rel);
        if (served) return;
        // SPA fallback
        const fallback = await tryServeFile(res, opts.webDir, 'index.html');
        if (fallback) return;
        return text(
          res,
          200,
          'WebViz hub is running. Build the app (pnpm --filter @webviz/app build) to serve it here.',
        );
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function text(res: http.ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/** Resolve `rel` under `root`, refusing path traversal. */
function safeResolve(root: string, rel: string): string | null {
  const resolved = path.resolve(root, rel);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    return null;
  }
  return resolved;
}

async function tryServeFile(
  res: http.ServerResponse,
  root: string,
  rel: string,
): Promise<boolean> {
  const file = safeResolve(root, rel);
  if (!file) return false;
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}
