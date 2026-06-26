#!/usr/bin/env python3
"""WebViz ROS 2 adapter (§6.2) — a drop-in node that mirrors ROS topics to a hub.

Zero changes to your existing robot code: run this node alongside it and it
auto-discovers every topic whose type WebViz understands (see `registry.py`),
advertises one wv channel per topic, and republishes each message converted to the
`wv/*` wire protocol. Channel name = topic name minus the leading slash (e.g.
`/joint_states` → `joint_states`).

Run as a plain script (needs a sourced ROS 2 env + `pip install websockets`):

    python3 sdks/ros2/webviz_ros2_adapter/adapter.py --url ws://localhost:7777

…or, once built with colcon, as a ROS 2 node:

    ros2 run webviz_ros2_adapter adapter --ros-args -p hub_url:=ws://hub:7777

Filter which topics are bridged with --include / --exclude (regexes, matched against
the full topic name). New topics are picked up on a poll (`--discover-period`).
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time

# Make the sibling Python SDK importable when run straight from the repo (before a
# colcon/pip install). `webviz.Client` lives in sdks/python.
_REPO_PY = os.path.join(os.path.dirname(__file__), "..", "..", "python")
if os.path.isdir(_REPO_PY):
    sys.path.insert(0, os.path.abspath(_REPO_PY))

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, qos_profile_sensor_data, DurabilityPolicy

from .registry import REGISTRY, TypeEntry

# Sensor streams that should use best-effort sensor QoS rather than the default.
_SENSOR_TYPES = {
    "sensor_msgs/msg/LaserScan",
    "sensor_msgs/msg/Image",
    "sensor_msgs/msg/CompressedImage",
    "sensor_msgs/msg/PointCloud2",
}


def channel_name(topic: str) -> str:
    """`/joint_states` → `joint_states` (drop only the leading slash)."""
    return topic[1:] if topic.startswith("/") else topic


class WebVizAdapter(Node):
    def __init__(
        self,
        hub_url: str,
        include: re.Pattern | None,
        exclude: re.Pattern | None,
        discover_period: float,
    ):
        super().__init__("webviz_adapter")
        from webviz.client import Client  # deferred so --help works without it

        self._client = Client(hub_url)
        self._include = include
        self._exclude = exclude
        self._bridged: dict[str, object] = {}  # topic -> wv Channel
        self.get_logger().info(f"connected to WebViz hub at {hub_url}")

        # Poll for topics so sources that come up after us are picked up too.
        self._discover()
        self.create_timer(discover_period, self._discover)

    def _qos(self, topic: str, ros_type: str) -> QoSProfile:
        if topic.endswith("/tf_static"):
            # Latched: a late subscriber must still get the one static transform.
            q = QoSProfile(depth=1)
            q.durability = DurabilityPolicy.TRANSIENT_LOCAL
            return q
        if ros_type in _SENSOR_TYPES:
            return qos_profile_sensor_data
        return QoSProfile(depth=10)

    def _discover(self) -> None:
        for topic, types in self.get_topic_names_and_types():
            if topic in self._bridged:
                continue
            if self._include and not self._include.search(topic):
                continue
            if self._exclude and self._exclude.search(topic):
                continue
            entry = next((REGISTRY[t] for t in types if t in REGISTRY), None)
            if entry is None:
                continue
            self._bridge(topic, types[0], entry)

    def _bridge(self, topic: str, ros_type: str, entry: TypeEntry) -> None:
        try:
            msg_cls = entry.import_class()
        except (ImportError, AttributeError) as exc:
            self.get_logger().warn(f"skip {topic}: cannot import {ros_type}: {exc}")
            return
        chan = self._client.advertise(channel_name(topic), entry.schema, entry.encoding)
        self._bridged[topic] = chan
        self.create_subscription(
            msg_cls,
            topic,
            lambda msg, e=entry, c=chan: self._forward(e, c, msg),
            self._qos(topic, ros_type),
        )
        self.get_logger().info(
            f"bridging {topic} ({ros_type}) → {channel_name(topic)} [{entry.schema}]"
        )

    def _forward(self, entry: TypeEntry, chan, msg) -> None:
        try:
            payload = entry.convert(msg)
        except Exception as exc:  # one bad message must not kill the subscription
            self.get_logger().warn(f"convert failed for {entry.schema}: {exc}")
            return
        if payload is None:
            return
        items = payload if entry.multi else [payload]
        for item in items:
            if entry.encoding == "binary":
                chan.send_binary(item)
            else:
                chan.send(item)

    def destroy_node(self) -> bool:
        try:
            self._client.close()
        finally:
            return super().destroy_node()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="WebViz ROS 2 adapter")
    parser.add_argument(
        "--url", "--hub-url", dest="url", default="ws://localhost:7777",
        help="WebViz hub WebSocket URL (role=source is appended automatically)",
    )
    parser.add_argument("--id", default="ros2", help="source id reported to the hub")
    parser.add_argument("--include", help="only bridge topics matching this regex")
    parser.add_argument("--exclude", help="skip topics matching this regex")
    parser.add_argument(
        "--discover-period", type=float, default=2.0,
        help="seconds between topic-discovery sweeps",
    )
    # rclpy consumes --ros-args…; argparse only sees the rest.
    args, ros_args = parser.parse_known_args(argv)

    sep = "&" if "?" in args.url else "?"
    hub_url = f"{args.url}{sep}role=source&id={args.id}"
    include = re.compile(args.include) if args.include else None
    exclude = re.compile(args.exclude) if args.exclude else None

    rclpy.init(args=ros_args)
    node = WebVizAdapter(hub_url, include, exclude, args.discover_period)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
