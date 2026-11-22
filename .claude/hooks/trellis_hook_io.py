"""Process-boundary I/O shared by the installed Python hooks."""

from __future__ import annotations

import json
import os
import queue
import sys
import threading


def load_hook_input() -> dict:
    """Read one UTF-8 JSON object, framed by EOF or an idle pipe."""
    chunks: queue.Queue[bytes | None] = queue.Queue()

    def read_pipe() -> None:
        try:
            # A blocked daemon must not hold sys.stdin's buffered-reader lock
            # during interpreter shutdown. os.read also supports Windows pipes.
            while True:
                chunk = os.read(sys.stdin.fileno(), 65536)
                chunks.put(chunk)
                if not chunk:
                    return
        except (OSError, ValueError):
            chunks.put(None)

    threading.Thread(target=read_pipe, daemon=True).start()
    raw = bytearray()
    while True:
        try:
            chunk = chunks.get(timeout=0.2)
        except queue.Empty:
            break
        if chunk is None:
            return {}
        if not chunk:
            break
        raw.extend(chunk)
    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}
