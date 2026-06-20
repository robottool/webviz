/**
 * Placeholder renderer for tab types not yet implemented in the vertical slice
 * (3D, Image, Plot, Map, Log). Keeps the tab system fully navigable and makes
 * the remaining work explicit in the UI.
 */

import type { TabType } from '../store/tabs.store.js';

const NOTES: Partial<Record<TabType, string>> = {
  '3d': 'Three.js viewport + Displays/Properties panels + display plugins.',
  image: 'N×M grid of wv/Image canvases with per-cell channel binding.',
  plot: 'Recharts time-series with channel/field selector and time window.',
  map: 'Orthographic occupancy-grid canvas with robot + path overlays.',
  log: 'Filtered event stream with level toggles and text search.',
};

export function PlaceholderTab({ type }: { type: TabType }) {
  return (
    <div className="placeholder">
      <div className="placeholder-card">
        <h2>{type.toUpperCase()} tab</h2>
        <p>Not yet implemented in this vertical slice.</p>
        <p className="muted">{NOTES[type]}</p>
        <p className="muted">
          The protocol, hub, connection, and tab system are all in place — this
          renderer is the next build target.
        </p>
      </div>
    </div>
  );
}
