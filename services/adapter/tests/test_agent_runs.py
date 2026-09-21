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
from pathlib import Path

import httpx
import pytest

from sciencediscovery_adapter.agent_runs import AgentRunner
from sciencediscovery_adapter.app import create_app
from sciencediscovery_adapter.config import Settings

FIXTURES = Path(__file__).parent / "fixtures"
SETTINGS = Settings(host="127.0.0.1", port=4310, legacy_url="http://legacy.test",
                    gateway_url="ws://gw/tui", mgmt_url="ws://gw/ws", public_url="http://adapter.test")


def recorded(name):
    lines = [line.strip() for line in (FIXTURES / name).read_text().splitlines() if line.strip()]
    return [json.loads(line.removeprefix("ACK ")) for line in lines]


class FakeRun:
    """Stands in for gateway.ChatRun: replays a recorded run."""

    instances = []

    def __init__(self, url, params, **kwargs):
        self.url, self.params, self.cancelled = url, params, False
        FakeRun.instances.append(self)
        self.frames = recorded(FakeRun.fixture)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def cancel(self):
        self.cancelled = True

    def __aiter__(self):
        async def frames():
            for frame in self.frames:
                yield frame
        return frames()


@pytest.fixture
def harness(monkeypatch):
    FakeRun.instances = []
    FakeRun.fixture = "jw_chat_plain.raw"
    rpcs = []

    async def fake_rpc(url, method, params=None, **kwargs):
        if method == "models.list" and not rpcs and not FakeRun.instances:
            return {}  # the clean-up at start-up (see test_start_up_removes_stale_aliases), not part of a run
        rpcs.append((url, method, params))
        return {}

    app = create_app(SETTINGS)
    runner = app.state.agent_runner
    runner.chat_run = FakeRun
    runner.rpc = fake_rpc
    return app, runner, rpcs


async def post(app, body, headers=None):
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter") as client:
            response = await client.post("/agent/runs", json=body, headers=headers or {})
            lines = [json.loads(line) for line in response.text.splitlines() if line]
            return response, lines


async def test_streams_run_events_then_a_done_line(harness):
    app, *_ = harness
    response, lines = await post(app, {"sessionId": "s1", "prompt": "hi"})
    assert response.headers["content-type"].startswith("application/x-ndjson")
    events = [line["event"]["type"] for line in lines if "event" in line]
    assert events[0] == "agent.phase" and "assistant.delta" in events
    assert lines[-1] == {"done": {"finalText": "hello from stub", "unmapped": [], "cancelled": False}}


async def test_the_run_is_sent_to_the_gateway_with_the_session_and_prompt(harness):
    app, *_ = harness
    await post(app, {"sessionId": "s1", "prompt": "hi", "cwd": "/work"})
    params = FakeRun.instances[0].params
    assert FakeRun.instances[0].url == "ws://gw/tui"
    assert params["session_id"] == "s1" and params["content"] == "hi" and params["project_dir"] == "/work"
    assert "mcp" not in params


async def test_tools_are_registered_as_an_mcp_server_for_this_run_only(harness):
    app, _, rpcs = harness
    FakeRun.fixture = "jw_chat_mcp_direct.raw"
    tools = [{"name": "run_shell", "description": "d", "inputSchema": {"type": "object"}}]
    _, lines = await post(app, {"sessionId": "s1", "prompt": "go", "tools": tools,
                                "bridge": {"url": "http://legacy.test/bridge", "token": "t"}})
    methods = [m for _, m, _ in rpcs]
    assert methods == ["mcp.register_custom", "mcp.connect", "mcp.disconnect", "mcp.delete_custom"]
    name = rpcs[0][2]["name"]
    assert rpcs[0][2]["url"].startswith("http://adapter.test/mcp/") and rpcs[0][2]["transport"] == "streamable-http"
    assert FakeRun.instances[0].params["mcp"] == [name]
    assert all(p["name"] == name for _, _, p in rpcs)


async def test_tools_without_a_bridge_fail_the_run_cleanly(harness):
    app, _, rpcs = harness
    _, lines = await post(app, {"sessionId": "s1", "prompt": "go", "tools": [{"name": "x"}]})
    failed = [line["event"] for line in lines if line.get("event", {}).get("type") == "run.failed"]
    assert failed and "bridge" in failed[0]["error"]
    assert rpcs == [] and "done" in lines[-1]


async def test_a_gateway_that_cannot_register_the_toolset_fails_the_run(harness):
    from sciencediscovery_adapter.gateway import GatewayError

    app, runner, rpcs = harness

    async def refusing(url, method, params=None, **kwargs):
        rpcs.append(method)
        if method == "mcp.connect":
            raise GatewayError("mcp.connect refused: boom")
        return {}

    runner.rpc = refusing
    _, lines = await post(app, {"sessionId": "s1", "prompt": "go", "tools": [{"name": "x"}],
                                "bridge": {"url": "http://legacy.test/b"}})
    failed = next(line["event"] for line in lines if line.get("event", {}).get("type") == "run.failed")
    assert "mcp.connect refused" in failed["error"]
    assert rpcs[-2:] == ["mcp.disconnect", "mcp.delete_custom"]  # cleaned up even though connect failed


async def test_the_token_is_enforced_when_configured(harness):
    _, runner, _ = harness
    guarded = Settings(**{**SETTINGS.__dict__, "agent_token": "secret"})
    app = create_app(guarded)
    assert (await post(app, {"sessionId": "s", "prompt": "p"}))[0].status_code == 401
    assert (await post(app, {"sessionId": "s", "prompt": "p"}, {"authorization": "Bearer wrong"}))[0].status_code == 401


async def test_bridge_calls_go_to_the_callers_url_with_its_token(harness):
    from sciencediscovery_adapter.agent_runs import Bridge, bridge_caller

    seen = {}

    def handler(request):
        seen["url"], seen["auth"], seen["body"] = str(request.url), request.headers["authorization"], json.loads(request.content)
        return httpx.Response(200, json={"text": "out", "isError": True})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        text, is_error = await bridge_caller(Bridge(url="http://legacy.test/bridge", token="tok"), client)("run_shell", {"command": "x"})
    assert (text, is_error) == ("out", True)
    assert seen == {"url": "http://legacy.test/bridge", "auth": "Bearer tok",
                    "body": {"name": "run_shell", "arguments": {"command": "x"}}}


async def test_closing_the_stream_cancels_the_gateway_run(harness):
    import asyncio

    from sciencediscovery_adapter.agent_runs import AgentRunRequest

    _, runner, _ = harness

    class Endless(FakeRun):
        def __aiter__(self):
            async def frames():
                yield recorded("jw_chat_plain.raw")[2]  # processing_status: the run has started
                await asyncio.Event().wait()            # ...and never ends by itself
            return frames()

    runner.chat_run = Endless
    stream = runner.stream(AgentRunRequest(sessionId="s1", prompt="go"))
    first = await anext(stream)
    assert json.loads(first)["event"]["type"] == "agent.phase"
    await stream.aclose()  # what the HTTP layer does when the client disconnects
    assert FakeRun.instances[0].cancelled is True


async def test_the_run_talks_to_a_private_alias_that_routes_to_the_real_model(harness):
    app, runner, rpcs = harness
    listed = {"models": []}

    async def rpc(url, method, params=None, **kwargs):
        rpcs.append((url, method, params))
        if method == "models.list":
            return {"models": [dict(m) for m in listed["models"]]}
        if method == "models.replace_all":
            listed["models"] = params["models"]
        return {}

    runner.rpc = rpc
    seen = {}
    original = runner.chat_run

    class Spy(original):
        def __init__(self, url, params, **kwargs):
            super().__init__(url, params, **kwargs)
            seen["alias"] = params["model_name"]
            seen["entry"] = next(m for m in listed["models"] if m["model_name"] == params["model_name"])
            seen["route"] = runner.routes.get(seen["entry"]["api_key"])

    runner.chat_run = Spy
    await post(app, {"sessionId": "s1", "prompt": "hi", "systemPrompt": "Be a scientist.",
                     "tools": [{"name": "run_shell"}], "bridge": {"url": "http://legacy.test/b"},
                     "model": {"model": "gpt-x", "baseUrl": "http://llm/v1/", "apiKey": "sk"}})
    entry, route = seen["entry"], seen["route"]
    assert seen["alias"].startswith("sd-") and seen["alias"] != "gpt-x"
    assert entry["api_base"] == f"http://adapter.test/llm/{entry['api_key']}/v1"
    assert (route.base_url, route.api_key, route.model, route.system_prompt) == ("http://llm/v1", "sk", "gpt-x", "Be a scientist.")
    assert route.tool_names == frozenset({"run_shell"}) and route.tool_prefix.startswith("mcp_sci")
    # after the run: the alias is gone from the list and the route is closed
    assert listed["models"] == [] and runner.routes.get(entry["api_key"]) is None


async def test_a_protocol_other_than_openai_chat_is_refused_clearly(harness):
    app, *_ = harness
    _, lines = await post(app, {"sessionId": "s1", "prompt": "hi",
                                "model": {"model": "claude-x", "baseUrl": "http://a/v1", "provider": "Anthropic"}})
    failed = next(line["event"] for line in lines if line.get("event", {}).get("type") == "run.failed")
    assert "Anthropic protocol is not supported" in failed["error"]


async def test_no_model_leaves_the_gateways_default_in_charge(harness):
    app, *_ = harness
    await post(app, {"sessionId": "s1", "prompt": "hi"})
    assert "model_name" not in FakeRun.instances[0].params


async def test_start_up_removes_stale_aliases_left_by_an_earlier_process():
    calls = []

    async def rpc(url, method, params=None, **kwargs):
        calls.append(method)
        if method == "models.list":
            return {"models": [{"model_name": "sd-old", "is_default": False}, {"model_name": "kept", "is_default": True}]}
        return {}

    app = create_app(SETTINGS)
    app.state.agent_runner.models._rpc = rpc
    async with app.router.lifespan_context(app):
        pass
    assert calls == ["models.list", "models.replace_all"]


async def test_the_per_run_mcp_server_gets_a_tool_timeout_far_beyond_jiuwenswarms_30_seconds(harness):
    app, _, rpcs = harness
    FakeRun.fixture = "jw_chat_mcp_direct.raw"
    tools = [{"name": "run_shell", "description": "d", "inputSchema": {"type": "object"}}]
    bridge = {"url": "http://legacy.test/bridge", "token": "t"}
    await post(app, {"sessionId": "s1", "prompt": "go", "tools": tools, "bridge": bridge})
    assert next(p for _, m, p in rpcs if m == "mcp.register_custom")["timeout_s"] == 3600
    rpcs.clear()
    await post(app, {"sessionId": "s1", "prompt": "go", "tools": tools, "bridge": bridge, "toolTimeoutSeconds": 7200})
    assert next(p for _, m, p in rpcs if m == "mcp.register_custom")["timeout_s"] == 7200


class HistoryHarness:
    """A gateway that says whether it already has a conversation for a session."""

    def __init__(self, harness, known: dict[str, int]):
        self.app, self.runner, self.rpcs = harness
        self.known = known
        original = self.runner.rpc

        async def rpc(url, method, params=None, **kwargs):
            if method == "session.get_metadata":
                if params["session_id"] not in known:
                    raise RuntimeError("session.get_metadata refused: session not found")
                return {"message_count": known[params["session_id"]]}
            return await original(url, method, params, **kwargs)

        self.runner.rpc = rpc


HISTORY = [{"role": "user", "content": "earlier question"}, {"role": "assistant", "content": "earlier answer"}]


async def test_a_session_jiuwenswarm_has_no_context_for_is_started_with_the_earlier_conversation(harness):
    h = HistoryHarness(harness, {})
    await post(h.app, {"sessionId": "s1", "prompt": "next", "history": HISTORY})
    content = FakeRun.instances[0].params["content"]
    assert "<earlier_conversation>" in content and "user: earlier question" in content and "assistant: earlier answer" in content
    assert content.endswith("next")
    assert FakeRun.instances[0].params["session_id"] == "s1"


async def test_a_session_that_already_has_context_is_continued_as_it_is(harness):
    h = HistoryHarness(harness, {"s1": 4})
    await post(h.app, {"sessionId": "s1", "prompt": "next", "history": HISTORY})
    assert FakeRun.instances[0].params["content"] == "next"


async def test_a_known_but_empty_session_is_started_with_the_history_too(harness):
    h = HistoryHarness(harness, {"s1": 0})
    await post(h.app, {"sessionId": "s1", "prompt": "next", "history": HISTORY})
    assert "<earlier_conversation>" in FakeRun.instances[0].params["content"]


async def test_the_session_key_names_the_jiuwenswarm_session_and_no_history_means_no_lookup(harness):
    h = HistoryHarness(harness, {})
    await post(h.app, {"sessionId": "s1", "sessionKey": "s1--sub-7", "prompt": "hi"})
    assert FakeRun.instances[0].params["session_id"] == "s1--sub-7"
    assert FakeRun.instances[0].params["content"] == "hi"
    assert "session.get_metadata" not in [m for _, m, _ in h.rpcs]


async def test_the_models_context_window_is_given_to_jiuwenswarm_as_the_entrys_window(harness):
    _, runner, rpcs = harness
    FakeRun.fixture = "jw_chat_plain.raw"
    await post(harness[0], {"sessionId": "s1", "prompt": "hi", "model": {"model": "m", "baseUrl": "http://llm.test/v1", "apiKey": "k", "contextWindow": 131072}})
    replaced = [p for _, m, p in rpcs if m == "models.replace_all"]
    assert any(entry.get("context_window_tokens") == 131072 for p in replaced for entry in p["models"])


async def get(app, path, headers=None):
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter") as client:
            return await client.get(path, headers=headers or {})


async def test_info_says_which_backend_runs_and_whether_jiuwenswarm_answers(harness):
    app, *_ = harness
    body = (await get(app, "/agent/info")).json()
    assert body["adapter"] is True and body["executor"] == "native"
    assert body["jiuwenswarm"]["reachable"] is True and body["jiuwenswarm"]["managementUrl"] == "ws://gw/ws"
    assert body["toolTimeoutSeconds"] == 3600


async def test_info_reports_an_executor_of_jiuwenswarm_and_a_gateway_that_does_not_answer():
    # Nothing listens on the management URL of these settings, which is what a JiuwenSwarm that is down looks like.
    app = create_app(Settings(**{**SETTINGS.__dict__, "executor": "jiuwenswarm", "mgmt_url": "ws://127.0.0.1:1/ws"}))
    body = (await get(app, "/agent/info")).json()
    assert body["executor"] == "jiuwenswarm" and body["jiuwenswarm"]["reachable"] is False
    assert "unreachable" in body["jiuwenswarm"]["error"]


async def test_info_needs_a_token_when_there_is_one():
    guarded = create_app(Settings(**{**SETTINGS.__dict__, "agent_token": "secret"}))
    assert (await get(guarded, "/agent/info")).status_code == 401
    assert (await get(guarded, "/agent/info", {"authorization": "Bearer wrong"})).status_code == 401
    assert (await get(guarded, "/agent/info", {"authorization": "Bearer secret"})).status_code == 200


async def test_info_also_opens_with_the_apis_own_access_token():
    app = create_app(Settings(**{**SETTINGS.__dict__, "api_token": "api-token"}))
    assert (await get(app, "/agent/info")).status_code == 401
    assert (await get(app, "/agent/info", {"authorization": "Bearer api-token"})).status_code == 200
