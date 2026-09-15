// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { object, text, type ContextBlock, type TrajectoryDetail, type TrajectoryEntry, type TrajectoryIndex, type TrajectoryKind, type TrajectoryPort } from "./index.js";
import { entryTitle, internalEntry, recordGroups, timelineRows, visibleKinds } from "./presentation.js";
import { EventContent } from "./content-view.js";

const colors: Record<TrajectoryKind, string> = { state: "#d97706", input: "#2563eb", output: "#059669", thinking: "#9333ea", tool: "#db2777", mcp: "#0891b2", lifecycle: "#64748b" };
const palette = ["#2563eb", "#9333ea", "#0891b2", "#d97706", "#059669", "#db2777", "#4f46e5"];
function sourceColor(source: string) { let hash = 0; for (const char of source) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return palette[hash % palette.length]!; }
function time(value: string | null) { return value ? new Date(value).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }) : "—"; }

function ContextContent({ block, zh }: { block: ContextBlock; zh: boolean }) {
  if (!block.id.startsWith("message-")) return <pre>{block.content}</pre>;
  let message: Record<string, unknown>;
  try { message = object(JSON.parse(block.content)); } catch { return <pre>{block.content}</pre>; }
  return <><pre>{text(message.content ?? message)}</pre><details><summary>{zh ? "完整消息 JSON" : "Full message JSON"}</summary><pre>{block.content}</pre></details></>;
}

/** The viewer owns presentation only. Its host supplies the authenticated read-only port. */
export function TrajectoryViewer({ sessionId, title, port, locale, onClose }: {
  sessionId: string; title: string; port: TrajectoryPort; locale: string; onClose(): void;
}) {
  const zh = locale.startsWith("zh"), tr = (cn: string, en: string) => zh ? cn : en;
  const labels: Record<TrajectoryKind, string> = { state: tr("状态", "State"), input: tr("模型输入", "Input"), output: tr("模型输出", "Output"), thinking: tr("思考", "Thinking"), tool: tr("工具", "Tool"), mcp: "MCP", lifecycle: tr("生命周期", "Lifecycle") };
  const [index, setIndex] = useState<TrajectoryIndex>(), [selected, setSelected] = useState<string>(), [detail, setDetail] = useState<TrajectoryDetail>();
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0), [exporting, setExporting] = useState(false);
  const [filter, setFilter] = useState("all"), [agent, setAgent] = useState("all"), [tab, setTab] = useState("event"), [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState({ top: 0, height: 100 });
  const [blockHeights, setBlockHeights] = useState<Record<string, number>>({});
  const [trackWidth, setTrackWidth] = useState(450);
  const timeline = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null), exportController = useRef<AbortController>(undefined);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key === "Tab" && !dialog.current?.contains(document.activeElement)) {
        event.preventDefault(); dialog.current?.focus();
      }
    };
    document.addEventListener("keydown", keys, true);
    return () => { document.removeEventListener("keydown", keys, true); exportController.current?.abort(); previous?.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    port.index(sessionId, controller.signal).then(value => {
      setIndex(value);
      const all = [...value.entries, ...(value.untimedEntries ?? value.historicalEntries ?? [])];
      setSelected(current => all.some(e => e.id === current) ? current : value.entries.find(e => e.kind === "input")?.id ?? all[0]?.id);
    }).catch(reason => { if (!controller.signal.aborted) setError(String(reason)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId, port, revision]);
  useEffect(() => {
    setDetail(undefined); setViewport({ top: 0, height: 100 });
    if (!selected) return;
    const controller = new AbortController();
    port.detail(sessionId, selected, controller.signal).then(value => { if (!controller.signal.aborted) setDetail(value); }).catch(reason => { if (!controller.signal.aborted) setError(String(reason)); });
    return () => controller.abort();
  }, [sessionId, selected, port, revision]);
  useEffect(() => {
    const reveal = () => list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
    reveal(); const observer = new ResizeObserver(reveal);
    if (list.current) observer.observe(list.current);
    return () => observer.disconnect();
  }, [selected]);
  const groups = useMemo(() => index ? recordGroups(index).map(group => ({ ...group, entries: group.entries.filter(e => !internalEntry(e) && (filter === "all" || e.kind === filter) && (agent === "all" || e.agentId === agent)) })).filter(group => group.entries.length) : [], [index, filter, agent]);
  const entries = useMemo(() => groups.flatMap(group => group.entries), [groups]);
  const timelineEntries = entries.filter(e => e.timestamp);
  useEffect(() => { if (!entries.some(e => e.id === selected)) setSelected(entries[0]?.id); }, [entries, selected]);
  const times = index?.entries.flatMap(e => e.timestamp ? [Date.parse(e.timestamp), ...(e.endTime ? [Date.parse(e.endTime)] : [])] : []) ?? [];
  const start = times.length ? times.reduce((a, b) => Math.min(a, b)) : 0, end = times.length ? times.reduce((a, b) => Math.max(a, b)) : 0, duration = Math.max(1, end - start);
  const choose = (entry: TrajectoryEntry) => { setSelected(entry.id); setTab("event"); setError(""); };
  const jumpContext = (id: string | undefined) => { if (id) content.current?.querySelector<HTMLElement>(`#trajectory-${id}`)?.scrollIntoView({ block: "start" }); };
  const messages = detail?.context?.blocks.filter(b => b.id.startsWith("message-")) ?? [];
  useEffect(() => {
    const measure = () => setTrackWidth(timeline.current?.querySelector(".trajectory-track")?.clientWidth ?? 450);
    measure(); const observer = new ResizeObserver(measure);
    if (timeline.current) observer.observe(timeline.current);
    return () => observer.disconnect();
  }, [index, zoom]);
  useEffect(() => {
    if (tab !== "context") return;
    // Long repeated system prompts must not conceal the current request's conversation.
    const latest = detail?.context?.blocks.filter(b => b.id.startsWith("message-")).at(-1);
    if (latest) jumpContext(latest.id);
    else if (content.current) content.current.scrollTop = 0;
  }, [detail, tab]);
  const updateViewport = () => { const node = content.current; if (node) setViewport({ top: 100 * node.scrollTop / Math.max(1, node.scrollHeight), height: 100 * node.clientHeight / Math.max(1, node.scrollHeight) }); };
  useEffect(() => {
    const measure = () => {
      updateViewport();
      setBlockHeights(Object.fromEntries([...(content.current?.children ?? [])].map(node => [node.id, node.getBoundingClientRect().height + 12])));
    };
    measure(); const observer = new ResizeObserver(measure);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [detail, tab]);
  const download = async () => {
    const controller = new AbortController(); exportController.current = controller; setExporting(true); setError("");
    try {
      const blob = await port.export(sessionId, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob), anchor = document.createElement("a");
      anchor.href = url; anchor.download = `trajectory-${sessionId}.ndjson`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { if (!controller.signal.aborted) setError(String(reason)); }
    finally { if (!controller.signal.aborted) setExporting(false); }
  };
  return <div className="trajectory-backdrop"><div className="trajectory-dialog" role="dialog" aria-modal="true" aria-label={tr("Session 轨迹", "Session trajectory")} ref={dialog} tabIndex={-1} onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); closeRef.current(); }
    if (event.key === "Tab") {
      const nodes = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), select, input, [tabindex="0"]')].filter(n => n.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header className="trajectory-header"><div><small>SESSION OBSERVATORY</small><h2>{tr("执行轨迹与模型上下文", "Trajectory & model context")}</h2><p title={title}>{title}</p></div><div className="trajectory-actions">
      <button onClick={() => setRevision(r => r + 1)} disabled={loading}>{tr("刷新", "Refresh")}</button>
      <button onClick={() => void download()} disabled={loading || exporting || !index}>{exporting ? tr("导出中…", "Exporting…") : tr("导出 NDJSON", "Export NDJSON")}</button>
      <button onClick={onClose} aria-label={tr("关闭轨迹", "Close trajectory")}>×</button>
    </div></header>
    <p className="trajectory-notice">{tr("只显示已记录的数据。导出可能包含对话、工具结果和敏感业务内容，请妥善保管。", "Recorded data only. Exports may contain conversations, tool results and sensitive business content.")}</p>
    {error && <p role="alert" className="trajectory-error">{error}</p>}
    {loading && <p role="status">{tr("正在读取轨迹…", "Loading trajectory…")}</p>}
    {index && <>
      <div className="trajectory-toolbar"><div className="trajectory-legend">{visibleKinds.map(kind => <span key={kind}><i style={{ background: colors[kind] }} />{labels[kind]}</span>)}</div><label>{tr("时间轴缩放", "Timeline zoom")} <select value={zoom} onChange={e => setZoom(Number(e.target.value))}>{[1, 2, 4, 8].map(n => <option key={n} value={n}>{n}×</option>)}</select></label></div>
      <div className="trajectory-timeline" ref={timeline} aria-label={tr("真实时间多 Agent 时间轴", "Multi-agent wall-clock timeline")}><div style={{ minWidth: `${zoom * 100}%` }}>
        <div className="trajectory-axis"><span>{times.length ? new Date(start).toLocaleDateString() : "—"}</span><div>{[0, .25, .5, .75, 1].map(f => <time key={f}>{time(times.length ? new Date(start + duration * f).toISOString() : null)}</time>)}</div></div>
        {index.agents.map(a => <div className="trajectory-lane" key={a.id}><strong title={a.id}>{a.parentId ? "↳ " : ""}{a.label}</strong><div className="trajectory-tracks">{timelineRows(timelineEntries.filter(e => e.agentId === a.id), duration, trackWidth).map((row, i) => <div className="trajectory-track" data-category={row.category} key={i} aria-label={`${a.label} · ${row.category}`}>
          {row.entries.map(e => <button key={e.id} className={selected === e.id ? "trajectory-mark selected" : "trajectory-mark"} style={{ left: `${98 * (Date.parse(e.timestamp!) - start) / duration}%`, background: colors[e.kind], width: e.endTime ? `max(8px, ${98 * Math.max(0, Date.parse(e.endTime) - Date.parse(e.timestamp!)) / duration}%)` : undefined }} title={`${time(e.timestamp)} · ${labels[e.kind]} · ${entryTitle(e, zh)} · Run ${e.runId ?? "—"}`} aria-label={`${a.label} ${time(e.timestamp)} ${labels[e.kind]} ${entryTitle(e, zh)}`} onClick={() => choose(e)} />)}
        </div>)}</div></div>)}
      </div></div>
      {index.warnings.length > 0 && <details className="trajectory-warnings"><summary>{tr("记录完整性说明", "Recording completeness")} ({index.warnings.length})</summary>{index.warnings.map(w => <p key={w}>{w}</p>)}</details>}
      <div className="trajectory-body"><aside className="trajectory-events"><div className="trajectory-filters"><select aria-label={tr("事件类型", "Event type")} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">{tr("所有类型", "All types")}</option>{visibleKinds.map(k => <option key={k} value={k}>{labels[k]}</option>)}</select><select aria-label="Agent" value={agent} onChange={e => setAgent(e.target.value)}><option value="all">{tr("所有 Agent", "All agents")}</option>{index.agents.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</select></div>
      <div className="trajectory-event-list" ref={list}>{groups.length ? groups.map(group => <section className="trajectory-event-group" key={group.id}><header><strong>{index.agents.find(a => a.id === group.agentId)?.label}</strong><small title={group.runId}>Run {group.runId?.slice(0, 8) ?? "—"}</small></header>{group.entries.map(e => <button key={e.id} data-entry-id={e.id} data-event-type={e.eventType ?? e.label} aria-current={selected === e.id ? "true" : undefined} onClick={() => choose(e)} style={{ "--event-color": colors[e.kind] } as CSSProperties}><span><i />{labels[e.kind]}<time>{e.timestamp ? time(e.timestamp) : tr("时间未记录", "Time not recorded")}</time></span><strong>{entryTitle(e, zh)}</strong><small className="trajectory-run" title={e.runId}>{e.turn !== undefined ? `turn ${e.turn}` : ""}{e.sequence !== undefined ? ` · #${e.sequence}` : ""}{!e.timestamp ? tr(" · 调用记录", " · Invocation record") : ""}</small></button>)}</section>) : <p>{tr("暂无匹配的记录", "No matching records")}</p>}</div></aside>
      <section className="trajectory-detail"><nav aria-label={tr("详情类型", "Detail type")}>{[["event", tr("事件内容", "Event content")], ["context", tr("模型上下文", "Model context")], ["state", tr("Agent 状态", "Agent state")], ["assembly", tr("组装证据", "Assembly record")]].map(([id, label]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id!)}>{label}</button>)}</nav>
      {detail ? <><div className="trajectory-detail-heading"><strong>{labels[detail.entry.kind]} · {entryTitle(detail.entry, zh)}</strong><time>{detail.entry.timestamp ?? tr("时间未记录", "Time not recorded")}</time><small className="trajectory-run">Run {detail.entry.runId ?? "—"}{detail.entry.turn !== undefined ? ` · turn ${detail.entry.turn}` : ""}{detail.entry.sequence !== undefined ? ` · #${detail.entry.sequence}` : ""}</small></div>
        {tab === "context" && detail.context ? <><div className="trajectory-context-summary"><span>{tr("本次请求", "This request")} · {messages.length} {tr("条消息", "messages")} · {detail.context.blocks.filter(b => b.id.startsWith("tool-")).length} {tr("个工具", "tools")}</span><div>{[[detail.context.blocks[0]?.id, tr("系统提示", "System prompt")], [messages[0]?.id, tr("首条消息", "First message")], [messages.at(-1)?.id, tr("最新消息", "Latest message")], [detail.context.blocks.find(b => b.id.startsWith("tool-"))?.id, tr("工具定义", "Tool definitions")]].map(([id, label]) => <button key={label} disabled={!id} onClick={() => jumpContext(id)}>{label}</button>)}</div></div><div className="trajectory-context-wrap"><div className="trajectory-context" ref={content} onScroll={updateViewport}>{detail.context.blocks.map(block => <section id={`trajectory-${block.id}`} key={block.id} style={{ borderColor: sourceColor(`${block.source}:${block.kind}`) }}><header><strong>{block.source}</strong><span>{block.kind} {block.attribution === "unavailable" ? tr("· 来源未记录", "· origin unavailable") : ""}</span></header><ContextContent block={block} zh={zh} /></section>)}</div><div className="trajectory-minimap" aria-label={tr("上下文来源导航", "Context source navigation")}>{detail.context.blocks.map(block => <button key={block.id} title={`${block.source} · ${block.kind}`} aria-label={`${tr("跳转到", "Jump to")} ${block.source} ${block.kind}`} style={{ background: sourceColor(`${block.source}:${block.kind}`), flexGrow: blockHeights[`trajectory-${block.id}`] ?? 1 }} onClick={() => content.current?.querySelector<HTMLElement>(`#trajectory-${block.id}`)?.scrollIntoView({ block: "start" })} />)}<span className="trajectory-viewport" style={{ top: `${viewport.top}%`, height: `${Math.min(100, viewport.height)}%` }} /></div></div></>
        : tab === "event" ? <EventContent detail={detail} zh={zh} />
        : tab === "state" && detail.entry.kind === "state" ? <pre className="trajectory-raw">{text(detail.value)}</pre>
        : detail.context ? <pre className="trajectory-raw">{text(tab === "state" ? detail.context.state : detail.context.assembly)}</pre>
        : <div className="trajectory-empty">{tr("此节点没有已记录的模型上下文关联。可选择蓝色「模型输入」节点查看固定快照。", "This node has no recorded model-context association. Select a blue model-input node to inspect its frozen snapshot.")}</div>}
      </> : <div className="trajectory-empty">{selected ? tr("读取节点…", "Loading entry…") : tr("Session 尚无轨迹。运行一次任务后在此查看。", "No trajectory yet. Run a task to inspect it here.")}</div>}
      </section></div>
    </>}
  </div></div>;
}
