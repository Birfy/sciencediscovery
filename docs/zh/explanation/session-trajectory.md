# Session 轨迹与模型上下文

Session 标题旁的 **轨迹** 入口打开只读查看器。它将主 Agent、子 Agent 的执行放到同一个真实时间坐标中，并提供节点详情和 NDJSON 导出。

## 如何使用

1. 执行任务后打开轨迹；运行中也可点击刷新读取最新已发布记录。
2. 每个 Agent 有独立条带；颜色区分状态、模型输入、输出、思考、工具、MCP 和生命周期。点击标记或左侧事件行选择节点，可按类型或 Agent 筛选。
3. 在「模型上下文」查看该调用真正使用的输入；「Agent 状态」查看固定 StateView 对应的状态；「事件内容」查看返回的思考、工具输入输出等；「组装证据」查看动态上下文选择、预算与回退记录。
4. 上下文右侧彩色导航按贡献来源着色，点击跳到对应段落。未记录来源的消息会明确标注，不根据内容猜测贡献者。
5. 导出 NDJSON 保存轨迹证据。文件可能包含用户对话和工具返回的敏感业务内容，请妥善保管。

## 组件与数据链路

```text
AgentVersionRecorder ── State / Context / Step / EventSegment ── CAS
SessionStore ────────── 主/子/工具事件流 + MCP 审计
                                  │
API 鉴权与 Session 范围适配 ── trajectory/server
                                  │ index / detail / export
Session 入口 ── 认证 TrajectoryPort ── trajectory/web
```

`packages/trajectory` 拥有合同、只读投影和查看器；`services/api/src/trajectory.ts` 注入 Session 的 Agent 范围和事件；HTTP 宿主负责认证，Web 宿主只负责入口和认证请求。组件不反向依赖 services/apps，不改 AgentLoop 或工具权限。

模型输入来自 `ModelContextSnapshot.input`，边界是 `ProviderModelClient.invoke`，不是当前重新组装的上下文，也不是供应商协议转换后的网络报文。对应 `ContextAssemblyRecord.state` 指向固定状态版本。新事件记录 `contextRef` 和 `recordedAt`，通过引用关联具体调用；同一 turn 输入超限重试仍可区分各次输入。模型只返回了部分思考时，只展示这部分，不生成缺失内容。

系统提示来源需以 `admitted.sections`、`rendered.sectionIds` 与实际 `systemPrompt` 逐字核对。未通过核对或走 legacy 回退时显示实际系统提示并标注来源不可用；候选贡献/压缩过程留在组装证据中，不冒充最终输入。工具定义与消息按实际输入顺序展示。

## 接口与导出

| 接口 | 返回 |
|---|---|
| `GET /api/sessions/:id/trajectory` | Agent 列表、节点摘要、真实时间和完整性提示 |
| `GET /api/sessions/:id/trajectory/detail?id=…` | 本 Session 节点及其上下文、状态和组装证据 |
| `GET /api/sessions/:id/trajectory/export` | NDJSON 下载 |

导出首行为 `type: trajectory`，随后为 `type: entry` 的自包含详情，末行为 `type: complete` 和记录数。断流或读取失败的文件没有完整结束标记，不能当作完整导出。导出是观察证据，不是可执行恢复包：工作区二进制、外部 MCP 服务和环境进程不随文件打包。

API 不提供任意 CAS 地址读取，必须先解析当前 Session 的主子 Agent 和发布引用；不存在的 Session/节点返回 404，未认证返回 401。结构化凭证字段会脱敏，但自由文本仍可能含敏感内容。

## 兼容性与限制

- 新增时间/关联字段向后兼容；历史记录缺少时间时列出但不伪造时间轴位置，缺上下文关联时明确提示。
- 成功 Step 仍原子提交。失败/取消输入通过审计根保留；run 收尾保存最后部分事件，但不推进成功 head。进程被强杀、持久化失败等未落盘内容无法恢复。
- 正在运行时，Session 事件流先可见；精确事件与上下文关联在 turn 提交或 run 收尾后发布，刷新后读取。不用当前状态补造未发布快照。
- 详情按需读取；连续模型 token 包合为显示区间，详情保留原包。当前不提供无限体量的性能承诺，超大历史的分页/虚拟列表可继续演进。
- 这是基础观测组件，不是新的模型工具或插件启停项。导出/查看不会执行模型、工具、恢复、发布或演进操作。

参见：[组件与插件机制](plugins.md)、[Agent 后端](agent-backend.md)、[内容寻址存储](cas.md)。
