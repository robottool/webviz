/**
 * WebViz desktop (Electron) entry point.
 *
 * Runs the hub (WebSocket broker + HTTP/asset server) *in-process* and opens a
 * native window pointed at it, so the whole stack ships as one double-clickable
 * app — no terminal, no separate Node install (Electron bundles its own).
 *
 * The hub server code is bundled into this file by esbuild; the built webapp
 * (packages/app/dist) is copied alongside as a resource and served by the hub.
 */

import { app, BrowserWindow, shell, dialog } from 'electron';
import path from 'node:path';
import { startHub, type RunningHub } from '@webviz/hub';

// Fixed local ports (the in-window app auto-connects to ws://localhost:7777).
const WS_PORT = 7777;
const HTTP_PORT = 8080;
const APP_URL = `http://localhost:${HTTP_PORT}`;

let hub: RunningHub | null = null;
let mainWindow: BrowserWindow | null = null;

/** Where the built webapp lives: packaged → under resources/app-dist; dev →
 * the monorepo's packages/app/dist (this file builds to packages/desktop/build).*/
function webDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app-dist')
    : path.join(__dirname, '..', '..', 'app', 'dist');
}

async function ensureHub(): Promise<void> {
  if (hub) return;
  const dir = webDir();
  hub = await startHub({
    wsPort: WS_PORT,
    httpPort: HTTP_PORT,
    webDir: dir,
    // We no longer bundle robot descriptions (meshes load online); point the
    // /assets root at the app build so its own bundle still resolves.
    assetsDir: dir,
    dataDir: path.join(app.getPath('userData'), 'layouts'),
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'WebViz',
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Open target=_blank / external links in the OS browser, not a child window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost')) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(APP_URL);
}

async function start(): Promise<void> {
  try {
    await ensureHub();
  } catch (err) {
    dialog.showErrorBox(
      'WebViz failed to start',
      `Could not start the local hub on port ${HTTP_PORT}/${WS_PORT}.\n\n` +
        `${String(err)}\n\nIs another WebViz instance (or something on those ports) already running?`,
    );
    app.quit();
    return;
  }
  createWindow();
}

// One instance only — a second launch focuses the existing window instead of
// spinning up a second hub that would fail to bind the ports.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(start);

  app.on('activate', () => {
    // macOS: re-create a window when the dock icon is clicked and none are open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    void hub?.close();
    hub = null;
  });
}
