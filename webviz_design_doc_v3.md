# WebViz — Design Document v3.0
**Protocol-First · Source-Agnostic · Tabbed Workspace**

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Core Philosophy](#2-core-philosophy)
3. [System Architecture](#3-system-architecture)
4. [WebViz Wire Protocol](#4-webviz-wire-protocol)
5. [WebViz Hub](#5-webviz-hub)
6. [Data Source SDKs](#6-data-source-sdks)
7. [Browser App — Protocol Layer](#7-browser-app--protocol-layer)
8. [Browser App — Core Services](#8-browser-app--core-services)
9. [Tab System](#9-tab-system)
10. [Display Plugins](#10-display-plugins)
11. [UI Design](#11-ui-design)
12. [Technology Stack](#12-technology-stack)
13. [Project Structure](#13-project-structure)
14. [Deployment](#14-deployment)
15. [Risks & Mitigations](#15-risks--mitigations)
16. [Architectural Notes](#16-architectural-notes)

---

## 1. Executive Summary

WebViz is a browser-based visualization platform for robots and real-time systems. It provides a multi-tab workspace for visualizing 3D scenes, sensor data, camera feeds, time-series plots, maps, and raw data — all driven by a lightweight, well-defined WebSocket protocol that any system can implement.

**Three design pillars:**

| Pillar | Meaning |
|---|---|
| Protocol-first | The webapp defines the wire format. ROS, custom robots, simulators — any source that speaks the protocol is a first-class citizen. |
| Source-agnostic | The browser has zero knowledge of ROS or any specific robot stack. |
| Tabbed workspace | Different viewers (3D, camera grid, plots, map, inspector, log) live in dedicated tabs, each with its own layout and subscriptions — while sharing one WebSocket connection. |

---

## 2. Core Philosophy

```
 v1 (ROS-centric)                  v3 (Protocol-first + Tabs)
 ──────────────────────────────────────────────────────────────────────
 Browser depends on ROS            Browser depends on the protocol only
 One monolithic 3D view            Multiple specialized tabs per use case
 Hard to add new data sources      Any source adds a thin SDK (~50 lines)
 Multiple sources: not supported   Hub multiplexes any number of sources
 Layout: all panels in one view    Layout: tabs → panels → plugins
```

The golden rule: **the browser does not know where the data comes from**. It only knows channel names and schema types. Whether data arrives from a ROS 2 robot, a Python script, a MuJoCo simulation, or a pre-recorded file is irrelevant.

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Data Sources  (anything that opens a WebSocket)                        │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  ┌──────────┐  │
│  │ ROS 2 Adapter│  │ Python SDK   │  │ C++ SDK       │  │ HTTP POST│  │
│  │ (rclpy node) │  │ (any system) │  │ (embedded MCU)│  │ (batch)  │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  └────┬─────┘  │
└─────────┼─────────────────┼───────────────────┼───────────────┼────────┘
          │      WebViz Wire Protocol  (WebSocket · JSON + binary)
          └──────────────────────────┬────────────────────────────┘
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  WebViz Hub  (Node.js relay — optional but recommended)                 │
│                                                                         │
│  WebSocket broker · Channel registry · Asset server · Session store     │
│  :7777 (WS)  ·  :8080 (HTTP: webapp, assets, layouts, REST API)        │
└─────────────────────────────────────────────────────────────────────────┘
                               │ WebSocket
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Browser App                                                            │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Protocol layer:  HubClient · FrameDecoder · MessageRouter      │   │
│  ├─────────────────────────────────────────────────────────────────┤   │
│  │  Core services:   TFManager · SceneManager · PluginRegistry     │   │
│  │                   LayoutManager (tabs + panels)                 │   │
│  ├─────────────────────────────────────────────────────────────────┤   │
│  │  Tab types:       3D View · Image Viewer · Plot · Map 2D        │   │
│  │                   Inspector · Log  (+ user-defined)             │   │
│  ├─────────────────────────────────────────────────────────────────┤   │
│  │  Display plugins: RobotModel · PointCloud · Marker · LaserScan  │   │
│  │                   OccupancyGrid · Path · Pose · Image · Custom  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. WebViz Wire Protocol

The protocol is the contract. Every data source must implement it; the browser implements nothing else.

### 4.1 Transport

- **WebSocket (unified pipeline)** — a single, persistent TCP connection handles all data. Text frames carry low-bandwidth JSON messages (transforms, markers, parameters). Binary frames are strictly enforced for high-bandwidth payloads (point clouds, images). This guarantees deterministic, ordered delivery of all system state — critical for correlating sensor data with coordinate transforms.
- **HTTP POST** — for one-shot or batch data injection (no persistent connection needed).
- **Encoding** — JSON for control messages and light telemetry; zero-copy binary `ArrayBuffer` for `wv/PointCloud` and `wv/Image` to protect the browser's main thread from decode overhead.

### 4.2 Connection Handshake

Hub sends on connect:
```json
{
  "op": "server_info",
  "version": "1.0",
  "capabilities": ["time_sync", "parameters", "recording"],
  "channels": [
    { "id": 1, "name": "transforms",   "schema": "wv/Transform",     "encoding": "json" },
    { "id": 2, "name": "joint_states", "schema": "wv/JointState",    "encoding": "json" },
    { "id": 3, "name": "lidar_front",  "schema": "wv/PointCloud",    "encoding": "binary" },
    { "id": 4, "name": "markers",      "schema": "wv/Marker",        "encoding": "json" }
  ]
}
```

Data source dynamically adds/removes channels:
```json
{ "op": "advertise",   "channel": { "name": "battery", "schema": "wv/Custom", "encoding": "json" } }
{ "op": "unadvertise", "channel_name": "battery" }
```

Browser subscribes, with optional Quality of Service (QoS) parameters:
```json
{
  "op": "subscribe",
  "channels": [
    { "id": 1 },
    { "id": 2 },
    { "id": 3, "max_hz": 15 }
  ]
}
```

`max_hz` is enforced by the Hub — it tracks the last-forwarded timestamp per (channel, client) pair and drops frames that arrive faster than the requested rate. This lets the UI dynamically reduce bandwidth (e.g., 15 Hz for a 2×2 image grid, full rate for a focused single-camera view).

`resolution` downsampling is **not** handled by the Hub (which is a byte relay and never decodes image content). To request a lower-resolution stream, send a `set_parameter` control message to the data source directly and let it publish a reduced-resolution channel.

### 4.3 Message Frames

**JSON frame:**
```json
{ "op": "message", "channel_id": 2, "timestamp": 1718000000.123, "data": { ... } }
```

**Binary frame** (for point clouds / images):
```
Bytes  0       : uint8  — op code (0x01)
Bytes  1–3     : uint8  — reserved (zero)
Bytes  4–7     : uint32 — channel_id
Bytes  8–15    : float64 — timestamp (unix seconds)
Bytes  16–19   : uint32 — payload_length
Bytes  20+     : payload (schema-specific)
```

### 4.4 Channel Schemas

#### `wv/Transform`
```json
{
  "frame_id": "base_link",
  "parent_frame_id": "odom",
  "translation": [1.2, 0.0, 0.05],
  "rotation": [0.0, 0.0, 0.707, 0.707]
}
```
`rotation` is quaternion `[x, y, z, w]`. Send a `wv/TransformArray` (array of the above) to batch multiple transforms in one message.

#### `wv/JointState`
```json
{
  "names":      ["left_shoulder", "left_elbow"],
  "positions":  [0.52, -1.10],
  "velocities": [0.01, 0.00],
  "efforts":    [1.2, 0.8]
}
```

#### `wv/RobotModel`
```json
{
  "name":     "my_robot",
  "urdf_url": "http://asset-server:8080/urdf/my_robot.urdf",
  "package_map": {
    "my_robot_description": "http://asset-server:8080/packages/my_robot_description"
  }
}
```
Or inline: `{ "name": "my_robot", "urdf_xml": "<robot name='...'>...</robot>" }`

#### `wv/Marker`
```json
{
  "id": "waypoint_3",
  "namespace": "waypoints",
  "action": "add",
  "type": "sphere",
  "frame_id": "map",
  "pose": { "position": [4.5, 2.1, 0.0], "orientation": [0,0,0,1] },
  "scale": [0.3, 0.3, 0.3],
  "color": [0.0, 1.0, 0.5, 0.8],
  "lifetime": 5.0
}
```

| `type` | Extra fields | Three.js primitive |
|---|---|---|
| `cube` | — | BoxGeometry |
| `sphere` | — | SphereGeometry |
| `cylinder` | — | CylinderGeometry |
| `arrow` | `shaft_length`, `head_length`, `width` | Cylinder + Cone |
| `line_strip` | `points: [[x,y,z],…]` | Line / BufferGeometry |
| `line_list` | `points` (pairs) | LineSegments |
| `points` | `points`, `colors` (per-point) | Points |
| `text` | `text`, `font_size` | CSS2DObject |
| `mesh` | `mesh_url`, `mesh_format` | GLTFLoader / ColladaLoader |
| `triangle_list` | `points`, `colors` | BufferGeometry |

`action`: `"add"` / `"modify"` / `"delete"` / `"delete_namespace"` / `"delete_all"`

#### `wv/PointCloud`
JSON (small clouds):
```json
{
  "frame_id": "lidar_link",
  "fields": [
    { "name": "x", "offset": 0, "type": "float32" },
    { "name": "y", "offset": 4, "type": "float32" },
    { "name": "z", "offset": 8, "type": "float32" },
    { "name": "intensity", "offset": 12, "type": "float32" }
  ],
  "data": "<base64>"
}
```

Binary payload (after 20-byte header): `[uint32 point_count][uint8 field_flags][float32 × N × fields]`

`field_flags`: bit 0 = has_intensity, bit 1 = has_rgb, bit 2 = has_normal.

#### `wv/LaserScan`
```json
{
  "frame_id": "laser_link",
  "angle_min": -3.14159, "angle_max": 3.14159, "angle_increment": 0.00873,
  "range_min": 0.1, "range_max": 25.0,
  "ranges": [1.2, 1.3, 0.9, "Inf", ...],
  "intensities": [120, 110, 95, 0, ...]
}
```

#### `wv/OccupancyGrid`
```json
{
  "frame_id": "map",
  "resolution": 0.05,
  "width": 400, "height": 400,
  "origin": { "position": [-10.0, -10.0, 0.0], "orientation": [0,0,0,1] },
  "data": "<base64 uint8 — 0=free, 100=occupied, 255=unknown>"
}
```

#### `wv/Path`
```json
{
  "id": "nav_plan", "frame_id": "map", "color": [0.2, 0.8, 1.0, 1.0],
  "poses": [
    { "position": [0.0, 0.0, 0.0], "orientation": [0,0,0,1] },
    { "position": [1.0, 0.5, 0.0], "orientation": [0,0,0.38,0.92] }
  ]
}
```

#### `wv/Pose`
```json
{
  "id": "robot_estimate", "frame_id": "map",
  "position": [4.5, 2.1, 0.0], "orientation": [0,0,0.38,0.92],
  "covariance": [0.01, 0, 0, 0, 0, 0, ...]
}
```

#### `wv/Image` (binary only)
Images are sent exclusively as binary frames. Base64 JSON encoding is not supported — it adds ~33% size overhead plus CPU decode cost on every frame, which is prohibitive at 30 Hz for HD cameras. The payload (starting at byte 20, after the standard frame header) is:

```
Bytes 20–23        : uint32 — frame_id string length (N)
Bytes 24–(24+N-1)  : utf8   — frame_id (e.g. "camera_left")
Bytes (24+N)–(27+N): uint32 — width
Bytes (28+N)–(31+N): uint32 — height
Bytes (32+N)–(35+N): uint32 — encoding  (0 = jpeg, 1 = png, 2 = rgb8)
Bytes (36+N)+      : raw image bytes (directly ingestible via createImageBitmap)
```

The browser decodes via `createImageBitmap(blob)` on a canvas 2D context — no intermediate string allocation.

**Future direction — video-coded camera streams (WebCodecs).** The three encodings above are all *intra-frame*: every frame is self-contained, so each one is independently decodable and a late subscriber renders the next frame immediately. That is the right default, but it leaves inter-frame compression on the table — for the common case of a slowly-changing camera scene, MJPEG (encoding `0`) re-sends the whole picture every frame. A future extension adds a video codec as a fourth encoding (`3 = h264`, and/or `4 = av1`), decoded on the client via the browser's **WebCodecs `VideoDecoder`** rather than `createImageBitmap`. The win is bandwidth: a real codec exploits temporal redundancy and is hardware-decoded, the same lever cloud-gaming platforms (e.g. GeForce NOW) pull for camera-grade pixel rates. Crucially this is a **pure, non-breaking extension of the `encoding` enum** — the 20-byte frame header and the `frame_id`/`width`/`height` prefix are unchanged; only the decode branch differs (`decodeImagePayload` switches on `encoding`). We deliberately leave this *un*-implemented for now and keep the intra-frame default, because video coding is **stateful** in a way the current schema is not, and that statefulness has real design cost:

- A coded frame is a *chunk in a stream*, not a standalone image. The decoder must be configured per stream (codec + parameter sets) and frames are key/delta — a subscriber that joins mid-stream sees nothing until the next keyframe. So the source must emit periodic keyframes (and ideally a fresh keyframe on each new subscription), which interacts with the hub's fan-out and the recorder/player (a `.wvrec` seek must land on a keyframe boundary).
- This is the same trade-off as the §16.1 transport discussion: intra-frame is lossless-per-frame and trivially seekable/late-joinable; inter-frame is smaller but couples frames together. The intra-frame default keeps every frame independent, which is why it stays the default and video coding is an opt-in per channel.

This is recorded as a deliberate "ship data, decode locally" choice (consistent with §16.1 / §16.2): WebViz streams camera *data* to each client and lets the browser decode and render it, rather than rendering on the server and streaming pixels — the client GPU is free, interaction is local and zero-latency, and the same bytes fan out unchanged to every viewer. Video-coding the stream is an optimization of *that* path, not a move toward server-side rendering.

#### `wv/Custom`
Any JSON object with a user-defined schema name. Displayed in the Inspector tab as a JSON tree.

### 4.5 Control Messages (bidirectional)
```json
{ "op": "time",           "timestamp": 1718000000.123 }
{ "op": "get_parameter",  "id": "req_01", "name": "fixed_frame" }
{ "op": "parameter_value","id": "req_01", "value": "odom" }
{ "op": "set_parameter",  "name": "point_size", "value": 2.5 }
{ "op": "heartbeat",      "source_id": "ros2_adapter", "healthy": true }
{ "op": "error",          "code": "schema_mismatch", "message": "..." }
```

---

## 5. WebViz Hub

A lightweight Node.js relay server (~300 lines). **Optional** — a source can connect directly to the browser for single-source, single-client setups.

### Responsibilities
- Accept WebSocket connections from both data sources and browser clients.
- Maintain the channel registry (who publishes what schema).
- Fan out messages from sources → all subscribed browsers.
- Merge multiple simultaneous data sources (name-prefix collision avoidance).
- Serve the static webapp and asset files (URDF, meshes).
- Store and serve layout configurations (REST API).
- Optional: record sessions to MCAP files for replay.

### Endpoint Summary
```
WebSocket :7777          Sources + browser clients
GET  :8080/              Static React app (built bundle)
GET  :8080/assets/*      URDF files, mesh files
GET  :8080/api/channels  Active channel list + metadata
GET  :8080/api/layouts   Saved workspace layouts
POST :8080/api/layouts   Save a layout
DEL  :8080/api/layouts/:name
POST :8080/api/inject    One-shot data injection (HTTP, no WS needed)
```

### Channel Name Collision
If two sources advertise the same channel name, the Hub prefixes with the source ID:
```
source "ros2" + channel "lidar" → ros2/lidar
source "sim"  + channel "lidar" → sim/lidar
```
The browser's Channel Browser shows both and the user selects which to subscribe to.

---

## 6. Data Source SDKs

### 6.1 Python SDK
```python
import webviz, numpy as np

client = webviz.Client("ws://localhost:7777?role=source")
tf_chan    = client.advertise("transforms",  "wv/Transform")
cloud_chan = client.advertise("lidar_front", "wv/PointCloud", encoding="binary")
marker_chan = client.advertise("markers",    "wv/Marker")

while True:
    tf_chan.send({
        "frame_id": "base_link", "parent_frame_id": "odom",
        "translation": [robot.x, robot.y, 0.0], "rotation": robot.quaternion
    })
    cloud_chan.send_binary(np.array(lidar.points, dtype=np.float32))
    time.sleep(0.05)
```

### 6.2 ROS 2 Adapter
```python
# Drop-in ROS 2 node — zero changes to your existing robot code
class WebVizAdapter(Node):
    def __init__(self):
        super().__init__('webviz_adapter')
        self.client = webviz.Client("ws://localhost:7777?role=source&id=ros2")
        self.tf_chan = self.client.advertise("transforms",   "wv/Transform")
        self.js_chan = self.client.advertise("joint_states", "wv/JointState")
        self.pc_chan = self.client.advertise("lidar_front",  "wv/PointCloud", encoding="binary")

        self.create_subscription(TFMessage,  '/tf',           self.on_tf, 10)
        self.create_subscription(JointState, '/joint_states', self.on_js, 10)
        self.create_subscription(PointCloud2,'/lidar/points', self.on_pc, 10)
```

### 6.3 C++ SDK (header-only)
Designed for embedded controllers and high-performance nodes. Supports zero-copy binary framing to prevent memory reallocation when pushing large camera buffers or dense point clouds.

```cpp
#include "webviz/client.hpp"
webviz::Client client("ws://192.168.1.10:7777?role=source");

// Standard JSON telemetry
auto tf_chan = client.advertise("transforms", "wv/Transform");
tf_chan.send({{"frame_id","base_link"},{"parent_frame_id","odom"},
              {"translation",{pose.x, pose.y, 0.0}},{"rotation",{qx,qy,qz,qw}}});

// High-throughput binary image (zero-copy: raw_jpeg_buffer is not copied)
auto cam_chan = client.advertise("camera_front", "wv/Image", webviz::Encoding::BINARY);
cam_chan.send_binary(width, height, webviz::ImageFormat::JPEG, raw_jpeg_buffer, buffer_size);
```

`send_binary` writes the frame header and payload fields (frame_id, width, height, encoding enum, raw bytes) directly into the WebSocket send buffer using scatter-gather I/O — no intermediate allocation.

### 6.4 HTTP Batch Upload
```bash
curl -X POST http://localhost:8080/api/inject \
  -H "Content-Type: application/json" \
  -d '{"channel":"map","schema":"wv/OccupancyGrid","data":{...}}'
```

---

## 7. Browser App — Protocol Layer

The browser app speaks WebViz protocol only. The rendering layer (Three.js, plugins) has no awareness of where data comes from.

```
HubClient
  │  raw WebSocket frames (text/binary)
  ▼
FrameDecoder
  │  decoded { channel_id, timestamp, data }
  ▼
MessageRouter
  │  routes by channel_id → registered plugin handlers
  ▼
Plugin instances (per-tab)
  │  typed data
  ▼
SceneManager / TFManager
```

```typescript
class HubClient {
  connect(url: string): void;
  disconnect(): void;
  getStatus(): 'connecting' | 'connected' | 'disconnected' | 'error';
  subscribe(channelName: string, handler: MessageHandler): () => void;
  send(msg: object): void;
  onChannelList(cb: (channels: ChannelInfo[]) => void): void;
}

class MessageRouter {
  register(channelName: string, handler: MessageHandler): () => void;
  dispatch(channelId: number, timestamp: number, data: unknown): void;
}
```

**The connection is a singleton per browser window** — all tabs share it. The MessageRouter dispatches the same message to every registered handler across all tabs. Each tab's plugin instances register and unregister handlers as tabs are activated/deactivated.

---

## 8. Browser App — Core Services

### TFManager
Subscribes to the `transforms` channel. Maintains a 5-second rolling buffer of stamped transforms. Provides `lookupTransform(frameId, time?)` to all plugins.

```typescript
class TFManager {
  setFixedFrame(frame: string): void;
  getFixedFrame(): string;
  lookupTransform(frameId: string, time?: number): Transform | null;
  getFrameList(): string[];
}
```

Interpolation uses **SLERP** (Spherical Linear Interpolation) for rotations and **LERP** for translations between the two nearest buffered timestamps. Nearest-neighbor is not used — it produces visible stepping on fast-moving end-effectors and high-frequency trajectories.

### TimeManager
Because all data arrives over a single ordered TCP stream, messages are globally sequenced. The `TimeManager` buffers incoming high-frequency frames by a configurable window (default 20 ms) before dispatching them to plugins.

```typescript
class TimeManager {
  setSyncWindow(ms: number): void;   // default 20ms; reduce for lower-latency monitoring
  getCurrentTime(): number;          // wall-clock or replay time
  enqueue(channelId: number, timestamp: number, data: unknown): void;
  // Flushes frames whose timestamp ≤ (now - syncWindow) to MessageRouter
}
```

**Why this matters:** by the time a `wv/PointCloud` or `wv/Image` frame is dispatched to the scene, the surrounding `wv/Transform` messages have already arrived and been indexed in the TFManager buffer. `lookupTransform(frameId, frame.timestamp)` then returns an interpolated pose rather than failing with "transform not yet available." This is especially important for evaluating sensor fusion, motion planning, and fast trajectory segments.

### SceneManager
Owns the Three.js scene, renderer, camera, OrbitControls, and the `requestAnimationFrame` loop. Plugins add/remove Object3D instances through it. All `requestRender()` calls are coalesced into a single draw per frame.

```typescript
class SceneManager {
  addObject(pluginId: string, obj: THREE.Object3D): void;
  removeObject(pluginId: string): void;
  requestRender(): void;      // coalesces multiple → single rAF
  setFixedFrame(frame: string): void;
  takeScreenshot(): Blob;
}
```

### PluginRegistry
Manages plugin factories and active instances. Plugins are per-tab-instance — two 3D tabs have separate plugin instances but share the same HubClient and TFManager.

### LayoutManager
Owns the complete workspace state.

```typescript
interface WorkspaceConfig {
  version:    string;
  tabs:       TabConfig[];
  activeTabId: string;
  connection: { url: string };
}

interface TabConfig {
  id:       string;
  name:     string;
  type:     TabType;          // '3d' | 'image' | 'plot' | 'map' | 'inspector' | 'log'
  pinned:   boolean;
  panelLayout: MosaicNode;   // react-mosaic tree (for 3D tab)
  displays: DisplayConfig[]; // plugin instances + settings
  camera?:  CameraConfig;    // 3D viewport camera state
  settings: Record<string, unknown>; // tab-type-specific settings
}

class LayoutManager {
  save(name: string): void;       // persists to localStorage + Hub API
  load(name: string): void;
  list(): string[];
  export(): string;               // JSON for file download
  import(json: string): void;
  toURL(): string;                // layout as base64 query param
}
```

---

## 9. Tab System

The tab system is the top-level organizing structure of the webapp. Each tab is an independent workspace with its own layout, plugins, and settings — but they all share the same Hub connection and TF tree.

### 9.1 Tab Types

| Type | Purpose | Key panels |
|---|---|---|
| `3d` | Main 3D visualization | Displays sidebar, Three.js viewport, Properties panel |
| `image` | Camera feeds | Configurable N×M grid of image panels, each bound to a `wv/Image` channel |
| `plot` | Time-series data | Recharts line chart, channel/field selector, time window slider |
| `map` | 2D occupancy view | Orthographic top-down canvas with robot + path overlays, settings sidebar |
| `inspector` | Protocol debugging | Channel selector, live JSON tree, pause/resume, copy |
| `log` | Event stream | Filtered log list with level toggles, source filter, text search |

Users can also register **custom tab types** following the same factory interface.

### 9.2 Tab State Model

```typescript
type TabType = '3d' | 'image' | 'plot' | 'map' | 'inspector' | 'log';

interface TabConfig {
  id:          string;      // uuid
  name:        string;      // user-visible label
  type:        TabType;
  pinned:      boolean;     // if true, no close button
  icon:        string;      // Tabler icon class name
  settings:    Record<string, unknown>;  // type-specific
}

// The tab store (Zustand)
interface TabStore {
  tabs:        TabConfig[];
  activeTabId: string;
  addTab(type: TabType): void;
  closeTab(id: string): void;
  renameTab(id: string, name: string): void;
  pinTab(id: string, pinned: boolean): void;
  reorderTab(id: string, direction: 'left' | 'right'): void;
  activateTab(id: string): void;
  duplicateTab(id: string): void;
}
```

### 9.3 Tab Lifecycle

```
addTab('3d')
  → generate uuid
  → push to tabs[]
  → create TabRenderer instance (mounts React subtree)
  → TabRenderer initializes its plugin instances
  → plugin instances register channel subscriptions via MessageRouter

closeTab(id)
  → plugin instances call destroy() (unsubscribes channels, disposes Three.js objects)
  → TabRenderer unmounts
  → remove from tabs[]

Tab becomes inactive (user clicks another tab)
  → plugin subscriptions remain active (data continues flowing)
  → SceneManager pauses rAF for inactive 3D tabs (saves GPU)
  → Optional: throttle subscriptions to reduce bandwidth (configurable)

Tab becomes active
  → SceneManager resumes rAF
  → subscriptions return to full rate
```

### 9.4 Shared vs. Isolated State

| State | Shared across tabs | Tab-local |
|---|---|---|
| Hub connection | ✓ | |
| TF tree | ✓ | |
| Channel list | ✓ | |
| Plugin instances | | ✓ |
| Three.js scene | | ✓ |
| Camera state | | ✓ |
| Panel layout | | ✓ |
| Subscriptions | | ✓ (per plugin) |
| Properties panel selection | | ✓ |

### 9.5 Tab Bar UX

- **Pinned tabs**: no close button, visually marked with a pin icon. Good for always-on tabs like "3D view" and "Log."
- **Right-click context menu**: Rename, Duplicate, Pin/Unpin, Move left, Move right, Close.
- **Overflow**: when tabs exceed the bar width, scroll arrows appear. A "..." overflow menu shows hidden tabs.
- **Drag to reorder**: HTML5 drag-and-drop reorders tabs.
- **Keyboard shortcuts**: `Ctrl+T` new tab, `Ctrl+W` close, `Ctrl+1..9` switch to tab N.

### 9.6 The 3D Tab's Internal Panel System

The `3d` tab type has its own sub-layout: a resizable three-column arrangement managed by `react-mosaic`.

```
┌──────────────────────────────────────────────────────────────┐
│  Displays panel  │  3D Viewport (Three.js)  │  Properties   │
│  (186px)         │  (flex-1)                │  (172px)      │
│                  │                          │               │
│  List of active  │  OrbitControls           │  Selected     │
│  display plugins │  Grid + axes             │  plugin       │
│  with enable     │  Robot, clouds,          │  settings     │
│  toggle          │  markers, etc.           │  (auto-form   │
│                  │                          │   from schema)│
└──────────────────────────────────────────────────────────────┘
```

Sidebar widths are user-resizable. Both sidebars can be collapsed to give the viewport full width.

---

## 10. Display Plugins

Each plugin is a self-contained unit that subscribes to one or more channels and manages Three.js objects.

```typescript
interface DisplayPlugin {
  id:       string;          // uuid, unique per instance
  type:     string;          // "RobotModel" | "PointCloud2" | ...
  name:     string;          // user label
  enabled:  boolean;

  initialize(ctx: PluginContext): Promise<void>;
  destroy(): void;
  onRender(dt: number): void;

  getSchema(): JSONSchema7;  // drives the auto-generated Properties form
  getSettings(): Record<string, unknown>;
  updateSettings(patch: Record<string, unknown>): void;
}

interface PluginContext {
  ros: HubClient;        // subscribe / publish
  tf:  TFManager;        // transform lookups
  scene: SceneManager;   // Three.js scene
}
```

### Plugin Catalogue

| Plugin | Schema(s) consumed | Rendering approach |
|---|---|---|
| `RobotModel` | `wv/RobotModel` + `wv/JointState` + `wv/Transform` | urdf-loader → Three.js bone tree |
| `PointCloud` | `wv/PointCloud` | WebWorker binary decoder + custom GLSL shader |
| `TFFrames` | `wv/Transform` | Axes + labels + parent–child lines |
| `Marker` | `wv/Marker` | 10 geometry types; `InstancedMesh` for list types |
| `LaserScan` | `wv/LaserScan` | Polar → Cartesian → `THREE.Points` |
| `OccupancyGrid` | `wv/OccupancyGrid` | `DataTexture` on `PlaneGeometry` |
| `Path` | `wv/Path` | `TubeGeometry` or `Line` |
| `Pose` | `wv/Pose` | Arrow + covariance ellipse |
| `Image` | `wv/Image` | Canvas 2D (not 3D viewport) |
| `Custom` | Any `wv/Custom` | JSON tree inspector |

### PointCloud Plugin — Performance Detail

The most performance-sensitive plugin. A Velodyne VLP-16 produces ~300k points at 10 Hz.

```
Binary WebSocket frame arrives
  → MessageRouter dispatches to PointCloud plugin handler
  → handler posts to WebWorker (transferable buffer, zero-copy)

WebWorker decodes:
  → reads field_flags, point_count from header
  → slices Float32Array views for x, y, z, intensity
  → posts { positions: Float32Array, colors: Float32Array } back

Main thread:
  → updates BufferGeometry attribute arrays (needsUpdate = true)
  → calls SceneManager.requestRender()
```

GLSL vertex shader applies intensity-based coloring via a texture lookup (turbo/viridis/jet colormap).

---

## 11. UI Design

### 11.1 Chrome Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ ⬡ WebViz  [ws://robot.local:7777]  [● 2 sources]       ⚙  💾  ⏺   │  ← Top bar (34px)
├──────────────────────────────────────────────────────────────────────┤
│ [⬡ 3D view ×] [🎞 Cameras ×] [📈 Plot ×] [🗺 Map ×] [🔍 Insp ×] [+]│  ← Tab bar (38px)
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│         Active tab content area  (flex-1)                           │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ ⌚ 12ms  📡 8 channels  🔄 28 FPS                     🕐 14:52:03   │  ← Status bar (21px)
└──────────────────────────────────────────────────────────────────────┘
```

### 11.2 3D Tab Layout

```
┌────────────────┬───────────────────────────────────┬───────────────┐
│  Displays      │                                   │  Properties   │
│  (186px)       │      Three.js canvas              │  (172px)      │
│                │                                   │               │
│  [+ Add]       │  Perspective camera               │  Selected     │
│                │  OrbitControls                    │  plugin form  │
│  ▼ Robot   ●  │  Grid + world axes                 │  (auto-gen'd  │
│  ▼ LiDAR   ●  │  All active plugins rendered       │   from schema)│
│  ▼ Markers ●  │                                    │               │
│  ▶ TF      ○  │  [⊤] [→] [⊙] camera presets       │               │
│  ▶ Map     ○  │  (top-right corner overlays)       │               │
└────────────────┴───────────────────────────────────┴───────────────┘
```

### 11.3 Image Viewer Tab Layout

```
[Layout: 2×2 ▾]  [+ Add camera]     [Sync playback ☑]
┌────────────────────┬────────────────────┐
│ camera_left        │ camera_right       │
│ wv/Image · 30 Hz  │ wv/Image · 30 Hz  │
│                    │                    │
│ [live canvas]      │ [live canvas]      │
├────────────────────┼────────────────────┤
│ camera_depth       │ camera_wide        │
│ wv/Image · 15 Hz  │ Not subscribed     │
│                    │                    │
│ [live canvas]      │ [empty state]      │
└────────────────────┴────────────────────┘
```
Grid layout is user-configurable (1×1, 1×2, 2×2, 3×2). Each cell independently chooses a channel.

### 11.4 Plot Tab Layout

```
[Channels: joint_states/left_shoulder ×   left_elbow ×   right_shoulder ×   [+]]   [Window: 10s ▾]  [⏸]
┌──────────────────────────────────────────────────────────────────────┐
│ 2.0 ─ ···················································           │
│ 1.0 ─                          ╭╮              ╭╮                   │
│ 0.0 ─ ─────────────────────────╯╰──────────────╯╰──────────────── ─│
│-1.0 ─         ╭╮                                                    │
│-2.0 ─ ────────╯╰──────────────────────────────────────────────── ─ │
│       0s      2s      4s      6s      8s     10s                    │
└──────────────────────────────────────────────────────────────────────┘
── left_shoulder    ── left_elbow    ── right_shoulder      50 Hz · 500 pts
```

### 11.5 Map 2D Tab Layout

```
┌────────────────────────────────────────┬────────────┐
│                                        │ Map 2D     │
│   2D canvas (orthographic top-down)    │ Channel:   │
│                                        │ [map ▾]    │
│   [occupancy grid texture]             │ Alpha: ─── │
│   [robot triangle arrow]               │ Show robot ☑│
│   [planned path dashed line]           │ Show path  ☑│
│   [laser scan fan]                     │ Show scan  ☑│
│   [goal marker]                        │ Show goals ○│
│                                        │            │
│   1 cell = 5 cm · N ↑                 │            │
└────────────────────────────────────────┴────────────┘
```

### 11.6 Inspector Tab Layout

```
[Channel: transforms ▾]  [50 Hz]  [last: 18ms ago]       [⏸] [📋]
┌──────────────────────────────────────────────────────────────────────┐
│ {                                                                    │
│   "channel":   "transforms",                                        │
│   "timestamp": 1718049284.472,                                      │
│   "data": {                                                          │
│     "frame_id":        "base_link",                                 │
│     "parent_frame_id": "odom",                                      │
│     "translation":     [1.242, 0.831, 0.050],                       │
│     "rotation":        [0.000, 0.000, 0.391, 0.920]                 │
│   }                                                                  │
│ }                                                                    │
└──────────────────────────────────────────────────────────────────────┘
```

### 11.7 Log Tab Layout

```
[⏸] [🗑] [Filter...         ]  [☑ INFO] [☑ WARN] [☑ ERROR] [○ DEBUG]    1,284 entries
┌──────────────────────────────────────────────────────────────────────────┐
│ 14:52:03.421  INFO   hub_client    Connected to ws://robot.local:7777   │
│ 14:52:03.512  DEBUG  tf_manager    Received 12 static transforms         │
│ 14:52:04.102  WARN   pointcloud    Frame lidar_link not in TF tree       │
│ 14:52:09.221  ERROR  urdf_loader   Mesh 404: package://robot_desc/arm   │
│ 14:52:10.003  INFO   scene_mgr     Steady 28 FPS · 8 channels active    │
└──────────────────────────────────────────────────────────────────────────┘
```

### 11.8 Camera Controls (3D Tab)

| Action | Input |
|---|---|
| Orbit | Left-drag |
| Pan | Middle-drag or right-drag |
| Zoom | Scroll wheel |
| Focus on object | Double-click |
| Reset view | `F` key |
| Top / Front / Side preset | `Numpad 7 / 1 / 3` |
| Toggle perspective / orthographic | `P` |
| Screenshot | `Ctrl+Shift+S` |

### 11.9 Keyboard Shortcuts (Global)

| Shortcut | Action |
|---|---|
| `Ctrl+T` | New tab (opens picker) |
| `Ctrl+W` | Close active tab |
| `Ctrl+1` … `Ctrl+9` | Switch to tab N |
| `Ctrl+S` | Save layout |
| `Ctrl+Shift+P` | Command palette (search all actions) |

---

## 12. Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| 3D rendering | Three.js r165+ | WebGL, custom GLSL, large ecosystem |
| UI framework | React 18 + TypeScript | Component model maps to plugin/panel architecture |
| State management | Zustand | Lightweight, high-frequency updates without re-renders |
| Panel layout (3D tab) | react-mosaic | Resizable, dockable split panes |
| Tab management | Custom (Zustand store) | Native feel, full control |
| Time-series charts | Recharts | Declarative, performant for ~500 pts |
| URDF parsing | urdf-loader | Fetches from asset server, Three.js integration |
| Build | Vite + pnpm workspaces | Fast HMR, tree-shaking, monorepo |
| Hub server | Node.js + `ws` | ~300 lines; minimal footprint |
| Asset server | FastAPI (Python) or Express | Co-located with ROS environment if needed |
| Python SDK | asyncio + websockets | `pip install webviz-client` |
| ROS 2 adapter | rclpy + webviz-client | `pip install webviz-ros2` |
| Wire encoding | JSON + custom binary | No protobuf dependency; human-readable for debugging |
| Testing | Vitest (unit) + Playwright (E2E) | Modern, fast, TypeScript-native |
| Styling | Tailwind CSS + shadcn/ui | Rapid dark-theme UI development |

---

## 13. Project Structure

```
webviz/
├── packages/
│   │
│   ├── protocol/                     # Shared TypeScript schema types
│   │   └── src/
│   │       ├── schemas/              # wv/Transform.ts, wv/PointCloud.ts, …
│   │       ├── binary.ts             # Binary frame encode/decode
│   │       └── index.ts
│   │
│   ├── hub/                          # Hub relay server (Node.js)
│   │   └── src/
│   │       ├── broker.ts             # WebSocket fanout
│   │       ├── channel_registry.ts
│   │       ├── asset_server.ts       # URDF, meshes, static webapp
│   │       ├── session_store.ts      # Layout CRUD, recording
│   │       └── main.ts
│   │
│   └── app/                          # Browser app (React + Vite)
│       └── src/
│           ├── protocol/             # HubClient, FrameDecoder, MessageRouter
│           ├── core/                 # TFManager, SceneManager, PluginRegistry
│           ├── layout/               # LayoutManager, tab store, workspace
│           ├── tabs/                 # Tab type registry + renderers
│           │   ├── TabRegistry.ts
│           │   ├── ThreeDTab/        # 3D view tab (viewport + sidebars)
│           │   ├── ImageTab/         # Image viewer tab
│           │   ├── PlotTab/          # Time-series plot tab
│           │   ├── MapTab/           # 2D map tab
│           │   ├── InspectorTab/     # JSON inspector tab
│           │   └── LogTab/           # Log stream tab
│           ├── plugins/              # Display plugins
│           │   ├── base/DisplayPlugin.ts
│           │   ├── RobotModelPlugin/
│           │   ├── PointCloudPlugin/
│           │   │   ├── index.ts
│           │   │   ├── decoder.worker.ts
│           │   │   └── shaders/
│           │   ├── MarkerPlugin/
│           │   ├── LaserScanPlugin/
│           │   ├── OccupancyGridPlugin/
│           │   ├── PathPlugin/
│           │   ├── PosePlugin/
│           │   ├── ImagePlugin/
│           │   └── CustomPlugin/
│           ├── ui/                   # Shared UI components
│           │   ├── TopBar/
│           │   ├── TabBar/           # Tab bar + context menu + keyboard nav
│           │   ├── StatusBar/
│           │   ├── panels/           # Displays, Properties, ChannelBrowser
│           │   ├── forms/            # JSON Schema → React form
│           │   └── viewport/         # Three.js canvas mount + overlay buttons
│           ├── store/                # Zustand stores
│           │   ├── connection.store.ts
│           │   ├── tabs.store.ts
│           │   ├── displays.store.ts
│           │   └── layout.store.ts
│           └── main.tsx
│
└── sdks/
    ├── python/                       # pip install webviz-client
    │   ├── webviz/client.py
    │   ├── webviz/channels.py
    │   └── webviz/encoders.py        # numpy → binary frame
    ├── python_ros2/                  # pip install webviz-ros2
    │   └── webviz_ros2/adapter_node.py
    └── cpp/                          # Header-only C++ SDK
        └── include/webviz/
            ├── client.hpp
            └── schemas.hpp
```

---

## 14. Deployment

### Option A — All-in-one (robot or edge computer)
```
Robot ──► Python SDK ──► Hub :7777
                          │
                          ├── serves webapp at :8080
                          └── serves URDF/meshes at :8080/assets

User opens http://robot-ip:8080 in browser
```

### Option B — Hub on edge, sources anywhere
```
Robot A ──► Python SDK ──┐
Robot B ──► C++ SDK ─────┼──► Hub (edge server or laptop) :7777
Simulator ───────────────┘         │
                                   └── Browser (same network)
```

### Option C — Cloud relay (remote access)
```
Robot ──► Python SDK ──► Hub (cloud VM, TLS) ──► Browser (anywhere)
```
Add `wss://` and JWT auth for any public-facing deployment.

### Option D — Per-user desktop app (installed client)
```
Robot ──► SDK ──► Hub (one box on the LAN) :7777   ◄── data broadcast
                   └── :8080  /api (layouts) + /assets (meshes)
                              ▲        ▲        ▲
                          User A   User B   User C    ← each runs an installed
                           app      app      app        app; subscribes by name
```
Instead of every user opening `http://hub:8080`, the app ships as a downloadable, double-click client that each viewer installs once. The Hub keeps only its broker + `/api` + `/assets` roles; serving the app bundle becomes the installer's job. This is purely a *distribution* change — the app is already a pure WebSocket subscriber, so the wire protocol is unchanged, and the deployment becomes a clean publisher/subscriber system (sources publish to the Hub; each installed app subscribes to the channels it wants).

**Packaging:** Tauri (≈5–10 MB, OS-native webview, recommended), Electron (≈150 MB, bundles Chromium → rendering identical to the verified browser build), or a PWA ("Install" from the browser — lightest effort, but still browser-backed).

**Prerequisite — one hub address (§16.3).** A served-from-Hub app infers the Hub from `location` + the dev proxy; an installed app (loaded from `file://`) cannot. Before packaging, all three endpoints — WS `:7777`, REST `:8080/api`, assets `:8080/assets` — must derive from a single user-supplied, persisted hub address, surfaced as a "Connect to hub" screen (optionally with mDNS LAN discovery).

**Does not change egress (§16.2).** Local install saves only the one-time app-bundle download; live data still fans out Hub → each client. It is a UX/distribution win, not a scaling one.

### Docker Compose (Option A)
```yaml
version: '3.8'
services:
  webviz-hub:
    build: ./packages/hub
    ports:
      - "7777:7777"
      - "8080:8080"
    volumes:
      - ./assets:/assets:ro
      - ./layouts:/data
    environment:
      - JWT_SECRET=${JWT_SECRET}
      - ALLOWED_ORIGINS=${ALLOWED_ORIGINS}

  webviz-asset-api:
    build: ./services/asset-api
    volumes:
      - /opt/ros:/opt/ros:ro
      - ~/robot_ws:/robot_ws:ro
    ports:
      - "8081:8000"

  nginx:
    image: nginx:alpine
    ports:
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./certs:/certs:ro
    depends_on: [webviz-hub]
```

---

## 15. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| PointCloud2 bandwidth saturates WebSocket | High | High | CBOR or binary encoding; adaptive stride; per-channel throttle |
| URDF `package://` mesh resolution fails | Medium | High | Asset API with `ros2 pkg prefix` resolver; fallback to collision geometry |
| Browser tab memory pressure (large clouds) | Medium | Medium | `decay_time` setting; explicit `Float32Array` reuse; heap size guard |
| WebGL context lost (GPU driver issue) | Low | High | `webglcontextlost` event handler; graceful re-initialization |
| `ctx.roundRect` / browser API availability | Low | Low | Polyfill for older browsers; Vite target config |
| Tab state serialization too large for URL | Medium | Low | gzip + base64 keeps typical layout < 2 KB; Hub API as fallback |
| JWT secret rotation disrupts active sessions | Low | Medium | Refresh token rotation; configurable expiry; graceful re-auth flow |
| ROS 2 adapter misses fast topics (100+ Hz) | Medium | Medium | rosbridge-style throttle_rate per topic; configurable per adapter |
| Multiple browser tabs fighting over a single Hub connection | Low | Low | Hub is multi-client by design; each browser tab is a separate WS client |
| Single-origin fan-out: many viewers of a heavy channel saturate the Hub NIC | Medium | High | Per-(channel, client) `max_hz`; subscribe-by-name (clients pull only what they show); relay/fan-out tier when many viewers share one heavy stream (§16.2) |
| Slow/stalled client backs up Hub memory (no `bufferedAmount` guard) | Medium | Medium | Drop frames for clients whose send buffer exceeds a threshold; disconnect chronically-behind clients (§16.2) |

---

## 16. Architectural Notes

### 16.1 Design decision: unified WebSocket vs. WebRTC

WebRTC was evaluated as a parallel transport layer for real-time video feeds, alongside WebSocket for stateful telemetry data.

**Why unified WebSocket was chosen:**

WebViz is optimized for local-network operation (gigabit Ethernet / strong Wi-Fi), where the priority is deterministic data synchronization rather than minimum glass-to-glass latency.

By multiplexing video, LiDAR, and coordinate transforms over the same TCP stream, WebViz guarantees that camera frames are chronologically aligned with control telemetry. `TFManager.lookupTransform(frameId, frame.timestamp)` works correctly because transforms always arrive before or alongside the frames that reference them — a property that holds on a shared ordered stream but cannot be guaranteed when video travels a separate UDP path. This alignment is a hard requirement for evaluating sensor fusion, motion planning, and control loop correctness.

A unified stream also makes session recording trivial: the Hub writes all bytes to MCAP as they pass through, and replay is byte-for-byte identical to a live connection. With WebRTC, video drifts independently of telemetry, making synchronized MCAP recording exceptionally difficult to implement correctly.

Finally, eliminating ICE/STUN/TURN negotiation reduces Hub complexity to a simple WebSocket broker and removes the need for any NAT-traversal infrastructure.

**When to reconsider:**

If WebViz is deployed for human-in-the-loop teleoperation over the public internet (remote driving via LTE/5G), TCP head-of-line blocking on a degraded connection becomes a safety concern. In that scenario, the Hub should be extended to act as a WebRTC signaling server, offloading video to a hardware-accelerated UDP peer connection. Telemetry would remain on WebSocket. This hybrid model accepts looser video–telemetry sync in exchange for resilient video delivery under packet loss.

### 16.2 Fan-out scaling: single-origin broker

The Hub is one process that is both origin and sole fan-out point: each frame is serialized once (`fanout()` caches the encoded buffer), then `ws.send()` to every subscribed client. Cost is therefore **egress ≈ Σ_channels (frame_size × rate × subscribed_clients)**, and the ceiling is the Hub machine's NIC, then its single event loop. Light JSON channels (TF, JointState) serve dozens of viewers comfortably; a multi-MB `wv/PointCloud` at 10 Hz can saturate a 1 GbE link in ~2 clients.

This is the **live-streaming** fan-out problem, not video-on-demand. Unlike a YouTube file — static, identical bytes for everyone, cacheable at CDN edges — WebViz frames are real-time and per-moment, so there is **nothing to cache** and no edge tier to lean on (closer to YouTube *Live* than to VOD). Two properties keep the single-origin model viable on a LAN: encode-once/send-many, and subscribe-by-name (a client only pulls the channels it displays). The per-(channel, client) `max_hz` throttle lets monitoring viewers trade rate for bandwidth — the crude analogue of adaptive bitrate.

**Gap:** `fanout()` has no backpressure handling — `ws.send()` is issued with no `bufferedAmount` check, so a slow client on a heavy channel grows Hub memory unbounded. A `bufferedAmount`-threshold frame-drop (and disconnect for chronically-behind clients) is the cheap first hardening.

**When to reconsider:** for many simultaneous viewers of the same heavy stream, insert a relay/fan-out tier (Hub → N relay nodes → clients), mirroring a live-streaming CDN. This is the LAN-scaling analogue of Option C's cloud relay, and does not require a protocol change — relays are just clients that re-advertise.

### 16.3 Hub-address resolution (centralized client config)

The app currently locates the Hub three ways: the WS URL from `location.hostname` (or `VITE_HUB_URL`), `/api` + `/assets` via the Vite dev proxy, and RobotModel meshes via an absolute `http://${location.hostname}:8080`. This works only when the app is *served by the Hub*. Any other deployment — the installed desktop app (§14 Option D), or a browser pointed at a separately-hosted app — has no meaningful `location` host and no dev proxy.

The fix is one source of truth: a user-supplied, persisted hub address from which **all** endpoints (WS `:7777`, REST/assets `:8080`) are derived, presented as a "Connect to hub" screen and optionally discovered via mDNS. This is a prerequisite for Option D and also tidies the remote-browser/VM case — the connection field already overrides the WS URL today; this generalizes that override to every endpoint.
