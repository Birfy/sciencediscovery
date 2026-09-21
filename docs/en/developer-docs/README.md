# Developer Documentation

These pages describe architecture, module boundaries, protocols, and current feature designs. For user-facing behavior and precise configuration, use the [documentation index](../README.md).

- [Runtime architecture](architecture.md) — resident processes, module boundaries, and cross-process timing.
- [Control plane](control-plane.md) — responsibilities, storage, and run lifecycle of `services/api`.
- [Agent backend](agent-backend.md) — the Node-native agent loop: modules, model transport, deferred tools, compaction.
- [Sandbox execution](sandbox-execution.md) — bubblewrap/seccomp, scientific environments, and persistent-kernel mechanism.
- [Ascend NPU Host Broker](ascend-npu-runner.md) — host allowlist job scheme used when Ascend devices cannot reliably pass through to bwrap.
- [External-source rate limiting](rate-limiting.md) — MCP rate-limit base, queueing, 429 cooldown, and coverage boundaries.
- [Science connectors](science-connectors.md) — governance chain, audit, and citation for scientific MCP sources.
- [MCP tool and protocol design](mcp-tool-protocol.md) — Source Manifest, tool protocol, Agent Loop, permissions, audit, and control-plane interface.
- [Network proxy](network-proxy.md) — proxy policy resolution, outbound access, and security boundary.
- [Review and provenance](review-provenance.md) — integrity checks, semantic review, claims/evidence, and Prompt Manifest.
- [ScienceMemory](science-memory.md) — task chain, citation chain, module boundary, and storage.
- [Skill progressive disclosure](skill-progressive-disclosure.md) — catalog search and frozen-snapshot reads.
- [Subagent orchestration](subagent-orchestration.md) — parent/child Agent contract, guardrails, and trade-offs.
- [Content-addressable storage](cas.md) — CAS addressing, workspace change detection, writers, and lifecycle.
- [Dynamic context assembly](context-assembly.md) — context modes, contributors, budgets, tracing, and validation.
- [Context assembly examples](context-assembly-examples.md) — model inputs generated through the production assembly path.
- [Runtime Core boundaries](runtime-core.md) — domain-neutral runtime responsibilities and registered ports.
- [Repository layout](repository-layout.md) — directories, modules, default ports, and data locations.
- [PDF worker](paper-worker.md) — PDF extraction protocol, pipeline, and limits.
- [Web frontend](web-frontend.md) — frontend stack, event mapping, and development/test entry points.
