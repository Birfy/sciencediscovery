// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { CasStore, RefStore, VersionStore, type AgentStateRef, type TrajectoryStep } from "@sciencediscovery/cas";
import { contextBlocks, eventKind, object, redact, type TrajectoryAgent, type TrajectoryDetail, type TrajectoryEntry, type TrajectoryIndex } from "./index.js";
import { readAgentJournal, type JournalEvent } from "./journal.js";

export interface RecordedEvent { id: string; agentId: string; createdAt: string; runId: string; event: unknown; streamId?: string; sequence?: number }
export interface SessionTrajectorySource {
  sessionId: string; agents: TrajectoryAgent[]; events: RecordedEvent[];
}
interface Assembly { capturedAt?: string; state: AgentStateRef; modelContext: AgentStateRef; turn: number }
function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/** A read projection over an authorized Session's refs. Never accepts arbitrary client CAS refs. */
export async function openSessionTrajectory(dataDir: string, source: SessionTrajectorySource, signal: AbortSignal) {
  const store = new VersionStore(dataDir);
  const entries: TrajectoryEntry[] = [], historicalEntries: TrajectoryEntry[] = [], loaders = new Map<string, () => Promise<unknown>>();
  const states = new Map<string, AgentStateRef>(), linkedContexts = new Set<string>();
  const journal: JournalEvent[] = [], journalRuns = new Set<string>(), coveredExecutions = new Set<string>();
  const contexts = new Map<string, { ref: AgentStateRef; assembly: Assembly; agentId: string }>();
  const responses = new Map<string, string>(), calls = new Map<string, { contextId: string; agentId: string } | null>();
  const rememberCall = (id: string, contextId: string, agentId: string) => {
    const previous = calls.get(id);
    // Providers can reuse tool IDs in another run. Such audit joins are
    // ambiguous; retain exact CAS links, but never attach a guessed context.
    calls.set(id, previous === null || previous && previous.contextId !== contextId ? null : { contextId, agentId });
  };
  const warnings = new Set<string>(), agentIds = new Set(source.agents.map(a => a.id));
  for (const agent of source.agents) {
    const result = await readAgentJournal(dataDir, agent.id, signal);
    result.warnings.forEach(w => warnings.add(w));
    for (const event of result.events) {
      journal.push(event); journalRuns.add(`${agent.id}:${event.runId}`);
      coveredExecutions.add(`${agent.id}:${agent.parentRunId ?? event.requestExecutionId}`);
      if (event.contextRef) linkedContexts.add(`context:${event.contextRef.digest}`);
    }
  }
  const add = (entry: TrajectoryEntry, load: () => Promise<unknown>) => {
    if (loaders.has(entry.id)) return;
    (entry.timestamp ? entries : historicalEntries).push(entry); loaders.set(entry.id, load);
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
    // A snapshot is not an event, even if an old producer embedded a timestamp.
    const runId = typeof state.trajectoryId === "string" ? state.trajectoryId : undefined;
    add({ id: `before:${ref.digest}`, agentId, runId, kind: "state", label: `State before · turn ${assembly.turn}`, timestamp: null, turn: assembly.turn, contextId: id }, () => record(assembly.state, "AgentStateSnapshot"));
    add({ id, agentId, runId, kind: "input", label: `Model input · turn ${assembly.turn}`, timestamp: null, turn: assembly.turn, contextId: id }, () => record(assembly.modelContext, "ModelContextSnapshot"));
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
      if (contextRef) { await addContext(agentId, contextRef); linkedContexts.add(`context:${contextRef.digest}`); }
      if (contextRef && typeof event.responseId === "string") responses.set(`${agentId}:${event.responseId}`, `context:${contextRef.digest}`);
      if (contextRef && typeof object(event.call).id === "string") rememberCall(String(object(event.call).id), `context:${contextRef.digest}`, agentId);
      add({ id: `segment:${ref.digest}:${first}`, agentId, streamId: `segment:${ref.digest}`, sequence: first, kind: eventKind(event), label: String(event.type),
        timestamp: timestamp(event.recordedAt), ...(endTime ? { endTime } : {}), ...(contextRef ? { contextId: `context:${contextRef.digest}` } : {}) }, async () => value);
    }
  };
  const refs = await RefStore.open(store);
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
          if (journalRuns.has(`${agent.id}:${step.trajectoryId}`)) continue;
          for (const [i, action] of step.actions.entries()) {
            const payload = object(await record(action)), call = object(payload.call);
            if (typeof call.id === "string") rememberCall(call.id, contextId, agent.id);
            add({ id: `action:${ref.digest}:${i}`, agentId: agent.id, runId: step.trajectoryId, kind: i === 0 ? "output" : eventKind({ type: "tool", call }), label: `${i === 0 ? "Model result" : String(call.name ?? "Tool result")} · turn ${step.turn}`, timestamp: null, turn: step.turn, contextId }, async () => payload);
          }
          add({ id: `after:${ref.digest}`, agentId: agent.id, runId: step.trajectoryId, kind: "state", label: `State after · turn ${step.turn}`, timestamp: null, turn: step.turn, contextId }, () => record(step.after, "AgentStateSnapshot"));
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
  for (let i = 0; i < journal.length; i++) {
    const event = journal[i]!, contextId = event.contextRef ? `context:${event.contextRef.digest}` : undefined;
    if (event.contextRef) {
      try { await addContext(event.agentId, event.contextRef); }
      catch { signal.throwIfAborted(); warnings.add("A journal context is missing or invalid; the event remains available."); }
    }
    const packets = [event];
    if (event.type === "model_delta") {
      while (i + 1 < journal.length) {
        const next = journal[i + 1]!;
        if (next.agentId !== event.agentId || next.runId !== event.runId || next.type !== event.type || next.kind !== event.kind
          || next.responseId !== event.responseId || next.contextRef?.digest !== event.contextRef?.digest || next.sequence !== packets.at(-1)!.sequence + 1) break;
        packets.push(next); i++;
      }
    }
    const finish = event.type === "tool_execution_start" ? journal.find(e => e.agentId === event.agentId && e.runId === event.runId
      && e.type === "tool_execution_end" && e.callId === event.callId && e.sequence > event.sequence && e.contextRef?.digest === event.contextRef?.digest) : undefined;
    const id = `journal:${event.agentId}:${event.runId}:${event.sequence}`;
    if (event.stateRef) states.set(id, event.stateRef);
    add({ id, agentId: event.agentId, runId: event.runId, requestExecutionId: event.requestExecutionId,
      streamId: "journal", sequence: event.sequence, turn: event.turn, contextId,
      kind: eventKind(event), label: event.type, timestamp: timestamp(event.recordedAt),
      ...(finish ? { endTime: finish.recordedAt } : packets.length > 1 ? { endTime: packets.at(-1)!.recordedAt } : {}),
    }, async () => {
      const values = await Promise.all(packets.map(p => record(p.payloadRef, "TrajectoryEventPayload")));
      return { ...object(values[0]), ...event, ...(packets.length > 1 ? { packets: values } : {}) };
    });
    if (event.callId && contextId) {
      const requestId = source.agents.find(a => a.id === event.agentId)?.parentRunId ?? event.requestExecutionId;
      rememberCall(`${event.agentId}:${requestId}:${event.callId}`, contextId, event.agentId);
    }
  }
  for (let i = 0; i < source.events.length; i++) {
    const item = source.events[i]!;
    if (!agentIds.has(item.agentId)) continue;
    const event = object(item.event), step = object(event.step);
    // Chat projections of recorded model/tool events are not a second timeline.
    // Command output, MCP audit and product-side events retain their own entries.
    if (coveredExecutions.has(`${item.agentId}:${item.runId}`) &&
      !/^(tool\.output|mcp\.|artifact\.|workspace\.|permission\.)/.test(String(event.type))) continue;
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
    const callId = String(event.toolCallId ?? trace.id ?? trace.toolCallId ?? step.toolCallId ?? "");
    const scopedCall = `${item.agentId}:${item.runId}:${callId}`;
    const call = calls.has(scopedCall) ? calls.get(scopedCall) : coveredExecutions.has(`${item.agentId}:${item.runId}`) ? undefined : calls.get(callId);
    const contextId = call?.contextId ?? responses.get(`${item.agentId}:${String(event.responseId)}`);
    add({ id: `event:${item.id}`, agentId: call?.agentId ?? item.agentId, kind: eventKind(event),
      ...(contextId ? { contextId } : {}),
      label: String(event.toolId ?? trace.name ?? trace.tool ?? step.toolName ?? step.kind ?? event.type ?? "event"), timestamp: timestamp(item.createdAt),
      ...(endTime ? { endTime } : {}), runId: item.runId, streamId: item.streamId ?? "events", sequence: item.sequence }, async () => payload);
  }
  const ordered = orderEvents(entries);
  entries.splice(0, entries.length, ...ordered);
  // Context snapshots referenced by events are details, not standalone markers.
  const history = historicalEntries.filter(e => !(e.contextId && linkedContexts.has(e.contextId) && (e.id.startsWith("before:") || e.id.startsWith("context:"))));
  if (history.length) warnings.add("Unlinked historical versions or events without timestamps are in History, not on the real-time axis.");
  if (source.events.length && !contexts.size) warnings.add("No recorded model contexts are available for this Session.");
  const index: TrajectoryIndex = { schemaVersion: 1, sessionId: source.sessionId, capturedAt: new Date().toISOString(), agents: source.agents, entries, historicalEntries: history, warnings: [...warnings] };
  async function detail(id: string): Promise<TrajectoryDetail | undefined> {
    signal.throwIfAborted();
    const entry = [...entries, ...history].find(e => e.id === id), load = loaders.get(id);
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
    if (states.has(id)) {
      const snapshot = await record(states.get(id)!, "AgentStateSnapshot");
      if (object(snapshot).agentId !== entry.agentId) throw new Error("State ownership mismatch");
      if (result.context) result.context.state = redact(snapshot);
      if (entry.kind === "state") result.value = redact(snapshot);
    }
    return result;
  }
  async function* exportRecords() {
    yield JSON.stringify({ type: "trajectory", ...index }) + "\n";
    for (const entry of [...entries, ...history]) {
      signal.throwIfAborted();
      // Each line is self-contained; an interrupted HTTP transfer lacks the final completion marker.
      yield JSON.stringify({ type: "entry", ...await detail(entry.id) }) + "\n";
    }
    yield JSON.stringify({ type: "complete", entries: entries.length + history.length, capturedAt: index.capturedAt }) + "\n";
  }
  return { index, detail, exportRecords };
}

/** Merge stream heads by wall time without reversing a producer's sequence. */
export function orderEvents(entries: TrajectoryEntry[]): TrajectoryEntry[] {
  const streams = new Map<string, TrajectoryEntry[]>();
  for (const entry of entries) {
    const key = `${entry.agentId}:${entry.runId}:${entry.streamId ?? entry.id}`;
    const stream = streams.get(key) ?? []; stream.push(entry); streams.set(key, stream);
  }
  const queues = [...streams.values()].map(items => items.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)));
  const positions = queues.map(() => 0), result: TrajectoryEntry[] = [];
  while (result.length < entries.length) {
    let best = -1;
    for (let i = 0; i < queues.length; i++) {
      const next = queues[i]![positions[i]!];
      if (next && (best < 0 || next.timestamp! < queues[best]![positions[best]!]!.timestamp!)) best = i;
    }
    result.push(queues[best]![positions[best]!]!); positions[best]!++;
  }
  return result;
}
