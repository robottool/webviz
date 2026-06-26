# WebViz ROS 2 Adapter (§6.2)

A **drop-in** ROS 2 node that mirrors your existing topics to a WebViz hub — no
changes to your robot code. Run it alongside your stack and it auto-discovers every
topic whose type WebViz understands, advertises one `wv/*` channel per topic, and
republishes each message converted to the WebViz wire protocol.

Channel name = topic name without the leading slash (`/joint_states` →
`joint_states`), so the browser sees source-agnostic channel names just like the
Python SDK demos.

## Supported topic types

| ROS 2 type | wv channel | encoding |
|---|---|---|
| `tf2_msgs/TFMessage` (`/tf`, `/tf_static`) | `wv/TransformArray` | json |
| `sensor_msgs/JointState` | `wv/JointState` | json |
| `sensor_msgs/LaserScan` | `wv/LaserScan` | json |
| `sensor_msgs/Image` | `wv/Image` | binary (rgb8/bgr8/rgba8/bgra8/mono8) |
| `sensor_msgs/CompressedImage` | `wv/Image` | binary (jpeg/png) |
| `sensor_msgs/PointCloud2` | `wv/PointCloud` | binary (xyz + intensity/rgb) |
| `nav_msgs/OccupancyGrid` | `wv/OccupancyGrid` | json |
| `nav_msgs/Path` | `wv/Path` | json |
| `geometry_msgs/PoseStamped` | `wv/Pose` | json |
| `geometry_msgs/PoseWithCovarianceStamped` | `wv/Pose` | json |
| `visualization_msgs/Marker` · `MarkerArray` | `wv/Marker` | json |
| `rcl_interfaces/Log` (`/rosout`) | `wv/Log` | json |

The mapping table lives in `webviz_ros2_adapter/registry.py`; the pure conversion
functions (and the binary payload layouts mirroring `packages/protocol`) live in
`webviz_ros2_adapter/converters.py`. To add a type, add a `TypeEntry` + converter.

## Prerequisites

- A sourced ROS 2 environment (Humble or newer).
- The WebViz Python SDK transport: `pip install 'websockets>=11'`. The adapter
  imports `webviz.Client` from `sdks/python`, which it adds to `sys.path`
  automatically when run from the repo.
- A running WebViz hub (`pnpm hub`, or `./dev.sh` from the repo root).

## Run it (straight from the repo)

```bash
source /opt/ros/<distro>/setup.bash
pip install 'websockets>=11'
python3 sdks/ros2/webviz_ros2_adapter/adapter.py --url ws://localhost:7777
```

Then open the app (`pnpm app`) — the bridged channels appear under their topic
names in the Inspector, 3D, Image, Map, Plot, and Log tabs.

Filter which topics are bridged (regexes against the full topic name):

```bash
# only the navigation + sensor topics, but never camera images
python3 .../adapter.py --include '^/(tf|scan|map|plan|joint_states)' --exclude image_raw
```

## Build as a ROS 2 package (colcon)

The directory is a normal `ament_python` package, so you can drop it into a
workspace:

```bash
mkdir -p ~/ws/src && cp -r sdks/ros2 ~/ws/src/webviz_ros2_adapter
cd ~/ws && colcon build && source install/setup.bash
ros2 run webviz_ros2_adapter adapter --url ws://localhost:7777
```

## Notes

- **QoS**: sensor streams (LaserScan, Image, PointCloud2) subscribe with
  best-effort `qos_profile_sensor_data`; `/tf_static` uses transient-local so a
  late-joining adapter still gets the latched transform; everything else uses a
  reliable depth-10 default.
- **Discovery is periodic** (`--discover-period`, default 2 s), so sources that
  start after the adapter are picked up automatically.
- **PointCloud2** conversion is a pure-Python deinterleave — fine for typical
  scan/RGBD clouds; for very dense clouds at high rate a NumPy fast path is the
  obvious next optimization.
