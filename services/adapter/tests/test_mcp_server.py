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

import httpx
import pytest
from fastapi import FastAPI

from sciencediscovery_adapter.mcp_server import Toolset, ToolsetRegistry, mcp_router

TOOLS = [{"name": "run_shell", "description": "Run a command.",
          "inputSchema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}]


@pytest.fixture
def setup():
    calls = []

    async def call(name, arguments):
        calls.append((name, arguments))
        return (f"ran {arguments.get('command')}", arguments.get("command") == "fail")

    registry = ToolsetRegistry()
    token = registry.add(Toolset(tools=TOOLS, call=call))
    app = FastAPI()
    app.include_router(mcp_router(registry))
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter")
    return client, token, calls, registry


async def rpc(client, token, method, params=None, id=1):
    body = {"jsonrpc": "2.0", "method": method, **({"id": id} if id is not None else {}), **({"params": params} if params else {})}
    return await client.post(f"/mcp/{token}", json=body)


async def test_initialize_echoes_the_clients_protocol_version(setup):
    client, token, *_ = setup
    response = await rpc(client, token, "initialize", {"protocolVersion": "2024-11-05", "capabilities": {}})
    result = response.json()["result"]
    assert result["protocolVersion"] == "2024-11-05"
    assert result["capabilities"] == {"tools": {"listChanged": False}}


async def test_tools_list_returns_the_runs_tools(setup):
    client, token, *_ = setup
    assert (await rpc(client, token, "tools/list")).json()["result"]["tools"] == TOOLS


async def test_tools_call_forwards_to_the_callback_and_returns_text(setup):
    client, token, calls, _ = setup
    response = await rpc(client, token, "tools/call", {"name": "run_shell", "arguments": {"command": "echo hi"}})
    assert response.json()["result"] == {"content": [{"type": "text", "text": "ran echo hi"}], "isError": False}
    assert calls == [("run_shell", {"command": "echo hi"})]


async def test_a_failed_tool_is_a_tool_error_not_a_protocol_error(setup):
    client, token, *_ = setup
    result = (await rpc(client, token, "tools/call", {"name": "run_shell", "arguments": {"command": "fail"}})).json()["result"]
    assert result["isError"] is True


async def test_unknown_tool_is_an_invalid_params_error(setup):
    client, token, calls, _ = setup
    body = (await rpc(client, token, "tools/call", {"name": "nope", "arguments": {}})).json()
    assert body["error"]["code"] == -32602 and calls == []


async def test_a_crashing_callback_becomes_an_error_result(setup):
    client, token, _, registry = setup

    async def boom(name, arguments):
        raise ConnectionError("bridge down")

    registry.get(token).call = boom
    result = (await rpc(client, token, "tools/call", {"name": "run_shell", "arguments": {}})).json()["result"]
    assert result["isError"] is True and "bridge down" in result["content"][0]["text"]


async def test_notifications_get_202_and_unknown_methods_are_errors(setup):
    client, token, *_ = setup
    assert (await rpc(client, token, "notifications/initialized", id=None)).status_code == 202
    assert (await rpc(client, token, "resources/list")).json()["error"]["code"] == -32601


async def test_an_unknown_token_is_404_and_get_is_refused(setup):
    client, token, *_ = setup
    assert (await rpc(client, "wrong", "tools/list")).status_code == 404
    assert (await client.get(f"/mcp/{token}")).status_code == 405


async def test_removed_toolsets_stop_answering(setup):
    client, token, _, registry = setup
    registry.remove(token)
    assert (await rpc(client, token, "tools/list")).status_code == 404
