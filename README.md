# Cortx

Cortx is a TypeScript agent foundation for building small prompt-driven agents and larger coding-agent products on the same core.

The current architecture is intentionally split:

- `@cortx/core` is the single-agent execution kernel.
- `@cortx/runtime` is the multi-session host for workspaces, capabilities, approvals, durable state, and event history.
- `@cortx/server` exposes runtime sessions through HTTP and SSE.
- `@cortx/tui` is an Ink frontend that can run local runtime sessions or connect to a remote server.
- `@cortx/web` is a React remote frontend backed by the server API.
- `@cortx/sdk` defines stable tool, event, policy, and extension contracts.
- `@cortx/store` reduces agent events into UI-ready state.

Concrete coding tools are not built into core or runtime. Official workspace tools live in the sibling `cortx-plugins` repository and are mounted by runtime through plugin-provided tool profiles.

## Repository Layout

```text
packages/
  core/      single-agent loop, tool pipeline, checkpoints, control signals
  runtime/   multi-session host, workspace validation, capabilities, durable state
  server/    REST/SSE adapter for runtime
  sdk/       public contracts and plugin authoring helpers
  store/     shared event-to-state reducer
  tui/       local/remote terminal frontend
  web/       remote-only React workbench
examples/
  skill-packs/basic/
docs/
  architecture/
  progress/
  plans/
  brainstorms/
  ideation/
```

There is no `packages/code` package. Workspace tools moved to `../cortx-plugins/workspace-tools`.

## Quick Start

Install dependencies:

```sh
bun install
```

Run tests:

```sh
bun test
```

Start the server:

```sh
bun run --cwd packages/server start
```

Start the web frontend in another terminal:

```sh
bun run --cwd packages/web dev
```

Start the TUI:

```sh
bun run --cwd packages/tui start
```

Use remote TUI mode:

```sh
CORTX_TUI_MODE=remote CORTX_SERVER_URL=http://localhost:3000 CORTX_API_KEY=cortx-dev-key bun run --cwd packages/tui start
```

The server reads `cortx.json` from the Cortx config directory managed by `@nerax-ai/storage`. If no config exists, start the TUI first or create the config with provider settings.

Useful server environment variables:

- `PORT`: server port, default `3000`
- `CORTX_API_KEY`: default development API key, default `cortx-dev-key`
- `CORTX_WORKSPACE_ROOTS`: path-list of allowed workspace roots
- `CORTX_WORKSPACE_TOOLS_PLUGIN`: override the official workspace tools plugin path
- `CORTX_MAX_RUNNING_SESSIONS` or `CORTX_MAX_SESSIONS`: running session capacity
- `CORTX_CONTEXT_WINDOW_TOKENS`: configured context window when provider metadata is unavailable
- `CORTX_DURABLE_DIR`: durable runtime state directory

## Official Plugins

Official tool implementations live outside this repository:

- `../cortx-plugins/workspace-tools`

That plugin contributes workspace-scoped tools such as `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`, plus tool profiles such as `none`, `read-only`, `coding`, and `all`.

Runtime resolves a session `toolMode` to a plugin-provided `runtime.toolProfile`. New plugins can add new profiles, such as an `ops` profile, without changing core.

## Current Documentation

Start here:

- [Docs index](docs/README.md)
- [Core + Runtime blueprint](docs/architecture/cortx-core-runtime-blueprint.md)
- [SDK and core extension guide](docs/architecture/sdk-and-core-extension-guide.md)
- [Official plugin architecture](docs/architecture/cortx-official-plugins.md)
- [Server API](docs/server-api.md)
- [Remaining work](docs/progress/2026-07-05-cortx-remaining-work.md)

Older brainstorm, ideation, and plan documents are kept as historical design artifacts. Some of them describe pre-runtime-host architecture and may mention the removed `@cortx/code` package. Use the docs index to identify the current authority before relying on an older document.

## Roadmap Shape

Cortx is past the main architecture-alignment phase. The next work is productization:

- Real-provider dogfood across TUI local, TUI remote, and Web remote.
- Web and TUI polish for long sessions, tools, sub-agents, approvals, history, and recovery.
- More official plugins and SkillPack examples.
- A stronger asset manager for AgentSpec and SkillPack installation, discovery, and updates.
- Operational hardening such as profiling, database-backed durable storage, archive policies, and SaaS-grade authorization.

The core rule for future work is simple: only single-agent execution semantics belong in `@cortx/core`. Product capabilities should be added through runtime capabilities, plugins, server adapters, or frontends.
