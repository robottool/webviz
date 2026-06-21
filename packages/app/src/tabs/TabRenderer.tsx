/**
 * Dispatches a tab to its renderer based on type (the TabRegistry of §9). New
 * tab types register here.
 */

import type { TabConfig } from '../store/tabs.store.js';
import { InspectorTab } from './InspectorTab.js';
import { ThreeDTab } from './ThreeDTab.js';
import { ImageTab } from './ImageTab.js';
import { PlaceholderTab } from './PlaceholderTab.js';

export function TabRenderer({ tab }: { tab: TabConfig }) {
  switch (tab.type) {
    case 'inspector':
      return <InspectorTab tabId={tab.id} />;
    case '3d':
      return <ThreeDTab tabId={tab.id} />;
    case 'image':
      return <ImageTab tabId={tab.id} />;
    default:
      return <PlaceholderTab type={tab.type} />;
  }
}
