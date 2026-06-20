/**
 * SceneManager (§8). Owns the Three.js scene, renderer, camera, OrbitControls,
 * and the requestAnimationFrame loop for one 3D tab. Plugins add/remove
 * Object3D instances through it. Renders are coalesced: the loop only draws when
 * something marked the scene dirty (a TF update, a settings change, or active
 * camera interaction), so an idle viewport costs nothing.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const UP_Z = new THREE.Vector3(0, 0, 1);

export class SceneManager {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  /** Root that holds plugin objects, oriented so +Z is up (robotics convention). */
  readonly root = new THREE.Group();

  private grid: THREE.GridHelper;
  private axes: THREE.AxesHelper;
  private objects = new Map<string, THREE.Object3D>();
  private renderCallbacks = new Set<(dt: number) => void>();

  private container: HTMLElement;
  private resizeObserver: ResizeObserver;
  private rafId = 0;
  private dirty = true;
  private running = false;
  private lastFrameTime = 0;
  private fixedFrame = 'odom';

  constructor(container: HTMLElement) {
    this.container = container;

    this.scene.background = new THREE.Color(0x0e1116);

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;

    this.camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 1000);
    this.camera.up.copy(UP_Z);
    this.camera.position.set(6, -6, 4);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.addEventListener('change', () => this.requestRender());

    // World up is +Z; rotate the grid (XY plane) accordingly.
    this.grid = new THREE.GridHelper(20, 20, 0x3a4350, 0x232a33);
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(1);
    this.scene.add(this.axes);

    this.scene.add(this.root);

    const ambient = new THREE.AmbientLight(0xffffff, 0.8);
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(5, -5, 10);
    this.scene.add(ambient, dir);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('[SceneManager] WebGL context lost');
    });
  }

  setGridVisible(v: boolean): void {
    this.grid.visible = v;
    this.requestRender();
  }

  setWorldAxesVisible(v: boolean): void {
    this.axes.visible = v;
    this.requestRender();
  }

  setFixedFrame(frame: string): void {
    this.fixedFrame = frame;
    this.requestRender();
  }

  getFixedFrame(): string {
    return this.fixedFrame;
  }

  /** Add (or replace) a plugin's object under the scene root. */
  addObject(pluginId: string, obj: THREE.Object3D): void {
    this.removeObject(pluginId);
    this.objects.set(pluginId, obj);
    this.root.add(obj);
    this.requestRender();
  }

  /** Toggle a plugin object's visibility without disposing it. */
  setObjectVisible(pluginId: string, visible: boolean): void {
    const obj = this.objects.get(pluginId);
    if (obj && obj.visible !== visible) {
      obj.visible = visible;
      this.requestRender();
    }
  }

  removeObject(pluginId: string): void {
    const existing = this.objects.get(pluginId);
    if (existing) {
      this.root.remove(existing);
      disposeObject(existing);
      this.objects.delete(pluginId);
      this.requestRender();
    }
  }

  /** Register a per-frame callback (plugin onRender). Returns an unregister fn. */
  onRender(cb: (dt: number) => void): () => void {
    this.renderCallbacks.add(cb);
    return () => this.renderCallbacks.delete(cb);
  }

  /** Mark the scene as needing a redraw; coalesced into the next rAF. */
  requestRender(): void {
    this.dirty = true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    this.loop();
  }

  /** Pause the rAF loop (§9.3: inactive 3D tabs stop rendering to save GPU). */
  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const now = performance.now();
    const dt = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;

    for (const cb of this.renderCallbacks) cb(dt);

    const controlsActive = this.controls.update(); // returns true while damping
    if (this.dirty || controlsActive) {
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
    }
  };

  resetView(): void {
    this.camera.position.set(6, -6, 4);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.requestRender();
  }

  takeScreenshot(): Promise<Blob | null> {
    this.renderer.render(this.scene, this.camera);
    return new Promise((resolve) =>
      this.renderer.domElement.toBlob((b) => resolve(b), 'image/png'),
    );
  }

  private handleResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.requestRender();
  }

  dispose(): void {
    this.stop();
    this.resizeObserver.disconnect();
    for (const id of [...this.objects.keys()]) this.removeObject(id);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** Recursively dispose geometries/materials of a removed object. */
function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}
