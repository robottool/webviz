# WebViz C++ SDK (§6.3)

A **header-only**, dependency-free C++ data-source client for the WebViz hub.
Mirrors the [Python SDK](../python) and the wire protocol in
`packages/protocol`. POSIX only (Linux/macOS); `ws://` only.

To *use* it, just put `include/` on your include path and
`#include "webviz/client.hpp"` — there is nothing to build. It speaks just
enough of RFC 6455 over a raw TCP socket to advertise channels and push frames,
so you need no Boost/OpenSSL/WebSocket library.

```cpp
#include "webviz/client.hpp"

webviz::Client client("ws://localhost:7777?role=source&id=robot");

// JSON telemetry (arrays use webviz::arr to disambiguate from objects)
auto tf = client.advertise("transforms", "wv/Transform");
tf.send({{"frame_id", "base_link"}, {"parent_frame_id", "odom"},
         {"translation", webviz::arr({x, y, 0.0})},
         {"rotation",    webviz::arr({qx, qy, qz, qw})}});

// Zero-copy binary: the raw buffer is never copied into a frame buffer
auto cam = client.advertise("camera_front", "wv/Image", webviz::Encoding::Binary);
cam.send_image("camera", w, h, webviz::ImageFormat::JPEG, jpeg.data(), jpeg.size());

auto cloud = client.advertise("lidar", "wv/PointCloud", webviz::Encoding::Binary);
cloud.send_pointcloud("odom", n_points, webviz::PC_FLAG_INTENSITY, floats);
```

## Zero-copy binary framing

`send_binary` / `send_image` / `send_pointcloud` build the small frame headers
on the stack and emit the large payload with a single scatter-gather
`writev()` — the camera/point-cloud buffer is never copied. To make that
possible the client sends every WebSocket frame with an **all-zero mask key**:
RFC 6455 requires the `MASK` bit on client frames, but a zero key is
unmask-identity, so the payload doesn't have to be XOR-copied. A WebViz hub is a
trusted LAN/edge broker, so this is safe; don't route this client through an
untrusted proxy.

## API

| Call | Sends |
|---|---|
| `client.advertise(name, schema, enc=Json)` | an `advertise` op; returns a `Channel` |
| `client.unadvertise(name)` | an `unadvertise` op |
| `chan.send(value, ts=-1)` | a JSON `message` frame (text) |
| `chan.send_binary(ptr, len, ts=-1)` | a 20-byte-header binary frame |
| `chan.send_image(frame_id, w, h, fmt, ptr, len, ts=-1)` | a `wv/Image` frame |
| `chan.send_pointcloud(frame_id, n, flags, floats, ts=-1)` | a `wv/PointCloud` frame |

`ts < 0` (the default) stamps with the current wall clock. `webviz::Value`
converts implicitly from numbers/strings/bools/`nullptr`; objects are
`{{"key", value}, ...}` and arrays are `webviz::arr({...})`.

A background thread drains inbound frames (answering pings, honoring close);
pass `Client(url, /*background_reader=*/false)` to disable it.

## Build the examples + test

```bash
cmake -S . -B build && cmake --build build
ctest --test-dir build --output-on-failure   # byte-layout test (no network)
./build/transform_demo                         # needs a running hub (./dev.sh or pnpm hub)
./build/pointcloud_demo
```

`test/test_payloads.cpp` asserts the encoded bytes match `binary.ts` exactly —
run it after any protocol change.

## Supported schemas

JSON: any schema — you supply the `data` object (`wv/Transform`, `wv/Marker`,
`wv/Log`, `wv/Pose`, …). Binary helpers: `wv/Image` (JPEG/PNG/RGB8) and
`wv/PointCloud` (xyz + intensity/rgb/normal via `PC_FLAG_*`). For other binary
schemas, build the payload yourself and call `send_binary`.
