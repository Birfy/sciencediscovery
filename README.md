<div align="center">

# ScienceDiscovery

**The one-stop AI research workspace, built for scientists.**

Literature review, hypothesis, code, experiments and tuning — in one environment, with every step on the record.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/release-0.2.0-brightgreen.svg)](https://github.com/openJiuwen-ai/sciencediscovery/releases/tag/0.2.0)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS-lightgrey.svg)](#requirements)

[Download](#install) · [Quick start](docs/en/tutorial/01-quick-start.md) · [Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md) · [中文](README_zh.md)

<img src="docs/images/task.png" width="920" alt="The ScienceDiscovery workspace: project and session navigation, the composer, and the artifact, reviewer and provenance panels" />

</div>

## What it is

A local research workspace where an agent reads the literature, writes and runs code in a sandbox, and records where every result came from. It runs on your own machine, against your own files, with your own model keys.

## Install

Download the build for your architecture from [release 0.2.0](https://github.com/openJiuwen-ai/sciencediscovery/releases/tag/0.2.0):

```bash
curl -LO https://github.com/openJiuwen-ai/sciencediscovery/releases/download/0.2.0/ScienceDiscovery-0.2.0-linux-x86_64
chmod +x ScienceDiscovery-0.2.0-linux-x86_64
./ScienceDiscovery-0.2.0-linux-x86_64 serve
```

Then open the **`Open to sign in`** URL that `serve` printed. The browser saves the local
service access token for you, so there is nothing to copy. That token is not a model API key,
and the URL grants access to this machine's workspace — keep it private. The UI itself lives at
<http://127.0.0.1:4310>; nothing runs in the terminal window.

For arm64, use [`ScienceDiscovery-0.2.0-linux-aarch64`](https://github.com/openJiuwen-ai/sciencediscovery/releases/download/0.2.0/ScienceDiscovery-0.2.0-linux-aarch64). Bubblewrap is the only host dependency. Source mode (Linux and macOS) and Docker are in the [deployment guide](docs/en/how-to/deployment.md).

## Configure a model

No model ships with the product; you bring your own API. Open **System configuration** at the bottom of the left sidebar and fill in two places:

1. **Model registry** — pick a preset provider, or enter a **Base URL** by hand; paste the **API key**, then add the model you want to use.
2. **Global defaults** — set the model you just added as the **task model**.

What each field means, and which ones an environment variable can set instead: [Configuration](docs/en/reference/configuration.md).

## First task

Create a Project and a Session, drop a CSV or a PDF into the workspace, and describe what you want analysed. Approve the permission card for the first code execution, and the tool calls and artifacts appear in the timeline. Step by step: [Quick Start](docs/en/tutorial/01-quick-start.md).

## What you can do

| Capability | What it means | Learn more |
|---|---|---|
| **Literature and data at hand** | Built-in connectors reach paper and data repositories; PDFs are parsed into citable evidence | [Literature research case](docs/en/how-to/literature-research-case-guide.md) · [Custom MCP servers](docs/en/how-to/configure-custom-mcp.md) |
| **Code that actually runs** | The agent writes, debugs and runs Python, R and shell in a fail-closed sandbox | [Sandbox execution](docs/en/explanation/sandbox-execution.md) |
| **Complex tasks, decomposed** | Planning and multi-agent orchestration split a task across sub-agents and a cross-domain skill library | [Subagent orchestration](docs/en/explanation/subagent-orchestration.md) · [Skills](docs/en/explanation/skill-progressive-disclosure.md) |
| **Every result traceable** | Code, environment, logs and cited evidence are recorded per deliverable; the optional memory graph makes the chain clickable | [Review and provenance](docs/en/explanation/review-provenance.md) · [ScienceMemory](docs/en/how-to/science-memory-setup.md) |

## Command line

A running `serve` can also be driven from the terminal:

```bash
./ScienceDiscovery run "Summarize these results" > answer.md
cat prompt.txt | ./ScienceDiscovery run --stdin --auto-approve | jq .
```

`run` connects to the same control plane as the browser and reads the access token from the data directory, so sharing a `--data-dir` with `serve` needs no further setup. On a terminal the answer goes to stdout and progress to stderr; when piped it emits JSONL, and a non-interactive run must pass `--auto-approve` because it cannot answer permission prompts. Full options: `./ScienceDiscovery run --help`.

## Requirements

| Path | Host requirements |
|---|---|
| **Prepackaged binary** | Linux x86_64/aarch64, Bubblewrap |
| **Local source mode** | Linux x86_64/aarch64 or macOS x64/arm64; Node.js 22.19+, pnpm 11.1.2, Python 3, uv 0.9+, Git; Bubblewrap on Linux, built-in Seatbelt on macOS |
| **Docker** | Linux x86_64/aarch64, Docker Engine 24+, Compose v2, unprivileged user namespaces |

Managed scientific environments run on a pinned micromamba, so no system Python, R or conda is needed.

## How it works

A browser UI talks to a Node control API. Each agent run is driven by a Python Gateway, while workspace tools, sandbox execution, scientific connectors, PDF extraction, permissions, provenance and review checks are enforced by the Node control plane.

> [!WARNING]
> ScienceDiscovery is not a multi-user production service. The API, runner, and gateway listen on loopback by default; the API uses one bearer token and does not terminate TLS. Exposing the API on another interface must be an explicit deployment choice on a trusted, secured network. Python, R, and shell commands run in a fail-closed platform sandbox (Bubblewrap on Linux and Seatbelt in macOS source mode); the control API, gateway, PDF worker, and outbound model/provider calls run outside that sandbox as trusted control-plane operations.

## Documentation

| Section | Guides |
|---|---|
| **Tutorial** | [Quick start](docs/en/tutorial/01-quick-start.md) |
| **How-to** | [Deployment](docs/en/how-to/deployment.md) · [Custom MCP](docs/en/how-to/configure-custom-mcp.md) · [Network proxy](docs/en/how-to/configure-network-proxy.md) · [ScienceMemory](docs/en/how-to/science-memory-setup.md) |
| **Reference** | [Configuration](docs/en/reference/configuration.md) · [REST API](docs/en/reference/rest-api.md) · [Built-in tools](docs/en/reference/builtin-tools.md) · [Runtime behavior](docs/en/reference/runtime-behavior.md) |
| **Explanation** | [Architecture](docs/en/explanation/architecture.md) and the [full index](docs/en/explanation/README.md) |

Complete English and Chinese indexes: [docs/README.md](docs/README.md). Development setup and test commands: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE).

This product serves solely as a workflow orchestration tool and does not embed any AI model capabilities. When users integrate AI models for specific business scenarios, they shall bear full responsibility for compliance obligations under the EU AI Act and other relevant regulatory frameworks.
