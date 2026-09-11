// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createPluginScope, type PluginDefinition } from "@sciencediscovery/plugin-sdk";
import { planPlugin } from "@sciencediscovery/plugin-plan";
import { skillPlugin } from "@sciencediscovery/plugin-skill";
import { mcpPlugin } from "@sciencediscovery/plugin-mcp";
import { schedulerPlugin } from "@sciencediscovery/plugin-scheduler";
import type { RuntimeContribution } from "@sciencediscovery/plugin-sdk/runtime";
import type { WorkspaceAgentOptions } from "@sciencediscovery/workspace";
import type { PlanStore } from "@sciencediscovery/plan";
import { createEvolveTools, type EvolveToolRuntime } from "@sciencediscovery/evolve";
import type { AgentScope, DurableContextStore } from "@sciencediscovery/context";
import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

/** Build-time installation. Providers receive only their own domain ports. */
export function runtimePluginDefinitions<M extends RuntimeMessage>(options: {
  scope: AgentScope;
  workspace: WorkspaceAgentOptions;
  durable: DurableContextStore;
  planStore?: PlanStore;
  evolve?: EvolveToolRuntime;
}): PluginDefinition<RuntimeContribution<M>>[] {
  return [
    skillPlugin<M>({ skills: options.workspace.skills ?? [], createSkill: options.workspace.createSkill,
      proposeSkillLibraryUpdate: options.workspace.proposeSkillLibraryUpdate,
      publishSkillLibraryUpdate: options.workspace.publishSkillLibraryUpdate,
      toolPolicy: options.workspace.toolPolicy, durable: options.durable, scope: options.scope }),
    mcpPlugin<M>({ mcpTools: options.workspace.mcpTools, toolPolicy: options.workspace.toolPolicy }),
    schedulerPlugin<M>({ runSubagent: options.workspace.runSubagent, specialists: options.workspace.specialists, toolPolicy: options.workspace.toolPolicy }),
    ...(options.planStore ? [planPlugin<M>(options.planStore, [options.scope])] : []),
    ...(options.evolve ? [{
      manifest: { id: "evolve", version: "0.1.0", apiVersion: 1 as const },
      create: () => ({ contribution: { tools: createEvolveTools(options.evolve), batchPolicies: [], contextFactories: [], stateProviders: [] } }),
    }] : []),
  ];
}

export function createRuntimePluginScope<M extends RuntimeMessage>(options: Parameters<typeof runtimePluginDefinitions<M>>[0], disabled: readonly string[] = []) {
  return createPluginScope(runtimePluginDefinitions<M>(options), disabled);
}
