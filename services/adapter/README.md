# ScienceDiscovery adapter

Python front door for the JiuwenSwarm migration (issue 84). It owns the public
port and proxies every route it has not migrated to the legacy TypeScript API.

## Direction taken

The legacy API keeps owning sessions, messages, run events and permission
records. Only the **agent executor** is swapped: the legacy `createAgent` seam
(`AgentRunBindings.createAgent`) will call the adapter, and the adapter drives a
run through the JiuwenSwarm gateway. The tools a run needs (`run_shell`,
`declare_artifact`, ...) are the same per-run closures the native agent uses; the
adapter exposes them to JiuwenSwarm as an MCP server and forwards each call back.

## What was measured on JiuwenSwarm 0.2.6 (not inferred)

Frames are recorded in `tests/fixtures/jw_*.raw`; `tests/stub_llm.py` scripts the
model so a run is reproducible.

- Chat: `chat.send` on the gateway (`/tui`). Reply is `res accepted`, then
  `chat.processing_status`, `chat.delta`*, `chat.final`.
- A run ends with `chat.processing_status` `is_complete`, **not** `chat.final`
  (an approval pause emits an empty `chat.final` and carries on).
- Tools: `chat.tool_call` / `chat.tool_update` / `chat.tool_result`. The result is
  a Python repr string (`success=True data={...} error=None ...`), not JSON.
- Approval: an empty-error `tool_result` with no prior `tool_call`, then
  `chat.ask_user_question` (`source: permission_interrupt`, `request_id` = tool call
  id). Options are positional (once, session, forever, deny) and labelled in the UI
  language. The answer is a second `chat.send` on the same connection carrying
  `request_id`, `answers`, `source`. After a denial the tool result is the bare
  option label.
- Cancel: `chat.interrupt` (`intent: cancel`, not streamed) gets a `res`; the run then
  just ends. No `chat.interrupt_result` arrives on the run's stream.
- MCP: management RPCs (`mcp.register_custom`, `mcp.connect`) are served on the web
  channel (`ws://<host>:<web port>/ws`), not `/tui`. A run reaches a server only when
  `chat.send` carries `"mcp": ["<name>"]`. Its tools are *deferred*: the model finds
  them with `tool_search` and calls them through `tool_call`, which the gateway
  reports as an outer `tool_call` plus an inner `<id>:target` call. The tool is named
  `mcp_<server>_<tool>`.
- `permissions.enabled` is off by default. With `tools.bash: ask`, `echo`/`pwd` are
  still auto-allowed (read-only allowlist); `touch` is not.

## Tests

    UV_PROJECT_ENVIRONMENT=/tmp/adapter-venv uv sync --extra test
    /tmp/adapter-venv/bin/python -m pytest

`tests/test_gateway_live.py` talks to a real gateway and is skipped unless
`JIUWENSWARM_GATEWAY_URL` is set; see its docstring for the scenarios.
