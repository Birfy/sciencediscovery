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

import pytest

from sciencediscovery_adapter.events import RunEventMapper, classify_failure

FIXTURES = Path(__file__).parent / "fixtures"


def frames(name: str) -> list[dict]:
    lines = [line.strip() for line in (FIXTURES / name).read_text().splitlines() if line.strip()]
    return [json.loads(line.removeprefix("ACK ")) for line in lines]


def run(name: str) -> tuple[RunEventMapper, list[dict]]:
    mapper = RunEventMapper()
    events: list[dict] = []
    for frame in frames(name):
        events.extend(mapper.feed(frame))
    return mapper, events


def test_plain_reply_maps_to_the_ui_event_sequence():
    mapper, events = run("jw_chat_plain.raw")
    assert [event["type"] for event in events] == [
        "agent.phase",
        "assistant.response.started",
        "assistant.delta", "assistant.delta", "assistant.delta",
        "assistant.response.settled",
    ]
    assert "".join(e["delta"] for e in events if e["type"] == "assistant.delta") == "hello from stub"
    assert mapper.final_text == "hello from stub"
    assert mapper.finished


def test_every_delta_of_one_reply_shares_one_response_id():
    _, events = run("jw_chat_plain.raw")
    started = next(e for e in events if e["type"] == "assistant.response.started")
    ids = {e["responseId"] for e in events if e["type"] in ("assistant.delta", "assistant.response.settled")}
    assert ids == {started["responseId"]}


def test_context_usage_and_ack_are_ignored_on_purpose():
    mapper, _ = run("jw_chat_plain.raw")
    assert mapper.unmapped == []


def test_unknown_events_are_reported_not_dropped_silently():
    mapper = RunEventMapper()
    assert mapper.feed({"type": "event", "event": "chat.brand_new", "payload": {}}) == []
    assert mapper.unmapped == ["chat.brand_new"]


def test_error_settles_the_open_response_then_fails_the_run():
    mapper = RunEventMapper()
    mapper.feed({"type": "event", "event": "chat.delta", "payload": {"content": "par"}})
    events = mapper.feed({"type": "event", "event": "chat.error", "payload": {
        "error": "[181001] model call failed, reason: openAI API async stream error: APIConnectionError: Connection error."}})
    assert [e["type"] for e in events] == ["assistant.response.settled", "run.failed"]
    assert events[1]["errorCode"] == "transport-error"
    assert "APIConnectionError" in events[1]["error"]
    assert mapper.finished


def test_refused_request_fails_the_run_with_the_gateway_message():
    mapper = RunEventMapper()
    events = mapper.feed({"type": "res", "id": "x", "ok": False, "error": {"code": "bad", "message": "no such session"}})
    assert events == [{"type": "run.failed", "error": "no such session", "errorCode": "semantic-error"}]


def test_interrupt_maps_to_cancelled():
    mapper = RunEventMapper()
    events = mapper.feed({"type": "event", "event": "chat.interrupt_result", "payload": {"message": "stopped"}})
    assert events == [{"type": "run.cancelled", "reason": "stopped"}]
    assert mapper.finished


def test_reasoning_streams_as_thinking_deltas():
    mapper = RunEventMapper()
    events = mapper.feed({"type": "event", "event": "chat.reasoning", "payload": {"content": "hmm"}})
    assert [e["type"] for e in events] == ["assistant.response.started", "assistant.thinking.delta"]
    assert events[1]["delta"] == "hmm"


@pytest.mark.parametrize("text,code", [
    ("HTTP 401 Unauthorized", "unauthorized"),
    ("429 rate limit exceeded", "rate-limited"),
    ("request timed out", "timeout"),
    ("APIConnectionError: Connection error.", "transport-error"),
    ("upstream 503", "server-error"),
    ("bad tool arguments", "semantic-error"),
])
def test_failure_classification(text, code):
    assert classify_failure(text) == code
