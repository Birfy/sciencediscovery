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

import json

import pytest
import websockets

from sciencediscovery_adapter.gateway import GatewayError, chat


def serve(script):
    """A fake gateway: send the ack, read one request, then play `script(request)`."""
    async def handler(connection):
        await connection.send(json.dumps({"type": "event", "event": "connection.ack", "payload": {}}))
        request = json.loads(await connection.recv())
        for frame in script(request):
            await connection.send(json.dumps(frame))
    return websockets.serve(handler, "127.0.0.1", 0)


async def collect(url, params):
    return [frame async for frame in chat(url, params)]


async def test_sends_chat_send_and_yields_frames_until_final():
    seen = {}

    def script(request):
        seen.update(request)
        yield {"type": "res", "id": request["id"], "ok": True, "payload": {"accepted": True}}
        yield {"type": "event", "event": "chat.delta", "payload": {"content": "hi"}}
        yield {"type": "event", "event": "chat.final", "payload": {"content": "hi"}}
        yield {"type": "event", "event": "chat.delta", "payload": {"content": "after the end"}}

    async with serve(script) as server:
        port = server.sockets[0].getsockname()[1]
        frames = await collect(f"ws://127.0.0.1:{port}/tui", {"session_id": "s1", "content": "yo"})
    assert seen["method"] == "chat.send" and seen["is_stream"] is True
    assert seen["params"] == {"session_id": "s1", "content": "yo"}
    assert [f.get("event", f["type"]) for f in frames] == ["res", "chat.delta", "chat.final"]


async def test_stops_after_a_refused_request():
    def script(request):
        yield {"type": "res", "id": request["id"], "ok": False, "error": "nope"}

    async with serve(script) as server:
        port = server.sockets[0].getsockname()[1]
        frames = await collect(f"ws://127.0.0.1:{port}/tui", {})
    assert len(frames) == 1 and frames[0]["ok"] is False


async def test_unreachable_gateway_is_a_gateway_error():
    with pytest.raises(GatewayError, match="unreachable"):
        await collect("ws://127.0.0.1:9/tui", {})


async def test_connection_dropped_mid_run_is_a_gateway_error():
    def script(request):
        yield {"type": "event", "event": "chat.delta", "payload": {"content": "x"}}

    async with serve(script) as server:
        port = server.sockets[0].getsockname()[1]
        with pytest.raises(GatewayError, match="closed"):
            await collect(f"ws://127.0.0.1:{port}/tui", {})
