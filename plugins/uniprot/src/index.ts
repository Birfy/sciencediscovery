// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { uniprotMcpSource } from "@sciencediscovery/mcp-sources";
import type { McpSourceAdapter } from "@sciencediscovery/schema";
import type { PluginDefinition } from "@sciencediscovery/plugin-sdk";
import { manifest } from "./manifest.js";

export const uniprotPlugin: PluginDefinition<{ sources: McpSourceAdapter[] }> = {
  manifest,
  create: () => ({ contribution: { sources: [uniprotMcpSource] } }),
};
