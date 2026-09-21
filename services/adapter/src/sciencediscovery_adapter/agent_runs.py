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
import os
import re
import sys
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
from .llm_proxy import LlmRoute, LlmRoutes
from .mcp_server import Toolset, ToolsetRegistry
from .models import ModelProfile, ModelSync
from .schema import relax_schema

# SCIENCE_AGENT_ADAPTER_DEBUG=1 prints every tool event of every run to stderr.
_DEBUG = os.environ.get("SCIENCE_AGENT_ADAPTER_DEBUG") == "1"
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
    # Replaces JiuwenSwarm's own system prompt for this run (needs `model`).
    systemPrompt: str | None = None
    # The JiuwenSwarm session that holds this agent's conversation: stable across runs, one per agent
    # (the main agent, and each subagent, of one caller session). JiuwenSwarm keeps and compresses the
    # context there; the adapter neither sends nor rebuilds any history. Defaults to `sessionId`.
    sessionKey: str | None = None
    # Names of JiuwenSwarm's own tools that stay visible to the model besides the toolset above
    # (for example `todo_create`). They run inside JiuwenSwarm, not over the bridge.
    nativeTools: list[str] = Field(default_factory=list)
    # Longest a single tool call may take, in seconds; the run's own timeout, when the caller has one.
    toolTimeoutSeconds: int | None = None


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

    def __init__(
        self, settings: Settings, registry: ToolsetRegistry, client: Callable[[], httpx.AsyncClient],
        routes: LlmRoutes | None = None,
    ) -> None:
        self.settings = settings
        self.registry = registry
        self.routes = routes or LlmRoutes()
        self.client = client  # a getter: the HTTP client exists only while the app runs
        self.chat_run = gateway.ChatRun
        self.rpc = gateway.rpc
        self.models = ModelSync(lambda *a, **k: self.rpc(*a, **k), settings.mgmt_url)

    async def stream(self, request: AgentRunRequest) -> AsyncIterator[str]:
        name = "sci" + _SAFE_NAME.sub("", uuid.uuid4().hex)[:10]
        token = None
        llm_token = None
        model_alias = None
        registered = False
        jw_session = request.sessionKey or request.sessionId
        mapper = RunEventMapper(session_id=request.sessionId, mcp_prefixes=(f"mcp_{name}_",))
        params: dict[str, Any] = {
            "session_id": jw_session, "content": request.prompt, "query": request.prompt,
            "mode": request.mode, "cwd": request.cwd, "project_dir": request.cwd, "trusted_dirs": [request.cwd],
            "supports_user_interaction": True, "agent_ref": {"mode": request.mode, "id": "default"},
        }
        try:
            if request.model:
                if request.model.provider != "OpenAI":
                    raise ValueError(f"the {request.model.provider} protocol is not supported by this executor yet")
                # JiuwenSwarm talks to a private alias that points at this run's proxy route, which
                # forwards to the real endpoint with the real id, tool names and system prompt.
                llm_token = self.routes.add(LlmRoute(
                    base_url=request.model.baseUrl.rstrip("/"), api_key=request.model.apiKey, model=request.model.model,
                    tool_prefix=f"mcp_{name}_", tool_names=frozenset(t.name for t in request.tools),
                    tool_specs={t.name: {"description": t.description, "parameters": t.inputSchema} for t in request.tools},
                    system_prompt=request.systemPrompt, native_tools=frozenset(request.nativeTools),
                ))
                model_alias = f"sd-{llm_token[:12]}"
                params["model_name"] = await self.models.ensure(ModelProfile(
                    model_alias, f"{self.settings.public_url}/llm/{llm_token}/v1", llm_token, "OpenAI",))
            if request.tools:
                if request.bridge is None:
                    raise ValueError("tools were given without a bridge to run them")
                token = self.registry.add(Toolset(
                    # JiuwenSwarm validates strictly; the model still sees the originals (see LlmRoute).
                    tools=[{**t.model_dump(), "inputSchema": relax_schema(t.inputSchema)} for t in request.tools], call=bridge_caller(request.bridge, self.client()),
                    server_name=name,
                ))
                await self.rpc(self.settings.mgmt_url, "mcp.register_custom", {
                    "name": name, "transport": "streamable-http", "url": f"{self.settings.public_url}/mcp/{token}",
                    "timeout_s": request.toolTimeoutSeconds or self.settings.tool_timeout_s,
                })
                registered = True
                await self.rpc(self.settings.mgmt_url, "mcp.connect", {"name": name})
                params["mcp"] = [name]
            async with self.chat_run(self.settings.gateway_url, params) as run:
                try:
                    async for frame in run:
                        for event in mapper.feed(frame):
                            if _DEBUG and event["type"].startswith("tool."):
                                print(f"[adapter-debug] {request.sessionId[:8]} {json.dumps(event, ensure_ascii=False)[:500]}",
                                      file=sys.stderr, flush=True)
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
            if llm_token:
                self.routes.remove(llm_token)
            if model_alias:
                try:
                    await self.models.remove(model_alias)
                except Exception:
                    pass
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

    @router.get("/agent/info")
    async def info(authorization: str | None = Header(default=None)) -> dict[str, Any]:
        """Which backend runs agent turns, and whether JiuwenSwarm answers: the way to check a deployment."""
        accepted = {f"Bearer {token}" for token in (settings.agent_token, settings.api_token) if token}
        if accepted and authorization not in accepted:
            raise HTTPException(status_code=401, detail="unauthorized")
        reachable, detail = True, None
        try:
            await runner.rpc(settings.mgmt_url, "models.list", timeout=5)
        except Exception as error:  # gateway down, refused, timed out
            reachable, detail = False, str(error)[:200]
        return {
            "adapter": True,
            "executor": settings.executor,
            "jiuwenswarm": {
                "gatewayUrl": settings.gateway_url, "managementUrl": settings.mgmt_url,
                "reachable": reachable, **({"error": detail} if detail else {}),
            },
            "toolTimeoutSeconds": settings.tool_timeout_s,
        }

    return router
