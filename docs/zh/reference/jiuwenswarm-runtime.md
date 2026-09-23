# JiuwenSwarm 运行时行为

本文是行为参考，不是安装指南。预打包二进制与 Docker 镜像已内置 JiuwenSwarm，且默认使用它。
本地源码模式默认使用原生循环，只有显式传入 `--jiuwenswarm` 才会切换；两种模式的启动方法见
[部署指南](../getting-started/deployment.md)。

## 确认当前后端

适配器/JiuwenSwarm 路径上，公共端口的 `GET /agent/info` 会说明当前后端，并报告 JiuwenSwarm
是否可达。本地源码模式的默认原生循环没有该端点。预打包二进制与 Docker 镜像仅在确实需要原生
循环时才传入 `--no-jiuwenswarm`。

## 重要行为边界

- JiuwenSwarm 在自己的每个智能体会话中保存模型对话，并使用自己的上下文管理。ScienceDiscovery
  继续持有可见的 Project、Session、运行与产物记录。
- 所有工具模式都会禁用 JiuwenSwarm 中直接操作宿主机的 `bash`、`read_file`、`write_file`、
  `edit_file`、`glob`、`list_files`、`grep` 和 `read_pdf` 实现。适配器会拒绝这类原生调用。
  若本次运行提供同名的 ScienceDiscovery 工具，该工具仍可用；命令和脚本应使用 `run_shell`。
- 除此之外，默认工具集包含 JiuwenSwarm 原生的 Web、计划、技能和子智能体工具，以及没有被同名
  JiuwenSwarm 原生工具覆盖的 ScienceDiscovery 工具。原生 `subagent_spawn` 子智能体仍在
  JiuwenSwarm 内部运行，拿不到 ScienceDiscovery 的工作区交接、沙箱工具、权限、溯源或子智能体卡片。
- **系统配置 → 技能 → JiuwenSwarm 中**的技能开关会全局应用于后续 JiuwenSwarm 会话，不能按
  Project 或 Session 单独选择。

兼容范围、已测行为与已知限制见[JiuwenSwarm 迁移状态](jiuwenswarm-migration-status.md)。
