/**
 * RobotModel display plugin (§10). Consumes `wv/RobotModel` (URDF reference),
 * `wv/JointState` (joint angles), and the TF tree (root-link pose) to render an
 * articulated robot via `urdf-loader`.
 *
 * Pipeline:
 *   wv/RobotModel  → load URDF once → urdf-loader builds the link/joint tree
 *   wv/JointState  → setJointValues() each message
 *   TF (root link) → place the whole robot in the fixed frame each render
 *
 * Mesh resolution: the UR URDFs reference meshes as
 *   package://example-robot-data/robots/ur_description/meshes/...
 * which we rewrite to the hub asset server by anchoring on `ur_description/`,
 * so the exact package name in the URDF doesn't matter.
 */

import * as THREE from 'three';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import URDFLoader from 'urdf-loader';
import type { URDFRobot } from 'urdf-loader';
import type { JointState, RobotModel } from '@webviz/protocol';
import type {
  DisplayPlugin,
  PluginContext,
  PluginFactory,
  PropSchema,
} from '../core/plugin.js';

interface Settings {
  model_channel: string;
  joint_channel: string;
  root_frame: string;
  opacity: number;
}

/** Default hub HTTP asset base (the HTTP server runs on :8080). */
function defaultAssetBase(): string {
  const host =
    typeof location !== 'undefined' && location.hostname
      ? location.hostname
      : 'localhost';
  return `http://${host}:8080/assets`;
}

export class RobotModelPlugin implements DisplayPlugin {
  readonly type = 'RobotModel';
  name = 'Robot Model';
  enabled = true;

  private ctx!: PluginContext;
  private settings: Settings;
  private assetBase = defaultAssetBase();

  private robot: URDFRobot | null = null;
  private loadedUrdf = '';
  private loading = false;
  private latestJoints: JointState | null = null;
  private jointsDirty = false;

  private unsubModel: (() => void) | null = null;
  private unsubJoints: (() => void) | null = null;
  /** Re-evaluate channel subscriptions whenever the channel list changes. */
  private unsubChannelList: (() => void) | null = null;

  constructor(
    readonly id: string,
    initial?: Record<string, unknown>,
  ) {
    this.settings = {
      model_channel: '',
      joint_channel: '',
      root_frame: 'base_link',
      opacity: 1,
      ...(initial as Partial<Settings> | undefined),
    };
  }

  async initialize(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    this.unsubChannelList = ctx.hub.onChannelList(() => this.syncSubscriptions());
    this.syncSubscriptions();
  }

  /** Pick default channels (first of each schema) and (re)bind subscriptions. */
  private syncSubscriptions(): void {
    const channels = this.ctx.hub.getChannels();
    const firstOf = (schema: string) =>
      channels.find((c) => c.schema === schema)?.name ?? '';

    if (!this.settings.model_channel) {
      this.settings.model_channel = firstOf('wv/RobotModel');
    }
    if (!this.settings.joint_channel) {
      this.settings.joint_channel = firstOf('wv/JointState');
    }
    this.bindModel();
    this.bindJoints();
  }

  private bindModel(): void {
    this.unsubModel?.();
    this.unsubModel = null;
    const name = this.settings.model_channel;
    if (!name) return;
    this.unsubModel = this.ctx.hub.subscribe(name, (m) => {
      if (m.binary) return;
      void this.applyModel(m.data as RobotModel);
    });
  }

  private bindJoints(): void {
    this.unsubJoints?.();
    this.unsubJoints = null;
    const name = this.settings.joint_channel;
    if (!name) return;
    this.unsubJoints = this.ctx.hub.subscribe(name, (m) => {
      if (m.binary) return;
      this.latestJoints = m.data as JointState;
      this.jointsDirty = true;
      this.ctx.scene.requestRender();
    });
  }

  /** Load (or reload) the URDF described by a wv/RobotModel message. */
  private async applyModel(model: RobotModel): Promise<void> {
    const url = model.urdf_url ?? '';
    if (!url || url === this.loadedUrdf || this.loading) return;
    this.loading = true;
    try {
      const robot = await this.loadUrdf(url);
      this.robot = robot;
      this.loadedUrdf = url;
      this.applyOpacity();
      if (this.latestJoints) this.jointsDirty = true;
      this.ctx.scene.addObject(this.id, robot);
      this.ctx.scene.requestRender();
    } catch (err) {
      console.error('[RobotModel] failed to load URDF', url, err);
    } finally {
      this.loading = false;
    }
  }

  private loadUrdf(url: string): Promise<URDFRobot> {
    return new Promise((resolve, reject) => {
      const loader = new URDFLoader();
      // We do our own package resolution in loadMeshCb, anchored on a known
      // directory, so the URDF's declared package name is irrelevant.
      // The runtime signature is (path, manager, material, onComplete); the
      // shipped urdf-loader types omit `material`, so we type it ourselves and
      // cast past the outdated declaration.
      type MeshDone = (obj: THREE.Object3D | null, err?: unknown) => void;
      const loadMeshCb = (
        path: string,
        _manager: THREE.LoadingManager,
        material: THREE.Material | null,
        done: MeshDone,
      ) => {
        this.loadMesh(path, material ?? undefined)
          .then((obj) => {
            done(obj);
            // Meshes resolve asynchronously after the URDF parse completes;
            // nudge the scene so they appear even if nothing else is dirty.
            this.ctx.scene.requestRender();
          })
          .catch((err) => {
            console.error('[RobotModel] mesh load failed', path, err);
            // Keep the link tree intact with an empty placeholder.
            done(new THREE.Object3D(), err);
          });
      };
      loader.loadMeshCb = loadMeshCb as unknown as typeof loader.loadMeshCb;
      loader.load(
        url,
        (robot) => resolve(robot),
        undefined,
        (err) => reject(err),
      );
    });
  }

  /** Rewrite a URDF mesh path onto the hub asset server, then load it. */
  private async loadMesh(
    path: string,
    material?: THREE.Material,
  ): Promise<THREE.Object3D> {
    const url = this.resolveMeshUrl(path);
    const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
    if (ext === 'dae') {
      const dae = await new ColladaLoader().loadAsync(url);
      return dae.scene;
    }
    if (ext === 'stl') {
      const geom = await new STLLoader().loadAsync(url);
      const mat = material ?? new THREE.MeshPhongMaterial({ color: 0x9aa4b2 });
      return new THREE.Mesh(geom, mat);
    }
    if (ext === 'glb' || ext === 'gltf') {
      const gltf = await new GLTFLoader().loadAsync(url);
      return gltf.scene;
    }
    throw new Error(`Unsupported mesh format: ${ext} (${url})`);
  }

  private resolveMeshUrl(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    const marker = 'ur_description/';
    const idx = path.indexOf(marker);
    const rel = idx >= 0 ? path.slice(idx) : path.replace(/^package:\/\//, '');
    return `${this.assetBase}/${rel}`;
  }

  onRender(): void {
    if (!this.robot) return;
    if (this.jointsDirty && this.latestJoints) {
      this.applyJoints(this.latestJoints);
      this.jointsDirty = false;
    }
    this.placeInFixedFrame();
  }

  private applyJoints(js: JointState): void {
    if (!this.robot) return;
    for (let i = 0; i < js.names.length; i++) {
      const value = js.positions[i];
      if (value !== undefined) this.robot.setJointValue(js.names[i], value);
    }
  }

  /** Position the robot root at its TF pose in the current fixed frame. */
  private placeInFixedFrame(): void {
    if (!this.robot) return;
    const pose = this.ctx.tf.resolveToFixed(this.settings.root_frame);
    if (pose) {
      this.robot.position.copy(pose.position);
      this.robot.quaternion.copy(pose.quaternion);
    }
  }

  private applyOpacity(): void {
    if (!this.robot) return;
    const opacity = this.settings.opacity;
    this.robot.traverse((node) => {
      const mesh = node as THREE.Mesh;
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      const mats = Array.isArray(mat) ? mat : [mat];
      for (const m of mats) {
        m.transparent = opacity < 1;
        m.opacity = opacity;
      }
    });
  }

  getSchema(): PropSchema {
    const namesFor = (schema: string) => () =>
      this.ctx?.hub
        .getChannels()
        .filter((c) => c.schema === schema)
        .map((c) => c.name) ?? [];
    return {
      model_channel: {
        kind: 'enum',
        label: 'Model channel',
        default: '',
        options: namesFor('wv/RobotModel'),
      },
      joint_channel: {
        kind: 'enum',
        label: 'Joints channel',
        default: '',
        options: namesFor('wv/JointState'),
      },
      root_frame: { kind: 'string', label: 'Root frame', default: 'base_link' },
      opacity: {
        kind: 'number',
        label: 'Opacity',
        default: 1,
        min: 0,
        max: 1,
        step: 0.05,
      },
    };
  }

  getSettings(): Record<string, unknown> {
    return { ...this.settings };
  }

  updateSettings(patch: Record<string, unknown>): void {
    const prev = this.settings;
    this.settings = { ...prev, ...(patch as Partial<Settings>) };
    if ('model_channel' in patch) this.bindModel();
    if ('joint_channel' in patch) this.bindJoints();
    if ('opacity' in patch) this.applyOpacity();
    this.ctx?.scene.requestRender();
  }

  destroy(): void {
    this.unsubChannelList?.();
    this.unsubModel?.();
    this.unsubJoints?.();
    this.ctx?.scene.removeObject(this.id);
    this.robot = null;
  }
}

export const robotModelFactory: PluginFactory = (id, initial) =>
  new RobotModelPlugin(id, initial);
