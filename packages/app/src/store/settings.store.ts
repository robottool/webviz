/**
 * App settings (the ⚙ panel): the handful of *global* knobs that aren't already
 * per-tab. Persisted to localStorage and applied to the live singletons on load
 * and on every change:
 *   - theme          → visual theme (sets data-theme on <html>; styles.css)
 *   - syncWindowMs   → TimeManager reorder window (§8)
 *   - recordingCapMB → in-memory recording cap (core/recorder.ts)
 *   - hubUrl         → default connection URL (read by connection.store; '' = auto)
 *
 * Most settings in WebViz live on a tab or display (TabConfig.settings / the
 * Properties panel) — this store deliberately holds only the cross-cutting ones.
 */

import { create } from 'zustand';
import { hubClient } from '../protocol/HubClient.js';
import { recorder } from '../core/recorder.js';

/** Visual themes. `telemetry` is the default; styles.css holds the palettes. */
export type ThemeId = 'telemetry' | 'minimal' | 'vibrant';

export interface Settings {
  theme: ThemeId;
  syncWindowMs: number;
  recordingCapMB: number;
  /** Empty string means "derive from location" (see connection.store). */
  hubUrl: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'telemetry',
  syncWindowMs: 20,
  recordingCapMB: 256,
  hubUrl: '',
};

const LS_KEY = 'webviz.settings';

function hydrate(): Settings {
  try {
    const raw =
      typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Push settings into the live singletons (TimeManager, recorder, DOM theme). */
function apply(s: Settings): void {
  hubClient.time.setSyncWindow(s.syncWindowMs);
  recorder.setCapMB(s.recordingCapMB);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = s.theme;
  }
}

function persist(s: Settings): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* ignore quota / unavailable storage */
  }
}

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void;
  reset: () => void;
}

const initial = hydrate();
apply(initial);

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...initial,
  set: (patch) => {
    const next: Settings = {
      theme: patch.theme ?? get().theme,
      syncWindowMs: patch.syncWindowMs ?? get().syncWindowMs,
      recordingCapMB: patch.recordingCapMB ?? get().recordingCapMB,
      hubUrl: patch.hubUrl ?? get().hubUrl,
    };
    apply(next);
    persist(next);
    set(next);
  },
  reset: () => {
    apply(DEFAULT_SETTINGS);
    persist(DEFAULT_SETTINGS);
    set({ ...DEFAULT_SETTINGS });
  },
}));

/** Persisted default hub URL, or '' if unset. Read by connection.store at init. */
export function persistedHubUrl(): string {
  return initial.hubUrl;
}
