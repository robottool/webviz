# Golden-bytes payload fixtures

The cross-language wire contract, as checked-in bytes. Each `.bin` is one
complete binary data frame (20-byte header + schema payload) encoded from the
canonical inputs below. Every implementation of the payload layouts asserts
against these files:

- `packages/protocol/src/golden.test.ts` (vitest — `binary.ts`, the source of truth)
- `sdks/cpp/test/test_payloads.cpp` (ctest — `client.hpp` encoders)
- `sdks/python/tests/test_payloads.py` (unittest — SDK header packing, demo payload builders, ROS adapter converters)

If an encoder drifts from `binary.ts`, its test fails against these bytes —
without any two languages having to run in the same process.

## Canonical inputs

| fixture | header | payload |
|---|---|---|
| `image_frame.bin` | channel 7, t = 1.5 | `wv/Image` — frame_id `cam`, 2×1, RGB8, data `[10, 20, 30, 40, 50, 60]` |
| `pointcloud_frame.bin` | channel 9, t = 2.25 | `wv/PointCloud` — frame_id `odom`, 2 points, flags = INTENSITY, floats `[1, 2, 3, 0.5, −1, −2, −3, 1]` |
| `occupancygrid_frame.bin` | channel 4, t = 3.5 | `wv/OccupancyGrid` — frame_id `map`, resolution 0.05, 3×2, origin pos (1, 2, 0) quat (0, 0, 0, 1), cells `[0, 100, 255, 50, 0, 255]` |

Values are chosen to be bit-exact across languages (timestamps are exact
doubles) and to exercise edge cases: `odom` (4 bytes) puts the pointcloud
float region at offset 13 — deliberately unaligned — and the grid cells
include 255 (unknown).

## Regenerating

Only when the wire layout *intentionally* changes (then update every consumer
— see CLAUDE.md "When changing the protocol"):

```bash
pnpm --filter @webviz/protocol build
pnpm --filter @webviz/protocol gen:fixtures   # runs scripts/gen_fixtures.mjs
```
