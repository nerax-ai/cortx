---
title: "feat: Web Frontend for Cortx"
type: feat
status: active
date: 2026-04-26
origin: docs/brainstorms/2026-05-12-web-frontend-requirements.md
---

# feat: Web Frontend for Cortx

## Overview

Add a web frontend to cortx via three new packages: `@cortx/store` (shared state), `@cortx/server` (headless HTTP/SSE server), and `@cortx/web` (React-DOM frontend). The agent loop's `AsyncGenerator<AgentEvent>` protocol is already UI-agnostic — this plan builds the server and web rendering layers to consume it. Delivered in 3 phases: foundation, server, web frontend. Advanced features (multi-agent dashboard, event tape replay) deferred to Phase 4.

## Problem Frame

Cortx is terminal-only. The agent loop and state store are UI-agnostic but only the Ink-based TUI consumes them. A web frontend unlocks browser-based access, remote usage, and multi-agent monitoring. The architecture is ready — the work is building the transport, state sharing, and rendering layers. (see origin: docs/brainstorms/2026-05-12-web-frontend-requirements.md)

## Requirements Trace

- R1. Shared store package extracted from TuiStore
- R2. Map serialization (Map ↔ Record converters)
- R3. HTTP server with REST + SSE endpoints, late-joiner support
- R4. API key authentication (Authorization header)
- R5. Session lifecycle (create, prompt, list, delete)
- R6. CORS configuration
- R7. askUser as AgentEvent variant
- R8. askUser response mechanism on controller
- R9. React-DOM app connecting via SSE + HTTP
- R10. Chat interface (prompt, streaming, thinking, tool status)
- R11. Tool call region (pending/complete/failed cards)
- R12-R13. Multi-agent dashboard — deferred to Phase 4
- R14-R16. Event tape + replay + timeline — deferred to Phase 4

## Scope Boundaries

- No multi-user auth — single API key for v1
- No real-time collaboration or shared cursors
- No mobile-specific UI optimization
- No server-side rendering — client-side React only
- No file upload/download through web UI
- No WebSocket transport (SSE + HTTP only)
- Default localhost binding; remote access is opt-in
- Event tape storage is file-based (no database)
- Multi-agent dashboard and event tape replay deferred to Phase 4

### Deferred to Separate Tasks

- Multi-agent tiled dashboard (R12-R13): Phase 4 follow-up plan
- Event tape replay + timeline navigation (R14-R16): Phase 4 follow-up plan
- TLS termination: handled by reverse proxy (documented in deployment notes)

## Context & Research

### Relevant Code and Patterns

- `packages/tui/src/store.ts` — TuiStore event reducer and selector subscriptions. TUI-specific fields (scrollOffset, autoFollow, elapsedTimer, interrupting, clearFlushedTurns) must stay in TUI layer
- `packages/tui/src/types/tui-state.ts` — TuiState shape. Shared fields: sessionId, messages, iteration, toolCalls (Map), tokenUsage, elapsed, status, error, agentSessions (Map), activeAgentView
- `packages/core/src/agent.ts` — Cortx class with run(), controller, onAgentEvent callback. Sub-agent events use onAgentEvent side channel
- `packages/core/src/loop.ts` — agentLoop() AsyncGenerator, tool execution batching, askUser callback in ToolContext
- `packages/sdk/src/index.ts` — AgentEvent union type (18 variants), Tool interface, ToolContext with askUser callback
- `packages/tui/src/plugins/session-plugin.ts` — Session persistence pattern (JSON files in ~/.cortx/sessions/)
- `packages/tui/src/components/tool-region.tsx` — Tool call UI component pattern using useSyncExternalStore

### External References

- Hono SSE streaming: Hono provides `streamSSE()` helper for Bun
- EventSource API: browser-native SSE client, cannot set custom headers (requires auth workaround)
- Base UI: unstyled headless primitives (Dialog, Tabs, etc.) from MUI team
- UnoCSS: utility-first CSS engine with Vite plugin

## Key Technical Decisions

- **Store split**: `AgentStore` (shared base) contains dispatch(), select(), and core state (sessionId, messages, toolCalls, tokenUsage, iteration, status, error, agentSessions). `TuiStore` extends AgentStore and adds scrollOffset, autoFollow, elapsedTimer, setInterrupting, clearFlushedTurns
- **askUser mechanism**: Promise-based gate. ctx.askUser(question) creates a Promise, emits `user_question` via `onAgentEvent` side channel (same pattern as agent_started/completed), controller resolves via answerUser(). Tool blocks on Promise, agent loop unchanged
- **SSE event format**: Hono `streamSSE()` with named events (`event: text_delta`, `data: {...}`). Browser EventSource consumes directly
- **EventSource auth**: POST /auth/token exchanges API key for short-lived token (15min). Token used in SSE query param. Avoids leaking long-lived key in URLs
- **Multi-agent SSE**: One EventSource per session for v1. Dashboard opens N connections. Documented constraint for Phase 3
- **Event tape format**: JSONL (one JSON event per line). Header line with `{ "meta": { "sessionId": "...", "createdAt": "...", "version": 1 } }`. Append via fs.appendFile
- **Default binding**: localhost:3000. Remote access via CORTX_HOST=0.0.0.0 env var (opt-in with warning log)
- **Phased delivery**: Foundation → Server → Web. Each phase is independently testable and deliverable

## Open Questions

### Resolved During Planning

- **askUser suspension**: Promise-based gate with onAgentEvent emission. No AsyncGenerator restructuring needed
- **SSE format**: Hono streamSSE with named events
- **Event tape format**: JSONL
- **Multi-agent SSE**: One connection per session for v1
- **Default binding**: localhost-only, remote opt-in

### Deferred to Implementation

- **Exact Hono SSE helper API**: implementation agent should verify against Hono docs for Bun
- **UnoCSS preset selection**: defaults to UnoCSS preset-uno; implementation agent picks icon/typography presets
- **Base UI component selection**: Dialog for askUser, Tabs for chat/thinking split; implementation agent selects remaining primitives
- **Event tape file naming**: sessionId-based or date-prefixed; implementation agent decides

## Output Structure

```
packages/
  store/
    src/
      index.ts           # exports
      store.ts           # AgentStore class (base reducer)
      types.ts           # AgentState, AgentSelector, etc.
      serialization.ts   # Map <-> Record converters
    tests/
      store.test.ts
      serialization.test.ts
    package.json
    tsconfig.json
  server/
    src/
      index.ts           # exports + createServer factory
      server.ts          # Hono app, routes
      auth.ts            # API key middleware + token exchange
      sse.ts             # SSE streaming + late-joiner replay
      session-manager.ts # session lifecycle + event tape append
      types.ts           # server-specific types
    tests/
      server.test.ts
      auth.test.ts
      session-manager.test.ts
    package.json
    tsconfig.json
  web/
    src/
      main.tsx           # React entry
      App.tsx            # Root component + routing
      bridge/
        event-bridge.ts  # SSE client + store dispatcher
        auth.ts          # token exchange + API client
      components/
        ChatView.tsx     # Chat interface layout
        PromptInput.tsx  # Multiline prompt input
        StreamingText.tsx # Streaming text with markdown
        ThinkingPanel.tsx # Collapsible thinking display
        ToolRegion.tsx   # Tool call list
        ToolCard.tsx     # Individual tool call card
        AskUserDialog.tsx # askUser modal
        StatusBar.tsx    # Connection + token usage
        ConnectionOverlay.tsx # Disconnected/reconnecting state
      hooks/
        use-store.ts     # useSyncExternalStore adapter
    index.html
    vite.config.ts
    uno.config.ts
    package.json
    tsconfig.json
```

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Event Flow

```
User Browser                    Server (Bun)                    Agent Loop
    |                               |                               |
    |-- POST /sessions ------------>|                               |
    |<-- { sessionId } -------------|                               |
    |                               |-- new Cortx(config) --------->|
    |                               |                               |
    |-- GET /sessions/:id/events -->|                               |
    |   (EventSource + token)       |-- replay prior events ------->|
    |<-- SSE: prior events ---------|                               |
    |                               |                               |
    |-- POST /sessions/:id/prompt ->|-- cortx.run(prompt) --------->|
    |                               |                               |
    |<-- SSE: text_delta -----------|<-- yield text_delta ----------|
    |<-- SSE: tool_use -------------|<-- yield tool_use ------------|
    |<-- SSE: tool_result ----------|<-- yield tool_result ---------|
    |                               |                               |
    |  (askUser triggered)          |                               |
    |<-- SSE: user_question --------|<-- onAgentEvent --------------|
    |                               |   (tool awaiting Promise)     |
    |-- POST .../answer ------------>|                              |
    |                               |-- controller.answerUser() --->|
    |                               |   (Promise resolves)          |
    |<-- SSE: tool_result ----------|<-- yield tool_result ---------|
    |<-- SSE: done -----------------|<-- yield done ----------------|
```

### Store Split

```
AgentStore (@cortx/store)           TuiStore (@cortx/tui)
├── dispatch(event)                 ├── extends AgentStore
├── select(selector)                ├── scrollUp() / scrollDown()
├── getState()                      ├── setInterrupting()
├── reset()                         ├── clearFlushedTurns()
│                                   ├── startElapsedTimer()
AgentState:                         └── adds to TuiState:
├── sessionId                         scrollOffset, autoFollow
├── messages { turns, currentText }    elapsedTimer (setInterval)
├── iteration                         activeAgentView
├── toolCalls (Map)
├── tokenUsage
├── status ('idle'|'running'|'error')
├── error
├── agentSessions (Map)
└── elapsed
```

### askUser Promise Gate

```
ToolContext.askUser(question):
  1. Create { resolve, reject } Promise pair
  2. Store on controller._pendingQuestions[toolCallId] = { resolve, question }
  3. Emit onAgentEvent({ type: 'user_question', question, toolCallId })
  4. Return Promise (tool execution blocks)

AgentLoopController.answerUser(toolCallId, response):
  1. Lookup controller._pendingQuestions[toolCallId]
  2. Call resolve(response)
  3. Remove from pending

Timeout:
  - setTimeout on Promise creation (default 120s)
  - On timeout: reject with timeout error, remove from pending
```

## Implementation Units

### Phase 1: Foundation

- [ ] **Unit 1: Create @cortx/store package with base reducer and serialization**

**Goal:** Extract the framework-agnostic event reducer, selector subscription system, and Map serialization from TuiStore into a new shared package.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Create: `packages/store/package.json`, `packages/store/tsconfig.json`
- Create: `packages/store/src/types.ts` — AgentState type (core fields only, no scroll/autoFollow/elapsedTimer)
- Create: `packages/store/src/store.ts` — AgentStore class with dispatch() and select()
- Create: `packages/store/src/serialization.ts` — Map↔Record converters + AgentState JSON round-trip
- Create: `packages/store/src/index.ts`
- Create: `packages/store/tests/store.test.ts`
- Create: `packages/store/tests/serialization.test.ts`
- Modify: `package.json` — add @cortx/store to workspaces

**Approach:**
- Extract dispatch() logic from TuiStore, filtering out TUI-specific concerns (elapsedTimer, turn duration calculation with Date.now(), flush behavior)
- AgentState omits: scrollOffset, autoFollow, elapsedTimer, activeAgentView. These stay in TuiStore
- AgentState keeps: sessionId, messages (TurnEntry[]), iteration, toolCalls (Map), tokenUsage, elapsed (number), status ('idle'|'running'|'error'), error, agentSessions (Map)
- Selector subscription system copied as-is (it's already framework-agnostic)
- Serialization: `serializeAgentState(AgentState) → SerializedAgentState` where Maps become Records. `deserializeAgentState(SerializedAgentState) → AgentState` for reverse. Both handle ToolCallEntry.input/result as JSON-safe (stringify unknown values)
- Register as workspace package

**Execution note:** Start with serialization tests (simpler, no dependencies), then store dispatch tests, then wire up package.

**Patterns to follow:**
- `packages/tui/src/store.ts` — dispatch() event handling and selector pattern
- `packages/sdk/src/index.ts` — AgentEvent type union
- `packages/tui/src/types/tui-state.ts` — state shape

**Test scenarios:**
- Happy path: dispatch each AgentEvent type produces correct AgentState transitions
- Happy path: select() returns correct slice and only notifies on changes
- Happy path: serialize → deserialize round-trip preserves all data (Map entries, messages, token counts)
- Edge case: serialize empty store state (no tool calls, no sessions, no messages)
- Edge case: ToolCallEntry with non-JSON-serializable input (function, undefined) — should stringify or null
- Edge case: concurrent select() subscribers notified correctly
- Error path: dispatch unknown event type — no crash, state unchanged

**Verification:**
- `bun test packages/store/` passes
- `@cortx/store` imports successfully from dependent packages

---

- [ ] **Unit 2: Implement askUser Promise-based mechanism**

**Goal:** Add `user_question` and `user_answer` event types to the SDK, implement the Promise-based gate in core, and wire the response mechanism on the controller.

**Requirements:** R7, R8

**Dependencies:** Unit 1 (AgentStore must handle user_question dispatch)

**Files:**
- Modify: `packages/sdk/src/index.ts` — add `user_question` and `user_answer` to AgentEvent union
- Modify: `packages/core/src/types.ts` — add answerUser() to AgentController
- Modify: `packages/core/src/loop.ts` — replace askUser stub with Promise-gate implementation
- Create: `packages/core/src/ask-user.ts` — createAskUserCallback factory
- Create: `packages/core/tests/ask-user.test.ts`
- Modify: `packages/store/src/store.ts` — handle user_question in dispatch (set status to 'awaiting_user' or similar)
- Modify: `packages/store/src/types.ts` — add 'awaiting_user' to status union

**Approach:**
- Add `{ type: 'user_question'; question: string; toolCallId: string }` and `{ type: 'user_answer'; toolCallId: string; response: string }` to AgentEvent
- `createAskUserCallback(controller, toolCallId, onEvent)` returns a function that: (1) creates a Promise, (2) stores resolver on controller._pendingQuestions, (3) fires onEvent({ type: 'user_question', ... }), (4) starts timeout (120s default), (5) returns Promise
- `controller.answerUser(toolCallId, response)` resolves the stored Promise
- On timeout: reject with error, remove from pending, tool gets error result
- Wire the factory into loop.ts where ToolContext.askUser is currently set (replace the stub)
- TUI: TuiStore dispatches user_question → shows inline prompt → calls controller.answerUser()

**Execution note:** Test-first for the Promise gate mechanism — it's the highest-risk change in the plan.

**Patterns to follow:**
- `packages/core/src/agent.ts` lines 162-206 — agent_started/completed pattern via onAgentEvent
- `packages/core/src/loop.ts` line 42 — current askUser callback wiring

**Test scenarios:**
- Happy path: askUser(question) returns Promise, answerUser resolves it with response string
- Happy path: user_question event emitted before Promise resolves
- Happy path: tool execution continues after answerUser
- Edge case: multiple concurrent askUser calls from parallel tools — each resolved independently
- Error path: timeout fires after 120s — Promise rejects, tool gets error
- Error path: answerUser called with unknown toolCallId — no-op or warning
- Integration: agent loop with askUser pauses tool execution and resumes on answer

**Verification:**
- `bun test packages/core/tests/ask-user.test.ts` passes
- Existing agent loop tests still pass (no regression from askUser change)

---

- [ ] **Unit 3: Migrate TUI to use @cortx/store**

**Goal:** Make TuiStore extend AgentStore instead of containing its own dispatch logic. All TUI components continue working unchanged.

**Requirements:** R1

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `packages/tui/src/store.ts` — TuiStore extends AgentStore, adds TUI-specific methods
- Modify: `packages/tui/src/types/tui-state.ts` — TuiState extends AgentState with scroll/autoFollow/activeAgentView
- Modify: `packages/tui/package.json` — add @cortx/store dependency
- Modify: `packages/tui/src/components/tool-region.tsx` — update import path
- Modify: all TUI component files importing from store — update to use @cortx/store types where appropriate
- Update: `packages/tui/tests/store-agent-sessions.test.ts`, `packages/tui/tests/*.test.ts` — verify existing tests pass

**Approach:**
- TuiStore extends AgentStore, overrides dispatch() to add TUI-specific behavior (elapsed timer start/stop, turn duration calculation with Date.now())
- TuiState extends AgentState with scrollOffset, autoFollow, activeAgentView, elapsedTimer
- TUI-specific methods (scrollUp, scrollDown, scrollToBottom, setInterrupting, clearFlushedTurns, loadTurns) remain in TuiStore
- All TUI component imports remain from `../store.js` (TuiStore) — they don't need to know about AgentStore
- Remove duplicated dispatch logic from TuiStore — call super.dispatch() then add TUI behavior

**Patterns to follow:**
- `packages/tui/src/store.ts` — existing dispatch patterns, just moved to super class
- `packages/tui/src/components/tool-region.tsx` — useSyncExternalStore pattern (unchanged)

**Test scenarios:**
- Happy path: existing TUI store tests pass without modification
- Happy path: TuiStore.dispatch() correctly calls super.dispatch() then adds TUI-specific state
- Integration: TUI app renders correctly with @cortx/store as dependency
- Regression: scrollUp/scrollDown/clearFlushedTurns work as before
- Regression: session restore via loadTurns works as before

**Verification:**
- `bun test packages/tui/` passes (all existing tests)
- `bun run build` succeeds from repo root

### Phase 2: Headless Server

- [ ] **Unit 4: Create @cortx/server with Hono routes, auth, and error handling**

**Goal:** Create the headless HTTP server package with session CRUD endpoints, API key auth middleware, CORS, and error responses.

**Requirements:** R3 (routes), R4 (auth), R5 (session lifecycle), R6 (CORS)

**Dependencies:** Unit 1 (@cortx/store for state types and serialization), Unit 2 (askUser event type)

**Files:**
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`
- Create: `packages/server/src/types.ts` — ServerConfig, SessionInfo types
- Create: `packages/server/src/auth.ts` — apiKeyAuth middleware + POST /auth/token endpoint
- Create: `packages/server/src/server.ts` — Hono app with routes, CORS, error handling
- Create: `packages/server/src/index.ts` — createServer factory + start export
- Create: `packages/server/tests/auth.test.ts`
- Create: `packages/server/tests/server.test.ts`

**Approach:**
- `createServer(config)` returns a Hono app. Config: apiKey, port, host (default localhost), corsOrigin, language config for Cortx instances
- Routes: POST /sessions, GET /sessions, GET /sessions/:id, DELETE /sessions/:id, POST /sessions/:id/prompt, POST /sessions/:id/abort, POST /sessions/:id/answer, POST /auth/token
- Auth middleware: validate Authorization: Bearer header against config.apiKey. Return 401 on failure. Skip for health endpoint
- Token exchange: POST /auth/token with Authorization header → returns { token, expiresAt } (HMAC-signed or random, 15min TTL). Store in-memory map with expiry
- CORS: configurable origin from env, default same-host
- Error handling: 400 invalid JSON, 401 auth failure, 404 unknown session, 429 rate limit (max 10 sessions), 500 internal errors
- Default binding: localhost:3000. Log warning when CORTX_HOST=0.0.0.0
- Max concurrent sessions: configurable, default 10

**Patterns to follow:**
- Hono Bun quickstart pattern for server setup
- `packages/core/src/agent.ts` — Cortx class API (constructor, run, controller)

**Test scenarios:**
- Happy path: create session → prompt → receive response
- Happy path: list sessions returns active session IDs
- Happy path: delete session removes it
- Happy path: token exchange returns valid token for correct API key
- Error path: request without auth returns 401
- Error path: invalid API key returns 401
- Error path: prompt on non-existent session returns 404
- Error path: create session beyond limit returns 429
- Edge case: concurrent requests to same session handled correctly
- Integration: abort endpoint triggers controller.abort()

**Verification:**
- `bun test packages/server/` passes
- Server starts on localhost:3000 and responds to health check

---

- [ ] **Unit 5: SSE streaming, late-joiner replay, and event tape append**

**Goal:** Implement SSE event streaming from agent loop to web client, state replay for late-joining/reconnecting clients, and real-time event tape persistence.

**Requirements:** R3 (SSE streaming), R14 (event tape append — Phase 4 scope but append logic needed now for durability)

**Dependencies:** Unit 4 (server routes and auth)

**Files:**
- Create: `packages/server/src/sse.ts` — SSE streaming helper, event serialization
- Create: `packages/server/src/session-manager.ts` — session lifecycle, event buffering, tape append
- Create: `packages/server/src/tape.ts` — JSONL event tape writer
- Create: `packages/server/tests/sse.test.ts`
- Create: `packages/server/tests/session-manager.test.ts`
- Create: `packages/server/tests/tape.test.ts`

**Approach:**
- SessionManager creates Cortx instances, iterates their run() generators, buffers all yielded events, appends to event tape (JSONL)
- GET /sessions/:id/events: authenticate, replay buffered events (serialize each AgentEvent as SSE named event), then stream new events as they arrive
- Event tape: append-only JSONL file per session in `~/.cortx/tape/{sessionId}.jsonl`. First line is metadata header. Each subsequent line is a JSON-serialized AgentEvent. Append on every event (streaming durability)
- Session cleanup: on idle timeout (30min default) or DELETE, close session, flush tape, remove from memory
- Reconnection: EventSource supports Last-Event-ID header. Server tracks event sequence numbers and replays from last seen
- Tape size bounds: max 256KB per event (truncate tool_result payloads), max 1GB total, 30-day retention

**Execution note:** Test session manager with a mock Cortx instance that yields a known sequence of events.

**Patterns to follow:**
- `packages/tui/src/plugins/session-plugin.ts` — existing session persistence pattern
- Hono streamSSE() for Bun SSE streaming

**Test scenarios:**
- Happy path: agent events stream correctly as SSE named events
- Happy path: late-joining client receives all prior events then live stream
- Happy path: event tape file created and appended to on each event
- Happy path: reconnection after disconnect replays missed events via Last-Event-ID
- Edge case: tool_result with large payload (100KB+) — truncated in tape to 256KB
- Edge case: session with 1000+ events — replay completes within reasonable time
- Error path: tape write failure — session continues in memory, error logged
- Integration: full flow: create session → prompt → stream events → disconnect → reconnect → receive missed events

**Verification:**
- `bun test packages/server/` passes
- Tape file exists and is valid JSONL after session activity
- SSE stream works with curl or simple EventSource client

### Phase 3: Web Frontend

- [ ] **Unit 6: Create @cortx/web scaffolding with EventBridge**

**Goal:** Set up the Vite + React-DOM + UnoCSS + Base UI package and implement the SSE client that connects to the headless server and feeds events into a local AgentStore.

**Requirements:** R9

**Dependencies:** Unit 1 (@cortx/store), Unit 4 (server), Unit 5 (SSE streaming)

**Files:**
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/vite.config.ts`, `packages/web/uno.config.ts`
- Create: `packages/web/index.html`
- Create: `packages/web/src/main.tsx` — React entry
- Create: `packages/web/src/App.tsx` — Root component with connection config
- Create: `packages/web/src/bridge/auth.ts` — token exchange + API client (fetch wrapper)
- Create: `packages/web/src/bridge/event-bridge.ts` — SSE client + store dispatcher
- Create: `packages/web/src/hooks/use-store.ts` — useSyncExternalStore adapter for AgentStore
- Create: `packages/web/src/components/ConnectionOverlay.tsx` — connecting/connected/disconnected state
- Create: `packages/web/src/components/StatusBar.tsx` — connection status + token usage

**Approach:**
- Vite config: React plugin, UnoCSS plugin, dev server proxy to localhost:3000
- EventBridge: connects to /auth/token to get short-lived token, opens EventSource to /sessions/:id/events?token=..., dispatches each SSE event into a local AgentStore instance
- API client: wraps fetch with auth header, base URL config. Methods: createSession, listSessions, prompt, abort, answerUser
- ConnectionOverlay: shows connecting/reconnecting/disconnected state with retry countdown
- StatusBar: displays connection status, session ID, token usage, elapsed time using store selectors

**Patterns to follow:**
- `packages/tui/src/components/tool-region.tsx` — useSyncExternalStore with store.select() pattern
- Base UI component patterns for Dialog/Tabs

**Test scenarios:**
- Happy path: EventBridge connects, receives events, dispatches to store
- Happy path: store state updates correctly from SSE events
- Error path: connection failure shows reconnecting state
- Error path: token expiry triggers re-authentication
- Edge case: rapid event stream (100 events/sec) — store updates without lag

**Verification:**
- Vite dev server starts and renders App component
- EventBridge connects to running server and displays events

---

- [ ] **Unit 7: Chat interface with prompt, streaming, tool calls, and askUser**

**Goal:** Build the full chat UI — prompt input, streaming text display, thinking panel, tool call region, and askUser dialog.

**Requirements:** R10, R11, R7 (UI side)

**Dependencies:** Unit 6 (EventBridge + store)

**Files:**
- Create: `packages/web/src/components/ChatView.tsx` — chat layout (messages + input + tools)
- Create: `packages/web/src/components/PromptInput.tsx` — multiline input with submit
- Create: `packages/web/src/components/StreamingText.tsx` — streaming text with basic markdown
- Create: `packages/web/src/components/ThinkingPanel.tsx` — collapsible thinking/reasoning
- Create: `packages/web/src/components/ToolRegion.tsx` — tool call list
- Create: `packages/web/src/components/ToolCard.tsx` — individual tool call with status + expand
- Create: `packages/web/src/components/AskUserDialog.tsx` — modal for askUser questions
- Create: `packages/web/src/components/MessageBubble.tsx` — user/assistant message rendering

**Approach:**
- ChatView: main layout with message history area, tool region, and prompt input. Auto-scrolls on new content, stops on manual scroll-up
- PromptInput: textarea with Enter to submit (Shift+Enter for newline), disabled during 'running' status, shows abort button when running
- StreamingText: renders currentText from store with basic markdown (code blocks, bold, italic). Updates on every text_delta
- ThinkingPanel: collapsible section showing currentThinking. Base UI Collapsible or Disclosure
- ToolRegion: maps over toolCalls entries from store. Each ToolCard shows status icon, tool name, summary, expandable result
- AskUserDialog: Base UI Dialog triggered when status is 'awaiting_user'. Shows question text, text input, submit button. Calls API client answerUser()
- MessageBubble: renders TurnEntry items (user/assistant/tool turns) with timestamps and role indicators

**Execution note:** Build components in order: PromptInput → StreamingText → MessageBubble → ToolCard → ToolRegion → ThinkingPanel → AskUserDialog → ChatView (composes all).

**Patterns to follow:**
- `packages/tui/src/components/tool-region.tsx` — tool call display pattern (status icons, summaries)
- Base UI Dialog for AskUserDialog
- UnoCSS utility classes for layout (flex, grid, padding, etc.)

**Test scenarios:**
- Happy path: user types prompt, submits, sees streaming text appear
- Happy path: tool calls appear with pending → complete status transitions
- Happy path: askUser dialog appears, user responds, dialog closes, agent continues
- Edge case: long streaming text (>10K chars) renders without lag
- Edge case: many tool calls (>20) renders correctly with collapsed view
- Edge case: thinking panel toggle preserves scroll position
- Error path: tool error shows error icon and error message
- Integration: full conversation flow — prompt → streaming text → tool calls → askUser → response → done

**Verification:**
- Web app renders complete chat interface
- Full conversation works through browser against running server
- askUser modal appears and response flows back to agent

### Phase 4: Advanced Features (Deferred)

The following are planned features with known requirements. A separate plan will detail implementation.

- **Multi-agent tiled dashboard** (R12-R13): Grid layout showing concurrent agent sessions as live cards. One SSE connection per session. Click to expand into full event stream view. Escape to return to grid. Requires: CSS grid/flex layout, per-session EventBridge instances, card status indicators

- **Event tape replay + timeline** (R14-R16): Load JSONL tape into fresh AgentStore for replay. Timeline scrubber (range input over event count). Auto-play with configurable speed. Visual distinction between live and replay mode. Requires: tape reader, replay controller, timeline UI component

- **Session history browser**: List past sessions from tape directory. Browse, replay, and optionally share session URLs. Requires: tape directory listing API, session metadata index

## System-Wide Impact

- **Interaction graph:** TuiStore inheritance chain changes (extends AgentStore). All TUI components that import from store.ts are affected by the type changes. Session persistence plugin unaffected (uses TurnEntry, not AgentState directly)
- **Error propagation:** Server errors map to HTTP status codes. Agent loop errors (from done/error events) propagate through SSE as typed events. askUser timeout creates a new error path (tool receives rejection)
- **State lifecycle risks:** Event tape append on every event — ensure fs.appendFile errors don't crash the session. askUser timeout (120s) must clean up the Promise resolver to prevent memory leaks
- **API surface parity:** TUI gets askUser inline prompt (using existing input area). Web gets askUser dialog (Base UI Dialog). Both use same controller.answerUser() mechanism
- **Integration coverage:** Server must handle concurrent SSE connections for the same session (multiple browser tabs). Session cleanup must gracefully close all SSE connections
- **Unchanged invariants:** The agent loop's AsyncGenerator protocol is unchanged. Tools don't know about the server or web — they use ToolContext as before. Plugin system is unchanged. Existing TUI behavior is preserved (all tests pass)

## Risks & Dependencies

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| askUser Promise gate blocks parallel tools | Medium | Medium | Document limitation: askUser in one tool waits for response before sibling parallel tools complete. Destructive tools (typical askUser use) run serially anyway |
| Hono SSE API differs from assumed pattern | Low | Medium | Implementation agent verifies against Hono docs first. Fallback: use raw Response with streaming |
| Event tape I/O pressure from high-frequency events (text_delta) | Medium | Low | Batch writes (accumulate for 100ms, then append). Acceptable loss: at most 100ms of events on crash |
| Store split breaks TUI components during migration | Medium | High | Migrate incrementally: AgentStore first, then TuiStore extends it. Run all TUI tests after each step |
| UnoCSS + Vite config conflicts in monorepo | Low | Low | Vite config is scoped to @cortx/web package. No cross-package build dependency |
| Base UI component API changes (pre-release) | Low | Medium | Pin exact version. Review changelog before upgrade |

## Documentation / Operational Notes

- **Deployment:** Default `cortx serve` command starts the server (or `bun run packages/server/src/index.ts`). Set CORTX_API_KEY env var. Optionally set CORTX_PORT (default 3000) and CORTX_HOST (default localhost)
- **Security:** Default localhost-only is safe for development. For remote access: set CORTX_HOST=0.0.0.0, use a TLS-terminating reverse proxy (nginx/Caddy), rotate API key regularly
- **Monitoring:** Server logs session creation, prompt count, and errors. Health endpoint at GET /health returns uptime and active session count
- **Event tape storage:** `~/.cortx/tape/` directory. Auto-created on first write. Cleaned up by retention policy (30-day default)

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-12-web-frontend-requirements.md](docs/brainstorms/2026-05-12-web-frontend-requirements.md)
- **Ideation document:** [docs/ideation/2026-05-12-web-frontend-ideation.md](docs/ideation/2026-05-12-web-frontend-ideation.md)
- Related code: `packages/tui/src/store.ts`, `packages/core/src/agent.ts`, `packages/core/src/loop.ts`, `packages/sdk/src/index.ts`
