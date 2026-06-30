/**
 * Workspace store (§9.2). The workspace is a **tiling layout of panels** — a
 * recursive binary tree of panes (no tab bar / no tab switching). Each leaf pane
 * owns one panel instance (a `TabConfig`: its type + persisted settings); you
 * add panels by splitting a pane and picking content, remove them by closing the
 * pane, and focus one with maximize. "Switch between whole setups" is handled by
 * named layouts (store/layouts.ts), not per-panel tabs.
 *
 * A node is either a `leaf` (one pane; `tabId` = the panel it owns, or null when
 * empty/awaiting a pick) or a `split` of two children laid out `row` (left|right)
 * or `col` (top/bottom) with a divider at `frac`. Splitting replaces a leaf with
 * a split of [old leaf, new empty leaf]; closing a leaf replaces its parent split
 * with the surviving sibling. The `tabs` array is the live panel pool — each
 * entry is owned by exactly one leaf, and orphans are garbage-collected.
 */

import { create } from 'zustand';
import { uuid } from '../core/uuid.js';
import type { IconName } from '../ui/icons.js';

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
  /** Leaf id rendered full-bleed over its siblings, or null. */
  maximized: string | null;
}

interface TabStore {
  /** Live panel instances, each owned by exactly one leaf in `split`. */
  tabs: TabConfig[];
  split: SplitState;
  updateSettings: (id: string, patch: Record<string, unknown>) => void;
  newWorkspace: () => void;
  splitPane: (leafId: string, dir: SplitDir) => void;
  closePane: (leafId: string) => void;
  /** Set (or replace) the panel a pane shows — the "pick content" action. */
  setPaneType: (leafId: string, type: TabType) => void;
  setSplitFrac: (branchId: string, frac: number) => void;
  focusPane: (leafId: string) => void;
  toggleMaximize: (leafId: string) => void;
}

// `icon` is a semantic key into the line-icon set (ui/icons.tsx), not a glyph —
// the UI maps it to an <Icon/> so colours follow the theme.
export const TAB_META: Record<TabType, { label: string; icon: IconName }> = {
  '3d': { label: '3D view', icon: 'cube' },
  image: { label: 'Cameras', icon: 'camera' },
  plot: { label: 'Plot', icon: 'chart' },
  map: { label: 'Map', icon: 'map' },
  inspector: { label: 'Inspector', icon: 'search' },
  log: { label: 'Log', icon: 'list' },
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

/** A fresh workspace: one empty pane (awaiting a panel pick). */
function emptyWorkspace(): Pick<TabStore, 'tabs' | 'split'> {
  const leaf = makeLeaf(null);
  return { tabs: [], split: { root: leaf, focusedLeaf: leaf.id, maximized: null } };
}

/** The set of panel ids currently owned by some pane. */
function ownedTabIds(root: SplitNode): Set<string> {
  return new Set(
    leafIds(root)
      .map((id) => findLeaf(root, id)?.tabId)
      .filter(Boolean) as string[],
  );
}

/** Drop panel instances no pane owns any more (e.g. after a pane closed or its
 * type changed) so the pool can't accumulate orphans. */
export function gcPanels(tabs: TabConfig[], root: SplitNode): TabConfig[] {
  const used = ownedTabIds(root);
  return tabs.filter((t) => used.has(t.id));
}

function findLeaf(node: SplitNode, id: string): LeafNode | null {
  if (node.type === 'leaf') return node.id === id ? node : null;
  return findLeaf(node.a, id) ?? findLeaf(node.b, id);
}

// Per-browser persistence of the current workspace, so a reload restores your
// tabs instead of resetting to a fresh Inspector. (Named/shared layouts go
// through the hub in store/layouts.ts; this is just the local working copy.)
const LS_KEY = 'webviz.workspace';

/** Validate a persisted/loaded split against the panel pool (drop stale ids,
 *  clamp fracs, regen missing node ids). Unknown shapes → one pane showing the
 *  first panel (or an empty pane when there are none). */
export function sanitizeSplit(raw: unknown, tabs: TabConfig[]): SplitState {
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
  const cleaned =
    raw && typeof raw === 'object'
      ? clean((raw as { root?: unknown }).root)
      : null;
  // No usable tree → a single pane bound to the first panel (or empty).
  const root = cleaned ?? makeLeaf(tabs[0]?.id ?? null);
  const ids = leafIds(root);
  const wanted = (raw as { focusedLeaf?: string })?.focusedLeaf;
  const focusedLeaf = wanted && ids.includes(wanted) ? wanted : ids[0];
  const wantedMax = (raw as { maximized?: unknown })?.maximized;
  const maximized =
    typeof wantedMax === 'string' && ids.includes(wantedMax) ? wantedMax : null;
  return { root, focusedLeaf, maximized };
}

function loadInitial(): Pick<TabStore, 'tabs' | 'split'> {
  try {
    const raw = typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY);
    if (raw) {
      const cfg = JSON.parse(raw) as { tabs?: TabConfig[]; split?: unknown };
      const pool = Array.isArray(cfg.tabs) ? cfg.tabs : [];
      const split = sanitizeSplit(cfg.split, pool);
      // Migration: pre-pivot layouts had a tab *pool* larger than the panes
      // (background tabs). gc keeps only panels a pane still owns.
      return { tabs: gcPanels(pool, split.root), split };
    }
  } catch {
    /* corrupt/unavailable storage → fall back to a fresh workspace */
  }
  return emptyWorkspace();
}

const initial = loadInitial();

export const useTabStore = create<TabStore>((set) => ({
  tabs: initial.tabs,
  split: initial.split,

  updateSettings: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, settings: { ...t.settings, ...patch } } : t,
      ),
    })),

  // Reset to a clean slate (one empty pane).
  newWorkspace: () => set(() => emptyWorkspace()),

  // Split a pane: the new sibling starts empty (the user picks its panel).
  splitPane: (leafId, dir) =>
    set((s) => {
      const fresh = makeLeaf(null);
      const root = splitLeafNode(s.split.root, leafId, dir, fresh);
      return { split: { root, focusedLeaf: fresh.id, maximized: null } };
    }),

  // Remove a pane; its sibling fills the freed space and its panel is GC'd.
  // Closing the only pane clears it back to a single empty pane.
  closePane: (leafId) =>
    set((s) => {
      const root = removeLeafNode(s.split.root, leafId) ?? makeLeaf(null);
      const ids = leafIds(root);
      const focusedLeaf = ids.includes(s.split.focusedLeaf)
        ? s.split.focusedLeaf
        : ids[0];
      const maximized =
        s.split.maximized && ids.includes(s.split.maximized)
          ? s.split.maximized
          : null;
      return { tabs: gcPanels(s.tabs, root), split: { root, focusedLeaf, maximized } };
    }),

  setPaneType: (leafId, type) =>
    set((s) => {
      const tab = makeTab(type);
      const root = mapLeaves(s.split.root, (l) =>
        l.id === leafId ? { ...l, tabId: tab.id } : l,
      );
      // gc drops the panel this pane used to own (now replaced).
      return {
        tabs: gcPanels([...s.tabs, tab], root),
        split: { ...s.split, root, focusedLeaf: leafId },
      };
    }),

  setSplitFrac: (branchId, frac) =>
    set((s) => ({
      split: {
        ...s.split,
        root: setFracNode(s.split.root, branchId, clampFrac(frac)),
      },
    })),

  focusPane: (leafId) =>
    set((s) => ({ split: { ...s.split, focusedLeaf: leafId } })),

  toggleMaximize: (leafId) =>
    set((s) => ({
      split: {
        ...s.split,
        maximized: s.split.maximized === leafId ? null : leafId,
        focusedLeaf: leafId,
      },
    })),
}));

// Persist the workspace on change (debounced — settings can update rapidly).
let persistTimer: ReturnType<typeof setTimeout> | undefined;
useTabStore.subscribe((s) => {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({ version: '2', tabs: s.tabs, split: s.split }),
      );
    } catch {
      /* storage full/unavailable — non-fatal */
    }
  }, 400);
});
