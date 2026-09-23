# JiuwenSwarm runtime behavior

This is a behavior reference, not a setup guide. The packaged binary and Docker image already include
JiuwenSwarm and use it by default. Local source mode uses the native loop unless you explicitly pass
`--jiuwenswarm`; see [Deployment](../getting-started/deployment.md) for both modes.

## Check the active backend

On the adapter/JiuwenSwarm path, `GET /agent/info` on the public port reports the active backend and
whether JiuwenSwarm is reachable. The default native loop in local source mode does not expose this
endpoint. For the packaged binary and Docker image, use `--no-jiuwenswarm` only when you deliberately
need the native loop.

## Important behavior boundaries

- JiuwenSwarm keeps the model conversation in its own per-agent sessions and applies its own context
  handling. ScienceDiscovery continues to own the visible Project, Session, run, and artifact records.
- JiuwenSwarm's host-acting implementations of `bash`, `read_file`, `write_file`, `edit_file`, `glob`,
  `list_files`, `grep`, and `read_pdf` are blocked in every tool mode. The adapter rejects an attempted
  native call. A ScienceDiscovery tool with the same name remains available when the run provides it;
  use `run_shell` for commands and scripts.
- Its default toolset otherwise includes JiuwenSwarm-native web, planning, skill, and subagent tools, plus
  ScienceDiscovery tools where no JiuwenSwarm-native tool of the same name supersedes them. A native
  `subagent_spawn` child stays inside JiuwenSwarm and does not receive ScienceDiscovery's workspace handoff,
  sandboxed tools, permissions, provenance, or subagent cards.
- Skill switches in **System configuration → Skills → In JiuwenSwarm** apply to future JiuwenSwarm
  sessions globally, rather than selecting skills separately for a Project or Session.

For compatibility scope, tested behavior, and known limitations, see
[JiuwenSwarm migration status](jiuwenswarm-migration-status.md).
