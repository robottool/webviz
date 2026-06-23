/**
 * Playback store: mirrors the `player` singleton's transport state into React so
 * the PlaybackBar re-renders as a recording plays. The `player` (which owns the
 * replay source socket + scheduler) remains the source of truth. Mirrors the
 * connection.store ↔ HubClient pattern.
 */

import { create } from 'zustand';
import { player, type PlayerState } from '../core/player.js';

export const usePlaybackStore = create<PlayerState>(() => player.getState());

// Push every player change into the store once at module load.
player.onChange(() => usePlaybackStore.setState(player.getState()));
