---
date: 2026-05-12
topic: web-frontend
focus: What work is needed to add a web frontend to cortx
---

# Ideation: Web Frontend for Cortx

## Codebase Context

Cortx is a TypeScript monorepo (Bun workspaces) building an AI agent framework with CLI/TUI interface. Architecture: `core` (agent loop, skills) + `sdk` (types, tool format) + `code` (bash/grep/edit tools) + `tui` (Ink-based React terminal UI).

Key architectural facts for web feasibility:
- **Agent loop is UI-agnostic**: `AsyncGenerator<AgentEvent>` with 18 typed event variants is the core protocol. The TUI is just one consumer.
- **TuiStore is framework-agnostic**: Plain TypeScript class with no React dependency. Uses `useSyncExternalStore` pattern. All selectors and state management are portable.
- **CortxSession exposes remote-control API**: `subscribe()`, `prompt()`, `controller.abort/steer/followUp()` — complete interactive surface, but only callable in-process today.
- **Plugin system accepts arbitrary extension types**: `@nerax-ai/plugin` registry works with any type string.
- **Session persistence exists**: File-based via `@nerax-ai/storage`, auto-save on events.

Blockers for web:
- No HTTP server, auth, or WebSocket layer
- `TuiState` uses `Map` fields that don't serialize to JSON
- `askUser` is a stub returning `'yes'` — no real human-in-the-loop
- Renderer flushes turns to `console.log` (terminal-specific)
- Ink components (`<Box>`, `<Text>`) don't map to DOM React
- Streaming deltas not persisted — late-joiners see only final state

## Ranked Ideas

### 1. Headless Server: `@cortx/server` with Agent-as-API
**Description:** Create a minimal HTTP server package that exposes `CortxSession` as REST + SSE endpoints: `POST /sessions`, `POST /sessions/:id/prompt`, `GET /sessions/:id/events` (SSE stream), `DELETE /sessions/:id`. Each session is a `Cortx` instance with its own `AgentLoopController`. No auth for v1 — single-user localhost.
**Rationale:** The architecture is already ready for this. `CortxSession` has `subscribe()`, `prompt()`, `controller` — a complete remote-control API that's process-local today. This is the lowest-common-denominator bridge between core and any consumer (web, VS Code, mobile, CI). ~200 lines of Hono/Bun HTTP.
**Downsides:** Changes deployment model (daemon vs CLI). Introduces process lifecycle management. Doesn't solve multi-user/auth.
**Confidence:** 95%
**Complexity:** Medium
**Status:** Unexplored

### 2. Elevate TuiStore to `@cortx/store`
**Description:** `TuiStore` is already framework-agnostic (zero Ink deps, zero React deps). It's a pure event reducer with selector-based subscriptions, `useSyncExternalStore` compatible. Move it to a shared `@cortx/store` package so terminal, web, VS Code, and any future consumer share the same state contract.
**Rationale:** It's a rename, not a refactor. The store is already "a plain TypeScript class with no React dependency." Moving it upstream creates a clean dependency for any UI and enforces that state shape is UI-agnostic by architecture, not convention.
**Downsides:** Breaks all tui component imports from `@cortx/tui`. Map fields still need serialization helpers.
**Confidence:** 90%
**Complexity:** Low
**Status:** Unexplored

### 3. askUser as First-Class Event Variant
**Description:** Promote `askUser` from a stub callback to a proper `AgentEvent` variant: `{ type: 'user_question'; question: string; toolCallId: string }` with a paired response mechanism on the controller. The loop yields the event, suspends, waits for response. TUI renders inline prompt, web renders modal, API returns it as a follow-up-required response, tests mock it deterministically.
**Rationale:** The current stub is a safety gap — every tool executes without confirmation. The architecture has the plumbing (`askUser` in `ToolContext`, `tool.execute.before` hook) but no UI surface to receive the question. Making it an event completes the protocol and makes it transportable.
**Downsides:** Tool execution blocks while waiting for response. Needs timeout handling. Requires all consumers to implement response UI.
**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

### 4. Map Serialization Layer
**Description:** Introduce `SerializableState` type where `Map<string, ToolCallEntry>` and `Map<string, AgentSessionSummary>` become `Record<string, ...>`. Create bidirectional converters. Every external consumer uses the serializable form.
**Rationale:** `TuiState.toolCalls` and `agentSessions` use Maps that silently vanish to `{}` on `JSON.stringify`. This breaks every web transport, API response, and WebSocket push. Fixing once unblocks: session persistence, SSE state snapshots, server-side rendering, and test fixtures.
**Downsides:** Redundant — internal Map shape and serialized Record shape must stay in sync. Migration needed for all Map consumers.
**Confidence:** 90%
**Complexity:** Low
**Status:** Unexplored

### 5. `@cortx/web` Package: React-DOM + SSE/WebSocket EventBridge
**Description:** Create `@cortx/web` structurally parallel to `@cortx/tui` but rendering to DOM. Connects to headless server via SSE/WebSocket, uses the same store class, event types, and selector pattern. Differences: React-DOM instead of Ink, CSS instead of terminal styling, EventBridge transport instead of direct function call.
**Rationale:** Store and selectors are already web-compatible. Plugin types use generic `ReactNode`. Investment: one EventBridge transport (~100 lines) + React-DOM components paralleling the Ink ones. Any future UI surface is just new components sharing the same store logic.
**Downsides:** Components aren't free — Ink's `<Box>`/`<Text>` layout model doesn't 1:1 map to CSS. TUI assumes fixed-width rendering, no scrollable containers, single-line focus. Web components need rethinking of layout decisions.
**Confidence:** 80%
**Complexity:** High
**Status:** Unexplored

### 6. Multi-Agent Tiled Dashboard
**Description:** Render the web UI as a spatial dashboard showing all concurrent agent sessions (foreground, background, sub-agents) as live tiled cards. Each card has its own event stream and store. Launch and monitor a fleet of agents simultaneously.
**Rationale:** The TUI is fundamentally single-focus — `activeAgentView` is a single `string | null`. The terminal cannot show 5 running agents without visual chaos. A browser's 2D layout with independent streaming panels unlocks a genuinely new usage pattern. `SubAgentSessionStore` already tracks multiple sessions with `getAll()`.
**Downsides:** Requires multiple store instances. Event filtering per panel adds complexity. Depends on headless server being built first.
**Confidence:** 75%
**Complexity:** High
**Status:** Unexplored

### 7. Event Tape: Replayable Session Timeline
**Description:** Persist raw `AgentEvent[]` stream as an append-only log. Replay is feeding events into a fresh store. Unlocks: time-travel debugging, video-like session playback, "watch this session" sharing, and training data generation. Loading a session = iterating stored events.
**Rationale:** `SubAgentSession.events: AgentEvent[]` already accumulates the full stream for sub-agents. `processEvents()` is already the replay function. Current session persistence (`TurnEntry[]`) is lossy — it drops thinking deltas, tool progress, token counts, streaming state. The event tape is the canonical truth.
**Downsides:** Storage size — a 20-iteration session may produce thousands of events. Needs indexing or summaries for fast loading. `tool_result` payloads can be large.
**Confidence:** 80%
**Complexity:** Medium
**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Browser-as-runtime (WASM/in-browser agent loop) | High-forward-looking but needs WASM build, replaces all Node tools with browser APIs, and requires CORS bypass. Value-to-work ratio unfavorable for first web frontend |
| 2 | Inject flush strategy into renderer | Real pain point but it's a subproblem of #1 (headless server) and #5 (web package). Disappears when you have a web store |
| 3 | Browser-native tool suite for web | Interesting but a separate product direction from "how to add a web frontend." Belongs in a future brainstorm |
| 4 | Session-as-URL for session picker | Good consequence of #1 (headless server) but not an idea on its own. Comes naturally once you have an API |
| 5 | Ambient desktop widget | Novel but needs Service Workers, browser extension APIs, notification infrastructure. Over-engineered for v1 |
| 6 | Skill marketplace/registry | Right direction for ecosystem but orthogonal to "add a web frontend." Filesystem skill discovery already works with headless server |
| 7 | Telemetry layer for session analytics | Valuable but icing-on-cake for web v1. `done` events already carry token usage |
| 8 | Agent-as-API endpoint builder (freeze sessions) | Compelling but highly speculative. Needs message templating, deterministic tool replay, deployment infrastructure |
| 9 | Collaborative sessions with shared cursors | Needs auth, conflict resolution, operational transforms. 3x+ complexity over single-user web |
| 10 | Unified EventBridge interface | Over-designed. The existing `CortxSession.subscribe()` + WebSocket `send` is already the bridge pattern |
| 11 | Remove message-io.ts in favor of event tape | Subset of idea #7 (event tape). Once you persist events, the lossy adapters become unnecessary |
| 12 | Web-first component shell (invert TUI/web priority) | A bias/philosophy, not a concrete idea. Architecture supports either approach regardless |
| 13 | Unified plugin system with web.* extensions | Premature design. Plugin registry already accepts arbitrary strings. Just define web types when you need them |
| 14 | Observability heatmap / token analytics | A dashboard feature, not a foundation for web frontend. Build on existing `done` usage data |

## Session Log
- 2026-05-12: Initial ideation — 40 candidates generated across 4 frames, 7 survived filtering
