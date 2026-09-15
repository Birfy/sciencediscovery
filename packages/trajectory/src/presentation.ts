// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { object, text, type TrajectoryDetail, type TrajectoryEntry, type TrajectoryIndex } from "./index.js";

export function internalEntry(entry: TrajectoryEntry): boolean {
  const type = entry.eventType ?? entry.label;
  if (entry.kind === "state" || type === "run.started") return true;
  if (type === "state_changed") return ["idle", "assembling_context", "calling_model", "executing_tools", "completed"].includes(entry.status ?? "");
  return ["turn_start", "response_start", "response_settled", "model_usage", "assistant.response.started", "assistant.response.settled", "session.updated", "run.queued", "run.status"].includes(type)
    || entry.id.startsWith("before:");
}

export interface TimelineRow { category: "model" | "tools" | "events"; entries: TrajectoryEntry[] }
/** Pack visual intervals, including the minimum clickable width of point events. */
export function timelineRows(entries: TrajectoryEntry[], duration: number, width: number): TimelineRow[] {
  const minimum = Math.max(1, duration) * 8 / Math.max(1, width * .98);
  const rows: TimelineRow[] = [];
  for (const category of ["model", "tools", "events"] as const) {
    const ends: number[] = [], lanes: TrajectoryEntry[][] = [];
    const candidates = entries.filter(e => e.timestamp && Number.isFinite(Date.parse(e.timestamp)) &&
      (e.kind === "tool" || e.kind === "mcp" ? "tools" : ["input", "output", "thinking"].includes(e.kind) ? "model" : "events") === category)
      .sort((a, b) => Date.parse(a.timestamp!) - Date.parse(b.timestamp!));
    for (const entry of candidates) {
      const start = Date.parse(entry.timestamp!);
      const end = entry.endTime ? Date.parse(entry.endTime) : start;
      let row = ends.findIndex(value => value <= start);
      if (row < 0) { row = lanes.length; lanes.push([]); }
      lanes[row]!.push(entry);
      ends[row] = Math.max(start + minimum, Number.isFinite(end) ? end : start);
    }
    rows.push(...lanes.map(entries => ({ category, entries })));
  }
  return rows;
}

export function entryTitle(entry: TrajectoryEntry, zh: boolean): string {
  const type = entry.eventType ?? entry.label;
  const titles: Record<string, [string, string]> = {
    "run.started": ["开始执行", "Run started"], completed: ["执行完成", "Run completed"],
    "run.completed": ["执行完成", "Run completed"], "run.failed": ["执行失败", "Run failed"], "run.cancelled": ["执行取消", "Run cancelled"],
    "context.captured": ["模型输入", "Model input"], "model.completed": ["模型返回", "Model response"],
    "state.committed": ["状态检查点", "State checkpoint"], context_recovery: ["上下文超限恢复", "Context overflow recovery"],
    tool_execution_start: ["工具调用", "Tool invocation"], tool_execution_end: ["工具结果", "Tool result"],
    "tool.started": ["工具调用", "Tool invocation"], "tool.completed": ["工具结果", "Tool result"],
    "tool.output": ["命令输出", "Command output"], "mcp.invocation": ["MCP 调用", "MCP invocation"],
  };
  if (type === "state_changed") return ({ failed: zh ? "执行失败" : "Run failed", cancelled: zh ? "执行取消" : "Run cancelled", waiting_external: zh ? "等待外部操作" : "Waiting for external action" })[entry.status ?? ""] ?? type;
  if (entry.kind === "thinking") return zh ? "思考内容" : "Thinking";
  if (titles[type]) return titles[type][zh ? 0 : 1];
  if (entry.id.startsWith("context:")) return zh ? "模型输入" : "Model input";
  if (entry.id.startsWith("before:")) return zh ? "调用前状态" : "State before invocation";
  if (entry.id.startsWith("after:")) return zh ? "调用后状态" : "State after invocation";
  if (type === "model_delta" || type === "assistant.delta") return zh ? "模型输出片段" : "Model output segment";
  return entry.label;
}

export interface RecordGroup { id: string; agentId: string; runId?: string; entries: TrajectoryEntry[] }
/** Visual groups belong to an Agent Run. Context identity stays on each entry. */
export function recordGroups(index: TrajectoryIndex): RecordGroup[] {
  const groups = new Map<string, RecordGroup>();
  for (const entry of [...index.entries, ...(index.untimedEntries ?? index.historicalEntries ?? [])]) {
    const id = JSON.stringify([entry.agentId, entry.runId ? ["run", entry.runId] : ["context", entry.contextId ?? "unassociated"]]);
    let group = groups.get(id);
    if (!group) { group = { id, agentId: entry.agentId, runId: entry.runId, entries: [] }; groups.set(id, group); }
    group.entries.push(entry);
  }
  for (const group of groups.values()) {
    // Insert untimed inputs next to the exact recorded invocation, not at Run start.
    for (const input of group.entries.filter(e => !e.timestamp && e.kind === "input" && e.contextId)) {
      const target = group.entries.findIndex(e => e !== input && e.contextId === input.contextId);
      const current = group.entries.indexOf(input);
      if (target >= 0 && current > target) { group.entries.splice(current, 1); group.entries.splice(target, 0, input); }
    }
  }
  return [...groups.values()];
}

export interface ContentSection { title: string; value: unknown; format: "text" | "fields" }
const parseArguments = (value: unknown) => { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return value; } };
function contentText(value: unknown): string {
  if (Array.isArray(value)) return value.map(item => typeof item === "string" ? item : text(object(item).text ?? item)).join("\n");
  return text(value);
}

/** Explicit adapters for recorded payload shapes; never execute or infer missing content. */
export function contentSections(detail: TrajectoryDetail, zh: boolean): ContentSection[] {
  const tr = (cn: string, en: string) => zh ? cn : en;
  const value = object(detail.value), step = object(value.step), result = object(value.result);
  const sections: ContentSection[] = [];
  const add = (title: string, value: unknown, format: ContentSection["format"] = "text") => {
    if (value !== undefined && value !== null && value !== "") sections.push({ title, value: format === "text" ? contentText(value) : value, format });
  };
  const packets = Array.isArray(value.packets) ? value.packets.map(p => object(object(p).event ?? p)) : [];
  if (detail.entry.kind === "thinking") {
    add(tr("思考内容", "Thinking"), packets.length ? packets.map(p => text(p.delta ?? p.text ?? "")).join("") : value.delta ?? value.thinking ?? value.content ?? step.content);
  } else if (detail.entry.kind === "tool" || detail.entry.kind === "mcp") {
    const payloads = object(value.payloads), request = object(payloads.request);
    const call = object(value.call ?? value.trace ?? step.toolTrace);
    const name = call.name ?? call.tool ?? value.toolId ?? step.toolName;
    const status = value.isError === true || value.status === "failed" ? tr("失败", "Failed") : value.status ?? (value.type === "tool_execution_start" ? tr("开始执行", "Started") : undefined);
    add(tr("工具", "Tool"), [name, status].filter(v => v !== undefined).map(text).join(" · "));
    add(tr("输入参数", "Input arguments"), parseArguments(call.args ?? call.arguments ?? call.input ?? value.arguments ?? request.arguments ?? request.params), "fields");
    add(tr("执行结果", "Result"), value.content ?? result.content ?? object(result.message).content ?? step.content);
    if (value.type === "tool.output") add(tr("命令输出", "Command output"), packets.length ? packets.map(p => text(p.chunk ?? p.text ?? p.content ?? p.delta ?? "")).join("") : value.chunk ?? value.text ?? value.delta);
    add(tr("MCP 返回", "MCP response"), object(payloads.rawResponse).content ?? payloads.rawResponse ?? payloads.normalizedResult, "fields");
    add(tr("错误", "Error"), value.error ?? call.error);
  } else if (detail.entry.kind === "input") {
    const input = object(detail.context?.input ?? value.input);
    add(tr("系统提示", "System prompt"), input.systemPrompt);
    for (const [i, message] of (Array.isArray(input.history) ? input.history : []).entries()) {
      const msg = object(message);
      add(`${tr("消息", "Message")} ${i + 1} · ${String(msg.role ?? "message")}`, msg.content ?? message);
    }
    add(tr("可用工具", "Available tools"), input.tools, "fields");
  } else if (detail.entry.kind === "output") {
    const message = object(value.assistantMessage ?? result.assistantMessage ?? value.message);
    add(tr("模型输出", "Model output"), packets.length ? packets.map(p => text(p.delta ?? p.text ?? "")).join("") : message.content ?? value.delta ?? value.content ?? step.content);
    add(tr("返回的思考", "Returned thinking"), message.reasoningContent ?? message.reasoning_content ?? message.thinking);
    if ((detail.entry.eventType ?? detail.entry.label) === "model.completed" || value.result) {
      const usage = object(value.usage ?? result.usage);
      const fields = Object.fromEntries([
        ["inputTokens", tr("输入 Token", "Input tokens")], ["outputTokens", tr("输出 Token", "Output tokens")],
        ["totalTokens", tr("总 Token", "Total tokens")], ["cacheReadTokens", tr("缓存读取 Token", "Cache read tokens")],
        ["cacheWriteTokens", tr("缓存写入 Token", "Cache write tokens")],
      ].flatMap(([key, label]) => typeof usage[key!] === "number" ? [[label!, usage[key!]]] : []));
      add(tr("本次请求用量", "This request's usage"), Object.keys(fields).length ? fields : tr("未记录", "Not recorded"), "fields");
    }
    add(tr("请求调用的工具", "Requested tools"), value.toolCalls ?? result.toolCalls ?? message.tool_calls, "fields");
  } else if (detail.entry.kind === "state" && value.checkpoint) {
    const checkpoint = object(value.checkpoint);
    add(tr("状态概览", "State overview"), { ...(value.phase ? { phase: value.phase } : {}), ...(value.turn !== undefined ? { turn: value.turn } : {}), ...(Array.isArray(value.history) ? { messages: value.history.length } : {}), ...(Array.isArray(value.observations) ? { observations: value.observations.length } : {}) }, "fields");
    add(tr("组件状态", "Component states"), Array.isArray(checkpoint.components) ? checkpoint.components.map(c => ({ id: object(c).id, revision: object(c).revision, fidelity: object(c).fidelity })) : checkpoint, "fields");
  } else {
    for (const [key, label] of [["error", tr("错误", "Error")], ["reason", tr("原因", "Reason")], ["state", tr("运行状态", "Run state")], ["message", tr("消息", "Message")], ["usage", tr("模型用量", "Model usage")]] as const) add(label, value[key], typeof value[key] === "object" ? "fields" : "text");
    if (value.truncated === true) add(tr("停止原因", "Stop reason"), tr("已达到模型轮次上限", "Model turn limit reached"));
    if (!sections.length) add(tr("事件", "Event"), entryTitle(detail.entry, zh));
  }
  return sections;
}
