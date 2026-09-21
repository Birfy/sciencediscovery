# JiuwenSwarm migration: status and hand-over

Where issue 84 (reuse the JiuwenSwarm backend) stands, what runs today, what does not, and how to start
working on a sub-issue. To run it, see [Run agent turns on JiuwenSwarm](../how-to/run-with-jiuwenswarm.md).

## What this baseline is

A **transitional architecture**, chosen deliberately: the existing TypeScript API keeps owning storage
(sessions, messages, run events, permission records) and every route the UI calls. Only the **agent
executor** is replaced: the model loop runs on JiuwenSwarm 0.2.6, reached through a Python **adapter**
that also sits in front of the API as a reverse proxy.

```
browser ─▶ adapter :4310 ──proxy──▶ legacy API :4410 ──createAgent──┐
              │  ▲                                                   │ POST /agent/runs
              │  └────── tool calls (loopback bridge, per run) ◀─────┤
              ▼
        JiuwenSwarm gateway ─▶ model, through /llm/<token>/v1 (adapter)
              └── MCP tools ─▶ /mcp/<token> (adapter, forwards to the bridge)
```

This is **not** the end state written in the issue body (routes served by the adapter on top of
JiuwenSwarm's own storage). Each sub-issue below says how much of its end state is still open. Whether the
acceptance criteria that assume the end state should be rewritten for this architecture is an open
decision for the issue owners.

Design and measured protocol facts: [`services/adapter/README.md`](../../../services/adapter/README.md).

## Status by sub-issue

| Issue | State | What exists | What does not |
|---|---|---|---|
| 86 Acceptance baseline, protocol calibration | closed | Interface inventory (259 rows), L1/L2 tooling, 21 recorded cases on Linux, protocol experiments, `CI_E2E_BACKEND=jiuwenswarm` | Cases for 125 rows; the 59 "approximate" mappings were not calibrated; `AgentRuntime` not evaluated |
| 87 Adapter core | closed | Public port, streaming proxy (SSE, NDJSON), 502 on upstream failure, optional token on `/agent/*` | Own storage, run registry, event log and resume: they stay in the legacy API |
| 88 Sessions and projects | closed | Served by the legacy API through the proxy; L1 covers all 13 rows | Nothing moves to JiuwenSwarm's session store |
| 89 Chat and runs | closed | A run executes on JiuwenSwarm; events, cancel, approval, usage, disconnect handling; L2 golden traces for 8 scenarios | See "Known gaps" |
| 90 Permissions | open | Approval requests, allow/deny, grants, audit and epoch behave as before (L1 8/8, L2 approve/deny) | Not mapped to JiuwenSwarm's permission engine (left off); one open finding, below |
| 91 Models, providers, settings | open | Model list, defaults and settings served by legacy (L1 covered); the selected model is handed to JiuwenSwarm per run | Only OpenAI chat-completions models run; Anthropic and Responses fail with a clear message |
| 92 MCP and data sources | open | Legacy MCP servers are part of the toolset the run sees | 0/21 L1 cases; the custom-MCP, OAuth and secret-edit journeys are not verified on this executor |
| 93 Skills and libraries | open | Served by legacy | 0/35 L1 cases; skill use on this executor is not verified |
| 94 Files, workspace, trajectory | open | Read routes have L1 cases | Trajectory view is empty for JiuwenSwarm runs (no `evidence` recorded) |
| 95 Planning and sub-agents | open | `update_plan` and `task` run through the bridge; M0 plan and delegate journeys pass | Subagent resume gets no earlier history |
| 97 Science toolset as MCP | open | The equivalent toolset is offered as MCP tools that call the legacy tools over the bridge, through the same ToolRegistry | `packages/tools` not inventoried one by one; deferred loading (`tool_search`) and parallel calls not verified |
| 103 Usage | open | Per-model-call token counts become `model.usage` and are summed | Not checked in the usage page; cross-session statistics not done |
| 93, 94, 96, 98-102, 104-106 | open | Unchanged legacy behaviour behind the proxy | Everything: not started as migrations. Runner/environment/remote-host reads have L1 cases |

## Verified

On the Aliyun Linux server (bubblewrap sandbox) with `SCIENCE_AGENT_ADAPTER=1 SCIENCE_AGENT_EXECUTOR=jiuwenswarm`:

- The five milestone-0 journeys (first run, compact process ×2, plan workspace, delegate subtask, deliver result) pass.
- One journey against a live OpenAI-compatible model passes (`journey-real-request`).
- L2: 8 run-event scenarios have the same event-type sequence as the built-in loop. Accepted differences are in
  `test/contract/accepted-differences.json` (the wording of a provider 401, and the evidence gap).
- L1: the recorded cases match between the built-in loop and the adapter + JiuwenSwarm stack, apart from build version strings, which are scrubbed.
- Unit tests: adapter (`pytest`, about 108) and the TypeScript agent factory (20).

## Known gaps

1. **No evidence or trajectory.** Runs on JiuwenSwarm produce no `agent.record`/`evidence` events, so the trajectory view is empty.
2. **No history carried in.** JiuwenSwarm keeps history per session; `gatewayHistory` from the API is unused, so a session started on the built-in loop does not continue on JiuwenSwarm, and legacy compaction is not applied.
3. **OpenAI chat-completions only.**
4. **No tool-output store, deferred tools or parallel tool calls** in the JiuwenSwarm toolset.
5. **Wake notices.** The mocked E2E `issue-77-wake-notice` fails on this executor (the scripted model recognises the wake turn by a prompt JiuwenSwarm does not present that way). `issue-85` passes. Run the group with `CI_E2E_BACKEND=jiuwenswarm .ci/run-e2e.sh mocked`; other specs have not been run through it.
6. **Legacy bugs found while recording (not fixed):** `PUT /api/sessions/:id/settings` with a bad body returns 500; `PUT /api/web/settings` with its own GET body returns 500; skill evolution on an unknown run returns 500; reading a file outside the workspace (`/file?path=../../etc/passwd`) returns 500 instead of 4xx.
7. **Finding for #90:** after `POST /api/sessions/:id/permission-epoch`, a session-scoped grant still applies (the epoch concerns the sandbox, the grant the session). The issue text expects old authorizations to become invalid; the baseline records what legacy does.

## Start working on a sub-issue

1. Install and start JiuwenSwarm, then the stack: see the [how-to](../how-to/run-with-jiuwenswarm.md).
2. Find your routes in `test/contract/routes.json` (`node test/contract/run.mjs --coverage` lists the rows without a case).
3. Add a case under `test/contract/cases/`, record it on a **fresh data directory** against the built-in loop, compare it against the adapter + JiuwenSwarm stack. Rules, the SSE step form and normalization: [`test/contract/README.md`](../../../test/contract/README.md). Baselines are read-only for agents; a change needs human review.
4. For behaviour, use the run-event cases (`l2-runs.json`); the stub model is `test/contract/stub-model.mjs`.
5. Browser journeys: `CI_E2E_BACKEND=jiuwenswarm .ci/run-e2e.sh mocked` (gateway must be running).

## Tests

```bash
UV_PROJECT_ENVIRONMENT=/tmp/adapter-venv uv sync --extra test --project services/adapter
/tmp/adapter-venv/bin/python -m pytest services/adapter          # adapter unit tests
cd services/api && pnpm build && node --test dist/agent-run/jiuwenswarm-agent.test.js
node --test test/contract/*.test.mjs                              # tooling of the contract tests
E2E_BASE_URL=... E2E_API_TOKEN=... node test/contract/run.mjs --compare test/contract/baselines/legacy-linux.json
```
