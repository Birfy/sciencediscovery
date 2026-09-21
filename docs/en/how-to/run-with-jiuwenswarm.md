# Run agent turns on JiuwenSwarm

ScienceDiscovery can run its agent loop on [JiuwenSwarm](https://gitcode.com/openJiuwen/jiuwenswarm) instead of the built-in loop. This is an **optional, experimental** backend introduced by the JiuwenSwarm migration (issue 84). The built-in loop stays the default; nothing changes unless you choose JiuwenSwarm as described below.

What stays the same: the web UI, sessions, messages, run events, permission requests, the Runner and its sandbox, artifacts and provenance. Tools still run inside the ScienceDiscovery API process, so every permission check and Runner rule applies as before. What moves: the model loop, and the conversation context (JiuwenSwarm keeps and compresses it).

```
browser ─▶ adapter (public port) ─▶ API (port + 100)
              │                        │
              └─▶ JiuwenSwarm ◀────────┘   tools run in the API, called back over a per-run bridge
                       │
                       └─▶ model, through a loopback gateway in the API (any protocol the UI can configure)
```

What exists and what does not: [JiuwenSwarm migration: status and hand-over](../reference/jiuwenswarm-migration-status.md).

## Choose the backend

| | Built-in loop (default) | JiuwenSwarm |
|---|---|---|
| Start with | `./scripts/start-stack.sh --mode local` | `./scripts/start-stack.sh --mode local --jiuwenswarm` |
| Same thing by variables | (nothing set) | `SCIENCE_AGENT_ADAPTER=1 SCIENCE_AGENT_EXECUTOR=jiuwenswarm` |
| Browser journeys | `.ci/run-e2e.sh mocked` | `CI_E2E_BACKEND=jiuwenswarm .ci/run-e2e.sh mocked` (JiuwenSwarm must already be running) |
| Public port | the API on 4310 | the adapter on 4310, the API on 4410 |
| Modes | local, Docker, binary | **local (source) only** |

The choice is made when the stack starts; there is no switch in the UI. To go back, start without the flag (and without the two variables). Data (sessions, projects, models, settings) is the same directory either way, so a session begun on one backend continues on the other; a conversation begun on the built-in loop is handed to JiuwenSwarm once, at its first turn there.

**Check which backend is running:**

```bash
curl -s -H "Authorization: Bearer $SCIENCE_AGENT_AUTH_TOKEN" http://127.0.0.1:4310/agent/info
# {"adapter":true,"executor":"jiuwenswarm","jiuwenswarm":{"gatewayUrl":"ws://...","managementUrl":"ws://...","reachable":true},"toolTimeoutSeconds":3600}
```

A stack on the built-in loop, or one that was never started with the adapter, has no `/agent/info`. In the log of a JiuwenSwarm stack every chat shows `POST /agent/runs`, `POST /llm/…` and `POST /mcp/…` from the adapter.

## Requirements

- Source mode (see [Deployment](deployment.md#local-mode-host-processes)); the binary and Docker images do not include the adapter or JiuwenSwarm.
- `git` and `uv` on the host. JiuwenSwarm installs into its own directory and virtualenv, never into ScienceDiscovery's environments.
- Access to `gitcode.com` (to clone the pinned tag) and to a PyPI index. On a slow link or in mainland China, set `SCIENCE_AGENT_PYPI_INDEX` to a mirror and, if downloads time out, `UV_HTTP_TIMEOUT` (the script defaults to 300 seconds).
- About 1.5 GB of disk for the JiuwenSwarm install.
- Any model the UI can configure: OpenAI chat completions, OpenAI Responses or Anthropic Messages, with their provider variants. You configure the model in ScienceDiscovery as usual; JiuwenSwarm needs no model setup of its own.

## Install and start

```bash
scripts/jiuwenswarm.sh setup     # once: clone the pinned tag (workswarm0.2.6), install it, create the instance
./scripts/start-stack.sh --mode local --jiuwenswarm    # starts JiuwenSwarm if it is not running, then the stack
```

`setup` is idempotent and applies the one JiuwenSwarm setting ScienceDiscovery depends on: `progressive_tool_enabled: false` in the instance's `config/config.yaml`. With JiuwenSwarm's default (`true`) the tools of a run are hidden behind a search step and the model would no longer see them by the names ScienceDiscovery defined. `--jiuwenswarm` refuses to start, with a message, if JiuwenSwarm is not installed.

To manage JiuwenSwarm yourself: `scripts/jiuwenswarm.sh start | stop | status | env`. JiuwenSwarm creates its instance workspace under `~/.jiuwenswarm-instances/<name>` (it has no option to move it). The instance is named `sciencediscovery` and gets its own ports, so it does not collide with a default JiuwenSwarm on the same host. To use a JiuwenSwarm that this script does not manage, set `JIUWENSWARM_GATEWAY_URL` and `JIUWENSWARM_MGMT_URL` yourself.

## Configuration

Everything is environment variables on the stack (in `.env`, or exported before `start-stack.sh`). Only the first block is needed to use JiuwenSwarm.

| Variable | Default | Meaning |
|---|---|---|
| **Choosing** | | |
| `--jiuwenswarm` (flag) | off | Sets the next two variables and starts JiuwenSwarm if needed |
| `SCIENCE_AGENT_ADAPTER` | unset | `1` puts the adapter on the public port in front of the API |
| `SCIENCE_AGENT_EXECUTOR` | unset | `jiuwenswarm` runs agent turns on JiuwenSwarm (needs the adapter) |
| **JiuwenSwarm instance** | | |
| `JIUWENSWARM_ROOT` | `.sciencediscovery-data/jiuwenswarm` | Install directory |
| `JIUWENSWARM_INSTANCE` | `sciencediscovery` | Instance name |
| `JIUWENSWARM_TAG` | `workswarm0.2.6` | Version to install. Only 0.2.6 has been validated |
| `JIUWENSWARM_GIT_URL` | `https://gitcode.com/openJiuwen/jiuwenswarm.git` | Clone source |
| `JIUWENSWARM_GATEWAY_URL` | read from the instance | Chat route of the gateway, e.g. `ws://127.0.0.1:20001/tui` |
| `JIUWENSWARM_MGMT_URL` | read from the instance | Web channel used for `mcp.*` and `models.*`, e.g. `ws://127.0.0.1:20000/ws` |
| `SCIENCE_AGENT_PYPI_INDEX`, `UV_HTTP_TIMEOUT` | unset, `300` | PyPI mirror and download timeout for the install |
| **Ports and addresses** | | |
| `SCIENCE_AGENT_PORT` | `4310` | Public port (the adapter's) |
| `SCIENCE_AGENT_LEGACY_PORT` / `SCIENCE_AGENT_LEGACY_URL` | port + 100 | Where the API listens behind the adapter |
| `SCIENCE_AGENT_ADAPTER_URL` | `http://127.0.0.1:<port>` | How the API reaches the adapter |
| `SCIENCE_AGENT_ADAPTER_PUBLIC_URL` | `http://127.0.0.1:<port>` | How JiuwenSwarm reaches the adapter (its per-run MCP and model routes) |
| `SCIENCE_AGENT_HOST` | `127.0.0.1` | Interface the adapter binds |
| `SCIENCE_AGENT_ADAPTER_TOKEN` | unset | Bearer token the API presents on `/agent/*`; set it if the adapter listens beyond loopback |
| **How a run behaves** | | |
| `SCIENCE_AGENT_ADAPTER_TOOL_TIMEOUT_S` | `3600` | Longest one tool call may take (JiuwenSwarm's own limit is 30 s; the API passes the run's timeout when it has one) |
| `SCIENCE_AGENT_JIUWENSWARM_PLANNING` | unset | `todo`: the model plans with JiuwenSwarm's todo tools and its list becomes the plan. Default: `update_plan` |
| `SCIENCE_AGENT_LLM_MAX_TOKENS` | `16384` | Output budget per model call (shared with the built-in loop); raise it for reasoning models |
| `SCIENCE_AGENT_LLM_MAX_RETRIES`, `SCIENCE_AGENT_LLM_TIMEOUT_SECONDS` | `2`, `600` | Retries (429 and other transient errors) and per-call timeout (shared) |
| **Diagnostics** | | |
| `SCIENCE_AGENT_ADAPTER_DEBUG` | unset | `1` prints every tool event and the last messages of every model request (adapter) |
| `SCIENCE_AGENT_JIUWENSWARM_DEBUG` | unset | `1` logs every bridge tool call (API) |

Set per model in the UI, as usual: provider, protocol and variant, API key, thinking mode, network proxy. The model's context window (from the model catalog, or your override in the model settings) is passed to JiuwenSwarm so that it compresses the conversation against the model's real limit.

## What to expect

- The same conversations, tool cards, permission prompts, plans, subagents and artifacts as with the built-in loop; the milestone-0 journeys pass on this backend.
- JiuwenSwarm keeps each agent's conversation (main agent, and each subagent) in its own session and compresses it as the model's window fills. The run contract and ScienceDiscovery's per-step context (plan snapshot, durable state) are **not** injected.
- Conversation, plan and event data stay in ScienceDiscovery's own stores.
- No trajectory or evidence records for JiuwenSwarm runs, and images are not sent to the model.
- Adding a model makes JiuwenSwarm send one small probe request to it (to detect image input); the gateway refuses the picture, so you may see a `400` for it in the log. That is expected.
- Token usage is reported per model call, including reasoning tokens.
- If the connection to JiuwenSwarm drops during a run, the adapter takes the run up again (`chat.resume`); what was sent while it was down is lost.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `start-stack.sh` says JiuwenSwarm is not installed or not reachable | Run `scripts/jiuwenswarm.sh setup` once, then use `--jiuwenswarm`, or `scripts/jiuwenswarm.sh start` and `status`. Logs: `.sciencediscovery-data/jiuwenswarm/jiuwenswarm.log` and `~/.jiuwenswarm-instances/<name>/agent/.logs/`. |
| `/agent/info` shows `"reachable": false` | JiuwenSwarm is down or the URLs are wrong. Check `scripts/jiuwenswarm.sh status`; set `JIUWENSWARM_GATEWAY_URL`/`JIUWENSWARM_MGMT_URL` for an instance the script does not manage. |
| The model never calls a tool | Check `progressive_tool_enabled: false` in the instance config; `scripts/jiuwenswarm.sh setup` restores it. |
| A subagent or a long command ends with an empty error after 30 s | JiuwenSwarm's own limit for one MCP call. The adapter raises it per run (`SCIENCE_AGENT_ADAPTER_TOOL_TIMEOUT_S`); if you see it, the adapter is older than this fix. |
| A run ends in the middle of a thought, or fails with "cut off at its output limit" | A reasoning model spent the whole per-call output budget (`max_tokens`, 16384 by default) on thinking. Raise `SCIENCE_AGENT_LLM_MAX_TOKENS` on the stack and retry. The built-in loop has the same limit. |
| A model returns `429` | The provider is rate limiting. The run retries with back-off as the built-in loop does, and fails with the provider's message when the retries run out. |
| A provider answers `403` only through this backend | Some gateways filter by `User-Agent`. Test the endpoint with `curl` and the same key; report the response body. |
| To see what a run did | `SCIENCE_AGENT_ADAPTER_DEBUG=1` and `SCIENCE_AGENT_JIUWENSWARM_DEBUG=1` print it to the stack log. |

Design notes and the protocol facts measured against JiuwenSwarm 0.2.6 are in [`services/adapter/README.md`](../../../services/adapter/README.md).
