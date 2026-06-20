/**
 * TFManager (§8). Subscribes to every `wv/Transform` / `wv/TransformArray`
 * channel, keeps a 5-second rolling buffer of stamped transforms per frame, and
 * resolves frame poses into the fixed frame for plugins.
 *
 * Interpolation between the two nearest buffered samples uses SLERP for rotation
 * and LERP for translation (§8) — nearest-neighbour stepping is avoided.
 *
 * This is a shared singleton: the TF tree is common to all tabs (§9.4).
 */

import * as THREE from 'three';
import type { Transform } from '@webviz/protocol';
import { hubClient } from '../protocol/HubClient.js';
import type { RoutedMessage } from '../protocol/MessageRouter.js';

const BUFFER_SECONDS = 5;

interface Sample {
  t: number; // timestamp (seconds)
  parent: string;
  translation: THREE.Vector3;
  rotation: THREE.Quaternion;
}

export interface ResolvedPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export class TFManager {
  private buffers = new Map<string, Sample[]>();
  private subscribed = new Set<string>();
  private unsubs = new Map<string, () => void>();
  private fixedFrame = 'odom';
  private listeners = new Set<() => void>();

  constructor() {
    // Subscribe to transform channels as they appear.
    hubClient.onChannelList(() => this.syncSubscriptions());
    this.syncSubscriptions();
  }

  private syncSubscriptions(): void {
    for (const ch of hubClient.getChannels()) {
      const isTf =
        ch.schema === 'wv/Transform' || ch.schema === 'wv/TransformArray';
      if (isTf && !this.subscribed.has(ch.name)) {
        this.subscribed.add(ch.name);
        const unsub = hubClient.subscribe(ch.name, (m) => this.ingest(m));
        this.unsubs.set(ch.name, unsub);
      }
    }
  }

  private ingest(msg: RoutedMessage): void {
    if (msg.binary) return;
    const data = msg.data;
    const list: Transform[] = Array.isArray(data)
      ? (data as Transform[])
      : [data as Transform];
    for (const tf of list) {
      if (!tf || !tf.frame_id) continue;
      this.addSample(tf, msg.timestamp);
    }
    this.notify();
  }

  private addSample(tf: Transform, t: number): void {
    let buf = this.buffers.get(tf.frame_id);
    if (!buf) {
      buf = [];
      this.buffers.set(tf.frame_id, buf);
    }
    buf.push({
      t,
      parent: tf.parent_frame_id,
      translation: new THREE.Vector3(...tf.translation),
      rotation: new THREE.Quaternion(...tf.rotation),
    });
    // Keep sorted by time (frames usually arrive in order; guard anyway).
    if (buf.length > 1 && buf[buf.length - 2].t > t) {
      buf.sort((a, b) => a.t - b.t);
    }
    // Drop samples older than the rolling window.
    const cutoff = buf[buf.length - 1].t - BUFFER_SECONDS;
    while (buf.length > 1 && buf[0].t < cutoff) buf.shift();
  }

  setFixedFrame(frame: string): void {
    this.fixedFrame = frame;
    this.notify();
  }

  getFixedFrame(): string {
    return this.fixedFrame;
  }

  /** All known frames (children and referenced parents). */
  getFrameList(): string[] {
    const frames = new Set<string>();
    for (const [child, buf] of this.buffers) {
      frames.add(child);
      if (buf.length) frames.add(buf[buf.length - 1].parent);
    }
    return [...frames].sort();
  }

  /** Interpolated transform of `frameId` relative to its parent at `time`. */
  lookupTransform(frameId: string, time?: number): Sample | null {
    const buf = this.buffers.get(frameId);
    if (!buf || buf.length === 0) return null;
    return this.interpolate(buf, time);
  }

  /**
   * Resolve `frameId`'s pose expressed in the current fixed frame by composing
   * the parent chain. Returns null if any link in the chain is unknown.
   */
  resolveToFixed(frameId: string, time?: number): ResolvedPose | null {
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    let current = frameId;
    const visited = new Set<string>();

    while (current !== this.fixedFrame) {
      if (visited.has(current)) return null; // cycle guard
      visited.add(current);

      const sample = this.lookupTransform(current, time);
      if (!sample) return null;

      // p_parent = R * p_current + t ; orientation_parent = R * orientation_current
      position.applyQuaternion(sample.rotation).add(sample.translation);
      quaternion.premultiply(sample.rotation);
      current = sample.parent;
    }
    return { position, quaternion };
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  private interpolate(buf: Sample[], time?: number): Sample {
    const latest = buf[buf.length - 1];
    if (time === undefined || buf.length === 1 || time >= latest.t) {
      return latest;
    }
    if (time <= buf[0].t) return buf[0];

    // Find the bracketing pair [a, b] with a.t <= time <= b.t.
    let lo = 0;
    let hi = buf.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (buf[mid].t <= time) lo = mid;
      else hi = mid;
    }
    const a = buf[lo];
    const b = buf[hi];
    const span = b.t - a.t;
    const alpha = span > 0 ? (time - a.t) / span : 0;

    const translation = a.translation.clone().lerp(b.translation, alpha);
    const rotation = a.rotation.clone().slerp(b.rotation, alpha);
    return { t: time, parent: b.parent, translation, rotation };
  }
}

/** Shared singleton — the TF tree is common to all tabs (§9.4). */
export const tfManager = new TFManager();
