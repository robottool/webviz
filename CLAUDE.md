# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WebViz is a browser-based visualization platform for robots and real-time systems. Three principles drive the design (`webviz_design_doc_v3.md` is the spec; code comments cite its sections as `§N`):

- **Protocol-first** — the `wv/*` wire protocol (`packages/protocol`) is the single contract shared by hub, app, and SDKs. Change it there and only there.
- **Source-agnostic** — the browser reasons only about channel *names* + schema types, never about where data came from (ROS, file, custom SDK). The hub erases origin.
- **Tabbed workspace** — the app is a set of independent tabs sharing one connection.

The repo is a **vertical slice in progress**. Working tabs: **Inspector** and **3D** (with a `RobotModel` display plugin, TFManager, and SceneManager). The tab store models all six types (`3d`, `image`, `plot`, `map`, `inspector`, `log`); Image/Plot/Map/Log renderers, the rest of the plugin catalogue (PointCloud, Marker, LaserScan, …), recording, and C++/ROS2 SDKs are not yet built.

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
python3 sdks/python/robot_demo.py          # feed the 3D tab: UR5 RobotModel + JointState + base TF
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
- `binary.ts` — binary data frames. **Fixed 20-byte little-endian header**: `op(0x01)` / 3 reserved / `uint32 channel_id` / `float64 timestamp` / `uint32 payload_length` / payload. Little-endian is a WebViz decision (the spec doesn't mandate one) — keep encoder and decoder in sync.
- `frame.ts` — `decodeFrame(raw)` normalizes any incoming WS frame (string JSON or binary) into a `data` or `control` result. The one decode entry point used by both hub and app.

### `packages/hub` — broker + asset server (`main.ts` wires both, sharing one registry)
- `broker.ts` — WebSocketServer on :7777. Same port serves both roles, distinguished by query string `?role=source|client` (`&id=<sourceId>`). Sources advertise channels and push frames; the broker fans each frame out to subscribed clients, enforcing per-`(channel, client)` `max_hz` throttling. `injectJson()` lets a non-WS HTTP caller publish (used by `/api/inject`).
- `channel_registry.ts` — maps each source's *local* channel ids to *global* ids, renaming on collision (`resolveLocal`, `advertise`). This is the source-agnostic erasure layer.
- `asset_server.ts` — HTTP :8080: serves the built app, plus REST `GET /api/channels`, `GET/POST /api/layouts` (+ `/:id`), `POST /api/inject`, and `/assets/*`. Has path-traversal guarding for static serving. The `/assets/` prefix is shared by two roots — robot descriptions/meshes (`assetsDir`) and the app's own Vite bundle (which Vite also emits under `/assets/`, i.e. `webDir/assets/*`) — so it resolves `assetsDir` first, then falls back to the app bundle, then 404s.
- Ports/dirs are overridable via env: `WEBVIZ_WS_PORT`, `WEBVIZ_HTTP_PORT`, `WEBVIZ_WEB_DIR`, `WEBVIZ_ASSETS_DIR`, `WEBVIZ_DATA_DIR`, `ALLOWED_ORIGINS`.

### `packages/app` — Vite + React + Zustand + three.js
The data path is **HubClient → MessageRouter → tab handlers**:
- `protocol/HubClient.ts` — **singleton** (`hubClient`), one WebSocket per browser window. Owns reconnection, the live channel list (from `server_info`/`advertise`/`unadvertise`), and **reference-counted subscriptions by channel name**: first subscriber sends `subscribe`, last sender of unsubscribe sends `unsubscribe`. Subscribing to a not-yet-advertised channel is deferred until it appears. Subscribe by *name*, not id.
- `protocol/MessageRouter.ts` — fans one decoded frame out to every registered per-channel-id handler, so multiple tabs on the same channel each get their own callback.
- `store/connection.store.ts`, `store/tabs.store.ts` — Zustand stores for connection state and the tab set/active tab. `TAB_META` defines the six tab types.
- `tabs/TabRenderer.tsx` dispatches a `TabConfig` to its renderer; `InspectorTab.tsx` and `ThreeDTab.tsx` are live, others fall back to `PlaceholderTab.tsx`.
- **3D tab** (`tabs/ThreeDTab.tsx`) — three-column workspace (Displays sidebar · Three.js viewport · Properties panel). Per-tab `SceneManager`; the TF tree and hub connection are shared singletons. The Properties panel is the generic schema-form (`PropSchema`) for most plugins, but RobotModel gets a custom panel (`tabs/RobotModelProperties.tsx`).
- `core/SceneManager.ts` — owns the three.js scene/camera/OrbitControls and a **coalesced** rAF loop (`requestRender()` marks dirty; idle viewport draws nothing). World is +Z up. Plugins add/remove `Object3D`s by id.
- `core/TFManager.ts` — shared singleton TF tree: subscribes to all `wv/Transform`(`Array`) channels, 5s rolling buffer per frame, **SLERP/LERP interpolation**, `resolveToFixed(frame)` composes the parent chain into the fixed frame.
- `core/plugin.ts` — `DisplayPlugin` contract + `PluginContext` (`{ hub, tf, scene }`) + `pluginRegistry`. `plugins/index.ts` registers built-ins (import for side effect before reading the catalogue).
- `plugins/RobotModelPlugin.ts` — renders a URDF via `urdf-loader` with three independently switchable input sources: **URDF** (`local` folder upload **or** a `wv/RobotModel` channel), **joints** (`manual` sliders **or** `wv/JointState`), **pose** (`manual` xyz/rpy **or** TF/`resolveToFixed`). Defaults to all-channel so a published robot auto-displays; loading a local folder flips joints/pose to manual preview. Emits a validation report (joints + limits, meshes loaded/failed) consumed by `RobotModelProperties`. Remote meshes load from the hub asset server (anchored on `ur_description/`); local meshes resolve to blob URLs.
- `core/meshResolver.ts` — `LocalAssetResolver`: indexes folder-picked files by `webkitRelativePath`, resolves `package://`/relative refs by **longest trailing-segment match**, and exposes a `THREE.LoadingManager` whose `setURLModifier` routes every loader request (mesh + DAE textures / GLTF `.bin`) to a blob URL.

### `sdks/python` — minimal client
- `webviz/client.py` — `webviz.Client`: WS client that advertises channels and sends JSON/binary frames (mirrors the binary header from `binary.ts`). Requires `pip install websockets`.
- `demo_source.py` — dependency-free demo; publishes transforms/markers via the hub's HTTP `/api/inject` instead of WS.

## When changing the protocol

Edit `packages/protocol/src`, rebuild it, then update consumers. The Python SDK's binary header packing (`struct.pack("<B3xIdI", …)`) duplicates `binary.ts` — keep both in sync when the frame layout changes. `PROTOCOL_VERSION` lives in `protocol/src/index.ts` and is sent in the `server_info` handshake.
