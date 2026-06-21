#!/usr/bin/env python3
"""WebViz image demo source — feeds the Image viewer tab's panels.

Publishes a synthetic animated RGB8 image (a scrolling color gradient with a
moving bright bar) on one binary `wv/Image` channel. RGB8 needs no codec, so this
demo has no extra deps beyond the WebSocket SDK:

    pip install websockets
    python3 sdks/python/image_demo.py

Binary payload layout (must match packages/protocol/src/binary.ts):
    uint32  frame_id length (N)   |  utf8 frame_id (N)
    uint32  width
    uint32  height
    uint32  encoding              (0=JPEG, 1=PNG, 2=RGB8)
    bytes   data                  (width*height*3 for RGB8)
"""

from __future__ import annotations

import argparse
import math
import struct
import time

ENCODING_RGB8 = 2


def image_payload(frame_id: str, width: int, height: int, data: bytes) -> bytes:
    """Pack an RGB8 image into the wv/Image binary payload."""
    fid = frame_id.encode("utf-8")
    return (
        struct.pack("<I", len(fid))
        + fid
        + struct.pack("<III", width, height, ENCODING_RGB8)
        + data
    )


def make_frame(t: float, width: int, height: int) -> bytes:
    """A scrolling R/G gradient with a vertical bright bar sweeping across."""
    bar = int((math.sin(t * 1.5) * 0.5 + 0.5) * (width - 1))
    rows = bytearray(width * height * 3)
    shift = int(t * 40) % 256
    for y in range(height):
        g = (y * 255) // max(1, height - 1)
        base = y * width * 3
        for x in range(width):
            i = base + x * 3
            r = (x + shift) & 0xFF
            if abs(x - bar) < 3:
                rows[i] = 255
                rows[i + 1] = 255
                rows[i + 2] = 255
            else:
                rows[i] = r
                rows[i + 1] = g
                rows[i + 2] = 128
    return bytes(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="WebViz image demo source")
    parser.add_argument(
        "--url",
        default="ws://localhost:7777/?role=source&id=image_demo",
        help="hub WebSocket URL (source role)",
    )
    parser.add_argument("--rate", type=float, default=15.0, help="publish rate (Hz)")
    parser.add_argument("--width", type=int, default=320)
    parser.add_argument("--height", type=int, default=240)
    args = parser.parse_args()

    # Imported here so --help works without the websockets package installed.
    from webviz.client import Client

    client = Client(args.url)
    chan = client.advertise("camera_front", "wv/Image", encoding="binary")
    print(
        f"[image_demo] publishing camera_front "
        f"({args.width}x{args.height} RGB8) at {args.rate} Hz (Ctrl+C to stop)"
    )

    period = 1.0 / args.rate
    t0 = time.time()
    try:
        while True:
            t = time.time() - t0
            frame = make_frame(t, args.width, args.height)
            chan.send_binary(image_payload("camera_front", args.width, args.height, frame))
            time.sleep(period)
    except KeyboardInterrupt:
        print("\n[image_demo] stopped")
    finally:
        client.close()


if __name__ == "__main__":
    main()
