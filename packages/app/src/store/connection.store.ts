/**
 * Connection store: mirrors the HubClient's status + channel list into React
 * state so components re-render on change. The HubClient itself remains the
 * source of truth and owns the socket.
 */

import { create } from 'zustand';
import type { ChannelInfo } from '@webviz/protocol';
import { hubClient, type ConnectionStatus } from '../protocol/HubClient.js';
import { autoHubClientUrl, hubClientUrl } from '../core/hubUrl.js';

/** Human label for each connection status — one wording shared by the top bar
 * and status bar so the same state always reads the same. */
export const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'connecting…',
  connected: 'connected',
  disconnected: 'disconnected',
  error: 'error',
};

interface ConnectionState {
  status: ConnectionStatus;
  url: string;
  channels: ChannelInfo[];
  connect: (url: string) => void;
  disconnect: () => void;
}

// The hub base (scheme/host/port) is derived in one place — `core/hubUrl.ts` —
// so the client connection, playback source, and UI publisher source all agree
// (and pick `wss:` on an HTTPS page, and honor the ⚙ / VITE_HUB_URL override).

/** The auto-derived hub URL used when no explicit URL is set (⚙ Settings blank).
 * Exported so the settings "Connect" control can target it. */
export const autoHubUrl = autoHubClientUrl();

// A persisted hub URL (⚙ settings) wins over the auto-derived default.
const INITIAL_URL = hubClientUrl();

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  url: INITIAL_URL,
  channels: [],
  connect: (url: string) => {
    set({ url });
    hubClient.connect(url);
  },
  disconnect: () => hubClient.disconnect(),
}));

// Wire HubClient events into the store once at module load.
hubClient.onStatus((status) => useConnectionStore.setState({ status }));
hubClient.onChannelList((channels) =>
  useConnectionStore.setState({ channels: [...channels] }),
);
