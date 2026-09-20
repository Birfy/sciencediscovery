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

"""`POST /agent/runs`: run one agent turn on JiuwenSwarm and stream its events.

The caller (the legacy API's executor) sends the prompt and the run's toolset.
The adapter hosts that toolset as an MCP server, points JiuwenSwarm at it for
this run only, and streams what happens back as NDJSON, one JSON object a line:

    {"event": {...}}                      a run event (see events.py)
    {"done": {"finalText": "...", ...}}   the run finished; last line

A call to a tool is forwarded to `bridge.url` with the bridge token, and the
answer `{"text": "...", "isError": false}` goes back to JiuwenSwarm.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import gateway
from .config import Settings
from .events import RunEventMapper
from .mcp_server import Toolset, ToolsetRegistry
from .models import ModelProfile, ModelSync

_SAFE_NAME = re.compile(r"[^a-z0-9]")


class ToolSpec(BaseModel):
    name: str
    description: str = ""
    inputSchema: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})


class Bridge(BaseModel):
    url: str
    token: str = ""


class ModelSpec(BaseModel):
    model: str
    baseUrl: str
    apiKey: str = ""
    provider: str = "OpenAI"


class AgentRunRequest(BaseModel):
    sessionId: str
    prompt: str
    mode: str = "agent.work.normal"
    cwd: str = "/tmp"
    tools: list[ToolSpec] = Field(default_factory=list)
    bridge: Bridge | None = None
    model: ModelSpec | None = None


def bridge_caller(bridge: Bridge, client: httpx.AsyncClient):
    async def call(name: str, arguments: dict[str, Any]) -> tuple[str, bool]:
        response = await client.post(
            bridge.url, json={"name": name, "arguments": arguments},
            headers={"authorization": f"Bearer {bridge.token}"} if bridge.token else {},
        )
        response.raise_for_status()
        body = response.json()
        return str(body.get("text", "")), bool(body.get("isError", False))
    return call


class AgentRunner:
    """Runs agent turns. The gateway calls are attributes so tests can replace them."""

    def __init__(self, settings: Settings, registry: ToolsetRegistry, client: Callable[[], httpx.AsyncClient]) -> None:
        self.settings = settings
        self.registry = registry
        self.client = client  # a getter: the HTTP client exists only while the app runs
        self.chat_run = gateway.ChatRun
        self.rpc = gateway.rpc
        self.models = ModelSync(lambda *a, **k: self.rpc(*a, **k), settings.mgmt_url)

    async def stream(self, request: AgentRunRequest) -> AsyncIterator[str]:
        name = "sci" + _SAFE_NAME.sub("", uuid.uuid4().hex)[:10]
        token = None
        registered = False
        mapper = RunEventMapper(session_id=request.sessionId, mcp_prefixes=(f"mcp_{name}_",))
        params: dict[str, Any] = {
            "session_id": request.sessionId, "content": request.prompt, "query": request.prompt,
            "mode": request.mode, "cwd": request.cwd, "project_dir": request.cwd, "trusted_dirs": [request.cwd],
            "supports_user_interaction": True, "agent_ref": {"mode": request.mode, "id": "default"},
        }
        try:
            if request.model:
                params["model_name"] = await self.models.ensure(ModelProfile(
                    request.model.model, request.model.baseUrl, request.model.apiKey, request.model.provider))
            if request.tools:
                if request.bridge is None:
                    raise ValueError("tools were given without a bridge to run them")
                token = self.registry.add(Toolset(
                    tools=[t.model_dump() for t in request.tools], call=bridge_caller(request.bridge, self.client()),
                    server_name=name,
                ))
                await self.rpc(self.settings.mgmt_url, "mcp.register_custom", {
                    "name": name, "transport": "streamable-http", "url": f"{self.settings.public_url}/mcp/{token}",
                })
                registered = True
                await self.rpc(self.settings.mgmt_url, "mcp.connect", {"name": name})
                params["mcp"] = [name]
            async with self.chat_run(self.settings.gateway_url, params) as run:
                try:
                    async for frame in run:
                        for event in mapper.feed(frame):
                            yield json.dumps({"event": event}, ensure_ascii=False) + "\n"
                except BaseException:
                    # The caller went away (or the task was cancelled): stop the run.
                    if not mapper.finished:
                        mapper.request_cancel()
                        try:
                            await run.cancel()
                        except Exception:
                            pass
                    raise
            yield json.dumps({"done": {
                "finalText": mapper.final_text or "", "unmapped": mapper.unmapped,
                "cancelled": mapper._cancel_requested,
            }}, ensure_ascii=False) + "\n"
        except (gateway.GatewayError, ValueError, httpx.HTTPError) as error:
            failure = {"type": "run.failed", "error": str(error), "errorCode": "transport-error"}
            yield json.dumps({"event": failure}, ensure_ascii=False) + "\n"
            yield json.dumps({"done": {"finalText": "", "unmapped": mapper.unmapped, "cancelled": False}}) + "\n"
        finally:
            if token:
                self.registry.remove(token)
            if registered:
                for method in ("mcp.disconnect", "mcp.delete_custom"):
                    try:
                        await self.rpc(self.settings.mgmt_url, method, {"name": name})
                    except Exception:
                        pass  # best effort: the toolset is unreachable once removed anyway


def agent_router(runner: AgentRunner, settings: Settings) -> APIRouter:
    router = APIRouter()

    @router.post("/agent/runs")
    async def create_run(body: AgentRunRequest, authorization: str | None = Header(default=None)) -> StreamingResponse:
        if settings.agent_token and authorization != f"Bearer {settings.agent_token}":
            raise HTTPException(status_code=401, detail="unauthorized")
        return StreamingResponse(runner.stream(body), media_type="application/x-ndjson")

    return router
