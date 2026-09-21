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

import type { WebKeyProvider, WebSettings } from "@sciencediscovery/schema";

import type { JiuwenSwarmAgentConfig } from "./jiuwenswarm-agent.js";

/**
 * The web settings as JiuwenSwarm's own configuration, for `config.set`.
 *
 * With the JiuwenSwarm backend web search is JiuwenSwarm's, so the settings page is where its search is
 * configured: its two free engines (DuckDuckGo, Bing) and the keys of its paid search (Jina, Bocha, Serper,
 * Perplexity). A key that is not saved is sent empty, which clears it there. Nothing else in the web settings
 * has a JiuwenSwarm counterpart.
 */
export function jiuwenSwarmWebConfig(settings: WebSettings, key: (provider: WebKeyProvider) => string | undefined): Record<string, string> {
  return {
    free_search_ddg_enabled: String(settings.freeSearchEngines.duckduckgo === true),
    free_search_bing_enabled: String(settings.freeSearchEngines.bing === true),
    jina_api_key: key("jina") ?? "",
    bocha_api_key: key("bocha") ?? "",
    serper_api_key: key("serper") ?? "",
    perplexity_api_key: key("perplexity") ?? "",
  };
}

/** Send the web settings to JiuwenSwarm through the adapter. Never throws: a failure is logged and returned. */
export async function syncWebSettingsToJiuwenSwarm(
  config: Pick<JiuwenSwarmAgentConfig, "adapterToken" | "adapterUrl" | "fetch">,
  settings: WebSettings,
  key: (provider: WebKeyProvider) => string | undefined,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await (config.fetch ?? fetch)(`${config.adapterUrl}/agent/jiuwenswarm-config`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.adapterToken ? { authorization: `Bearer ${config.adapterToken}` } : {}),
      },
      body: JSON.stringify({ values: jiuwenSwarmWebConfig(settings, key) }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[jiuwenswarm] could not apply the web settings to JiuwenSwarm: ${message}`);
    return { ok: false, error: message };
  }
}
