/**
 * Workspace view: the tiling panel layout (§9.2).
 *
 * Panes are rendered as a **flat, absolutely-positioned list keyed by leaf id** —
 * the split tree is walked only to compute each pane's rectangle (and the
 * dividers between them). This is deliberate: keeping each pane at a stable
 * position in the React child list means splitting / closing / maximizing only
 * changes rectangles, never a pane's place in the tree, so React never unmounts
 * a pane (and its `SceneManager` + loaded robot) just because the layout around
 * it changed. There is no tab bar — "switch between whole setups" is named
 * layouts. An empty pane shows a picker to choose its content.
 */

import { useRef } from 'react';
import { useTabStore, TAB_META, type TabType } from '../store/tabs.store.js';
import type { SplitNode, LeafNode, SplitDir } from '../store/tabs.store.js';
import { TabRenderer } from '../tabs/TabRenderer.js';
import { TabErrorBoundary } from './TabErrorBoundary.js';
import { Icon } from './icons.js';

const PANEL_TYPES: TabType[] = ['3d', 'image', 'plot', 'map', 'inspector', 'log'];
const DIVIDER_PX = 6;

/** A rectangle in workspace percentages (0–100). */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface PaneBox {
  leaf: LeafNode;
  rect: Rect;
}
interface DividerBox {
  branchId: string;
  dir: SplitDir;
  /** The branch's own rect, for mapping a drag back to a fraction. */
  branch: Rect;
  frac: number;
}

function childRects(rect: Rect, dir: SplitDir, frac: number): [Rect, Rect] {
  if (dir === 'row') {
    return [
      { x: rect.x, y: rect.y, w: rect.w * frac, h: rect.h },
      { x: rect.x + rect.w * frac, y: rect.y, w: rect.w * (1 - frac), h: rect.h },
    ];
  }
  return [
    { x: rect.x, y: rect.y, w: rect.w, h: rect.h * frac },
    { x: rect.x, y: rect.y + rect.h * frac, w: rect.w, h: rect.h * (1 - frac) },
  ];
}

/** Walk the tree into a flat list of pane + divider rectangles. */
function layout(
  node: SplitNode,
  rect: Rect,
  panes: PaneBox[],
  dividers: DividerBox[],
): void {
  if (node.type === 'leaf') {
    panes.push({ leaf: node, rect });
    return;
  }
  dividers.push({ branchId: node.id, dir: node.dir, branch: rect, frac: node.frac });
  const [a, b] = childRects(rect, node.dir, node.frac);
  layout(node.a, a, panes, dividers);
  layout(node.b, b, panes, dividers);
}

export function WorkspaceView() {
  const root = useTabStore((s) => s.split.root);
  const maximized = useTabStore((s) => s.split.maximized);
  const setSplitFrac = useTabStore((s) => s.setSplitFrac);
  const rootRef = useRef<HTMLDivElement>(null);

  const panes: PaneBox[] = [];
  const dividers: DividerBox[] = [];
  layout(root, { x: 0, y: 0, w: 100, h: 100 }, panes, dividers);
  const maxActive = maximized != null && panes.some((p) => p.leaf.id === maximized);

  const startDrag = (e: React.PointerEvent, d: DividerBox) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const root = rootRef.current?.getBoundingClientRect();
      if (!root) return;
      const frac =
        d.dir === 'row'
          ? (ev.clientX - (root.left + (d.branch.x / 100) * root.width)) /
            ((d.branch.w / 100) * root.width)
          : (ev.clientY - (root.top + (d.branch.y / 100) * root.height)) /
            ((d.branch.h / 100) * root.height);
      setSplitFrac(d.branchId, frac);
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
    <div className="split-root" ref={rootRef}>
      {panes.map(({ leaf, rect }) => {
        const isMax = maxActive && leaf.id === maximized;
        const box: Rect = isMax ? { x: 0, y: 0, w: 100, h: 100 } : rect;
        return (
          <div
            key={leaf.id}
            className="split-pane-host"
            style={{
              left: `${box.x}%`,
              top: `${box.y}%`,
              width: `${box.w}%`,
              height: `${box.h}%`,
              zIndex: isMax ? 5 : undefined,
            }}
          >
            <Pane leaf={leaf} />
          </div>
        );
      })}
      {!maxActive &&
        dividers.map((d) => {
          const bx = d.branch.x + d.branch.w * d.frac;
          const by = d.branch.y + d.branch.h * d.frac;
          const style: React.CSSProperties =
            d.dir === 'row'
              ? {
                  left: `${bx}%`,
                  top: `${d.branch.y}%`,
                  height: `${d.branch.h}%`,
                  width: DIVIDER_PX,
                  marginLeft: -DIVIDER_PX / 2,
                }
              : {
                  top: `${by}%`,
                  left: `${d.branch.x}%`,
                  width: `${d.branch.w}%`,
                  height: DIVIDER_PX,
                  marginTop: -DIVIDER_PX / 2,
                };
          return (
            <div
              key={d.branchId}
              className={`split-divider split-divider-${d.dir === 'row' ? 'col' : 'row'}`}
              style={style}
              onPointerDown={(e) => startDrag(e, d)}
            />
          );
        })}
    </div>
  );
}

function Pane({ leaf }: { leaf: LeafNode }) {
  const tabs = useTabStore((s) => s.tabs);
  const focusedLeaf = useTabStore((s) => s.split.focusedLeaf);
  const maximized = useTabStore((s) => s.split.maximized);
  const setPaneType = useTabStore((s) => s.setPaneType);
  const focusPane = useTabStore((s) => s.focusPane);
  const splitPane = useTabStore((s) => s.splitPane);
  const closePane = useTabStore((s) => s.closePane);
  const toggleMaximize = useTabStore((s) => s.toggleMaximize);

  const focused = focusedLeaf === leaf.id;
  const isMax = maximized === leaf.id;
  const tab = tabs.find((t) => t.id === leaf.tabId) ?? null;

  return (
    <div
      className={`split-pane ${focused ? 'split-pane-focused' : ''}`}
      data-tabtype={tab?.type}
      onPointerDown={() => {
        if (!focused) focusPane(leaf.id);
      }}
    >
      <div className="split-pane-header">
        <select
          className="split-pane-select"
          value={tab?.type ?? ''}
          onChange={(e) => setPaneType(leaf.id, e.target.value as TabType)}
          title="Panel type"
        >
          <option value="" disabled>
            Choose panel…
          </option>
          {PANEL_TYPES.map((t) => (
            <option key={t} value={t}>
              {TAB_META[t].label}
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
          className="split-pane-btn"
          title={isMax ? 'Restore' : 'Maximize'}
          onClick={(e) => {
            e.stopPropagation();
            toggleMaximize(leaf.id);
          }}
        >
          {isMax ? '⤡' : '⤢'}
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
          <TabErrorBoundary>
            <TabRenderer tab={tab} />
          </TabErrorBoundary>
        ) : (
          <PanelPicker onPick={(t) => setPaneType(leaf.id, t)} />
        )}
      </div>
    </div>
  );
}

function PanelPicker({ onPick }: { onPick: (t: TabType) => void }) {
  return (
    <div className="panel-picker">
      <div className="panel-picker-title eyebrow">Choose a panel</div>
      <div className="panel-picker-grid">
        {PANEL_TYPES.map((t) => (
          <button
            key={t}
            className="panel-picker-item"
            data-tabtype={t}
            onClick={() => onPick(t)}
          >
            <Icon name={TAB_META[t].icon} size={20} />
            {TAB_META[t].label}
          </button>
        ))}
      </div>
    </div>
  );
}
