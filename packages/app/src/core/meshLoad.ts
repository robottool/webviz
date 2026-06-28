/**
 * Shared mesh loading for the 3D plugins (RobotModel URDFs, Marker `mesh` type).
 *
 * Two concerns live here, both previously private to `RobotModelPlugin`:
 *   - format dispatch: pick the right three.js loader by file extension
 *     (Collada `.dae`, STL `.stl`, glTF `.glb`/`.gltf`) and return an `Object3D`.
 *   - URL resolution: rewrite a `package://`/relative mesh reference onto the hub
 *     asset server (`http://<host>:8080/assets`).
 *
 * Local (folder-picked) meshes resolve through a `LocalAssetResolver`'s
 * `LoadingManager` instead — pass its `manager` and an already-correct `url`.
 */

import * as THREE from 'three';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Base URL of the hub asset server, derived from the page host. */
export function defaultAssetBase(): string {
  const host =
    typeof location !== 'undefined' && location.hostname ? location.hostname : 'localhost';
  return `http://${host}:8080/assets`;
}

/** Last path segment, ignoring any query/hash and either slash style. */
export function basename(p: string): string {
  return p.split(/[?#]/)[0].split(/[\\/]/).pop() ?? p;
}

/** Lowercased file extension (no dot), or '' if none. */
export function extOf(p: string): string {
  return basename(p).split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Resolve a marker/asset mesh reference to a fetchable URL: absolute http(s)
 * URLs pass through unchanged; `package://pkg/...` and `file://`/relative refs
 * are anchored onto the hub asset server (so `package://foo/bar.dae` →
 * `<assetBase>/foo/bar.dae`). Publishers are expected to use paths that exist
 * under the served assets root.
 */
export function resolveAssetUrl(path: string, assetBase = defaultAssetBase()): string {
  if (/^https?:\/\//.test(path)) return path;
  const rel = path
    .replace(/^package:\/\//, '')
    .replace(/^file:\/\//, '')
    .replace(/^\/+/, '');
  return `${assetBase}/${rel}`;
}

/**
 * Load a mesh from an already-resolved URL, dispatching on `format` (a file
 * extension: `dae`/`stl`/`glb`/`gltf`). `material` is applied to STL geometry
 * (which carries none); DAE/glTF keep their embedded materials. `manager` routes
 * sub-resource requests (textures, `.bin`) — used by the local blob resolver.
 */
export async function loadMeshFromUrl(
  url: string,
  format: string,
  material?: THREE.Material,
  manager?: THREE.LoadingManager,
): Promise<THREE.Object3D> {
  const fmt = format.toLowerCase();
  if (fmt === 'dae') {
    const dae = await new ColladaLoader(manager).loadAsync(url);
    return dae.scene;
  }
  if (fmt === 'stl') {
    const geom = await new STLLoader(manager).loadAsync(url);
    return new THREE.Mesh(geom, material ?? new THREE.MeshPhongMaterial({ color: 0x9aa4b2 }));
  }
  if (fmt === 'glb' || fmt === 'gltf') {
    const gltf = await new GLTFLoader(manager).loadAsync(url);
    return gltf.scene;
  }
  throw new Error(`Unsupported mesh format: ${fmt} (${url})`);
}
