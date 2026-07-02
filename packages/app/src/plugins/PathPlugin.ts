/**
 * Path display plugin (§10). Draws a `wv/Path` as a polyline through its poses,
 * colored by the path's own RGBA, anchored to its frame via the shared TF tree.
 */

import * as THREE from 'three';
import type { Path } from '@webviz/protocol';
import type { DisplayPlugin, PluginContext, PluginFactory, PropSchema } from '../core/plugin.js';

interface Settings {
  channel: string;
}

export class PathPlugin implements DisplayPlugin {
  readonly type = 'Path';
  name = 'Path';
  enabled = true;

  private ctx!: PluginContext;
  private settings: Settings;
  private geometry = new THREE.BufferGeometry();
  private material = new THREE.LineBasicMaterial({ color: 0x33ccff });
  private line: THREE.Line | null = null;
  private frameId = '';
  private unsub: (() => void) | null = null;
  private unsubChannelList: (() => void) | null = null;
  /** Reused position buffer/attribute — grown only when a path needs more room,
   * so a re-published path doesn't allocate a fresh typed array every frame. */
  private posBuf = new Float32Array(0);
  private posAttr: THREE.BufferAttribute | null = null;

  constructor(
    readonly id: string,
    initial?: Record<string, unknown>,
  ) {
    this.settings = { channel: '', ...(initial as Partial<Settings> | undefined) };
  }

  async initialize(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    this.line = new THREE.Line(this.geometry, this.material);
    this.line.frustumCulled = false;
    ctx.scene.addObject(this.id, this.line);
    this.unsubChannelList = ctx.hub.onChannelList(() => this.syncSubscription());
    this.syncSubscription();
  }

  private syncSubscription(): void {
    if (!this.settings.channel) {
      const first = this.ctx.hub.getChannels().find((c) => c.schema === 'wv/Path')?.name;
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
      this.update(m.data as Path);
    });
  }

  private update(path: Path): void {
    this.frameId = path.frame_id;
    const n = path.poses.length;
    if (this.posBuf.length < n * 3) {
      this.posBuf = new Float32Array(n * 3);
      this.posAttr = new THREE.BufferAttribute(this.posBuf, 3);
      this.posAttr.setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute('position', this.posAttr);
    }
    const buf = this.posBuf;
    path.poses.forEach((p, i) => {
      buf[i * 3] = p.position[0];
      buf[i * 3 + 1] = p.position[1];
      buf[i * 3 + 2] = p.position[2];
    });
    if (this.posAttr) this.posAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, n);
    this.material.color.setRGB(path.color[0], path.color[1], path.color[2]);
    this.material.opacity = path.color[3];
    this.material.transparent = path.color[3] < 1;
    this.ctx.scene.requestRender();
  }

  onRender(): void {
    if (!this.line) return;
    const pose = this.frameId ? this.ctx.tf.resolveToFixed(this.frameId) : null;
    if (this.frameId && !pose) {
      this.line.visible = false;
      return;
    }
    this.line.visible = true;
    if (pose) {
      this.line.position.copy(pose.position);
      this.line.quaternion.copy(pose.quaternion);
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
            .filter((c) => c.schema === 'wv/Path')
            .map((c) => c.name) ?? [],
      },
    };
  }

  getSettings(): Record<string, unknown> {
    return { ...this.settings };
  }

  updateSettings(patch: Record<string, unknown>): void {
    this.settings = { ...this.settings, ...(patch as Partial<Settings>) };
    if ('channel' in patch) this.bind();
    this.ctx?.scene.requestRender();
  }

  destroy(): void {
    this.unsub?.();
    this.unsubChannelList?.();
    this.ctx?.scene.removeObject(this.id);
    this.geometry.dispose();
    this.material.dispose();
    this.line = null;
  }
}

export const pathFactory: PluginFactory = (id, initial) => new PathPlugin(id, initial);
