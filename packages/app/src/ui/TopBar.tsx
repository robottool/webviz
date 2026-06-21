/** Top bar (§11.1): brand, connection field + status, action icons. */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConnectionStore } from '../store/connection.store.js';
import { useTabStore } from '../store/tabs.store.js';
import {
  deleteLayout,
  listLayouts,
  loadLayout,
  saveLayout,
} from '../store/layouts.js';

const STATUS_LABEL: Record<string, string> = {
  connecting: 'connecting…',
  connected: 'connected',
  disconnected: 'disconnected',
  error: 'error',
};

export function TopBar() {
  const { status, url, channels, connect } = useConnectionStore();
  const [draft, setDraft] = useState(url);

  const sources = new Set(
    channels.map((c) => c.source_id).filter(Boolean) as string[],
  ).size;

  return (
    <div className="topbar">
      <span className="brand">⬡ WebViz</span>
      <input
        className="conn-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') connect(draft);
        }}
        spellCheck={false}
      />
      <button className="conn-btn" onClick={() => connect(draft)}>
        Connect
      </button>
      <span className={`status-dot status-${status}`} />
      <span className="status-text">{STATUS_LABEL[status] ?? status}</span>
      <span className="source-count">● {sources} sources</span>
      <div className="spacer" />
      <span className="icon-btn" title="Settings (not yet implemented)">⚙</span>
      <LayoutMenu />
      <span className="icon-btn" title="Record (not yet implemented)">⏺</span>
    </div>
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
        💾
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
                ✨ New (fresh) layout
              </div>
              <div className="tab-add-item" onClick={onSave}>
                💾 Save current layout…
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
