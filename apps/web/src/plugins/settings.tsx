// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ComponentProps } from "react";
import { SkillSettingsSection } from "@sciencediscovery/plugin-skill/web";
import { McpSettingsSection } from "@sciencediscovery/plugin-mcp/web";
import { manifest as skill } from "@sciencediscovery/plugin-skill/manifest";
import { manifest as mcp } from "@sciencediscovery/plugin-mcp/manifest";
import { manifest as plan } from "@sciencediscovery/plugin-plan/manifest";
import { manifest as scheduler } from "@sciencediscovery/plugin-scheduler/manifest";
import { manifest as uniprot } from "@sciencediscovery/plugin-uniprot/manifest";
import { manifest as json } from "@sciencediscovery/plugin-artifact-json/manifest";
import { mergePluginSettings, pluginEnabled } from "@sciencediscovery/plugin-sdk";
import { useLocale } from "../i18n/index.js";

const installed = [skill, mcp, plan, scheduler, uniprot, json];
type Props = Omit<ComponentProps<typeof SkillSettingsSection>, "t"> & Omit<ComponentProps<typeof McpSettingsSection>, "t"> & {
  t: ReturnType<typeof useLocale>["t"];
};
/** The host owns slots; feature packages own their fields and rendering. */
const sections = [
  { id: "mcp", render: (props: Props) => <McpSettingsSection {...props} /> },
  { id: "skill", render: (props: Props) => <SkillSettingsSection {...props} /> },
];
export function PluginSettingsSections(props: Props) {
  const zh = useLocale().locale.startsWith("zh");
  const effective = mergePluginSettings(props.details.inheritedPlugins, props.draft.plugins);
  return <>
    <details className="plugin-settings">
      <summary>{zh ? "插件与扩展" : "Plugins and extensions"}</summary>
      <p className="settings-hint">{zh ? "运行配置在下一次运行生效；正在运行的任务保持原组合。历史记录不会删除。" : "Changes apply to the next run. Active runs keep their composition; history is retained."}</p>
      {installed.map((manifest) => <label className="settings-field" key={manifest.id}>
        <span>{manifest.id} <small>{manifest.version}</small></span>
        <select aria-label={manifest.id + " plugin"} disabled={props.disabled} value={props.draft.plugins?.[manifest.id]?.enabled === undefined ? "inherit" : props.draft.plugins[manifest.id]!.enabled ? "enabled" : "disabled"}
          onChange={(event) => props.setDraft((draft) => {
            const plugins = { ...draft.plugins }, setting = { ...plugins[manifest.id] };
            if (event.target.value === "inherit") delete setting.enabled;
            else setting.enabled = event.target.value === "enabled";
            plugins[manifest.id] = setting;
            return { ...draft, plugins };
          })}>
          <option value="inherit">{props.skillScope === "global" ? (zh ? "默认" : "Default") : (zh ? "继承" : "Inherit")} ({pluginEnabled(props.details.inheritedPlugins, manifest.id) ? (zh ? "启用" : "enabled") : (zh ? "关闭" : "disabled")})</option>
          <option value="enabled">{zh ? "启用" : "Enabled"}</option>
          <option value="disabled">{zh ? "关闭" : "Disabled"}</option>
        </select>
      </label>)}
    </details>
    {sections.filter((section) => pluginEnabled(effective, section.id)).map((section) => <div key={section.id} data-plugin={section.id}>{section.render(props)}</div>)}
  </>;
}
