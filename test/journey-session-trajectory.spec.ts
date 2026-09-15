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
 *   1. Run a main Agent and delegated child with returned thinking and a local tool.
 *   2. Inspect real-time lanes, select a model input, and navigate contributed context sections.
 *   3. Inspect reasoning with its exact context, export NDJSON, and verify Session isolation.
 *   4. Inspect narrow-screen layout and close the viewer with the keyboard.
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
  const stub = await scriptedModel([
    { tool: "task", arguments: { description: "独立核查", prompt: "Use run_shell to print TRAJECTORY_CHILD, then report success.", subagent_type: "general-purpose" }, reasoning: "先委派独立核查。", delayMs: 300 },
    { text: "主任务核查完成。", reasoning: "结合子任务结果形成结论。" },
  ], [
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
      await expect(dialog.locator(".trajectory-context section").first()).toBeVisible();
      expect(await dialog.locator(".trajectory-mark").count()).toBeGreaterThan(5);
      expect(await dialog.locator(".trajectory-minimap button").count()).toBeGreaterThan(2);
      await expect(dialog.locator(".trajectory-context section").first()).not.toContainText("来源未记录");
      await expect(dialog.locator(".trajectory-axis")).toContainText(/\d{2}:\d{2}:\d{2}/);
      await dialog.locator(".trajectory-minimap button").last().click();
      expect(await dialog.locator(".trajectory-context").evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      await dialog.getByRole("button", { name: "Agent 状态", exact: true }).click();
      await expect(dialog.locator(".trajectory-raw")).toContainText("checkpoint");
    });
    await journey.step("选择思考节点并导出", "已记录思考对应固定上下文，导出含完整结束标记，未授权和其他 Session 无法读取。", async () => {
      await dialog.getByLabel("事件类型", { exact: true }).selectOption("thinking");
      await dialog.locator(".trajectory-event-list button").filter({ hasText: "model_delta" }).first().click();
      await dialog.getByRole("button", { name: "事件内容", exact: true }).click();
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
      expect(records.some(r => r.context?.input && r.entry.agentId.startsWith("subagent:"))).toBe(true);
      const unauthorized = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/trajectory`, { headers: { authorization: "Bearer wrong" } });
      expect(unauthorized.status()).toBe(401);
      const foreign = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/trajectory/detail?id=foreign`, { headers: authorizationHeader() });
      expect(foreign.status()).toBe(404);
    });
    await journey.step("窄屏阅读和关闭", "查看器不超出视口，键盘 Escape 返回 Session。", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await dialog.evaluate(el => el.getBoundingClientRect().right <= window.innerWidth + 1)).toBe(true);
      await expect(dialog.getByRole("button", { name: "关闭轨迹" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("button", { name: "轨迹", exact: true })).toBeInViewport();
      await expect(page.getByRole("button", { name: "轨迹", exact: true })).toHaveCSS("height", "34px");
    });
  } finally { if (fixture) await cleanupJourney(page, fixture); await stub.stop(); }
});
