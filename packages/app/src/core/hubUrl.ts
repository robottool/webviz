/**
 * Central hub-URL derivation. Every WebSocket the app opens targets the *same*
 * hub — the client connection (`role=client`), the recording-playback source
 * (`core/player.ts`), and the UI publisher source (`core/sourcePublisher.ts`) —
 * so they all derive host/port/scheme here instead of each hardcoding
 * `ws://<host>:7777`. Centralizing this fixes two bugs the copies had: they
 * hardcoded `ws://` (blocked as mixed content on an HTTPS deploy) and ignored
 * the configured hub URL (so playback / gizmo publishing hit the wrong host).
 *
 * Precedence for the base (scheme + host + port):
 *   1. the persisted ⚙ hub URL (settings.store), if set;
 *   2. the `VITE_HUB_URL` build-time override, if set;
 *   3. auto-derive from the page — same hostname, port 7777, and `wss:` when the
 *      page itself is served over HTTPS (so a TLS deploy isn't blocked as mixed
 *      content).
 * Only the base is taken from the configured URL; the `role`/`id` query is
 * always rebuilt for the specific socket.
 */

import { persistedHubUrl } from '../store/settings.store.js';

const DEFAULT_PORT = '7777';

interface HubBase {
  scheme: 'ws' | 'wss';
  host: string;
  port: string;
}

function pageScheme(): 'ws' | 'wss' {
  return typeof location !== 'undefined' && location.protocol === 'https:'
    ? 'wss'
    : 'ws';
}

function pageHost(): string {
  return typeof location !== 'undefined' && location.hostname
    ? location.hostname
    : 'localhost';
}

/** Parse a configured ws(s):// URL into a base, ignoring its query/path. */
function parseBase(url: string): HubBase | null {
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    return {
      scheme: u.protocol === 'wss:' ? 'wss' : 'ws',
      host: u.hostname,
      port: u.port || DEFAULT_PORT,
    };
  } catch {
    return null;
  }
}

const envHubUrl = (import.meta.env.VITE_HUB_URL as string | undefined) ?? '';

/**
 * @param includePersisted when false the persisted ⚙ setting is ignored — used
 *   for the "blank = auto" target the settings UI offers.
 */
function resolveBase(includePersisted: boolean): HubBase {
  const configured = (includePersisted ? persistedHubUrl() : '') || envHubUrl;
  const parsed = configured ? parseBase(configured) : null;
  return (
    parsed ?? { scheme: pageScheme(), host: pageHost(), port: DEFAULT_PORT }
  );
}

function build(base: HubBase, role: 'client' | 'source', id?: string): string {
  const q = new URLSearchParams({ role });
  if (id) q.set('id', id);
  return `${base.scheme}://${base.host}:${base.port}?${q.toString()}`;
}

/** Client connection URL, honoring the persisted ⚙ setting / env / auto-derive. */
export function hubClientUrl(): string {
  return build(resolveBase(true), 'client');
}

/** The auto-derived client URL used when the ⚙ hub URL is left blank. */
export function autoHubClientUrl(): string {
  return build(resolveBase(false), 'client');
}

/** Source-socket URL (playback replay, UI publisher); same base as the client. */
export function hubSourceUrl(id: string): string {
  return build(resolveBase(true), 'source', id);
}
