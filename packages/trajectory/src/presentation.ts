// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { object, text, type TrajectoryDetail, type TrajectoryEntry, type TrajectoryIndex } from "./index.js";

export function internalEntry(entry: TrajectoryEntry): boolean {
  const type = entry.eventType ?? entry.label;
  if (type === "state_changed") return ["idle", "assembling_context", "calling_model", "executing_tools", "completed"].includes(entry.status ?? "");
  return ["turn_start", "response_start", "response_settled", "model_usage", "assistant.response.started", "assistant.response.settled"].includes(type)
    || entry.id.startsWith("before:");
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

export interface RecordGroup { id: string; agentId: string; runId?: string; turn?: number; invocation?: number; entries: TrajectoryEntry[] }
/** Group only by recorded context identity, never by a guessed timestamp or turn. */
export function recordGroups(index: TrajectoryIndex): RecordGroup[] {
  const groups = new Map<string, RecordGroup>(), attempts = new Map<string, number>();
  for (const entry of [...index.entries, ...(index.untimedEntries ?? index.historicalEntries ?? [])]) {
    const id = `${entry.agentId}:${entry.contextId ?? entry.id}`;
    let group = groups.get(id);
    if (!group) { group = { id, agentId: entry.agentId, runId: entry.runId, turn: entry.turn, entries: [] }; groups.set(id, group); }
    group.runId ??= entry.runId; group.turn ??= entry.turn;
    group.entries.push(entry);
  }
  for (const group of groups.values()) {
    if (group.entries.some(e => e.contextId)) {
      const key = `${group.agentId}:${group.runId}`;
      group.invocation = (attempts.get(key) ?? 0) + 1; attempts.set(key, group.invocation);
    }
    // An untimed input is still the input of this invocation, not an older version.
    group.entries = [...group.entries.filter(e => !e.timestamp && e.kind === "input"), ...group.entries.filter(e => e.timestamp || e.kind !== "input")];
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
    add(tr("工具", "Tool"), call.name ?? call.tool ?? value.toolId ?? step.toolName);
    add(tr("调用状态", "Invocation status"), value.isError === true || value.status === "failed" ? tr("失败", "Failed") : value.status ?? (value.type === "tool_execution_start" ? tr("开始执行", "Started") : undefined));
    add(tr("输入参数", "Input arguments"), parseArguments(call.arguments ?? call.input ?? value.arguments ?? request.arguments ?? request.params), "fields");
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
