# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WebViz is a browser-based visualization platform for robots and real-time systems. Three principles drive the design (`webviz_design_doc_v3.md` is the spec; code comments cite its sections as `§N`):

- **Protocol-first** — the `wv/*` wire protocol (`packages/protocol`) is the single contract shared by hub, app, and SDKs. Change it there and only there.
- **Source-agnostic** — the browser reasons only about channel *names* + schema types, never about where data came from (ROS, file, custom SDK). The hub erases origin.
- **Tabbed workspace** — the app is a set of independent tabs sharing one connection.

The repo is a **vertical slice in progress**. Working tabs: **Inspector**, **3D**, **Image**, **Plot**, and **Map** — the 3D display-plugin catalogue is essentially complete: `RobotModel`, `TFFrames`, `Marker`, `PointCloud`, `LaserScan`, `OccupancyGrid`, `Path`, `Pose` (plus TFManager and SceneManager). The tab store models all six types (`3d`, `image`, `plot`, `map`, `inspector`, `log`); the remaining tab renderer (Log — needs a new `wv/Log` schema), recording, and C++/ROS2 SDKs are not yet built.

## Commands

Toolchain note: pnpm 9 runs via corepack from `~/.local/bin` (Node 20 quirk) — ensure that's on `PATH` before running pnpm.

```bash
pnpm install                              # install workspace deps
pnpm --filter @webviz/protocol build      # MUST build protocol first — hub & app consume its dist/
pnpm build                                 # build all packages (pnpm -r)
pnpm typecheck                             # typecheck all packages

pnpm hub                                   # run hub: WS broker :7777 + HTTP/asset :8080 (tsx watch)
pnpm app                                   # run app dev server (Vite) :5173, auto-connects ws://localhost:7777
python3 sdks/python/demo_source.py         # feed demo data via HTTP /api/inject (no pip deps)
python3 sdks/python/map_sim_demo.py        # feed the Map tab: scan-built map + wandering robot + raycast scan (HTTP, no pip deps)
python3 sdks/python/robot_demo.py          # feed the 3D tab: UR5 RobotModel + JointState + base TF
python3 sdks/python/pointcloud_demo.py     # feed the 3D tab: animated binary wv/PointCloud (needs `pip install websockets`)
python3 sdks/python/image_demo.py          # feed the Image tab: animated binary wv/Image RGB8 (needs `pip install 'websockets>=11'`)
```

The hub's asset server defaults `assetsDir` to the **repo root**, so robot descriptions are reachable at `/assets/ur_description/...` out of the box (override with `WEBVIZ_ASSETS_DIR` in production). The `RobotModel` plugin fetches URDF + meshes from `http://<host>:8080/assets`.

Tests (vitest, only in `@webviz/protocol`):
```bash
pnpm --filter @webviz/protocol test                 # run once
pnpm --filter @webviz/protocol test:watch           # watch
pnpm --filter @webviz/protocol exec vitest run binary   # single test file by name
```

`@webviz/protocol` must be built before hub/app typecheck or build, because they import from its `dist/` via `workspace:*`. The hub uses `tsx watch` in dev so it does not need a prior build for `pnpm hub`.

## Architecture

Three TS packages + a Python SDK, pnpm workspace (`packages/*`), ESM throughout (`"type": "module"`), strict TS. Note that intra-package imports use `.js` extensions (ESM/`moduleResolution: Bundler`) even though sources are `.ts`.

### `packages/protocol` — the wire contract
- `schemas.ts` — `wv/*` schema types (Transform, Marker, Image, PointCloud, …): the shape of each channel's `data` payload.
- `messages.ts` — JSON control/data ops over the WS text channel (`server_info`, `advertise`, `subscribe`, `message`, …), with discriminated-union types (`ClientMessage`, `SourceMessage`, `ServerMessage`, `AnyMessage`) for exhaustive routing.
- `binary.ts` — binary data frames. **Fixed 20-byte little-endian header**: `op(0x01)` / 3 reserved / `uint32 channel_id` / `float64 timestamp` / `uint32 payload_length` / payload. Little-endian is a WebViz decision (the spec doesn't mandate one) — keep encoder and decoder in sync. Also holds the schema-specific binary payload codecs: `wv/Image` and `wv/PointCloud` both lead with a length-prefixed `frame_id` (so the cloud/image carries its own TF frame); the PointCloud float region is generally unaligned, so the decoder copies it into an aligned buffer before viewing it as `Float32Array`.
- `frame.ts` — `decodeFrame(raw)` normalizes any incoming WS frame (string JSON or binary) into a `data` or `control` result. The one decode entry point used by both hub and app.

### `packages/hub` — broker + asset server (`main.ts` wires both, sharing one registry)
- `broker.ts` — WebSocketServer on :7777. Same port serves both roles, distinguished by query string `?role=source|client` (`&id=<sourceId>`). Sources advertise channels and push frames; the broker fans each frame out to subscribed clients, enforcing per-`(channel, client)` `max_hz` throttling. `injectJson()` lets a non-WS HTTP caller publish (used by `/api/inject`).
- `channel_registry.ts` — maps each source's *local* channel ids to *global* ids, renaming on collision (`resolveLocal`, `advertise`). This is the source-agnostic erasure layer.
- `session_store.ts` — `SessionStore`: persists workspace layouts as JSON files under `dataDir` (`WEBVIZ_DATA_DIR`, default `data/layouts`), backing the `/api/layouts` REST endpoints. The hub is the shared/multi-user source of truth; the app also keeps a localStorage copy. Layout names are sanitized to a flat, safe filename namespace.
- `asset_server.ts` — HTTP :8080: serves the built app, plus REST `GET /api/channels`, `GET/POST /api/layouts` (+ `/:id`), `POST /api/inject`, and `/assets/*`. Has path-traversal guarding for static serving. The `/assets/` prefix is shared by two roots — robot descriptions/meshes (`assetsDir`) and the app's own Vite bundle (which Vite also emits under `/assets/`, i.e. `webDir/assets/*`) — so it resolves `assetsDir` first, then falls back to the app bundle, then 404s.
- Ports/dirs are overridable via env: `WEBVIZ_WS_PORT`, `WEBVIZ_HTTP_PORT`, `WEBVIZ_WEB_DIR`, `WEBVIZ_ASSETS_DIR`, `WEBVIZ_DATA_DIR`, `ALLOWED_ORIGINS`.

### `packages/app` — Vite + React + Zustand + three.js
The data path is **HubClient → MessageRouter → tab handlers**:
- `protocol/HubClient.ts` — **singleton** (`hubClient`), one WebSocket per browser window. Owns reconnection, the live channel list (from `server_info`/`advertise`/`unadvertise`), and **reference-counted subscriptions by channel name**: first subscriber sends `subscribe`, last sender of unsubscribe sends `unsubscribe`. Subscribing to a not-yet-advertised channel is deferred until it appears. Subscribe by *name*, not id.
- `protocol/MessageRouter.ts` — fans one decoded frame out to every registered per-channel-id handler, so multiple tabs on the same channel each get their own callback.
- `store/connection.store.ts`, `store/tabs.store.ts` — Zustand stores for connection state and the tab set/active tab. `TAB_META` defines the six tab types.
- `tabs/TabRenderer.tsx` dispatches a `TabConfig` to its renderer; `InspectorTab.tsx`, `ThreeDTab.tsx`, `ImageTab.tsx`, `PlotTab.tsx`, and `MapTab.tsx` are live, only `log` falls back to `PlaceholderTab.tsx`. Each active tab is wrapped (in `App.tsx`) in `ui/TabErrorBoundary.tsx`, keyed by tab id — a tab that throws (e.g. the 3D tab when the browser can't create a WebGL context) shows an inline error instead of unmounting the whole app, with a tailored hint for WebGL-context failures.
- **Image tab** (`tabs/ImageTab.tsx`) — the §11.3 camera grid and the first consumer of the binary data path *outside* the 3D scene. A user-configurable N×M grid (1×1/1×2/2×2/3×2, persisted in tab settings as `{ layout, cells }`); each cell binds one `wv/Image` channel (dropdown filtered to that schema) and blits decoded frames to a `<canvas>` sized to the source image and scaled via CSS `object-fit: contain`. Decodes with the shared `decodeImagePayload`: JPEG/PNG via `createImageBitmap`, RGB8 via `ImageData`. Skips frames while an async decode is in flight (no backlog under a fast publisher).
- **Plot tab** (`tabs/PlotTab.tsx` + `core/plotSeries.ts`) — the §11.4 live time-series chart, organized as **subplots**: settings persist as `{ plots: [{ id, series: [{channel, field}] }], windowSec }`. Each subplot is its own coordinate system (independently auto-scaled y-axis) sharing the global x time-window — so multiple fields in one subplot share an axis, while different channels in separate subplots get independent axes (a small signal isn't flattened by a large one). Old `{ series }` settings migrate to one subplot; new tabs start with one empty subplot. **Hand-rolled `<canvas>` per subplot with a coalesced rAF draw loop** (not Recharts, despite §12) — the window scrolls every frame, where a declarative chart's per-frame reconciliation would thrash; series are coloured by index *within* their subplot.
- **Map tab** (`tabs/MapTab.tsx`) — the §11.5 2D orthographic top-down view, a pure consumer of existing schemas (no new protocol): `wv/OccupancyGrid` base map + `wv/Path` polyline + `wv/LaserScan` points + a robot heading triangle from a TF frame. Everything is transformed into the shared **TFManager fixed frame** (`resolveToFixed`), reduced to a 2D affine `{tx, ty, yaw}` (`yawFrom*` extracts yaw from the quaternion) — no three.js. The occupancy grid is decoded (base64 uint8) into an offscreen image once per message and placed with a canvas transform (world→screen ∘ gridpixel→world via the origin pose); points use a JS `world→screen`. Hand-rolled `<canvas>` + rAF; wheel zooms about the cursor (native non-passive listener), drag pans, auto-fit on first grid (and the “⤢ Fit” button). Sidebar (`.mapd-side`) picks the fixed frame, per-layer channels (filtered by schema), the robot TF frame, grid alpha, and per-layer show toggles; a scale bar + “N ↑” are drawn in-canvas. World is +X right / +Y up (screen Y flipped). `plotSeries.ts` is the pure (node-testable) field layer: `discoverFields` lists a payload's numeric leaves as dot-paths, special-casing `wv/JointState` to one field per joint name; `readField` resolves a series' current value (joint-name lookup or dot-path). One subscription per distinct channel across all subplots; each frame is pushed once per distinct `(channel, field)` into a rolling buffer trimmed by window + `MAX_POINTS`; orphaned buffers are pruned when the series set changes. Live data lives in refs (canvases read them directly); the React-rendered legends (Hz / point counts) are kept fresh by a low-frequency forced re-render. Channel picker filters out binary (`encoding === 'binary'`) channels. **Pause freezes the time axis** (a shared `viewRef` `{end, span, latest}`; `null` = live and follows `now`) and makes the frozen view **zoom/pan-able** — wheel zooms about the cursor (native non-passive listener), drag pans, both clamped to the retained data; buffers retain `RETENTION_SEC` (120 s, ≫ the view window) so there's scrollback to inspect; the y-axis auto-scales to the visible time slice. The view is shared across subplots so they stay x-aligned; “⤢ Fit” resets the zoom.
- **3D tab** (`tabs/ThreeDTab.tsx`) — three-column workspace (Displays sidebar · Three.js viewport · Properties panel). Per-tab `SceneManager`; the TF tree and hub connection are shared singletons. The Properties panel is the generic schema-form (`PropSchema`) for most plugins, but RobotModel gets a custom panel (`tabs/RobotModelProperties.tsx`).
- `core/SceneManager.ts` — owns the three.js scene/camera/OrbitControls and a **coalesced** rAF loop (`requestRender()` marks dirty; idle viewport draws nothing). World is +Z up. Plugins add/remove `Object3D`s by id.
- `core/TFManager.ts` — shared singleton TF tree: subscribes to all `wv/Transform`(`Array`) channels, 5s rolling buffer per frame, **SLERP/LERP interpolation**, `resolveToFixed(frame)` composes the parent chain into the fixed frame. Also records the publishing channel per frame (`getFrameSource`/`getSourceChannels`) so displays can filter by source.
- `core/plugin.ts` — `DisplayPlugin` contract + `PluginContext` (`{ hub, tf, scene }`) + `pluginRegistry`. `plugins/index.ts` registers built-ins (import for side effect before reading the catalogue).
- `plugins/RobotModelPlugin.ts` — renders a URDF via `urdf-loader` with three independently switchable input sources: **URDF** (`local` folder upload **or** a `wv/RobotModel` channel), **joints** (`manual` sliders **or** `wv/JointState`), **pose** (`manual` xyz/rpy **or** TF/`resolveToFixed`). Defaults to all-channel so a published robot auto-displays; loading a local folder flips joints/pose to manual preview. Emits a validation report (joints + limits, meshes loaded/failed) consumed by `RobotModelProperties`. Remote meshes load from the hub asset server (anchored on `ur_description/`); local meshes resolve to blob URLs.
- `plugins/TFFramesPlugin.ts` — visualizes the TF tree: an `AxesHelper` triad + camera-facing canvas-texture label per frame, plus parent→child line segments. A **pure TFManager consumer** — no channel binding of its own; each frame is placed via `resolveToFixed` (the scene root *is* the fixed frame), unresolved frames are hidden. Uses the generic `PropSchema` Properties form (source filter, frame-name filter, axis scale, labels, parent links); a link is drawn only when both endpoints pass the filter.
- `plugins/MarkerPlugin.ts` — subscribes to one `wv/Marker` channel and keeps a marker **store** keyed by `namespace/id`, honoring the action lifecycle (`add`/`modify`/`delete`/`delete_namespace`/`delete_all`) and `lifetime` expiry. Each marker is a group anchored to its `frame_id` via `resolveToFixed` each render, with the geometry offset inside by the marker's own pose. First-cut geometry: cube, sphere, cylinder, arrow, line_strip, line_list, points, triangle_list; `text` (needs a CSS2D renderer) and `mesh` (needs the URDF loaders) are deferred and ignored.
- `plugins/PointCloudPlugin.ts` + `plugins/pointcloud.worker.ts` + `core/pointcloudDecode.ts` — the performance-critical plugin (§10). Binary `wv/PointCloud` frames are **decoded in a WebWorker** (`pointcloud.worker.ts`, instantiated via Vite's `new Worker(new URL(...), { type: 'module' })`); the pure deinterleave lives in `pointcloudDecode.ts` (no three/Worker globals, so it's node-testable and shared by both). The plugin copies each payload out of the shared frame buffer, transfers it to the worker, and on the result swaps the buffers into a BufferGeometry. Coloring: RGB → vertex colors; intensity → viridis colormap (`core/colormap.ts` DataTexture, sampled in a `ShaderMaterial`) normalized per frame; xyz-only → colormap over z. Anchored to the payload's `frame_id` via `resolveToFixed`.
- `plugins/{LaserScan,OccupancyGrid,Path,Pose}Plugin.ts` — the JSON sensor/nav plugins, each subscribing to one channel of its schema and anchoring to `frame_id` via `resolveToFixed`. **LaserScan**: polar→Cartesian `THREE.Points` (drops out-of-range / `"Inf"` beams). **OccupancyGrid**: base64 uint8 → `DataTexture` (free=white, occupied=black, unknown=transparent) on a `PlaneGeometry` sized `w·h·resolution`, nested root(frame)▸origin(grid origin)▸plane. **Path**: `THREE.Line` polyline colored by the path's RGBA. **Pose**: an `ArrowHelper` along +X plus an optional 2σ covariance ellipse (`ellipse2D` does the 2×2 eigen of the position block).
- `core/meshResolver.ts` — `LocalAssetResolver`: indexes folder-picked files by `webkitRelativePath`, resolves `package://`/relative refs by **longest trailing-segment match**, and exposes a `THREE.LoadingManager` whose `setURLModifier` routes every loader request (mesh + DAE textures / GLTF `.bin`) to a blob URL.

### `sdks/python` — minimal client
- `webviz/client.py` — `webviz.Client`: WS client that advertises channels and sends JSON/binary frames (mirrors the binary header from `binary.ts`). Requires `pip install websockets`.
- `demo_source.py` — dependency-free demo; publishes transforms/markers/battery plus one of each remaining JSON 3D schema (LaserScan, OccupancyGrid, Path, Pose) via the hub's HTTP `/api/inject` instead of WS.
- `map_sim_demo.py` — dependency-free Map-tab (§11.5) demo. A `MapSim` holds a random world as hidden ground truth (border walls + random rectangular obstacles, `--seed` for repeatability) and drives a dot robot on a collision-avoiding random walk (publishing `base_link→odom` `wv/Transform`). It **raycasts** a 360° `wv/LaserScan` against the truth and **builds the published `wv/OccupancyGrid` from those scans** (cells traversed→free, hit→occupied, rest→unknown) so the map fills in SLAM-style as the robot explores; the trajectory is a `wv/Path` (`trail`). Also HTTP `/api/inject`. Drive the Map tab with fixed frame `odom`, map=`map`, scan=`scan`, path=`trail`, robot=`base_link`.
- `robot_demo.py` / `pointcloud_demo.py` / `image_demo.py` — WS demos built on `webviz.Client` (so they need `websockets`; `client.py` uses the `websockets.sync` API, which requires **websockets ≥ 11**): `robot_demo.py` feeds a UR5 `wv/RobotModel` + `wv/JointState` + base TF; `pointcloud_demo.py` streams animated binary `wv/PointCloud` frames; `image_demo.py` streams an animated RGB8 `wv/Image` (`camera_front`) for the Image tab. Each `*_payload()` duplicates the matching `binary.ts` payload layout.

## When changing the protocol

Edit `packages/protocol/src`, rebuild it, then update consumers. The Python SDK's binary header packing (`struct.pack("<B3xIdI", …)`) duplicates `binary.ts` — keep both in sync when the frame layout changes; likewise `pointcloud_demo.py`'s `pointcloud_payload()` duplicates the `wv/PointCloud` payload layout. `PROTOCOL_VERSION` lives in `protocol/src/index.ts` and is sent in the `server_info` handshake.
