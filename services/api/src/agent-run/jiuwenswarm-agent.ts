// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { AgentEvent } from "@sciencediscovery/orchestration";
import { TOOL_SEARCH_NAME, TOOL_SEARCH_SPEC, type AgentTool } from "@sciencediscovery/tools";

import { DurableContextStore } from "@sciencediscovery/context";

import { startModelGateway } from "./jiuwenswarm-model-gateway.js";

import { resolveModelClientPolicy, type streamModelTurn } from "@sciencediscovery/model";

import {
  composeSystemPrompt,
  createToolRegistry,
  modelEndpointFor,
  startPluginScope,
  type NativeAgentHandle,
  type NativeAgentOptions,
} from "../native-agent/index.js";

/**
 * An agent whose loop runs on JiuwenSwarm, behind the adapter.
 *
 * It keeps everything the legacy run already owns: the tools are the ones the
 * native agent would have got, and they still execute here, in this process,
 * through a loopback bridge the adapter calls. So permission checks, the
 * runner, artifacts and their events behave exactly as before; only the model
 * loop and its context live elsewhere.
 */
export interface JiuwenSwarmAgentConfig {
  /** Base URL of the adapter, e.g. http://127.0.0.1:4310. */
  adapterUrl: string;
  /** Bearer token the adapter expects on /agent/*, when it has one. */
  adapterToken?: string;
  /** How long the bridge waits for the adapter to report a tool call before running it anyway. */
  toolAnnouncementTimeoutMs?: number;
  /** Replaceable for tests. */
  fetch?: typeof fetch;
  /** Replaceable for tests: the native model client the run's model requests are served by. */
  modelStreamer?: typeof streamModelTurn;
  /**
   * Who keeps the plan. `todo` (default): the model uses JiuwenSwarm's own todo tools and its todo list
   * becomes the run's plan. `update_plan`: the model calls ScienceDiscovery's own tool instead.
   */
  planning?: "todo" | "update_plan";
}

/**
 * What the model is told about JiuwenSwarm's todo tools. The rest of the system prompt says to use only the
 * registered workspace tools, which these are not, and the plan guidance ScienceDiscovery normally gives
 * (the `update_plan` description, the plan context added at every step) does not apply to them.
 */
export const TODO_PLANNING_SECTION = [
  "## Planning",
  "For work with several steps, keep a task list with `todo_create` (creates or replaces the whole list), `todo_modify` (update, insert, cancel or delete items) and `todo_list`. The runtime provides them next to the workspace tools above; they are the way to plan.",
  "Mark a task in_progress before you start it and completed as soon as it is done; do not finish several at once. Keep the list short, at most 20 items, and change it when new evidence changes the approach.",
].join("\n");

/** JiuwenSwarm's own todo tools, left visible to the model unless planning is `update_plan`. */
export const JIUWENSWARM_TODO_TOOLS = ["todo_create", "todo_modify", "todo_list", "todo_get"] as const;

/** Selected by SCIENCE_AGENT_EXECUTOR=jiuwenswarm; the native agent stays the default. */
export function jiuwenSwarmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JiuwenSwarmAgentConfig | undefined {
  if (env.SCIENCE_AGENT_EXECUTOR?.trim() !== "jiuwenswarm") return undefined;
  const adapterUrl = env.SCIENCE_AGENT_ADAPTER_URL?.trim();
  if (!adapterUrl) throw new Error("SCIENCE_AGENT_EXECUTOR=jiuwenswarm requires SCIENCE_AGENT_ADAPTER_URL");
  return {
    adapterUrl: adapterUrl.replace(/\/+$/, ""),
    ...(env.SCIENCE_AGENT_ADAPTER_TOKEN?.trim() ? { adapterToken: env.SCIENCE_AGENT_ADAPTER_TOKEN.trim() } : {}),
    ...(env.SCIENCE_AGENT_JIUWENSWARM_PLANNING?.trim() === "update_plan" ? { planning: "update_plan" as const } : {}),
  };
}

type Listener = (event: AgentEvent) => void;

/** A line of the adapter's NDJSON stream. */
type RunLine =
  | { event: { type: string; [key: string]: unknown } }
  | { done: { finalText: string; unmapped?: string[]; cancelled?: boolean } };

export function createJiuwenSwarmAgentFactory(config: JiuwenSwarmAgentConfig) {
  return (options: NativeAgentOptions): NativeAgentHandle => new JiuwenSwarmAgent(config, options);
}

class JiuwenSwarmAgent implements NativeAgentHandle {
  private readonly listeners = new Set<Listener>();
  private readonly controller = new AbortController();
  private executed = false;

  constructor(private readonly config: JiuwenSwarmAgentConfig, private readonly options: NativeAgentOptions) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  abort(): void {
    this.controller.abort();
  }

  /** The loop is remote, so there is no local idle clock to pause. */
  beginExternalWait(): () => void {
    return () => undefined;
  }

  async prompt(text: string): Promise<void> {
    await this.execute(text);
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async execute(text: string): Promise<{ finalMessages: Awaited<ReturnType<NativeAgentHandle["execute"]>>["finalMessages"] }> {
    if (this.executed) throw new Error("Agent handle has already been executed");
    this.executed = true;
    const durable = new DurableContextStore({
      history: this.options.gatewayHistory,
      ...(this.options.runContract ? { runContract: this.options.runContract } : {}),
    });
    const plugins = await startPluginScope(this.options, durable, this.controller.signal);
    // The same registry the native loop dispatches through: output guard, detail sanitisation,
    // neutralised untrusted content, loop protection, the standard error shape.
    const registry = createToolRegistry(this.options, plugins, durable);
    const tools = new Map(registry.values().map((tool) => [tool.name, tool]));
    await offerDeferredTools(registry, tools, this.controller.signal);
    // With JiuwenSwarm's own todo tools the model does not also get ours.
    const jiuwenSwarmPlans = (this.config.planning ?? "todo") === "todo" && Boolean(this.options.planStore);
    if (jiuwenSwarmPlans) tools.delete("update_plan");
    const bridgeToken = randomUUID();
    const announcements = new ToolAnnouncements();
    const transcript = new Transcript();
    const bridge = await startBridge(registry, tools, bridgeToken, this.controller.signal, (event) => this.emit(event), announcements, transcript,
      this.config.toolAnnouncementTimeoutMs);
    // JiuwenSwarm only speaks OpenAI chat completions; the model itself may not (see the gateway).
    const policy = resolveModelClientPolicy();
    const modelGateway = await startModelGateway(modelEndpointFor(this.options), policy, this.controller.signal, this.config.modelStreamer);
    const timeout = this.options.runTimeoutMs ? setTimeout(() => this.controller.abort(), this.options.runTimeoutMs) : undefined;
    try {
      const finalText = await this.stream(text, tools, bridge.url, bridgeToken, announcements, transcript, modelGateway, jiuwenSwarmPlans);
      // The model was cut at max_tokens and JiuwenSwarm ended the run there. Say so as the native loop does;
      // a turn that produced no visible text (a reasoning model spending its whole budget on thought) would
      // otherwise end the run in the middle of a thought with nothing to show for it.
      const last = modelGateway.lastTurn();
      if (last?.truncated && last.toolCalls === 0) {
        this.emit({ type: "turn_truncated" } as never);
        if (!last.text.trim()) {
          throw new Error(`The model was cut off at its output limit (max_tokens ${policy.maxTokens}) while thinking and gave no answer. Raise SCIENCE_AGENT_LLM_MAX_TOKENS and try again.`);
        }
      }
      return {
        finalMessages: [{ role: "user", content: text }, ...transcript.finish(finalText).map((message) => modelGateway.restore(message))] as never,
      };
    } catch (error) {
      if (this.controller.signal.aborted) throw new Error("Agent run cancelled");
      console.warn(`[jiuwenswarm-agent] run of ${this.options.sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      await bridge.close();
      await modelGateway.close();
      await plugins.dispose();
    }
  }

  /** JiuwenSwarm's todo list, as the run's plan: what the plan panel and the API's plan events read. */
  private async recordPlan(store: NonNullable<NativeAgentOptions["planStore"]>, items: Array<{ content: string; status: string }>, toolCallId: string): Promise<void> {
    const plan = items.flatMap(({ content, status }) => {
      const step = content.trim().slice(0, 1_000);
      // A cancelled todo is not part of the plan; the plan knows pending, in progress and completed.
      return step && (status === "pending" || status === "in_progress" || status === "completed")
        ? [{ step, status: status as "pending" | "in_progress" | "completed" }] : [];
    }).slice(0, 20);
    try {
      await store.update({ plan }, toolCallId, this.controller.signal);
    } catch (error) {
      console.warn(`[jiuwenswarm-agent] could not record the plan: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async stream(
    text: string, tools: Map<string, AgentTool>, bridgeUrl: string, bridgeToken: string,
    announcements: ToolAnnouncements, transcript: Transcript, modelGateway: { token: string; url: string },
    jiuwenSwarmPlans = false,
  ): Promise<string> {
    const { config: model } = this.options;
    const toolNames = new Set(tools.keys());
    // The same system prompt the native loop would send: the model is tuned to it.
    const composed = composeSystemPrompt(this.options, toolNames, toolNames.has("read_skill") ? this.options.skills ?? [] : []).systemPrompt;
    const systemPrompt = jiuwenSwarmPlans ? `${composed}\n\n${TODO_PLANNING_SECTION}` : composed;
    const response = await (this.config.fetch ?? fetch)(`${this.config.adapterUrl}/agent/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.adapterToken ? { authorization: `Bearer ${this.config.adapterToken}` } : {}),
      },
      body: JSON.stringify({
        sessionId: this.options.sessionId,
        sessionKey: jiuwenSwarmSessionKey(this.options),
        prompt: text,
        systemPrompt,
        cwd: this.options.workspaceRoot,
        // The adapter's proxy forwards to this loopback gateway, which speaks the model's own protocol.
        model: { model: model.model, baseUrl: modelGateway.url, apiKey: modelGateway.token, provider: "OpenAI" },
        ...(jiuwenSwarmPlans ? { nativeTools: [...JIUWENSWARM_TODO_TOOLS] } : {}),
        // JiuwenSwarm gives a tool call 30 s unless told otherwise; the run's own timeout is the limit here.
        ...(this.options.runTimeoutMs ? { toolTimeoutSeconds: Math.ceil(this.options.runTimeoutMs / 1000) } : {}),
        tools: [...tools.values()].map((tool) => ({
          name: tool.name, description: tool.description, inputSchema: tool.parameters,
        })),
        bridge: { url: bridgeUrl, token: bridgeToken },
      }),
      signal: this.controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`adapter refused the run: HTTP ${response.status} ${await response.text().catch(() => "")}`.trim());
    }
    const planStore = this.options.planStore;
    const translator = new EventTranslator((event) => this.emit(event), announcements, transcript,
      new Set(jiuwenSwarmPlans ? JIUWENSWARM_TODO_TOOLS : []),
      planStore ? (items, toolCallId) => this.recordPlan(planStore, items, toolCallId) : undefined);
    let finalText = "";
    let failure: string | undefined;
    for await (const line of ndjson(response.body)) {
      if ("done" in line) finalText = line.done.finalText;
      else if (line.event.type === "run.failed") failure = String(line.event.error);
      else translator.handle(line.event);
    }
    if (failure !== undefined) throw new Error(failure);
    translator.finish();
    return finalText;
  }
}

/**
 * The tool calls the adapter says the model made, in order. The bridge runs a tool only when
 * JiuwenSwarm calls it over MCP, which can beat the adapter's own report of the same call to
 * this process. Waiting for that report keeps the run's events in the order the native agent
 * produces them (the response of the model call first, then the tool) and lets the tool run
 * under the id the model gave it.
 */
class ToolAnnouncements {
  private readonly pending: Array<{ args: unknown; id: string; input: string; name: string }> = [];
  private readonly waiters = new Set<() => void>();
  /** Every call announced so far, in the order the model made them, with the response it belongs to. */
  readonly all: Array<{ args: Record<string, unknown>; batch: number; id: string; name: string; seq: number }> = [];
  private batch = 0;

  /** A new model response begins: its calls form the next batch. */
  newResponse(): void {
    this.batch += 1;
  }

  announce(call: { args: unknown; id: string; input: string; name: string }): void {
    this.all.push({ args: (call.args ?? {}) as Record<string, unknown>, batch: this.batch, id: call.id, name: call.name, seq: this.all.length });
    this.pending.push(call);
    for (const wake of [...this.waiters]) wake();
  }

  /**
   * Take the first announced call with this name whose arguments are the ones JiuwenSwarm passed on.
   * JiuwenSwarm fills schema defaults into the arguments and drops empty arrays and objects, so
   * "the same call" means: every argument the model sent is there unchanged, or was empty and is
   * absent. The caller then runs the tool with the announced (model's own) arguments.
   */
  async claim(name: string, given: Record<string, unknown>, timeoutMs = 5_000):
    Promise<{ args: Record<string, unknown>; id: string; input: string } | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.pending.findIndex((call) => call.name === name && sameCall(call.args as Record<string, unknown>, given));
      if (index >= 0) {
        const [call] = this.pending.splice(index, 1);
        return { args: call!.args as Record<string, unknown>, id: call!.id, input: call!.input };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await new Promise<void>((resolve) => {
        const wake = () => { this.waiters.delete(wake); clearTimeout(timer); resolve(); };
        const timer = setTimeout(wake, remaining);
        this.waiters.add(wake);
      });
    }
  }
}

type Prepared = ReturnType<ReturnType<typeof createToolRegistry>["prepareBatch"]>;
type Dispatch = Awaited<ReturnType<ReturnType<typeof createToolRegistry>["execute"]>>;

/**
 * Keeps the native loop's scheduling rules when JiuwenSwarm calls the tools of one model response
 * side by side. Per response, the registry decides which calls may overlap (`isConcurrencySafe`;
 * anything not declared safe runs alone) and which are superseded by another call of the same
 * response (batch policies, e.g. two `update_plan`). A call therefore waits for the calls the model
 * made before it that it may not overlap with, in the order the model made them.
 */
class ToolScheduler {
  private readonly prepared = new Map<number, Prepared>();
  private readonly arrived = new Set<string>();
  private readonly finished = new Set<string>();

  constructor(
    private readonly registry: ReturnType<typeof createToolRegistry>,
    private readonly announcements: ToolAnnouncements,
    /** How long to wait for an earlier call that never reaches the bridge. */
    private readonly graceMs = 5_000,
  ) {}

  async run(call: { args: Record<string, unknown>; id: string; name: string }, signal: AbortSignal, started: () => void): Promise<Dispatch> {
    const own = this.announcements.all.find((item) => item.id === call.id);
    // A call nobody announced (see claim) has no place in an order: run it as it comes.
    if (!own) { started(); return await this.registry.execute(call as never, signal); }
    this.arrived.add(call.id);
    try {
      // Announcements of one response arrive back to back; let them all in before deciding.
      await new Promise((resolve) => setImmediate(resolve));
      const batchCalls = this.announcements.all.filter((item) => item.batch === own.batch);
      let prepared = this.prepared.get(own.batch);
      if (!prepared) {
        prepared = this.registry.prepareBatch(batchCalls.map(({ args, id, name }) => ({ args, id, name })) as never);
        this.prepared.set(own.batch, prepared);
      }
      const exclusive = (item: { args: Record<string, unknown>; id: string; name: string }) =>
        // Fail closed like the native loop: only an explicit "parallel" may overlap.
        prepared!.executionMode?.({ args: item.args, id: item.id, name: item.name } as never) !== "parallel";
      const mine = exclusive(own);
      for (const earlier of batchCalls.filter((item) => item.seq < own.seq && (mine || exclusive(item)))) {
        const deadline = Date.now() + this.graceMs;
        while (!this.finished.has(earlier.id) && (this.arrived.has(earlier.id) || Date.now() < deadline)) {
          if (signal.aborted) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      started();
      return await prepared.execute({ args: call.args, id: call.id, name: call.name } as never, signal);
    } finally {
      this.finished.add(call.id);
    }
  }
}

const isEmptyContainer = (value: unknown) =>
  (Array.isArray(value) && value.length === 0)
  || (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);

function sameCall(announced: Record<string, unknown>, given: Record<string, unknown>): boolean {
  return Object.entries(announced ?? {}).every(([key, value]) =>
    key in given ? JSON.stringify(given[key]) === JSON.stringify(value) : isEmptyContainer(value));
}

/** The model-facing transcript of a run, in the shape the native agent leaves behind. */
class Transcript {
  readonly messages: Array<Record<string, unknown>> = [];
  private text = "";
  private pending: { content: string; tool_calls?: Array<Record<string, unknown>> } | undefined;

  delta(text: string): void {
    this.text += text;
  }

  /** A model call ended; what it said is held until we know whether it also called tools. */
  settled(): void {
    this.flush();
    this.pending = { content: this.text };
    this.text = "";
  }

  toolCall(id: string, name: string, input: string): void {
    this.pending ??= { content: "" };
    (this.pending.tool_calls ??= []).push({ id, type: "function", function: { name, arguments: input } });
  }

  toolResult(id: string, name: string, content: string): void {
    this.flush();
    this.messages.push({ role: "tool", tool_call_id: id, name, content });
  }

  private flush(): void {
    if (!this.pending) return;
    this.messages.push({ role: "assistant", ...this.pending });
    this.pending = undefined;
  }

  /** Close the run. A model call that answered without streaming leaves `finalText` as its answer. */
  finish(finalText: string): Array<Record<string, unknown>> {
    if (this.text) this.settled();
    if (!this.pending && finalText && !this.messages.some((message) => message.role === "assistant" && message.content === finalText)) {
      this.pending = { content: finalText };
    }
    this.flush();
    return this.messages;
  }
}

/**
 * Turns the adapter's run events into the agent events the run consumes. Tool
 * events are deliberately not translated: the bridge reports them, from the
 * place the tool really runs, with its real result.
 */
class EventTranslator {
  private turn = 0;
  private total: { cacheReadTokens: number | null; cacheWriteTokens: number | null; inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

  constructor(
    private readonly emit: Listener,
    private readonly announcements: ToolAnnouncements,
    private readonly transcript: Transcript,
    /** JiuwenSwarm's own tools the model may call; they run there, so their events come from here. */
    private readonly nativeTools: ReadonlySet<string> = new Set(),
    private readonly onPlan?: (items: Array<{ content: string; status: string }>, toolCallId: string) => void,
  ) {}

  private lastNativeCall = "";
  private readonly nativeCalls = new Map<string, { args: unknown; name: string }>();

  handle(event: { type: string; [key: string]: unknown }): void {
    switch (event.type) {
      case "agent.phase":
        this.startTurn(Number(event.turn));
        break;
      case "assistant.response.started": {
        const turn = Number(event.turn);
        if (turn > this.turn) this.startTurn(turn);
        this.announcements.newResponse();
        this.emit({ type: "response_start", responseId: String(event.responseId), turn });
        break;
      }
      case "assistant.delta":
        this.transcript.delta(String(event.delta));
        this.emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: String(event.delta), responseId: String(event.responseId) },
        });
        break;
      case "assistant.thinking.delta":
        this.emit({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: String(event.delta), responseId: String(event.responseId) },
        });
        break;
      case "tool.started": {
        // Not translated (the bridge reports the tool from where it runs), but the model's call
        // is recorded and announced so the bridge can run under the model's id, in order.
        const trace = event.trace as { args?: unknown; id: string; input?: string; name: string };
        const input = trace.input ?? JSON.stringify(trace.args ?? {});
        // Compact JSON like the model sent it; JiuwenSwarm re-serialises arguments with spaces.
        this.transcript.toolCall(trace.id, trace.name, JSON.stringify(trace.args ?? {}));
        if (this.nativeTools.has(trace.name)) {
          // Runs inside JiuwenSwarm: nothing will claim it at the bridge, so report it from here.
          this.lastNativeCall = trace.id;
          this.nativeCalls.set(trace.id, { args: trace.args ?? {}, name: trace.name });
          this.emit({ type: "tool_execution_start", toolCallId: trace.id, toolName: trace.name, args: (trace.args ?? {}) as Record<string, unknown> });
        } else {
          this.announcements.announce({ args: trace.args ?? {}, id: trace.id, input, name: trace.name });
        }
        break;
      }
      case "tool.completed": {
        const trace = event.trace as { id: string; name: string; output?: string; status?: string };
        if (!this.nativeCalls.has(trace.id)) break;
        const text = trace.output ?? "";
        this.emit({
          type: "tool_execution_end", toolCallId: trace.id, toolName: trace.name, isError: trace.status === "failed",
          result: { content: [{ type: "text", text }] },
        });
        this.transcript.toolResult(trace.id, trace.name, text);
        break;
      }
      case "plan.updated":
        this.onPlan?.(event.items as Array<{ content: string; status: string }>, this.lastNativeCall);
        break;
      case "assistant.response.settled":
        this.transcript.settled();
        this.emit({ type: "response_settled", responseId: String(event.responseId), turn: Number(event.turn) });
        break;
      case "model.usage": {
        const usage = event.usage as { cacheReadTokens?: number | null; cacheWriteTokens?: number | null; inputTokens: number; outputTokens: number; totalTokens: number };
        this.emit({ type: "model_usage", usage, usageReported: true });
        this.add(usage);
        break;
      }
      default:
        break;
    }
  }

  /** Sum of the model calls of the run; null stays null unless some call reported a number. */
  private add(usage: { cacheReadTokens?: number | null; cacheWriteTokens?: number | null; inputTokens: number; outputTokens: number; totalTokens: number }): void {
    const plus = (a: number | null, b: number | null | undefined) => (b === null || b === undefined ? a : (a ?? 0) + b);
    const total = this.total ?? { cacheReadTokens: null, cacheWriteTokens: null, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    // Key order matters: subagent summaries serialise this object into a tool result string.
    this.total = {
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
      cacheReadTokens: plus(total.cacheReadTokens, usage.cacheReadTokens),
      cacheWriteTokens: plus(total.cacheWriteTokens, usage.cacheWriteTokens),
    };
  }

  /** The `usage` event the native agent emits once, after the last model call. */
  finish(): void {
    if (this.total) this.emit({ type: "usage", usage: this.total });
  }

  private startTurn(turn: number): void {
    this.turn = turn;
    this.emit({ type: "turn_start" });
  }
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<RunLine> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) yield JSON.parse(line) as RunLine;
      newline = pending.indexOf("\n");
    }
  }
  const rest = (pending + decoder.decode()).trim();
  if (rest) yield JSON.parse(rest) as RunLine;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * The JiuwenSwarm session that holds one agent's conversation. It is stable across runs, so JiuwenSwarm
 * keeps (and compresses) the context itself, and there is one per agent: the main agent uses the
 * session's own id, a subagent its own key, so a resumed subagent finds its conversation. Nothing of the
 * conversation is sent along: JiuwenSwarm is the only holder of the model's context.
 */
export function jiuwenSwarmSessionKey(options: Pick<NativeAgentOptions, "sessionId" | "versioning">): string {
  const agentId = options.versioning?.agentId ?? "main";
  if (agentId.startsWith("main")) return options.sessionId;
  return `${options.sessionId}--${agentId.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

/**
 * The native loop hides deferred tools (large MCP tool schemas) until the model finds them with
 * `tool_search`. JiuwenSwarm fixes the tool list when the run starts, so nothing can be revealed
 * later: promote every deferred tool now, offer them all, and keep `tool_search` in the list so a
 * model that asks for it (the system prompt tells it to) gets the schemas and the tools stay callable.
 */
async function offerDeferredTools(
  registry: ReturnType<typeof createToolRegistry>,
  tools: Map<string, AgentTool>,
  signal: AbortSignal,
): Promise<void> {
  const deferred = [...registry.deferredNames()];
  if (!deferred.length) return;
  await registry.execute({ id: randomUUID(), name: TOOL_SEARCH_NAME, args: { query: `select:${deferred.join(",")}` } } as never, signal);
  tools.set(TOOL_SEARCH_NAME, { ...TOOL_SEARCH_SPEC, label: "Tool search" } as unknown as AgentTool);
}

/** Loopback endpoint the adapter calls to run one of this run's tools. */
async function startBridge(
  registry: ReturnType<typeof createToolRegistry>,
  tools: Map<string, AgentTool>,
  token: string,
  signal: AbortSignal,
  emit: Listener,
  announcements: ToolAnnouncements,
  transcript: Transcript,
  announcementTimeoutMs?: number,
): Promise<{ url: string; close(): Promise<void> }> {
  const scheduler = new ToolScheduler(registry, announcements, announcementTimeoutMs);
  const server: Server = createServer(async (request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "POST" || request.headers.authorization !== `Bearer ${token}`) {
      reply(401, { error: "unauthorized" });
      return;
    }
    let body: { name?: string; arguments?: Record<string, unknown> };
    try {
      body = await readJson(request) as typeof body;
    } catch {
      reply(400, { error: "invalid JSON" });
      return;
    }
    const tool = body.name ? tools.get(body.name) : undefined;
    if (!tool) {
      reply(404, { error: `unknown tool: ${body.name}` });
      return;
    }
    // Run under the model's own id and arguments, and only after the adapter has reported the call
    // (see ToolAnnouncements).
    const claimed = await announcements.claim(tool.name, body.arguments ?? {}, announcementTimeoutMs);
    if (!claimed) console.warn(`[jiuwenswarm-bridge] no model call was reported for ${tool.name}; running it under a generated id`);
    const toolCallId = claimed?.id ?? randomUUID();
    const args = claimed?.args ?? body.arguments ?? {};
    // registry.execute never throws for a failing tool: it answers with the standard error shape.
    // The scheduler holds the call back until the calls it may not overlap with have finished, so
    // the start is reported when the tool really starts, as the native loop does.
    const dispatched = await scheduler.run({ id: toolCallId, name: tool.name, args }, signal, () =>
      emit({ type: "tool_execution_start", toolCallId, toolName: tool.name, args }));
    const isError = dispatched.isError === true;
    // Tool failures reach the model as text; without this line they are invisible to the operator.
    if (isError) console.warn(`[jiuwenswarm-bridge] tool ${tool.name} failed: ${dispatched.content.slice(0, 300)}`);
    if (process.env.SCIENCE_AGENT_JIUWENSWARM_DEBUG === "1") {
      console.warn(`[jiuwenswarm-bridge] ${tool.name}(${JSON.stringify(args).slice(0, 160)}) -> ${isError ? "ERROR " : ""}${dispatched.content.slice(0, 300)}`);
    }
    emit({
      type: "tool_execution_end", toolCallId, toolName: tool.name, isError,
      result: { content: [{ type: "text", text: dispatched.content }], ...(dispatched.details !== undefined ? { details: dispatched.details } : {}) },
    });
    transcript.toolResult(toolCallId, tool.name, dispatched.content);
    reply(200, { text: dispatched.content, isError });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/bridge`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
