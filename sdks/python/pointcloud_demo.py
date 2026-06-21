#!/usr/bin/env python3
"""WebViz point-cloud demo source — feeds the 3D tab's PointCloud plugin.

Publishes a synthetic animated cloud (a traveling radial wave, intensity-colored)
on one binary `wv/PointCloud` channel, anchored to the `odom` frame so it shows
at the origin with the default fixed frame.

Unlike the HTTP demos (`demo_source.py`, `robot_demo.py`), binary frames need the
WebSocket SDK, which needs the `websockets` package:

    pip install websockets
    python3 sdks/python/pointcloud_demo.py

Binary payload layout (must match packages/protocol/src/binary.ts):
    uint32  frame_id length (N)   |  utf8 frame_id (N)
    uint32  point_count           |  uint8 field_flags
    float32 × point_count × stride  (here: x, y, z, intensity — little-endian)
"""

from __future__ import annotations

import argparse
import math
import struct
import time

PC_FLAG_INTENSITY = 0b001


def pointcloud_payload(
    frame_id: str, points: list[tuple[float, float, float, float]]
) -> bytes:
    """Pack an xyz+intensity cloud into the wv/PointCloud binary payload."""
    fid = frame_id.encode("utf-8")
    header = (
        struct.pack("<I", len(fid))
        + fid
        + struct.pack("<IB", len(points), PC_FLAG_INTENSITY)
    )
    flat: list[float] = [v for p in points for v in p]
    return header + struct.pack("<%df" % len(flat), *flat)


def make_cloud(t: float, n: int = 70) -> list[tuple[float, float, float, float]]:
    """An n×n grid on the XY plane lifted by a traveling radial sine wave."""
    pts: list[tuple[float, float, float, float]] = []
    span = 6.0
    for i in range(n):
        x = -span / 2 + span * i / (n - 1)
        for j in range(n):
            y = -span / 2 + span * j / (n - 1)
            r = math.hypot(x, y)
            z = 0.6 * math.sin(2.0 * r - t * 2.0)
            intensity = (z + 0.6) / 1.2  # normalize to ~[0, 1]
            pts.append((x, y, z + 0.6, intensity))
    return pts


def main() -> None:
    parser = argparse.ArgumentParser(description="WebViz point-cloud demo source")
    parser.add_argument(
        "--url",
        default="ws://localhost:7777/?role=source&id=pointcloud_demo",
        help="hub WebSocket URL (source role)",
    )
    parser.add_argument("--rate", type=float, default=10.0, help="publish rate (Hz)")
    args = parser.parse_args()

    # Imported here so --help works without the websockets package installed.
    from webviz.client import Client

    client = Client(args.url)
    chan = client.advertise("lidar_points", "wv/PointCloud", encoding="binary")
    print(f"[pointcloud_demo] publishing lidar_points at {args.rate} Hz (Ctrl+C to stop)")

    period = 1.0 / args.rate
    t0 = time.time()
    try:
        while True:
            t = time.time() - t0
            chan.send_binary(pointcloud_payload("odom", make_cloud(t)))
            time.sleep(period)
    except KeyboardInterrupt:
        print("\n[pointcloud_demo] stopped")
    finally:
        client.close()


if __name__ == "__main__":
    main()
