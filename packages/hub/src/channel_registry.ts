/**
 * Channel registry (§5). Assigns global channel ids, tracks which source owns
 * each channel, and resolves name collisions by prefixing with the source id.
 *
 * Sources address their own channels with a *local* id they pick (1, 2, 3, ...).
 * The hub maps `(sourceConnId, localId) -> globalId` so that ids are unique
 * across all simultaneously connected sources. Browser clients only ever see
 * global ids.
 */

import type { ChannelInfo, Encoding } from '@webviz/protocol';

export interface ChannelEntry extends ChannelInfo {
  /** Connection id of the owning source. */
  ownerConnId: string;
  /** The id the source uses locally to reference this channel. */
  localId: number;
  /** Bare (un-prefixed) advertised name, used for collision detection. */
  bareName: string;
}

export interface AdvertiseResult {
  channel: ChannelEntry;
  /** Other channels whose public name changed due to a new collision. */
  renamed: ChannelEntry[];
}

export class ChannelRegistry {
  private byGlobalId = new Map<number, ChannelEntry>();
  /** (ownerConnId → localId → entry) index for the per-frame `resolveLocal`
   * hot path, so relaying a data frame is O(1) rather than a scan of every
   * channel. Kept in sync with `byGlobalId` on advertise/unadvertise/remove. */
  private byOwner = new Map<string, Map<number, ChannelEntry>>();
  private nextGlobalId = 1;

  private index(entry: ChannelEntry): void {
    let owned = this.byOwner.get(entry.ownerConnId);
    if (!owned) {
      owned = new Map();
      this.byOwner.set(entry.ownerConnId, owned);
    }
    owned.set(entry.localId, entry);
  }

  private deindex(entry: ChannelEntry): void {
    const owned = this.byOwner.get(entry.ownerConnId);
    if (!owned) return;
    owned.delete(entry.localId);
    if (owned.size === 0) this.byOwner.delete(entry.ownerConnId);
  }

  advertise(
    ownerConnId: string,
    sourceId: string,
    localId: number,
    name: string,
    schema: string,
    encoding: Encoding,
    latched = false,
  ): AdvertiseResult {
    const renamed: ChannelEntry[] = [];

    // Find any existing channels sharing this bare name from *other* sources.
    const collisions = [...this.byGlobalId.values()].filter(
      (c) => c.bareName === name && c.ownerConnId !== ownerConnId,
    );

    let publicName = name;
    if (collisions.length > 0) {
      publicName = `${sourceId}/${name}`;
      // Prefix any colliding entry that is still using the bare name.
      for (const c of collisions) {
        if (c.name === c.bareName) {
          c.name = `${c.source_id ?? 'src'}/${c.bareName}`;
          renamed.push(c);
        }
      }
    }

    const entry: ChannelEntry = {
      id: this.nextGlobalId++,
      name: publicName,
      bareName: name,
      schema,
      encoding,
      source_id: sourceId,
      ownerConnId,
      localId,
      latched: latched || undefined,
    };
    this.byGlobalId.set(entry.id, entry);
    this.index(entry);
    return { channel: entry, renamed };
  }

  /** Resolve a source's local channel id to its global entry (O(1)). */
  resolveLocal(ownerConnId: string, localId: number): ChannelEntry | undefined {
    return this.byOwner.get(ownerConnId)?.get(localId);
  }

  get(globalId: number): ChannelEntry | undefined {
    return this.byGlobalId.get(globalId);
  }

  unadvertise(ownerConnId: string, name: string): ChannelEntry | undefined {
    const owned = this.byOwner.get(ownerConnId);
    if (owned) {
      for (const c of owned.values()) {
        if (c.bareName === name) {
          this.byGlobalId.delete(c.id);
          this.deindex(c);
          return c;
        }
      }
    }
    return undefined;
  }

  /** Remove and return all channels owned by a disconnected source. */
  removeBySource(ownerConnId: string): ChannelEntry[] {
    const owned = this.byOwner.get(ownerConnId);
    if (!owned) return [];
    const removed = [...owned.values()];
    for (const c of removed) this.byGlobalId.delete(c.id);
    this.byOwner.delete(ownerConnId);
    return removed;
  }

  list(): ChannelInfo[] {
    return [...this.byGlobalId.values()].map((c) => ({
      id: c.id,
      name: c.name,
      schema: c.schema,
      encoding: c.encoding,
      source_id: c.source_id,
      latched: c.latched,
    }));
  }
}
