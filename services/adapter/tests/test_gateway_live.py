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
    approval  STUB_LLM_SCRIPT=tests/fixtures/stub_script_approval.json (allow and deny)
    cancel    STUB_LLM_SCRIPT=tests/fixtures/stub_script_slow.json

The instance must run with `permissions.enabled: true` and `tools.bash: ask`
(the approval scenario runs `touch`, which the engine does not auto-allow; the
bash scenario runs `echo`/`pwd`, which it does).
"""

import asyncio
import os
import uuid

import pytest

from sciencediscovery_adapter.events import RunEventMapper
from sciencediscovery_adapter.gateway import ChatRun, chat

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


@pytest.mark.skipif(SCENARIO != "approval", reason="scenario is not approval")
@pytest.mark.parametrize("decision", ["allow_once", "deny"])
async def test_real_gateway_approval_round_trip(decision):
    session = f"live-{uuid.uuid4().hex[:8]}"
    mapper = RunEventMapper(session_id=session)
    events = []
    async with ChatRun(URL, params(session, "run it"), idle_timeout=60) as run:
        async for frame in run:
            new = mapper.feed(frame)
            events.extend(new)
            if any(e["type"] == "permission.required" for e in new):
                request_id = next(e["request"]["id"] for e in new if e["type"] == "permission.required")
                answer, resolved = mapper.decide(request_id, decision)
                events.append(resolved)
                await run.answer(request_id, "permission_interrupt", answer)
    kinds = [e["type"] for e in events]
    assert kinds.index("permission.required") < kinds.index("permission.resolved") < kinds.index("tool.started")
    status = next(e for e in events if e["type"] == "tool.completed")["trace"]["status"]
    assert status == ("failed" if decision == "deny" else "completed")
    assert mapper.final_text == "approved and done"
    assert mapper.finished and mapper.unmapped == []


@pytest.mark.skipif(SCENARIO != "cancel", reason="scenario is not cancel")
async def test_real_gateway_cancel_ends_the_run_as_cancelled():
    session = f"live-{uuid.uuid4().hex[:8]}"
    mapper = RunEventMapper(session_id=session)
    events = []
    async with ChatRun(URL, params(session, "go"), idle_timeout=30) as run:
        async for frame in run:
            events.extend(mapper.feed(frame))
            if mapper.turn == 1 and not mapper._cancel_requested:
                await asyncio.sleep(2)  # let the model call start
                mapper.request_cancel()
                await run.cancel()
    assert events[-1]["type"] == "run.cancelled"
    assert mapper.finished and mapper.unmapped == []
