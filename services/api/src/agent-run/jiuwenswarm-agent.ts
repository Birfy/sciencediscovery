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
import type { AgentTool, AgentToolResult } from "@sciencediscovery/tools";

import { DurableContextStore } from "@sciencediscovery/context";

import {
  buildTools,
  composeSystemPrompt,
  pluginTools,
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
  /** Replaceable for tests. */
  fetch?: typeof fetch;
}

/** Selected by SCIENCE_AGENT_EXECUTOR=jiuwenswarm; the native agent stays the default. */
export function jiuwenSwarmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JiuwenSwarmAgentConfig | undefined {
  if (env.SCIENCE_AGENT_EXECUTOR?.trim() !== "jiuwenswarm") return undefined;
  const adapterUrl = env.SCIENCE_AGENT_ADAPTER_URL?.trim();
  if (!adapterUrl) throw new Error("SCIENCE_AGENT_EXECUTOR=jiuwenswarm requires SCIENCE_AGENT_ADAPTER_URL");
  return {
    adapterUrl: adapterUrl.replace(/\/+$/, ""),
    ...(env.SCIENCE_AGENT_ADAPTER_TOKEN?.trim() ? { adapterToken: env.SCIENCE_AGENT_ADAPTER_TOKEN.trim() } : {}),
  };
}

const PROVIDERS: Record<string, string> = {
  "anthropic-messages": "Anthropic",
  "openai-chat-completions": "OpenAI",
  "openai-responses": "OpenAI",
};

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
    const tools = new Map([...buildTools(this.options), ...pluginTools(plugins)].map((tool) => [tool.name, tool]));
    const bridgeToken = randomUUID();
    const bridge = await startBridge(tools, bridgeToken, this.controller.signal, (event) => this.emit(event));
    const timeout = this.options.runTimeoutMs ? setTimeout(() => this.controller.abort(), this.options.runTimeoutMs) : undefined;
    try {
      const finalText = await this.stream(text, tools, bridge.url, bridgeToken);
      return {
        finalMessages: [
          { role: "user", content: text },
          { role: "assistant", content: finalText },
        ],
      };
    } catch (error) {
      if (this.controller.signal.aborted) throw new Error("Agent run cancelled");
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      await bridge.close();
      await plugins.dispose();
    }
  }

  private async stream(text: string, tools: Map<string, AgentTool>, bridgeUrl: string, bridgeToken: string): Promise<string> {
    const { config: model } = this.options;
    const provider = model.apiProtocol ? PROVIDERS[model.apiProtocol] : undefined;
    const toolNames = new Set(tools.keys());
    // The same system prompt the native loop would send: the model is tuned to it.
    const { systemPrompt } = composeSystemPrompt(this.options, toolNames, toolNames.has("read_skill") ? this.options.skills ?? [] : []);
    const response = await (this.config.fetch ?? fetch)(`${this.config.adapterUrl}/agent/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.adapterToken ? { authorization: `Bearer ${this.config.adapterToken}` } : {}),
      },
      body: JSON.stringify({
        sessionId: this.options.sessionId,
        prompt: text,
        systemPrompt,
        cwd: this.options.workspaceRoot,
        model: { model: model.model, baseUrl: model.baseUrl, apiKey: model.apiToken ?? "", ...(provider ? { provider } : {}) },
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
    const translator = new EventTranslator((event) => this.emit(event));
    let finalText = "";
    let failure: string | undefined;
    for await (const line of ndjson(response.body)) {
      if ("done" in line) finalText = line.done.finalText;
      else if (line.event.type === "run.failed") failure = String(line.event.error);
      else translator.handle(line.event);
    }
    if (failure !== undefined) throw new Error(failure);
    return finalText;
  }
}

/**
 * Turns the adapter's run events into the agent events the run consumes. Tool
 * events are deliberately not translated: the bridge reports them, from the
 * place the tool really runs, with its real result.
 */
class EventTranslator {
  private turn = 0;

  constructor(private readonly emit: Listener) {}

  handle(event: { type: string; [key: string]: unknown }): void {
    switch (event.type) {
      case "agent.phase":
        this.startTurn(Number(event.turn));
        break;
      case "assistant.response.started": {
        const turn = Number(event.turn);
        if (turn > this.turn) this.startTurn(turn);
        this.emit({ type: "response_start", responseId: String(event.responseId), turn });
        break;
      }
      case "assistant.delta":
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
      case "assistant.response.settled":
        this.emit({ type: "response_settled", responseId: String(event.responseId), turn: Number(event.turn) });
        break;
      case "model.usage": {
        const usage = event.usage as { cacheReadTokens?: number | null; cacheWriteTokens?: number | null; inputTokens: number; outputTokens: number; totalTokens: number };
        this.emit({ type: "model_usage", usage, usageReported: true });
        break;
      }
      default:
        break;
    }
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

function resultText(result: AgentToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Loopback endpoint the adapter calls to run one of this run's tools. */
async function startBridge(
  tools: Map<string, AgentTool>,
  token: string,
  signal: AbortSignal,
  emit: Listener,
): Promise<{ url: string; close(): Promise<void> }> {
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
    const toolCallId = randomUUID();
    const args = body.arguments ?? {};
    emit({ type: "tool_execution_start", toolCallId, toolName: tool.name, args });
    let result: AgentToolResult;
    try {
      result = await tool.execute(toolCallId, args as never, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { content: [{ type: "text", text: message }], isError: true };
    }
    const isError = result.isError === true;
    // Tool failures reach the model as text; without this line they are invisible to the operator.
    if (isError) console.warn(`[jiuwenswarm-bridge] tool ${tool.name} failed: ${resultText(result).slice(0, 300)}`);
    emit({ type: "tool_execution_end", toolCallId, toolName: tool.name, isError, result });
    reply(200, { text: resultText(result), isError });
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
