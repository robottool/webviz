/**
 * PointCloud display plugin (§10) — the performance-critical one. Binary frames
 * are decoded in a WebWorker (off the main thread) into deinterleaved buffers;
 * the main thread only swaps them into a BufferGeometry and requests a render.
 *
 * Coloring (chosen by the cloud's fields, see `pointcloudDecode`):
 *   - RGB present       → per-point vertex colors
 *   - intensity present → colormap (viridis) over intensity, normalized per frame
 *   - xyz only          → colormap over z height
 *
 * The cloud is anchored to its own `frame_id` (carried in the payload) via the
 * shared TF tree each render, like the other 3D plugins.
 */

import * as THREE from 'three';
import type { DisplayPlugin, PluginContext, PluginFactory, PropSchema } from '../core/plugin.js';
import type { DecodedCloud } from '../core/pointcloudDecode.js';
import { makeColormapTexture } from '../core/colormap.js';

interface Settings {
  channel: string;
  point_size: number;
}

const VERT = /* glsl */ `
  attribute float scalar;
  uniform float uMin;
  uniform float uMax;
  uniform float uSize;
  varying float vT;
  void main() {
    vT = clamp((scalar - uMin) / max(uMax - uMin, 1e-6), 0.0, 1.0);
    gl_PointSize = uSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const FRAG = /* glsl */ `
  uniform sampler2D uColormap;
  varying float vT;
  void main() {
    gl_FragColor = texture2D(uColormap, vec2(vT, 0.5));
  }
`;

export class PointCloudPlugin implements DisplayPlugin {
  readonly type = 'PointCloud';
  name = 'Point Cloud';
  enabled = true;

  private ctx!: PluginContext;
  private settings: Settings;

  private worker: Worker | null = null;
  private geometry = new THREE.BufferGeometry();
  private points: THREE.Points | null = null;
  private colormap: THREE.DataTexture;
  private scalarMaterial: THREE.ShaderMaterial;
  private rgbMaterial: THREE.PointsMaterial;
  private frameId = '';

  private unsub: (() => void) | null = null;
  private unsubChannelList: (() => void) | null = null;

  constructor(
    readonly id: string,
    initial?: Record<string, unknown>,
  ) {
    this.settings = { channel: '', point_size: 3, ...(initial as Partial<Settings> | undefined) };
    this.colormap = makeColormapTexture();
    this.scalarMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColormap: { value: this.colormap },
        uMin: { value: 0 },
        uMax: { value: 1 },
        uSize: { value: this.settings.point_size },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      // Points are unlit; keep the viridis/intensity colours exact under the
      // studio theme's ACES tone mapping (which would otherwise desaturate them).
      toneMapped: false,
    });
    this.rgbMaterial = new THREE.PointsMaterial({
      size: this.settings.point_size,
      sizeAttenuation: false,
      vertexColors: true,
      // Preserve raw RGB point colours regardless of scene tone mapping.
      toneMapped: false,
    });
  }

  async initialize(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    this.worker = new Worker(new URL('./pointcloud.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<DecodedCloud>) => this.onDecoded(e.data);
    this.unsubChannelList = ctx.hub.onChannelList(() => this.syncSubscription());
    this.syncSubscription();
  }

  // --- channel binding ---

  private syncSubscription(): void {
    if (!this.settings.channel) {
      const first = this.ctx.hub.getChannels().find((c) => c.schema === 'wv/PointCloud')?.name;
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
      if (!m.binary || !this.worker) return;
      // Copy the payload out of the shared frame buffer (other subscribers may
      // still read it), then transfer that copy to the worker zero-copy.
      const copy = (m.data as Uint8Array).slice();
      this.worker.postMessage({ buffer: copy.buffer }, [copy.buffer]);
    });
  }

  // --- worker results ---

  private onDecoded(c: DecodedCloud): void {
    this.frameId = c.frameId;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
    if (c.colors) {
      this.geometry.setAttribute('color', new THREE.BufferAttribute(c.colors, 3));
      this.geometry.deleteAttribute('scalar');
      this.useMaterial(this.rgbMaterial);
    } else if (c.scalar) {
      this.geometry.setAttribute('scalar', new THREE.BufferAttribute(c.scalar, 1));
      this.geometry.deleteAttribute('color');
      this.scalarMaterial.uniforms.uMin.value = c.scalarMin;
      this.scalarMaterial.uniforms.uMax.value = c.scalarMax;
      this.useMaterial(this.scalarMaterial);
    }
    this.geometry.setDrawRange(0, c.pointCount);
    this.geometry.computeBoundingSphere();
    this.ctx.scene.requestRender();
  }

  private useMaterial(mat: THREE.Material): void {
    if (!this.points) {
      this.points = new THREE.Points(this.geometry, mat);
      this.points.frustumCulled = false;
      this.ctx.scene.addObject(this.id, this.points);
    } else if (this.points.material !== mat) {
      this.points.material = mat;
    }
  }

  // --- per-frame TF anchoring ---

  onRender(): void {
    if (!this.points) return;
    if (!this.frameId) {
      this.points.visible = true;
      this.points.position.set(0, 0, 0);
      this.points.quaternion.identity();
      return;
    }
    const pose = this.ctx.tf.resolveToFixed(this.frameId);
    if (!pose) {
      this.points.visible = false;
      return;
    }
    this.points.visible = true;
    this.points.position.copy(pose.position);
    this.points.quaternion.copy(pose.quaternion);
  }

  // --- DisplayPlugin contract ---

  getSchema(): PropSchema {
    return {
      channel: {
        kind: 'enum',
        label: 'Channel',
        default: '',
        options: () =>
          this.ctx?.hub
            .getChannels()
            .filter((c) => c.schema === 'wv/PointCloud')
            .map((c) => c.name) ?? [],
      },
      point_size: { kind: 'number', label: 'Point size', default: 3, min: 1, max: 20, step: 1 },
    };
  }

  getSettings(): Record<string, unknown> {
    return { ...this.settings };
  }

  updateSettings(patch: Record<string, unknown>): void {
    this.settings = { ...this.settings, ...(patch as Partial<Settings>) };
    if ('channel' in patch) this.bind();
    if ('point_size' in patch) {
      this.scalarMaterial.uniforms.uSize.value = this.settings.point_size;
      this.rgbMaterial.size = this.settings.point_size;
    }
    this.ctx?.scene.requestRender();
  }

  destroy(): void {
    this.unsub?.();
    this.unsubChannelList?.();
    this.worker?.terminate();
    this.worker = null;
    this.ctx?.scene.removeObject(this.id);
    this.geometry.dispose();
    this.scalarMaterial.dispose();
    this.rgbMaterial.dispose();
    this.colormap.dispose();
    this.points = null;
  }
}

export const pointCloudFactory: PluginFactory = (id, initial) => new PointCloudPlugin(id, initial);
