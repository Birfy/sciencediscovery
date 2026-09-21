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

import type { ModelTurn } from "@sciencediscovery/model";
import type { AgentEventEvidence } from "@sciencediscovery/schema";

import type { NativeAgentOptions } from "../native-agent/index.js";
import { AgentVersionRecorder } from "../native-agent/versioning.js";

/** What the model was given for one call: the system prompt, the conversation and the tools, as sent. */
export interface ModelCallInput {
  history: unknown[];
  systemPrompt: string;
  tools: unknown[];
}

/**
 * The run's trajectory, recorded as the built-in loop records it, for the JiuwenSwarm executor.
 *
 * JiuwenSwarm owns the loop, but every model call passes through the run's model gateway and every tool result
 * through this process, so the same `AgentVersionRecorder` records each turn: the exact model input before the
 * call, the model's answer after it, the tool observations, and the step once the next call (or the end of the
 * run) shows the turn is over. Events are tagged with the recorder's evidence, which is how the trajectory view
 * ties them to the model input they belong to.
 */
export class JiuwenSwarmTrajectory {
  private readonly recorder?: AgentVersionRecorder<never, ModelCallInput, unknown>;
  private turn = 0;
  private sequence = 0;
  private pending?: { history: unknown[]; modelTurn: ModelTurn; turn: number };
  private readonly results = new Map<string, { content: string; details?: unknown; isError: boolean }>();
  private queue = Promise.resolve();

  constructor(options: NativeAgentOptions, readRuntime: () => unknown = () => ({ executor: "jiuwenswarm" })) {
    if (options.versioning) {
      this.recorder = new AgentVersionRecorder(options.config.dataDir, options.workspaceRoot, options.versioning, readRuntime);
    }
  }

  get enabled(): boolean {
    return Boolean(this.recorder);
  }

  async start(behavior: unknown): Promise<void> {
    await this.recorder?.initialize(behavior, []);
  }

  /** Serialized: JiuwenSwarm can overlap requests (a title while the turn runs); the recorder takes one at a time. */
  private run(step: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(step, step);
    return this.queue;
  }

  /** A model call is about to be made: the turn before it is over, and this one begins with its exact input. */
  modelRequest(input: ModelCallInput): Promise<void> {
    if (!this.recorder) return Promise.resolve();
    return this.run(async () => {
      await this.commitPending();
      this.turn += 1;
      const history = input.history as never[];
      await this.recorder!.beforeTurn({ turn: this.turn, history });
      await this.recorder!.afterAssembly({ turn: this.turn, assembly: { history, modelInput: input } });
    });
  }

  /** The model answered the current call. */
  modelCompleted(turn: ModelTurn, history: unknown[]): Promise<void> {
    if (!this.recorder) return Promise.resolve();
    return this.run(async () => {
      await this.recorder!.modelCompleted(turn);
      this.pending = { history: [...history, turn.assistantMessage], modelTurn: turn, turn: this.turn };
    });
  }

  /** A tool finished (one of ours, through the bridge, or one of JiuwenSwarm's own). */
  async observe(input: { call: { args: unknown; id: string; name: string }; content: string; details?: unknown; isError: boolean }): Promise<void> {
    if (!this.recorder) return;
    this.results.set(input.call.id, { content: input.content, isError: input.isError, ...(input.details !== undefined ? { details: input.details } : {}) });
    await this.recorder.recordObservation({ ...input, call: input.call as never, sequence: this.sequence++ });
  }

  /** The evidence an event carries: which run, turn, response and model input it belongs to. */
  evidence(event: { type: string; responseId?: unknown; turn?: unknown }): AgentEventEvidence | undefined {
    if (!this.recorder) return undefined;
    const runEvent = event.type === "response_start" ? { type: "response_start", responseId: String(event.responseId), turn: Number(event.turn) } : { type: event.type };
    return this.recorder.event(runEvent as never);
  }

  /** The run ended: commit the last turn and let the records reach the run's stream. */
  finish(): Promise<void> {
    if (!this.recorder) return Promise.resolve();
    return this.run(async () => {
      try {
        await this.commitPending();
        await this.recorder!.flushEvents();
      } finally {
        this.recorder!.close();
      }
    });
  }

  private async commitPending(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    const results = pending.modelTurn.toolCalls.map((call) => {
      const result = this.results.get(call.id) ?? { content: "", isError: true };
      return {
        content: result.content, isError: result.isError, ...(result.details !== undefined ? { details: result.details } : {}),
        message: { role: "tool", tool_call_id: call.id, content: result.content },
      };
    });
    await this.recorder!.afterTurn({
      turn: pending.turn, history: pending.history as never[], modelTurn: pending.modelTurn as never, results: results as never,
    });
  }
}
