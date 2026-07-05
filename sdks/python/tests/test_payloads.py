"""Golden-bytes payload tests for every Python copy of the wire layouts.

Asserts against the checked-in fixtures in packages/protocol/fixtures (see its
README for the canonical inputs) — the same bytes the protocol vitest and the
C++ SDK test pin — so all four copies of the payload layouts stay in lockstep
without sharing a process:

- webviz/client.py           encode_binary_frame (20-byte header)
- demos/image_demo.py        image_payload
- demos/pointcloud_demo.py   pointcloud_payload
- sdks/ros2 converters.py    image_to_payload / pointcloud2_to_payload /
                             occupancygrid_to_payload (duck-typed ROS msgs —
                             the module imports no rclpy)

Stdlib only (unittest); importing the demos pulls in webviz.client, which
needs `websockets` (present in ./venv):

    venv/bin/python3 -m unittest discover -s sdks/python/tests -v
"""

from __future__ import annotations

import struct
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "sdks" / "python"))  # webviz package
sys.path.insert(0, str(REPO / "sdks" / "python" / "demos"))  # demo modules
sys.path.insert(0, str(REPO / "sdks" / "ros2"))  # webviz_ros2_adapter package

FIXTURES = REPO / "packages" / "protocol" / "fixtures"


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def payload_of(frame: bytes) -> bytes:
    """Strip the 20-byte standard header off a fixture frame."""
    return frame[20:]


class TestBinaryHeader(unittest.TestCase):
    def test_encode_binary_frame_matches_image_fixture(self) -> None:
        from webviz.client import encode_binary_frame

        want = fixture("image_frame.bin")
        got = encode_binary_frame(7, 1.5, payload_of(want))
        self.assertEqual(got, want)

    def test_encode_binary_frame_matches_pointcloud_fixture(self) -> None:
        from webviz.client import encode_binary_frame

        want = fixture("pointcloud_frame.bin")
        got = encode_binary_frame(9, 2.25, payload_of(want))
        self.assertEqual(got, want)


class TestDemoPayloads(unittest.TestCase):
    def test_image_demo_payload(self) -> None:
        from image_demo import image_payload

        want = payload_of(fixture("image_frame.bin"))
        got = image_payload("cam", 2, 1, bytes([10, 20, 30, 40, 50, 60]))
        self.assertEqual(got, want)

    def test_pointcloud_demo_payload(self) -> None:
        from pointcloud_demo import pointcloud_payload

        want = payload_of(fixture("pointcloud_frame.bin"))
        got = pointcloud_payload(
            "odom", [(1.0, 2.0, 3.0, 0.5), (-1.0, -2.0, -3.0, 1.0)]
        )
        self.assertEqual(got, want)


class TestRosConverters(unittest.TestCase):
    """converters.py touches only message attributes, so duck-typed
    SimpleNamespace stand-ins are enough — no rclpy/message packages."""

    def test_image_to_payload(self) -> None:
        from webviz_ros2_adapter import converters

        msg = SimpleNamespace(
            encoding="rgb8",
            width=2,
            height=1,
            data=bytes([10, 20, 30, 40, 50, 60]),
            header=SimpleNamespace(frame_id="cam"),
        )
        self.assertEqual(
            converters.image_to_payload(msg), payload_of(fixture("image_frame.bin"))
        )

    def test_pointcloud2_to_payload(self) -> None:
        from webviz_ros2_adapter import converters

        # Two xyz+intensity points, float32 fields at offsets 0/4/8/12.
        fields = [
            SimpleNamespace(name=n, offset=o, datatype=7, count=1)  # 7 = FLOAT32
            for n, o in (("x", 0), ("y", 4), ("z", 8), ("intensity", 12))
        ]
        pts = [(1.0, 2.0, 3.0, 0.5), (-1.0, -2.0, -3.0, 1.0)]
        data = b"".join(struct.pack("<4f", *p) for p in pts)
        msg = SimpleNamespace(
            fields=fields,
            width=2,
            height=1,
            point_step=16,
            row_step=32,
            is_bigendian=False,
            data=data,
            header=SimpleNamespace(frame_id="odom"),
        )
        self.assertEqual(
            converters.pointcloud2_to_payload(msg),
            payload_of(fixture("pointcloud_frame.bin")),
        )

    def test_occupancygrid_to_payload(self) -> None:
        from webviz_ros2_adapter import converters

        # ROS int8 cells: -1 = unknown → wv 255; canonical cells are
        # [0, 100, 255, 50, 0, 255] on the wire.
        msg = SimpleNamespace(
            data=[0, 100, -1, 50, 0, -1],
            info=SimpleNamespace(
                resolution=0.05,
                width=3,
                height=2,
                origin=SimpleNamespace(
                    position=SimpleNamespace(x=1.0, y=2.0, z=0.0),
                    orientation=SimpleNamespace(x=0.0, y=0.0, z=0.0, w=1.0),
                ),
            ),
            header=SimpleNamespace(frame_id="map"),
        )
        self.assertEqual(
            converters.occupancygrid_to_payload(msg),
            payload_of(fixture("occupancygrid_frame.bin")),
        )


if __name__ == "__main__":
    unittest.main()
