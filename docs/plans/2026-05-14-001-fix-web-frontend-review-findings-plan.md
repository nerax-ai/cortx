---
title: "fix: Web frontend review findings — SSE routing, auth wiring, reactivity, concurrency"
type: fix
status: active
date: 2026-05-14
origin: Code review of feat/web-frontend branch (11 reviewer synthesis)
---

# fix: Web Frontend Review Findings

## Overview

Fix all P0/P1 issues and important P2s identified during the code review of the `feat/web-frontend` branch. The review surfaced 4 P0s, 6 P1s, and 11 P2s across 11 reviewers. This plan addresses the critical and high-priority items in 6 implementation units.

## Problem Frame

The web frontend (`@cortx/web`), HTTP server (`@cortx/server`), and shared store (`@cortx/store`) were implemented in the previous iteration but have multiple integration bugs that prevent the system from functioning end-to-end:

1. SSE events never reach the client (named-event routing mismatch)
2. The SSE connection is never opened after session creation
3. The API key entered by the user is never passed to the bridge
4. React components don't re-render for state changes beyond status
5. Server has no guard against concurrent prompts on the same session
6. Error objects serialize to `{}` over SSE
7. The askUser dialog is a non-functional placeholder

## Requirements Trace

- R1. SSE events must flow from server to client and dispatch into the AgentStore
- R2. The connect flow (enter API key → create session → open SSE → send prompt → receive events) must work end-to-end
- R3. React components must re-render when any state slice changes (messages, toolCalls, status, etc.)
- R4. Server must reject concurrent prompts on the same session
- R5. Error events must carry meaningful messages over SSE
- R6. The askUser flow must display the question and auto-populate toolCallId
- R7. Token exchange must be used for subsequent requests after exchange
- R8. Abort must clean up pending askUser promises

## Scope Boundaries

### In Scope

- Fix all P0 and P1 review findings
- Fix P2 findings that are safe to include in the same unit (no scope creep)
- Add tests for fixed behavior where test infrastructure exists

### Deferred to Separate Tasks

- Missing steer/follow-up API routes (P2, new feature scope — separate PR)
- Missing GET /sessions/:id/state endpoint (P2, new feature scope)
- Web package test infrastructure setup (no test runner configured yet — dedicated task)
- Timing-safe token comparisons (P2, security hardening — separate pass)
- CORS configuration for production (P2, deployment concern)
- Event deduplication for SSE replay (P3, robustness improvement)

## Context & Research

### Relevant Code and Patterns

- `packages/store/src/store.ts` — AgentStore dispatch reducer handles 20 event types; selector-based subscriptions with shallow equality
- `packages/server/src/server.ts` — Hono routes with streamSSE; sends `event: event.type` on every SSE write
- `packages/server/src/session-manager.ts` — Fire-and-forget async IIFE for agent loop; no concurrent guard
- `packages/web/src/bridge/event-bridge.ts` — EventSource client; `onmessage` + single `addEventListener('user_question')`
- `packages/web/src/bridge/auth.ts` — apiFetch always uses `client.apiKey`, ignores `client.token`
- `packages/web/src/hooks/use-store.ts` — Subscribes only to `s.status` selector
- `packages/web/src/App.tsx` — Creates EventBridge with defaults, never calls `connect()`, never passes API key

### Institutional Learnings

- EventSource API cannot set custom headers — token must go via query param (see web frontend plan Key Decision)
- Map fields silently vanish on JSON.stringify — serialization.ts handles this explicitly
- processEvent() was dead code for weeks — always verify event pipelines are wired end-to-end (see background viewer plan)

## Key Technical Decisions

- **SSE routing fix: Remove `event:` field from server writes.** The server currently sends `event: event.type` on every SSE message. Per the SSE spec, named events only fire on matching `addEventListener` handlers — they do NOT fire `onmessage`. The simplest fix is to remove the `event:` field so all events arrive via the default `onmessage` handler. The event type is already in the JSON payload. Keep the `event:` field only for the `ping` keepalive (so it doesn't get dispatched to the store). Rationale: avoids registering N addEventListener handlers, keeps the client simple.

- **useStore fix: Subscribe to full state with identity selector.** Replace `store.select(s => s.status)` with a subscription that fires on any state change. The cleanest approach: create a generic onChange subscription on AgentStore that fires on every `notifySelectors()` call, and use it in useStore. This avoids the overhead of subscribing to every individual field.

- **API key flow: Pass via callback parameter.** Change `ConnectionOverlay`'s `onConnect` to accept the apiKey string. App.tsx reconstructs or reconfigures the EventBridge with the key. This is the minimal wiring change.

- **Token usage in apiFetch: Prefer token when available.** Change `apiFetch` to use `client.token ?? client.apiKey` for the Authorization header.

- **Concurrent prompt guard: Add isRunning flag to ManagedSession.** Set true before the async loop, clear in finally block. Return 409 if already running.

- **Error serialization: Convert Error to plain object before SSE write.** In the broadcast path, intercept error events and replace `error: Error` with `{ message, name }`.

## Open Questions

### Resolved During Planning

- SSE routing approach: Remove named events from server (confirmed simplest)
- useStore reactivity approach: Add generic onChange mechanism to AgentStore
- Auth wiring approach: Pass apiKey via callback parameter

### Deferred to Implementation

- Whether AgentStore's onChange mechanism should use a counter or a symbol key in selectorSubs — implementation detail
- Exact shape of the pendingQuestion field on AgentState — straightforward but naming is execution-time

## Implementation Units

- [ ] **Unit 1: Fix SSE event routing**

**Goal:** Make all agent events flow from server to client via SSE. Currently silently dropped.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `packages/server/src/server.ts` (SSE write path — remove `event:` field except for ping)
- Test: `packages/server/tests/server.test.ts` (add SSE event body verification)

**Approach:**
- In the SSE replay loop and subscriber callback, remove the `event:` field from `stream.writeSSE()` calls. Keep `event: 'ping'` for the keepalive ping so it doesn't get dispatched to the store.
- On the client side (`event-bridge.ts`), remove the `addEventListener('user_question')` handler since `onmessage` will now receive all events. Add a guard in `onmessage` to skip events without a recognized `type` field (catches the ping).
- Fix the query parameter mismatch: change client SSE URL from `?token=` to `?key=` to match server's `extractApiKey`. Alternatively, update `extractApiKey` to also check `c.req.query('token')`.

**Test scenarios:**
- Happy path: SSE stream delivers a text_delta event, client onmessage handler receives and parses it correctly
- Edge case: Ping event (`{}`) is not dispatched to the store
- Error path: Server sends error event with Error object — verify JSON payload

**Verification:**
- SSE test reads at least one event from the stream and verifies it contains the expected JSON payload
- Client guard correctly filters ping events

---

- [ ] **Unit 2: Fix web app connection flow**

**Goal:** Make the connect flow work end-to-end: enter API key → create session → open SSE → ready.

**Requirements:** R2, R7

**Dependencies:** Unit 1 (SSE routing must be fixed for events to arrive)

**Files:**
- Modify: `packages/web/src/App.tsx` (pass API key, call connect, add cleanup)
- Modify: `packages/web/src/components/ConnectionOverlay.tsx` (pass apiKey via callback)
- Modify: `packages/web/src/bridge/auth.ts` (prefer token in apiFetch)
- Modify: `packages/web/src/bridge/event-bridge.ts` (reset store on reconnect, add disconnect on unmount support)

**Approach:**
- Change `ConnectionOverlayProps.onConnect` to `(apiKey: string) => void`. Pass the apiKey when calling `onConnect()`.
- In `App.tsx`, accept the apiKey in `connect()`, create a new `EventBridge(apiKey)` (or update the client), call `bridge.createSession()` then `bridge.connect(id)`, then `setConnected(true)`.
- In `apiFetch`, change Authorization header to prefer `client.token ?? client.apiKey`.
- In `EventBridge.connect()`, call `this.store.reset()` before connecting to clear stale state from prior sessions.
- Add `useEffect` cleanup in App to call `bridge.disconnect()` on unmount.

**Test scenarios:**
- Happy path: Connect with API key → bridge receives key → createSession sends key in auth → connect opens SSE → store is reset
- Edge case: Reconnect to new session clears previous session state from store
- Error path: Invalid API key → exchangeToken fails → error shown to user

**Verification:**
- Manual: Enter API key, click Connect, verify SSE connection opens (no 401)
- Bridge.auth.ts: apiFetch uses token when available, falls back to apiKey

---

- [ ] **Unit 3: Fix useStore reactivity**

**Goal:** React components re-render when any state field changes, not just status.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `packages/store/src/store.ts` (add `onChange` subscription method)
- Modify: `packages/web/src/hooks/use-store.ts` (use onChange instead of status selector)

**Approach:**
- Add an `onChange(callback): () => void` method to AgentStore that fires the callback on every `notifySelectors()` call. Implementation: maintain a `Set<() => void>` of onChange listeners, add/remove via the returned unsubscribe function, iterate in `notifySelectors()`.
- In `useStore`, replace the `store.select(s => s.status)` subscription with `store.onChange(callback)`. This fires on every state change, which is what the React components need.

**Test scenarios:**
- Happy path: Dispatch text_delta → useStore triggers re-render → component sees updated currentText
- Happy path: Dispatch tool_use → useStore triggers re-render → component sees updated toolCalls
- Edge case: Multiple rapid dispatches → React batches updates (no excessive renders)

**Verification:**
- Existing store tests still pass
- useStore triggers callback on text_delta dispatch (not just status changes)

---

- [ ] **Unit 4: Fix server concurrency and lifecycle**

**Goal:** Prevent concurrent prompts, clean up on abort/destroy, serialize errors properly.

**Requirements:** R4, R5, R8

**Dependencies:** None

**Files:**
- Modify: `packages/server/src/session-manager.ts` (isRunning guard, rejectPendingQuestions on abort/destroy, error serialization)
- Test: `packages/server/tests/session-manager.test.ts` (new test file)

**Approach:**
- Add `isRunning: boolean` to `ManagedSession`. In `prompt()`, check and return 409 if running. Set true before the async loop, false in finally block.
- In `abort()`, after calling `cortx.abort()`, also call `controller.rejectPendingQuestions('Session aborted')`.
- In `destroy()`, also call `controller.rejectPendingQuestions('Session destroyed')`.
- In `broadcast()`, before pushing event and iterating subscribers, check if the session is still in `this.sessions` (guard against orphaned async loops).
- In the error catch of the async IIFE, convert Error objects to plain objects before broadcasting: `{ type: 'error', error: { message: e.message, name: e.name }, code: 'stream_error' }`.
- Guard `user_answer` status transition: only set status to 'running' if currently 'awaiting_user'. Also validate that the toolCallId has a pending question before broadcasting user_answer.

**Test scenarios:**
- Happy path: prompt → agent runs → done → isRunning cleared
- Edge case: Second prompt while running → 409 Conflict
- Error path: Agent loop throws → error event with actual message (not {})
- Integration: abort while askUser pending → pending questions rejected → session cleanup
- Integration: delete session while loop running → broadcast guards against orphaned session

**Verification:**
- Concurrent prompt returns 409
- Error events contain message text over SSE
- Abort during askUser resolves the pending promise (no 120s hang)

---

- [ ] **Unit 5: Fix askUser web flow**

**Goal:** Store pending question data, surface it in the UI, auto-populate toolCallId.

**Requirements:** R6

**Dependencies:** Unit 2 (connection flow), Unit 3 (reactivity)

**Files:**
- Modify: `packages/store/src/types.ts` (add `pendingQuestion` to AgentState)
- Modify: `packages/store/src/store.ts` (store question data on user_question dispatch)
- Modify: `packages/web/src/App.tsx` (pass pending question to AskUserDialog)
- Modify: `packages/web/src/components/AskUserDialog.tsx` (display question, auto-populate toolCallId, remove unused imports)

**Approach:**
- Add `pendingQuestion: { toolCallId: string; question: string } | null` to `AgentState` (default `null`).
- In `dispatch` for `user_question`: set `pendingQuestion: { toolCallId: event.toolCallId, question: event.question }`.
- In `dispatch` for `user_answer`: clear `pendingQuestion: null`.
- In `App.tsx`, pass `pendingQuestion={state.pendingQuestion}` to AskUserDialog.
- Rewrite AskUserDialog: accept `pendingQuestion` and `onSubmit` props. Display the question text. Auto-populate toolCallId (hidden). User only enters their response.
- Remove unused imports (AgentEvent, useStore, EventBridge).

**Test scenarios:**
- Happy path: user_question dispatched → state.pendingQuestion set → AskUserDialog shows question text
- Happy path: User types response and submits → onSubmit called with toolCallId and response → user_answer clears pendingQuestion
- Edge case: No pending question → AskUserDialog not rendered

**Verification:**
- AskUserDialog displays the agent's question text
- User only needs to type their response (toolCallId is auto-populated)
- Store correctly stores and clears pendingQuestion

---

- [ ] **Unit 6: Minor fixes and cleanup**

**Goal:** Address remaining P2/P3 items that are safe to include.

**Requirements:** R7

**Dependencies:** None (independent of other units)

**Files:**
- Modify: `packages/server/src/auth.ts` (accept `?token=` in addition to `?key=`)
- Modify: `packages/server/src/server.ts` (remove dead host/port variables)
- Modify: `packages/web/src/components/AskUserDialog.tsx` (remove unused imports — already done in Unit 5)
- Modify: `packages/web/package.json` (add `lint` script)

**Approach:**
- Update `extractApiKey` to check both `c.req.query('token')` and `c.req.query('key')` — makes the SSE auth flexible regardless of which query param name the client uses.
- Remove the `host` and `port` local variables in server.ts (unused — config values are checked inline).
- Add `"lint": "tsc --noEmit"` to web package.json for monorepo lint consistency.

**Test scenarios:**
- Edge case: extractApiKey returns value from `?token=` when `?key=` is absent
- Edge case: extractApiKey returns value from `?key=` when both are present (key takes precedence)
- Verification: `bun run lint` passes for web package

**Verification:**
- SSE auth works with either `?token=` or `?key=` query parameter
- Web package lint script runs without error

## System-Wide Impact

- **Interaction graph:** AgentStore.dispatch now handles `pendingQuestion` state. TuiStore inherits this field but doesn't use it — no TUI impact.
- **Error propagation:** Error events over SSE now carry `{ message, name }` instead of `Error` objects. Client store already accesses `event.error.message` — now it will actually work.
- **State lifecycle risks:** The `isRunning` flag on ManagedSession prevents concurrent loops. The `rejectPendingQuestions` call in abort/destroy prevents dangling Promises.
- **API surface parity:** No API contracts are added or removed. The SSE wire format changes (no `event:` field on data events) — this is a fix, not a breaking change (the current format never worked).
- **Unchanged invariants:** The TUI store and renderer are not modified. The @cortx/core askUser mechanism is not modified. The @cortx/store serialization layer is not modified.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| SSE format change could affect future consumers expecting named events | The event type is preserved in the JSON payload. Named events never worked — this is the initial working state. |
| AgentStore.onChange fires on every dispatch — potential performance concern for high-frequency text_delta | useSyncExternalStore with getSnapshot returns same reference if state hasn't changed. React's built-in batching handles rapid updates. Monitor in practice. |
| pendingQuestion field on AgentState adds a web-specific concern to the shared store | The field is minimal (nullable object) and useful for any consumer that handles user_question events. Not web-specific. |

## Sources & References

- **Code review synthesis:** 11 reviewers (correctness, testing, maintainability, security, api-contract, reliability, adversarial, kieran-typescript, agent-native, project-standards, learnings)
- **Original plan:** docs/plans/2026-04-26-002-feat-web-frontend-plan.md
- Related code: packages/store/src/store.ts, packages/server/src/session-manager.ts, packages/web/src/bridge/event-bridge.ts
