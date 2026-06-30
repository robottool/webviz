/**
 * 3D tab (§9.6, §11.2): a three-column workspace — a Displays sidebar (active
 * plugins + enable toggles), the Three.js viewport, and a Properties panel
 * (auto-form from the selected plugin's schema). The viewport is driven by a
 * per-tab SceneManager; the TF tree and hub connection are shared singletons.
 *
 * Sidebars are collapsible. The full design targets react-mosaic resizable
 * panels; this slice uses fixed-width collapsible columns.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SceneManager } from '../core/SceneManager.js';
import { ViewGizmo } from '../ui/ViewGizmo.js';
import { uuid } from '../core/uuid.js';
import { tfManager } from '../core/TFManager.js';
import { hubClient } from '../protocol/HubClient.js';
import type { DisplayPlugin } from '../core/plugin.js';
import type { RobotModelPlugin } from '../plugins/RobotModelPlugin.js';
import { RobotModelProperties } from './RobotModelProperties.js';
import { pluginRegistry } from '../plugins/index.js';
import { useConnectionStore } from '../store/connection.store.js';
import { useTabStore } from '../store/tabs.store.js';
import { useSettingsStore } from '../store/settings.store.js';

interface StoredDisplay {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}

interface Props {
  tabId: string;
}

export function ThreeDTab({ tabId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneManager | null>(null);
  const pluginsRef = useRef<DisplayPlugin[]>([]);

  const theme = useSettingsStore((s) => s.theme);

  const [scene, setScene] = useState<SceneManager | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDisplays, setShowDisplays] = useState(true);
  const [showProps, setShowProps] = useState(true);
  const [fixedFrame, setFixedFrame] = useState('odom');
  const [grid, setGrid] = useState(true);
  const [axes, setAxes] = useState(true);
  // Force re-render to refresh dynamic dropdowns (TF frames) and plugin lists.
  const [, force] = useReducer((n: number) => n + 1, 0);

  const channels = useConnectionStore((s) => s.channels);
  const updateTabSettings = useTabStore((s) => s.updateSettings);
  const storedDisplays = useTabStore(
    (s) =>
      (s.tabs.find((t) => t.id === tabId)?.settings.displays as
        | StoredDisplay[]
        | undefined),
  );

  // Persist the live plugin list back into the tab's settings.
  const persist = () => {
    const displays: StoredDisplay[] = pluginsRef.current.map((p) => ({
      id: p.id,
      type: p.type,
      name: p.name,
      enabled: p.enabled,
      settings: p.getSettings(),
    }));
    updateTabSettings(tabId, { displays });
  };

  const addPlugin = async (
    type: string,
    init?: Partial<StoredDisplay>,
    scene: SceneManager | null = sceneRef.current,
    cancelled?: () => boolean,
  ): Promise<void> => {
    if (!scene) return;
    const id = init?.id ?? uuid();
    const plugin = pluginRegistry.create(type, id, init?.settings);
    if (init?.name) plugin.name = init.name;
    plugin.enabled = init?.enabled ?? true;
    await plugin.initialize({ hub: hubClient, tf: tfManager, scene });
    // The scene may have been torn down while we awaited (StrictMode remount).
    if (cancelled?.()) {
      plugin.destroy();
      return;
    }
    scene.setObjectVisible(id, plugin.enabled);
    pluginsRef.current.push(plugin);
    setSelectedId((cur) => cur ?? id);
    force();
  };

  // Mount the scene and seed plugins once. Guarded against React StrictMode's
  // mount→cleanup→mount cycle: the cleanup sets `disposed`, so an in-flight
  // async seed from a torn-down scene bails before adding duplicate plugins.
  useEffect(() => {
    let disposed = false;
    const scene = new SceneManager(containerRef.current!);
    sceneRef.current = scene;
    setScene(scene);
    scene.setFixedFrame(fixedFrame);
    tfManager.setFixedFrame(fixedFrame);

    const offTf = tfManager.onChange(() => scene.requestRender());
    const offRender = scene.onRender((dt) => {
      for (const p of pluginsRef.current) if (p.enabled) p.onRender(dt);
    });

    // A fresh 3D panel starts empty — the user adds displays via "＋ Add".
    const seed: Array<Partial<StoredDisplay> & { type: string }> =
      storedDisplays ?? [];

    (async () => {
      for (const d of seed) {
        if (disposed) return;
        await addPlugin(d.type, d, scene, () => disposed);
      }
      if (disposed) return;
      persist();
      scene.start();
    })();

    // Refresh TF-frame dropdown periodically (frames arrive at message rate).
    const ticker = setInterval(force, 1000);

    return () => {
      disposed = true;
      clearInterval(ticker);
      offTf();
      offRender();
      for (const p of pluginsRef.current) p.destroy();
      pluginsRef.current = [];
      scene.dispose();
      sceneRef.current = null;
      setScene(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Repaint the WebGL viewport (background + grid) when the theme changes; the
  // CSS vars SceneManager reads have already flipped by the time this runs.
  useEffect(() => {
    sceneRef.current?.applyTheme();
  }, [theme]);

  const applyFixedFrame = (frame: string) => {
    setFixedFrame(frame);
    sceneRef.current?.setFixedFrame(frame);
    tfManager.setFixedFrame(frame);
  };

  const toggleEnabled = (plugin: DisplayPlugin) => {
    plugin.enabled = !plugin.enabled;
    sceneRef.current?.setObjectVisible(plugin.id, plugin.enabled);
    persist();
    force();
  };

  const removePlugin = (plugin: DisplayPlugin) => {
    plugin.destroy();
    pluginsRef.current = pluginsRef.current.filter((p) => p !== plugin);
    if (selectedId === plugin.id) setSelectedId(pluginsRef.current[0]?.id ?? null);
    persist();
    force();
  };

  const selected = pluginsRef.current.find((p) => p.id === selectedId) ?? null;
  const frames = tfManager.getFrameList();
  const frameOptions = frames.includes(fixedFrame)
    ? frames
    : [fixedFrame, ...frames];

  return (
    <div className="threed">
      <div className="threed-toolbar">
        <button onClick={() => setShowDisplays((v) => !v)} title="Toggle displays">
          ☰ Displays
        </button>
        <label className="threed-field">
          Fixed frame
          <select
            value={fixedFrame}
            onChange={(e) => applyFixedFrame(e.target.value)}
          >
            {frameOptions.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="threed-check">
          <input
            type="checkbox"
            checked={grid}
            onChange={(e) => {
              setGrid(e.target.checked);
              sceneRef.current?.setGridVisible(e.target.checked);
            }}
          />
          Grid
        </label>
        <label className="threed-check">
          <input
            type="checkbox"
            checked={axes}
            onChange={(e) => {
              setAxes(e.target.checked);
              sceneRef.current?.setWorldAxesVisible(e.target.checked);
            }}
          />
          Axes
        </label>
        <div className="spacer" />
        <button onClick={() => sceneRef.current?.fitView()} title="Frame all content">
          ⤢ Fit
        </button>
        <button onClick={() => setShowProps((v) => !v)} title="Toggle properties">
          Properties ☰
        </button>
      </div>

      <div className="threed-body">
        {showDisplays && (
          <div className="threed-sidebar">
            <div className="threed-sidebar-head">
              <span>Displays</span>
              <AddDisplayMenu onAdd={(type) => addPlugin(type).then(persist)} />
            </div>
            <ul className="display-list">
              {pluginsRef.current.map((p) => (
                <li
                  key={p.id}
                  className={p.id === selectedId ? 'display-item sel' : 'display-item'}
                  onClick={() => setSelectedId(p.id)}
                >
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleEnabled(p)}
                  />
                  <span className="display-name">{p.name}</span>
                  <span className="display-type">{p.type}</span>
                  <span
                    className="display-remove"
                    title="Remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      removePlugin(p);
                    }}
                  >
                    ✕
                  </span>
                </li>
              ))}
              {pluginsRef.current.length === 0 && (
                <li className="muted" style={{ padding: '8px' }}>
                  No displays. Use “＋ Add”.
                </li>
              )}
            </ul>
          </div>
        )}

        <div className="threed-viewport-wrap">
          <div className="threed-viewport" ref={containerRef} />
          {scene && <ViewGizmo scene={scene} />}
        </div>

        {showProps && (
          <div className="threed-props">
            <div className="threed-sidebar-head">
              <span>Properties</span>
            </div>
            {selected ? (
              selected.type === 'RobotModel' ? (
                <RobotModelProperties
                  key={selected.id}
                  plugin={selected as RobotModelPlugin}
                  onChange={() => {
                    persist();
                    force();
                  }}
                />
              ) : (
                <PropertiesForm
                  key={selected.id}
                  plugin={selected}
                  onChange={() => {
                    persist();
                    force();
                  }}
                />
              )
            ) : (
              <div className="muted" style={{ padding: '10px' }}>
                Select a display to edit its properties.
              </div>
            )}
          </div>
        )}
      </div>

      {/* channels in deps so dropdown enum options refresh as channels arrive */}
      <span hidden>{channels.length}</span>
    </div>
  );
}

function AddDisplayMenu({ onAdd }: { onAdd: (type: string) => void }) {
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  const btnRef = useRef<HTMLButtonElement>(null);
  const catalogue = pluginRegistry.catalogue();

  const openMenu = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPos({ top: rect.bottom + 4, left: rect.left });
  };
  const closeMenu = () => setMenuPos(null);

  // Dismiss the menu on resize or Escape (matches the tab add menu).
  useEffect(() => {
    if (!menuPos) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeMenu();
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', closeMenu);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', closeMenu);
    };
  }, [menuPos]);

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => (menuPos ? closeMenu() : openMenu())}
      >
        ＋ Add
      </button>
      {menuPos &&
        createPortal(
          <>
            <div className="tab-add-backdrop" onClick={closeMenu} />
            <div
              className="tab-add-menu"
              style={{ top: menuPos.top, left: menuPos.left }}
            >
              {catalogue.map((c) => (
                <div
                  key={c.type}
                  className="tab-add-item"
                  onClick={() => {
                    onAdd(c.type);
                    closeMenu();
                  }}
                >
                  {c.label}
                </div>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

function PropertiesForm({
  plugin,
  onChange,
}: {
  plugin: DisplayPlugin;
  onChange: () => void;
}) {
  const schema = plugin.getSchema();
  const settings = plugin.getSettings();

  const set = (key: string, value: unknown) => {
    plugin.updateSettings({ [key]: value });
    onChange();
  };

  return (
    <div className="props-form">
      <label className="props-row">
        <span>Name</span>
        <input
          type="text"
          value={plugin.name}
          onChange={(e) => {
            plugin.name = e.target.value;
            onChange();
          }}
        />
      </label>
      {Object.entries(schema).map(([key, field]) => {
        const value = settings[key];
        return (
          <label className="props-row" key={key}>
            <span>{field.label}</span>
            {field.kind === 'boolean' && (
              <input
                type="checkbox"
                checked={Boolean(value)}
                onChange={(e) => set(key, e.target.checked)}
              />
            )}
            {field.kind === 'number' && (
              <input
                type="number"
                value={Number(value ?? field.default)}
                min={field.min}
                max={field.max}
                step={field.step}
                onChange={(e) => set(key, Number(e.target.value))}
              />
            )}
            {field.kind === 'string' && (
              <input
                type="text"
                value={String(value ?? '')}
                onChange={(e) => set(key, e.target.value)}
              />
            )}
            {field.kind === 'enum' && (
              <select
                value={String(value ?? '')}
                onChange={(e) => set(key, e.target.value)}
              >
                <option value="">—</option>
                {field.options().map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            )}
          </label>
        );
      })}
    </div>
  );
}
