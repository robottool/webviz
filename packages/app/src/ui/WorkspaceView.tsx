/**
 * Workspace view: renders the split tree. A lone leaf is the active tab
 * full-bleed (single mode); a split tree renders recursively as nested flex
 * rows/columns with draggable dividers, each leaf a pane bound to a tab. A pure
 * consumer of the tab store's `split` tree; panes reuse `TabRenderer` +
 * `TabErrorBoundary` unchanged, so each tab mounts independently.
 */

import { useRef } from 'react';
import { useTabStore } from '../store/tabs.store.js';
import type { SplitNode, SplitBranch, LeafNode } from '../store/tabs.store.js';
import { TabRenderer } from '../tabs/TabRenderer.js';
import { TabErrorBoundary } from './TabErrorBoundary.js';

export function WorkspaceView() {
  const root = useTabStore((s) => s.split.root);
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);

  if (root.type === 'leaf') {
    const tab =
      tabs.find((t) => t.id === (root.tabId ?? activeTabId)) ?? tabs[0];
    return (
      <div className="tab-content">
        {tab && (
          <TabErrorBoundary key={tab.id}>
            <TabRenderer tab={tab} />
          </TabErrorBoundary>
        )}
      </div>
    );
  }

  return (
    <div className="split-root">
      <Node node={root} />
    </div>
  );
}

function Node({ node }: { node: SplitNode }) {
  return node.type === 'leaf' ? (
    <Pane leaf={node} />
  ) : (
    <Branch branch={node} />
  );
}

function Branch({ branch }: { branch: SplitBranch }) {
  const ref = useRef<HTMLDivElement>(null);
  const setSplitFrac = useTabStore((s) => s.setSplitFrac);
  const isRow = branch.dir === 'row';

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    // Capture on the divider so the drag survives moving over a pane's canvas.
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      const frac = isRow
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      setSplitFrac(branch.id, frac);
    };
    const up = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  return (
    <div
      className="split-branch"
      ref={ref}
      style={{ flexDirection: isRow ? 'row' : 'column' }}
    >
      <div className="split-child" style={{ flexGrow: branch.frac, flexBasis: 0 }}>
        <Node node={branch.a} />
      </div>
      <div
        className={`split-divider split-divider-${isRow ? 'col' : 'row'}`}
        onPointerDown={startDrag}
      />
      <div
        className="split-child"
        style={{ flexGrow: 1 - branch.frac, flexBasis: 0 }}
      >
        <Node node={branch.b} />
      </div>
    </div>
  );
}

function Pane({ leaf }: { leaf: LeafNode }) {
  const tabs = useTabStore((s) => s.tabs);
  const focusedLeaf = useTabStore((s) => s.split.focusedLeaf);
  const assignPane = useTabStore((s) => s.assignPane);
  const focusPane = useTabStore((s) => s.focusPane);
  const splitPane = useTabStore((s) => s.splitPane);
  const closePane = useTabStore((s) => s.closePane);

  const focused = focusedLeaf === leaf.id;
  const tab = tabs.find((t) => t.id === leaf.tabId) ?? null;

  return (
    <div
      className={`split-pane ${focused ? 'split-pane-focused' : ''}`}
      onPointerDown={() => {
        if (!focused) focusPane(leaf.id);
      }}
    >
      <div className="split-pane-header">
        <select
          className="split-pane-select"
          value={leaf.tabId ?? ''}
          onChange={(e) => assignPane(leaf.id, e.target.value || null)}
        >
          <option value="">— empty —</option>
          {tabs.map((t) => (
            <option key={t.id} value={t.id}>
              {t.icon} {t.name}
            </option>
          ))}
        </select>
        <button
          className="split-pane-btn"
          title="Split left / right"
          onClick={(e) => {
            e.stopPropagation();
            splitPane(leaf.id, 'row');
          }}
        >
          ◫
        </button>
        <button
          className="split-pane-btn"
          title="Split top / bottom"
          onClick={(e) => {
            e.stopPropagation();
            splitPane(leaf.id, 'col');
          }}
        >
          ⊟
        </button>
        <button
          className="split-pane-close"
          title="Close pane"
          onClick={(e) => {
            e.stopPropagation();
            closePane(leaf.id);
          }}
        >
          ×
        </button>
      </div>
      <div className="split-pane-body">
        {tab ? (
          <TabErrorBoundary key={`${leaf.id}:${tab.id}`}>
            <TabRenderer tab={tab} />
          </TabErrorBoundary>
        ) : (
          <div className="split-pane-empty">Pick a tab ▾</div>
        )}
      </div>
    </div>
  );
}
