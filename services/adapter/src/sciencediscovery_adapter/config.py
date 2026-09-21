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
    # JiuwenSwarm: chats go to the gateway route, management calls to the web channel.
    gateway_url: str = "ws://127.0.0.1:19001/tui"
    mgmt_url: str = "ws://127.0.0.1:19000/ws"
    # How JiuwenSwarm reaches this process to call the per-run MCP toolsets.
    public_url: str = ""
    # Bearer token the legacy API presents on /agent/*; empty leaves them open
    # (the adapter listens on loopback by default).
    agent_token: str = ""
    # How long JiuwenSwarm waits for one tool call over MCP. Its default is 30 s, which cuts off
    # a subagent (minutes) or a long shell command; the run's own timeout is what should end them.
    tool_timeout_s: int = 3600

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        env = dict(os.environ if env is None else env)
        port = int(env.get("SCIENCE_AGENT_PORT", "4310"))
        legacy_port = int(env.get("SCIENCE_AGENT_LEGACY_PORT", str(port + 100)))
        return cls(
            host=env.get("SCIENCE_AGENT_HOST", "127.0.0.1"),
            port=port,
            legacy_url=env.get("SCIENCE_AGENT_LEGACY_URL", f"http://127.0.0.1:{legacy_port}").rstrip("/"),
            gateway_url=env.get("JIUWENSWARM_GATEWAY_URL", "ws://127.0.0.1:19001/tui"),
            mgmt_url=env.get("JIUWENSWARM_MGMT_URL", "ws://127.0.0.1:19000/ws"),
            public_url=env.get("SCIENCE_AGENT_ADAPTER_PUBLIC_URL", f"http://127.0.0.1:{port}").rstrip("/"),
            agent_token=env.get("SCIENCE_AGENT_ADAPTER_TOKEN", ""),
            tool_timeout_s=int(env.get("SCIENCE_AGENT_ADAPTER_TOOL_TIMEOUT_S", "3600")),
        )
