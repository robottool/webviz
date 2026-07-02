/**
 * LaserScan display plugin (§10). Converts a polar `wv/LaserScan` to Cartesian
 * points (`THREE.Points`) in the scan frame and anchors them to that frame via
 * the shared TF tree. Out-of-range and non-finite (`"Inf"`) beams are dropped.
 */

import * as THREE from 'three';
import type { LaserScan } from '@webviz/protocol';
import type { DisplayPlugin, PluginContext, PluginFactory, PropSchema } from '../core/plugin.js';

interface Settings {
  channel: string;
  point_size: number;
}

export class LaserScanPlugin implements DisplayPlugin {
  readonly type = 'LaserScan';
  name = 'Laser Scan';
  enabled = true;

  private ctx!: PluginContext;
  private settings: Settings;
  private geometry = new THREE.BufferGeometry();
  private material: THREE.PointsMaterial;
  private points: THREE.Points | null = null;
  private frameId = '';
  private unsub: (() => void) | null = null;
  private unsubChannelList: (() => void) | null = null;
  /** Reused position buffer/attribute — grown only when a scan needs more room,
   * so a high-rate stream doesn't allocate a fresh typed array every frame. */
  private posBuf = new Float32Array(0);
  private posAttr: THREE.BufferAttribute | null = null;

  constructor(
    readonly id: string,
    initial?: Record<string, unknown>,
  ) {
    this.settings = { channel: '', point_size: 4, ...(initial as Partial<Settings> | undefined) };
    this.material = new THREE.PointsMaterial({
      color: 0xff7733,
      size: this.settings.point_size,
      sizeAttenuation: false,
    });
  }

  async initialize(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    ctx.scene.addObject(this.id, this.points);
    this.unsubChannelList = ctx.hub.onChannelList(() => this.syncSubscription());
    this.syncSubscription();
  }

  private syncSubscription(): void {
    if (!this.settings.channel) {
      const first = this.ctx.hub.getChannels().find((c) => c.schema === 'wv/LaserScan')?.name;
      if (first) this.settings.channel = first;
    }
    this.bind();
  }

  private bind(): void {
    this.unsub?.();
    this.unsub = null;
    const name = this.settings.channel;
    if (!name) return;
    this.unsub = this.ctx.hub.subscribe(name, (m) => {
      if (m.binary) return;
      this.update(m.data as LaserScan);
    });
  }

  private update(scan: LaserScan): void {
    this.frameId = scan.frame_id;
    const n = scan.ranges.length;
    // Grow (and re-bind the attribute) only when a scan needs more room than the
    // current buffer holds; otherwise write in place and flag it for re-upload.
    if (this.posBuf.length < n * 3) {
      this.posBuf = new Float32Array(n * 3);
      this.posAttr = new THREE.BufferAttribute(this.posBuf, 3);
      this.posAttr.setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute('position', this.posAttr);
    }
    const buf = this.posBuf;
    let w = 0;
    for (let i = 0; i < n; i++) {
      const r = scan.ranges[i];
      if (typeof r !== 'number' || !Number.isFinite(r)) continue;
      if (r < scan.range_min || r > scan.range_max) continue;
      const a = scan.angle_min + i * scan.angle_increment;
      buf[w++] = r * Math.cos(a);
      buf[w++] = r * Math.sin(a);
      buf[w++] = 0;
    }
    if (this.posAttr) this.posAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, w / 3);
    this.ctx.scene.requestRender();
  }

  onRender(): void {
    if (!this.points) return;
    const pose = this.frameId ? this.ctx.tf.resolveToFixed(this.frameId) : null;
    if (this.frameId && !pose) {
      this.points.visible = false;
      return;
    }
    this.points.visible = true;
    if (pose) {
      this.points.position.copy(pose.position);
      this.points.quaternion.copy(pose.quaternion);
    }
  }

  getSchema(): PropSchema {
    return {
      channel: {
        kind: 'enum',
        label: 'Channel',
        default: '',
        options: () =>
          this.ctx?.hub
            .getChannels()
            .filter((c) => c.schema === 'wv/LaserScan')
            .map((c) => c.name) ?? [],
      },
      point_size: { kind: 'number', label: 'Point size', default: 4, min: 1, max: 20, step: 1 },
    };
  }

  getSettings(): Record<string, unknown> {
    return { ...this.settings };
  }

  updateSettings(patch: Record<string, unknown>): void {
    this.settings = { ...this.settings, ...(patch as Partial<Settings>) };
    if ('channel' in patch) this.bind();
    if ('point_size' in patch) this.material.size = this.settings.point_size;
    this.ctx?.scene.requestRender();
  }

  destroy(): void {
    this.unsub?.();
    this.unsubChannelList?.();
    this.ctx?.scene.removeObject(this.id);
    this.geometry.dispose();
    this.material.dispose();
    this.points = null;
  }
}

export const laserScanFactory: PluginFactory = (id, initial) => new LaserScanPlugin(id, initial);
