/**
 * Resolves mesh/texture references from a locally-picked file set to in-browser
 * blob URLs, so a URDF loaded from disk can find its meshes without a server.
 *
 * URDFs reference meshes as `package://pkg/path/to/mesh.dae` (or relative), and
 * the picked files arrive with a `webkitRelativePath` rooted at whatever folder
 * the user selected. Rather than require the package name to match the folder,
 * we match by **longest trailing path segment** — `.../meshes/base.dae` finds a
 * picked file ending in `meshes/base.dae`, falling back to the basename.
 *
 * A `THREE.LoadingManager` with `setURLModifier` routes every request a loader
 * makes (the mesh itself, plus DAE textures / GLTF `.bin` buffers) through the
 * same resolver, so externally-referenced sub-resources resolve too.
 */

import * as THREE from 'three';

/** A file with an explicit path (e.g. from `File.webkitRelativePath`). */
export interface PickedFile {
  path: string;
  blob: Blob;
}

export class LocalAssetResolver {
  readonly manager = new THREE.LoadingManager();
  private entries: Array<{ segs: string[]; blob: Blob }> = [];
  private blobUrls = new Map<Blob, string>();

  constructor(files: Array<File | PickedFile>) {
    for (const f of files) {
      const path =
        'path' in f ? f.path : f.webkitRelativePath || f.name;
      const blob: Blob = 'blob' in f ? f.blob : f;
      this.entries.push({ segs: normalizeSegs(path), blob });
    }
    this.manager.setURLModifier((url) => this.resolve(url) ?? url);
  }

  /** Best blob URL for a referenced path, or null if no file matches. */
  resolve(ref: string): string | null {
    if (ref.startsWith('blob:') || ref.startsWith('data:')) return null;
    const want = normalizeSegs(ref);
    if (want.length === 0) return null;
    let best: Blob | null = null;
    let bestScore = 0;
    for (const e of this.entries) {
      const score = suffixMatch(e.segs, want);
      if (score > bestScore) {
        bestScore = score;
        best = e.blob;
      }
    }
    return best ? this.blobUrl(best) : null;
  }

  private blobUrl(b: Blob): string {
    let u = this.blobUrls.get(b);
    if (!u) {
      u = URL.createObjectURL(b);
      this.blobUrls.set(b, u);
    }
    return u;
  }

  /** Revoke all blob URLs handed out by this resolver. */
  dispose(): void {
    for (const u of this.blobUrls.values()) URL.revokeObjectURL(u);
    this.blobUrls.clear();
  }
}

/** Path → lowercased, scheme-stripped segments (drops query/hash, `.`). */
function normalizeSegs(p: string): string[] {
  let s = p.split(/[?#]/)[0];
  try {
    s = decodeURIComponent(s);
  } catch {
    /* leave as-is if not valid percent-encoding */
  }
  s = s
    .replace(/\\/g, '/')
    .replace(/^package:\/\//, '')
    .replace(/^file:\/\//, '');
  return s.split('/').filter((x) => x && x !== '.');
}

/** Number of matching trailing segments between two paths (basename ⇒ ≥1). */
function suffixMatch(a: string[], b: string[]): number {
  let i = a.length - 1;
  let j = b.length - 1;
  let n = 0;
  while (i >= 0 && j >= 0 && a[i].toLowerCase() === b[j].toLowerCase()) {
    i--;
    j--;
    n++;
  }
  return n;
}
