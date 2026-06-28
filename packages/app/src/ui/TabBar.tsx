/** Tab bar (§11.1, §9.5): tab chips, close buttons, and an add-tab menu. */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useTabStore,
  TAB_META,
  type TabType,
} from '../store/tabs.store.js';

const ADDABLE: TabType[] = ['3d', 'image', 'plot', 'map', 'inspector', 'log'];

export function TabBar() {
  const { tabs, activeTabId, addTab, closeTab, activateTab } = useTabStore();
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  const addBtnRef = useRef<HTMLButtonElement>(null);

  const openMenu = () => {
    const rect = addBtnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPos({ top: rect.bottom + 4, left: rect.left });
  };
  const closeMenu = () => setMenuPos(null);

  // Dismiss the menu on outside click, scroll, or Escape.
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
    <div className="tabbar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab ${tab.id === activeTabId ? 'tab-active' : ''}`}
          data-tabtype={tab.type}
          onClick={() => activateTab(tab.id)}
        >
          <span className="tab-icon">{tab.icon}</span>
          <span className="tab-name">{tab.name}</span>
          {tab.pinned ? (
            <span className="tab-pin" title="pinned">📌</span>
          ) : (
            <span
              className="tab-close"
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
            >
              ×
            </span>
          )}
        </div>
      ))}

      <button
        ref={addBtnRef}
        className="tab-add"
        onClick={() => (menuPos ? closeMenu() : openMenu())}
      >
        +
      </button>

      <div className="spacer" />
      <SplitPicker />

      {menuPos &&
        createPortal(
          <>
            <div className="tab-add-backdrop" onClick={closeMenu} />
            <div
              className="tab-add-menu"
              style={{ top: menuPos.top, left: menuPos.left }}
            >
              {ADDABLE.map((type) => (
                <div
                  key={type}
                  className="tab-add-item"
                  onClick={() => {
                    addTab(type);
                    closeMenu();
                  }}
                >
                  <span className="tab-icon">{TAB_META[type].icon}</span>
                  {TAB_META[type].label}
                </div>
              ))}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

/** Split the focused pane (right-aligned in the tab bar). Works in single mode
 *  too — the sole pane is always focused. */
function SplitPicker() {
  const focusedLeaf = useTabStore((s) => s.split.focusedLeaf);
  const splitPane = useTabStore((s) => s.splitPane);
  return (
    <div className="split-picker">
      <button
        className="split-preset"
        title="Split left / right"
        onClick={() => splitPane(focusedLeaf, 'row')}
      >
        ◫
      </button>
      <button
        className="split-preset"
        title="Split top / bottom"
        onClick={() => splitPane(focusedLeaf, 'col')}
      >
        ⊟
      </button>
    </div>
  );
}
