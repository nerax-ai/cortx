---
date: 2026-05-18
topic: open-project-analysis
focus: Analyze project holistically, find optimization points across the entire codebase
---

# Ideation: Open Project Analysis — Optimization Points

## Codebase Context

**Project shape:** cortx is a TypeScript agent framework (~9K lines, Bun runtime) organized as a monorepo with 4 packages:
- `@cortx/sdk` (75 lines) — types, interfaces: Tool, ToolResult, CortxPlugin, AgentEvent (13 variants), ErrorCode, ToolContext, SkillInfo
- `@cortx/core` (~800 lines) — agent loop (`loop.ts` ~260 lines), Cortx class, CortxSession, AgentLoopController, skill discovery/parse/render/plugin system
- `@cortx/code` (~400 lines) — 7 file tools (bash, edit, find, grep, ls, read, write) with `createAllTools()`, `createCodingTools()`, `createReadOnlyTools()` factory functions
- `@cortx/tui` (~1500 lines) — Ink v7 + React 19 TUI with TuiStore (selector-based reactive state), TuiRegistry (plugin/command routing), command palette, session persistence (auto-save to JSON), markdown rendering, event-to-region routing pipeline, virtual scroll viewport

**Architecture:** Async generator `agentLoop()` yields `AgentEvent` variants. Plugin system with 7 hook points: `messages.transform`, `system.transform`, `tool.execute.before`, `tool.execute.after`, `error.recover`, `context.overflow`, `event`. Skills are markdown files with YAML frontmatter, discovered by walking from CWD to home directory. Tool results are truncated at 10KB with head/tail strategy. Error classification via `classifyError()` maps HTTP status codes to `ErrorCode` variants.

**Notable patterns:** Provider-agnostic via `@synax-ai/core`, `@synax-ai/sdk` abstractions. Plugin registry via `@nerax-ai/plugin` singleton. Storage via `@nerax-ai/storage`. Logger via `@nerax-ai/logger`. TUI uses `useSyncExternalStore` for store subscriptions.

**Past learnings:** Two prior ideation sessions (2026-04-18) covered agent core loop enhancements (7 ideas) and TUI refactoring (7 ideas). Five implementation plans exist (001–005) covering agent loop, TUI refactor, TUI review fixes, skill system, and fullscreen TUI with Ink v7.

**Obvious pain points:**
- Zero onboarding documentation (no README.md)
- `askUser` callback is a stub returning 'yes'
- `bun test` returns empty output
- Skills re-discovered (filesystem walk CWD→home) on every `run()` call
- Session state only saved on `done`/`error` — crashes lose work
- No CLI flags or env var configuration
- Tool input schemas exist but are never validated
- Sub-agent tool hardcoded in Cortx constructor

**Likely leverage points:**
- The AsyncGenerator architecture is already headless-capable — no TUI required
- The event stream (13 types) is a complete audit log — replay/debug is natural
- The skill system (45+ skills) has rich metadata potential beyond name/description
- The plugin system's hooks are well-placed for cross-cutting concerns

---

## Ranked Ideas

### 1. Project README & Onboarding Documentation
**Description:** Create a comprehensive README.md at the project root covering: what cortx is and why it exists, architecture overview (4 packages with dependency graph), quick start guide (install, configure, first conversation), how to write a plugin, how to write a skill, configuration reference (`cortx.json` schema), development setup (build, test, lint), and contributing guidelines. The project currently has zero onboarding documentation — no README, no getting-started guide, no architecture overview.
**Rationale:** This is the single highest-leverage investment. Every future user and contributor hits this wall first. The codebase is well-structured (~9K lines, clean package separation) but completely opaque to newcomers. Even the existing skill files and ideation docs assume deep knowledge that no document explains.
**Downsides:** Documentation maintenance burden — can become stale as code changes.
**Confidence:** 98%
**Complexity:** Low
**Status:** Unexplored

### 2. Tool Input Schema Validation Pipeline
**Description:** Use the existing `inputSchema` (JSON Schema) on every Tool definition to validate inputs before execution. Add validation as a built-in step in the tool execution path (either as a core loop feature or a default `tool.execute.before` plugin). When the LLM sends malformed JSON or missing required fields, return a structured validation error message back to the model instead of crashing or producing confusing downstream errors. The fix site is `loop.ts` around line where `JSON.parse(tc.input)` happens — currently parsed input passes to `tool.execute()` unvalidated.
**Rationale:** Every tool already declares `inputSchema` but nothing validates against it. `loop.ts` does `const parsed = typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input` and passes the result directly to `tool.execute()`. Missing required fields produce cryptic errors deep in tool implementations (e.g., bash tool checks `if (!command)` and returns a generic error). A ~50-line addition prevents an entire class of bugs and gives the LLM clear feedback to self-correct.
**Downsides:** Must choose a lightweight JSON Schema validator (dependency). Validation error messages must be helpful (show expected vs actual), not just "validation failed."
**Confidence:** 95%
**Complexity:** Low
**Status:** Unexplored

### 3. Headless/SDK Mode Entry Point
**Description:** Create a `@cortx/core`-based programmatic entry point that doesn't require the TUI. Expose clear `Cortx` class usage patterns: create agent, register tools, run with event consumption. Provide a `cortx --headless` CLI flag or a `createHeadlessAgent()` factory function. Document the SDK usage pattern with examples for common integrations (API server, bot, testing harness).
**Rationale:** The architecture is already headless-capable — `agentLoop()` is a pure async generator with no TUI dependency, `Cortx` has `runSimple()` returning a string, and events are fully typed. But the only entry point is `cli.tsx` which renders an Ink TUI. Anyone wanting to use cortx programmatically (API server, Slack bot, CI integration, testing) has no documented path. A headless entry unlocks all programmatic use cases without any architectural changes.
**Downsides:** Needs API stability guarantees once exposed publicly. Must decide on the public surface (which types, which classes, which events).
**Confidence:** 90%
**Complexity:** Low-Medium
**Status:** Unexplored

### 4. Crash-Resilient Session Persistence
**Description:** Save session state incrementally — after each `turn_end` event, not just on `done`/`error`. The save point is natural: the messages array is consistent and tool results are complete. On startup, detect sessions that ended without a `done` event (crashed/incomplete) and offer recovery. Mark session files with status (`active`, `completed`, `crashed`) for easy detection.
**Rationale:** Currently `autoSaveHandler` in `app.tsx` (line ~95) only triggers on `event.type === 'done' || event.type === 'error'`. If the process crashes mid-turn (OOM, unhandled exception, SIGKILL, accidental terminal close), the entire conversation is lost. Users report this as the most frustrating failure mode. The `turn_end` event is already emitted by the core loop and contains `iteration` and `toolCallCount` — the save point already exists.
**Downsides:** More filesystem writes (once per turn instead of once per session). Must handle incomplete/corrupted session files gracefully on recovery.
**Confidence:** 92%
**Complexity:** Low
**Status:** Unexplored

### 5. Cached Skill Discovery with Invalidation
**Description:** Cache the result of `discoverSkills()` (the Map of skills by name) and only re-discover when the filesystem changes. Use a simple mtime check on `.cortx/skills/` directories or `fs.watch`. The cache key is the CWD + config skill paths. Invalidate when any SKILL.md file changes or a new skill directory appears.
**Rationale:** `discoverSkills()` in `discover.ts` walks from CWD to home directory (`walkCwdToHome()`), reads every `SKILL.md` file, parses YAML frontmatter via `parseSkillFile()`, and builds a skill Map — on every single `Cortx.run()` call (see `agent.ts` line ~34: `const skills = await discoverSkills(cwd, this.config)`). With 45+ skills across multiple directories (project `.cortx/skills/` + home `~/.cortx/skills/`), this is potentially hundreds of filesystem operations per conversation turn. The result is deterministic unless skills are added/removed, which is rare.
**Downsides:** Cache invalidation edge cases (new skills not appearing immediately). Must handle CWD changes correctly. Adds state management complexity to `Cortx` class.
**Confidence:** 88%
**Complexity:** Low
**Status:** Unexplored

### 6. Session Replay & Event Debug Inspector
**Description:** Record the full AgentEvent stream to a structured log file alongside the existing session JSON. Build a `cortx replay <session-id>` CLI command that replays events chronologically with timing information. Add a `--debug` flag that enables verbose diagnostic events (tool execution timing, token counts per turn, retry attempts). The event stream is already captured by `CortxSession.subscribe()` and routed through `processEvent()`.
**Rationale:** When something goes wrong in an agent session (wrong tool call, hallucinated command, infinite loop, context overflow), there is currently no way to inspect what happened post-hoc. The event stream is already rich (13 types covering the full lifecycle), the session persistence infrastructure exists, and `processEvent()` already routes events. A replay tool compounds testing (replay failing sessions), debugging (inspect tool call sequences), user support (share session replay instead of screenshots), and skill development (see exactly how the model interprets skill instructions).
**Downsides:** Event logs can be large for long sessions. Needs a compact serialization format. Replay command requires TUI or text rendering.
**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

### 7. CLI Flags & Environment Variable Configuration
**Description:** Support `cortx --model gpt-4 --system "custom prompt" --max-iterations 50` and `CORTX_MODEL=gpt-4 cortx` as configuration sources. Merge precedence: CLI flags > environment variables > config file > defaults. Use the existing `CortxConfig` type as the schema. Parse flags in `cli.tsx` before creating the agent, merge with `loadConfig()` result.
**Rationale:** The only way to configure cortx currently is editing `~/.config/cortx/cortx.json` (via `@nerax-ai/storage`'s `config.writeJSON`). No CLI flags, no env vars. This is the most basic DX expectation for any CLI tool. Users switching models, adjusting iteration limits, or setting working directories must find and edit a JSON file. Every comparable tool (claude-code, opencode, aider) supports both CLI flags and env vars.
**Downsides:** Must handle type coercion for env vars (strings → numbers/booleans). Flag parsing adds a dependency or manual parsing logic.
**Confidence:** 92%
**Complexity:** Low
**Status:** Unexplored

---

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Configurable Tool Result Budgets (per-tool) | Subsumed by broader tool configuration; minor improvement over global budget |
| 2 | Real Permission/Confirmation System | Already covered by planned middleware pipeline (agent-core-loop ideation #1) |
| 3 | User-Facing Diagnostics & Debug Mode | Too vague — "diagnostics" needs brainstorm to define scope; partially overlaps with Session Replay (#6) |
| 4 | Pipe-from-Stdin / Batch Input Mode | Niche use case for v0.x; no evidence of demand |
| 5 | Bash Tool Refactor (split platform complexity) | Internal cleanliness only; bash tool works correctly across platforms; low user-visible impact |
| 6 | Tool Registration Registry (decentralize) | Subsumed by planned middleware pipeline — tools become self-describing |
| 7 | Testable Plugin System (remove singleton) | Premature — singleton pattern works at current scale; refactor when needed |
| 8 | Semantic Tool Result Truncation | Nice-to-have but not grounded in user pain — head/tail truncation is adequate |
| 9 | Session File Pruning & Indexing | Premature — sessions are small JSON files, no performance problem observed |
| 10 | Lazy Tool Initialization | Bash tool init is fast (no network calls); no observed perf issue from eager init |
| 11 | Incremental Context Windowing | Subsumed by planned context management plugin (agent-core-loop ideation #2) |
| 12 | Forked Conversations / Turn-Level Branching | Ambitious but premature — no evidence users need branching; speculative |
| 13 | Multi-Source Skills (git repos, URLs, npm) | Interesting but speculative — local markdown skills work well for current use |
| 14 | Structured Tool Output Protocol | Over-engineering at 7-tool scale; tools return strings which is sufficient |
| 15 | Dynamic System Prompt Assembly from Tool Context | `system.transform` plugin hook already handles this; not enough delta |
| 16 | Skill Telemetry & Usage Analytics | Privacy concerns; premature for v0.x; no evidence of demand |
| 17 | Plugin Ecosystem Foundation (template, docs, discovery) | Premature — 0 external plugins exist; build when demand appears |
| 18 | Command Palette Expansion | Trivial to add commands incrementally; not a project-level gap |
| 19 | Performance Benchmarking Infrastructure | Internal tooling concern, not a product improvement |
| 20 | Tool Progress Reporting for All Tools | Low impact — most tools (read, write, edit) are fast; only agent tool benefits |
| 21 | Skill Argument Validation & Autocomplete | Subsumed by Tool Input Schema Validation (#2) which covers the broader case |

## Compounding Dependency Map

```
README & Onboarding (#1)
  ├── enables all future contributors to understand the project
  └── makes Headless/SDK Mode (#3) discoverable

Tool Input Validation (#2)
  ├── prevents bug class that blocks Headless SDK adoption (#3)
  └── provides structure for future tool ecosystem

Headless/SDK Mode (#3)
  ├── enables Session Replay (#6) as a programmatic tool
  ├── enables CI/testing integrations
  └── compounds with Crash-Resilient Sessions (#4) for API users

Crash-Resilient Sessions (#4)
  ├── enables Session Replay (#6) with complete data
  └── builds trust for production use

Cached Skill Discovery (#5)
  └── performance foundation — every run() benefits

Session Replay (#6)
  ├── enables debugging of all other features
  └── compounds with Headless Mode (#3) for test harnesses

CLI Flags & Env Vars (#7)
  ├── makes Headless Mode (#3) configurable at runtime
  └── enables CI/CD configuration without file editing
```

## Session Log
- 2026-05-18: Initial ideation — 28 raw candidates generated across 4 frames (pain/friction, inversion/removal, assumption-breaking, leverage/compounding), 21 rejected, 7 survived adversarial filtering
