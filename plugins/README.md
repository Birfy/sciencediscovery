# 内置插件开发

完整机制和维护入口见 [插件化机制](../docs/zh/explanation/plugins.md)，本页保留包开发速查。

插件是可信、随 workspace 构建和发布的包，不是任意代码热加载或安全沙箱。
AgentLoop、工具权限、审批、CAS 和 SessionStore 仍由基座管理。

## 扩展一个能力

1. 在 `plugins/<name>` 提供独立 `manifest`；声明 ID、包/API 版本、runtime/web/platform 入口、必需/可选服务版本、权限、配置 schema 和贡献类型。
2. runtime 工厂只接收所需的领域 Ports，返回 tools/contextFactories/stateProviders/batchPolicies；需要写领域状态时调用命令端口，不在事件订阅中写状态。
3. 在 `services/api/src/plugins/catalog.ts` 登记构建期安装，运行入口通过 `runtime.ts` 提供该包的 Ports。缺少必需服务或合同版本不匹配时不激活，并保留诊断。
4. Web 包通过单独的 `./web` 入口贡献设置或视图。安装登记在 `apps/web/src/plugins/`；宿主提供翻译、图标、认证 Bridge 和作用域，不让 UI 直接取得数据库。
5. 补齐包级测试、项目启停和下一次运行的用户旅程；workspace 打包会收集 `plugins/*`，包的 exports 必须指向已构建产物。

目前安装 Skill、MCP、默认调度、Plan、UniProt、JSON 查看器。新增同类实现无需改 AgentLoop。
历史 Plan 是只读记录，关闭下一次运行的贡献不会删除历史卡片。

## 配置与状态

`RuntimeSettingsOverrides.plugins` 按插件 ID/config 字段合并 global → project → session。
省略字段表示继承，`enabled:false` 关闭下一次运行的贡献。现有插件均声明 `nextRun`；
`restart` 是 manifest 的另一种生效声明，未来采用它的进程级组件须在启动装配时冻结，不能宣称支持热切换。
凭据只能用 secret 引用，不能写入插件配置。插件启用不等于获准调用工具；原权限端口仍逐次校验。

主/子/reviewer 共用冻结的插件组合。StateProvider 提供 JSON 状态和 schema/revision；
contributor 必须声明 `stateReads`，只从该次调用的 StateView 投影。Plan 没有 StateView 就失败，
不会回退 live store。领域命令与 snapshot 通过 StateCoordinator 协调，迁移显式执行，失败不会产生新的可用投影。

## 认证 Bridge

路径前缀为 `/api/projects/:projectId/plugins`，Session 使用 `?sessionId=...`。
沿用 API bearer 认证；此单用户控制面没有另设多租户登录或赋权系统。

- `GET /`：安装清单、当前配置 revision、能力诊断。未装配的上下文不报告 active。
- `POST /bridge`：`{apiVersion:1,pluginId,scope:{projectId,sessionId?},kind,method,input}`。路径 scope 必须与 envelope 一致。
- 插件 `query/settings`、Plan `query/state({runId})` 为只读；`command/configure({expectedRevision,settings,fields?})` 只改该包声明的字段。
- 宿主 `host.settings/command/replace({expectedRevision,overrides})` 原子替换一次编辑表单，仍调用同一 SessionStore 权威，不逐插件双写。
- `GET /events`：携带 bearer 的 fetch SSE，`changed` 只通知缓存失效；断开即释放订阅。

关闭插件仍允许查看历史及重新配置，不提供该插件新的执行工具。
过期 revision 返回 409，越域拒绝；错误沿用 `{error,code}`。

## 最小候选闭环

`POST /candidates` 接收 `{expectedRevision,patch}`，仅允许插件配置和 Skill 选择/库资产；
固定库版本和资产指纹，把基线、候选保存为 CAS 记录，不修改活动组合。

依次调用 `POST /candidates/:id/prepare|compare|approve|apply|reject`：

- prepare 创建普通基线/候选实验 Session，走原 Runner、模型和权限路径；在两者提交相同任务。
- compare 接收 `{baselineRunId,candidateRunId}`，要求双方完成、任务与固定配置一致；保存实际结果和 CAS 比较记录。
- approve 是独立的显式管理操作，不由模型自动判断；apply 以基线 revision 校验后，在同一事务保存活动设置和应用回执。重试已应用请求幂等。
- reject、配置/资产漂移或持久化失败不应用候选。实验记录保留；候选只影响新运行。

prepare 创建的两个普通实验 Session 在 apply/reject 后不自动清理，避免丢失用户仍需审阅的结果。用户确认后可通过现有 Session 删除入口显式清理；候选保留的 Session/Run 引用在删除后不保证可回看。当前没有候选专属归档策略。

经典全局/项目/会话设置、Composer 更新、Bridge 和 ApplyPort 都经 SessionStore 的同一设置互斥。Bridge 的 revision 必须在锁内复查；经典 PUT 保持原有后写覆盖语义，不把历史应用回执解释为永久活动版本。

比较属于 `observed-runs`：它不是自动判优、确定性环境重放或外部副作用回滚。
自动评价、候选搜索、灰度平台、模型训练不在当前范围。
