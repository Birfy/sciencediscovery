//!/usr/bin/env bash
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

/**
 * A scripted OpenAI-compatible chat-completions endpoint for L2 scenarios.
 *
 * steps.main and steps.subagent are lists consumed one per model request that
 * offers tools (a request without tools is a title/summary call and gets a fixed
 * reply). Requests are told apart by the product's subagent preset marker in the
 * system prompt, as the journeys' stub does. A step is one of:
 *   { text: "..." }                       stream that text
 *   { tool: "run_shell", arguments: {} }  stream one tool call
 *   { fail: 429 }                         answer with that HTTP status
 * and may carry delayMs (wait before answering).
 */

import { createServer } from "node:http";

const SUBAGENT_MARKER = "Applied subagent preset general-purpose";

const chunk = (id, delta, finish = null) => ({
  choices: [{ delta, finish_reason: finish, index: 0 }], created: 1, id, model: "contract-stub", object: "chat.completion.chunk",
});

export async function startStubModel(steps = {}) {
  const queues = { main: [...(steps.main ?? [])], subagent: [...(steps.subagent ?? [])] };
  const requests = [];
  const consumed = { main: 0, subagent: 0 };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (part) => chunks.push(part));
    request.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const id = `chatcmpl-contract-${requests.length + 1}`;
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      const finish = () => response.end("data: [DONE]\n\n");
      if (!body.tools?.length) {
        // A title or summary call: fixed reply, does not consume a scripted step.
        requests.push({ route: "title" });
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        send(chunk(id, { role: "assistant", content: "Contract session" }));
        send({ ...chunk(id, {}, "stop"), usage: { completion_tokens: 3, prompt_tokens: 10, total_tokens: 13 } });
        finish();
        return;
      }
      const system = String(body.messages?.find((message) => message.role === "system")?.content ?? "");
      const route = system.includes(SUBAGENT_MARKER) ? "subagent" : "main";
      const step = queues[route].shift();
      if (step) consumed[route] += 1;
      requests.push({ route, step });
      if (!step) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `no scripted ${route} step left` } }));
        return;
      }
      if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      if (step.fail) {
        response.writeHead(step.fail, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `scripted failure ${step.fail}` } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (step.tool) {
        send(chunk(id, { role: "assistant", tool_calls: [{ index: 0, id: `call-${route}-${consumed[route]}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.arguments ?? {}) } }] }));
        send({ ...chunk(id, {}, "tool_calls"), usage: { completion_tokens: 8, prompt_tokens: 20, total_tokens: 28 } });
      } else {
        for (const word of String(step.text ?? "").split(/(?<= )/)) send(chunk(id, { role: "assistant", content: word }));
        send({ ...chunk(id, {}, "stop"), usage: { completion_tokens: 8, prompt_tokens: 20, total_tokens: 28 } });
      }
      finish();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: "contract-stub",
    apiToken: "contract-stub-token",
    requests,
    remaining: () => ({ main: queues.main.length, subagent: queues.subagent.length }),
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}
