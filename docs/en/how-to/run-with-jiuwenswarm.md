# Run agent turns on JiuwenSwarm

ScienceDiscovery can run its agent loop on [JiuwenSwarm](https://gitcode.com/openJiuwen/jiuwenswarm) instead of the built-in loop. This is an **optional, experimental** executor introduced by the JiuwenSwarm migration (issue 84). The built-in loop remains the default and nothing changes unless you turn this on.

What stays the same: the web UI, sessions, messages, run events, permission requests, the Runner and its sandbox, artifacts and provenance. Tools still run inside the ScienceDiscovery API process, so every permission check and Runner rule applies as before. What moves: the model loop and its conversation context.

```
browser ─▶ adapter (public port) ─▶ legacy API (port + 100)
              │                          │
              └─▶ JiuwenSwarm ◀──────────┘   tools run in the API, called back over a per-run bridge
```

## Requirements

- Source mode (see [Deployment](deployment.md#local-mode-host-processes)); the binary and Docker images do not include this executor yet.
- `git` and `uv` on the host. JiuwenSwarm installs into its own directory and virtualenv, never into ScienceDiscovery's environments.
- Access to `gitcode.com` (to clone the pinned tag) and to a PyPI index. On a slow link or in mainland China, set `SCIENCE_AGENT_PYPI_INDEX` to a mirror and, if downloads time out, `UV_HTTP_TIMEOUT` (the script defaults to 300 seconds).
- A model endpoint that speaks the **OpenAI chat-completions** protocol. Anthropic Messages and OpenAI Responses models fail the run with a clear message; use the built-in loop for those.
- About 1.5 GB of disk for the JiuwenSwarm install.

## 1. Install and start JiuwenSwarm

```bash
scripts/jiuwenswarm.sh setup     # clone the pinned tag (workswarm0.2.6), install it, create the instance
scripts/jiuwenswarm.sh start     # start it and wait for its gateway
scripts/jiuwenswarm.sh status
```

`setup` is idempotent and applies the one JiuwenSwarm setting ScienceDiscovery depends on: `progressive_tool_enabled: false` in the instance's `config/config.yaml`. With JiuwenSwarm's default (`true`) the tools of a run are hidden behind a search step, and the model would no longer see them by the names ScienceDiscovery defined.

JiuwenSwarm creates its instance workspace under `~/.jiuwenswarm-instances/<name>` (it has no option to move it). The instance is named `sciencediscovery` and gets its own ports, so it does not collide with a default JiuwenSwarm on the same host.

| Variable | Default | Meaning |
|---|---|---|
| `JIUWENSWARM_TAG` | `workswarm0.2.6` | Version to install. Only 0.2.6 has been validated. |
| `JIUWENSWARM_ROOT` | `.sciencediscovery-data/jiuwenswarm` | Install directory |
| `JIUWENSWARM_INSTANCE` | `sciencediscovery` | Instance name |
| `JIUWENSWARM_GIT_URL` | `https://gitcode.com/openJiuwen/jiuwenswarm.git` | Clone source |

You do not configure a model in JiuwenSwarm. The model you choose in ScienceDiscovery is handed to JiuwenSwarm for each run.

## 2. Start ScienceDiscovery with the executor

```bash
SCIENCE_AGENT_ADAPTER=1 SCIENCE_AGENT_EXECUTOR=jiuwenswarm ./scripts/start-stack.sh --mode local
```

`start-stack.sh` finds the JiuwenSwarm instance through `scripts/jiuwenswarm.sh env` and refuses to start with a clear message if the instance is not reachable or the adapter is not enabled. Set `JIUWENSWARM_GATEWAY_URL` and `JIUWENSWARM_MGMT_URL` yourself to point at a JiuwenSwarm the script does not manage.

With the adapter on, the adapter takes the public port (default 4310) and the legacy API moves to the public port plus 100. Open the same URL as before. To go back, start without these two variables.

## What to expect

- The same conversations, tool cards, permission prompts, plans, subagents and artifacts as with the built-in loop; the milestone-0 journeys pass on this executor.
- Conversation history is kept by JiuwenSwarm per session. Sessions that already have history from the built-in loop do **not** carry it over when you switch, and a subagent that is resumed does not receive its earlier history.
- Adding a model makes JiuwenSwarm send one small probe request to it (to detect image input).
- Token usage is reported per model call, including reasoning tokens.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `start-stack.sh` says JiuwenSwarm is not reachable | Run `scripts/jiuwenswarm.sh start`, then `scripts/jiuwenswarm.sh status`. Logs: `.sciencediscovery-data/jiuwenswarm/jiuwenswarm.log` and `~/.jiuwenswarm-instances/<name>/agent/.logs/`. |
| Run fails with `... protocol is not supported by this executor yet` | The selected model uses Anthropic Messages or OpenAI Responses. Choose an OpenAI chat-completions model or start without `SCIENCE_AGENT_EXECUTOR`. |
| The model never calls a tool | Check `progressive_tool_enabled: false` in the instance config; `scripts/jiuwenswarm.sh setup` restores it. |
| A provider answers `403` only through the executor | Some gateways filter by `User-Agent`. Test the endpoint with `curl` and the same key; report the response body. |
| To see what a run did | `SCIENCE_AGENT_ADAPTER_DEBUG=1` (tool events, adapter) and `SCIENCE_AGENT_JIUWENSWARM_DEBUG=1` (tool calls, API) print them to the stack log. |

Design notes and the protocol facts measured against JiuwenSwarm 0.2.6 are in [`services/adapter/README.md`](../../../services/adapter/README.md).
