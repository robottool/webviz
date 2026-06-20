/**
 * Connection store: mirrors the HubClient's status + channel list into React
 * state so components re-render on change. The HubClient itself remains the
 * source of truth and owns the socket.
 */

import { create } from 'zustand';
import type { ChannelInfo } from '@webviz/protocol';
import { hubClient, type ConnectionStatus } from '../protocol/HubClient.js';

interface ConnectionState {
  status: ConnectionStatus;
  url: string;
  channels: ChannelInfo[];
  connect: (url: string) => void;
  disconnect: () => void;
}

const DEFAULT_URL =
  (import.meta.env.VITE_HUB_URL as string | undefined) ??
  'ws://localhost:7777?role=client';

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  url: DEFAULT_URL,
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
