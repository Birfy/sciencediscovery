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

import type { NativeAgentOptions } from "../native-agent/index.js";
import {
  createJiuwenSwarmAgentFactory,
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
    assert.deepEqual(body.model, { model: "gpt-x", baseUrl: "http://llm.test/v1", apiKey: "sk-test", provider: "OpenAI" });
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
    const call = await fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "update_plan", arguments: { plan: [{ step: "Do it", status: "in_progress" }] } }),
    });
    reply = await call.json();
    response.writeHead(200);
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

test("reported token usage becomes a model_usage event the run can record", async () => {
  const adapter = await fakeAdapter((_request, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "model.usage", usage: { inputTokens: 731, outputTokens: 87, totalTokens: 818, cacheReadTokens: 0, cacheWriteTokens: null }, reasoningTokens: 71 } }));
    response.end(line({ done: { finalText: "" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    const events = collect(agent);
    await agent.execute("go");
    assert.deepEqual(events, [{
      type: "model_usage", usageReported: true,
      usage: { inputTokens: 731, outputTokens: 87, totalTokens: 818, cacheReadTokens: 0, cacheWriteTokens: null },
    }]);
  } finally {
    await adapter.close();
  }
});

test("a tool call from the adapter runs the real tool here and is reported as tool events", async () => {
  let bridgeStatus = 0;
  let bridgeReply: any;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    const call = await fetch(body.bridge.url, {
      method: "POST",
      headers: { authorization: `Bearer ${body.bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "echo", arguments: { word: "ping" } }),
    });
    bridgeStatus = call.status;
    bridgeReply = await call.json();
    response.writeHead(200);
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
    const call = await fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "boom", arguments: {} }),
    });
    reply = await call.json();
    response.writeHead(200);
    response.end(line({ done: { finalText: "carried on" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ extraTools: [failing as never] }));
    const events = collect(agent);
    const result = await agent.execute("go");
    assert.deepEqual(reply, { text: "disk on fire", isError: true });
    assert.equal((events.find((event) => event.type === "tool_execution_end") as any).isError, true);
    assert.equal(result.finalMessages[1]!.content, "carried on");
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
