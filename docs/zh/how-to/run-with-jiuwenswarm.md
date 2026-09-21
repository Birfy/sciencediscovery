# 在 JiuwenSwarm 上运行智能体

ScienceDiscovery 可以让智能体循环跑在 [JiuwenSwarm](https://gitcode.com/openJiuwen/jiuwenswarm) 上，而不是内置循环。这是 JiuwenSwarm 迁移（issue 84）引入的**可选、实验性**后端。默认仍是内置循环；不按下面的方法选择，就没有任何变化。

不变的部分：网页界面、会话、消息、运行事件、权限请求、Runner 及其沙箱、产物与溯源。工具仍在 ScienceDiscovery 的 API 进程里执行，所以每一项权限检查和 Runner 规则照旧。变化的部分：模型循环，以及对话上下文（由 JiuwenSwarm 保存并压缩）。

```
浏览器 ─▶ 适配器（公共端口）─▶ API（端口 + 100）
              │                     │
              └─▶ JiuwenSwarm ◀─────┘   工具在 API 里执行，经每次运行一个的桥回调
                       │
                       └─▶ 模型，经 API 里的回环网关（前端能配置的协议都可以）
```

哪些已实现、哪些没有：[JiuwenSwarm 迁移：现状与交接](../reference/jiuwenswarm-migration-status.md)。

## 选择后端

| | 内置循环（默认） | JiuwenSwarm |
|---|---|---|
| 启动 | `./scripts/start-stack.sh --mode local` | `./scripts/start-stack.sh --mode local --jiuwenswarm` |
| 等价的环境变量写法 | （什么都不设） | `SCIENCE_AGENT_ADAPTER=1 SCIENCE_AGENT_EXECUTOR=jiuwenswarm` |
| 浏览器旅程 | `.ci/run-e2e.sh mocked` | `CI_E2E_BACKEND=jiuwenswarm .ci/run-e2e.sh mocked`（JiuwenSwarm 需已在运行） |
| 公共端口 | API 占 4310 | 适配器占 4310，API 在 4410 |
| 模式 | 本地、Docker、二进制 | **只支持本地（源码）模式** |

后端在栈启动时选定，界面里没有切换开关。要回到内置循环，不带该参数（也不设那两个变量）重新启动即可。两种后端用的是同一份数据目录（会话、项目、模型、设置、界面上的消息），但**模型的对话上下文不共用**：JiuwenSwarm 自己保存上下文，并且一开始是空的。所以在内置循环上开始的会话，界面上能看到之前的轮次，但 JiuwenSwarm 不记得它们；切换后如果在意，请新开一个会话。反过来没有问题：内置循环会读取 JiuwenSwarm 那些运行的记录。

**确认当前跑的是哪个后端：**

```bash
curl -s -H "Authorization: Bearer $SCIENCE_AGENT_AUTH_TOKEN" http://127.0.0.1:4310/agent/info
# {"adapter":true,"executor":"jiuwenswarm","jiuwenswarm":{"gatewayUrl":"ws://...","managementUrl":"ws://...","reachable":true},"toolTimeoutSeconds":3600}
```

跑内置循环、或者没有带适配器启动的栈，没有 `/agent/info`。JiuwenSwarm 栈的日志里，每次对话都会出现适配器的 `POST /agent/runs`、`POST /llm/…` 和 `POST /mcp/…`。

## 前置条件

- 源码模式（见[部署](deployment.md#local-mode-host-processes)）；二进制包和 Docker 镜像不含适配器和 JiuwenSwarm。
- 主机上有 `git` 和 `uv`。JiuwenSwarm 装在它自己的目录和虚拟环境里，不会装进 ScienceDiscovery 的环境。
- 能访问 `gitcode.com`（克隆固定版本）和 PyPI 源。网络慢或在中国大陆时，把 `SCIENCE_AGENT_PYPI_INDEX` 设为镜像；下载超时再设 `UV_HTTP_TIMEOUT`（脚本默认 300 秒）。
- JiuwenSwarm 的安装大约占 1.5 GB 磁盘。
- 前端能配置的模型都可以：OpenAI chat completions、OpenAI Responses、Anthropic Messages，以及它们的供应商变体。模型照常在 ScienceDiscovery 里配置，JiuwenSwarm 自己不需要配模型。

## 安装与启动

```bash
scripts/jiuwenswarm.sh setup     # 一次性：克隆固定版本（workswarm0.2.6）、安装、创建实例
./scripts/start-stack.sh --mode local --jiuwenswarm    # 如果 JiuwenSwarm 没在运行会先启动它，再启动整套栈
```

`setup` 是幂等的，并会写入 ScienceDiscovery 依赖的一项 JiuwenSwarm 设置：实例 `config/config.yaml` 里的 `progressive_tool_enabled: false`。JiuwenSwarm 默认是 `true`，那样一次运行的工具会藏在一个搜索步骤后面，模型就看不到 ScienceDiscovery 定义的那些工具名。JiuwenSwarm 没装时，`--jiuwenswarm` 会带提示直接拒绝启动。

想自己管理 JiuwenSwarm：`scripts/jiuwenswarm.sh start | stop | status | env`。JiuwenSwarm 会在 `~/.jiuwenswarm-instances/<name>` 下创建实例工作区（它没有办法改位置）。实例名是 `sciencediscovery`，有自己的端口，不会和同一台机器上默认的 JiuwenSwarm 冲突。想用脚本不管理的 JiuwenSwarm，自己设 `JIUWENSWARM_GATEWAY_URL` 和 `JIUWENSWARM_MGMT_URL`。

## 配置

全部是栈上的环境变量（写在 `.env` 里，或在 `start-stack.sh` 之前导出）。用 JiuwenSwarm 只需要第一组。

| 变量 | 默认值 | 含义 |
|---|---|---|
| **选择** | | |
| `--jiuwenswarm`（参数） | 关 | 设置下面两个变量，并在需要时启动 JiuwenSwarm |
| `SCIENCE_AGENT_ADAPTER` | 未设置 | `1` 让适配器占公共端口，挡在 API 前面 |
| `SCIENCE_AGENT_EXECUTOR` | 未设置 | `jiuwenswarm` 让智能体跑在 JiuwenSwarm 上（需要适配器） |
| **JiuwenSwarm 实例** | | |
| `JIUWENSWARM_ROOT` | `.sciencediscovery-data/jiuwenswarm` | 安装目录 |
| `JIUWENSWARM_INSTANCE` | `sciencediscovery` | 实例名 |
| `JIUWENSWARM_TAG` | `workswarm0.2.6` | 安装的版本，只验证过 0.2.6 |
| `JIUWENSWARM_GIT_URL` | `https://gitcode.com/openJiuwen/jiuwenswarm.git` | 克隆来源 |
| `JIUWENSWARM_GATEWAY_URL` | 从实例读取 | 网关的对话路由，例如 `ws://127.0.0.1:20001/tui` |
| `JIUWENSWARM_MGMT_URL` | 从实例读取 | 用于 `mcp.*`、`models.*` 的 web 通道，例如 `ws://127.0.0.1:20000/ws` |
| `SCIENCE_AGENT_PYPI_INDEX`、`UV_HTTP_TIMEOUT` | 未设置、`300` | 安装时的 PyPI 镜像和下载超时 |
| **端口与地址** | | |
| `SCIENCE_AGENT_PORT` | `4310` | 公共端口（适配器的） |
| `SCIENCE_AGENT_LEGACY_PORT` / `SCIENCE_AGENT_LEGACY_URL` | 端口 + 100 | 适配器后面的 API 监听在哪 |
| `SCIENCE_AGENT_ADAPTER_URL` | `http://127.0.0.1:<端口>` | API 怎样访问适配器 |
| `SCIENCE_AGENT_ADAPTER_PUBLIC_URL` | `http://127.0.0.1:<端口>` | JiuwenSwarm 怎样访问适配器（每次运行的 MCP 和模型路由） |
| `SCIENCE_AGENT_HOST` | `127.0.0.1` | 适配器绑定的网卡 |
| `SCIENCE_AGENT_ADAPTER_TOKEN` | 未设置 | API 访问 `/agent/*` 时带的 Bearer token；适配器监听在回环之外时请设置 |
| **一次运行的行为** | | |
| `SCIENCE_AGENT_ADAPTER_TOOL_TIMEOUT_S` | `3600` | 单次工具调用最长多久（JiuwenSwarm 自己的限制是 30 秒；API 有运行超时时会传运行的超时） |
| `SCIENCE_AGENT_JIUWENSWARM_PLANNING` | 未设置 | `todo`：模型用 JiuwenSwarm 的 todo 工具做计划，它的清单就是计划。默认是 `update_plan` |
| `SCIENCE_AGENT_LLM_MAX_TOKENS` | `16384` | 每次模型调用的输出预算（与内置循环共用）；推理模型请调大 |
| `SCIENCE_AGENT_LLM_MAX_RETRIES`、`SCIENCE_AGENT_LLM_TIMEOUT_SECONDS` | `2`、`600` | 重试次数（429 等瞬时错误）和单次调用超时（共用） |
| **诊断** | | |
| `SCIENCE_AGENT_ADAPTER_DEBUG` | 未设置 | `1` 打印每次运行的每个工具事件和每个模型请求的最后几条消息（适配器） |
| `SCIENCE_AGENT_JIUWENSWARM_DEBUG` | 未设置 | `1` 记录桥上的每次工具调用（API） |

模型仍照常在界面里逐个设置：供应商、协议与变体、API key、思考模式、网络代理。模型的上下文窗口（来自模型目录，或你在模型设置里的覆盖值）会传给 JiuwenSwarm，它据此按模型真实的上限压缩对话。

## 使用时会看到什么

- 与内置循环相同的对话、工具卡片、权限提示、计划、子代理和产物；里程碑 0 的旅程在这个后端上通过。
- JiuwenSwarm 把每个智能体（主智能体和每个子代理）的对话保存在自己的会话里，并在模型窗口快满时压缩。运行契约和 ScienceDiscovery 每一步的上下文（计划快照、持久状态）**不会**注入。
- 对话、计划和事件的数据仍保存在 ScienceDiscovery 自己的存储里。
- JiuwenSwarm 的运行没有轨迹和 evidence 记录，图片也不会发给模型。
- 新增一个模型时，JiuwenSwarm 会向它发一条很小的探测请求（检测是否支持图片输入）；网关会拒绝那张图片，所以日志里出现一条 `400` 是预期的。
- 用量按每次模型调用统计，包含推理 token。
- 运行期间与 JiuwenSwarm 的连接断开时，适配器会把这次运行接回来（`chat.resume`）；断开期间发出的内容会丢失。

## 排错

| 现象 | 原因与处理 |
|---|---|
| `start-stack.sh` 提示 JiuwenSwarm 没装或连不上 | 先执行一次 `scripts/jiuwenswarm.sh setup`，再用 `--jiuwenswarm`；或者 `scripts/jiuwenswarm.sh start` 后用 `status` 查看。日志：`.sciencediscovery-data/jiuwenswarm/jiuwenswarm.log` 和 `~/.jiuwenswarm-instances/<name>/agent/.logs/`。 |
| `/agent/info` 里 `"reachable": false` | JiuwenSwarm 没运行，或地址不对。用 `scripts/jiuwenswarm.sh status` 检查；脚本不管理的实例要自己设 `JIUWENSWARM_GATEWAY_URL`/`JIUWENSWARM_MGMT_URL`。 |
| 模型从不调用工具 | 检查实例配置里的 `progressive_tool_enabled: false`；`scripts/jiuwenswarm.sh setup` 会恢复它。 |
| 子代理或长命令在 30 秒后以空错误结束 | 这是 JiuwenSwarm 自己对单次 MCP 调用的限制。适配器按运行提高了它（`SCIENCE_AGENT_ADAPTER_TOOL_TIMEOUT_S`）；如果还看到，说明适配器版本早于此修复。 |
| 运行停在半句思考上，或提示 “cut off at its output limit” | 推理模型把每次调用的输出预算（`max_tokens`，默认 16384）全花在思考上了。在栈上调大 `SCIENCE_AGENT_LLM_MAX_TOKENS` 后重试。内置循环也有同样的上限。 |
| 模型返回 `429` | 供应商在限流。运行会像内置循环一样退避重试，重试用完才以供应商的原话失败。 |
| 只有走这个后端时供应商返回 `403` | 有些网关按 `User-Agent` 过滤。用 `curl` 和同一个 key 直接测试该端点，并反馈响应内容。 |
| 想看一次运行做了什么 | `SCIENCE_AGENT_ADAPTER_DEBUG=1` 和 `SCIENCE_AGENT_JIUWENSWARM_DEBUG=1` 会把它们打印到栈的日志里。 |

设计说明和针对 JiuwenSwarm 0.2.6 实测的协议事实见 [`services/adapter/README.md`](../../../services/adapter/README.md)。
