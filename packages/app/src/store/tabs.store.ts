/**
 * Tab store (§9.2). Manages the set of tabs and which one is active. Each tab is
 * an independent workspace; for this vertical slice only the Inspector tab type
 * has a working renderer, but the store models all six declared types.
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

interface TabStore {
  tabs: TabConfig[];
  activeTabId: string;
  addTab: (type: TabType) => void;
  closeTab: (id: string) => void;
  renameTab: (id: string, name: string) => void;
  pinTab: (id: string, pinned: boolean) => void;
  activateTab: (id: string) => void;
  duplicateTab: (id: string) => void;
  updateSettings: (id: string, patch: Record<string, unknown>) => void;
  newWorkspace: () => void;
}

export const TAB_META: Record<TabType, { label: string; icon: string }> = {
  '3d': { label: '3D view', icon: '⬡' },
  image: { label: 'Cameras', icon: '🎞' },
  plot: { label: 'Plot', icon: '📈' },
  map: { label: 'Map', icon: '🗺' },
  inspector: { label: 'Inspector', icon: '🔍' },
  log: { label: 'Log', icon: '📋' },
};

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

// Per-browser persistence of the current workspace, so a reload restores your
// tabs instead of resetting to a fresh Inspector. (Named/shared layouts go
// through the hub in store/layouts.ts; this is just the local working copy.)
const LS_KEY = 'webviz.workspace';

function loadInitial(): { tabs: TabConfig[]; activeTabId: string } {
  try {
    const raw = typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY);
    if (raw) {
      const cfg = JSON.parse(raw) as { tabs?: TabConfig[]; activeTabId?: string };
      if (Array.isArray(cfg.tabs) && cfg.tabs.length > 0) {
        const activeTabId = cfg.tabs.some((t) => t.id === cfg.activeTabId)
          ? (cfg.activeTabId as string)
          : cfg.tabs[0].id;
        return { tabs: cfg.tabs, activeTabId };
      }
    }
  } catch {
    /* corrupt/unavailable storage → fall back to a fresh workspace */
  }
  const first = makeTab('inspector');
  return { tabs: [first], activeTabId: first.id };
}

const initial = loadInitial();

export const useTabStore = create<TabStore>((set) => ({
  tabs: initial.tabs,
  activeTabId: initial.activeTabId,

  addTab: (type) =>
    set((s) => {
      const tab = makeTab(type);
      return { tabs: [...s.tabs, tab], activeTabId: tab.id };
    }),

  closeTab: (id) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || tab.pinned) return s;
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (tabs.length === 0) {
        const replacement = makeTab('inspector');
        return { tabs: [replacement], activeTabId: replacement.id };
      }
      let activeTabId = s.activeTabId;
      if (activeTabId === id) {
        activeTabId = tabs[Math.max(0, idx - 1)].id;
      }
      return { tabs, activeTabId };
    }),

  renameTab: (id, name) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, name } : t)),
    })),

  pinTab: (id, pinned) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, pinned } : t)),
    })),

  activateTab: (id) => set({ activeTabId: id }),

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

  // Reset to a clean slate (one fresh Inspector tab); the localStorage copy
  // updates via the subscribe below.
  newWorkspace: () =>
    set(() => {
      const first = makeTab('inspector');
      return { tabs: [first], activeTabId: first.id };
    }),
}));

// Persist the workspace on change (debounced — settings can update rapidly).
let persistTimer: ReturnType<typeof setTimeout> | undefined;
useTabStore.subscribe((s) => {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({ version: '1', tabs: s.tabs, activeTabId: s.activeTabId }),
      );
    } catch {
      /* storage full/unavailable — non-fatal */
    }
  }, 400);
});
