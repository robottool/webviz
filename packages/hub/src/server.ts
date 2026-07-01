/**
 * Programmatic hub entry point. Starts the WebSocket broker + HTTP asset/REST
 * server and returns a handle so an embedding host (the CLI in `main.ts`, or any
 * in-process host) can run and later shut down the hub. Keeping the wiring here —
 * rather than at module top-level — is what lets a host start the hub in-process
 * with custom paths instead of shelling out to a CLI.
 */

import { Broker } from './broker.js';
import { createAssetServer } from './asset_server.js';

export interface HubOptions {
  /** WebSocket broker port (sources + clients). Default 7777. */
  wsPort?: number;
  /** HTTP asset/REST port (also serves the built app). Default 8080. */
  httpPort?: number;
  /** Built webapp dir (packages/app/dist) served as the app + at /assets fallback. */
  webDir: string;
  /** Asset root for /assets/* (URDF/meshes); resolved before the app bundle. */
  assetsDir: string;
  /** Directory layouts are persisted under. */
  dataDir: string;
  /** CORS allow-origin; '*' when omitted. */
  allowedOrigins?: string;
}

export interface RunningHub {
  wsPort: number;
  httpPort: number;
  /** Close both servers (idempotent enough for process teardown). */
  close(): Promise<void>;
}

/** Start the hub and resolve once the HTTP server is listening. Rejects if the
 * HTTP port can't be bound (e.g. already in use). */
export function startHub(opts: HubOptions): Promise<RunningHub> {
  const wsPort = opts.wsPort ?? 7777;
  const httpPort = opts.httpPort ?? 8080;

  const broker = new Broker({ port: wsPort });
  const httpServer = createAssetServer({
    broker,
    webDir: opts.webDir,
    assetsDir: opts.assetsDir,
    dataDir: opts.dataDir,
    allowedOrigins: opts.allowedOrigins,
  });

  return new Promise<RunningHub>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(httpPort, () => {
      httpServer.removeListener('error', reject);
      resolve({
        wsPort,
        httpPort,
        close: () =>
          new Promise<void>((done) => {
            broker.close();
            httpServer.close(() => done());
          }),
      });
    });
  });
}
