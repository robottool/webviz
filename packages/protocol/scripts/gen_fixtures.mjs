/**
 * Regenerate the golden-bytes fixtures in ../fixtures from the canonical
 * inputs below (documented in fixtures/README.md). The fixtures are the
 * cross-language payload contract: the protocol vitest, the C++ SDK test, and
 * the Python payload tests all assert their encoders produce these exact
 * bytes. Run after building the protocol package:
 *
 *   pnpm --filter @webviz/protocol build
 *   pnpm --filter @webviz/protocol gen:fixtures
 *
 * Only regenerate when the wire layout intentionally changes — and then update
 * every consumer listed in CLAUDE.md ("When changing the protocol").
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encodeBinaryFrame,
  encodeImagePayload,
  encodeOccupancyGridPayload,
  encodePointCloudPayload,
  ImageEncoding,
  PC_FLAG_INTENSITY,
} from '../dist/index.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
mkdirSync(outDir, { recursive: true });

const write = (name, frame) => {
  writeFileSync(join(outDir, name), Buffer.from(frame));
  console.log(`wrote ${name} (${frame.byteLength} bytes)`);
};

// --- wv/Image: channel 7, t=1.5, "cam" 2×1 RGB8 ---
write(
  'image_frame.bin',
  encodeBinaryFrame(
    7,
    1.5,
    encodeImagePayload({
      frame_id: 'cam',
      width: 2,
      height: 1,
      encoding: ImageEncoding.RGB8,
      data: new Uint8Array([10, 20, 30, 40, 50, 60]),
    }),
  ),
);

// --- wv/PointCloud: channel 9, t=2.25, "odom" 2 points xyz+intensity ---
// frame_id "odom" makes the float region start at offset 13 — deliberately
// unaligned, so decoders that need alignment are exercised.
write(
  'pointcloud_frame.bin',
  encodeBinaryFrame(
    9,
    2.25,
    encodePointCloudPayload({
      frameId: 'odom',
      pointCount: 2,
      fieldFlags: PC_FLAG_INTENSITY,
      data: new Float32Array([1, 2, 3, 0.5, -1, -2, -3, 1]),
    }),
  ),
);

// --- wv/OccupancyGrid: channel 4, t=3.5, "map" 3×2 ---
write(
  'occupancygrid_frame.bin',
  encodeBinaryFrame(
    4,
    3.5,
    encodeOccupancyGridPayload({
      frame_id: 'map',
      resolution: 0.05,
      width: 3,
      height: 2,
      origin: { position: [1, 2, 0], orientation: [0, 0, 0, 1] },
      data: new Uint8Array([0, 100, 255, 50, 0, 255]),
    }),
  ),
);
