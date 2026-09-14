// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasStore, RefStore, VersionStore } from "@sciencediscovery/cas";
import { contextBlocks, eventKind, redact } from "./index.js";
import { openSessionTrajectory } from "./server.js";

test("exact admitted system sections preserve order and separators, not rejected proposals", () => {
  const input = { systemPrompt: "rules\nscience", history: [{ role: "user", content: "question" }], tools: [{ name: "search" }] };
  const assembly = { trace: { used: "dynamic", admitted: { sections: [
    { id: "science", content: "science", contributorId: "skill", slot: "capabilities" },
    { id: "rules", content: "rules", contributorId: "governance", slot: "governance" },
  ] }, rendered: { sectionIds: ["rules", "science"] } } };
  const blocks = contextBlocks(input, assembly);
  assert.deepEqual(blocks.slice(0, 2).map(b => b.source), ["governance", "skill"]);
  assert.equal(blocks.slice(0, 2).map(b => b.content).join(""), input.systemPrompt);
  assert.equal(blocks[2]!.attribution, "unavailable");
  assert.equal(contextBlocks({ ...input, systemPrompt: "fallback" }, assembly)[0]!.attribution, "unavailable");
});
test("classification and structured credential redaction", () => {
  assert.equal(eventKind({ type: "model_delta", kind: "thinking" }), "thinking");
  assert.equal(eventKind({ type: "subagent.step", step: { kind: "tool" } }), "tool");
  assert.equal(eventKind({ type: "mcp.invocation" }), "mcp");
  assert.deepEqual(redact({ authorization: "secret", nested: [{ api_key: "secret", answer: "hello" }] }), { authorization: "[REDACTED]", nested: [{ api_key: "[REDACTED]", answer: "hello" }] });
});
test("failed attempts remain inspectable, scoped, immutable and self-contained in NDJSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trajectory-"));
  const store = new VersionStore(directory), refs = await RefStore.open(store);
  const agentId = "main:session", trajectoryId = "attempt";
  try {
    const state = await store.putRecord("AgentStateSnapshot", { agentId, checkpoint: { revision: "frozen" } });
    const modelContext = await store.putRecord("ModelContextSnapshot", { input: { systemPrompt: "exact", history: [], tools: [] } });
    const assembly = await store.putRecord("ContextAssemblyRecord", { state, modelContext, turn: 0, capturedAt: "2026-09-14T10:00:00.000Z" });
    const start = await store.putRecord("TrajectoryStart", { state });
    await refs.commit(store, `agents/${encodeURIComponent(agentId)}/trajectories/${trajectoryId}`, null, start);
    await refs.commit(store, `attempts/${trajectoryId}/0`, null, assembly);
    const segment = await store.putRecord("EventSegment", { stream: agentId, events: [{ type: "model_delta", kind: "thinking", delta: "returned reasoning", recordedAt: "2026-09-14T10:00:01.000Z", contextRef: assembly }] });
    await refs.commit(store, `trajectory-events/${trajectoryId}/main`, null, segment);
    const view = await openSessionTrajectory(directory, { sessionId: "session", agents: [{ id: agentId, label: "Main" }], events: [
      { id: "foreign", agentId: "main:another-session", createdAt: "2026-09-14T10:00:00Z", runId: "r", event: { type: "assistant.delta", delta: "private" } },
    ] }, new AbortController().signal);
    assert.equal(view.index.entries.length, 3);
    const thinking = view.index.entries.find(e => e.kind === "thinking")!;
    assert.equal(thinking.timestamp, "2026-09-14T10:00:01.000Z");
    assert.deepEqual((await view.detail(thinking.id))!.context!.input, { systemPrompt: "exact", history: [], tools: [] });
    assert.equal(await view.detail(`context:sha256:${"0".repeat(64)}`), undefined);
    assert.equal(refs.head(`agents/${encodeURIComponent(agentId)}/head`), null);
    const lines: unknown[] = [];
    for await (const line of view.exportRecords()) lines.push(JSON.parse(line));
    assert.equal((lines.at(-1) as { type: string }).type, "complete");
    assert.equal(JSON.stringify(lines).includes("private"), false);
    const other = await openSessionTrajectory(directory, { sessionId: "other", agents: [{ id: "main:other", label: "Other" }], events: [] }, new AbortController().signal);
    assert.equal(other.index.entries.length, 0);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(openSessionTrajectory(directory, { sessionId: "session", agents: [{ id: agentId, label: "Main" }], events: [] }, controller.signal));
  } finally { refs.close(); await rm(directory, { recursive: true, force: true }); }
});

test("historical timestamps remain unknown instead of a fabricated timeline position", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trajectory-legacy-"));
  try {
    const view = await openSessionTrajectory(directory, { sessionId: "s", agents: [{ id: "main:s", label: "Main" }], events: [
      { id: "old", agentId: "main:s", createdAt: "", runId: "r", event: { type: "run.started" } },
    ] }, new AbortController().signal);
    assert.equal(view.index.entries[0]!.timestamp, null);
    assert.ok(view.index.warnings.some(w => w.includes("timestamps")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("MCP audit detail resolves owned payloads and redacts credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trajectory-mcp-"));
  try {
    const cas = new CasStore(directory);
    const request = await cas.put(JSON.stringify({ arguments: { query: "protein" }, authorization: "private-token" }));
    const rawResponse = await cas.put(JSON.stringify({ content: [{ text: "observed result" }] }));
    const view = await openSessionTrajectory(directory, { sessionId: "s", agents: [{ id: "main:s", label: "Main" }], events: [
      { id: "audit", agentId: "main:s", createdAt: "2026-09-14T10:00:00Z", runId: "r", event: { type: "mcp.invocation", request, rawResponse } },
    ] }, new AbortController().signal);
    const detail = await view.detail("event:audit");
    assert.match(JSON.stringify(detail), /observed result/);
    assert.match(JSON.stringify(detail), /protein/);
    assert.doesNotMatch(JSON.stringify(detail), /private-token/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
