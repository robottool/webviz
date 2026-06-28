"""ROS 2 → WebViz `wv/*` message converters (§6.2).

Pure functions that take a ROS 2 message instance and return either a JSON-able
`dict`/`list` (for JSON channels) or `bytes` (the payload after the 20-byte binary
header, for binary channels). They touch only message *attributes*, so this module
imports no `rclpy` / message packages itself — it can be imported and unit-tested
without a ROS environment (feed it duck-typed stand-ins).

Binary payload layouts mirror `packages/protocol/src/binary.ts` (and the duplicates
in `sdks/python/{pointcloud,image}_demo.py`). Keep all three in sync if the frame
layout changes.
"""

from __future__ import annotations

import base64
import struct
from typing import Any

# wv/PointCloud field_flags (see binary.ts).
PC_FLAG_INTENSITY = 0b001
PC_FLAG_RGB = 0b010

# wv/Image encoding enum (see binary.ts ImageEncoding).
IMG_JPEG = 0
IMG_PNG = 1
IMG_RGB8 = 2

# ROS sensor_msgs/PointField datatype → (struct format, byte size).
_PF_FMT = {
    1: ("b", 1),  # INT8
    2: ("B", 1),  # UINT8
    3: ("h", 2),  # INT16
    4: ("H", 2),  # UINT16
    5: ("i", 4),  # INT32
    6: ("I", 4),  # UINT32
    7: ("f", 4),  # FLOAT32
    8: ("d", 8),  # FLOAT64
}

# ROS visualization_msgs/Marker.type → wv/Marker type string.
_MARKER_TYPE = {
    0: "arrow",
    1: "cube",
    2: "sphere",
    3: "cylinder",
    4: "line_strip",
    5: "line_list",
    6: "cube",  # CUBE_LIST → first-cut: render as cube
    7: "sphere",  # SPHERE_LIST
    8: "points",
    9: "text",
    10: "mesh",
    11: "triangle_list",
}

# ROS visualization_msgs/Marker.action → wv action string.
_MARKER_ACTION = {0: "add", 1: "modify", 2: "delete", 3: "delete_all"}

# ROS rcl_interfaces/Log.level (byte) → wv/Log level. ROS: DEBUG=10, INFO=20,
# WARN=30, ERROR=40, FATAL=50.
def _log_level(level: int) -> str:
    if level >= 40:
        return "ERROR"
    if level >= 30:
        return "WARN"
    if level >= 20:
        return "INFO"
    return "DEBUG"


def _quat(q: Any) -> list[float]:
    """geometry_msgs/Quaternion → [x, y, z, w], defaulting a zero quat to identity."""
    x, y, z, w = q.x, q.y, q.z, q.w
    if x == 0.0 and y == 0.0 and z == 0.0 and w == 0.0:
        return [0.0, 0.0, 0.0, 1.0]
    return [x, y, z, w]


def _vec3(v: Any) -> list[float]:
    return [v.x, v.y, v.z]


def _pose(p: Any) -> dict[str, Any]:
    return {"position": _vec3(p.position), "orientation": _quat(p.orientation)}


def _stamp_secs(header: Any) -> float | None:
    """builtin_interfaces/Time on a Header → float seconds (None if unset)."""
    s = header.stamp
    t = s.sec + s.nanosec * 1e-9
    return t if t > 0 else None


# --- JSON converters -------------------------------------------------------

def tf_to_wv(msg: Any) -> list[dict[str, Any]]:
    """tf2_msgs/TFMessage → wv/TransformArray.

    A ROS TransformStamped names the *child* in `child_frame_id` and the parent in
    `header.frame_id`; wv/Transform calls them `frame_id` / `parent_frame_id`.
    """
    out: list[dict[str, Any]] = []
    for t in msg.transforms:
        out.append(
            {
                "frame_id": t.child_frame_id,
                "parent_frame_id": t.header.frame_id,
                "translation": [
                    t.transform.translation.x,
                    t.transform.translation.y,
                    t.transform.translation.z,
                ],
                "rotation": _quat(t.transform.rotation),
            }
        )
    return out


def jointstate_to_wv(msg: Any) -> dict[str, Any]:
    """sensor_msgs/JointState → wv/JointState."""
    return {
        "names": list(msg.name),
        "positions": list(msg.position),
        "velocities": list(msg.velocity),
        "efforts": list(msg.effort),
    }


def laserscan_to_wv(msg: Any) -> dict[str, Any]:
    """sensor_msgs/LaserScan → wv/LaserScan (NaN/Inf ranges pass through as "Inf")."""
    def clean(r: float) -> Any:
        return r if (r == r and r not in (float("inf"), float("-inf"))) else "Inf"

    return {
        "frame_id": msg.header.frame_id,
        "angle_min": msg.angle_min,
        "angle_max": msg.angle_max,
        "angle_increment": msg.angle_increment,
        "range_min": msg.range_min,
        "range_max": msg.range_max,
        "ranges": [clean(r) for r in msg.ranges],
        "intensities": list(msg.intensities),
    }


def occupancygrid_to_wv(msg: Any) -> dict[str, Any]:
    """nav_msgs/OccupancyGrid → wv/OccupancyGrid.

    ROS cells are int8: -1 unknown, 0..100 occupancy. wv wants uint8 with 255 for
    unknown (0=free, 100=occupied), so remap -1 → 255 and clamp the rest.
    """
    cells = bytes(255 if v < 0 else min(v, 100) for v in msg.data)
    info = msg.info
    return {
        "frame_id": msg.header.frame_id,
        "resolution": info.resolution,
        "width": info.width,
        "height": info.height,
        "origin": _pose(info.origin),
        "data": base64.b64encode(cells).decode("ascii"),
    }


def path_to_wv(msg: Any) -> dict[str, Any]:
    """nav_msgs/Path → wv/Path."""
    return {
        "id": "path",
        "frame_id": msg.header.frame_id,
        "color": [0.2, 0.8, 1.0, 1.0],
        "poses": [_pose(ps.pose) for ps in msg.poses],
    }


def posestamped_to_wv(msg: Any) -> dict[str, Any]:
    """geometry_msgs/PoseStamped → wv/Pose."""
    return {
        "id": "pose",
        "frame_id": msg.header.frame_id,
        "position": _vec3(msg.pose.position),
        "orientation": _quat(msg.pose.orientation),
    }


def posecov_to_wv(msg: Any) -> dict[str, Any]:
    """geometry_msgs/PoseWithCovarianceStamped → wv/Pose (with covariance)."""
    out = {
        "id": "pose",
        "frame_id": msg.header.frame_id,
        "position": _vec3(msg.pose.pose.position),
        "orientation": _quat(msg.pose.pose.orientation),
    }
    cov = list(msg.pose.covariance)
    if any(cov):
        out["covariance"] = cov
    return out


# --- reverse: wv/* JSON → ROS 2 message (§6.2 reverse bridge) ---
# Mirror image of the forward converters: these *fill* a pre-constructed ROS
# message (passed in by the node, which owns the message classes) so this module
# still imports no message packages and stays node-testable with duck-typed
# stand-ins. The node sets msg.header.stamp (clock access lives in the node).


def fill_posestamped_from_wv(data: dict[str, Any], msg: Any) -> None:
    """wv/Pose → geometry_msgs/PoseStamped (inverse of `posestamped_to_wv`).

    wv/Pose payload: {frame_id, position:[x,y,z], orientation:[x,y,z,w]}.
    """
    msg.header.frame_id = data.get("frame_id", "")
    px, py, pz = data.get("position", [0.0, 0.0, 0.0])
    ox, oy, oz, ow = data.get("orientation", [0.0, 0.0, 0.0, 1.0])
    msg.pose.position.x = float(px)
    msg.pose.position.y = float(py)
    msg.pose.position.z = float(pz)
    msg.pose.orientation.x = float(ox)
    msg.pose.orientation.y = float(oy)
    msg.pose.orientation.z = float(oz)
    msg.pose.orientation.w = float(ow)


def marker_to_wv(msg: Any) -> dict[str, Any]:
    """visualization_msgs/Marker → wv/Marker."""
    out: dict[str, Any] = {
        "id": str(msg.id),
        "namespace": msg.ns,
        "action": _MARKER_ACTION.get(msg.action, "add"),
        "type": _MARKER_TYPE.get(msg.type, "cube"),
        "frame_id": msg.header.frame_id,
        "pose": _pose(msg.pose),
        "scale": [msg.scale.x, msg.scale.y, msg.scale.z],
        "color": [msg.color.r, msg.color.g, msg.color.b, msg.color.a],
    }
    # lifetime: ROS Duration → seconds; 0 means forever (omit).
    lt = msg.lifetime.sec + msg.lifetime.nanosec * 1e-9
    if lt > 0:
        out["lifetime"] = lt
    if msg.points:
        out["points"] = [[p.x, p.y, p.z] for p in msg.points]
    if msg.colors:
        out["colors"] = [[c.r, c.g, c.b, c.a] for c in msg.colors]
    if msg.text:
        out["text"] = msg.text
    return out


def markerarray_to_wv(msg: Any) -> list[dict[str, Any]]:
    """visualization_msgs/MarkerArray → list of wv/Marker (sent one frame each)."""
    return [marker_to_wv(m) for m in msg.markers]


def rosout_to_wv(msg: Any) -> dict[str, Any]:
    """rcl_interfaces/Log (the /rosout stream) → wv/Log."""
    out = {
        "level": _log_level(msg.level),
        "name": msg.name,
        "message": msg.msg,
    }
    stamp = msg.stamp.sec + msg.stamp.nanosec * 1e-9
    if stamp > 0:
        out["stamp"] = stamp
    return out


# --- binary converters (return the payload after the 20-byte header) -------

def _swap_rgb(data: bytes, channels: int) -> bytearray:
    """In-place swap of B↔R for a BGR(A) buffer; returns the RGB(A) bytearray."""
    buf = bytearray(data)
    buf[0::channels], buf[2::channels] = buf[2::channels], buf[0::channels]
    return buf


def image_to_payload(msg: Any) -> bytes | None:
    """sensor_msgs/Image → wv/Image RGB8 payload (None for unsupported encodings)."""
    enc = msg.encoding.lower()
    w, h = msg.width, msg.height
    data = bytes(msg.data)
    if enc == "rgb8":
        rgb = data
    elif enc == "bgr8":
        rgb = bytes(_swap_rgb(data, 3))
    elif enc in ("rgba8", "bgra8"):
        if enc == "bgra8":
            data = bytes(_swap_rgb(data, 4))
        rgb = bytes(b for i in range(0, len(data), 4) for b in data[i : i + 3])
    elif enc == "mono8":
        rgb = bytes(b for v in data for b in (v, v, v))
    else:
        return None
    fid = msg.header.frame_id.encode("utf-8")
    return (
        struct.pack("<I", len(fid))
        + fid
        + struct.pack("<III", w, h, IMG_RGB8)
        + rgb
    )


def compressedimage_to_payload(msg: Any) -> bytes | None:
    """sensor_msgs/CompressedImage → wv/Image JPEG/PNG payload.

    Width/height are not in the CompressedImage message; the browser reads them
    from the codec stream (createImageBitmap), so we send 0×0.
    """
    fmt = msg.format.lower()
    if "jpeg" in fmt or "jpg" in fmt:
        enc = IMG_JPEG
    elif "png" in fmt:
        enc = IMG_PNG
    else:
        return None
    fid = msg.header.frame_id.encode("utf-8")
    return (
        struct.pack("<I", len(fid))
        + fid
        + struct.pack("<III", 0, 0, enc)
        + bytes(msg.data)
    )


def pointcloud2_to_payload(msg: Any) -> bytes | None:
    """sensor_msgs/PointCloud2 → wv/PointCloud binary payload (None if no xyz).

    Deinterleaves x/y/z (+ optional intensity, rgb) out of the packed ROS buffer
    into the wv interleaved float32 layout. xyz → intensity → rgb (matches the
    browser decoder's field order). RGB is unpacked from the packed-uint32 `rgb`
    field into three 0..1 floats.
    """
    fields = {f.name: f for f in msg.fields}
    if not ("x" in fields and "y" in fields and "z" in fields):
        return None
    has_int = "intensity" in fields
    rgb_name = "rgb" if "rgb" in fields else ("rgba" if "rgba" in fields else None)

    def reader(name: str):
        f = fields[name]
        fmt, _ = _PF_FMT.get(f.datatype, ("f", 4))
        s = struct.Struct("<" + fmt)
        off = f.offset
        return lambda base: s.unpack_from(msg.data, base + off)[0]

    rx, ry, rz = reader("x"), reader("y"), reader("z")
    ri = reader("intensity") if has_int else None
    # The rgb/rgba field is a float32 whose bits are 0x00RRGGBB / 0xAARRGGBB.
    rgb_struct = struct.Struct("<I")
    rgb_off = fields[rgb_name].offset if rgb_name else 0

    flags = 0
    if has_int:
        flags |= PC_FLAG_INTENSITY
    if rgb_name:
        flags |= PC_FLAG_RGB

    n = msg.width * msg.height
    step = msg.point_step
    out: list[float] = []
    for p in range(n):
        base = p * step
        out.append(rx(base))
        out.append(ry(base))
        out.append(rz(base))
        if ri is not None:
            out.append(ri(base))
        if rgb_name:
            packed = rgb_struct.unpack_from(msg.data, base + rgb_off)[0]
            out.append(((packed >> 16) & 0xFF) / 255.0)
            out.append(((packed >> 8) & 0xFF) / 255.0)
            out.append((packed & 0xFF) / 255.0)

    fid = msg.header.frame_id.encode("utf-8")
    return (
        struct.pack("<I", len(fid))
        + fid
        + struct.pack("<IB", n, flags)
        + struct.pack("<%df" % len(out), *out)
    )
