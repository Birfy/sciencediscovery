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

"""A per-run OpenAI chat-completions proxy between JiuwenSwarm and the real model.

JiuwenSwarm names MCP tools `mcp_<server>_<tool>`, offers the model dozens of
tools of its own and wraps the prompt in its own persona. ScienceDiscovery's
model was tuned against its own tool names, toolset and system prompt, so the
proxy gives it those back:

- the tool list is cut to the run's toolset and the `mcp_<server>_` prefix removed;
- the system prompt is replaced by the caller's, when it sent one;
- the model id is the real one (JiuwenSwarm addresses the run by a private alias);
- tool calls coming back are given the prefix again so JiuwenSwarm can route them.

Only the OpenAI chat-completions protocol is handled.
"""

from __future__ import annotations

import json
import secrets
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask


@dataclass
class LlmRoute:
    base_url: str  # the real endpoint, up to and including /v1
    api_key: str
    model: str  # the real model id
    tool_prefix: str  # "mcp_<server>_"
    tool_names: frozenset[str]  # the run's tools, unprefixed
    system_prompt: str | None = None


@dataclass
class LlmRoutes:
    _routes: dict[str, LlmRoute] = field(default_factory=dict)

    def add(self, route: LlmRoute) -> str:
        token = secrets.token_hex(16)
        self._routes[token] = route
        return token

    def get(self, token: str) -> LlmRoute | None:
        return self._routes.get(token)

    def remove(self, token: str) -> None:
        self._routes.pop(token, None)


def _unprefixed(name: str, route: LlmRoute) -> str:
    return name.removeprefix(route.tool_prefix) if name.startswith(route.tool_prefix) else name


def rewrite_request(body: dict[str, Any], route: LlmRoute) -> dict[str, Any]:
    out = dict(body)
    out["model"] = route.model
    if body.get("tools"):
        out["tools"] = [
            {**tool, "function": {**tool["function"], "name": _unprefixed(tool["function"]["name"], route)}}
            for tool in body["tools"]
            if _unprefixed(tool.get("function", {}).get("name", ""), route) in route.tool_names
        ]
        if not out["tools"]:
            del out["tools"]
            out.pop("tool_choice", None)
    choice = body.get("tool_choice")
    if isinstance(choice, dict) and isinstance(choice.get("function"), dict):
        out["tool_choice"] = {**choice, "function": {**choice["function"], "name": _unprefixed(choice["function"]["name"], route)}}
    messages = []
    replaced = False
    for message in body.get("messages", []):
        message = dict(message)
        if message.get("role") == "system" and route.system_prompt is not None:
            if replaced:
                continue  # one system prompt: the caller's
            message["content"] = route.system_prompt
            replaced = True
        for call in message.get("tool_calls") or []:
            call["function"] = {**call["function"], "name": _unprefixed(call["function"]["name"], route)}
        if isinstance(message.get("name"), str):
            message["name"] = _unprefixed(message["name"], route)
        messages.append(message)
    if route.system_prompt is not None and not replaced:
        messages.insert(0, {"role": "system", "content": route.system_prompt})
    out["messages"] = messages
    return out


def _prefixed(name: str, route: LlmRoute) -> str:
    return route.tool_prefix + name if name in route.tool_names else name


def rewrite_response(payload: dict[str, Any], route: LlmRoute) -> dict[str, Any]:
    """Give tool calls the prefix again. Works on a full response and on a stream chunk."""
    for choice in payload.get("choices") or []:
        for holder in (choice.get("message"), choice.get("delta")):
            for call in (holder or {}).get("tool_calls") or []:
                function = call.get("function") or {}
                if isinstance(function.get("name"), str):
                    function["name"] = _prefixed(function["name"], route)
    return payload


_HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "host"}


async def _rewrite_stream(upstream: httpx.Response, route: LlmRoute) -> AsyncIterator[bytes]:
    buffer = ""
    async for text in upstream.aiter_text():
        buffer += text
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            if line.startswith("data:") and line[5:].strip() not in ("", "[DONE]"):
                try:
                    payload = rewrite_response(json.loads(line[5:]), route)
                    line = "data: " + json.dumps(payload, ensure_ascii=False)
                except ValueError:
                    pass  # not JSON: pass it through untouched
            yield (line + "\n").encode()
    if buffer:
        yield buffer.encode()


def llm_router(routes: LlmRoutes, client_getter) -> APIRouter:
    router = APIRouter()

    @router.post("/llm/{token}/v1/chat/completions")
    async def completions(token: str, request: Request) -> Response:
        route = routes.get(token)
        if route is None:
            return JSONResponse({"error": {"message": "unknown route"}}, status_code=404)
        body = rewrite_request(await request.json(), route)
        client: httpx.AsyncClient = client_getter()
        upstream_request = client.build_request(
            "POST", f"{route.base_url}/chat/completions", json=body,
            headers={"authorization": f"Bearer {route.api_key}"} if route.api_key else {},
        )
        try:
            upstream = await client.send(upstream_request, stream=True)
        except httpx.HTTPError as error:
            return JSONResponse({"error": {"message": f"model endpoint unreachable: {type(error).__name__}"}}, status_code=502)
        headers = {k: v for k, v in upstream.headers.items() if k.lower() not in _HOP_BY_HOP}
        if "text/event-stream" in upstream.headers.get("content-type", ""):
            return StreamingResponse(
                _rewrite_stream(upstream, route), status_code=upstream.status_code, headers=headers,
                media_type="text/event-stream", background=BackgroundTask(upstream.aclose),
            )
        content = await upstream.aread()
        await upstream.aclose()
        if upstream.status_code == 200:
            try:
                content = json.dumps(rewrite_response(json.loads(content), route), ensure_ascii=False).encode()
            except ValueError:
                pass
        return Response(content, status_code=upstream.status_code, headers=headers,
                        media_type=upstream.headers.get("content-type", "application/json"))

    return router
