# ScienceDiscovery 中文文档

[English documentation](../en/README.md) | [文档总入口](../README.md)

这是 ScienceDiscovery 的完整中文文档集。

## 快速开始

- [快速开始](getting-started/quick-start.md) — 安装、启动、配置模型并完成第一次 Agent 任务。
- [部署](getting-started/deployment.md) — 本地模式、Docker 和源码构建单文件二进制的操作步骤。

## 核心能力

- [程序演进](core/evolve.md) — 理解搜索、打分模式、引擎、数据切分和结果可信度。
- [Shell、环境与 Workspace](core/execution-workspaces.md) — 理解执行、文件、环境、完成与停止行为。
- [Idea Tree](core/idea-tree.md) — 理解自主研究引擎的使用方式、状态和边界。

## 领域指南

- [演进出一个更优解](domains/evolve-a-solution.md) — 完整跑一次程序演进搜索，并判断改进是不是真的。
- [文献调研](domains/literature-research.md) — 以跨数据库文献调研为例，演示从启动服务、配置系统到审批与查看结果的全流程。

## How-to（操作指南）

- [配置自定义 MCP](how-to/configure-custom-mcp.md) — 本地/远程连接、秘密值编辑、OAuth、Inspector 与会话工具选择。
- [在 JiuwenSwarm 上运行 agent](how-to/run-with-jiuwenswarm.md) — 可选的实验性执行器：安装固定版本的 JiuwenSwarm、带 adapter 启动服务，并了解预期行为。
- [配置网络代理](how-to/configure-network-proxy.md) — 在设置页添加代理并为 LLM、Web 和 MCP 选择策略。
- [运行一次演进搜索](how-to/run-an-evolution-search.md) — 提出 `/evolve-design` 搜索、定分片规模、看过程，并读留出结果。
- [安装 Neo4j 与配置科学记忆](how-to/science-memory-setup.md) — 安装外部 Neo4j、在系统设置里开启科学记忆，并在前端图谱里查看链路。

## Reference（参考）

- [配置、端口与存储](reference/configuration.md) — 环境变量、默认端口、上传/工作区/输出配额和数据布局。
- [REST API](reference/rest-api.md) — 当前 UI 使用的内部 HTTP 接口、认证、请求/响应与错误语义。
- [运行时行为](reference/runtime-behavior.md) — 模型、设置继承、技能、权限、超时和执行限制。
- [内置工具](reference/builtin-tools.md) — 模型可见工具的参数、边界和暴露条件。
- [Web 工具](reference/web-tools.md) — Web Search/Fetch provider、配置、权限、缓存与审计。
- [JiuwenSwarm 迁移状态](reference/jiuwenswarm-migration-status.md) — 已实现范围、已知缺口与后续交接方式。

## 开发者文档

见[开发者文档导航](developer-docs/README.md)，其中包括架构、模块边界、协议和当前有效的特性设计。

## 其他资料

- [贡献指南](../../CONTRIBUTING.md)
- [License](../../LICENSE)
