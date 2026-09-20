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

"""Adapter settings, read once from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    # The legacy TypeScript API that still serves every route not yet migrated.
    legacy_url: str

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        env = dict(os.environ if env is None else env)
        port = int(env.get("SCIENCE_AGENT_PORT", "4310"))
        legacy_port = int(env.get("SCIENCE_AGENT_LEGACY_PORT", str(port + 100)))
        return cls(
            host=env.get("SCIENCE_AGENT_HOST", "127.0.0.1"),
            port=port,
            legacy_url=env.get("SCIENCE_AGENT_LEGACY_URL", f"http://127.0.0.1:{legacy_port}").rstrip("/"),
        )
