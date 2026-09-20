# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""WebSocket client for the JiuwenSwarm gateway."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

import websockets

# The frames after which the gateway sends nothing more for a chat request.
_TERMINAL_EVENTS = frozenset({"chat.final", "chat.error", "chat.interrupt_result"})


class GatewayError(RuntimeError):
    """The gateway could not be reached or broke the protocol."""


async def chat(
    url: str,
    params: dict[str, Any],
    *,
    idle_timeout: float | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Send one `chat.send` and yield every frame until the run ends.

    One connection per run, like the JiuwenSwarm CLI. `res` frames are yielded
    too: a refusal arrives there, not as an event.
    """
    try:
        connection = await websockets.connect(url, max_size=None)
    except OSError as error:
        raise GatewayError(f"gateway unreachable at {url}: {error}") from error
    async with connection:
        ack = json.loads(await connection.recv())
        if ack.get("event") != "connection.ack":
            raise GatewayError(f"expected connection.ack, got {ack.get('type')}/{ack.get('event')}")
        request_id = f"chat-{uuid.uuid4().hex[:12]}"
        await connection.send(json.dumps({
            "type": "req", "id": request_id, "method": "chat.send",
            "is_stream": True, "params": params,
        }, ensure_ascii=False))
        while True:
            try:
                raw = await asyncio.wait_for(connection.recv(), idle_timeout)
            except websockets.ConnectionClosed as error:
                raise GatewayError("gateway closed the connection mid-run") from error
            frame = json.loads(raw)
            yield frame
            if frame.get("type") == "res" and frame.get("ok") is False:
                return
            if frame.get("type") == "event" and frame.get("event") in _TERMINAL_EVENTS:
                return
