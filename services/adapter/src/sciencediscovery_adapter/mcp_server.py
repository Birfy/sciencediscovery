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

"""A per-run, stateless MCP server (streamable HTTP, JSON-RPC).

One run gets one toolset: the tools the legacy API would have given its native
agent for that run. JiuwenSwarm lists them and calls them here; each call is
forwarded to a callback, which executes the legacy closure and answers with the
result text. Stateless on purpose: no session ids, no server-sent stream.
"""

from __future__ import annotations

import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

PROTOCOL_VERSION = "2025-03-26"

# (tool name, arguments) -> (text, is_error)
ToolCall = Callable[[str, dict[str, Any]], Awaitable[tuple[str, bool]]]


@dataclass
class Toolset:
    tools: list[dict[str, Any]]  # {name, description, inputSchema}
    call: ToolCall
    server_name: str = "sci"


@dataclass
class ToolsetRegistry:
    """Live toolsets by token; the token is the only capability that reaches one."""

    _sets: dict[str, Toolset] = field(default_factory=dict)

    def add(self, toolset: Toolset) -> str:
        token = secrets.token_urlsafe(24)
        self._sets[token] = toolset
        return token

    def get(self, token: str) -> Toolset | None:
        return self._sets.get(token)

    def remove(self, token: str) -> None:
        self._sets.pop(token, None)


def _result(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


async def handle_rpc(toolset: Toolset, message: dict[str, Any]) -> dict[str, Any] | None:
    """Answer one JSON-RPC message; `None` for a notification."""
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") or {}
    if request_id is None:
        return None  # notifications/initialized, notifications/cancelled, ...
    if method == "initialize":
        return _result(request_id, {
            "protocolVersion": params.get("protocolVersion") or PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": toolset.server_name, "version": "0.0.0"},
        })
    if method == "ping":
        return _result(request_id, {})
    if method == "tools/list":
        return _result(request_id, {"tools": toolset.tools})
    if method == "tools/call":
        name = params.get("name")
        if not any(tool["name"] == name for tool in toolset.tools):
            return _error(request_id, -32602, f"unknown tool: {name}")
        try:
            text, is_error = await toolset.call(str(name), params.get("arguments") or {})
        except Exception as error:  # the callback is another process; surface, don't crash the run
            text, is_error = f"tool bridge failed: {type(error).__name__}: {error}", True
        return _result(request_id, {"content": [{"type": "text", "text": text}], "isError": is_error})
    return _error(request_id, -32601, f"method not found: {method}")


def mcp_router(registry: ToolsetRegistry) -> APIRouter:
    router = APIRouter()

    @router.post("/mcp/{token}")
    async def post(token: str, request: Request) -> Response:
        toolset = registry.get(token)
        if toolset is None:
            return JSONResponse({"error": "unknown toolset"}, status_code=404)
        body = await request.json()
        if isinstance(body, list):  # a JSON-RPC batch
            replies = [r for r in [await handle_rpc(toolset, m) for m in body] if r is not None]
            return JSONResponse(replies) if replies else Response(status_code=202)
        reply = await handle_rpc(toolset, body)
        return JSONResponse(reply) if reply is not None else Response(status_code=202)

    @router.get("/mcp/{token}")
    async def get(token: str) -> Response:
        # No server-initiated stream: the spec allows refusing it.
        return Response(status_code=405, headers={"allow": "POST, DELETE"})

    @router.delete("/mcp/{token}")
    async def delete(token: str) -> Response:
        return Response(status_code=200)

    return router
