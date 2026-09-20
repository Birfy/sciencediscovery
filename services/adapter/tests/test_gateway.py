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

from sciencediscovery_adapter.gateway import ChatRun, GatewayError, chat, rpc


DONE = {"type": "event", "event": "chat.processing_status", "payload": {"is_processing": False, "is_complete": True}}


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
        yield DONE
        yield {"type": "event", "event": "chat.delta", "payload": {"content": "after the end"}}

    async with serve(script) as server:
        port = server.sockets[0].getsockname()[1]
        frames = await collect(f"ws://127.0.0.1:{port}/tui", {"session_id": "s1", "content": "yo"})
    assert seen["method"] == "chat.send" and seen["is_stream"] is True
    assert seen["params"] == {"session_id": "s1", "content": "yo"}
    assert [f.get("event", f["type"]) for f in frames] == ["res", "chat.delta", "chat.final", "chat.processing_status"]


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


async def test_a_chat_final_alone_does_not_end_the_run():
    """A run paused for approval emits an empty chat.final, then carries on."""
    def script(request):
        yield {"type": "event", "event": "chat.final", "payload": {"content": ""}}
        yield {"type": "event", "event": "chat.delta", "payload": {"content": "later"}}
        yield DONE

    async with serve(script) as server:
        port = server.sockets[0].getsockname()[1]
        frames = await collect(f"ws://127.0.0.1:{port}/tui", {})
    assert [f["event"] for f in frames] == ["chat.final", "chat.delta", "chat.processing_status"]


async def test_answer_resumes_the_paused_run_on_the_same_connection():
    answers = []

    async def handler(connection):
        await connection.send(json.dumps({"type": "event", "event": "connection.ack", "payload": {}}))
        json.loads(await connection.recv())
        await connection.send(json.dumps({"type": "event", "event": "chat.ask_user_question",
                                          "payload": {"request_id": "call_1", "source": "permission_interrupt"}}))
        answers.append(json.loads(await connection.recv()))
        await connection.send(json.dumps({"type": "event", "event": "chat.final", "payload": {"content": "ok"}}))
        await connection.send(json.dumps(DONE))

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        seen = []
        async with ChatRun(f"ws://127.0.0.1:{port}/tui", {"session_id": "s1", "mode": "agent.work.normal"}) as run:
            async for frame in run:
                seen.append(frame["event"])
                if frame["event"] == "chat.ask_user_question":
                    await run.answer("call_1", "permission_interrupt", {"selected_options": ["once"], "custom_input": "once"})
    assert seen == ["chat.ask_user_question", "chat.final", "chat.processing_status"]
    assert answers[0]["method"] == "chat.send"
    assert answers[0]["params"] == {
        "session_id": "s1", "query": "", "request_id": "call_1", "source": "permission_interrupt",
        "answers": [{"selected_options": ["once"], "custom_input": "once"}],
        "mode": "agent.work.normal", "supports_user_interaction": True,
    }


async def test_cancel_sends_chat_interrupt_with_the_cancel_intent():
    seen = []

    async def handler(connection):
        await connection.send(json.dumps({"type": "event", "event": "connection.ack", "payload": {}}))
        json.loads(await connection.recv())
        seen.append(json.loads(await connection.recv()))
        await connection.send(json.dumps(DONE))

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        async with ChatRun(f"ws://127.0.0.1:{port}/tui", {"session_id": "s1", "mode": "agent.work.normal"}) as run:
            await run.cancel()
            async for _ in run:
                pass
    assert seen[0]["method"] == "chat.interrupt" and seen[0]["is_stream"] is False
    assert seen[0]["params"] == {"session_id": "s1", "intent": "cancel", "mode": "agent.work.normal"}


async def test_rpc_returns_the_payload_of_the_matching_response():
    seen = []

    async def handler(connection):
        await connection.send(json.dumps({"type": "event", "event": "connection.ack", "payload": {}}))
        request = json.loads(await connection.recv())
        seen.append(request)
        await connection.send(json.dumps({"type": "event", "event": "noise", "payload": {}}))
        await connection.send(json.dumps({"type": "res", "id": request["id"], "ok": True, "payload": {"type": "connected"}}))

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        payload = await rpc(f"ws://127.0.0.1:{port}/ws", "mcp.connect", {"name": "sci"})
    assert payload == {"type": "connected"}
    assert seen[0]["method"] == "mcp.connect" and seen[0]["is_stream"] is False and seen[0]["params"] == {"name": "sci"}


async def test_rpc_refusal_raises():
    async def handler(connection):
        await connection.send(json.dumps({"type": "event", "event": "connection.ack", "payload": {}}))
        request = json.loads(await connection.recv())
        await connection.send(json.dumps({"type": "res", "id": request["id"], "ok": False, "error": "unknown method: x"}))

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        with pytest.raises(GatewayError, match="unknown method"):
            await rpc(f"ws://127.0.0.1:{port}/ws", "x")
