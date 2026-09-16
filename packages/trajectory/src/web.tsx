// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { text, type TrajectoryDetail, type TrajectoryEntry, type TrajectoryIndex, type TrajectoryKind, type TrajectoryPort } from "./index.js";
import { entryTitle, internalEntry, recordGroups, timelineEnd, timelineRows, timelineScale, visibleKinds } from "./presentation.js";
import { EventContent } from "./content-view.js";
import { InputContent } from "./input-view.js";

const colors: Record<TrajectoryKind, string> = { state: "#d97706", input: "#2563eb", output: "#059669", thinking: "#9333ea", tool: "#db2777", mcp: "#0891b2", lifecycle: "#64748b" };
function time(value: string | null) { return value ? new Date(value).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }) : "—"; }

/** The viewer owns presentation only. Its host supplies the authenticated read-only port. */
export function TrajectoryViewer({ sessionId, title, port, locale, onClose }: {
  sessionId: string; title: string; port: TrajectoryPort; locale: string; onClose(): void;
}) {
  const zh = locale.startsWith("zh"), tr = (cn: string, en: string) => zh ? cn : en;
  const labels: Record<TrajectoryKind, string> = { state: tr("状态", "State"), input: tr("模型输入", "Input"), output: tr("模型输出", "Output"), thinking: tr("思考", "Thinking"), tool: tr("工具", "Tool"), mcp: "MCP", lifecycle: tr("生命周期", "Lifecycle") };
  const [index, setIndex] = useState<TrajectoryIndex>(), [selected, setSelected] = useState<string>(), [detail, setDetail] = useState<TrajectoryDetail>();
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0), [exporting, setExporting] = useState(false);
  const [filter, setFilter] = useState("all"), [agent, setAgent] = useState(""), [tab, setTab] = useState("event"), [zoom, setZoom] = useState(1);
  const [trackWidth, setTrackWidth] = useState(450);
  const timeline = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null), exportController = useRef<AbortController>(undefined);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    view.current?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
    };
    document.addEventListener("keydown", keys, true);
    // Defer the focus restore past the host's re-layout: closing the inline view
    // remounts the conversation, and a synchronous focus scroll would be undone.
    return () => { document.removeEventListener("keydown", keys, true); exportController.current?.abort(); requestAnimationFrame(() => previous?.focus()); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    port.index(sessionId, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setIndex(value);
      const all = [...value.entries, ...(value.untimedEntries ?? value.historicalEntries ?? [])];
      setSelected(current => all.some(e => e.id === current) ? current : value.entries.find(e => e.kind === "input")?.id ?? all[0]?.id);
    }).catch(reason => { if (!controller.signal.aborted) setError(String(reason)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId, port, revision]);
  useEffect(() => {
    setDetail(undefined);
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
  const selectedAgent = index?.agents.find(a => a.id === agent)?.id ?? index?.agents.find(a => !a.parentId)?.id ?? index?.agents[0]?.id ?? "";
  const groups = useMemo(() => index ? recordGroups(index).map(group => ({ ...group, entries: group.entries.filter(e => !internalEntry(e) && (filter === "all" || e.kind === filter) && e.agentId === selectedAgent) })).filter(group => group.entries.length) : [], [index, filter, selectedAgent]);
  const entries = useMemo(() => groups.flatMap(group => group.entries), [groups]);
  // The overview is global; the lower list is scoped to exactly one Agent.
  const timelineEntries = index?.entries.filter(e => e.timestamp && !internalEntry(e)) ?? [];
  useEffect(() => { if (!entries.some(e => e.id === selected)) setSelected(entries[0]?.id); }, [entries, selected]);
  const scale = useMemo(() => timelineScale(index?.entries.filter(e => !internalEntry(e)) ?? [], trackWidth * zoom), [index, trackWidth, zoom]);
  const choose = (entry: TrajectoryEntry) => { setAgent(entry.agentId); if (filter !== "all" && filter !== entry.kind) setFilter("all"); setSelected(entry.id); setTab("event"); setError(""); };
  const associatedInput = index && [...index.entries, ...(index.untimedEntries ?? index.historicalEntries ?? [])].find(e => e.kind === "input" && e.agentId === detail?.entry.agentId && e.runId === detail?.entry.runId && !!e.contextId && e.contextId === detail?.entry.contextId);
  useEffect(() => {
    // Measure the viewport, not the expanded content: otherwise minimum marker
    // spacing feeds back into the next measurement and keeps growing the axis.
    const measure = () => setTrackWidth(Math.max(450, (timeline.current?.clientWidth ?? 630)
      - (timeline.current?.querySelector(".trajectory-axis>span")?.getBoundingClientRect().width ?? 160) - 20));
    measure(); const observer = new ResizeObserver(measure);
    if (timeline.current) observer.observe(timeline.current);
    return () => observer.disconnect();
  }, [index]);
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
  return <div className="trajectory-view" role="region" aria-label={tr("Session 轨迹", "Session trajectory")} ref={view} tabIndex={-1} onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); closeRef.current(); }
  }}>
    <header className="trajectory-header"><div><small>SESSION OBSERVATORY</small><h2>{tr("执行轨迹与模型上下文", "Trajectory & model context")}</h2><p title={title}>{title}</p></div><div className="trajectory-actions">
      <button onClick={() => setRevision(r => r + 1)} disabled={loading}>{tr("刷新", "Refresh")}</button>
      <button onClick={() => void download()} disabled={loading || exporting || !index}>{exporting ? tr("导出中…", "Exporting…") : tr("导出 NDJSON", "Export NDJSON")}</button>
      <button onClick={onClose} aria-label={tr("返回对话", "Back to conversation")}>×</button>
    </div></header>
    <p className="trajectory-notice">{tr("只显示已记录的数据。导出可能包含对话、工具结果和敏感业务内容，请妥善保管。", "Recorded data only. Exports may contain conversations, tool results and sensitive business content.")}</p>
    {error && <p role="alert" className="trajectory-error">{error}</p>}
    {loading && <p role="status">{tr("正在读取轨迹…", "Loading trajectory…")}</p>}
    {index && <>
      <div className="trajectory-toolbar"><div className="trajectory-legend">{visibleKinds.map(kind => <span key={kind}><i style={{ background: colors[kind] }} />{labels[kind]}</span>)}</div><label>{tr("时间轴缩放", "Timeline zoom")} <select value={zoom} onChange={e => setZoom(Number(e.target.value))}>{[1, 2, 4, 8].map(n => <option key={n} value={n}>{n}×</option>)}</select></label></div>
      {scale.expanded && <p className="trajectory-notice">{tr("密集时间点已横向展开以保留分隔；分行仅表示真实时间重叠，悬停可查看精确时间。", "Dense timestamps are spaced apart; rows reflect real time overlaps only. Hover for exact times.")}</p>}
      <div className="trajectory-timeline" ref={timeline} aria-label={tr("真实时间多 Agent 时间轴", "Multi-agent wall-clock timeline")}><div style={{ width: `calc(var(--trajectory-label-width, 160px) + ${scale.width + 20}px)` }}>
        <div className="trajectory-axis"><span>{timelineEntries.length ? new Date(scale.start).toLocaleDateString() : "—"}</span><div>{[0, .25, .5, .75, 1].map(f => <time key={f}>{time(timelineEntries.length ? new Date(scale.time((scale.width - 8) * f)).toISOString() : null)}</time>)}</div></div>
        {index.agents.map(a => <div className="trajectory-lane" data-agent-id={a.id} key={a.id}><strong title={a.id}>{a.parentId ? "↳ " : ""}{a.label}</strong><div className="trajectory-tracks">{timelineRows(timelineEntries.filter(e => e.agentId === a.id)).map((row, i) => <div className="trajectory-track" data-category={row.category} key={i} aria-label={`${a.label} · ${row.category}`}>
          {row.entries.map(e => <button key={e.id} data-entry-id={e.id} data-kind={e.kind} className={selected === e.id ? "trajectory-mark selected" : "trajectory-mark"} style={{ left: scale.x(Date.parse(e.timestamp!)), background: colors[e.kind], width: Math.max(8, scale.x(timelineEnd(e)) - scale.x(Date.parse(e.timestamp!)) - 2) }} title={`${time(e.timestamp)} · ${labels[e.kind]} · ${entryTitle(e, zh)} · Run ${e.runId ?? "—"}`} aria-label={`${a.label} ${time(e.timestamp)} ${labels[e.kind]} ${entryTitle(e, zh)}`} onClick={() => choose(e)} />)}
        </div>)}</div></div>)}
      </div></div>
      {index.warnings.length > 0 && <details className="trajectory-warnings"><summary>{tr("记录完整性说明", "Recording completeness")} ({index.warnings.length})</summary>{index.warnings.map(w => <p key={w}>{w}</p>)}</details>}
      <div className="trajectory-body"><aside className="trajectory-events"><div className="trajectory-filters"><select aria-label={tr("事件类型", "Event type")} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">{tr("所有类型", "All types")}</option>{visibleKinds.map(k => <option key={k} value={k}>{labels[k]}</option>)}</select><select aria-label="Agent" value={selectedAgent} onChange={e => setAgent(e.target.value)}>{index.agents.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</select></div>
      <div className="trajectory-event-list" ref={list}>{groups.length ? groups.map(group => <section className="trajectory-event-group" key={group.id}><header><strong>{index.agents.find(a => a.id === group.agentId)?.label}</strong><small title={group.runId}>Run {group.runId?.slice(0, 8) ?? "—"}</small></header>{group.entries.map(e => <button key={e.id} data-entry-id={e.id} data-event-type={e.eventType ?? e.label} aria-current={selected === e.id ? "true" : undefined} onClick={() => choose(e)} style={{ "--event-color": colors[e.kind] } as CSSProperties}><span><i />{labels[e.kind]}<time>{e.timestamp ? time(e.timestamp) : tr("时间未记录", "Time not recorded")}</time></span><strong>{entryTitle(e, zh)}</strong><small className="trajectory-run" title={e.runId}>{e.turn !== undefined ? `turn ${e.turn}` : ""}{e.sequence !== undefined ? ` · #${e.sequence}` : ""}{!e.timestamp ? tr(" · 调用记录", " · Invocation record") : ""}</small></button>)}</section>) : <p>{tr("暂无匹配的记录", "No matching records")}</p>}</div></aside>
      <section className="trajectory-detail"><nav aria-label={tr("详情类型", "Detail type")}>{[["event", tr("事件内容", "Event content")], ["state", tr("Agent 状态", "Agent state")]].map(([id, label]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id!)}>{label}</button>)}{detail && detail.entry.id === selected && detail.entry.kind !== "input" && associatedInput && <button className="trajectory-input-link" onClick={() => choose(associatedInput)}>{tr("查看本次输入", "View request input")}</button>}</nav>
      {detail && detail.entry.id === selected ? <><div className="trajectory-detail-heading"><strong>{labels[detail.entry.kind]} · {entryTitle(detail.entry, zh)}</strong><time>{detail.entry.timestamp ?? tr("时间未记录", "Time not recorded")}</time><small className="trajectory-run" title={`Run ${detail.entry.runId ?? "—"} · turn ${detail.entry.turn ?? "—"} · #${detail.entry.sequence ?? "—"}`}>Run {detail.entry.runId ?? "—"}{detail.entry.turn !== undefined ? ` · turn ${detail.entry.turn}` : ""}{detail.entry.sequence !== undefined ? ` · #${detail.entry.sequence}` : ""}</small></div>
        {tab === "event" && detail.entry.kind === "input" && detail.context ? <InputContent key={detail.entry.id} context={detail.context} zh={zh} />
        : tab === "event" ? <EventContent detail={detail} zh={zh} />
        : tab === "state" && detail.entry.kind === "state" ? <pre className="trajectory-raw">{text(detail.value)}</pre>
        : detail.context ? <pre className="trajectory-raw">{text(detail.context.state)}</pre>
        : <div className="trajectory-empty">{tr("此节点没有已记录的模型上下文关联。可选择蓝色「模型输入」节点查看固定快照。", "This node has no recorded model-context association. Select a blue model-input node to inspect its frozen snapshot.")}</div>}
      </> : <div className="trajectory-empty">{selected ? tr("读取节点…", "Loading entry…") : tr("Session 尚无轨迹。运行一次任务后在此查看。", "No trajectory yet. Run a task to inspect it here.")}</div>}
      </section></div>
    </>}
  </div>;
}
