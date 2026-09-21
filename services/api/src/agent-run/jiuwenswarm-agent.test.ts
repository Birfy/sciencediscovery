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

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AgentEvent } from "@sciencediscovery/orchestration";
import { Type } from "typebox";

import { DurableContextStore } from "@sciencediscovery/context";

import { createToolRegistry, startPluginScope, type NativeAgentOptions } from "../native-agent/index.js";
import {
  createJiuwenSwarmAgentFactory,
  openAiHistory,
  jiuwenSwarmConfigFromEnv,
} from "./jiuwenswarm-agent.js";

/** A fake adapter: records the request and lets each test script the reply. */
async function fakeAdapter(
  script: (request: { body: any; headers: IncomingMessage["headers"] }, response: ServerResponse) => Promise<void> | void,
): Promise<{ url: string; requests: any[]; close(): Promise<void>; aborted: () => boolean }> {
  const requests: any[] = [];
  let aborted = false;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ body, headers: request.headers });
    response.on("close", () => { if (!response.writableEnded) aborted = true; });
    await script({ body, headers: request.headers }, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    aborted: () => aborted,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

const line = (value: unknown) => JSON.stringify(value) + "\n";

function options(extra: Partial<NativeAgentOptions> = {}): NativeAgentOptions {
  const echo = {
    label: "Echo", name: "echo", description: "Echo a word.",
    parameters: Type.Object({ word: Type.String() }),
    execute: async (_id: string, params: { word: string }) => ({ content: [{ type: "text" as const, text: `echo:${params.word}` }] }),
  };
  return {
    config: { baseUrl: "http://llm.test/v1", dataDir: "/data", model: "gpt-x", apiToken: "sk-test", apiProtocol: "openai-chat-completions" },
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not called"); },
    executeShell: async () => { throw new Error("not called"); },
    extraTools: [echo as never],
    sessionId: "session-1",
    workspaceRoot: "/workspace",
    ...extra,
  } as NativeAgentOptions;
}

function collect(agent: { subscribe(l: (e: AgentEvent) => void): () => void }): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((event) => events.push(event));
  return events;
}

test("sends the prompt, model and the run's tools to the adapter and returns the final text", async () => {
  const adapter = await fakeAdapter((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(line({ event: { type: "agent.phase", phase: "thinking", turn: 1 } }) + line({ done: { finalText: "hi there" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, adapterToken: "secret" })(options());
    const result = await agent.execute("hello");
    assert.deepEqual(result.finalMessages, [{ role: "user", content: "hello" }, { role: "assistant", content: "hi there" }]);
    const { body, headers } = adapter.requests[0];
    assert.equal(headers.authorization, "Bearer secret");
    assert.equal(body.sessionId, "session-1");
    assert.equal(body.prompt, "hello");
    assert.equal(body.cwd, "/workspace");
    assert.equal(typeof body.systemPrompt, "string");
    assert.ok(body.systemPrompt.length > 200, "the run gets the workspace system prompt, not an empty one");
    assert.equal(body.model.model, "gpt-x");
    assert.match(body.model.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/, "the adapter is pointed at the run's loopback model gateway, not the provider");
    assert.notEqual(body.model.apiKey, "sk-test", "the provider's key never leaves this process");
    assert.equal(body.model.provider, "OpenAI");
    const echo = body.tools.find((tool: { name: string }) => tool.name === "echo");
    assert.equal(echo.description, "Echo a word.");
    assert.deepEqual(echo.inputSchema.required, ["word"]);
    assert.match(body.bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/bridge$/);
  } finally {
    await adapter.close();
  }
});

test("translates the adapter's run events into agent events", async () => {
  const adapter = await fakeAdapter((_request, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "agent.phase", phase: "thinking", turn: 1 } }));
    response.write(line({ event: { type: "assistant.response.started", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "assistant.thinking.delta", delta: "hmm", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "assistant.delta", delta: "hel", responseId: "r1" } }));
    response.write(line({ event: { type: "assistant.delta", delta: "lo", responseId: "r1" } }));
    response.write(line({ event: { type: "assistant.response.settled", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "assistant.response.started", responseId: "r2", turn: 2 } }));
    response.write(line({ event: { type: "assistant.response.settled", responseId: "r2", turn: 2 } }));
    response.end(line({ done: { finalText: "hello" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    const events = collect(agent);
    await agent.execute("go");
    assert.deepEqual(events.map((event) => event.type), [
      "turn_start", "response_start", "message_update", "message_update", "message_update", "response_settled",
      "turn_start", "response_start", "response_settled",
    ]);
    const text = events.flatMap((event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"
      ? [event.assistantMessageEvent.delta] : []);
    assert.equal(text.join(""), "hello");
    const second = events.filter((event) => event.type === "response_start");
    assert.deepEqual(second.map((event) => (event as { turn: number }).turn), [1, 2]);
  } finally {
    await adapter.close();
  }
});

test("plugin-contributed tools (update_plan) are offered to the adapter and run here", async () => {
  const updates: unknown[] = [];
  const planStore = {
    latest: async () => undefined,
    update: async (input: unknown) => { updates.push(input); return { id: "p1", steps: [] } as never; },
  };
  let offered: string[] = [];
  let reply: any;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    offered = body.tools.map((tool: { name: string }) => tool.name);
    response.writeHead(200);
    response.write(line({ event: { type: "tool.started", trace: { id: "call-plan", name: "update_plan", args: { plan: [{ step: "Do it", status: "in_progress" }] }, status: "running" } } }));
    const call = await fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "update_plan", arguments: { plan: [{ step: "Do it", status: "in_progress" }] } }),
    });
    reply = await call.json();
    response.end(line({ done: { finalText: "planned" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ planStore: planStore as never }));
    const events = collect(agent);
    await agent.execute("plan it");
    assert.ok(offered.includes("update_plan"), `offered: ${offered.join(", ")}`);
    assert.ok(offered.includes("echo"), "the workspace tools are still offered");
    assert.equal(events.filter((event) => event.type === "tool_execution_end").length, 1);
    assert.equal(reply.isError, false, reply.text);
    assert.deepEqual(updates, [{ plan: [{ status: "in_progress", step: "Do it" }] }]);
  } finally {
    await adapter.close();
  }
});

test("reported token usage becomes model_usage events and one summed usage event at the end", async () => {
  const adapter = await fakeAdapter((_request, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "model.usage", usage: { inputTokens: 700, outputTokens: 80, totalTokens: 780, cacheReadTokens: 0, cacheWriteTokens: null }, reasoningTokens: 71 } }));
    response.write(line({ event: { type: "model.usage", usage: { inputTokens: 31, outputTokens: 7, totalTokens: 38, cacheReadTokens: 10, cacheWriteTokens: null } } }));
    response.end(line({ done: { finalText: "" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    const events = collect(agent);
    await agent.execute("go");
    assert.deepEqual(events.map((event) => event.type), ["model_usage", "model_usage", "usage"]);
    assert.deepEqual(events[0], {
      type: "model_usage", usageReported: true,
      usage: { inputTokens: 700, outputTokens: 80, totalTokens: 780, cacheReadTokens: 0, cacheWriteTokens: null },
    });
    const summary = (events[2] as { usage: unknown }).usage;
    assert.deepEqual(summary, { cacheReadTokens: 10, cacheWriteTokens: null, inputTokens: 731, outputTokens: 87, totalTokens: 818 });
    // The same key order the native agent's summary has: it is serialised into subagent results.
    assert.deepEqual(Object.keys(summary as object), ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"]);
  } finally {
    await adapter.close();
  }
});

test("a run that reported no usage emits no usage summary", async () => {
  const adapter = await fakeAdapter((_request, response) => { response.writeHead(200); response.end(line({ done: { finalText: "x" } })); });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    const events = collect(agent);
    await agent.execute("go");
    assert.equal(events.some((event) => event.type === "usage"), false);
  } finally {
    await adapter.close();
  }
});

test("a tool call from the adapter runs the real tool here and is reported as tool events", async () => {
  let bridgeStatus = 0;
  let bridgeReply: any;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    // As the real adapter does: report the model's call, then JiuwenSwarm calls the tool over MCP.
    response.writeHead(200);
    response.write(line({ event: { type: "tool.started", trace: { id: "call-echo-1", name: "echo", args: { word: "ping" }, status: "running" } } }));
    const call = await fetch(body.bridge.url, {
      method: "POST",
      headers: { authorization: `Bearer ${body.bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "echo", arguments: { word: "ping" } }),
    });
    bridgeStatus = call.status;
    bridgeReply = await call.json();
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    const events = collect(agent);
    await agent.execute("go");
    assert.equal(bridgeStatus, 200);
    assert.deepEqual(bridgeReply, { text: "echo:ping", isError: false });
    const start = events.find((event) => event.type === "tool_execution_start") as any;
    const end = events.find((event) => event.type === "tool_execution_end") as any;
    assert.equal(start.toolName, "echo");
    assert.deepEqual(start.args, { word: "ping" });
    assert.equal(start.toolCallId, "call-echo-1", "the tool runs under the id the model gave it");
    assert.equal(end.toolCallId, start.toolCallId);
    assert.equal(end.isError, false);
    assert.equal(end.result.content[0].text, "echo:ping");
  } finally {
    await adapter.close();
  }
});

test("a throwing tool is a tool error, not a failed run", async () => {
  const failing = {
    label: "Boom", name: "boom", description: "Always fails.", parameters: Type.Object({}),
    execute: async () => { throw new Error("disk on fire"); },
  };
  let reply: any;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "tool.started", trace: { id: "call-boom", name: "boom", args: {}, status: "running" } } }));
    const call = await fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "boom", arguments: {} }),
    });
    reply = await call.json();
    response.end(line({ done: { finalText: "carried on" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ extraTools: [failing as never] }));
    const events = collect(agent);
    const result = await agent.execute("go");
    // The standard error shape the native registry produces, so the model sees the same JSON either way.
    assert.equal(reply.isError, true);
    assert.deepEqual(JSON.parse(reply.text), {
      ok: false, error: { attempts: 1, code: "TOOL_EXECUTION_FAILED", message: "disk on fire", retryable: false },
    });
    assert.equal((events.find((event) => event.type === "tool_execution_end") as any).isError, true);
    assert.equal(result.finalMessages.at(-1)!.content, "carried on");
  } finally {
    await adapter.close();
  }
});

test("the bridge refuses a wrong token, an unknown tool and a malformed body", async () => {
  const statuses: number[] = [];
  const adapter = await fakeAdapter(async ({ body }, response) => {
    const post = async (headers: Record<string, string>, payload: string) => (await fetch(body.bridge.url, { method: "POST", headers, body: payload })).status;
    const good = { authorization: `Bearer ${body.bridge.token}` };
    statuses.push(await post({ authorization: "Bearer wrong" }, JSON.stringify({ name: "echo", arguments: {} })));
    statuses.push(await post(good, JSON.stringify({ name: "nope", arguments: {} })));
    statuses.push(await post(good, "{not json"));
    response.writeHead(200);
    response.end(line({ done: { finalText: "" } }));
  });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options()).execute("go");
    assert.deepEqual(statuses, [401, 404, 400]);
  } finally {
    await adapter.close();
  }
});

test("a failed run throws the provider's text so the run can classify it", async () => {
  const adapter = await fakeAdapter((_request, response) => {
    response.writeHead(200);
    response.end(
      line({ event: { type: "run.failed", error: "429 rate limit exceeded", errorCode: "rate-limited" } })
      + line({ done: { finalText: "" } }),
    );
  });
  try {
    await assert.rejects(
      createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options()).execute("go"),
      /429 rate limit exceeded/,
    );
  } finally {
    await adapter.close();
  }
});

test("an adapter that refuses the run is reported with its status", async () => {
  const adapter = await fakeAdapter((_request, response) => {
    response.writeHead(401);
    response.end("unauthorized");
  });
  try {
    await assert.rejects(
      createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options()).execute("go"),
      /adapter refused the run: HTTP 401 unauthorized/,
    );
  } finally {
    await adapter.close();
  }
});

test("abort cancels the run and drops the connection so the adapter stops it", async () => {
  const adapter = await fakeAdapter((_request, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "agent.phase", phase: "thinking", turn: 1 } }));
    // never ends
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    const events = collect(agent);
    const running = agent.execute("go");
    while (!events.length) await new Promise((resolve) => setTimeout(resolve, 10));
    agent.abort();
    await assert.rejects(running, /Agent run cancelled/);
    for (let i = 0; i < 50 && !adapter.aborted(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(adapter.aborted(), true);
  } finally {
    await adapter.close();
  }
});

test("the run timeout aborts a stuck run", async () => {
  const adapter = await fakeAdapter((_request, response) => { response.writeHead(200); response.write(""); });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ runTimeoutMs: 50 }));
    await assert.rejects(agent.execute("go"), /Agent run cancelled/);
  } finally {
    await adapter.close();
  }
});

test("a handle runs once", async () => {
  const adapter = await fakeAdapter((_request, response) => { response.writeHead(200); response.end(line({ done: { finalText: "" } })); });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    await agent.execute("a");
    await assert.rejects(agent.execute("b"), /already been executed/);
  } finally {
    await adapter.close();
  }
});

test("the executor is chosen by SCIENCE_AGENT_EXECUTOR and needs the adapter URL", () => {
  assert.equal(jiuwenSwarmConfigFromEnv({}), undefined);
  assert.equal(jiuwenSwarmConfigFromEnv({ SCIENCE_AGENT_EXECUTOR: "native" }), undefined);
  assert.throws(() => jiuwenSwarmConfigFromEnv({ SCIENCE_AGENT_EXECUTOR: "jiuwenswarm" }), /SCIENCE_AGENT_ADAPTER_URL/);
  assert.deepEqual(
    jiuwenSwarmConfigFromEnv({
      SCIENCE_AGENT_EXECUTOR: "jiuwenswarm", SCIENCE_AGENT_ADAPTER_URL: "http://127.0.0.1:4310/", SCIENCE_AGENT_ADAPTER_TOKEN: "t",
    }),
    { adapterUrl: "http://127.0.0.1:4310", adapterToken: "t" },
  );
});

test("a tool is not run until the adapter has reported the model's call, so the response comes first", async () => {
  const order: string[] = [];
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    // JiuwenSwarm's MCP call arrives *before* the adapter's report of the same call ...
    const call = fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "echo", arguments: { word: "late" } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    // ... which then reports the model call's (empty) response and the call itself.
    response.write(line({ event: { type: "agent.phase", phase: "thinking", turn: 1 } }));
    response.write(line({ event: { type: "assistant.response.started", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "assistant.response.settled", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "tool.started", trace: { id: "call-late", name: "echo", args: { word: "late" }, status: "running" } } }));
    await call;
    response.end(line({ done: { finalText: "" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    agent.subscribe((event) => order.push(event.type));
    await agent.execute("go");
    assert.deepEqual(order, ["turn_start", "response_start", "response_settled", "tool_execution_start", "tool_execution_end"]);
  } finally {
    await adapter.close();
  }
});

test("two calls to the same tool with different arguments are matched to their own model call ids", async () => {
  const started: Array<{ id: string; word: string }> = [];
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    for (const [id, word] of [["call-a", "one"], ["call-b", "two"]]) {
      response.write(line({ event: { type: "tool.started", trace: { id, name: "echo", args: { word }, status: "running" } } }));
    }
    // JiuwenSwarm may call them in either order.
    await Promise.all(["two", "one"].map((word) => fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "echo", arguments: { word } }),
    })));
    response.end(line({ done: { finalText: "" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    agent.subscribe((event) => {
      if (event.type === "tool_execution_start") started.push({ id: event.toolCallId, word: String((event.args as { word: string }).word) });
    });
    await agent.execute("go");
    assert.deepEqual(started.sort((a, b) => a.word.localeCompare(b.word)), [{ id: "call-a", word: "one" }, { id: "call-b", word: "two" }]);
  } finally {
    await adapter.close();
  }
});

test("the run leaves the model-facing transcript of its tool round, as the native agent does", async () => {
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "assistant.response.started", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "assistant.response.settled", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "tool.started", trace: { id: "call-1", name: "echo", input: "{\"word\": \"hi\"}", args: { word: "hi" }, status: "running" } } }));
    await fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "echo", arguments: { word: "hi" } }),
    });
    response.write(line({ event: { type: "assistant.response.started", responseId: "r2", turn: 2 } }));
    response.write(line({ event: { type: "assistant.delta", delta: "It said hi.", responseId: "r2" } }));
    response.write(line({ event: { type: "assistant.response.settled", responseId: "r2", turn: 2 } }));
    response.end(line({ done: { finalText: "It said hi." } }));
  });
  try {
    const result = await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options()).execute("say hi");
    assert.deepEqual(result.finalMessages, [
      { role: "user", content: "say hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "echo", arguments: "{\"word\":\"hi\"}" } }] },
      { role: "tool", tool_call_id: "call-1", name: "echo", content: "echo:hi" },
      { role: "assistant", content: "It said hi." },
    ]);
  } finally {
    await adapter.close();
  }
});

test("a tool nobody reported still runs (under a generated id) instead of hanging the run", async () => {
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    const call = await fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "echo", arguments: { word: "orphan" } }),
    });
    assert.equal(call.status, 200);
    response.end(line({ done: { finalText: "" } }));
  });
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, toolAnnouncementTimeoutMs: 200 } as never)(options());
    const events = collect(agent);
    await agent.execute("go");
    assert.equal(events.some((event) => event.type === "tool_execution_end"), true);
  } finally {
    console.warn = warn;
    await adapter.close();
  }
});

test("the tool runs with the model's own arguments even though JiuwenSwarm added defaults and dropped empties", async () => {
  const seen: unknown[] = [];
  const probe = {
    label: "Probe", name: "probe", description: "Records what it was called with.",
    parameters: Type.Object({ word: Type.String(), extra: Type.Optional(Type.Number()), list: Type.Optional(Type.Array(Type.String())) }),
    execute: async (_id: string, params: unknown) => { seen.push(params); return { content: [{ type: "text" as const, text: "ok" }] }; },
  };
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    // the model sent {word, list: []}; JiuwenSwarm calls the tool with {word, extra: 7200} (default added, empty list dropped)
    response.write(line({ event: { type: "tool.started", trace: { id: "call-p", name: "probe", args: { word: "w", list: [] }, status: "running" } } }));
    await fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "probe", arguments: { word: "w", extra: 7200 } }),
    });
    response.end(line({ done: { finalText: "" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ extraTools: [probe as never] }));
    const events = collect(agent);
    await agent.execute("go");
    assert.deepEqual(seen, [{ word: "w", list: [] }]);
    const start = events.find((event) => event.type === "tool_execution_start") as { args: unknown; toolCallId: string };
    assert.deepEqual(start.args, { word: "w", list: [] });
    assert.equal(start.toolCallId, "call-p");
  } finally {
    await adapter.close();
  }
});

test("tool details in the run's events are sanitised and bounded like the native agent's", async () => {
  const leaky = {
    label: "Leaky", name: "leaky", description: "Returns details with a secret and a payload.", parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: "done" }], details: { apiKey: "sk-secret-value", stdout: "fine", note: "kept" } }),
  };
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "tool.started", trace: { id: "call-l", name: "leaky", args: {}, status: "running" } } }));
    await fetch(body.bridge.url, { method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` }, body: JSON.stringify({ name: "leaky", arguments: {} }) });
    response.end(line({ done: { finalText: "" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ extraTools: [leaky as never] }));
    const events = collect(agent);
    await agent.execute("go");
    const end = events.find((event) => event.type === "tool_execution_end") as { result: { details: Record<string, unknown> } };
    assert.equal(end.result.details.apiKey, "[redacted]", "secrets are redacted before they reach a run event");
    assert.equal(end.result.details.stdout, "[omitted]", "payload fields are left out of run events");
    assert.equal((end.result.details.__detailsBoundary as { omittedPayloadFields: boolean }).omittedPayloadFields, true);
  } finally {
    await adapter.close();
  }
});

test("deferred tools (custom MCP) are callable at once, and tool_search is offered and answers", async () => {
  const bulky = {
    label: "Bulky", name: "mcp__custom-1__bulky", description: "A deferred MCP tool.", deferred: true,
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_id: string, params: { text: string }) => ({ content: [{ type: "text" as const, text: `bulky:${params.text}` }] }),
  };
  let offered: string[] = [];
  let direct: any;
  let searched: any;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    offered = body.tools.map((tool: { name: string }) => tool.name);
    response.writeHead(200);
    const call = (name: string, args: unknown) => fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` }, body: JSON.stringify({ name, arguments: args }),
    }).then((reply) => reply.json());
    response.write(line({ event: { type: "tool.started", trace: { id: "c-search", name: "tool_search", args: { query: "select:mcp__custom-1__bulky" }, status: "running" } } }));
    searched = await call("tool_search", { query: "select:mcp__custom-1__bulky" });
    response.write(line({ event: { type: "tool.started", trace: { id: "c-bulky", name: "mcp__custom-1__bulky", args: { text: "hi" }, status: "running" } } }));
    direct = await call("mcp__custom-1__bulky", { text: "hi" });
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ extraTools: [bulky as never] }));
    await agent.execute("use it");
    assert.ok(offered.includes("mcp__custom-1__bulky"), `offered: ${offered.join(", ")}`);
    assert.ok(offered.includes("tool_search"));
    assert.equal(searched.isError, false, searched.text);
    assert.match(searched.text, /mcp__custom-1__bulky/);
    assert.deepEqual(direct, { text: "bulky:hi", isError: false });
  } finally {
    await adapter.close();
  }
});

test("a run with no deferred tools is not offered tool_search", async () => {
  let offered: string[] = [];
  const adapter = await fakeAdapter(async ({ body }, response) => {
    offered = body.tools.map((tool: { name: string }) => tool.name);
    response.writeHead(200);
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options()).execute("go");
    assert.ok(!offered.includes("tool_search"), offered.join(", "));
  } finally {
    await adapter.close();
  }
});

test("the API's history is sent as OpenAI messages, so a resumed conversation continues", async () => {
  let sent: any[] = [];
  const adapter = await fakeAdapter(async ({ body }, response) => {
    sent = body.history;
    response.writeHead(200);
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const history = [
      { role: "user", content: "run it" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "echo", args: { word: "a" } }] },
      { role: "tool", tool_call_id: "c1", name: "echo", content: "echo:a", additional_kwargs: { tool_output: {} } },
      { role: "system", content: "dropped" },
      { role: "assistant", content: "done", tool_calls: [{ id: "c2", type: "function", function: { name: "echo", arguments: "{\"word\":\"b\"}" } }] },
    ];
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ gatewayHistory: history as never })).execute("next");
    assert.deepEqual(sent, [
      { role: "user", content: "run it" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: "{\"word\":\"a\"}" } }] },
      { role: "tool", content: "echo:a", tool_call_id: "c1", name: "echo" },
      { role: "assistant", content: "done", tool_calls: [{ id: "c2", type: "function", function: { name: "echo", arguments: "{\"word\":\"b\"}" } }] },
    ]);
  } finally {
    await adapter.close();
  }
});

test("a first turn sends an empty history, not none", async () => {
  let sent: unknown;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    sent = body.history;
    response.writeHead(200);
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options()).execute("hi");
    assert.deepEqual(sent, []);
  } finally {
    await adapter.close();
  }
});

test("the tools offered are exactly the native registry's, every one with its own schema (plus tool_search when some are deferred)", async () => {
  const planStore = { latest: async () => undefined, update: async () => ({ id: "p", steps: [] }) as never };
  const deferredTool = {
    label: "D", name: "mcp__custom-2__d", description: "deferred", deferred: true,
    parameters: Type.Object({ q: Type.String() }), execute: async () => ({ content: [{ type: "text" as const, text: "" }] }),
  };
  const opts = options({ planStore: planStore as never, extraTools: [deferredTool as never] });
  const durable = new DurableContextStore({ history: [] });
  const plugins = await startPluginScope(opts, durable, new AbortController().signal);
  const registry = createToolRegistry(opts, plugins, durable);
  const expected = new Map(registry.values().map((tool) => [tool.name, tool]));
  await plugins.dispose();
  let offered: Array<{ name: string; inputSchema: unknown }> = [];
  const adapter = await fakeAdapter(async ({ body }, response) => {
    offered = body.tools;
    response.writeHead(200);
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(opts).execute("go");
    const names = offered.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...expected.keys(), "tool_search"].sort());
    for (const tool of offered) {
      if (tool.name === "tool_search") continue;
      assert.deepEqual(tool.inputSchema, JSON.parse(JSON.stringify(expected.get(tool.name)!.parameters)), `schema of ${tool.name}`);
    }
    assert.ok(names.includes("update_plan"), "a plugin's tool is among them");
    assert.ok(names.includes("mcp__custom-2__d"), "and so is a deferred one");
  } finally {
    await adapter.close();
  }
});

/** Tools that log when they start and end, so overlap is visible. */
function timedTools(log: string[], concurrencySafe: boolean) {
  const make = (name: string, ms: number) => ({
    label: name, name, description: name, parameters: Type.Object({}),
    ...(concurrencySafe ? { isConcurrencySafe: () => true } : {}),
    execute: async () => {
      log.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      log.push(`${name}:end`);
      return { content: [{ type: "text" as const, text: name }] };
    },
  });
  return [make("slow_a", 60), make("fast_b", 5)];
}

/** One model response with two tool calls; JiuwenSwarm calls them side by side, the second one first. */
async function respondWithTwoCalls(names: [string, string], calls: Array<{ args?: unknown; name: string }>, script?: { reverse?: boolean }) {
  return await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "assistant.response.started", responseId: "r1", turn: 1 } }));
    calls.forEach((call, index) => response.write(line({ event: { type: "tool.started", trace: { id: `c${index + 1}`, name: call.name, args: call.args ?? {}, status: "running" } } })));
    const send = (call: { args?: unknown; name: string }) => fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` }, body: JSON.stringify({ name: call.name, arguments: call.args ?? {} }),
    }).then((reply) => reply.json());
    await Promise.all((script?.reverse === false ? calls : [...calls].reverse()).map(send));
    response.end(line({ done: { finalText: "ok" } }));
  });
}

test("tools not declared concurrency-safe run one at a time, in the order the model called them", async () => {
  const log: string[] = [];
  const adapter = await respondWithTwoCalls(["slow_a", "fast_b"], [{ name: "slow_a" }, { name: "fast_b" }]);
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ extraTools: timedTools(log, false) as never })).execute("go");
    assert.deepEqual(log, ["slow_a:start", "slow_a:end", "fast_b:start", "fast_b:end"]);
  } finally {
    await adapter.close();
  }
});

test("tools declared concurrency-safe may overlap", async () => {
  const log: string[] = [];
  const adapter = await respondWithTwoCalls(["slow_a", "fast_b"], [{ name: "slow_a" }, { name: "fast_b" }]);
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ extraTools: timedTools(log, true) as never })).execute("go");
    assert.equal(log.indexOf("fast_b:end") < log.indexOf("slow_a:end"), true, log.join(" "));
  } finally {
    await adapter.close();
  }
});

test("two update_plan calls in one response: the earlier one is superseded, as in the native loop", async () => {
  const updates: unknown[] = [];
  const planStore = { latest: async () => undefined, update: async (input: unknown) => { updates.push(input); return { id: "p", steps: [] } as never; } };
  const first = { plan: [{ step: "first", status: "pending" }] };
  const second = { plan: [{ step: "second", status: "pending" }] };
  const adapter = await respondWithTwoCalls(["update_plan", "update_plan"], [{ name: "update_plan", args: first }, { name: "update_plan", args: second }]);
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ planStore: planStore as never })).execute("plan");
    assert.deepEqual(updates, [{ plan: [{ status: "pending", step: "second" }] }]);
  } finally {
    await adapter.close();
  }
});

test("an earlier call that never reaches the bridge does not hold up the later one for ever", async () => {
  const log: string[] = [];
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "assistant.response.started", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "tool.started", trace: { id: "c1", name: "slow_a", args: {}, status: "running" } } }));
    response.write(line({ event: { type: "tool.started", trace: { id: "c2", name: "fast_b", args: {}, status: "running" } } }));
    await fetch(body.bridge.url, { method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` }, body: JSON.stringify({ name: "fast_b", arguments: {} }) });
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, toolAnnouncementTimeoutMs: 100 })(options({ extraTools: timedTools(log, false) as never })).execute("go");
    assert.deepEqual(log, ["fast_b:start", "fast_b:end"]);
  } finally {
    await adapter.close();
  }
});

test("the run's timeout is passed on as the longest a single tool call may take", async () => {
  let sent: any;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    sent = body;
    response.writeHead(200);
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ runTimeoutMs: 90_000 })).execute("go");
    assert.equal(sent.toolTimeoutSeconds, 90);
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options()).execute("go");
    assert.equal("toolTimeoutSeconds" in sent, false);
  } finally {
    await adapter.close();
  }
});

test("provider fields in the API's history (thinking blocks, reasoning items) go to the adapter untouched", async () => {
  let sent: any[] = [];
  const adapter = await fakeAdapter(async ({ body }, response) => {
    sent = body.history;
    response.writeHead(200);
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const history = [
      { role: "user", content: "run it" },
      { role: "assistant", content: "", anthropic_content: [{ type: "thinking", thinking: "t", signature: "s" }], tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: "{}" }, response_item_id: "fc-1" }],
        response_items: [{ type: "reasoning", id: "rs-1" }] },
      { role: "tool", tool_call_id: "c1", name: "echo", content: "out", additional_kwargs: { tool_output: { big: true } } },
    ];
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ gatewayHistory: history as never })).execute("next");
    assert.deepEqual(sent[1].anthropic_content, [{ type: "thinking", thinking: "t", signature: "s" }]);
    assert.deepEqual(sent[1].response_items, [{ type: "reasoning", id: "rs-1" }]);
    assert.equal(sent[1].tool_calls[0].response_item_id, "fc-1");
    assert.equal("additional_kwargs" in sent[2], false, "bookkeeping of the API's own is not sent");
  } finally {
    await adapter.close();
  }
});
