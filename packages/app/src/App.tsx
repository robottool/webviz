/**
 * App shell (§11.1): top bar, tab bar, active tab content, status bar. Connects
 * to the hub on mount. All tabs share the single HubClient connection.
 */

import { useEffect } from 'react';
import { TopBar } from './ui/TopBar.js';
import { TabBar } from './ui/TabBar.js';
import { StatusBar } from './ui/StatusBar.js';
import { TabRenderer } from './tabs/TabRenderer.js';
import { useConnectionStore } from './store/connection.store.js';
import { useTabStore } from './store/tabs.store.js';

export function App() {
  const connect = useConnectionStore((s) => s.connect);
  const url = useConnectionStore((s) => s.url);
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);

  useEffect(() => {
    connect(url);
    // connect once on mount; reconnection is handled inside HubClient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  return (
    <div className="app">
      <TopBar />
      <TabBar />
      <div className="tab-content">
        {activeTab && <TabRenderer key={activeTab.id} tab={activeTab} />}
      </div>
      <StatusBar />
    </div>
  );
}
