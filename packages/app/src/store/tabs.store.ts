/**
 * Tab store (§9.2). Manages the set of tabs and which one is active, plus the
 * workspace **split layout** — a recursive binary tree of panes. Each tab is an
 * independent workspace; the split tree is a view onto that set (leaves bind to
 * existing tab ids, they don't own tabs).
 *
 * A node is either a `leaf` (one pane showing one tab) or a `split` of two
 * children laid out `row` (left|right) or `col` (top/bottom) with a divider at
 * `frac`. `single` mode is just a lone leaf root. Splitting replaces a leaf with
 * a split of [old leaf, new leaf]; closing a leaf replaces its parent split with
 * the surviving sibling, so the twin fills the freed space.
 */

import { create } from 'zustand';
import { uuid } from '../core/uuid.js';

export type TabType = '3d' | 'image' | 'plot' | 'map' | 'inspector' | 'log';

export interface TabConfig {
  id: string;
  name: string;
  type: TabType;
  pinned: boolean;
  icon: string;
  settings: Record<string, unknown>;
}

/** `row` = side-by-side (vertical divider); `col` = stacked (horizontal divider). */
export type SplitDir = 'row' | 'col';

export interface LeafNode {
  type: 'leaf';
  id: string;
  tabId: string | null;
}
export interface SplitBranch {
  type: 'split';
  id: string;
  dir: SplitDir;
  /** Size of child `a` as a fraction of the branch, 0.15–0.85. */
  frac: number;
  a: SplitNode;
  b: SplitNode;
}
export type SplitNode = LeafNode | SplitBranch;

export interface SplitState {
  root: SplitNode;
  /** Leaf id that splits land in / that the focus outline marks. */
  focusedLeaf: string;
}

interface TabStore {
  tabs: TabConfig[];
  activeTabId: string;
  split: SplitState;
  addTab: (type: TabType) => void;
  closeTab: (id: string) => void;
  renameTab: (id: string, name: string) => void;
  pinTab: (id: string, pinned: boolean) => void;
  activateTab: (id: string) => void;
  duplicateTab: (id: string) => void;
  updateSettings: (id: string, patch: Record<string, unknown>) => void;
  newWorkspace: () => void;
  splitPane: (leafId: string, dir: SplitDir) => void;
  closePane: (leafId: string) => void;
  assignPane: (leafId: string, tabId: string | null) => void;
  setSplitFrac: (branchId: string, frac: number) => void;
  focusPane: (leafId: string) => void;
}

export const TAB_META: Record<TabType, { label: string; icon: string }> = {
  '3d': { label: '3D view', icon: '⬡' },
  image: { label: 'Cameras', icon: '🎞' },
  plot: { label: 'Plot', icon: '📈' },
  map: { label: 'Map', icon: '🗺' },
  inspector: { label: 'Inspector', icon: '🔍' },
  log: { label: 'Log', icon: '📋' },
};

const clampFrac = (v: number) => Math.min(0.85, Math.max(0.15, v));

function makeTab(type: TabType): TabConfig {
  return {
    id: uuid(),
    name: TAB_META[type].label,
    type,
    pinned: false,
    icon: TAB_META[type].icon,
    settings: {},
  };
}

// --- split-tree helpers (pure, immutable) ---

function makeLeaf(tabId: string | null): LeafNode {
  return { type: 'leaf', id: uuid(), tabId };
}

function leafIds(node: SplitNode, out: string[] = []): string[] {
  if (node.type === 'leaf') out.push(node.id);
  else {
    leafIds(node.a, out);
    leafIds(node.b, out);
  }
  return out;
}

function mapLeaves(node: SplitNode, fn: (l: LeafNode) => LeafNode): SplitNode {
  if (node.type === 'leaf') return fn(node);
  return { ...node, a: mapLeaves(node.a, fn), b: mapLeaves(node.b, fn) };
}

/** Replace the target leaf with a split of [original leaf, new leaf]. */
function splitLeafNode(
  node: SplitNode,
  leafId: string,
  dir: SplitDir,
  fresh: LeafNode,
): SplitNode {
  if (node.type === 'leaf') {
    if (node.id !== leafId) return node;
    return { type: 'split', id: uuid(), dir, frac: 0.5, a: node, b: fresh };
  }
  return {
    ...node,
    a: splitLeafNode(node.a, leafId, dir, fresh),
    b: splitLeafNode(node.b, leafId, dir, fresh),
  };
}

/** Remove a leaf; its parent collapses to the sibling. null = removed the root. */
function removeLeafNode(node: SplitNode, leafId: string): SplitNode | null {
  if (node.type === 'leaf') return node.id === leafId ? null : node;
  const a = removeLeafNode(node.a, leafId);
  if (a === null) return node.b; // child a *was* the leaf → sibling fills
  const b = removeLeafNode(node.b, leafId);
  if (b === null) return node.a;
  return { ...node, a, b };
}

function setFracNode(node: SplitNode, branchId: string, frac: number): SplitNode {
  if (node.type === 'leaf') return node;
  if (node.id === branchId) return { ...node, frac };
  return {
    ...node,
    a: setFracNode(node.a, branchId, frac),
    b: setFracNode(node.b, branchId, frac),
  };
}

function defaultSplit(tabId: string): SplitState {
  const leaf = makeLeaf(tabId);
  return { root: leaf, focusedLeaf: leaf.id };
}

/** A tab id currently shown in no pane (for seeding a fresh split), or fallback. */
function unusedTab(
  root: SplitNode,
  tabs: TabConfig[],
  fallback: string,
): string {
  const shown = new Set(
    leafIds(root)
      .map((id) => findLeaf(root, id)?.tabId)
      .filter(Boolean) as string[],
  );
  return tabs.find((t) => !shown.has(t.id))?.id ?? fallback;
}

function findLeaf(node: SplitNode, id: string): LeafNode | null {
  if (node.type === 'leaf') return node.id === id ? node : null;
  return findLeaf(node.a, id) ?? findLeaf(node.b, id);
}

// Per-browser persistence of the current workspace, so a reload restores your
// tabs instead of resetting to a fresh Inspector. (Named/shared layouts go
// through the hub in store/layouts.ts; this is just the local working copy.)
const LS_KEY = 'webviz.workspace';

/** Validate a persisted/loaded split against the current tabs (drop stale ids,
 *  clamp fracs, regen missing node ids). Unknown shapes → single mode. */
export function sanitizeSplit(
  raw: unknown,
  tabs: TabConfig[],
  activeTabId: string,
): SplitState {
  const valid = new Set(tabs.map((t) => t.id));
  interface RawNode {
    type?: string;
    id?: unknown;
    tabId?: unknown;
    dir?: unknown;
    frac?: unknown;
    a?: unknown;
    b?: unknown;
  }
  const clean = (node: unknown): SplitNode | null => {
    if (!node || typeof node !== 'object') return null;
    const n = node as RawNode;
    if (n.type === 'leaf') {
      const tabId =
        typeof n.tabId === 'string' && valid.has(n.tabId) ? n.tabId : null;
      return { type: 'leaf', id: typeof n.id === 'string' ? n.id : uuid(), tabId };
    }
    if (n.type === 'split') {
      const a = clean(n.a);
      const b = clean(n.b);
      if (!a || !b) return a ?? b; // drop a broken side, keep the other
      return {
        type: 'split',
        id: typeof n.id === 'string' ? n.id : uuid(),
        dir: n.dir === 'col' ? 'col' : 'row',
        frac:
          typeof n.frac === 'number' && n.frac >= 0.15 && n.frac <= 0.85
            ? n.frac
            : 0.5,
        a,
        b,
      };
    }
    return null;
  };
  const root =
    raw && typeof raw === 'object'
      ? clean((raw as { root?: unknown }).root)
      : null;
  if (!root) return defaultSplit(activeTabId);
  const ids = leafIds(root);
  const wanted = (raw as { focusedLeaf?: string }).focusedLeaf;
  const focusedLeaf = wanted && ids.includes(wanted) ? wanted : ids[0];
  return { root, focusedLeaf };
}

function loadInitial(): Pick<TabStore, 'tabs' | 'activeTabId' | 'split'> {
  try {
    const raw = typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY);
    if (raw) {
      const cfg = JSON.parse(raw) as {
        tabs?: TabConfig[];
        activeTabId?: string;
        split?: unknown;
      };
      if (Array.isArray(cfg.tabs) && cfg.tabs.length > 0) {
        const activeTabId = cfg.tabs.some((t) => t.id === cfg.activeTabId)
          ? (cfg.activeTabId as string)
          : cfg.tabs[0].id;
        return {
          tabs: cfg.tabs,
          activeTabId,
          split: sanitizeSplit(cfg.split, cfg.tabs, activeTabId),
        };
      }
    }
  } catch {
    /* corrupt/unavailable storage → fall back to a fresh workspace */
  }
  const first = makeTab('inspector');
  return { tabs: [first], activeTabId: first.id, split: defaultSplit(first.id) };
}

const initial = loadInitial();

export const useTabStore = create<TabStore>((set) => ({
  tabs: initial.tabs,
  activeTabId: initial.activeTabId,
  split: initial.split,

  addTab: (type) =>
    set((s) => {
      const tab = makeTab(type);
      // Drop the new tab into the focused pane so it's immediately visible.
      const root = mapLeaves(s.split.root, (l) =>
        l.id === s.split.focusedLeaf ? { ...l, tabId: tab.id } : l,
      );
      return {
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        split: { ...s.split, root },
      };
    }),

  closeTab: (id) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || tab.pinned) return s;
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (tabs.length === 0) {
        const replacement = makeTab('inspector');
        return {
          tabs: [replacement],
          activeTabId: replacement.id,
          split: defaultSplit(replacement.id),
        };
      }
      let activeTabId = s.activeTabId;
      if (activeTabId === id) activeTabId = tabs[Math.max(0, idx - 1)].id;
      // Empty out any pane that was showing the closed tab.
      const root = mapLeaves(s.split.root, (l) =>
        l.tabId === id ? { ...l, tabId: null } : l,
      );
      return { tabs, activeTabId, split: { ...s.split, root } };
    }),

  renameTab: (id, name) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, name } : t)),
    })),

  pinTab: (id, pinned) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, pinned } : t)),
    })),

  // Show the tab in the focused pane (in single mode that's the whole view).
  activateTab: (id) =>
    set((s) => {
      const root = mapLeaves(s.split.root, (l) =>
        l.id === s.split.focusedLeaf ? { ...l, tabId: id } : l,
      );
      return { activeTabId: id, split: { ...s.split, root } };
    }),

  duplicateTab: (id) =>
    set((s) => {
      const src = s.tabs.find((t) => t.id === id);
      if (!src) return s;
      const copy: TabConfig = {
        ...src,
        id: uuid(),
        name: `${src.name} copy`,
        pinned: false,
        settings: { ...src.settings },
      };
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = [...s.tabs];
      tabs.splice(idx + 1, 0, copy);
      return { tabs, activeTabId: copy.id };
    }),

  updateSettings: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, settings: { ...t.settings, ...patch } } : t,
      ),
    })),

  // Reset to a clean slate (one fresh Inspector tab).
  newWorkspace: () =>
    set(() => {
      const first = makeTab('inspector');
      return {
        tabs: [first],
        activeTabId: first.id,
        split: defaultSplit(first.id),
      };
    }),

  splitPane: (leafId, dir) =>
    set((s) => {
      const seed = unusedTab(s.split.root, s.tabs, s.activeTabId);
      const fresh = makeLeaf(seed);
      const root = splitLeafNode(s.split.root, leafId, dir, fresh);
      return { split: { root, focusedLeaf: fresh.id } };
    }),

  // Remove a pane; the sibling subtree fills the freed space. Closing the last
  // pane is a no-op (there's always at least one).
  closePane: (leafId) =>
    set((s) => {
      const root = removeLeafNode(s.split.root, leafId);
      if (!root) return s;
      const ids = leafIds(root);
      const focusedLeaf = ids.includes(s.split.focusedLeaf)
        ? s.split.focusedLeaf
        : ids[0];
      // If we've collapsed back to one pane, sync the active tab to it.
      const activeTabId =
        root.type === 'leaf' && root.tabId ? root.tabId : s.activeTabId;
      return { activeTabId, split: { root, focusedLeaf } };
    }),

  assignPane: (leafId, tabId) =>
    set((s) => ({
      split: {
        ...s.split,
        root: mapLeaves(s.split.root, (l) =>
          l.id === leafId ? { ...l, tabId } : l,
        ),
        focusedLeaf: leafId,
      },
    })),

  setSplitFrac: (branchId, frac) =>
    set((s) => ({
      split: {
        ...s.split,
        root: setFracNode(s.split.root, branchId, clampFrac(frac)),
      },
    })),

  focusPane: (leafId) =>
    set((s) => ({ split: { ...s.split, focusedLeaf: leafId } })),
}));

// Persist the workspace on change (debounced — settings can update rapidly).
let persistTimer: ReturnType<typeof setTimeout> | undefined;
useTabStore.subscribe((s) => {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          version: '1',
          tabs: s.tabs,
          activeTabId: s.activeTabId,
          split: s.split,
        }),
      );
    } catch {
      /* storage full/unavailable — non-fatal */
    }
  }, 400);
});
