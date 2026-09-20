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
"""Opt-in: talks to a real JiuwenSwarm gateway whose model is the scripted stub.

    JIUWENSWARM_GATEWAY_URL=ws://127.0.0.1:20001/tui pytest tests/test_gateway_live.py

The stub (tests/stub_llm.py) must be serving the gateway's configured model.
JIUWENSWARM_LIVE_SCENARIO selects the scenario, and the stub must be freshly
started for it (its script is consumed one turn per request):

    plain  no STUB_LLM_SCRIPT; the stub answers "hello from stub"
    bash   STUB_LLM_SCRIPT=tests/fixtures/stub_script_bash.json
"""

import os
import uuid

import pytest

from sciencediscovery_adapter.events import RunEventMapper
from sciencediscovery_adapter.gateway import chat

URL = os.environ.get("JIUWENSWARM_GATEWAY_URL")
SCENARIO = os.environ.get("JIUWENSWARM_LIVE_SCENARIO", "plain")
pytestmark = pytest.mark.skipif(not URL, reason="JIUWENSWARM_GATEWAY_URL not set")


def params(session_id: str, text: str) -> dict:
    return {
        "session_id": session_id, "content": text, "query": text,
        "mode": "agent.work.normal", "cwd": "/tmp", "project_dir": "/tmp", "trusted_dirs": ["/tmp"],
        "supports_user_interaction": False, "agent_ref": {"mode": "agent.work.normal", "id": "default"},
    }


@pytest.mark.skipif(SCENARIO != "plain", reason="scenario is not plain")
async def test_real_gateway_reply_maps_to_a_completed_run():
    mapper = RunEventMapper()
    events = []
    async for frame in chat(URL, params(f"live-{uuid.uuid4().hex[:8]}", "say hi"), idle_timeout=60):
        events.extend(mapper.feed(frame))
    assert mapper.final_text == "hello from stub"
    assert events[0]["type"] == "agent.phase"
    assert "".join(e["delta"] for e in events if e["type"] == "assistant.delta") == "hello from stub"
    assert mapper.unmapped == []


@pytest.mark.skipif(SCENARIO != "bash", reason="scenario is not bash")
async def test_real_gateway_tool_round_maps_to_tool_events():
    mapper = RunEventMapper()
    events = []
    async for frame in chat(URL, params(f"live-{uuid.uuid4().hex[:8]}", "run it"), idle_timeout=60):
        events.extend(mapper.feed(frame))
    kinds = [e["type"] for e in events]
    assert kinds[:4] == ["agent.phase", "tool.started", "tool.output", "tool.completed"]
    completed = next(e for e in events if e["type"] == "tool.completed")["trace"]
    assert completed["status"] == "completed" and "J-MARK-1" in completed["output"]
    assert mapper.final_text == "tool finished ok"
    assert mapper.unmapped == []
