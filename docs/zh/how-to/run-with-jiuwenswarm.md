# 在 JiuwenSwarm 上运行 agent

ScienceDiscovery 可以把 agent 循环交给 [JiuwenSwarm](https://gitcode.com/openJiuwen/jiuwenswarm) 执行，而不是使用内置循环。这是 JiuwenSwarm 迁移（issue 84）引入的**可选、实验性**执行器；内置循环仍是默认，不打开就没有任何变化。

保持不变的部分：Web 界面、会话、消息、运行事件、权限请求、Runner 及其沙箱、产物与溯源。工具仍然在 ScienceDiscovery API 进程内执行，所以每一项权限检查和 Runner 规则都和以前一样。换掉的部分：模型循环及其对话上下文。

```text
浏览器 ─▶ adapter（公开端口）─▶ 旧 API（端口 + 100）
              │                        │
              └─▶ JiuwenSwarm ◀────────┘   工具在 API 内执行，经每次运行独立的桥接回调
```

## 前置条件

- 源码模式（见[部署](../getting-started/deployment.md#本地模式宿主进程)）；二进制和 Docker 镜像暂不包含这个执行器。
- 宿主机有 `git` 和 `uv`。JiuwenSwarm 装在自己的目录和虚拟环境里，不会装进 ScienceDiscovery 的环境。
- 能访问 `gitcode.com`（克隆固定版本）和一个 PyPI 源。网络慢或在中国大陆时，把 `SCIENCE_AGENT_PYPI_INDEX` 设为镜像；下载超时可调 `UV_HTTP_TIMEOUT`（脚本默认 300 秒）。
- 模型端点需使用 **OpenAI chat-completions** 协议。Anthropic Messages 和 OpenAI Responses 的模型会让运行失败并给出明确提示，这类模型请用内置循环。
- 约 1.5 GB 磁盘用于 JiuwenSwarm 安装。

## 1. 安装并启动 JiuwenSwarm

```bash
scripts/jiuwenswarm.sh setup     # 克隆固定版本（workswarm0.2.6）、安装、创建实例
scripts/jiuwenswarm.sh start     # 启动并等待网关就绪
scripts/jiuwenswarm.sh status
```

`setup` 可重复执行，并应用 ScienceDiscovery 依赖的唯一一项 JiuwenSwarm 配置：实例 `config/config.yaml` 中的 `progressive_tool_enabled: false`。JiuwenSwarm 默认值是 `true`，此时一次运行的工具会被藏在“搜索工具”这一步后面，模型看不到 ScienceDiscovery 定义的工具名。

JiuwenSwarm 把实例工作区建在 `~/.jiuwenswarm-instances/<名称>`（它没有改位置的选项）。实例名为 `sciencediscovery`，端口独立分配，不会和同机的默认 JiuwenSwarm 冲突。

| 变量 | 默认值 | 含义 |
|---|---|---|
| `JIUWENSWARM_TAG` | `workswarm0.2.6` | 安装的版本。目前只验证过 0.2.6。 |
| `JIUWENSWARM_ROOT` | `.sciencediscovery-data/jiuwenswarm` | 安装目录 |
| `JIUWENSWARM_INSTANCE` | `sciencediscovery` | 实例名 |
| `JIUWENSWARM_GIT_URL` | `https://gitcode.com/openJiuwen/jiuwenswarm.git` | 克隆来源 |

不需要在 JiuwenSwarm 里配置模型：你在 ScienceDiscovery 里选的模型，会在每次运行时交给 JiuwenSwarm。

## 2. 用该执行器启动 ScienceDiscovery

```bash
SCIENCE_AGENT_ADAPTER=1 SCIENCE_AGENT_EXECUTOR=jiuwenswarm ./scripts/start-stack.sh --mode local
```

`start-stack.sh` 通过 `scripts/jiuwenswarm.sh env` 找到 JiuwenSwarm 实例；实例不可达或没开启 adapter 时会拒绝启动并给出明确提示。要连接不由脚本管理的 JiuwenSwarm，自行设置 `JIUWENSWARM_GATEWAY_URL` 和 `JIUWENSWARM_MGMT_URL`。

开启 adapter 后，adapter 占用公开端口（默认 4310），旧 API 移到公开端口加 100。访问地址和以前相同。要回退，去掉这两个变量重新启动即可。

## 预期行为

- 与内置循环相同的对话、工具卡片、权限提示、计划、子 agent 和产物；里程碑 0 的用例在该执行器上通过。
- 对话历史由 JiuwenSwarm 按会话保存。切换执行器时，已有的内置循环历史**不会**带过去；被恢复的子 agent 也拿不到它此前的历史。
- 新增模型时，JiuwenSwarm 会向它发一次很小的探测请求（用于判断是否支持图片输入）。
- token 用量按每次模型调用上报，包含推理 token。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| `start-stack.sh` 提示 JiuwenSwarm 不可达 | 执行 `scripts/jiuwenswarm.sh start`，再用 `scripts/jiuwenswarm.sh status` 确认。日志：`.sciencediscovery-data/jiuwenswarm/jiuwenswarm.log` 与 `~/.jiuwenswarm-instances/<名称>/agent/.logs/`。 |
| 运行失败，提示 `... protocol is not supported by this executor yet` | 所选模型用的是 Anthropic Messages 或 OpenAI Responses。请换 OpenAI chat-completions 模型，或不设置 `SCIENCE_AGENT_EXECUTOR` 启动。 |
| 模型从不调用工具 | 检查实例配置里的 `progressive_tool_enabled: false`；`scripts/jiuwenswarm.sh setup` 会恢复它。 |
| 仅经该执行器访问时提供方返回 `403` | 部分网关会按 `User-Agent` 过滤。请用同一个 key 直接 `curl` 测试端点，并反馈响应内容。 |
| 想看一次运行做了什么 | `SCIENCE_AGENT_ADAPTER_DEBUG=1`（adapter 的工具事件）和 `SCIENCE_AGENT_JIUWENSWARM_DEBUG=1`（API 的工具调用）会把它们打到栈日志里。 |

设计说明和在 JiuwenSwarm 0.2.6 上实测的协议事实见 [`services/adapter/README.md`](../../../services/adapter/README.md)。
