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

/**
 * Live checks of what only the JiuwenSwarm executor does (there is nothing to compare with on the
 * built-in loop, so they are not L2 cases). Run against a stack started with the adapter and
 * SCIENCE_AGENT_EXECUTOR=jiuwenswarm:
 *
 *   E2E_BASE_URL=http://127.0.0.1:4310 E2E_API_TOKEN=... node test/contract/jw-only/live.mjs history
 *   node test/contract/jw-only/live.mjs todo-plan
 *
 *   LIVE_RESTART_CMD='scripts/jiuwenswarm.sh stop && scripts/jiuwenswarm.sh start' ... live.mjs history-restart
 *
 * Each check builds its own project, model and scripted model, and deletes them.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

import { startStubModel } from "../stub-model.mjs";

const run = promisify(exec);
const base = process.env.E2E_BASE_URL;
const token = process.env.E2E_API_TOKEN;
if (!base || !token) throw new Error("Need E2E_BASE_URL and E2E_API_TOKEN");

async function api(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

async function setup(stub, modelExtras = {}) {
  const model = await api("POST", "/api/models", { vision: false, apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `live ${Date.now()}`, ...modelExtras });
  const project = await api("POST", "/api/projects", { name: `live ${Date.now()}` });
  const sessionId = project.firstSession.id;
  await api("PATCH", `/api/sessions/${sessionId}`, { modelId: model.id, title: "live" });
  await api("PATCH", `/api/sessions/${sessionId}`, { approvalMode: "always_allow" });
  const cleanup = async () => {
    await api("DELETE", `/api/projects/${project.id}`, { confirmationId: project.id }).catch(() => undefined);
    await api("DELETE", `/api/models/${model.id}`).catch(() => undefined);
    await stub.stop();
  };
  return { sessionId, cleanup };
}

async function runAndWait(sessionId, content) {
  const run = await api("POST", `/api/sessions/${sessionId}/runs`, { content });
  for (let i = 0; i < 240; i += 1) {
    const current = await api("GET", `/api/sessions/${sessionId}/runs/${run.id}`);
    if (["completed", "failed", "cancelled", "interrupted"].includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("run did not finish");
}

const runEvents = async (sessionId, runId) => (await api("GET", `/api/sessions/${sessionId}/runs/${runId}/events`)).map((entry) => entry.event ?? entry);

const checks = {
  /** The second turn of a conversation reaches the model with the first turn in its context. */
  async history() {
    const stub = await startStubModel({ main: [{ text: "First answer." }, { text: "Second answer." }] });
    const { sessionId, cleanup } = await setup(stub);
    try {
      await runAndWait(sessionId, "My favourite number is 4711.");
      const second = await runAndWait(sessionId, "What did I say my favourite number was?");
      if (second.status !== "completed") throw new Error(`second run ${second.status}: ${second.error}`);
      const tail = stub.requests.filter((request) => request.route === "main").length;
      if (tail !== 2) throw new Error(`expected 2 model requests, saw ${tail}`);
      const seen = stub.lastMessages?.() ?? [];
      const text = JSON.stringify(seen);
      if (!text.includes("4711")) throw new Error("the second request did not carry the first turn");
      console.log(`history: ok (the second model request had ${seen.length} messages and the first turn in them)`);
    } finally {
      await cleanup();
    }
  },

  /** The conversation is still in JiuwenSwarm's context after JiuwenSwarm itself was restarted between two turns. */
  async "history-restart"() {
    const restart = process.env.LIVE_RESTART_CMD;
    if (!restart) throw new Error("history-restart needs LIVE_RESTART_CMD, the command that restarts JiuwenSwarm");
    const stub = await startStubModel({ main: [{ text: "First answer." }, { text: "Second answer." }] });
    const { sessionId, cleanup } = await setup(stub);
    try {
      await runAndWait(sessionId, "My favourite number is 4711.");
      // Asynchronously: the scripted model lives in this process and must keep answering while JiuwenSwarm restarts.
      await run(restart, { shell: "/bin/bash", timeout: 300_000 });
      const second = await runAndWait(sessionId, "What did I say my favourite number was?");
      if (second.status !== "completed") throw new Error(`second run ${second.status}: ${second.error}`);
      const seen = stub.lastMessages?.() ?? [];
      if (!JSON.stringify(seen).includes("4711")) throw new Error(`after the restart the second request did not carry the first turn (${seen.length} messages)`);
      console.log(`history-restart: ok (after restarting JiuwenSwarm the second request still had the first turn among its ${seen.length} messages)`);
    } finally {
      await cleanup();
    }
  },

  /**
   * JiuwenSwarm compresses the conversation when its window fills. The stack must have been started with
   * JIUWENSWARM_CONTEXT_WINDOW_TOKENS=3000 (the only window setting JiuwenSwarm 0.2.6 honours); six turns of
   * about 750 tokens each are sent: by the last request the early turns must be gone or summarised, while
   * the newest is there in full.
   */
  async compression() {
    const stub = await startStubModel({ main: Array.from({ length: 30 }, (_, index) => ({ text: `Answer ${index + 1}.` })) });
    const { sessionId, cleanup } = await setup(stub);
    try {
      const turns = 6;
      for (let turn = 1; turn <= turns; turn += 1) {
        const run = await runAndWait(sessionId, `TURN-${turn}-MARK ${"lorem ipsum dolor ".repeat(170)}`);
        if (run.status !== "completed") throw new Error(`turn ${turn} ${run.status}: ${run.error}`);
      }
      const seen = JSON.stringify(stub.lastMessages?.() ?? []);
      const present = Array.from({ length: turns }, (_, index) => index + 1).filter((turn) => seen.includes(`TURN-${turn}-MARK`));
      const sent = turns * 3000;
      console.log(`compression: last request ${seen.length} chars for ${sent} sent; turns still present in full: ${present.join(",") || "none"}`);
      if (!present.includes(turns)) throw new Error("the newest turn is missing from the last request");
      // The size of the request is not a test: JiuwenSwarm's own system prompt is part of it.
      if (present.length === turns) throw new Error("nothing was compressed: every turn is still there");
    } finally {
      await cleanup();
    }
  },

  /**
   * Each run registers its tools under a new server name, and JiuwenSwarm keeps the session's history across
   * runs. By the second run's model request, the first run's tool call must be there under its plain name.
   */
  async "history-names"() {
    const stub = await startStubModel({ main: [
      { tool: "run_shell", arguments: { command: "echo FIRST" } }, { text: "First done." },
      { tool: "run_shell", arguments: { command: "echo SECOND" } }, { text: "Second done." },
    ] });
    const { sessionId, cleanup } = await setup(stub);
    try {
      for (const text of ["Run the first command.", "Run the second command."]) {
        const run = await runAndWait(sessionId, text);
        if (run.status !== "completed") throw new Error(`run ${run.status}: ${run.error}`);
      }
      const seen = JSON.stringify(stub.lastMessages?.() ?? []);
      const stale = seen.match(/mcp_sci[0-9a-z]{10}_\w+/g) ?? [];
      if (stale.length) throw new Error(`prefixed tool names reached the model: ${[...new Set(stale)].join(", ")}`);
      if (!seen.includes("echo FIRST")) throw new Error("the first run's tool call is not in the history");
      console.log("history-names: ok (the first run's tool call reached the second run's model under its plain name)");
    } finally {
      await cleanup();
    }
  },

  /** One of JiuwenSwarm's own tools (bash) runs, and the run shows it as a tool call with its output. */
  async "native-tools"() {
    const stub = await startStubModel({ main: [{ tool: "bash", arguments: { command: "echo JW-BASH-OK" } }, { text: "Ran it." }] });
    const { sessionId, cleanup } = await setup(stub);
    try {
      const run = await runAndWait(sessionId, "Run echo.");
      if (run.status !== "completed") throw new Error(`run ${run.status}: ${run.error}`);
      const offered = JSON.stringify(stub.requests.at(-1) ?? {});
      const events = await runEvents(sessionId, run.id);
      const started = events.find((event) => event.type === "tool.started");
      const completed = events.find((event) => event.type === "tool.completed");
      if (started?.trace?.name !== "bash") throw new Error(`no bash tool call in the run: ${events.map((e) => e.type).join(" ")}`);
      // A tool's output is kept in its own stream; the completed event only points at it.
      const stream = completed?.trace?.outputStream;
      const output = stream ? await api("GET", `/api/sessions/${sessionId}/runs/${run.id}/streams/${stream}/events`) : [];
      if (!JSON.stringify(output).includes("JW-BASH-OK")) throw new Error(`bash output missing from ${stream}: ${JSON.stringify(output).slice(0, 300)}`);
      console.log("native-tools: ok (JiuwenSwarm's bash ran and its output is in the run's tool card)");
    } finally {
      await cleanup();
    }
  },

  /** JiuwenSwarm's own todo tool drives the plan (the default; not with SCIENCE_AGENT_JIUWENSWARM_PLANNING=update_plan). */
  async "todo-plan"() {
    const tasks = [
      { id: "search", content: "Search the literature", activeForm: "Searching", description: "find sources" },
      { id: "write", content: "Write the summary", activeForm: "Writing", description: "summarise" },
    ];
    const stub = await startStubModel({ main: [{ tool: "todo_create", arguments: { tasks, call_goal: "plan" } }, { text: "Planned." }] });
    const { sessionId, cleanup } = await setup(stub);
    try {
      const run = await runAndWait(sessionId, "Plan the work.");
      if (run.status !== "completed") throw new Error(`run ${run.status}: ${run.error}`);
      const events = await runEvents(sessionId, run.id);
      const types = events.map((event) => event.type);
      const plans = events.filter((event) => event.type === "plan.updated");
      if (!plans.length) throw new Error(`no plan.updated event; events: ${types.join(" ")}`);
      const steps = JSON.stringify(plans.at(-1));
      for (const wanted of ["Search the literature", "Write the summary", "in_progress"]) {
        if (!steps.includes(wanted)) throw new Error(`plan lacks ${wanted}: ${steps.slice(0, 300)}`);
      }
      const started = events.find((event) => event.type === "tool.started");
      if (started?.trace?.name !== "todo_create") throw new Error(`the todo call is not shown as a tool: ${JSON.stringify(started)?.slice(0, 200)}`);
      console.log("todo-plan: ok (todo_create shown as a tool call, plan.updated carries both steps)");
    } finally {
      await cleanup();
    }
  },
};

const wanted = process.argv.slice(2);
try {
  for (const name of wanted.length ? wanted : Object.keys(checks)) {
    if (!checks[name]) throw new Error(`unknown check ${name}; known: ${Object.keys(checks).join(", ")}`);
    await checks[name]();
  }
} catch (error) {
  console.error(`FAILED: ${error instanceof Error ? error.message : error}${error?.cause?.message ? ` (${error.cause.message})` : ""}`);
  process.exit(1);
}
