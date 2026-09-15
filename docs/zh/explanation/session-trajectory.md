# Session 轨迹与模型上下文

Session 标题旁的 **轨迹** 入口打开只读查看器。它将主 Agent、子 Agent 的执行放到同一个真实时间坐标中，并提供节点详情和 NDJSON 导出。

## 如何使用

1. 执行任务后打开轨迹；运行中也可点击刷新读取最新已发布记录。
2. 每个 Agent 有独立条带；颜色区分状态、模型输入、输出、思考、工具、MCP 和生命周期。点击标记或左侧事件行选择节点，可按类型或 Agent 筛选。
3. 在「模型上下文」查看该调用真正使用的输入；「Agent 状态」查看固定 StateView 对应的状态；「事件内容」查看返回的思考、工具输入输出等；「组装证据」查看动态上下文选择、预算与回退记录。
4. 上下文右侧彩色导航按贡献来源着色，点击跳到对应段落。未记录来源的消息会明确标注，不根据内容猜测贡献者。
5. 导出 NDJSON 保存轨迹证据。文件可能包含用户对话和工具返回的敏感业务内容，请妥善保管。
6. 左侧「事件时间线」显示真实事件，「历史版本」单独保留没有可靠事件时间的旧快照。Run 表示一次 Agent 执行，turn 是该 Run 内的轮次，# 是该事件流的序号；新 Run 从 turn 0 开始不表示顺序错误。

## 组件与数据链路

```text
AgentVersionRecorder ── Agent / Run 事件 JSONL ── 时间、序号、类型、引用
                                  │ contextRef / stateRef / payloadRef
                                  └───────── CAS：State / Context / Step / 正文
SessionStore ────────── 既有工具输出流 + MCP 审计 ── 补充事件入口
                                  │
API 鉴权与 Session 范围适配 ── trajectory/server
                                  │ index / detail / export
Session 入口 ── 认证 TrajectoryPort ── trajectory/web
```

`packages/trajectory` 拥有合同、只读投影和查看器；`services/api/src/trajectory.ts` 注入 Session 的 Agent 范围和事件；HTTP 宿主负责认证，Web 宿主只负责入口和认证请求。组件不反向依赖 services/apps，不改 AgentLoop 或工具权限。

模型输入来自 `ModelContextSnapshot.input`，边界是 `ProviderModelClient.invoke`，不是当前重新组装的上下文，也不是供应商协议转换后的网络报文。对应 `ContextAssemblyRecord.state` 指向固定状态版本。新事件记录 `contextRef` 和 `recordedAt`，通过引用关联具体调用；同一 turn 输入超限重试仍可区分各次输入。模型只返回了部分思考时，只展示这部分，不生成缺失内容。

### 事件与版本各司其职

`trajectory/journal` 在数据根的 `trajectories/<agent-key>/<run-key>.jsonl` 追加事件，两个 key 均为 ID 的 base64url 编码。每行包含 Agent、Agent Run、请求执行 ID、递增 sequence、记录时刻、事件类型，以及 `contextRef` / `stateRef` / `payloadRef`。采集边界先确定时间和序号，再先保存 CAS 正文、后追加入口；CAS hash 只寻址内容，不决定时间或顺序。备份必须同时保留 journal、CAS 和引用库。

`context.captured` 发布调用输入，`model.completed` 在模型返回时记录完整结果，工具开始/结束记录执行区间，`state.committed` 指向成功 Step 后的状态。运行时增量事件也进入同一 journal。单个 Agent Run 内按 sequence 排序，多个流按各自队首的记录时间合并；时钟回拨时保留原始时间并提示，不倒置同流序号。跨机器的严格因果排序不是当前承诺。

新 journal 已覆盖的模型/工具生命周期不再从聊天投影重复生成。工具输出与 MCP 审计仍从原入口读取，只在调用 ID 与 Agent/请求范围可以确切关联时挂接上下文。旧 `EventSegment` 只作为兼容事件源；旧 CAS 中的 ModelAction、State、Context 若没有事件入口关联，只在「历史版本」显示，绝不以文件修改时间、CAS hash 或整轮结束时间伪造节点时间。

系统提示来源需以 `admitted.sections`、`rendered.sectionIds` 与实际 `systemPrompt` 逐字核对。未通过核对或走 legacy 回退时显示实际系统提示并标注来源不可用；候选贡献/压缩过程留在组装证据中，不冒充最终输入。工具定义与消息按实际输入顺序展示。

## 接口与导出

| 接口 | 返回 |
|---|---|
| `GET /api/sessions/:id/trajectory` | Agent 列表、事件 entries、分离的 historicalEntries、真实时间和完整性提示 |
| `GET /api/sessions/:id/trajectory/detail?id=…` | 本 Session 节点及其上下文、状态和组装证据 |
| `GET /api/sessions/:id/trajectory/export` | NDJSON 下载 |

导出首行为 `type: trajectory`，分别列出事件与历史版本索引，随后为两类记录的 `type: entry` 自包含详情，末行为 `type: complete` 和总记录数。断流或读取失败的文件没有完整结束标记，不能当作完整导出。导出是观察证据，不是可执行恢复包：工作区二进制、外部 MCP 服务和环境进程不随文件打包。

API 不提供任意 CAS 地址读取，必须先解析当前 Session 的主子 Agent 和发布引用；不存在的 Session/节点返回 404，未认证返回 401。结构化凭证字段会脱敏，但自由文本仍可能含敏感内容。

## 兼容性与限制

- 新增时间/关联字段向后兼容；历史记录缺少时间时列出但不伪造时间轴位置，缺上下文关联时明确提示。
- 成功 Step 仍原子提交。失败/取消输入通过审计根保留；run 收尾保存最后部分事件，但不推进成功 head。进程被强杀、持久化失败等未落盘内容无法恢复。
- 正在运行时只读取已完整写入的 JSONL 行；未完成尾行跳过并提示刷新，序号缺口/损坏记录提示不完整。输入在模型调用前发布，增量串行写入，模型返回、Step 提交和 run 收尾排空队列。不用当前状态补造未发布快照，也不声称文件追加具有跨存储事务或断电持久化保证。
- 详情按需读取；连续模型 token 包合为显示区间，详情保留原包。当前不提供无限体量的性能承诺，超大历史的分页/虚拟列表可继续演进。
- 这是基础观测组件，不是新的模型工具或插件启停项。导出/查看不会执行模型、工具、恢复、发布或演进操作。

参见：[组件与插件机制](plugins.md)、[Agent 后端](agent-backend.md)、[内容寻址存储](cas.md)。
