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

"""Carry an earlier conversation into a JiuwenSwarm session that has no context yet.

JiuwenSwarm keeps a conversation's context per session and manages its size itself (it compresses
old turns when the model's window fills). Its API has no call that writes into that context, so a
conversation that began elsewhere, for example on the built-in loop, is handed over once, as text
at the top of the session's first message. From then on JiuwenSwarm owns it and can compress it.
"""

from __future__ import annotations

import json
from typing import Any

# Enough for a long conversation, small enough not to be the whole window on its own.
MAX_CHARS = 60_000
_TOOL_RESULT_CHARS = 600
_TOOL_ARGS_CHARS = 200


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
    return ""


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + " …"


def _line(message: dict[str, Any]) -> str:
    role = message.get("role")
    if role == "user":
        return f"user: {_text(message.get('content'))}"
    if role == "tool":
        return f"tool result ({message.get('name', '?')}): {_clip(_text(message.get('content')), _TOOL_RESULT_CHARS)}"
    parts = []
    text = _text(message.get("content"))
    if text:
        parts.append(f"assistant: {text}")
    for call in message.get("tool_calls") or []:
        function = call.get("function") or {}
        arguments = function.get("arguments", "")
        arguments = arguments if isinstance(arguments, str) else json.dumps(arguments, ensure_ascii=False)
        parts.append(f"assistant called {function.get('name', '?')}({_clip(arguments, _TOOL_ARGS_CHARS)})")
    return "\n".join(parts)


def transcript(history: list[dict[str, Any]]) -> str:
    """The earlier conversation as text, oldest first; the oldest part is dropped if it is too long."""
    lines = [line for line in (_line(m) for m in history if m.get("role") in ("user", "assistant", "tool")) if line]
    kept: list[str] = []
    size = 0
    for line in reversed(lines):
        if size + len(line) > MAX_CHARS and kept:
            kept.append("(earlier turns omitted)")
            break
        kept.append(line)
        size += len(line) + 1
    return "\n".join(reversed(kept))


def seeded_prompt(history: list[dict[str, Any]], prompt: str) -> str:
    """The first message of a session: the earlier conversation, then the new request."""
    earlier = transcript(history)
    if not earlier:
        return prompt
    return (
        "<earlier_conversation>\n"
        "This conversation began before this session existed. What was said so far, oldest first:\n\n"
        f"{earlier}\n"
        "</earlier_conversation>\n\n"
        f"{prompt}"
    )
