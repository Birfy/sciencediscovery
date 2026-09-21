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

"""Put the model a run asked for into JiuwenSwarm's model list.

JiuwenSwarm keeps one global list (`models.list` / `models.replace_all`) and a
chat picks an entry with `model_name`. The UI chooses a model per run, so before
each run the adapter makes sure that model is in the list. Replacement is
whole-list, hence the lock: two runs must not interleave read-modify-write.

Limit: `model_name` is both the entry's key and the model id sent to the
provider, so two endpoints serving the same model id share one entry (the most
recent wins).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

Rpc = Callable[..., Awaitable[dict[str, Any]]]

# Fields JiuwenSwarm computes itself; sending them back is noise, not state.
_DERIVED = frozenset({"origin_index"})


@dataclass(frozen=True)
class ModelProfile:
    model: str
    base_url: str
    api_key: str
    provider: str = "OpenAI"
    # In tokens; JiuwenSwarm compresses a conversation against it (its default is 200000).
    context_window: int | None = None

    def entry(self) -> dict[str, Any]:
        entry = {"model_name": self.model, "api_base": self.base_url, "api_key": self.api_key,
                 "model_provider": self.provider}
        if self.context_window:
            entry["context_window_tokens"] = int(self.context_window)
        return entry


class ModelSync:
    def __init__(self, rpc: Rpc, mgmt_url: str) -> None:
        self._rpc = rpc
        self._url = mgmt_url
        self._lock = asyncio.Lock()

    async def ensure(self, profile: ModelProfile) -> str:
        """Return the `model_name` to chat with, adding or updating the entry if needed."""
        async with self._lock:
            current = (await self._rpc(self._url, "models.list")).get("models", [])
            existing = next((m for m in current if m.get("model_name") == profile.model), None)
            wanted = profile.entry()
            if existing and all(existing.get(key) == value for key, value in wanted.items()):
                return profile.model
            kept = [{k: v for k, v in m.items() if k not in _DERIVED}
                    for m in current if m.get("model_name") != profile.model]
            entry = {**(existing or {}), **wanted}
            entry.pop("origin_index", None)
            entry["is_default"] = bool((existing or {}).get("is_default")) or not any(m.get("is_default") for m in kept)
            await self._rpc(self._url, "models.replace_all", {"models": [*kept, entry]})
            return profile.model

    async def remove(self, model_name: str) -> None:
        """Drop a private per-run entry once its run is over."""
        async with self._lock:
            current = (await self._rpc(self._url, "models.list")).get("models", [])
            kept = [{k: v for k, v in m.items() if k not in _DERIVED} for m in current if m.get("model_name") != model_name]
            if len(kept) == len(current):
                return
            if kept and not any(m.get("is_default") for m in kept):
                kept[0]["is_default"] = True
            await self._rpc(self._url, "models.replace_all", {"models": kept})

    async def prune(self, prefix: str) -> int:
        """Drop every entry whose name starts with `prefix`; return how many.

        A run that ended abnormally (the stack was killed, the process crashed) never removed its private
        alias, and JiuwenSwarm probes every entry in its list each time it starts, so leftovers become
        a burst of failing requests at every restart. Only safe while no run is active: at start-up.
        """
        async with self._lock:
            current = (await self._rpc(self._url, "models.list")).get("models", [])
            kept = [{k: v for k, v in m.items() if k not in _DERIVED}
                    for m in current if not str(m.get("model_name", "")).startswith(prefix)]
            if len(kept) == len(current):
                return 0
            if kept and not any(m.get("is_default") for m in kept):
                kept[0]["is_default"] = True
            await self._rpc(self._url, "models.replace_all", {"models": kept})
            return len(current) - len(kept)
