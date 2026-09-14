// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { manifest as skill } from "@sciencediscovery/plugin-skill/manifest";
import { manifest as mcp } from "@sciencediscovery/plugin-mcp/manifest";
import { manifest as scheduler } from "@sciencediscovery/plugin-scheduler/manifest";
import { manifest as plan } from "@sciencediscovery/plugin-plan/manifest";
import { builtinMcpSourceManifests } from "@sciencediscovery/plugin-mcp-sources";
import { manifest as json } from "@sciencediscovery/plugin-artifact-json/manifest";
import type { PluginManifest } from "@sciencediscovery/plugin-sdk";

/** Only installed trusted packages are advertised. No user-supplied entry imports. */
export const installedPlugins: readonly PluginManifest[] = [skill, mcp, scheduler, plan, ...builtinMcpSourceManifests, json];
// API installation capabilities, not evidence that a particular Run has activated them.
export const hostServices = ["skill.catalog", "mcp.tools", "subagent.dispatch", "plan.store", "mcp.sources", "artifact.read"]
  .map((id) => ({ id, version: 1 }));
export const hostPermissions = ["runtime.contribute", "connector.register", "artifact.read"];
