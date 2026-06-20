/** Top bar (§11.1): brand, connection field + status, action icons. */

import { useState } from 'react';
import { useConnectionStore } from '../store/connection.store.js';

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
      <span className="icon-btn" title="Settings">⚙</span>
      <span className="icon-btn" title="Save layout">💾</span>
      <span className="icon-btn" title="Record">⏺</span>
    </div>
  );
}
