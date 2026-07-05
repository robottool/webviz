/**
 * SceneManager (§8). Owns the Three.js scene, renderer, camera, OrbitControls,
 * and the requestAnimationFrame loop for one 3D tab. Plugins add/remove
 * Object3D instances through it. Renders are coalesced: the loop only draws when
 * something marked the scene dirty (a TF update, a settings change, or active
 * camera interaction), so an idle viewport costs nothing.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { AXIS_COLORS } from './axisColors.js';

const UP_Z = new THREE.Vector3(0, 0, 1);

/** Default ("home") view direction — the offset from the orbit target toward
 * the camera, in the +Z-up robotics world (+X forward, +Y left, +Z up). */
const HOME_DIR = new THREE.Vector3(1, -1, 0.7);

/** Small +Z offset (metres) for the origin axes so they sit just above the grid
 * plane and don't z-fight the floor lines, while still being depth-tested (and
 * thus occluded) against the robot. Imperceptible at robot scale. */
const ORIGIN_AXES_LIFT = 0.002;

/** Read a CSS custom property (set by the theme) as a THREE.Color, falling back
 * to a literal when it's unset or we're off-DOM. Lets the viewport track the
 * theme palette without duplicating colours here. */
function cssColor(name: string, fallback: number): THREE.Color {
  if (typeof getComputedStyle === 'undefined' || typeof document === 'undefined') {
    return new THREE.Color(fallback);
  }
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? new THREE.Color(v) : new THREE.Color(fallback);
}

/** Read a raw CSS custom property string (empty when unset / off-DOM). Used for
 * the `--viewport-shadows` theme flag that gates the shadow + PBR rig. */
function cssVar(name: string): string {
  if (typeof getComputedStyle === 'undefined' || typeof document === 'undefined') {
    return '';
  }
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

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

  // Lighting rig. The base (ambient + key directional) is always present; the
  // `studio` theme additionally enables shadow casting, a hemisphere fill, a
  // shadow-catcher ground plane, an env map, and ACES tone mapping — all toggled
  // by applyViewportStyle() off the `--viewport-shadows` CSS flag.
  private ambient: THREE.AmbientLight;
  private keyLight: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private shadowGround: THREE.Mesh;
  private env?: THREE.Texture;
  private studioOn = false;

  private container: HTMLElement;
  private resizeObserver: ResizeObserver;
  private rafId = 0;
  private dirty = true;
  private running = false;
  private lastFrameTime = 0;
  private fixedFrame = 'odom';

  // One-shot auto-fit: frame the scene the first time plugin content appears
  // and its size settles (a robot's meshes stream in over many frames, so we
  // wait for the bounding radius to stop growing before committing the view).
  private autoFitArmed = true;
  private fitStableFrames = 0;
  private lastContentRadius = -1;
  private readonly tmpBox = new THREE.Box3();
  private readonly tmpBox2 = new THREE.Box3();
  private readonly tmpSphere = new THREE.Sphere();

  constructor(container: HTMLElement) {
    this.container = container;

    this.scene.background = cssColor('--viewport-bg', 0x0e1116);

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
    this.grid = this.buildGrid();
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(1);
    // AxesHelper defaults to a per-axis gradient (red→orange, green→…, blue→…);
    // paint each axis a single solid colour instead, from the shared soft
    // palette (core/axisColors.ts) so every axis indicator reads consistently.
    this.axes.setColors(
      new THREE.Color(AXIS_COLORS.x),
      new THREE.Color(AXIS_COLORS.y),
      new THREE.Color(AXIS_COLORS.z),
    );
    // The X/Y axes lie in the grid's z=0 plane, so drawn at exactly z=0 they
    // z-fight with the grid lines. Lift the origin frame a hair above the grid so
    // it wins cleanly against the floor — but keep depth testing ON so the robot
    // still occludes it (it marks the robot's base; it shouldn't punch through
    // the mesh like an always-on-top overlay).
    this.axes.position.z = ORIGIN_AXES_LIFT;
    this.scene.add(this.axes);

    this.scene.add(this.root);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.8);
    this.keyLight = new THREE.DirectionalLight(0xffffff, 0.6);
    // A moderately raking angle (~40° elevation) so the studio shadow extends to
    // the side and reads clearly, rather than hiding straight under the robot.
    this.keyLight.position.set(6, -5, 6);
    // Shadow-camera frustum sized for a robot-scale scene (metres). Only used
    // when studio mode flips castShadow on; harmless otherwise.
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 0.1;
    this.keyLight.shadow.camera.far = 60;
    this.keyLight.shadow.camera.left = -12;
    this.keyLight.shadow.camera.right = 12;
    this.keyLight.shadow.camera.top = 12;
    this.keyLight.shadow.camera.bottom = -12;
    this.keyLight.shadow.bias = -0.0002;
    this.keyLight.shadow.normalBias = 0.02;
    // Sky/ground hemisphere fill — only visible in studio mode.
    this.hemi = new THREE.HemisphereLight(0xbcd0ff, 0x2a2620, 0.6);
    this.scene.add(this.ambient, this.keyLight, this.hemi);

    // Transparent shadow-catcher on the z=0 plane: ShadowMaterial renders *only*
    // where shadows fall, so it grounds the robot without hiding the grid or any
    // map/point-cloud data drawn at/below z=0 (unlike an opaque floor). PlaneGeo
    // lies in XY with a +Z normal, matching the +Z-up world.
    this.shadowGround = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.ShadowMaterial({ opacity: 0.42 }),
    );
    this.shadowGround.receiveShadow = true;
    this.scene.add(this.shadowGround);

    this.applyViewportStyle();

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('[SceneManager] WebGL context lost');
    });
  }

  /** A grid coloured from the current theme's CSS vars. */
  private buildGrid(): THREE.GridHelper {
    const grid = new THREE.GridHelper(
      20,
      20,
      cssColor('--grid-major', 0x3a4350),
      cssColor('--grid-minor', 0x232a33),
    );
    grid.rotation.x = Math.PI / 2;
    // The grid colours come straight from the theme; keep ACES tone mapping (on
    // in studio mode) from shifting them.
    (grid.material as THREE.Material).toneMapped = false;
    return grid;
  }

  /** Read the `--viewport-shadows` theme flag and switch the renderer between the
   * flat base rig and the studio shadow + PBR rig. Idempotent; called from the
   * constructor and on every theme change. */
  private applyViewportStyle(): void {
    const studio = cssVar('--viewport-shadows') === '1';
    this.studioOn = studio;

    this.renderer.shadowMap.enabled = studio;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.keyLight.castShadow = studio;
    this.hemi.visible = studio;
    this.shadowGround.visible = studio;

    // Re-flag every already-loaded object's meshes (switching *into* studio after
    // a robot has streamed in is the common case). The render loop also re-flags
    // on dirty frames while studio is on, so async URDF meshes arriving later get
    // castShadow too.
    for (const obj of this.objects.values()) this.applyShadowFlags(obj);

    // Balance the fill: studio leans on the key light + shadows, so drop the flat
    // ambient (which would wash the shadows out) and brighten the key.
    this.ambient.intensity = studio ? 0.32 : 0.8;
    this.keyLight.intensity = studio ? 1.15 : 0.6;

    this.renderer.toneMapping = studio ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.scene.environment = studio ? this.getEnvironment() : null;

    // Toggling shadowMap.enabled / tone mapping changes the shader defines, so
    // force affected materials to recompile once.
    this.scene.traverse((n) => {
      const m = (n as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
      else if (m) m.needsUpdate = true;
    });
    this.requestRender();
  }

  /** Lazily build a RoomEnvironment PMREM for soft image-based lighting (studio
   * mode only). Cached; disposed in dispose(). */
  private getEnvironment(): THREE.Texture {
    if (!this.env) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    }
    return this.env;
  }

  /** Flag shadow casting/receiving on a plugin object's meshes. Opaque meshes
   * cast (a translucent jog ghost / gizmo would drop a solid, misleading shadow —
   * those are skipped via `userData.noShadow`/`noFit` or material transparency);
   * every mesh receives. Points/Lines are left alone (point shadows are speckle).
   * Cheap and harmless when studio mode is off. */
  private applyShadowFlags(obj: THREE.Object3D): void {
    obj.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      let excluded = false;
      for (let p: THREE.Object3D | null = mesh; p; p = p.parent) {
        if (p.userData?.noFit || p.userData?.noShadow) {
          excluded = true;
          break;
        }
      }
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      const transparent = Array.isArray(mat)
        ? mat.some((m) => m.transparent)
        : !!mat?.transparent;
      mesh.receiveShadow = true;
      mesh.castShadow = !excluded && !transparent;
    });
  }

  /** Re-read theme colours into the WebGL scene (background + grid). Called by
   * the 3D tab when the theme changes — the CSS vars have flipped by then. */
  applyTheme(): void {
    this.scene.background = cssColor('--viewport-bg', 0x0e1116);
    // GridHelper bakes its colours into geometry, so rebuild it (preserving the
    // user's show/hide state) rather than mutating in place.
    const visible = this.grid.visible;
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.grid = this.buildGrid();
    this.grid.visible = visible;
    this.scene.add(this.grid);
    // The theme may have flipped the --viewport-shadows flag (e.g. into/out of
    // `studio`), so re-sync the shadow + PBR rig.
    this.applyViewportStyle();
    this.requestRender();
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
    this.applyShadowFlags(obj);
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

    if (this.autoFitArmed) this.tryAutoFit();

    const controlsActive = this.controls.update(); // returns true while damping
    if (this.dirty || controlsActive) {
      // A dirty frame means content changed (new/updated plugin objects), so in
      // studio mode re-flag castShadow to catch async-loaded meshes (URDF meshes
      // stream in after addObject). Cheap: boolean sets over a handful of meshes.
      if (this.studioOn && this.dirty) {
        for (const obj of this.objects.values()) this.applyShadowFlags(obj);
      }
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

  /**
   * Frame all plugin content (the scene root) in view from the current view
   * direction. The grid/axes live on the scene (not the root), so they don't
   * pad the fit. Returns false if there's nothing to frame yet.
   */
  fitView(): boolean {
    return this.frameFrom(null);
  }

  /**
   * Snap the camera to look along a world-axis direction (the offset from the
   * target toward the camera, e.g. (0,0,1) for top-down), framing the content
   * when there is any. Used by the corner navigation gizmo.
   */
  setViewDirection(dir: THREE.Vector3): void {
    this.frameFrom(dir.clone().normalize());
  }

  /** Bounding box of framable content: every root child except those flagged
   * `userData.noFit` — interactive gizmos, whose huge invisible drag-planes would
   * otherwise blow the fit up and fling the camera far away. */
  private contentBox(target: THREE.Box3): THREE.Box3 {
    target.makeEmpty();
    const b = this.tmpBox2;
    for (const child of this.root.children) {
      if (child.userData.noFit) continue;
      b.setFromObject(child);
      if (!b.isEmpty()) target.union(b);
    }
    return target;
  }

  /** Shared camera placement: orbit `dir` (or the current direction if null) at
   * a distance that frames the scene content, falling back to the current target
   * / distance when the scene is still empty (so a gizmo click works pre-load). */
  private frameFrom(dir: THREE.Vector3 | null): boolean {
    const box = this.contentBox(this.tmpBox);
    const hasContent = !box.isEmpty();

    let center: THREE.Vector3;
    let distance: number;
    let radius = 0;
    if (hasContent) {
      const sphere = box.getBoundingSphere(this.tmpSphere);
      center = sphere.center.clone();
      radius = Math.max(sphere.radius, 0.05);
      const fovV = (this.camera.fov * Math.PI) / 180;
      const fovH = 2 * Math.atan(Math.tan(fovV / 2) * this.camera.aspect);
      // Fit the bounding sphere to whichever fov dimension is the binding one.
      distance = (radius / Math.sin(Math.min(fovV, fovH) / 2)) * 1.15;
    } else {
      center = this.controls.target.clone();
      distance = this.camera.position.distanceTo(this.controls.target) || 9;
    }

    const d = new THREE.Vector3();
    if (dir) d.copy(dir);
    else {
      d.subVectors(this.camera.position, this.controls.target);
      if (d.lengthSq() < 1e-9) d.copy(HOME_DIR);
    }
    d.normalize();

    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(d, distance);
    if (radius > 0) {
      this.camera.near = Math.max(distance / 1000, 0.001);
      this.camera.far = distance * 4 + radius * 10;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
    this.requestRender();
    return hasContent;
  }

  /** Re-arm the one-shot auto-fit (e.g. a new robot is loading). */
  armAutoFit(): void {
    this.autoFitArmed = true;
    this.fitStableFrames = 0;
    this.lastContentRadius = -1;
  }

  /** While armed, watch for content to appear and stop growing, then frame it
   * once. Cheap when the root is empty (nothing to traverse). */
  private tryAutoFit(): void {
    const box = this.contentBox(this.tmpBox);
    if (box.isEmpty()) {
      this.lastContentRadius = -1;
      this.fitStableFrames = 0;
      return;
    }
    const radius = box.getBoundingSphere(this.tmpSphere).radius;
    if (
      this.lastContentRadius > 0 &&
      Math.abs(radius - this.lastContentRadius) <= this.lastContentRadius * 0.02
    ) {
      this.fitStableFrames++;
    } else {
      this.fitStableFrames = 0;
    }
    this.lastContentRadius = radius;
    if (this.fitStableFrames >= 20) {
      this.fitView();
      this.autoFitArmed = false;
    }
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
    this.env?.dispose();
    (this.shadowGround.material as THREE.Material).dispose();
    this.shadowGround.geometry.dispose();
    this.renderer.dispose();
    // dispose() frees three's GPU resources but not the underlying WebGL
    // context; forceContextLoss() actually releases it, so per-tab renderers
    // don't leak contexts and exhaust Chrome's ~16-per-page cap (black viewport).
    this.renderer.forceContextLoss();
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
