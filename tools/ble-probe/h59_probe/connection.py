"""
Thin async BLE connection wrapper around `bleak`, scoped to what this
research tool needs: connect by address, write a command, collect whatever
response frame(s) come back within a timeout. Connecting "cold" by address
can be unreliable on some platforms, so — like OpenH59 found on macOS — we
always resolve the device via a scan first.
"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime

from bleak import BleakClient, BleakScanner

from . import protocol


def _log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", file=sys.stderr)


class H59Probe:
    def __init__(self, address: str):
        self.address = address
        self.client: BleakClient | None = None
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._raw_log: list[tuple[datetime, bytes]] = []

    async def __aenter__(self) -> "H59Probe":
        _log(f"Scanning for {self.address} (15s timeout)...")
        device = await BleakScanner.find_device_by_address(self.address, timeout=15)
        if device is None:
            raise RuntimeError(
                "Device not found. Is it worn / powered / in range? Is your "
                "phone's Bluetooth OFF (the band only talks to one master at a time)?"
            )
        self.client = BleakClient(device, timeout=20)
        await self.client.connect()
        await self.client.start_notify(protocol.CHARACTERISTIC_NOTIFY, self._on_notify)
        _log("Connected.")
        return self

    async def __aexit__(self, *exc) -> None:
        if self.client is not None:
            try:
                await self.client.disconnect()
            except Exception:
                pass

    def _on_notify(self, _handle, data: bytearray) -> None:
        b = bytes(data)
        self._raw_log.append((datetime.now(), b))
        self._queue.put_nowait(b)
        _log(f"<- {b.hex(' ')}")

    async def send(self, frame: bytes, label: str = "") -> None:
        assert self.client is not None
        _log(f"-> {frame.hex(' ')}{f'  ({label})' if label else ''}")
        await self.client.write_gatt_char(protocol.CHARACTERISTIC_WRITE, frame, response=False)

    async def send_and_collect(self, frame: bytes, label: str = "", wait_s: float = 3.0) -> list[bytes]:
        """Sends a frame and returns every notification received within wait_s."""
        while not self._queue.empty():
            self._queue.get_nowait()
        await self.send(frame, label)
        collected: list[bytes] = []
        deadline = asyncio.get_event_loop().time() + wait_s
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                break
            try:
                collected.append(await asyncio.wait_for(self._queue.get(), timeout=remaining))
            except asyncio.TimeoutError:
                break
        return collected

    def raw_log(self) -> list[tuple[datetime, bytes]]:
        return list(self._raw_log)
