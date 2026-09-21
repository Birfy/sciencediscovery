# ScienceDiscovery adapter

Python front door for the JiuwenSwarm migration (issue 84). It owns the public
port, proxies every route it has not taken over to the legacy TypeScript API, and
runs agent turns on JiuwenSwarm when `SCIENCE_AGENT_EXECUTOR=jiuwenswarm`.

To run it, see [Run with JiuwenSwarm](../../docs/en/how-to/run-with-jiuwenswarm.md).
This file is for people working on the adapter.

## Direction

The legacy API keeps owning sessions, messages, run events and permission records.
Only the **agent executor** is swapped: the legacy `createAgent` seam
(`AgentRunBindings.createAgent`) is filled by `createJiuwenSwarmAgentFactory`
(`services/api/src/agent-run/jiuwenswarm-agent.ts`), which calls this adapter.

```
browser ──▶ adapter :4310 ──proxy──▶ legacy API :4410 ──createAgent──┐
                │  ▲                                                  │ POST /agent/runs
                │  └──── tool calls (loopback bridge, per run) ◀──────┤ (NDJSON events)
                ▼
           JiuwenSwarm gateway (WebSocket)  ──▶  model, via /llm/<token>/v1 (this adapter)
                └── MCP tools ─▶ /mcp/<token>  (this adapter)
```

A run, end to end:

1. The legacy API builds the run's tools exactly as the native agent would (workspace
   tools plus plugin tools such as `update_plan` and `task`), starts a loopback bridge
   that executes them, and posts the prompt, model, system prompt and tool list to
   `POST /agent/runs`.
2. The adapter hosts that toolset as a per-run MCP server (`mcp_server.py`), registers
   it with JiuwenSwarm for this run only, and points JiuwenSwarm at a private model
   alias whose endpoint is a per-run proxy route (`llm_proxy.py`).
3. JiuwenSwarm runs the loop. Tool calls come back over MCP and are forwarded to the
   bridge, so permissions, the runner, artifacts and their events behave as before.
   Model calls go through the proxy to the real endpoint.
4. The adapter maps JiuwenSwarm's frames to run events (`events.py`) and streams them
   back as NDJSON; the legacy API turns them into the events the UI already renders.

Why a model proxy: JiuwenSwarm names MCP tools `mcp_<server>_<tool>`, offers the model
dozens of tools of its own and wraps the prompt in its persona. The proxy restores the
tool names, cuts the list to the run's toolset, substitutes the caller's system prompt
and hands the model the original tool schemas.

## Modules

| Module | Role |
|---|---|
| `app.py`, `proxy.py` | FastAPI app; streaming reverse proxy (SSE included) to the legacy API |
| `agent_runs.py` | `POST /agent/runs`: orchestrates one run and streams NDJSON |
| `gateway.py` | `ChatRun` (one chat on one connection, approval answers, cancel) and `rpc()` |
| `events.py` | `RunEventMapper`: gateway frames → run events, error classification, usage |
| `mcp_server.py` | Stateless per-run MCP server; forwards tool calls to the bridge |
| `llm_proxy.py` | Per-run OpenAI chat-completions proxy |
| `models.py` | Puts the run's model alias into JiuwenSwarm's global model list |
| `schema.py` | Relaxes tool schemas for JiuwenSwarm; restores dropped empty arguments |

## What was measured on JiuwenSwarm 0.2.6 (not inferred)

Frames are recorded in `tests/fixtures/jw_*.raw`; `tests/stub_llm.py` scripts the model
so a run is reproducible.

- **Chat**: `chat.send` on the gateway (`/tui`). `res accepted`, then
  `chat.processing_status`, `chat.delta`\*, `chat.final`.
- **End of a run** is `chat.processing_status` with `is_complete`, **not** `chat.final`
  (a run paused for approval emits an empty `chat.final` and carries on).
- **Tools**: `chat.tool_call` / `chat.tool_update` / `chat.tool_result`. The result is a
  Python `repr` string (`success=True data={...} error=None ...`), not JSON. MCP results
  also carry the structured `raw_output`.
- **Approval** (JiuwenSwarm's own permission engine): an empty-error `tool_result` with no
  prior `tool_call`, then `chat.ask_user_question` (`source: permission_interrupt`). The
  options are positional (once, session, forever, deny) and labelled in the UI language.
  The answer is a second `chat.send` on the same connection. After a denial the tool
  result is the bare option label. `permissions.enabled` is off by default; `echo`/`pwd`
  are auto-allowed even with `bash: ask`.
- **Cancel**: `chat.interrupt` (`intent: cancel`, not streamed) gets a `res`; the run then
  just ends. No `chat.interrupt_result` arrives on the run's stream.
- **MCP**: management RPCs (`mcp.register_custom`, `mcp.connect`, `models.*`) are served on
  the web channel (`ws://<host>:<web port>/ws`), not `/tui`. A run reaches a server only
  when `chat.send` carries `"mcp": ["<name>"]`. With `progressive_tool_enabled: true` (the
  default) MCP tools are deferred behind `tool_search`/`tool_call`; the adapter needs it
  set to `false` (see `scripts/jiuwenswarm.sh`).
- **Models**: `models.replace_all` applies without a restart and replaces the whole list;
  `chat.send` selects an entry with `model_name`, which is also the id sent to the provider.
  Adding a model triggers an image-modality probe request (tool-less, non-streaming).
- **Argument handling**: JiuwenSwarm validates MCP tool arguments strictly (pydantic) where
  the native agent never validated, and it **drops empty arrays and objects** from a call
  (`{"plan": []}` arrives as `{}`; `""`, `0` and `false` survive). `schema.py` compensates.
- **Usage**: `chat.usage_metadata` (one per model call) carries token counts including
  reasoning and cache fields; `chat.usage_summary` repeats their sum.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SCIENCE_AGENT_ADAPTER` | unset | `1` makes `start-stack.sh` start the adapter on the public port |
| `SCIENCE_AGENT_PORT` | `4310` | Public port (the adapter's) |
| `SCIENCE_AGENT_LEGACY_PORT` / `SCIENCE_AGENT_LEGACY_URL` | port + 100 | Where the legacy API listens |
| `SCIENCE_AGENT_EXECUTOR` | unset | `jiuwenswarm` runs agent turns on JiuwenSwarm (needs the adapter) |
| `JIUWENSWARM_GATEWAY_URL` | `ws://127.0.0.1:19001/tui` | Chat route of the gateway |
| `JIUWENSWARM_MGMT_URL` | `ws://127.0.0.1:19000/ws` | Web channel used for `mcp.*` and `models.*` |
| `SCIENCE_AGENT_ADAPTER_PUBLIC_URL` | `http://127.0.0.1:<port>` | How JiuwenSwarm reaches the adapter |
| `SCIENCE_AGENT_ADAPTER_TOKEN` | unset | Bearer token required on `/agent/*` when set |
| `SCIENCE_AGENT_ADAPTER_DEBUG` | unset | `1` prints every tool event of every run to stderr |
| `SCIENCE_AGENT_JIUWENSWARM_DEBUG` | unset | `1` (legacy API) logs every bridge tool call |

## Tests

    UV_PROJECT_ENVIRONMENT=/tmp/adapter-venv uv sync --extra test
    /tmp/adapter-venv/bin/python -m pytest                       # ~100 unit tests, no JiuwenSwarm needed

Opt-in tests that talk to a real JiuwenSwarm (set the URLs first; a scripted stub
model is in `tests/stub_llm.py`):

    JIUWENSWARM_GATEWAY_URL=... JIUWENSWARM_MGMT_URL=... JIUWENSWARM_LIVE_SCENARIO=agent_run \
      pytest tests/test_gateway_live.py           # scenarios: plain, bash, approval, deny, cancel, mcp, agent_run
    REAL_LLM_BASE_URL=... REAL_LLM_MODEL=... REAL_LLM_KEY=... pytest tests/test_real_llm.py

The stub must be freshly started for each live scenario (its script is consumed one turn
per request); see the docstring of `tests/test_gateway_live.py`. Credentials are only
ever read from the environment.

TypeScript side: `cd services/api && pnpm build && node --test dist/agent-run/jiuwenswarm-agent.test.js`.

## Status against the milestone-0 journeys

Verified on Linux (bubblewrap) with `SCIENCE_AGENT_ADAPTER=1 SCIENCE_AGENT_EXECUTOR=jiuwenswarm`:
`journey-first-run`, `journey-compact-process` (2), `journey-plan-workspace`,
`journey-delegate-subtask`, `journey-deliver-result`: all pass. `journey-real-request`
passes against a live OpenAI-compatible endpoint.

Not done yet:

- **History**: only the current prompt is sent; JiuwenSwarm keeps history per `session_id`.
  `gatewayHistory` from the legacy API is unused, so pre-existing conversations are not
  carried over, a resumed subagent does not get its history, and legacy compaction is not
  applied.
- **Tool output store** (`ToolOutputStore`, oversized results by reference) is not part of
  the toolset; tool arguments are not schema-validated (as in the native agent).
- **Protocols**: only OpenAI chat completions. Anthropic and Responses fail the run with a
  clear message.
- **Model alias**: an entry is keyed by model id, so two endpoints serving the same id
  share one entry while a run is active.
- Everything outside `/agent/*` and `/llm/*` and `/mcp/*` is still proxied to the legacy API.
