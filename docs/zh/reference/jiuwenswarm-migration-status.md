# JiuwenSwarm 迁移：现状与交接

issue 84（复用 JiuwenSwarm 后端）做到哪一步、现在能跑什么、什么还没做，以及如何开始做某个子 issue。启动方法见[在 JiuwenSwarm 上运行智能体](../how-to/run-with-jiuwenswarm.md)。

## 这个基线是什么

一个**过渡架构**，是有意选择的：现有 TypeScript API 继续持有存储（会话、消息、运行事件、权限记录）以及 UI 调用的全部路由。只替换**智能体执行器**：模型循环跑在 JiuwenSwarm 0.2.6 上，通过一个 Python **适配器**接入；适配器同时作为反向代理挡在 API 前面。

```text
浏览器 ─▶ 适配器 :4310 ──代理──▶ legacy API :4410 ──createAgent──┐
              │  ▲                                                 │ POST /agent/runs
              │  └────── 工具调用（每次运行一个回环 bridge）◀──────┤
              ▼
        JiuwenSwarm 网关 ─▶ 模型，经 /llm/<token>/v1（适配器）
              └── MCP 工具 ─▶ /mcp/<token>（适配器，转发给 bridge）
```

这**不是** issue 正文写的终态（由适配器在 JiuwenSwarm 自有存储之上提供路由）。下表逐个子 issue 说明离终态还差多少。假设终态的验收标准是否要按过渡架构改写，还是待 issue 负责人决定的事项。

设计与实测的协议事实：[`services/adapter/README.md`](../../../services/adapter/README.md)。

## 各子 issue 现状

| Issue | 状态 | 已有 | 没有 |
|---|---|---|---|
| 86 验收基线与协议校准 | 已关闭 | 接口清单（259 行）、L1/L2 工具、Linux 上 27 个录制用例、协议实验、`CI_E2E_BACKEND=jiuwenswarm` | 104 行没有用例；59 条“近似映射”未校准；未评估 `AgentRuntime` |
| 87 适配器核心 | 已关闭 | 公共端口、流式代理（SSE、NDJSON）、上游失败返回 502、`/agent/*` 可选 token | 自有存储、run 注册表、事件日志与续传：仍在 legacy API |
| 88 会话与项目 | 已关闭 | 经代理由 legacy API 提供；L1 覆盖 13 行 | 没有迁到 JiuwenSwarm 的会话存储 |
| 89 对话与运行 | 已关闭 | 运行在 JiuwenSwarm 上执行；事件、取消、审批、用量、断线处理；8 个场景的 L2 黄金轨迹 | 见“已知缺口” |
| 90 权限 | 已完成 | 审批请求、允许/拒绝、授权、审计、epoch、错误 token 拒绝与之前一致（L1 8/8 加负例，L2 允许/拒绝） | 未映射到 JiuwenSwarm 的权限引擎（保持关闭，由 API 的权限运行时判定）；发现见下 |
| 91 模型、供应商、设置 | 已完成 | 模型列表、默认值、设置由 legacy 提供（L1 覆盖全部行）；所选模型按次交给 JiuwenSwarm | 三种模型协议都能跑，经 API 里的回环模型网关 |
| 92 MCP 与数据源 | 已完成 | 21 行都有 L1 用例；5 条 MCP 旅程在此执行器上通过（自定义 MCP、智能体调用自定义 MCP 工具、OAuth、密钥编辑 ×2）；延迟的 MCP 工具启动时一并晋升，并提供 `tool_search` | 没有对真实供应商跑过 MCP OAuth |
| 93 技能与技能库 | 未开始 | 由 legacy 提供 | L1 0/35；技能在此执行器上的使用未验证 |
| 94 文件、工作区、轨迹 | 未开始 | 读接口有 L1 用例 | JiuwenSwarm 运行的轨迹视图为空（没有记录 `evidence`） |
| 95 规划与子代理 | 已完成 | `update_plan`、`task` 经 bridge 运行；L1 覆盖全部行；L2 子代理与两轮对话用例一致；M0 计划、委派旅程通过；恢复的子代理带有此前历史 | 不使用 JiuwenSwarm 自己的 todo/子代理/agent 模板（子代理就是 API 的 `task` 工具） |
| 97 科学工具集 MCP 化 | 已完成 | 等价工具集以 MCP 工具提供，经 bridge 调 legacy 工具，走同一个 ToolRegistry；有测试把提供的工具集与 schema 钉在注册表上；延迟工具启动时一并晋升并提供 `tool_search`；并行调用可运行且一致 | 后续子 issue（idea-tree、evolve、memory、产物审阅）的工具随它们一起到 |
| 103 用量 | 已完成 | 每次模型调用的 token 数映射成 `model.usage` 并汇总；一次运行后的会话用量、按模型用量与内置循环一致（L2）；每一行都有 L1 用例 | 没有迁到适配器存储；统计仍在 API |
| 93、94、96、98-102、104-106 | 未开始 | legacy 行为原样在代理之后 | 全部：作为迁移尚未开始。runner/环境/远程主机的读接口有 L1 用例 |

## 已验证

在阿里云 Linux 服务器（bubblewrap 沙箱）上，`SCIENCE_AGENT_ADAPTER=1 SCIENCE_AGENT_EXECUTOR=jiuwenswarm`：

- 里程碑 0 的五条旅程（首次运行、精简过程 ×2、计划工作区、委派子任务、交付结果）通过。
- 一条使用真实 OpenAI 兼容模型的旅程通过（`journey-real-request`）。
- L2：10 个运行事件场景（文本、工具调用、审批允许/拒绝、取消、401、子代理、断线续传、post-messages、两轮对话、并行工具调用）的事件类型序列与内置循环一致。被接受的差异记在 `test/contract/accepted-differences.json`（供应商 401 的措辞、evidence 缺口）。
- L1：内置循环与“适配器 + JiuwenSwarm”栈上录制的用例一致（构建版本号已归一化）。
- 单测：适配器（`pytest`，135 个）、TypeScript 的 agent 工厂与模型网关（51 个）。`test/contract/jw-only/live.mjs` 在运行中的 JiuwenSwarm 栈上检查只有这个后端才有的行为（对话连续性、todo 规划）。

## 上下文管理

JiuwenSwarm 自己有一套上下文引擎（占用到模型窗口的 80% 时压缩，并自己注入每一步的动态上下文）。执行器现在用的是它：

| | 内置循环 | JiuwenSwarm 执行器 |
|---|---|---|
| 对话放在哪 | API 的记录，每一步重新发 | JiuwenSwarm 的会话，每个智能体一个（持久化在它的检查点数据库里）；不随请求发送，适配器里也没有 |
| 窗口快满时的压缩 | ScienceDiscovery 自己的压缩器 | JiuwenSwarm 的（已把模型真实窗口告诉它；**窗口写满时的表现没有验证**） |
| 系统提示各段（身份、治理、能力、技能） | 每一步组装 | 文本相同，每次运行组装一次 |
| 运行契约（受保护） | 每一步都在 | **没有注入** |
| 计划快照、持久状态、插件上下文 | 每一步注入 | **没有注入**；JiuwenSwarm 加自己的动态上下文 |
| 工具路由提示 | 有 | **没有注入** |
| 工具输出守卫和读取 | 有 | 有（同一个 `ToolRegistry`） |
| 输入过长的恢复 | 压缩后重试 | JiuwenSwarm 自己的处理；**没有验证** |
| 轨迹与 evidence | 有 | **没有** |

## 已知缺口

1. **没有 evidence / 轨迹。** JiuwenSwarm 运行不产生 `agent.record`/`evidence`，轨迹视图为空。
2. **历史与上下文。** JiuwenSwarm 是模型上下文的唯一持有者：每个智能体一个稳定会话，由 JiuwenSwarm 压缩；适配器和 API 都不发送、不重建任何历史。所以在内置循环上开始的会话，JiuwenSwarm 不记得（之前的轮次只在界面上），在 API 里编辑或回退的对话也不会反映过去。JiuwenSwarm 重启后这份上下文仍在（已验证：`live.mjs history-restart`）。运行契约和每一步的动态上下文（计划快照、持久状态）没有注入，见“上下文管理”。
3. **模型协议：** UI 能配置的三种都可用（API 里的回环网关用原生模型客户端为 JiuwenSwarm 的 chat-completions 请求提供服务）。图片不会发给模型。
4. **工具集里没有** 工具输出存储。延迟工具启动时一并晋升。同一次模型响应里的工具调用按原生规则调度（没声明并发安全的工具独占、按模型调用的顺序执行；重复调用由批处理策略取代），所以两个执行器的事件与顺序一致。
5. **唤醒提示。** mocked E2E 的 `issue-77-wake-notice` 在此执行器上失败（脚本化模型靠 JiuwenSwarm 没有那样给出的提示词识别唤醒轮）；`issue-85` 通过。用 `CI_E2E_BACKEND=jiuwenswarm .ci/run-e2e.sh mocked` 运行该组。这些旅程在小机器上对负载敏感：在 2 核服务器上连续运行时有两条失败过一次，单独运行（重复 3 次）都通过，所以有疑问时请逐条运行。
6. **录制中发现的 legacy 缺陷（未修）：** `PUT /api/sessions/:id/settings` 请求体错误返回 500；`PUT /api/web/settings` 用它自己 GET 的响应体返回 500；对未知 run 做技能进化返回 500；读工作区外的文件（`/file?path=../../etc/passwd`）返回 500 而非 4xx。
7. **#90 的发现：** `POST /api/sessions/:id/permission-epoch` 之后，会话范围的授权仍然生效（epoch 管沙箱，授权管会话）。issue 文字期望旧授权失效；基线记录的是 legacy 的实际行为。

## 开始做某个子 issue

1. 选择后端并启动整套栈：先执行一次 `scripts/jiuwenswarm.sh setup`，再 `./scripts/start-stack.sh --mode local --jiuwenswarm`（用 `GET /agent/info` 确认）；见[操作指南](../how-to/run-with-jiuwenswarm.md)。
2. 在 `test/contract/routes.json` 里找到你的路由（`node test/contract/run.mjs --coverage` 会列出没有用例的行）。
3. 在 `test/contract/cases/` 下加用例，在**全新数据目录**上对内置循环录制，再对“适配器 + JiuwenSwarm”栈比对。规则、SSE 步骤写法和归一化见 [`test/contract/README.md`](../../../test/contract/README.md)。基线对智能体只读，改动需要人工评审。
4. 行为类用 run 事件用例（`l2-runs.json`）；脚本化模型是 `test/contract/stub-model.mjs`。
5. 浏览器旅程：`CI_E2E_BACKEND=jiuwenswarm .ci/run-e2e.sh mocked`（网关必须已在运行）。

## 测试

```bash
UV_PROJECT_ENVIRONMENT=/tmp/adapter-venv uv sync --extra test --project services/adapter
/tmp/adapter-venv/bin/python -m pytest services/adapter          # 适配器单测
cd services/api && pnpm build && node --test dist/agent-run/jiuwenswarm-agent.test.js
node --test test/contract/*.test.mjs                              # 契约测试工具自身
E2E_BASE_URL=... E2E_API_TOKEN=... node test/contract/run.mjs --compare test/contract/baselines/legacy-linux.json
```
