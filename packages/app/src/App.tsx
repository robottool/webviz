/**
 * App shell (§11.1): top bar, the tiling panel workspace, transport + status
 * bars. Connects to the hub on mount. All panels share the one HubClient.
 */

import { useEffect } from 'react';
import { TopBar } from './ui/TopBar.js';
import { StatusBar } from './ui/StatusBar.js';
import { PlaybackBar } from './ui/PlaybackBar.js';
import { WorkspaceView } from './ui/WorkspaceView.js';
import { useConnectionStore } from './store/connection.store.js';

export function App() {
  const connect = useConnectionStore((s) => s.connect);
  const url = useConnectionStore((s) => s.url);

  useEffect(() => {
    connect(url);
    // connect once on mount; reconnection is handled inside HubClient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <TopBar />
      <WorkspaceView />
      <PlaybackBar />
      <StatusBar />
    </div>
  );
}
