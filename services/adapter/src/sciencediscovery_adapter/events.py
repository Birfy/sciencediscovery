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

"""Translate JiuwenSwarm gateway frames into ScienceDiscovery run events.

Frame shapes here were captured from a real JiuwenSwarm 0.2.6 gateway
(`tests/fixtures/jw_*.raw`), not inferred from its source.
"""

from __future__ import annotations

import ast
import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

# Frames that carry no run-visible state. Listed so that "ignored on purpose"
# stays distinguishable from "not mapped yet" in `RunEventMapper.unmapped`.
_IGNORED_EVENTS = frozenset({"connection.ack", "context.usage", "chat.tool_update"})

_ERROR_CODES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\b(401|403)\b|unauthori[sz]ed|invalid.{0,10}api.?key", re.I), "unauthorized"),
    (re.compile(r"\b429\b|rate.?limit|too many requests", re.I), "rate-limited"),
    (re.compile(r"timed? ?out|timeout", re.I), "timeout"),
    (re.compile(r"APIConnectionError|connection (error|refused|reset)|ConnectError", re.I), "transport-error"),
    (re.compile(r"\b5\d\d\b|server error|overloaded", re.I), "server-error"),
)


_TOOL_RESULT = re.compile(r"^success=(True|False) data=(.*) error=(.*?) extracted_content=", re.S)


def parse_tool_result(result: Any) -> tuple[bool, str]:
    """Split JiuwenSwarm's `chat.tool_result.result` into (ok, text).

    The gateway sends the Python repr of its result object, e.g.
    "success=True data={'content': '...'} error=None extracted_content=None ...",
    not JSON, so it is unpicked here rather than left to the UI.
    """
    if not isinstance(result, str):
        return True, json.dumps(result, ensure_ascii=False)
    match = _TOOL_RESULT.match(result)
    if match is None:
        return True, result
    ok = match.group(1) == "True"
    if not ok:
        return False, _literal_text(match.group(3))
    data = _literal(match.group(2))
    if isinstance(data, dict) and isinstance(data.get("content"), str):
        return True, data["content"]
    return True, data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)


def _literal(text: str) -> Any:
    try:
        return ast.literal_eval(text)
    except (ValueError, SyntaxError):
        return text


def _literal_text(text: str) -> str:
    value = _literal(text)
    return value if isinstance(value, str) else str(value)


def classify_failure(message: str) -> str:
    """Map a provider error text onto the UI's stable RunFailureCode."""
    for pattern, code in _ERROR_CODES:
        if pattern.search(message):
            return code
    return "semantic-error"


@dataclass
class RunEventMapper:
    """Stateful per-run translator. Feed frames in arrival order."""

    turn: int = 0
    final_text: str | None = None
    finished: bool = False
    unmapped: list[str] = field(default_factory=list)
    _response_id: str | None = None
    _tools: dict[str, dict[str, Any]] = field(default_factory=dict)
    _announced_thinking: bool = False

    def feed(self, frame: dict[str, Any]) -> list[dict[str, Any]]:
        if frame.get("type") == "res":
            # The acceptance ack. A refusal is a failed run, not silence.
            if frame.get("ok") is False:
                return self._fail(_error_text(frame))
            return []
        if frame.get("type") != "event":
            self.unmapped.append(f"frame:{frame.get('type')}")
            return []
        name = frame.get("event", "")
        payload = frame.get("payload") or {}
        handler = getattr(self, "_on_" + name.replace(".", "_"), None)
        if handler is not None:
            return handler(payload)
        if name not in _IGNORED_EVENTS:
            self.unmapped.append(name)
        return []

    # -- helpers -----------------------------------------------------------

    def _open_response(self) -> list[dict[str, Any]]:
        if self._response_id is not None:
            return []
        self._response_id = uuid.uuid4().hex
        return [{"type": "assistant.response.started", "responseId": self._response_id, "turn": self.turn}]

    def _settle_response(self) -> list[dict[str, Any]]:
        if self._response_id is None:
            return []
        settled = {"type": "assistant.response.settled", "responseId": self._response_id, "turn": self.turn}
        self._response_id = None
        return [settled]

    def _fail(self, message: str) -> list[dict[str, Any]]:
        self.finished = True
        events = self._settle_response()
        events.append({"type": "run.failed", "error": message, "errorCode": classify_failure(message)})
        return events

    # -- gateway events ----------------------------------------------------

    def _on_chat_processing_status(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        if payload.get("is_processing") and not payload.get("is_complete") and self.turn == 0:
            self.turn = 1
            return [{"type": "agent.phase", "phase": "thinking", "turn": self.turn}]
        return []

    def _on_chat_delta(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        text = payload.get("content") or ""
        if not text:
            return []
        events = self._open_response()
        events.append({"type": "assistant.delta", "delta": text, "responseId": self._response_id})
        return events

    def _on_chat_reasoning(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        text = payload.get("content") or ""
        if not text:
            return []
        events = self._open_response()
        events.append({
            "type": "assistant.thinking.delta", "delta": text,
            "responseId": self._response_id, "turn": self.turn,
        })
        return events

    def _on_chat_tool_call(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        call = payload.get("tool_call") or {}
        tool_id = str(call.get("tool_call_id") or uuid.uuid4().hex)
        raw_arguments = call.get("arguments")
        input_text = raw_arguments if isinstance(raw_arguments, str) else json.dumps(raw_arguments or {}, ensure_ascii=False)
        try:
            args = json.loads(input_text)
        except ValueError:
            args = {}
        trace: dict[str, Any] = {
            "id": tool_id, "name": str(call.get("name") or "tool"), "input": input_text,
            "args": args if isinstance(args, dict) else {}, "status": "running",
        }
        if call.get("display_name"):
            trace["summary"] = str(call["display_name"])
        self._tools[tool_id] = trace
        return [*self._settle_response(), {"type": "tool.started", "trace": dict(trace)}]

    def _on_chat_tool_result(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        tool_id = str(payload.get("tool_call_id") or "")
        trace = self._tools.pop(tool_id, None) or {
            "id": tool_id, "name": str(payload.get("tool_name") or "tool"), "input": "{}", "args": {},
        }
        ok, text = parse_tool_result(payload.get("result"))
        trace.update({"status": "completed" if ok else "failed", "output": text, "outputChars": len(text)})
        self.turn += 1
        return [
            {"type": "tool.output", "toolCallId": tool_id, "chunk": text},
            {"type": "tool.completed", "trace": trace},
        ]

    def _on_chat_final(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        self.final_text = payload.get("content") or ""
        self.finished = True
        return self._settle_response()

    def _on_chat_error(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        return self._fail(str(payload.get("error") or "unknown error"))

    def _on_chat_interrupt_result(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        self.finished = True
        events = self._settle_response()
        events.append({"type": "run.cancelled", "reason": str(payload.get("message") or "cancelled")})
        return events


def _error_text(frame: dict[str, Any]) -> str:
    error = frame.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or error.get("code") or error)
    return str(error or frame.get("payload") or "request refused")
