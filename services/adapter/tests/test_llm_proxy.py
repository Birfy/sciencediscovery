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

import httpx
from fastapi import FastAPI

from sciencediscovery_adapter.llm_proxy import LlmRoute, LlmRoutes, llm_router, rewrite_request, rewrite_response

ROUTE = LlmRoute(base_url="http://llm.test/v1", api_key="sk-real", model="gpt-real", tool_prefix="mcp_sci_",
                 tool_names=frozenset({"run_shell", "declare_artifact"}), system_prompt="You are the science agent.")


def tool(name):
    return {"type": "function", "function": {"name": name, "description": "d", "parameters": {"type": "object"}}}


def test_the_tool_list_is_cut_to_the_runs_toolset_with_original_names():
    body = {"model": "sd-1", "tools": [tool("mcp_sci_run_shell"), tool("bash"), tool("mcp_sci_declare_artifact"), tool("todo_create")],
            "messages": []}
    names = [t["function"]["name"] for t in rewrite_request(body, ROUTE)["tools"]]
    assert names == ["run_shell", "declare_artifact"]


def test_no_science_tools_means_no_tools_field_at_all():
    out = rewrite_request({"tools": [tool("bash")], "tool_choice": "auto", "messages": []}, ROUTE)
    assert "tools" not in out and "tool_choice" not in out


def test_the_model_id_is_the_real_one_and_the_rest_is_kept():
    out = rewrite_request({"model": "sd-alias", "stream": True, "temperature": 0.1, "messages": []}, ROUTE)
    assert out["model"] == "gpt-real" and out["stream"] is True and out["temperature"] == 0.1


def test_the_system_prompt_is_replaced_and_extra_system_messages_dropped():
    body = {"messages": [{"role": "system", "content": "You are JiuwenSwarm."}, {"role": "user", "content": "hi"},
                         {"role": "system", "content": "another"}]}
    out = rewrite_request(body, ROUTE)["messages"]
    assert out == [{"role": "system", "content": "You are the science agent."}, {"role": "user", "content": "hi"}]


def test_a_system_prompt_is_added_when_the_request_has_none():
    out = rewrite_request({"messages": [{"role": "user", "content": "hi"}]}, ROUTE)["messages"]
    assert out[0] == {"role": "system", "content": "You are the science agent."}


def test_without_a_route_system_prompt_the_messages_are_untouched():
    route = LlmRoute(**{**ROUTE.__dict__, "system_prompt": None})
    body = {"messages": [{"role": "system", "content": "keep me"}, {"role": "user", "content": "hi"}]}
    assert rewrite_request(body, route)["messages"] == body["messages"]


def test_history_tool_calls_and_tool_names_lose_the_prefix():
    body = {"messages": [
        {"role": "assistant", "tool_calls": [{"id": "1", "type": "function", "function": {"name": "mcp_sci_run_shell", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "1", "name": "mcp_sci_run_shell", "content": "out"},
    ]}
    out = rewrite_request(body, ROUTE)["messages"]
    assert out[1]["tool_calls"][0]["function"]["name"] == "run_shell" and out[2]["name"] == "run_shell"


def test_tool_choice_by_name_is_unprefixed():
    out = rewrite_request({"tool_choice": {"type": "function", "function": {"name": "mcp_sci_run_shell"}},
                           "tools": [tool("mcp_sci_run_shell")], "messages": []}, ROUTE)
    assert out["tool_choice"]["function"]["name"] == "run_shell"


def test_response_tool_calls_get_the_prefix_back_but_unknown_names_do_not():
    payload = {"choices": [{"message": {"tool_calls": [
        {"function": {"name": "run_shell"}}, {"function": {"name": "not_ours"}}]}}]}
    calls = rewrite_response(payload, ROUTE)["choices"][0]["message"]["tool_calls"]
    assert [c["function"]["name"] for c in calls] == ["mcp_sci_run_shell", "not_ours"]


def test_a_stream_chunk_delta_is_rewritten_too():
    chunk = {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"name": "declare_artifact", "arguments": ""}}]}}]}
    assert rewrite_response(chunk, ROUTE)["choices"][0]["delta"]["tool_calls"][0]["function"]["name"] == "mcp_sci_declare_artifact"


def make_app(handler, route=ROUTE):
    routes = LlmRoutes()
    token = routes.add(route)
    app = FastAPI()
    upstream = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app.include_router(llm_router(routes, lambda: upstream))
    return app, token


def streamed(status, body, headers):
    return httpx.Response(status, headers=headers, stream=httpx.ByteStream(body))


async def post(app, token, body):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter") as client:
        return await client.post(f"/llm/{token}/v1/chat/completions", json=body)


async def test_the_request_goes_upstream_rewritten_with_the_real_key():
    seen = {}

    def handler(request):
        seen["url"], seen["auth"], seen["body"] = str(request.url), request.headers["authorization"], json.loads(request.content)
        return streamed(200, json.dumps({"choices": [{"message": {"content": "hi"}}]}).encode(), {"content-type": "application/json"})

    app, token = make_app(handler)
    response = await post(app, token, {"model": "sd-alias", "messages": [{"role": "user", "content": "x"}], "tools": [tool("mcp_sci_run_shell")]})
    assert response.json() == {"choices": [{"message": {"content": "hi"}}]}
    assert seen["url"] == "http://llm.test/v1/chat/completions" and seen["auth"] == "Bearer sk-real"
    assert seen["body"]["model"] == "gpt-real" and seen["body"]["tools"][0]["function"]["name"] == "run_shell"


async def test_a_streamed_tool_call_comes_back_prefixed_and_the_rest_is_untouched():
    def sse(payload):
        return b"data: " + json.dumps(payload).encode() + b"\n\n"

    body = (sse({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "run_shell", "arguments": ""}}]}}]})
            + sse({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "{\"command\":\"ls\"}"}}]}}]})
            + sse({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}) + b"data: [DONE]\n\n")
    app, token = make_app(lambda request: streamed(200, body, {"content-type": "text/event-stream"}))
    response = await post(app, token, {"stream": True, "messages": []})
    lines = [line for line in response.text.splitlines() if line.startswith("data:") and "[DONE]" not in line]
    parsed = [json.loads(line[5:]) for line in lines]
    assert parsed[0]["choices"][0]["delta"]["tool_calls"][0]["function"]["name"] == "mcp_sci_run_shell"
    assert parsed[1]["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"] == "{\"command\":\"ls\"}"
    assert "data: [DONE]" in response.text and response.headers["content-type"].startswith("text/event-stream")


async def test_upstream_errors_pass_through_with_their_status():
    app, token = make_app(lambda request: streamed(429, b'{"error":{"message":"rate limited"}}', {"content-type": "application/json"}))
    response = await post(app, token, {"messages": []})
    assert response.status_code == 429 and "rate limited" in response.text


async def test_an_unreachable_endpoint_is_a_502_and_an_unknown_token_a_404():
    def boom(request):
        raise httpx.ConnectError("down")

    app, token = make_app(boom)
    assert (await post(app, token, {"messages": []})).status_code == 502
    assert (await post(app, "nope", {"messages": []})).status_code == 404


def test_jiuwenswarms_own_tools_named_for_the_run_stay_visible_with_their_own_spec():
    route = LlmRoute(**{**ROUTE.__dict__, "native_tools": frozenset({"todo_create"})})
    todo = {"type": "function", "function": {"name": "todo_create", "description": "JiuwenSwarm's own", "parameters": {"type": "object", "properties": {"tasks": {}}}}}
    body = {"tools": [tool("mcp_sci_run_shell"), todo, tool("bash"), tool("todo_list")], "messages": []}
    tools = rewrite_request(body, route)["tools"]
    assert [t["function"]["name"] for t in tools] == ["run_shell", "todo_create"]
    assert tools[1]["function"]["description"] == "JiuwenSwarm's own"


def test_without_native_tools_none_of_them_is_visible():
    assert [t["function"]["name"] for t in rewrite_request({"tools": [tool("todo_create"), tool("mcp_sci_run_shell")], "messages": []}, ROUTE)["tools"]] == ["run_shell"]


def _client(routes, handler):
    upstream = httpx.MockTransport(handler)
    app = FastAPI()
    app.include_router(llm_router(routes, lambda: httpx.AsyncClient(transport=upstream)))
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter")


async def test_jiuwenswarms_own_model_calls_go_to_the_model_of_the_run_in_progress_untouched():
    routes = LlmRoutes()
    routes.add(LlmRoute(**{**ROUTE.__dict__, "base_url": "http://old.test/v1", "api_key": "old", "model": "old-model"}))
    routes.add(ROUTE)  # the run that started last
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(url=str(request.url), auth=request.headers["authorization"], body=json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "summary", "tool_calls": [
            {"id": "c", "type": "function", "function": {"name": "run_shell", "arguments": "{}"}}]}}]})

    body = {"model": "sd-default", "messages": [{"role": "system", "content": "Summarise this."}, {"role": "user", "content": "long text"}], "tools": [tool("bash")]}
    async with _client(routes, handler) as client:
        response = await client.post("/llm/default/v1/chat/completions", json=body, headers={"authorization": f"Bearer {routes.default_key}"})
    assert response.status_code == 200
    assert seen["url"] == "http://llm.test/v1/chat/completions" and seen["auth"] == "Bearer sk-real"
    assert seen["body"]["model"] == "gpt-real", "the real model id"
    assert seen["body"]["messages"][0]["content"] == "Summarise this.", "JiuwenSwarm's own system prompt, not the agent's"
    assert [t["function"]["name"] for t in seen["body"]["tools"]] == ["bash"], "no tool list cut or renamed"
    assert response.json()["choices"][0]["message"]["tool_calls"][0]["function"]["name"] == "run_shell", "names are not prefixed"


async def test_the_default_route_needs_its_own_key_and_a_run_in_progress():
    routes = LlmRoutes()
    async with _client(routes, lambda request: httpx.Response(200, json={})) as client:
        assert (await client.post("/llm/default/v1/chat/completions", json={})).status_code == 401
        assert (await client.post("/llm/default/v1/chat/completions", json={}, headers={"authorization": "Bearer wrong"})).status_code == 401
        no_run = await client.post("/llm/default/v1/chat/completions", json={}, headers={"authorization": f"Bearer {routes.default_key}"})
        assert no_run.status_code == 503 and "no run in progress" in no_run.json()["error"]["message"]


async def test_the_default_route_is_not_mistaken_for_a_runs_token():
    routes = LlmRoutes()
    async with _client(routes, lambda request: httpx.Response(200, json={})) as client:
        response = await client.post("/llm/default/v1/chat/completions", json={}, headers={"authorization": "Bearer x"})
    assert response.status_code == 401  # not "unknown route" (404) from the per-run handler


def test_a_jiuwenswarm_tool_spelled_like_one_of_ours_is_not_offered_as_a_second_copy():
    """JiuwenSwarm has its own read_file and list_files; the run's toolset has tools of those names too."""
    route = LlmRoute(**{**ROUTE.__dict__, "tool_names": frozenset({"read_file", "list_files", "run_shell"})})
    body = {"tools": [tool("read_file"), tool("mcp_sci_read_file"), tool("list_files"), tool("mcp_sci_list_files"), tool("mcp_sci_run_shell")],
            "messages": []}
    names = [t["function"]["name"] for t in rewrite_request(body, route)["tools"]]
    assert names == ["read_file", "list_files", "run_shell"], "one of each, and each one is the run's own"


def test_a_prefixed_name_that_is_not_in_the_toolset_is_not_offered():
    assert rewrite_request({"tools": [tool("mcp_sci_bash")], "messages": []}, ROUTE).get("tools") is None
