// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { uniprotMcpSource } from "@sciencediscovery/mcp-sources";
import type { McpSourceAdapter } from "@sciencediscovery/schema";
import type { PluginDefinition } from "@sciencediscovery/plugin-sdk";

export const uniprotPlugin: PluginDefinition<{ sources: McpSourceAdapter[] }> = {
  manifest: { id: "connector.uniprot", version: "0.1.0", apiVersion: 1, capabilities: ["mcp.source.uniprot"] },
  create: () => ({ contribution: { sources: [uniprotMcpSource] } }),
};
