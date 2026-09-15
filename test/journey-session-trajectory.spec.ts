// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel, sendUserMessage, waitForRunTerminal, type JourneyFixture } from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: Inspect and export a Session's real multi-agent trajectory and frozen model contexts.
 * Steps:
 *   1. Run a main Agent and delegated child, then continue the Session with a second Run.
 *   2. Inspect real-time lanes, select a model input, and navigate contributed context sections.
 *   3. Inspect reasoning with its exact context, export NDJSON, and verify Session isolation.
 *   4. Read tool arguments and results, with an optional raw JSON view.
 *   5. Inspect per-request token usage on its model response.
 *   6. Inspect narrow-screen layout and Run labels.
 *   7. Close the viewer with the keyboard and return to the Session.
 * Environment: Isolated current-worktree API/Web and Runner at E2E_BASE_URL.
 * Type: mocked
 * LLM: journey-owned deterministic HTTP model with main/subagent scripts.
 * WebSearch: none
 * PaperSources: none
 * MCP: none; MCP record projection is covered by component tests.
 * OtherExternal: none; one local sandboxed printf operation.
 * Credentials: E2E_API_TOKEN for the isolated local stack only.
 * CostSideEffects: Temporary model, Project and Session removed in finally; no external cost.
 */
test("查看多 Agent 轨迹、精确上下文并导出", { tag: "@mocked" }, async ({ page, journey }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "zh-CN"));
  const stub = await scriptedModel([[
    { tool: "task", arguments: { description: "独立核查", prompt: "Use run_shell to print TRAJECTORY_CHILD, then report success.", subagent_type: "general-purpose" }, reasoning: "先委派独立核查。", delayMs: 300 },
    { text: "主任务核查完成。", reasoning: "结合子任务结果形成结论。" },
  ], [{ text: "第二轮确认完成。" }]], [
    { tool: "run_shell", arguments: { command: "printf TRAJECTORY_CHILD" }, reasoning: "核对工具执行结果。", delayMs: 300 },
    { text: "TRAJECTORY_CHILD 已核验。" },
  ]);
  let fixture: JourneyFixture | undefined;
  journey.scenario({ goal: "研究员检查主子 Agent 的执行时间、状态和模型实际输入，并导出证据。", preconditions: ["独立 API/Runner 已启动", "模型仅调用本地脚本桩"] });
  try {
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow", projectName: `Trajectory ${Date.now()}`, sessionTitle: "执行证据", model: { ...stub, name: `Trajectory model ${Date.now()}`, apiVariant: "deepseek" } });
    await journey.step("运行主子任务", "主 Agent 委派独立核查，子 Agent 返回工具证据。", async () => {
      await openProjectSession(page, fixture!);
      const run = await sendUserMessage(page, fixture!.session.id, "请委派独立核查后汇总结果。");
      const terminal = await waitForRunTerminal(page, fixture!.session.id, run.id);
      expect(terminal.status).toBe("completed");
      await expect(page.getByText("主任务核查完成。", { exact: true }).first()).toBeVisible();
      const followup = await sendUserMessage(page, fixture!.session.id, "请确认上一轮结论。");
      expect((await waitForRunTerminal(page, fixture!.session.id, followup.id)).status).toBe("completed");
      await expect(page.getByText("第二轮确认完成。", { exact: true }).first()).toBeVisible();
      const entry = page.getByRole("button", { name: "轨迹", exact: true });
      await expect(entry).toHaveClass(/secondary-button compact-button/);
      await expect(entry).toHaveCSS("border-radius", "7px");
      await expect(entry).toHaveCSS("min-height", "34px");
      await expect(entry).toHaveCSS("white-space", "nowrap");
      await expect(entry).toHaveCSS("height", "34px");
      await entry.focus();
      await expect(entry).toBeFocused();
    });
    const dialog = page.getByRole("dialog", { name: "Session 轨迹" });
    await journey.step("查看时间轴和上下文来源", "主子 Agent 共用时间坐标，输入展示实际贡献块，彩色导航可跳转。", async () => {
      await page.getByRole("button", { name: "轨迹", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "刷新", exact: true })).toHaveCSS("border-radius", "7px");
      await expect(dialog.locator(".trajectory-lane")).toHaveCount(2);
      await expect(dialog.getByRole("button", { name: "事件内容", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(dialog.locator(".trajectory-readable")).toContainText("系统提示");
      await expect(dialog.locator('[data-event-type="turn_start"]')).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "全部记录", exact: true })).toHaveCount(0);
      const headings = await dialog.locator(".trajectory-event-group > header").evaluateAll(nodes => nodes.map(node => `${node.querySelector("strong")?.textContent}:${node.querySelector("small")?.getAttribute("title")}`));
      expect(headings.length).toBeGreaterThanOrEqual(3);
      expect(new Set(headings).size).toBe(headings.length);
      expect(await dialog.locator(".trajectory-event-group").first().locator("button").count()).toBeGreaterThan(5);
      for (const type of ["session.updated", "run.queued", "run.status", "model_usage"]) await expect(dialog.locator(`[data-event-type="${type}"]`)).toHaveCount(0);
      await dialog.getByRole("button", { name: "模型上下文", exact: true }).click();
      await expect(dialog.locator(".trajectory-context section").first()).toBeVisible();
      expect(await dialog.locator(".trajectory-mark").count()).toBeGreaterThan(5);
      expect(await dialog.locator(".trajectory-minimap button").count()).toBeGreaterThan(2);
      await expect(dialog.locator(".trajectory-context section").first()).not.toContainText("来源未记录");
      await expect(dialog.locator(".trajectory-axis")).toContainText(/\d{2}:\d{2}:\d{2}/);
      await expect(dialog.locator(".trajectory-event-group header small").first()).toContainText(/Run .+/);
      await expect(dialog.getByRole("button", { name: /^历史版本/ })).toHaveCount(0);
      await dialog.locator('[data-event-type="context.captured"]').first().click();
      await dialog.getByRole("button", { name: "模型上下文", exact: true }).click();
      await dialog.locator(".trajectory-minimap button").last().click();
      expect(await dialog.locator(".trajectory-context").evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      await dialog.getByRole("button", { name: "Agent 状态", exact: true }).click();
      await expect(dialog.locator(".trajectory-raw")).toContainText("checkpoint");
    });
    await journey.step("选择思考节点并导出", "已记录思考对应固定上下文，导出含完整结束标记，未授权和其他 Session 无法读取。", async () => {
      await dialog.getByLabel("事件类型", { exact: true }).selectOption("thinking");
      await dialog.locator(".trajectory-event-list button").filter({ hasText: "思考内容" }).first().click();
      await expect(dialog.locator(".trajectory-readable")).toContainText("先委派独立核查。");
      await expect(dialog.locator(".trajectory-raw")).toHaveCount(0);
      await dialog.getByRole("button", { name: "原始 JSON", exact: true }).click();
      await expect(dialog.locator(".trajectory-raw")).toContainText("contextRef");
      await dialog.getByRole("button", { name: "模型上下文", exact: true }).click();
      await expect(dialog.locator(".trajectory-context section").first()).toBeVisible();
      const downloadPromise = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "导出 NDJSON", exact: true }).click();
      const download = await downloadPromise, stream = await download.createReadStream();
      const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      const records = Buffer.concat(chunks).toString().trim().split("\n").map(line => JSON.parse(line));
      expect(records[0].sessionId).toBe(fixture!.session.id);
      expect(records.at(-1).type).toBe("complete");
      expect(records[0].historicalEntries).toEqual([]);
      const streams = new Map<string, number[]>();
      for (const entry of records[0].entries) {
        expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);
        if (entry.streamId !== "journal") continue;
        const key = `${entry.agentId}:${entry.runId}`;
        streams.set(key, [...(streams.get(key) ?? []), entry.sequence]);
      }
      expect(streams.size).toBeGreaterThanOrEqual(3);
      const mainStarts = records[0].entries.filter((e: { agentId: string; label: string; turn: number }) => e.agentId.startsWith("main:") && e.label === "context.captured" && e.turn === 0);
      expect(new Set(mainStarts.map((e: { runId: string }) => e.runId)).size).toBe(2);
      for (const sequences of streams.values()) expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      expect(records[0].entries.some((e: { id: string }) => /^(action:|before:|after:)/.test(e.id))).toBe(false);
      expect(records.some(r => r.context?.input && r.entry.agentId.startsWith("subagent:"))).toBe(true);
      const unauthorized = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/trajectory`, { headers: { authorization: "Bearer wrong" } });
      expect(unauthorized.status()).toBe(401);
      const foreign = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/trajectory/detail?id=foreign`, { headers: authorizationHeader() });
      expect(foreign.status()).toBe(404);
    });
    await journey.step("阅读工具参数", "工具卡片展示实际输入，原始 JSON 可切换。", async () => {
      await dialog.getByLabel("事件类型", { exact: true }).selectOption("tool");
      await dialog.getByLabel("Agent", { exact: true }).selectOption({ label: "独立核查" });
      await dialog.locator('[data-event-type="tool_execution_start"]').first().click();
      await expect(dialog.locator(".trajectory-readable")).toContainText("输入参数");
      await expect(dialog.locator(".trajectory-readable")).toContainText("printf TRAJECTORY_CHILD");
      await dialog.getByRole("button", { name: "原始 JSON", exact: true }).click();
      await expect(dialog.locator(".trajectory-raw")).toContainText("run_shell");
      await dialog.getByRole("button", { name: "解析内容", exact: true }).click();
      await expect(dialog.locator(".trajectory-readable dt").filter({ hasText: "command" })).toBeInViewport();
    });
    await journey.step("核对单次模型用量", "模型返回展示该次请求的 Token 用量，不是 Session 累计值。", async () => {
      await dialog.getByLabel("Agent", { exact: true }).selectOption("all");
      await dialog.getByLabel("事件类型", { exact: true }).selectOption("output");
      await dialog.locator('[data-event-type="model.completed"]').first().click();
      const usage = dialog.locator(".trajectory-readable section").filter({ has: page.getByRole("heading", { name: "本次请求用量", exact: true }) });
      await expect(usage).toContainText("输入 Token20");
      await expect(usage).toContainText("输出 Token8");
      await expect(usage).toContainText("总 Token28");
      await usage.scrollIntoViewIfNeeded();
    });
    await journey.step("窄屏阅读", "查看器不超出视口，选中事件、Run 标签和模型用量可见。", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await dialog.evaluate(el => el.getBoundingClientRect().right <= window.innerWidth + 1)).toBe(true);
      await expect(dialog.getByRole("button", { name: "关闭轨迹" })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "全部记录", exact: true })).toHaveCount(0);
      await expect(dialog.locator(".trajectory-detail-heading .trajectory-run")).toBeVisible();
      await expect(dialog.locator('.trajectory-event-list button[aria-current="true"]')).toBeInViewport({ ratio: 0.95 });
      await dialog.locator(".trajectory-readable dt").filter({ hasText: "总 Token" }).scrollIntoViewIfNeeded();
      await expect(dialog.locator(".trajectory-readable dt").filter({ hasText: "总 Token" })).toBeInViewport();
      const listHeight = await dialog.locator(".trajectory-event-list").evaluate(el => el.clientHeight);
      expect(await dialog.locator(".trajectory-event-list button").first().evaluate(el => el.clientHeight)).toBeLessThanOrEqual(listHeight);
    });
    await journey.step("返回会话", "键盘 Escape 返回 Session，轨迹入口保持单行可见。", async () => {
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("button", { name: "轨迹", exact: true })).toBeInViewport();
      await expect(page.getByRole("button", { name: "轨迹", exact: true })).toHaveCSS("height", "34px");
    });
  } finally { if (fixture) await cleanupJourney(page, fixture); await stub.stop(); }
});
