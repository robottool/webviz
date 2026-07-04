"""Minimal WebViz Python SDK (§6.1).

A thin WebSocket client that advertises channels and sends JSON / binary frames
following the WebViz wire protocol. Requires the `websockets` package:

    pip install websockets

For a dependency-free demo that needs no pip install, see `map_sim_demo.py`,
which publishes via the hub's HTTP `/api/inject` endpoint instead.
"""

from __future__ import annotations

import json
import struct
import threading
import time
from typing import Any

try:
    from websockets.sync.client import connect as _ws_connect
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "webviz.client requires the 'websockets' package: pip install websockets"
    ) from exc

BINARY_OP = 0x01
HEADER_SIZE = 20


def encode_binary_frame(channel_id: int, timestamp: float, payload: bytes) -> bytes:
    """Pack a standard binary frame (little-endian header + payload)."""
    header = struct.pack(
        "<B3xIdI", BINARY_OP, channel_id, timestamp, len(payload)
    )
    return header + payload


class Channel:
    def __init__(self, client: "Client", channel_id: int, encoding: str):
        self._client = client
        self.id = channel_id
        self.encoding = encoding

    def send(self, data: dict[str, Any], timestamp: float | None = None) -> None:
        ts = time.time() if timestamp is None else timestamp
        self._client._send_json(
            {"op": "message", "channel_id": self.id, "timestamp": ts, "data": data}
        )

    def send_binary(self, payload: bytes, timestamp: float | None = None) -> None:
        ts = time.time() if timestamp is None else timestamp
        self._client._send_binary(encode_binary_frame(self.id, ts, payload))


class Client:
    """Connects to a WebViz hub as a data source."""

    def __init__(self, url: str):
        self._url = url
        self._ws = _ws_connect(url)
        self._next_id = 1
        self._lock = threading.Lock()

    def advertise(
        self, name: str, schema: str, encoding: str = "json"
    ) -> Channel:
        with self._lock:
            channel_id = self._next_id
            self._next_id += 1
        self._send_json(
            {
                "op": "advertise",
                "channel": {
                    "id": channel_id,
                    "name": name,
                    "schema": schema,
                    "encoding": encoding,
                },
            }
        )
        return Channel(self, channel_id, encoding)

    def _send_json(self, msg: dict[str, Any]) -> None:
        with self._lock:
            self._ws.send(json.dumps(msg))

    def _send_binary(self, frame: bytes) -> None:
        with self._lock:
            self._ws.send(frame)

    def close(self) -> None:
        self._ws.close()


class Consumer:
    """Connects to a WebViz hub as a *client* (`role=client`) and routes incoming
    JSON `message` frames to per-channel-name callbacks.

    The receive-side counterpart of `Client`. Mirrors the app's HubClient: you
    subscribe by channel *name*, and the subscription is deferred until a channel
    of that name is advertised — via the initial `server_info` or a later
    `advertise`. Only JSON data frames are delivered; binary frames (wv/Image,
    wv/PointCloud) are ignored, since the reverse / consume path only needs the
    small interactive JSON schemas (e.g. the gizmo's wv/Pose).

    A background daemon thread drains the socket; callbacks run on that thread.
    """

    def __init__(self, url: str):
        self._ws = _ws_connect(url)
        self._lock = threading.Lock()
        self._by_id: dict[int, dict[str, Any]] = {}  # channel_id -> ChannelInfo
        self._name_to_id: dict[str, int] = {}
        self._wanted: dict[str, Any] = {}  # name -> callback(data, timestamp)
        self._subscribed: set[int] = set()
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def subscribe(self, name: str, callback: Any) -> None:
        """Route frames from channel `name` to `callback(data, timestamp)`.

        Safe to call before the channel exists; it subscribes once it appears.
        """
        with self._lock:
            self._wanted[name] = callback
            cid = self._name_to_id.get(name)
        if cid is not None:
            self._ensure_subscribed(cid)

    def _ensure_subscribed(self, cid: int) -> None:
        with self._lock:
            if cid in self._subscribed:
                return
            self._subscribed.add(cid)
        self._send_json({"op": "subscribe", "channels": [{"id": cid}]})

    def _register(self, info: dict[str, Any]) -> None:
        cid, name = info.get("id"), info.get("name")
        if cid is None or name is None:
            return
        with self._lock:
            self._by_id[cid] = info
            self._name_to_id[name] = cid
            wanted = name in self._wanted
        if wanted:
            self._ensure_subscribed(cid)

    def _unregister(self, name: str) -> None:
        with self._lock:
            cid = self._name_to_id.pop(name, None)
            if cid is not None:
                self._by_id.pop(cid, None)
                self._subscribed.discard(cid)

    def _send_json(self, msg: dict[str, Any]) -> None:
        with self._lock:
            self._ws.send(json.dumps(msg))

    def _loop(self) -> None:
        try:
            for raw in self._ws:  # ends when the socket closes
                if not self._running:
                    break
                try:
                    self._handle(raw)
                except Exception:  # one bad frame must not kill the reader
                    continue
        except Exception:
            pass

    def _handle(self, raw: Any) -> None:
        if isinstance(raw, (bytes, bytearray)):
            return  # binary data frame; consume path is JSON-only
        msg = json.loads(raw)
        op = msg.get("op")
        if op == "server_info":
            for ch in msg.get("channels", []):
                self._register(ch)
        elif op == "advertise":
            self._register(msg.get("channel", {}))
        elif op == "unadvertise":
            name = msg.get("channel_name")
            if name:
                self._unregister(name)
        elif op == "message":
            cid = msg.get("channel_id")
            with self._lock:
                info = self._by_id.get(cid)
                cb = self._wanted.get(info["name"]) if info else None
            if cb:
                cb(msg.get("data"), msg.get("timestamp"))

    def close(self) -> None:
        self._running = False
        self._ws.close()
