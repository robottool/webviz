/**
 * Connection store: mirrors the HubClient's status + channel list into React
 * state so components re-render on change. The HubClient itself remains the
 * source of truth and owns the socket.
 */

import { create } from 'zustand';
import type { ChannelInfo } from '@webviz/protocol';
import { hubClient, type ConnectionStatus } from '../protocol/HubClient.js';
import { persistedHubUrl } from './settings.store.js';

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

// Derive the hub host from the page's own host so the app connects back to the
// machine that served it — works whether that's localhost, a VM's IP, or a
// port-forwarded host. Mirrors the RobotModel asset-host derivation. Override
// explicitly with VITE_HUB_URL when the hub lives elsewhere.
const hubHost =
  typeof location !== 'undefined' && location.hostname
    ? location.hostname
    : 'localhost';

const DEFAULT_URL =
  (import.meta.env.VITE_HUB_URL as string | undefined) ??
  `ws://${hubHost}:7777?role=client`;

/** The auto-derived hub URL used when no explicit URL is set (⚙ Settings blank).
 * Exported so the settings "Connect" control can target it. */
export const autoHubUrl = DEFAULT_URL;

// A persisted hub URL (⚙ settings) wins over the auto-derived default.
const INITIAL_URL = persistedHubUrl() || DEFAULT_URL;

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
