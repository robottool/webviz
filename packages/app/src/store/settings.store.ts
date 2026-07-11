/**
 * App settings (the ⚙ panel): the handful of *global* knobs that aren't already
 * per-tab. Persisted to localStorage and applied to the live singletons on load
 * and on every change:
 *   - theme          → visual theme (sets data-theme on <html>; styles.css)
 *   - syncWindowMs   → TimeManager reorder window (§8)
 *   - recordingCapMB → in-memory recording cap (core/recorder.ts)
 *   - hubUrl         → default connection URL (read by connection.store; '' = auto)
 *   - angleUnit / lengthUnit → display units (read by components; values stay SI)
 *
 * Most settings in WebViz live on a tab or display (TabConfig.settings / the
 * Properties panel) — this store deliberately holds only the cross-cutting ones.
 */

import { create } from 'zustand';
import { hubClient } from '../protocol/HubClient.js';
import { recorder } from '../core/recorder.js';

/** Visual themes. `industry` (light) is the default; styles.css holds the palettes.
 * `studio` (dark) and `studio-light` (bright) both turn the 3D viewport's
 * shadows + PBR lighting on (gated by the `--viewport-shadows` CSS flag, read by
 * core/SceneManager.ts); they differ only in chrome + viewport backdrop. */
export type ThemeId =
  | 'telemetry'
  | 'minimal'
  | 'vibrant'
  | 'industry'
  | 'studio'
  | 'studio-light';

/** Display units (values are stored/sent in SI — rad + m — and only converted
 * for display; e.g. the RobotModel joint sliders + TCP nudge). */
export type AngleUnit = 'deg' | 'rad';
export type LengthUnit = 'm' | 'mm';

export interface Settings {
  theme: ThemeId;
  syncWindowMs: number;
  recordingCapMB: number;
  /** Empty string means "derive from location" (see connection.store). */
  hubUrl: string;
  /** Angular display unit (revolute joints, TCP roll/pitch/yaw). */
  angleUnit: AngleUnit;
  /** Linear display unit (prismatic joints, TCP x/y/z). */
  lengthUnit: LengthUnit;
  /** Demo mode: RobotModel fakes `demo/joint_states` + `demo/base_frame` live
   * state client-side (no hub) and "Send to robot" plays an interpolated move
   * onto the monitor. Off = live data only (RobotModelPlugin). */
  demoMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'industry',
  syncWindowMs: 20,
  recordingCapMB: 256,
  hubUrl: '',
  angleUnit: 'deg',
  lengthUnit: 'mm',
  demoMode: false,
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
      angleUnit: patch.angleUnit ?? get().angleUnit,
      lengthUnit: patch.lengthUnit ?? get().lengthUnit,
      demoMode: patch.demoMode ?? get().demoMode,
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
