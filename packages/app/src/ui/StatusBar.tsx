/** Status bar (§11.1): channel count, connection status, wall clock. */

import { useEffect, useState } from 'react';
import { useConnectionStore, STATUS_LABEL } from '../store/connection.store.js';
import { Icon } from './icons.js';

export function StatusBar() {
  const { channels, status } = useConnectionStore();
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="statusbar">
      <span>
        <Icon name="broadcast" />
        <span className="readout">{channels.length}</span> channels
      </span>
      <span>
        <Icon name="plug" />
        {STATUS_LABEL[status] ?? status}
      </span>
      <div className="spacer" />
      <span className="readout">
        <Icon name="clock" />
        {clock.toLocaleTimeString()}
      </span>
    </div>
  );
}
