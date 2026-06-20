/** Status bar (§11.1): channel count, connection status, wall clock. */

import { useEffect, useState } from 'react';
import { useConnectionStore } from '../store/connection.store.js';

export function StatusBar() {
  const { channels, status } = useConnectionStore();
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="statusbar">
      <span>📡 {channels.length} channels</span>
      <span>🔌 {status}</span>
      <div className="spacer" />
      <span>🕐 {clock.toLocaleTimeString()}</span>
    </div>
  );
}
