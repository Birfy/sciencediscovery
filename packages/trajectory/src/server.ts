// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { CasStore, RefStore, VersionStore, type AgentStateRef, type TrajectoryStep } from "@sciencediscovery/cas";
import { contextBlocks, eventKind, object, redact, type TrajectoryAgent, type TrajectoryDetail, type TrajectoryEntry, type TrajectoryIndex } from "./index.js";

export interface RecordedEvent { id: string; agentId: string; createdAt: string; runId: string; event: unknown }
export interface SessionTrajectorySource {
  sessionId: string; agents: TrajectoryAgent[]; events: RecordedEvent[];
}
interface Assembly { capturedAt?: string; state: AgentStateRef; modelContext: AgentStateRef; turn: number }
function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/** A read projection over an authorized Session's refs. Never accepts arbitrary client CAS refs. */
export async function openSessionTrajectory(dataDir: string, source: SessionTrajectorySource, signal: AbortSignal) {
  const store = new VersionStore(dataDir), refs = await RefStore.open(store);
  const entries: TrajectoryEntry[] = [], loaders = new Map<string, () => Promise<unknown>>();
  const contexts = new Map<string, { ref: AgentStateRef; assembly: Assembly; agentId: string }>();
  const responses = new Map<string, string>(), calls = new Map<string, { contextId: string; agentId: string } | null>();
  const rememberCall = (id: string, contextId: string, agentId: string) => {
    const previous = calls.get(id);
    // Providers can reuse tool IDs in another run. Such audit joins are
    // ambiguous; retain exact CAS links, but never attach a guessed context.
    calls.set(id, previous === null || previous && previous.contextId !== contextId ? null : { contextId, agentId });
  };
  const warnings = new Set<string>(), agentIds = new Set(source.agents.map(a => a.id));
  const add = (entry: TrajectoryEntry, load: () => Promise<unknown>) => {
    if (loaders.has(entry.id)) return;
    entries.push(entry); loaders.set(entry.id, load);
  };
  const record = async (ref: AgentStateRef, kind?: string) => {
    signal.throwIfAborted(); return (await store.readRecord(ref, kind)).value;
  };
  const addContext = async (agentId: string, ref: AgentStateRef) => {
    const id = `context:${ref.digest}`;
    if (contexts.has(id)) return;
    const assembly = await record(ref, "ContextAssemblyRecord") as Assembly;
    const state = object(await record(assembly.state, "AgentStateSnapshot"));
    if (state.agentId !== agentId) throw new Error("Context ownership mismatch");
    contexts.set(id, { ref, assembly, agentId });
    add({ id, agentId, kind: "input", label: `Model input · turn ${assembly.turn}`, timestamp: timestamp(assembly.capturedAt), turn: assembly.turn, contextId: id }, () => record(assembly.modelContext, "ModelContextSnapshot"));
    add({ id: `before:${ref.digest}`, agentId, kind: "state", label: `State before · turn ${assembly.turn}`, timestamp: timestamp(assembly.capturedAt), turn: assembly.turn, contextId: id }, () => record(assembly.state, "AgentStateSnapshot"));
  };
  const addSegment = async (agentId: string, ref: AgentStateRef) => {
    const segment = object(await record(ref, "EventSegment"));
    const values: unknown[] = Array.isArray(segment.events) ? segment.events : [];
    for (let i = 0; i < values.length; i++) {
      let value = values[i];
      const event = object(value), contextRef = event.contextRef as AgentStateRef | undefined;
      const first = i;
      let endTime: string | null = null;
      // Token packets are retained in the detail, but one contiguous response
      // channel becomes one interval rather than thousands of overlapping buttons.
      if (event.type === "model_delta") {
        const packets = [event];
        while (i + 1 < values.length) {
          const next = object(values[i + 1]);
          if (next.type !== event.type || next.kind !== event.kind || next.responseId !== event.responseId || object(next.contextRef).digest !== contextRef?.digest) break;
          packets.push(next); i++;
        }
        endTime = timestamp(packets.at(-1)!.recordedAt);
        value = { ...event, delta: packets.map(p => String(p.delta ?? "")).join(""), packets };
      } else if (event.type === "tool_execution_start") {
        const finish = values.map(object).find(e => e.type === "tool_execution_end" && object(e.call).id === object(event.call).id);
        endTime = timestamp(finish?.recordedAt);
      }
      // Older segments have no exact attempt association. Do not guess from wall time.
      if (contextRef) await addContext(agentId, contextRef);
      if (contextRef && typeof event.responseId === "string") responses.set(`${agentId}:${event.responseId}`, `context:${contextRef.digest}`);
      if (contextRef && typeof object(event.call).id === "string") rememberCall(String(object(event.call).id), `context:${contextRef.digest}`, agentId);
      add({ id: `segment:${ref.digest}:${first}`, agentId, kind: eventKind(event), label: String(event.type),
        timestamp: timestamp(event.recordedAt), ...(endTime ? { endTime } : {}), ...(contextRef ? { contextId: `context:${contextRef.digest}` } : {}) }, async () => value);
    }
  };
  try {
    // Freeze published step heads before reading payloads. Later appends appear on Refresh.
    const scopes = source.agents.map(agent => ({ agent, steps: refs.history(`agents/${encodeURIComponent(agent.id)}/head`),
      starts: refs.list(`agents/${encodeURIComponent(agent.id)}/trajectories/`) }));
    for (const { agent, steps, starts } of scopes) {
      const trajectories = new Set(starts.map(start => decodeURIComponent(start.name.split("/").at(-1)!)));
      for (const ref of steps) {
        signal.throwIfAborted();
        try {
          const step = await record(ref, "TrajectoryStep") as TrajectoryStep;
          if (step.agentId !== agent.id) throw new Error("Step ownership mismatch");
          trajectories.add(step.trajectoryId);
          await addContext(agent.id, step.context);
          for (const segment of step.eventSegments) await addSegment(agent.id, segment.events);
          const contextId = `context:${step.context.digest}`;
          add({ id: `after:${ref.digest}`, agentId: agent.id, kind: "state", label: `State after · turn ${step.turn}`, timestamp: timestamp(step.finishedAt), turn: step.turn, contextId }, () => record(step.after, "AgentStateSnapshot"));
          for (const [i, action] of step.actions.entries()) {
            const payload = object(await record(action)), call = object(payload.call);
            if (typeof call.id === "string") rememberCall(call.id, contextId, agent.id);
            add({ id: `action:${ref.digest}:${i}`, agentId: agent.id, kind: i === 0 ? "output" : eventKind({ type: "tool", call }), label: `${i === 0 ? "Model result" : String(call.name ?? "Tool result")} · turn ${step.turn}`, timestamp: timestamp(step.finishedAt), turn: step.turn, contextId }, async () => payload);
          }
        } catch (error) {
          signal.throwIfAborted();
          warnings.add(`Some committed records for ${agent.label} are missing or invalid; this view is incomplete.`);
        }
      }
      // Includes failed/cancelled model attempts and overflow retries, not just completed turns.
      for (const trajectory of trajectories) {
        for (const segment of refs.list(`trajectory-events/${encodeURIComponent(trajectory)}/`)) {
          try { await addSegment(agent.id, segment.target); }
          catch { signal.throwIfAborted(); warnings.add(`Some event segments for ${agent.label} cannot be read.`); }
        }
        for (const attempt of refs.list(`attempts/${encodeURIComponent(trajectory)}/`)) {
          for (const ref of refs.history(attempt.name)) {
            try { await addContext(agent.id, ref); }
            catch { signal.throwIfAborted(); warnings.add(`Some model attempts for ${agent.label} cannot be read.`); }
          }
        }
      }
    }
  } finally { refs.close(); }
  for (let i = 0; i < source.events.length; i++) {
    const item = source.events[i]!;
    if (!agentIds.has(item.agentId)) continue;
    const event = object(item.event), step = object(event.step);
    let payload: unknown = item.event, endTime = timestamp(event.finishedAt);
    if (["assistant.delta", "assistant.thinking.delta", "tool.output"].includes(String(event.type))) {
      const packets = [item];
      while (i + 1 < source.events.length) {
        const next = source.events[i + 1]!, nextEvent = object(next.event);
        if (next.agentId !== item.agentId || next.runId !== item.runId || nextEvent.type !== event.type || nextEvent.responseId !== event.responseId || nextEvent.toolCallId !== event.toolCallId) break;
        packets.push(next); i++;
      }
      payload = { ...event, packets };
      endTime = timestamp(packets.at(-1)!.createdAt);
    }
    const trace = object(event.trace ?? step.toolTrace);
    const call = calls.get(String(event.toolCallId ?? trace.id ?? trace.toolCallId ?? step.toolCallId ?? ""));
    const contextId = call?.contextId ?? responses.get(`${item.agentId}:${String(event.responseId)}`);
    add({ id: `event:${item.id}`, agentId: call?.agentId ?? item.agentId, kind: eventKind(event),
      ...(contextId ? { contextId } : {}),
      label: String(event.toolId ?? trace.name ?? trace.tool ?? step.toolName ?? step.kind ?? event.type ?? "event"), timestamp: timestamp(item.createdAt),
      ...(endTime ? { endTime } : {}), runId: item.runId }, async () => payload);
  }
  entries.sort((a, b) => (a.timestamp ?? "~").localeCompare(b.timestamp ?? "~") || a.id.localeCompare(b.id));
  // Unknown historical timestamps are never invented or placed at the start of a run.
  if (entries.some(e => e.timestamp === null)) warnings.add("Historical records without timestamps are listed separately; their positions on the real-time axis are unknown.");
  if (source.events.length && !contexts.size) warnings.add("No recorded model contexts are available for this Session.");
  const index: TrajectoryIndex = { schemaVersion: 1, sessionId: source.sessionId, capturedAt: new Date().toISOString(), agents: source.agents, entries, warnings: [...warnings] };
  async function detail(id: string): Promise<TrajectoryDetail | undefined> {
    signal.throwIfAborted();
    const entry = entries.find(e => e.id === id), load = loaders.get(id);
    if (!entry || !load) return undefined;
    const result: TrajectoryDetail = { entry, value: redact(await load()) };
    if (entry.kind === "mcp" && object(result.value).type === "mcp.invocation") {
      const invocation = object(result.value), payloads: Record<string, unknown> = {};
      for (const key of ["request", "rawResponse", "normalizedResult"]) {
        const hash = object(invocation[key]).hash;
        if (typeof hash !== "string") continue;
        try {
          const bytes = await new CasStore(dataDir).read(hash);
          let value: unknown = bytes.toString("utf8");
          try { value = JSON.parse(value as string); } catch { /* non-JSON audit content */ }
          payloads[key] = redact(value);
        } catch { signal.throwIfAborted(); payloads[key] = { unavailable: "Audit payload missing or invalid" }; }
      }
      result.value = { ...invocation, payloads };
    }
    const context = entry.contextId ? contexts.get(entry.contextId) : undefined;
    if (context) {
      const input = redact(object(await record(context.assembly.modelContext, "ModelContextSnapshot")).input);
      const assembly = redact(await record(context.ref, "ContextAssemblyRecord"));
      result.context = { input, assembly, state: redact(await record(context.assembly.state, "AgentStateSnapshot")), blocks: contextBlocks(input, assembly) };
    }
    return result;
  }
  async function* exportRecords() {
    yield JSON.stringify({ type: "trajectory", ...index }) + "\n";
    for (const entry of entries) {
      signal.throwIfAborted();
      // Each line is self-contained; an interrupted HTTP transfer lacks the final completion marker.
      yield JSON.stringify({ type: "entry", ...await detail(entry.id) }) + "\n";
    }
    yield JSON.stringify({ type: "complete", entries: entries.length, capturedAt: index.capturedAt }) + "\n";
  }
  return { index, detail, exportRecords };
}
