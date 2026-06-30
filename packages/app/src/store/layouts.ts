/**
 * Layout (workspace) persistence (§8 LayoutManager, §5 REST API).
 *
 * Two tiers, matching the design:
 *   - localStorage: a per-browser copy of the *current* workspace, auto-restored
 *     on reload (the hydrate/persist lives in tabs.store to avoid an import cycle).
 *   - the hub `/api/layouts` REST API: named, shared layouts that survive across
 *     browsers and restarts. The hub is the shared source of truth.
 *
 * A saved layout is a WorkspaceConfig. Loading restores the tabs/active tab; the
 * connection URL is saved for completeness but NOT re-applied (loading a layout
 * shouldn't yank your live hub connection).
 */

import {
  useTabStore,
  sanitizeSplit,
  gcPanels,
  type TabConfig,
  type SplitState,
} from './tabs.store.js';
import { useConnectionStore } from './connection.store.js';

export interface WorkspaceConfig {
  version: string;
  tabs: TabConfig[];
  /** Pre-pivot layouts also carried `activeTabId`; ignored on load now. */
  activeTabId?: string;
  split?: SplitState;
  connection?: { url: string };
}

export function serializeWorkspace(): WorkspaceConfig {
  const { tabs, split } = useTabStore.getState();
  const { url } = useConnectionStore.getState();
  return { version: '2', tabs, split, connection: { url } };
}

/** Replace the live workspace with a saved one. Returns false if unusable. */
export function applyWorkspace(cfg: WorkspaceConfig | null | undefined): boolean {
  if (!cfg || typeof cfg !== 'object') return false;
  const pool = Array.isArray(cfg.tabs) ? cfg.tabs : [];
  // Old layouts predate split → sanitizeSplit defaults to a single pane; gc
  // drops any panels no pane owns (pre-pivot background tabs).
  const split = sanitizeSplit(cfg.split, pool);
  useTabStore.setState({ tabs: gcPanels(pool, split.root), split });
  return true;
}

// --- named layouts via the hub (relative /api so the Vite dev proxy and the
// hub-served prod build both resolve it) ---

export async function listLayouts(): Promise<string[]> {
  const r = await fetch('/api/layouts');
  if (!r.ok) throw new Error(`list failed: ${r.status}`);
  const j = (await r.json()) as { layouts?: string[] };
  return j.layouts ?? [];
}

export async function saveLayout(name: string): Promise<void> {
  const r = await fetch('/api/layouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, layout: serializeWorkspace() }),
  });
  if (!r.ok) throw new Error(`save failed: ${r.status}`);
}

export async function loadLayout(name: string): Promise<boolean> {
  const r = await fetch(`/api/layouts/${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`load failed: ${r.status}`);
  return applyWorkspace((await r.json()) as WorkspaceConfig);
}

export async function deleteLayout(name: string): Promise<void> {
  const r = await fetch(`/api/layouts/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!r.ok) throw new Error(`delete failed: ${r.status}`);
}
