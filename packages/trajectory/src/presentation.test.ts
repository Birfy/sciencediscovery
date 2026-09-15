// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { test } from "node:test";
import { contentSections, internalEntry, recordGroups } from "./presentation.js";
import type { TrajectoryEntry, TrajectoryIndex, TrajectoryKind } from "./index.js";

const entry = (values: Partial<TrajectoryEntry> = {}): TrajectoryEntry => ({ id: "e", agentId: "main:s", kind: "lifecycle", label: "event", timestamp: null, ...values });
const sections = (kind: TrajectoryKind, value: unknown) => contentSections({ entry: entry({ kind }), value }, true);

test("hide only known bookkeeping; failures, waiting, recovery and unknown events remain visible", () => {
  for (const eventType of ["turn_start", "response_start", "response_settled", "model_usage"]) assert.equal(internalEntry(entry({ eventType })), true);
  for (const status of ["assembling_context", "calling_model", "executing_tools", "completed"]) assert.equal(internalEntry(entry({ eventType: "state_changed", status })), true);
  for (const status of ["failed", "cancelled", "waiting_external", "future_status", undefined]) assert.equal(internalEntry(entry({ eventType: "state_changed", status })), false);
  for (const eventType of ["context_recovery", "run.failed", "state.committed", "unknown"]) assert.equal(internalEntry(entry({ eventType })), false);
});

test("untimed input belongs to exact invocation; equal turns across runs or retries do not merge", () => {
  const index: TrajectoryIndex = { schemaVersion: 1, sessionId: "s", capturedAt: "now", agents: [], warnings: [], entries: [
    entry({ id: "output-a", contextId: "a", runId: "r1", turn: 0, timestamp: "2026-09-15T10:00:00Z" }),
    entry({ id: "output-b", contextId: "b", runId: "r1", turn: 0 }),
    entry({ id: "output-c", contextId: "c", runId: "r2", turn: 0 }),
  ], untimedEntries: [entry({ id: "input-a", kind: "input", contextId: "a", runId: "r1", turn: 0 })] };
  index.historicalEntries = index.untimedEntries;
  const groups = recordGroups(index);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0]!.entries.map(e => e.id), ["input-a", "output-a"]);
  assert.deepEqual(groups.map(g => g.invocation), [1, 2, 1]);
  assert.equal(groups[0]!.entries[0]!.timestamp, null);
  assert.equal(index.entries[0]!.id, "output-a");
});

test("thinking and model stream packets render only recorded text", () => {
  assert.equal(sections("thinking", { packets: [{ delta: "先分析" }, { event: { delta: "，再核实。" } }] })[0]!.value, "先分析，再核实。");
  assert.deepEqual(sections("thinking", {}), []);
  assert.equal(sections("output", { assistantMessage: { content: "<script>literal</script>" } })[0]!.value, "<script>literal</script>");
  assert.equal(sections("output", { result: { assistantMessage: { content: "结论" }, toolCalls: [{ name: "search" }] } }).length, 2);
});

test("tools parse arguments, retain invalid JSON and show results, MCP payloads and command output", () => {
  assert.deepEqual(sections("tool", { call: { name: "run_shell", args: { command: "printf actual" } } }).map(s => s.value), ["run_shell", { command: "printf actual" }]);
  const tool = sections("tool", { call: { name: "run_shell", arguments: '{"command":"printf ok"}' }, result: { message: { content: "ok" } } });
  assert.deepEqual(tool.map(s => s.value), ["run_shell", { command: "printf ok" }, "ok"]);
  assert.equal(sections("tool", { arguments: "invalid JSON" })[0]!.value, "invalid JSON");
  assert.equal(sections("tool", { type: "tool.output", packets: [{ chunk: "one" }, { chunk: "two" }] })[0]!.value, "onetwo");
  assert.deepEqual(sections("mcp", { payloads: { request: { arguments: { query: "protein" } }, rawResponse: { content: [{ text: "result" }] } } }).map(s => s.value), [{ query: "protein" }, [{ text: "result" }]]);
});

test("input and state summaries use frozen data, not an inferred current state", () => {
  assert.deepEqual(sections("input", { input: { systemPrompt: "rules", history: [{ role: "user", content: "question" }], tools: [] } }).map(s => s.value), ["rules", "question", []]);
  assert.deepEqual(sections("state", { phase: "completed", turn: 2, history: [], checkpoint: { components: [{ id: "plan", revision: "frozen", fidelity: "exact" }] } })[1]!.value, [{ id: "plan", revision: "frozen", fidelity: "exact" }]);
});
