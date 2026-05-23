---
date: 2026-05-12
topic: web-frontend
origin: docs/ideation/2026-05-12-web-frontend-ideation.md
---

# Web Frontend for Cortx

## Problem Frame

Cortx is terminal-only today. The agent loop (`AsyncGenerator<AgentEvent>`) is UI-agnostic and the state store (`TuiStore`) is framework-agnostic, but only the Ink-based TUI consumes them. Adding a web frontend unlocks browser-based access, multi-agent monitoring, and session replay — but requires server infrastructure, state serialization, protocol completion (askUser), and a React-DOM rendering layer.

This feature builds all 7 layers together: shared store, serialization, headless server, askUser event, web frontend, multi-agent dashboard, and event tape.

## Architecture Overview

```
┌─────────────┐     SSE/HTTP      ┌─────────────────┐
│  @cortx/web │ ◄───────────────► │  @cortx/server  │
│  (Vite+DOM) │   API Key auth    │  (Hono+Bun)     │
│  UnoCSS     │                   │                  │
│  Base UI    │                   │  ┌────────────┐  │
│             │                   │  │  Cortx      │  │
│  ┌───────┐  │                   │  │  instances  │  │
│  │ Store │  │  events via SSE   │  └────────────┘  │
│  │ (local│◄─┼───────────────────┤                  │
│  │ copy) │  │  prompt/ctrl HTTP │  Event Tape      │
│  └───────┘  │──────────────────►│  (persistent)    │
└─────────────┘                   └────────┬─────────┘
                                           │ uses
                                  ┌────────▼─────────┐
                                  │  @cortx/store     │
                                  │  (shared, from    │
                                  │   TuiStore)       │
                                  └──────────────────┘
```

Three new packages (`@cortx/store`, `@cortx/server`, `@cortx/web`) plus core SDK changes (askUser event variant).

## Requirements

**Shared State Foundation**

- R1. Elevate `TuiStore` to `@cortx/store` — move the framework-agnostic event reducer and selector subscription system to a shared package. The TUI imports from this package instead of its own copy. The server and web client use the same state contract.
- R2. Map serialization layer — provide bidirectional converters between `Map<string, ToolCallEntry>` / `Map<string, AgentSessionSummary>` and `Record<string, ...>`. Every external consumer (API responses, SSE snapshots, WebSocket pushes) uses the serializable form. Internal store continues using Maps for performance.

**Headless Server**

- R3. HTTP server exposing `CortxSession` as REST + SSE endpoints: `POST /sessions` (create), `POST /sessions/:id/prompt` (send user message), `GET /sessions/:id/events` (SSE stream), `DELETE /sessions/:id`, `GET /sessions` (list active). SSE connections receive all prior events for the session before streaming new ones, enabling late-joiners and reconnections to reconstruct full state. Error responses: 400 for invalid input, 401 for auth failure, 404 for unknown session, 500 for LLM/config errors.
- R4. API key authentication — single key passed via `Authorization: Bearer <key>` header or `?key=` query parameter. All endpoints require valid key. Invalid key returns 401.
- R5. Session lifecycle — each session is a `Cortx` instance with its own `AgentLoopController`. Sessions are held in memory. Server cleans up idle sessions after configurable timeout.
- R6. CORS headers configured for web client origin. Configurable via environment variable or server options.

**Protocol Completion (askUser)**

- R7. Promote `askUser` from a stub callback (`ToolContext.askUser` returning `'yes'`) to a proper `AgentEvent` variant: `{ type: 'user_question'; question: string; toolCallId: string }`. The agent loop yields this event, suspends tool execution, and waits for a response.
- R8. Response mechanism on `AgentLoopController` — `controller.answerUser(toolCallId, response: string)` resumes the suspended tool execution. Timeout after configurable duration (default 120s) with auto-reject.

**Web Frontend**

- R9. React-DOM application built with Vite. Connects to headless server via SSE for event streaming and HTTP POST for prompts and control actions. Maintains a local `@cortx/store` instance fed by incoming events.
- R10. Chat interface — prompt input with multiline support, streaming text display, thinking/reasoning panel (collapsible), and tool call status indicators. Auto-scroll with manual scroll-up support.
- R11. Tool call region — shows pending, in-progress, and completed tool calls with status icons, summaries, and expandable results. Mirrors the TUI tool region behavior using DOM components.

**Multi-Agent Dashboard**

- R12. Tiled view showing all concurrent agent sessions (foreground, background, sub-agents) as live cards. Each card streams its own events and shows real-time status.
- R13. Per-card detail expansion — clicking a card opens a full event stream view for that agent, showing text output, tool calls, and progress. Escape or back button returns to tiled view.

**Event Tape**

- R14. Persistent append-only event log — each session's `AgentEvent[]` stream is stored as a log file. Events are appended as they are produced. Loading a session means iterating stored events. Maximum event size configurable (default 256KB), total storage capped at configurable limit (default 1GB), sessions older than configurable retention period auto-deleted (default 30 days).
- R15. Session replay — feed persisted events into a fresh store instance to reconstruct full state. Enables time-travel debugging and "watch this session" sharing.
- R16. Timeline navigation — scrub bar or event list showing session history. Jump to any point in the event stream and see reconstructed state at that point.

## Success Criteria

- User can interact with a cortx agent through a web browser at a network-accessible URL
- Multiple concurrent agent sessions are visible simultaneously in a tiled dashboard
- Sessions can be replayed from persisted event logs with timeline navigation
- `askUser` prompts appear in the web UI and responses flow back to the agent
- API key authentication protects all server endpoints
- Same `@cortx/store` logic powers both TUI and web without duplication
- All `Map` fields survive JSON serialization round-trips without data loss

## Scope Boundaries

- No multi-user authentication — single API key for v1
- No real-time collaboration or shared cursors
- No mobile-specific UI optimization (responsive but not designed for mobile)
- No server-side rendering — client-side React only
- No file upload/download through web UI (tools still operate on server filesystem)
- No skill marketplace or plugin management UI
- No WebSocket transport (SSE + HTTP only for v1)
- Event tape storage is file-based (no database)

## Key Decisions

- **Hono for HTTP server**: Bun-native, lightweight, ~200 lines for the core server. Avoids Express overhead.
- **SSE + HTTP for transport**: SSE for server→client streaming (auto-reconnect, proxy-friendly, simple). HTTP POST for client→server (prompt, abort, answer user). WebSocket avoided for simplicity.
- **API key auth (not localhost-only)**: Server binds to `0.0.0.0` with configurable port. Single API key set via environment variable. Enables remote access from day one.
- **UnoCSS + Base UI**: UnoCSS for utility styling, Base UI for accessible headless primitives (Dialog, Tabs, etc.). No heavy component library.
- **Vite + React-DOM**: Fast HMR, simple config, no framework opinions. React-DOM shares patterns with existing Ink/React TUI.
- **Event-sourcing pattern for web client**: Web client receives events via SSE and dispatches them through a local `@cortx/store` instance. Server is stateful authority; web client reconstructs state from events.
- **Package structure**: Three new packages (`@cortx/store`, `@cortx/server`, `@cortx/web`) plus core SDK changes. Each can be used independently — store without server, server without web, web with a different server.

## Dependencies / Assumptions

- `@cortx/store` must be ready before `@cortx/server` and `@cortx/web` can build against it
- Serialization layer (R2) must be ready before server API responses are correct
- `askUser` event variant (R7-R8) must land in `@cortx/sdk` types before server/web can handle it
- Headless server must be running before web frontend can connect during development
- `Cortx` class from `@cortx/core` already exposes `run()`, `controller`, and event subscriptions — server wraps these, doesn't replace them
- `TuiStore.dispatch()` is already the event reducer — the web client reuses this exact logic
- External dependencies (`@synax-ai/core`, `@synax-ai/sdk`, `@nerax-ai/*`) remain unchanged

## Outstanding Questions

### Deferred to Planning

- [Affects R3][Technical] What is the exact SSE event format — newline-delimited JSON, or `event:` + `data:` fields? Planning should decide based on Hono's SSE helpers and client-side EventSource API.
- [Affects R7-R8][Technical] How does the agent loop suspend and resume for askUser? `AsyncGenerator` yield works, but the resume mechanism (controller method vs callback vs Promise) needs design.
- [Affects R14][Technical] What storage format for event tape — JSONL (one event per line), or structured JSON with metadata header? JSONL is simpler for append, structured JSON enables indexing.
- [Affects R12][Needs research] How does the web client subscribe to multiple agent sessions simultaneously — one SSE connection per session, or a multiplexed single connection with event filtering?
- [Affects R5][Technical] What idle session timeout value, and should sessions be persisted to disk before cleanup or just discarded?

## Next Steps

-> `/ce:plan` for structured implementation planning across all 7 areas
