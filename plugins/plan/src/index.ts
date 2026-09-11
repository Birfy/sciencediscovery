// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createHash } from "node:crypto";
import { canonicalState, type AgentScope } from "@sciencediscovery/context";
import { createPlanTool, createPlanBatchPolicy, createPlanContextFactory, type PlanStore } from "@sciencediscovery/plan";
import type { RuntimeMessage } from "@sciencediscovery/runtime-core";
import type { PluginDefinition } from "@sciencediscovery/plugin-sdk";
import type { RuntimeContribution } from "@sciencediscovery/plugin-sdk/runtime";

export const manifest = Object.freeze({ id: "plan", version: "0.1.0", apiVersion: 1 as const, capabilities: ["plan.snapshot"] });
export function planPlugin<M extends RuntimeMessage>(store: PlanStore, scopes: readonly AgentScope[]): PluginDefinition<RuntimeContribution<M>> {
  return {
    manifest,
    create: () => ({
      contribution: {
        tools: [createPlanTool({ store })],
        batchPolicies: [createPlanBatchPolicy()],
        contextFactories: [createPlanContextFactory<M>(store, scopes)],
        stateProviders: [{
          id: "plan",
          async capture(signal) {
            const value = JSON.parse(JSON.stringify(await store.latest(signal) ?? null)) as unknown;
            return { id: "plan", schemaVersion: 1, revision: createHash("sha256").update(canonicalState(value)).digest("hex"), value, fidelity: "captured" };
          },
        }],
      },
    }),
  };
}
