// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useMemo, useRef, useState } from "react";
import { text, type ContextBlock, type TrajectoryDetail } from "./index.js";
import { blockValue, contextLabel, inputSections, toolName } from "./input-presentation.js";

const palette = ["#2563eb", "#9333ea", "#0891b2", "#a16207", "#047857", "#be185d", "#4f46e5"];
function sourceColor(block: ContextBlock) {
  let hash = 0;
  for (const char of `${block.source}:${block.kind}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}

function ContextContent({ block, zh }: { block: ContextBlock; zh: boolean }) {
  if (!block.id.startsWith("message-")) return <pre>{block.content}</pre>;
  const message = blockValue(block);
  return <>
    <pre>{text(message.content ?? message)}</pre>
    {Array.isArray(message.tool_calls) && message.tool_calls.length > 0 && <><h4>{zh ? "工具调用" : "Tool calls"}</h4><pre>{text(message.tool_calls)}</pre></>}
    <details><summary>{zh ? "完整消息 JSON" : "Full message JSON"}</summary><pre>{block.content}</pre></details>
  </>;
}

/** Read-only presentation of one frozen input, not a reconstruction from live state. */
export function InputContent({ context, zh }: { context: NonNullable<TrajectoryDetail["context"]>; zh: boolean }) {
  const tr = (cn: string, en: string) => zh ? cn : en;
  const sections = useMemo(() => inputSections(context.blocks), [context.blocks]);
  const messages = sections.context.filter(b => b.id.startsWith("message-"));
  const [raw, setRaw] = useState(false), [active, setActive] = useState("");
  const content = useRef<HTMLDivElement>(null), outline = useRef<HTMLDivElement>(null);
  const jump = (id: string | undefined) => {
    const node = [...(content.current?.children ?? [])].find(n => n.id === `trajectory-${id}`) as HTMLElement | undefined;
    if (node && content.current) { content.current.scrollTop += node.getBoundingClientRect().top - content.current.getBoundingClientRect().top; setActive(id!); }
  };
  const updateActive = () => {
    if (!content.current) return;
    const top = content.current.getBoundingClientRect().top;
    const nodes = [...content.current.children];
    const node = nodes.find(n => n.getBoundingClientRect().bottom > top + 8) ?? nodes.at(-1);
    if (node) setActive(node.id.replace(/^trajectory-/, ""));
  };
  useEffect(() => {
    if (!raw) jump(messages.at(-1)?.id ?? sections.context[0]?.id);
  }, [context, raw]);
  useEffect(() => {
    const selected = outline.current?.querySelector<HTMLElement>('[aria-current="true"]');
    selected?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return <div className="trajectory-input">
    <div className="trajectory-content-controls"><button aria-pressed={!raw} onClick={() => setRaw(false)}>{tr("解析内容", "Readable")}</button><button aria-pressed={raw} onClick={() => setRaw(true)}>{tr("原始 JSON", "Raw JSON")}</button></div>
    {raw ? <pre className="trajectory-raw">{text(context.input)}</pre> : <>
      <div className="trajectory-context-summary"><span>{tr("本次请求", "This request")} · {messages.length} {tr("条消息", "messages")} · {sections.tools.length} {tr("个工具", "tools")}</span><div>
        {[[sections.context.find(b => !b.id.startsWith("message-"))?.id, tr("系统提示", "System prompt")], [messages[0]?.id, tr("首条消息", "First message")], [messages.at(-1)?.id, tr("最新消息", "Latest message")]].map(([id, label]) => <button key={label} disabled={!id} onClick={() => jump(id)}>{label}</button>)}
      </div></div>
      <div className="trajectory-context-wrap"><div className="trajectory-context" ref={content} onScroll={updateActive}>
        {sections.context.map(block => <section id={`trajectory-${block.id}`} key={block.id} style={{ borderColor: sourceColor(block) }}>
          <header><strong>{contextLabel(block, sections.context, zh)}</strong><span>{block.kind}{block.attribution === "unavailable" && !block.id.startsWith("message-") ? tr(" · 来源未记录", " · origin unavailable") : ""}</span></header>
          <ContextContent block={block} zh={zh} />
        </section>)}
        {!sections.context.length && <p>{tr("未记录消息内容", "No message content recorded")}</p>}
      </div><div className="trajectory-minimap" ref={outline} aria-label={tr("上下文来源导航", "Context source navigation")}>
        {sections.context.map(block => <button key={block.id} title={`${contextLabel(block, sections.context, zh)} · ${block.source} · ${block.kind}`} aria-current={active === block.id ? "true" : undefined} style={{ background: sourceColor(block) }} onClick={() => jump(block.id)}><strong>{contextLabel(block, sections.context, zh)}</strong><small>{block.id.startsWith("message-") ? `${tr("消息", "Message")} ${Number(block.id.slice(8)) + 1} · ${block.kind}` : block.kind}</small></button>)}
      </div></div>
      <details className="trajectory-tools"><summary>{tr("工具定义", "Tool definitions")} ({sections.tools.length}) <small>{tr("独立 tools 字段", "Separate tools field")}</small></summary>
        <div className="trajectory-tool-list">{sections.tools.length ? sections.tools.map(block => {
          const tool = blockValue(block);
          return <details key={block.id}><summary>{toolName(tool) || block.id}</summary><pre>{block.content}</pre></details>;
        }) : <p>{tr("本次请求没有工具定义", "No tools in this request")}</p>}</div>
      </details>
    </>}
  </div>;
}
