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

    def __init__(self, url: str, params: dict[str, Any], *, idle_timeout: float | None = None,
                 reconnects: int = 3, reconnect_delay: float = 0.5) -> None:
        self._url = url
        self._params = params
        self._idle_timeout = idle_timeout
        self._connection: Any = None
        self._reconnects = reconnects
        self._reconnect_delay = reconnect_delay
        #: How many times the connection was lost mid-run and taken up again (frames in between are gone).
        self.resumed = 0
        # Reconnects in a row that brought no frame; a frame from the run starts the count again.
        self._misses = 0

    async def _connect(self) -> None:
        try:
            self._connection = await websockets.connect(self._url, max_size=None)
        except OSError as error:
            raise GatewayError(f"gateway unreachable at {self._url}: {error}") from error
        ack = json.loads(await self._connection.recv())
        if ack.get("event") != "connection.ack":
            await self._connection.close()
            raise GatewayError(f"expected connection.ack, got {ack.get('type')}/{ack.get('event')}")

    async def __aenter__(self) -> "ChatRun":
        await self._connect()
        await self._send("chat", "chat.send", self._params)
        return self

    async def _reattach(self) -> bool:
        """Take the run up again on a new connection with `chat.resume`.

        Measured on JiuwenSwarm 0.2.6: a run keeps going when its client's connection drops; `chat.resume`
        from a new connection answers `chat.interrupt_result` "task resumed" and the run's frames flow to
        it again, but nothing sent in the gap is replayed. It answers "task completed" when there is no
        run to take up. Returns whether a live run was found.
        """
        while self._misses < self._reconnects:
            self._misses += 1
            await asyncio.sleep(self._reconnect_delay * self._misses)
            try:
                await self._connect()
            except (GatewayError, websockets.WebSocketException, OSError):
                continue
            await self._send("resume", "chat.resume", {
                "session_id": self._params["session_id"], "query": "", "mode": self._params.get("mode"),
                "supports_user_interaction": True,
            })
            self.resumed += 1
            return True
        return False

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

    async def cancel(self) -> None:
        """Ask the gateway to stop the run. It answers with a `res` and then ends
        the run with the usual completion status."""
        await self._connection.send(json.dumps({
            "type": "req", "id": f"interrupt-{uuid.uuid4().hex[:12]}", "method": "chat.interrupt",
            "is_stream": False,
            "params": {"session_id": self._params["session_id"], "intent": "cancel", "mode": self._params.get("mode")},
        }))

    def __aiter__(self) -> AsyncIterator[dict[str, Any]]:
        return self._frames()

    async def _frames(self) -> AsyncIterator[dict[str, Any]]:
        while True:
            try:
                raw = await asyncio.wait_for(self._connection.recv(), self._idle_timeout)
            except websockets.ConnectionClosed as error:
                if not await self._reattach():
                    raise GatewayError("gateway closed the connection mid-run") from error
                continue
            frame = json.loads(raw)
            if self.resumed:
                if _no_run_to_resume(frame):
                    # The run ended while we were away: what it said in the gap is gone.
                    raise GatewayError("the run ended while the connection to the gateway was down")
                if _resume_answer(frame):
                    continue
            self._misses = 0
            yield frame
            if _ends_run(frame):
                return


def _notice(frame: dict[str, Any]) -> str:
    """The text of a `chat.interrupt_result` frame ("" for any other frame)."""
    if frame.get("event") != "chat.interrupt_result":
        return ""
    payload = frame.get("payload") or {}
    return str(payload.get("message") or payload.get("content") or "")


def _no_run_to_resume(frame: dict[str, Any]) -> bool:
    """`chat.resume` found nothing running: JiuwenSwarm answers with a completed-task notice."""
    return "已完成" in _notice(frame)


def _resume_answer(frame: dict[str, Any]) -> bool:
    """The gateway's own answer to a `chat.resume` (`res`, then "task resumed"); not part of the run."""
    return (frame.get("type") == "res" and str(frame.get("id", "")).startswith("resume-")) or "已恢复" in _notice(frame)


async def chat(url: str, params: dict[str, Any], *, idle_timeout: float | None = None) -> AsyncIterator[dict[str, Any]]:
    """Run a chat that needs no approval and yield its frames."""
    async with ChatRun(url, params, idle_timeout=idle_timeout) as run:
        async for frame in run:
            yield frame


async def rpc(url: str, method: str, params: dict[str, Any] | None = None, *, timeout: float = 30) -> dict[str, Any]:
    """One non-streaming management call (`mcp.*`, `permissions.*`, ...).

    Returns the response payload; a refusal raises GatewayError. Management
    methods are served on the web channel (`ws://<host>:<web port>/ws`), not on
    the `/tui` route chats use.
    """
    try:
        connection = await websockets.connect(url, max_size=None)
    except OSError as error:
        raise GatewayError(f"gateway unreachable at {url}: {error}") from error
    async with connection:
        await asyncio.wait_for(connection.recv(), timeout)  # connection.ack
        request_id = f"rpc-{uuid.uuid4().hex[:12]}"
        await connection.send(json.dumps({
            "type": "req", "id": request_id, "method": method, "is_stream": False, "params": params or {},
        }, ensure_ascii=False))
        while True:
            frame = json.loads(await asyncio.wait_for(connection.recv(), timeout))
            if frame.get("type") == "res" and frame.get("id") == request_id:
                break
    if not frame.get("ok"):
        raise GatewayError(f"{method} refused: {frame.get('error') or frame.get('payload')}")
    return frame.get("payload") or {}
