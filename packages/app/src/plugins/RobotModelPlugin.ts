/**
 * RobotModel display plugin (§10). Renders an articulated robot via
 * `urdf-loader`, with two independently switchable input sources:
 *
 *   URDF   : a local folder of files (preview) OR a `wv/RobotModel` channel
 *   joints : manual sliders (preview) OR a `wv/JointState` channel
 *   pose   : manual base-pose inputs (preview) OR the TF tree (`wv/Transform`)
 *
 * The intended flow: load a URDF from disk, validate it with manual joint
 * sliders + a base-pose input, then — once the live pipeline is publishing —
 * switch each source over to its channel. Manual mode is preview-only; it never
 * publishes.
 *
 * Mesh resolution: remote (channel) URDFs load meshes from the hub asset server
 * (`/assets/...`); local URDFs resolve meshes to blob URLs from the picked file
 * set (see `LocalAssetResolver`).
 */

import * as THREE from 'three';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import URDFLoader from 'urdf-loader';
import type { URDFRobot } from 'urdf-loader';
import type { JointState, RobotModel } from '@webviz/protocol';
import type { DisplayPlugin, PluginContext, PluginFactory, PropSchema } from '../core/plugin.js';
import { LocalAssetResolver } from '../core/meshResolver.js';

export type Source = 'channel' | 'manual';
export type UrdfSource = 'channel' | 'local';

export interface JointInfo {
  name: string;
  type: URDFRobot['joints'][string]['jointType'];
  lower: number;
  upper: number;
}

export interface ValidationReport {
  loaded: boolean;
  robotName: string;
  jointInfo: JointInfo[];
  meshTotal: number;
  meshLoaded: number;
  meshFailed: string[];
  error: string | null;
}

interface ManualPose {
  xyz: [number, number, number];
  rpy: [number, number, number];
}

interface Settings {
  urdf_source: UrdfSource;
  joint_source: Source;
  pose_source: Source;
  model_channel: string;
  joint_channel: string;
  root_frame: string;
  opacity: number;
  manual_joints: Record<string, number>;
  manual_pose: ManualPose;
}

function defaultAssetBase(): string {
  const host =
    typeof location !== 'undefined' && location.hostname ? location.hostname : 'localhost';
  return `http://${host}:8080/assets`;
}

function emptyReport(): ValidationReport {
  return {
    loaded: false,
    robotName: '',
    jointInfo: [],
    meshTotal: 0,
    meshLoaded: 0,
    meshFailed: [],
    error: null,
  };
}

function basename(p: string): string {
  return p.split(/[?#]/)[0].split(/[\\/]/).pop() ?? p;
}

function extOf(p: string): string {
  return basename(p).split('.').pop()?.toLowerCase() ?? '';
}

export class RobotModelPlugin implements DisplayPlugin {
  readonly type = 'RobotModel';
  name = 'Robot Model';
  enabled = true;

  private ctx!: PluginContext;
  private settings: Settings;
  private assetBase = defaultAssetBase();

  private robot: URDFRobot | null = null;
  private loadedKey = '';
  private loading = false;
  private report: ValidationReport = emptyReport();
  private localResolver: LocalAssetResolver | null = null;

  private latestJoints: JointState | null = null;
  private jointsDirty = false;
  private manualDirty = false;

  private unsubModel: (() => void) | null = null;
  private unsubJoints: (() => void) | null = null;
  private unsubChannelList: (() => void) | null = null;
  private changeCbs = new Set<() => void>();

  constructor(
    readonly id: string,
    initial?: Record<string, unknown>,
  ) {
    this.settings = {
      // Default to channels so a published robot auto-displays with no config;
      // loading a local folder flips joints/pose to manual preview (below).
      urdf_source: 'channel',
      joint_source: 'channel',
      pose_source: 'channel',
      model_channel: '',
      joint_channel: '',
      root_frame: 'base_link',
      opacity: 1,
      manual_joints: {},
      manual_pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] },
      ...(initial as Partial<Settings> | undefined),
    };
  }

  async initialize(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    this.unsubChannelList = ctx.hub.onChannelList(() => this.syncSubscriptions());
    this.syncSubscriptions();
  }

  // --- change notifications (drive the Properties UI) ---

  onChange(cb: () => void): () => void {
    this.changeCbs.add(cb);
    return () => this.changeCbs.delete(cb);
  }

  private emitChange(): void {
    for (const cb of this.changeCbs) cb();
  }

  getReport(): ValidationReport {
    return this.report;
  }

  // --- channel subscriptions ---

  private syncSubscriptions(): void {
    const channels = this.ctx.hub.getChannels();
    const firstOf = (schema: string) => channels.find((c) => c.schema === schema)?.name ?? '';
    if (!this.settings.model_channel) this.settings.model_channel = firstOf('wv/RobotModel');
    if (!this.settings.joint_channel) this.settings.joint_channel = firstOf('wv/JointState');
    this.bindModel();
    this.bindJoints();
  }

  private bindModel(): void {
    this.unsubModel?.();
    this.unsubModel = null;
    const name = this.settings.model_channel;
    if (!name) return;
    this.unsubModel = this.ctx.hub.subscribe(name, (m) => {
      if (m.binary || this.settings.urdf_source !== 'channel') return;
      void this.loadFromChannel(m.data as RobotModel);
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
      if (this.settings.joint_source === 'channel') {
        this.jointsDirty = true;
        this.ctx.scene.requestRender();
      }
    });
  }

  // --- loading ---

  /** Load a URDF from a locally-picked folder (the file list of an <input>). */
  async loadFromFiles(files: File[]): Promise<void> {
    const urdfFile = files.find(
      (f) => /\.urdf$/i.test(f.name) || /\.urdf$/i.test(f.webkitRelativePath),
    );
    if (!urdfFile) {
      this.report = { ...emptyReport(), error: 'No .urdf file in the selected folder' };
      this.emitChange();
      return;
    }
    // A local file has no live data, so preview it with manual joints + pose.
    this.settings.urdf_source = 'local';
    this.settings.joint_source = 'manual';
    this.settings.pose_source = 'manual';
    const text = await urdfFile.text();
    this.localResolver?.dispose();
    this.localResolver = new LocalAssetResolver(files);
    await this.loadRobot(
      () => this.buildLoader(this.localResolver ?? undefined).parse(text) as URDFRobot,
      `local:${urdfFile.webkitRelativePath || urdfFile.name}:${files.length}`,
    );
  }

  private async loadFromChannel(model: RobotModel): Promise<void> {
    const url = model.urdf_url ?? '';
    if (!url || `url:${url}` === this.loadedKey) return;
    await this.loadRobot(
      () =>
        new Promise<URDFRobot>((resolve, reject) => {
          this.buildLoader().load(url, resolve, undefined, reject);
        }),
      `url:${url}`,
    );
  }

  private async loadRobot(produce: () => URDFRobot | Promise<URDFRobot>, key: string): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.report = emptyReport();
    this.emitChange();
    try {
      const robot = await produce();
      this.setRobot(robot);
      this.loadedKey = key;
    } catch (err) {
      this.report.error = String(err);
      console.error('[RobotModel] load failed', err);
    } finally {
      this.loading = false;
      this.emitChange();
    }
  }

  /** A URDFLoader whose mesh callback loads + counts meshes for the report. */
  private buildLoader(resolver?: LocalAssetResolver): URDFLoader {
    const loader = new URDFLoader(resolver?.manager);
    type MeshDone = (obj: THREE.Object3D | null, err?: unknown) => void;
    const cb = (
      path: string,
      _manager: THREE.LoadingManager,
      material: THREE.Material | null,
      done: MeshDone,
    ) => {
      this.report.meshTotal++;
      this.loadMesh(path, material ?? undefined, resolver)
        .then((obj) => {
          this.report.meshLoaded++;
          done(obj);
          this.afterMesh();
        })
        .catch((err) => {
          this.report.meshFailed.push(basename(path));
          console.error('[RobotModel] mesh load failed', path, err);
          done(new THREE.Object3D(), err);
          this.afterMesh();
        });
    };
    loader.loadMeshCb = cb as unknown as typeof loader.loadMeshCb;
    return loader;
  }

  private afterMesh(): void {
    this.ctx.scene.requestRender();
    this.emitChange();
  }

  private async loadMesh(
    path: string,
    material: THREE.Material | undefined,
    resolver?: LocalAssetResolver,
  ): Promise<THREE.Object3D> {
    const ext = extOf(path);
    const manager = resolver?.manager;
    // Local: pass the raw path; the manager's URL modifier maps it (and any
    // sub-resources) to blob URLs. Remote: rewrite onto the hub asset server.
    const url = resolver ? path : this.resolveMeshUrl(path);
    if (ext === 'dae') {
      const dae = await new ColladaLoader(manager).loadAsync(url);
      return dae.scene;
    }
    if (ext === 'stl') {
      const geom = await new STLLoader(manager).loadAsync(url);
      return new THREE.Mesh(geom, material ?? new THREE.MeshPhongMaterial({ color: 0x9aa4b2 }));
    }
    if (ext === 'glb' || ext === 'gltf') {
      const gltf = await new GLTFLoader(manager).loadAsync(url);
      return gltf.scene;
    }
    throw new Error(`Unsupported mesh format: ${ext} (${path})`);
  }

  private resolveMeshUrl(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    // The UR meshes use package://example-robot-data/robots/ur_description/...;
    // anchor on a known dir so the declared package name doesn't matter.
    const marker = 'ur_description/';
    const idx = path.indexOf(marker);
    const rel = idx >= 0 ? path.slice(idx) : path.replace(/^package:\/\//, '');
    return `${this.assetBase}/${rel}`;
  }

  private setRobot(robot: URDFRobot): void {
    this.ctx.scene.removeObject(this.id);
    this.robot = robot;
    this.report.loaded = true;
    this.report.robotName = robot.robotName ?? '';
    this.report.jointInfo = this.computeJointInfo(robot);
    // Seed any joints we don't yet have a manual value for.
    for (const j of this.report.jointInfo) {
      if (!(j.name in this.settings.manual_joints)) {
        this.settings.manual_joints[j.name] = clamp(0, j.lower, j.upper);
      }
    }
    this.applyOpacity();
    this.manualDirty = true;
    this.jointsDirty = true;
    this.ctx.scene.addObject(this.id, robot);
    this.ctx.scene.requestRender();
  }

  private computeJointInfo(robot: URDFRobot): JointInfo[] {
    const out: JointInfo[] = [];
    for (const [name, j] of Object.entries(robot.joints)) {
      if (j.jointType === 'fixed') continue;
      let lower = j.limit?.lower ?? 0;
      let upper = j.limit?.upper ?? 0;
      if (j.jointType === 'continuous' || (lower === 0 && upper === 0)) {
        if (j.jointType === 'prismatic') {
          lower = -1;
          upper = 1;
        } else {
          lower = -Math.PI;
          upper = Math.PI;
        }
      }
      out.push({ name, type: j.jointType, lower, upper });
    }
    return out;
  }

  // --- per-frame application ---

  onRender(): void {
    if (!this.robot) return;
    if (this.settings.joint_source === 'manual') {
      if (this.manualDirty) {
        this.applyManualJoints();
        this.manualDirty = false;
      }
    } else if (this.jointsDirty && this.latestJoints) {
      this.applyJoints(this.latestJoints);
      this.jointsDirty = false;
    }
    if (this.settings.pose_source === 'manual') this.applyManualPose();
    else this.placeInFixedFrame();
  }

  private applyJoints(js: JointState): void {
    if (!this.robot) return;
    for (let i = 0; i < js.names.length; i++) {
      const v = js.positions[i];
      if (v !== undefined) this.robot.setJointValue(js.names[i], v);
    }
  }

  private applyManualJoints(): void {
    if (!this.robot) return;
    for (const [name, v] of Object.entries(this.settings.manual_joints)) {
      this.robot.setJointValue(name, v);
    }
  }

  private applyManualPose(): void {
    if (!this.robot) return;
    const { xyz, rpy } = this.settings.manual_pose;
    this.robot.position.set(xyz[0], xyz[1], xyz[2]);
    this.robot.quaternion.setFromEuler(new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX'));
  }

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
      const mat = (node as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) {
        m.transparent = opacity < 1;
        m.opacity = opacity;
      }
    });
  }

  // --- manual setters (called by the Properties UI) ---

  setManualJoint(name: string, value: number): void {
    this.settings.manual_joints[name] = value;
    if (this.settings.joint_source === 'manual') {
      this.manualDirty = true;
      this.ctx.scene.requestRender();
    }
  }

  setManualPose(patch: Partial<ManualPose>): void {
    this.settings.manual_pose = { ...this.settings.manual_pose, ...patch };
    this.ctx.scene.requestRender();
  }

  // --- DisplayPlugin contract ---

  /** RobotModel uses a custom Properties UI, so the schema form is unused. */
  getSchema(): PropSchema {
    return {};
  }

  getSettings(): Record<string, unknown> {
    return { ...this.settings };
  }

  updateSettings(patch: Record<string, unknown>): void {
    this.settings = { ...this.settings, ...(patch as Partial<Settings>) };
    if ('model_channel' in patch) this.bindModel();
    if ('joint_channel' in patch) this.bindJoints();
    if ('urdf_source' in patch) this.bindModel();
    if ('joint_source' in patch) {
      this.manualDirty = true;
      this.jointsDirty = true;
    }
    if ('opacity' in patch) this.applyOpacity();
    this.ctx?.scene.requestRender();
    this.emitChange();
  }

  destroy(): void {
    this.unsubChannelList?.();
    this.unsubModel?.();
    this.unsubJoints?.();
    this.localResolver?.dispose();
    this.ctx?.scene.removeObject(this.id);
    this.robot = null;
    this.changeCbs.clear();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export const robotModelFactory: PluginFactory = (id, initial) => new RobotModelPlugin(id, initial);
