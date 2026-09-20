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

class GatewayError(RuntimeError):
    """The gateway could not be reached or broke the protocol."""


def _ends_run(frame: dict[str, Any]) -> bool:
    """True for the last frame the gateway sends for a run.

    `chat.final` is not it: a run that pauses for approval emits an empty
    `chat.final`, then carries on after the answer. The gateway closes every run
    with `chat.processing_status` `is_complete`, and a refused request or a
    `chat.error` (which is followed by that status too) needs no answer.
    """
    if frame.get("type") == "res":
        return frame.get("ok") is False
    payload = frame.get("payload") or {}
    event = frame.get("event")
    if event == "chat.processing_status":
        return bool(payload.get("is_complete")) and not payload.get("is_processing")
    return event == "chat.interrupt_result"


class ChatRun:
    """One chat run on one gateway connection.

    Iterate to receive frames. While the run waits for an approval the iterator
    simply blocks; `answer()` (from another task) resumes it on the same
    connection, as the JiuwenSwarm CLI does.
    """

    def __init__(self, url: str, params: dict[str, Any], *, idle_timeout: float | None = None) -> None:
        self._url = url
        self._params = params
        self._idle_timeout = idle_timeout
        self._connection: Any = None

    async def __aenter__(self) -> "ChatRun":
        try:
            self._connection = await websockets.connect(self._url, max_size=None)
        except OSError as error:
            raise GatewayError(f"gateway unreachable at {self._url}: {error}") from error
        ack = json.loads(await self._connection.recv())
        if ack.get("event") != "connection.ack":
            await self._connection.close()
            raise GatewayError(f"expected connection.ack, got {ack.get('type')}/{ack.get('event')}")
        await self._send("chat", "chat.send", self._params)
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        if self._connection is not None:
            await self._connection.close()

    async def _send(self, prefix: str, method: str, params: dict[str, Any]) -> None:
        await self._connection.send(json.dumps({
            "type": "req", "id": f"{prefix}-{uuid.uuid4().hex[:12]}", "method": method,
            "is_stream": True, "params": params,
        }, ensure_ascii=False))

    async def answer(self, request_id: str, source: str, answer: dict[str, Any]) -> None:
        """Resume a run paused on `chat.ask_user_question`."""
        await self._send("answer", "chat.send", {
            "session_id": self._params["session_id"], "query": "", "request_id": request_id,
            "answers": [answer], "source": source, "mode": self._params.get("mode"),
            "supports_user_interaction": True,
        })

    def __aiter__(self) -> AsyncIterator[dict[str, Any]]:
        return self._frames()

    async def _frames(self) -> AsyncIterator[dict[str, Any]]:
        while True:
            try:
                raw = await asyncio.wait_for(self._connection.recv(), self._idle_timeout)
            except websockets.ConnectionClosed as error:
                raise GatewayError("gateway closed the connection mid-run") from error
            frame = json.loads(raw)
            yield frame
            if _ends_run(frame):
                return


async def chat(url: str, params: dict[str, Any], *, idle_timeout: float | None = None) -> AsyncIterator[dict[str, Any]]:
    """Run a chat that needs no approval and yield its frames."""
    async with ChatRun(url, params, idle_timeout=idle_timeout) as run:
        async for frame in run:
            yield frame
