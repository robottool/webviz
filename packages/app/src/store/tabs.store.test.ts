/**
 * Tests for the workspace split-tree validation/GC helpers — the pure layer
 * behind the tiling-panel store. These guard the invariants a corrupt
 * persisted layout (or a pre-pivot config) must not break.
 */

import { describe, expect, it } from 'vitest';
import {
  gcPanels,
  sanitizeSplit,
  type SplitBranch,
  type SplitNode,
  type TabConfig,
} from './tabs.store.js';

const tab = (id: string): TabConfig => ({
  id,
  name: 'Inspector',
  type: 'inspector',
  pinned: false,
  icon: 'search',
  settings: {},
});

const leaf = (id: string, tabId: string | null): SplitNode => ({
  type: 'leaf',
  id,
  tabId,
});

describe('sanitizeSplit', () => {
  it('accepts a valid tree unchanged', () => {
    const raw = {
      root: {
        type: 'split',
        id: 's1',
        dir: 'row',
        frac: 0.3,
        a: leaf('l1', 't1'),
        b: leaf('l2', null),
      },
      focusedLeaf: 'l2',
      maximized: null,
    };
    const out = sanitizeSplit(raw, [tab('t1')]);
    expect(out.root).toEqual(raw.root);
    expect(out.focusedLeaf).toBe('l2');
    expect(out.maximized).toBeNull();
  });

  it('drops stale tab ids to null (empty pane)', () => {
    const out = sanitizeSplit({ root: leaf('l1', 'gone') }, []);
    expect(out.root).toEqual(leaf('l1', null));
  });

  it('clamps out-of-range fracs to 0.5 and defaults bad dirs to row', () => {
    const raw = {
      root: {
        type: 'split',
        id: 's1',
        dir: 'diagonal',
        frac: 0.01,
        a: leaf('l1', null),
        b: leaf('l2', null),
      },
    };
    const root = sanitizeSplit(raw, []).root as SplitBranch;
    expect(root.frac).toBe(0.5);
    expect(root.dir).toBe('row');
  });

  it('collapses a split with one broken side to the surviving side', () => {
    const raw = {
      root: {
        type: 'split',
        id: 's1',
        dir: 'row',
        frac: 0.5,
        a: leaf('l1', 't1'),
        b: 'garbage',
      },
    };
    const out = sanitizeSplit(raw, [tab('t1')]);
    expect(out.root).toEqual(leaf('l1', 't1'));
  });

  it('falls back to one pane on unusable input, bound to the first panel', () => {
    for (const raw of [null, 42, 'nope', { root: { type: 'wat' } }]) {
      const out = sanitizeSplit(raw, [tab('t1')]);
      expect(out.root.type).toBe('leaf');
      expect((out.root as { tabId: string | null }).tabId).toBe('t1');
      expect(out.focusedLeaf).toBe(out.root.id);
    }
  });

  it('rejects focusedLeaf/maximized ids that are not in the tree', () => {
    const out = sanitizeSplit(
      { root: leaf('l1', null), focusedLeaf: 'nope', maximized: 'nope' },
      [],
    );
    expect(out.focusedLeaf).toBe('l1');
    expect(out.maximized).toBeNull();
  });
});

describe('gcPanels', () => {
  it('keeps only panels some pane still owns', () => {
    const root: SplitNode = {
      type: 'split',
      id: 's1',
      dir: 'row',
      frac: 0.5,
      a: leaf('l1', 't1'),
      b: leaf('l2', null),
    };
    const kept = gcPanels([tab('t1'), tab('orphan')], root);
    expect(kept.map((t) => t.id)).toEqual(['t1']);
  });
});
