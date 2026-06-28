"""Mapping from ROS 2 message type → WebViz channel schema + converter (§6.2).

Keeping this table separate from the node keeps the node generic: it discovers
topics, looks the type up here, lazily imports the message class, and wires a
subscription whose callback runs the converter and pushes to a wv channel.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from . import converters as C


@dataclass(frozen=True)
class TypeEntry:
    """How to bridge one ROS message type to a wv channel."""

    module: str  # python module holding the message class, e.g. "sensor_msgs.msg"
    cls: str  # message class name, e.g. "JointState"
    schema: str  # wv/* schema name to advertise
    encoding: str  # "json" or "binary"
    convert: Callable[[Any], Any]  # msg -> dict|list|bytes (or None to skip a frame)
    multi: bool = False  # True if convert() returns a list, each sent as its own frame

    def import_class(self) -> type:
        mod = __import__(self.module, fromlist=[self.cls])
        return getattr(mod, self.cls)


# ROS type string (as reported by get_topic_names_and_types) → bridge entry.
REGISTRY: dict[str, TypeEntry] = {
    "tf2_msgs/msg/TFMessage": TypeEntry(
        "tf2_msgs.msg", "TFMessage", "wv/TransformArray", "json", C.tf_to_wv
    ),
    "sensor_msgs/msg/JointState": TypeEntry(
        "sensor_msgs.msg", "JointState", "wv/JointState", "json", C.jointstate_to_wv
    ),
    "sensor_msgs/msg/LaserScan": TypeEntry(
        "sensor_msgs.msg", "LaserScan", "wv/LaserScan", "json", C.laserscan_to_wv
    ),
    "nav_msgs/msg/OccupancyGrid": TypeEntry(
        "nav_msgs.msg", "OccupancyGrid", "wv/OccupancyGrid", "json",
        C.occupancygrid_to_wv,
    ),
    "nav_msgs/msg/Path": TypeEntry(
        "nav_msgs.msg", "Path", "wv/Path", "json", C.path_to_wv
    ),
    "geometry_msgs/msg/PoseStamped": TypeEntry(
        "geometry_msgs.msg", "PoseStamped", "wv/Pose", "json", C.posestamped_to_wv
    ),
    "geometry_msgs/msg/PoseWithCovarianceStamped": TypeEntry(
        "geometry_msgs.msg", "PoseWithCovarianceStamped", "wv/Pose", "json",
        C.posecov_to_wv,
    ),
    "visualization_msgs/msg/Marker": TypeEntry(
        "visualization_msgs.msg", "Marker", "wv/Marker", "json", C.marker_to_wv
    ),
    "visualization_msgs/msg/MarkerArray": TypeEntry(
        "visualization_msgs.msg", "MarkerArray", "wv/Marker", "json",
        C.markerarray_to_wv, multi=True,
    ),
    "rcl_interfaces/msg/Log": TypeEntry(
        "rcl_interfaces.msg", "Log", "wv/Log", "json", C.rosout_to_wv
    ),
    "sensor_msgs/msg/Image": TypeEntry(
        "sensor_msgs.msg", "Image", "wv/Image", "binary", C.image_to_payload
    ),
    "sensor_msgs/msg/CompressedImage": TypeEntry(
        "sensor_msgs.msg", "CompressedImage", "wv/Image", "binary",
        C.compressedimage_to_payload,
    ),
    "sensor_msgs/msg/PointCloud2": TypeEntry(
        "sensor_msgs.msg", "PointCloud2", "wv/PointCloud", "binary",
        C.pointcloud2_to_payload,
    ),
}


# --- reverse bridge (§6.2): wv interactive channel → ROS 2 topic ---------------
#
# The forward table keys on ROS *type* because a robot can expose anything. The
# reverse direction is the opposite: it only ever carries the small, fixed set of
# messages WebViz *itself* can emit (interactive displays), so we key on the wv
# channel *name* the producer publishes. Today that's the CoordinateFrame gizmo's
# wv/Pose (default channel `tcp_target`). Add a row per future interactive
# producer — no discovery or per-deployment config needed.


@dataclass(frozen=True)
class ReverseEntry:
    """How to bridge one interactive wv channel back to a ROS topic."""

    schema: str  # wv/* schema the channel carries (sanity / documentation)
    module: str  # ROS message module, e.g. "geometry_msgs.msg"
    cls: str  # ROS message class, e.g. "PoseStamped"
    topic: str  # ROS topic to publish on
    fill: Callable[[Any, Any], None]  # (wv data dict, ros msg) -> None (mutates msg)
    stamped: bool = True  # set msg.header.stamp from the node clock before publish

    def import_class(self) -> type:
        mod = __import__(self.module, fromlist=[self.cls])
        return getattr(mod, self.cls)


# wv channel name → reverse bridge entry.
REVERSE_REGISTRY: dict[str, ReverseEntry] = {
    "tcp_target": ReverseEntry(
        "wv/Pose", "geometry_msgs.msg", "PoseStamped", "/tcp_target",
        C.fill_posestamped_from_wv,
    ),
}
