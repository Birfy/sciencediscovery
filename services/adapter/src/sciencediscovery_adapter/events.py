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

import re
import uuid
from dataclasses import dataclass, field
from typing import Any

# Frames that carry no run-visible state. Listed so that "ignored on purpose"
# stays distinguishable from "not mapped yet" in `RunEventMapper.unmapped`.
_IGNORED_EVENTS = frozenset({"connection.ack", "context.usage"})

_ERROR_CODES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\b(401|403)\b|unauthori[sz]ed|invalid.{0,10}api.?key", re.I), "unauthorized"),
    (re.compile(r"\b429\b|rate.?limit|too many requests", re.I), "rate-limited"),
    (re.compile(r"timed? ?out|timeout", re.I), "timeout"),
    (re.compile(r"APIConnectionError|connection (error|refused|reset)|ConnectError", re.I), "transport-error"),
    (re.compile(r"\b5\d\d\b|server error|overloaded", re.I), "server-error"),
)


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
