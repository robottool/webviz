/**
 * PointCloud decode worker (§10). Receives a transferred copy of a `wv/PointCloud`
 * binary payload, deinterleaves it off the main thread, and transfers the result
 * attribute buffers back (zero-copy) so the renderer can drop them straight into
 * a BufferGeometry.
 */

import { decodeCloud, type DecodedCloud } from '../core/pointcloudDecode.js';

// Minimal worker-scope shape so this file needs only the DOM lib, not webworker.
interface WorkerScope {
  onmessage: ((e: MessageEvent<{ buffer: ArrayBuffer }>) => void) | null;
  postMessage(message: DecodedCloud, transfer: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = (e) => {
  const cloud = decodeCloud(new Uint8Array(e.data.buffer));
  const transfer: Transferable[] = [cloud.positions.buffer];
  if (cloud.scalar) transfer.push(cloud.scalar.buffer);
  if (cloud.colors) transfer.push(cloud.colors.buffer);
  ctx.postMessage(cloud, transfer);
};
