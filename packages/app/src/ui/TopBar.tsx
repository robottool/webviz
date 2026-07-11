/** Top bar (§11.1): brand, connection status, action icons. The hub URL +
 * Connect control lives in the ⚙ settings popover (SettingsMenu). */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useConnectionStore,
  STATUS_LABEL,
  autoHubUrl,
} from '../store/connection.store.js';
import { useTabStore } from '../store/tabs.store.js';
import { hubClient } from '../protocol/HubClient.js';
import {
  useSettingsStore,
  type ThemeId,
  type AngleUnit,
  type LengthUnit,
} from '../store/settings.store.js';
import { recorder } from '../core/recorder.js';
import { player } from '../core/player.js';
import { Icon } from './icons.js';
import {
  deleteLayout,
  listLayouts,
  loadLayout,
  saveLayout,
} from '../store/layouts.js';

export function TopBar() {
  // Connection status + counts live in the bottom StatusBar; the top bar is just
  // the brand and actions.
  return (
    <div className="topbar">
      <span className="brand">WebViz</span>
      <div className="spacer" />
      <SettingsMenu />
      <LayoutMenu />
      <LoadRecordingButton />
      <RecordButton />
    </div>
  );
}

/** ⚙ — global settings popover (sync window, recording cap, default hub URL). */
function SettingsMenu() {
  const btnRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const { theme, syncWindowMs, recordingCapMB, hubUrl, angleUnit, lengthUnit, demoMode, set, reset } =
    useSettingsStore();
  const { status, connect } = useConnectionStore();

  // Demo mode replaces the session with an in-app fake robot; toggling it either
  // way resets the workspace (closes every panel) so nothing conflicts with — or
  // lingers after — the demo. If there's real work to lose (open panels, or live
  // hub data when entering), confirm first.
  const toggleDemo = (on: boolean) => {
    const { tabs, newWorkspace } = useTabStore.getState();
    const hasPanels = Object.keys(tabs).length > 0;
    if (on) {
      const liveData =
        hubClient.getStatus() === 'connected' && hubClient.getChannels().length > 0;
      if (
        (hasPanels || liveData) &&
        !window.confirm(
          'Demo mode will close the currently open panels, and any loaded ' +
            'robot / live hub data will be cleared. You can save the current ' +
            'layout and reload it later. Continue?',
        )
      ) {
        return; // leave demo mode off
      }
      newWorkspace();
      set({ demoMode: true });
    } else {
      if (
        hasPanels &&
        !window.confirm(
          'Turning off demo mode will tear down the demo robot and close the ' +
            'open panels. Continue?',
        )
      ) {
        return; // leave demo mode on
      }
      // Flip the flag first so the demo teardown (stopDemo) runs while the
      // RobotModel panel is still mounted, then close every panel.
      set({ demoMode: false });
      newWorkspace();
    }
  };

  const open = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ top: r.bottom + 6, left: Math.max(8, r.right - 260) });
  };
  const close = () => setPos(null);

  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  return (
    <>
      <span
        ref={btnRef}
        className="icon-btn"
        title="Settings"
        onClick={() => (pos ? close() : open())}
      >
        <Icon name="gear" size={16} />
      </span>
      {pos &&
        createPortal(
          <>
            <div className="tab-add-backdrop" onClick={close} />
            <div
              className="tab-add-menu settings-menu"
              style={{ top: pos.top, left: pos.left }}
            >
              <label className="settings-row">
                <span>Theme</span>
                <select
                  value={theme}
                  onChange={(e) => set({ theme: e.target.value as ThemeId })}
                >
                  <option value="telemetry">Sci-fi telemetry</option>
                  <option value="minimal">Clean minimal</option>
                  <option value="vibrant">Vibrant</option>
                  <option value="industry">Industry (light)</option>
                  <option value="studio">Studio (shadows)</option>
                  <option value="studio-light">Studio bright (shadows)</option>
                </select>
              </label>
              <label className="settings-row">
                <span>Angle unit</span>
                <select
                  value={angleUnit}
                  onChange={(e) => set({ angleUnit: e.target.value as AngleUnit })}
                >
                  <option value="deg">Degrees (°)</option>
                  <option value="rad">Radians (rad)</option>
                </select>
              </label>
              <label className="settings-row">
                <span>Length unit</span>
                <select
                  value={lengthUnit}
                  onChange={(e) => set({ lengthUnit: e.target.value as LengthUnit })}
                >
                  <option value="mm">Millimetres (mm)</option>
                  <option value="m">Metres (m)</option>
                </select>
              </label>
              <label className="settings-row">
                <span>Sync window (ms)</span>
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={syncWindowMs}
                  onChange={(e) =>
                    set({ syncWindowMs: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              </label>
              <label className="settings-row">
                <span>Recording cap (MB)</span>
                <input
                  type="number"
                  min={1}
                  max={4096}
                  value={recordingCapMB}
                  onChange={(e) =>
                    set({
                      recordingCapMB: Math.max(1, Number(e.target.value) || 1),
                    })
                  }
                />
              </label>
              <label className="settings-row settings-row-col">
                <span>Hub URL</span>
                <div className="settings-conn">
                  <input
                    type="text"
                    placeholder="auto (from page host)"
                    value={hubUrl}
                    spellCheck={false}
                    onChange={(e) => set({ hubUrl: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') connect(hubUrl.trim() || autoHubUrl);
                    }}
                  />
                  <button
                    className="conn-btn"
                    onClick={() => connect(hubUrl.trim() || autoHubUrl)}
                  >
                    Connect
                  </button>
                </div>
              </label>
              <div className="settings-note muted">
                <span className={`status-dot status-${status}`} />{' '}
                {STATUS_LABEL[status] ?? status} · blank = auto ({autoHubUrl}).
              </div>
              <div className="layout-sep" />
              <label className="settings-row">
                <span>Demo mode</span>
                <input
                  type="checkbox"
                  checked={demoMode}
                  onChange={(e) => toggleDemo(e.target.checked)}
                />
              </label>
              <div className="settings-note muted">
                Fakes a robot's live state client-side; “Send to robot” plays the
                move onto the dummy. No hub needed.
              </div>
              <div className="layout-sep" />
              <div className="tab-add-item" onClick={reset}>
                ↺ Reset to defaults
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

/** 📂 — load a recording (.mcap, or legacy .wvrec) and start replaying it (as
 * a coexisting hub source). */
function LoadRecordingButton() {
  const inputRef = useRef<HTMLInputElement>(null);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    try {
      await player.load(file);
      player.play();
    } catch (err) {
      window.alert(`Could not load recording: ${(err as Error).message}`);
    }
  };

  return (
    <>
      <span
        className="icon-btn"
        title="Load recording (.mcap / .wvrec)"
        onClick={() => inputRef.current?.click()}
      >
        <Icon name="folder" size={16} />
      </span>
      <input
        ref={inputRef}
        type="file"
        accept=".mcap,.wvrec"
        style={{ display: 'none' }}
        onChange={onPick}
      />
    </>
  );
}

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function RecordButton() {
  const channels = useConnectionStore((s) => s.channels);
  const [active, setActive] = useState(recorder.isActive());
  const [stats, setStats] = useState(recorder.stats());

  const finalize = useCallback(() => {
    setActive(false);
    void recorder.stop().then((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `webviz-${new Date().toISOString().replace(/[:.]/g, '-')}.mcap`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setStats(recorder.stats());
      // Auto-stop & download once the recording hits its size/frame cap.
      if (recorder.isLimitReached()) {
        finalize();
        window.alert(
          `Recording stopped: reached the size limit (${recorder.getCapMB()} MB).`,
        );
      }
    }, 250);
    return () => clearInterval(id);
  }, [active, finalize]);

  const toggle = () => {
    if (recorder.isActive()) {
      finalize();
    } else {
      recorder.start(channels);
      setStats(recorder.stats());
      setActive(true);
    }
  };

  if (!active) {
    return (
      <span
        className="icon-btn icon-btn-rec"
        title="Record session"
        onClick={toggle}
      >
        <Icon name="record" size={14} />
      </span>
    );
  }
  return (
    <span
      className="rec-indicator"
      title="Stop & download recording"
      onClick={toggle}
    >
      <span className="rec-dot" />
      REC {fmtDur(stats.elapsedMs)} · {stats.frames} · {fmtBytes(stats.bytes)}
    </span>
  );
}

function LayoutMenu() {
  const btnRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const newWorkspace = useTabStore((s) => s.newWorkspace);

  const refresh = async () => {
    try {
      setNames(await listLayouts());
      setError(null);
    } catch {
      setNames([]);
      setError('Hub unavailable');
    }
  };

  const open = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ top: r.bottom + 6, left: Math.max(8, r.right - 240) });
    void refresh();
  };
  const close = () => setPos(null);

  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  const onSave = async () => {
    const name = window.prompt('Save current layout as:');
    if (!name?.trim()) return;
    try {
      await saveLayout(name.trim());
      await refresh();
    } catch {
      setError('Save failed');
    }
  };
  const onLoad = async (name: string) => {
    try {
      await loadLayout(name);
      close();
    } catch {
      setError('Load failed');
    }
  };
  const onNew = () => {
    if (window.confirm('Start a fresh layout? The current tabs will be cleared.')) {
      newWorkspace();
      close();
    }
  };
  const onDelete = async (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    if (!window.confirm(`Delete saved layout “${name}”?`)) return;
    try {
      await deleteLayout(name);
      await refresh();
    } catch {
      setError('Delete failed');
    }
  };

  return (
    <>
      <span
        ref={btnRef}
        className="icon-btn"
        title="Layouts"
        onClick={() => (pos ? close() : open())}
      >
        <Icon name="save" size={16} />
      </span>
      {pos &&
        createPortal(
          <>
            <div className="tab-add-backdrop" onClick={close} />
            <div
              className="tab-add-menu layout-menu"
              style={{ top: pos.top, left: pos.left }}
            >
              <div className="tab-add-item" onClick={onNew}>
                <Icon name="newfile" /> New (fresh) layout
              </div>
              <div className="tab-add-item" onClick={onSave}>
                <Icon name="save" /> Save current layout…
              </div>
              <div className="layout-sep" />
              {error && <div className="layout-msg muted">{error}</div>}
              {!error && names.length === 0 && (
                <div className="layout-msg muted">No saved layouts</div>
              )}
              {names.map((name) => (
                <div
                  key={name}
                  className="tab-add-item layout-row"
                  onClick={() => onLoad(name)}
                  title="Load layout"
                >
                  <span className="layout-name">{name}</span>
                  <span
                    className="layout-del"
                    title="Delete"
                    onClick={(e) => onDelete(e, name)}
                  >
                    ✕
                  </span>
                </div>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
