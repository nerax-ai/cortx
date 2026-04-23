---
title: Fix TUI Review Findings (P0 + P1)
type: fix
status: active
date: 2026-04-19
origin: docs/brainstorms/2026-04-19-tui-review-fixes-requirements.md
---

# Fix TUI Review Findings (P0 + P1)

## Overview

Fix 15 critical and high-impact findings from the code review of the Ink-based TUI refactoring. The P0 issue (Ctrl+C double-fire) makes the TUI unusable in practice. The session system is architecturally incomplete. Several React anti-patterns and dead code need cleanup.

## Problem Frame

The TUI was built as a complete replacement for the readline CLI. A code review by 6 reviewer personas identified 41 findings. The 15 P0+P1 findings represent correctness breakage (Ctrl+C exits immediately), architectural gaps (session persistence incomplete, renderer pipeline disconnected), and React anti-patterns (setState during render, unstable memo deps).

## Requirements Trace

- R1. Single Ctrl+C during agent run aborts (does NOT exit). Second Ctrl+C exits. (P0-1)
- R2. `isResuming` flag properly resets — no silent message drops (P1-2)
- R3. Session restore loads messages back into the agent and resumes correctly (P1-3, P1-4)
- R4. Timer cleanup on unmount — no leaked intervals (P1-5)
- R5. Registry stable across session picker open/close (P1-6)
- R6. Renderer pipeline wired or dead code removed (P1-7, P1-8)
- R7. Down-arrow navigates to newer history entries from end-of-input (P1-9)
- R8. All runtime methods tested, critical paths tested (P1-10, P1-11)
- R9. No `as any` casts in session plugin wiring (P1-12)
- R10. setStatus uses proper React pattern (P1-13)
- R11. Single auto-save source, no second plugin instance (P1-14)

## Scope Boundaries

- **Out of scope**: All 26 P2 findings, all 6 P3 findings
- **Out of scope**: Security hardening (temp file predictability, plaintext sessions)
- **Out of scope**: Performance optimizations (factory caching, batch dispatch)

### Deferred to Separate Tasks

- P2 security findings (temp file, session encryption, input validation)
- P2 performance findings (factory caching, batch dispatch, Set handling)
- P2 code hygiene (dead code removal beyond renderer/plugin, shared helpers)

## Context & Research

### Relevant Code and Patterns

- `packages/tui/src/app.tsx` — Root component, session wiring, Ctrl+C handling
- `packages/tui/src/store.ts` — TuiStore with dispatch, selectors, timer
- `packages/tui/src/components/input-area.tsx` — Ctrl+C state machine, status sync
- `packages/tui/src/renderer.ts` — Event routing pipeline (currently disconnected)
- `packages/tui/src/plugins/session-plugin.ts` — Session persistence
- `packages/tui/src/plugins/markdown-plugin.ts` — Zero-behavior placeholder
- `packages/core/src/loop.ts` — Agent loop with isResuming flag

### Institutional Learnings

- React 18 with `react-jsx` transform does not need `import React` — subagents kept adding it
- `useSyncExternalStore` requires stable subscribe/getSnapshot references

## Key Technical Decisions

1. **Ctrl+C ownership**: Remove the App-level `useInput` handler entirely. InputArea is the sole Ctrl+C handler. App exposes `onAbort` and `onForceExit` callbacks that InputArea calls directly. No shared state ambiguity. *(see origin: Key Decisions #3)*

2. **Renderer pipeline**: Wire `processEvent()` into app.tsx's `session.subscribe` callback. The renderer module is the right architecture — it routes events to the store AND invokes registered renderer extensions. Currently only the store dispatch happens. *(see origin: Key Decisions #1)*

3. **Session message accumulation**: Change `TuiState.messages` from `string` to an array of turn entries `{ role, content }`. Each turn appends, never resets. The output region renders the latest turn's text for streaming; auto-save persists the full array. *(see origin: Key Decisions #2)*

4. **Auto-save architecture**: Extract auto-save into a standalone function in session-plugin.ts. App.tsx calls it directly with deps (getSessionId, getMessages, getModel). No second plugin instance, no `as any` cast. *(see origin: Key Decisions #4)*

5. **Status sync in InputArea**: Replace render-time `setStatus` with a `useEffect` watching `isRunning`. Handle `interrupting → idle` transition when isRunning becomes false and status is not 'interrupting' (i.e., the abort completed).

6. **markdown-plugin.ts**: Keep but wire the renderer. Once processEvent is connected, the markdown plugin's renderer extension will actually be invoked for text_delta events.

## Open Questions

### Resolved During Planning

- **Renderer pipeline vs removal**: Wire it. The extension system is the right architecture; it just isn't connected.
- **Session messages shape**: Array of turn objects `{ role: string, content: string }` rather than flat string.
- **Auto-save extraction**: Standalone function, not a plugin method.

### Deferred to Implementation

- Exact shape of the turn entry array (string-only content vs full LanguageMessage subset)
- Whether renderer extensions can produce side effects beyond the return value

## Implementation Units

- [ ] **Unit 1: Fix Ctrl+C double-fire (P0)**

**Goal:** Make Ctrl+C work correctly — single press aborts during run, second press exits.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `packages/tui/src/app.tsx`
- Modify: `packages/tui/src/components/input-area.tsx`
- Test: `packages/tui/src/__tests__/input.test.ts`

**Approach:**
- Remove the `useInput` handler for Ctrl+C from `app.tsx` (lines 195-205)
- InputArea already handles all Ctrl+C cases via `resolveCtrlCAction` — it calls `onAbort` and `onForceExit` props correctly
- The `status` in InputArea needs to derive from the store rather than local state (see Unit 5)
- For now, ensure the `isRunning` prop accurately reflects store status so InputArea's state machine works

**Patterns to follow:**
- `resolveCtrlCAction` in input-area.tsx (existing state machine)

**Test scenarios:**
- Happy path: resolveCtrlCAction('running', '') returns 'abort' (existing)
- Happy path: resolveCtrlCAction('interrupting', '') returns 'force-exit' (existing)
- Edge case: verify that InputArea's onAbort/onForceExit callbacks are the only code paths that handle Ctrl+C — no duplicate handler in App

**Verification:**
- App.tsx has no `useInput` handler for Ctrl+C
- Single Ctrl+C press during agent run calls onAbort only (not exit)
- Second Ctrl+C press during interrupting state calls onForceExit

---

- [ ] **Unit 2: Fix isResuming flag in agent loop (P1-2)**

**Goal:** Ensure `isResuming` is reset at the start of each mainLoop iteration, not only in the tool-calls branch.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `packages/core/src/loop.ts`
- Test: `packages/core/src/__tests__/loop.test.ts` (create if needed)

**Approach:**
- Move `isResuming = false` to the top of the mainLoop body (after the abort/iteration checks, before the stream phase)
- Only set `isResuming = true` inside the `if (resumeFromToolCalls)` block, which already exists
- Remove the line `isResuming = false` at line 277 since it will be redundant

**Patterns to follow:**
- Existing reset patterns at top of mainLoop (iteration check, abort check)

**Test scenarios:**
- Happy path: skipInitialLlm=true with tool calls resumes correctly, isResuming resets on next iteration
- Edge case: context overflow recovery during resumed session — isResuming does not persist into post-recovery iteration
- Edge case: resumed session with text-only output (no tool calls) — assistant message still pushed to messages array

**Verification:**
- After any iteration boundary, isResuming is always false regardless of how the previous iteration ended

---

- [ ] **Unit 3: Refactor store messages to accumulate across turns (P1-4, P1-5)**

**Goal:** Store accumulates all turn messages instead of resetting on each turn_start. Add dispose() for timer cleanup.

**Requirements:** R3, R4

**Dependencies:** None (can run in parallel with Units 1-2)

**Files:**
- Modify: `packages/tui/src/types/tui-state.ts`
- Modify: `packages/tui/src/store.ts`
- Test: `packages/tui/src/__tests__/store.test.ts`

**Approach:**
- Change `TuiState.messages` type from `string` to `{ turns: TurnEntry[]; currentText: string }` where `TurnEntry = { role: string; content: string; timestamp: number }`
- `turn_start` appends the previous `currentText` as a completed turn (if non-empty) and resets `currentText` to `''`
- `text_delta` and `text` update `currentText` only (same as before)
- `done` appends the final `currentText` as a completed turn
- Add `dispose()` method that calls `stopElapsedTimer()` and clears `selectorSubs`
- Remove the `thinking_delta` no-op spread (just break without state mutation)
- Remove redundant `as TuiStatus` casts

**Technical design:**
```
State shape change:
  messages: string  →  { turns: TurnEntry[], currentText: string }

turn_start: if currentText non-empty, push it as {role:'assistant', content:currentText} to turns. Reset currentText.
text_delta: currentText += delta  (same as before, but on currentText not messages)
text: currentText = content  (finalize)
done: if currentText non-empty, push final turn. Reset currentText.
getMessages() for auto-save: return full turns array serialized
getMessagesForDisplay(): return currentText (for OutputRegion streaming)
```

**Patterns to follow:**
- Existing dispatch pattern in store.ts
- Selector-based subscription already handles new state shape

**Test scenarios:**
- Happy path: single turn streams text_delta, text, done — turns array has one entry
- Happy path: multiple turns — turns array accumulates, currentText resets between turns
- Edge case: turn_start when currentText is empty — no empty turn appended
- Edge case: done when currentText is empty — no empty turn appended
- Edge case: dispose() clears timer and removes all selector subscriptions
- Edge case: setSessionId updates sessionId and notifies subscribers
- Edge case: reset(customId) sets sessionId to provided value

**Verification:**
- After a multi-turn conversation, `store.getState().messages.turns.length` equals the number of completed turns
- `store.getState().messages.currentText` is the streaming buffer for the current turn
- `dispose()` can be called without error and clears the elapsed timer

---

- [ ] **Unit 4: Refactor session auto-save and wiring (P1-3, P1-12, P1-14)**

**Goal:** Extract auto-save as standalone function. Fix session restore to load messages into agent. Eliminate `as any` cast.

**Requirements:** R3, R9, R11

**Dependencies:** Unit 3 (new messages shape)

**Files:**
- Modify: `packages/tui/src/plugins/session-plugin.ts`
- Modify: `packages/tui/src/app.tsx`

**Approach:**
- Export `createAutoSaveHandler(deps)` as a standalone function from session-plugin.ts (not a plugin method)
- `deps` type is explicit: `{ getSessionId, getMessages, getModel, sessionsDir, startTime }`
- Update `SessionPluginDeps.getMessages` return type to match new store shape
- In app.tsx useEffect: call `createAutoSaveHandler(deps)` directly instead of creating a second plugin instance
- In app.tsx handleRestoreSession: after reading session file, pass the restored turns to the agent's message history before calling session.resume()
- Remove the `as any` cast entirely — the standalone function has proper types
- Update `SessionMetadata.messages` type to store the turns array (serialized as JSON string for backward compat, or as an array)

**Patterns to follow:**
- Existing `saveSession`, `buildSessionMetadata` pure functions in session-plugin.ts

**Test scenarios:**
- Happy path: createAutoSaveHandler returns a function that saves session on 'done' event
- Happy path: createAutoSaveHandler saves session on 'error' event with 'crashed' status
- Edge case: handler ignores non-terminal events ('text_delta', 'turn_start')
- Integration: restored session's messages array is passed to agent before resume

**Verification:**
- No `as any` cast exists in app.tsx for session plugin access
- Auto-save uses a single function, not a second plugin instance
- Session restore passes messages to the agent

---

- [ ] **Unit 5: Fix InputArea status sync and down-arrow guard (P1-9, P1-13)**

**Goal:** Use useEffect for status sync. Fix down-arrow to check end-of-input. Handle interrupting→idle transition.

**Requirements:** R7, R10

**Dependencies:** Unit 1 (Ctrl+C ownership clarified)

**Files:**
- Modify: `packages/tui/src/components/input-area.tsx`
- Test: `packages/tui/src/__tests__/input.test.ts`

**Approach:**
- Replace render-time `setStatus` with `useEffect(() => { ... }, [isRunning])` that syncs status
- Add transition: when `isRunning` becomes false and `status` is 'interrupting', set to 'idle' (abort completed)
- Fix down-arrow guard: change `cursor.row === 0 && cursor.col === 0` to `cursorAtEnd(value)` check for down navigation
- Add `cursorAtEnd(value)` helper: checks if cursor is at the last character of the last line
- Remove `getState` callback and `void getState` dead code

**Patterns to follow:**
- `getCursorPosition` helper already exists — extend with `cursorAtEnd` counterpart

**Test scenarios:**
- Happy path: isRunning transitions true→false, status goes running→idle
- Edge case: isRunning false while status is 'interrupting', status transitions to idle (abort completed)
- Edge case: isRunning stays true, status stays running (no flip-flop)
- Happy path: down-arrow with cursor at end of input navigates history
- Edge case: down-arrow with cursor NOT at end of input does not navigate history
- Edge case: up-arrow with cursor NOT at start of input does not navigate history

**Verification:**
- No `setStatus` call during render phase
- Down-arrow history navigation works when cursor is at end of input
- `interrupting → idle` transition happens when isRunning becomes false

---

- [ ] **Unit 6: Wire renderer pipeline and stabilize registry (P1-6, P1-7, P1-8)**

**Goal:** Connect processEvent into the event stream. Stabilize registry useMemo. Keep markdown-plugin (it will actually work now).

**Requirements:** R5, R6

**Dependencies:** Unit 3 (store changes), Unit 4 (app.tsx changes)

**Files:**
- Modify: `packages/tui/src/app.tsx`
- Modify: `packages/tui/src/plugins/markdown-plugin.ts` (update comment to reflect it's now wired)
- Test: `packages/tui/src/__tests__/renderer.test.ts`

**Approach:**
- In app.tsx's `session.subscribe` callback: call `processEvent(event, store, registry)` instead of `store.dispatch(event)` directly
- `processEvent` already calls `store.dispatch` internally AND invokes renderer extensions
- Remove `sessionList` from the registry useMemo deps — use a ref for sessionList instead
- Move `handleOpenSessionPicker` and `handleRestoreSession` to use refs (or inline the sessionList lookup at call time)
- Keep markdown-plugin.ts — its renderer extension will now actually be invoked

**Patterns to follow:**
- `processEvent` in renderer.ts (already handles store dispatch + renderer invocation)

**Test scenarios:**
- Happy path: processEvent dispatches event to store AND invokes registered renderers
- Edge case: renderer extension that throws does not interrupt store dispatch
- Integration: markdown-plugin renderer invoked for text_delta events after wiring

**Verification:**
- `processEvent` is called in the session.subscribe callback
- Registry instance identity stable across session picker open/close
- `renderer.test.ts` tests still pass

---

- [ ] **Unit 7: Add tests for session plugin runtime methods (P1-11)**

**Goal:** Test getAutoSaveHandler, detectCrashedSessions, restoreSession, and the new createAutoSaveHandler.

**Requirements:** R8

**Dependencies:** Unit 4 (auto-save refactored)

**Files:**
- Modify: `packages/tui/src/__tests__/session-plugin.test.ts`

**Approach:**
- Test `createAutoSaveHandler`: invoke with 'done' and 'error' event types, verify file written with correct metadata
- Test `detectCrashedSessions`: create mix of completed and crashed session files, verify only crashed returned
- Test `restoreSession`: verify loads existing session, returns null for non-existent
- Test `setSessionId` and `reset(sessionId)` on the store (these were untested)

**Patterns to follow:**
- Existing session-plugin.test.ts patterns (mock deps, temp directories)

**Test scenarios:**
- Happy path: createAutoSaveHandler('done') writes file with status 'completed'
- Happy path: createAutoSaveHandler('error') writes file with status 'crashed'
- Edge case: createAutoSaveHandler ignores 'text_delta' event type
- Happy path: detectCrashedSessions returns only crashed sessions
- Edge case: detectCrashedSessions with no session files returns empty array
- Happy path: restoreSession returns metadata for existing session
- Edge case: restoreSession returns null for non-existent session ID
- Happy path: store.setSessionId updates sessionId and notifies subscribers
- Happy path: store.reset('custom-id') sets sessionId to provided value

**Verification:**
- All new tests pass
- Coverage of session plugin runtime methods > 80%

---

- [ ] **Unit 8: Add integration tests for critical flows (P1-10)**

**Goal:** Test the critical integration paths that have zero React component coverage — primarily the event-to-store-to-auto-save pipeline.

**Requirements:** R8

**Dependencies:** Units 3, 4, 6 (all store and wiring changes complete)

**Files:**
- Create: `packages/tui/src/__tests__/integration.test.ts`

**Approach:**
- Test the full event pipeline: create a store, registry, wire processEvent, dispatch events, verify store state and renderer invocations
- Test the session lifecycle: dispatch turn_start → text_delta → text → tool_use → tool_result → turn_end → done, verify final state
- Test multi-turn accumulation: two full cycles, verify turns array
- Test Ctrl+C state machine end-to-end: running → dispatch abort → interrupting status → isRunning false → idle
- These are NOT React component tests — they test the wiring between store, registry, renderer, and auto-save without mounting React components

**Test scenarios:**
- Integration: full agent turn lifecycle produces correct store state (status, iteration, toolCalls, messages)
- Integration: multi-turn conversation accumulates turns correctly
- Integration: Ctrl+C state machine transitions through running→interrupting→idle
- Integration: auto-save handler triggered on done/error writes session with correct turns
- Integration: session restore loads messages and updates store sessionId

**Verification:**
- Integration tests cover the session.subscribe → store → auto-save pipeline
- Integration tests cover the Ctrl+C state machine transitions
- All 293+ existing tests still pass

## System-Wide Impact

- **Interaction graph:** Ctrl+C path changes from dual-handler (App + InputArea) to single-handler (InputArea only). This affects `app.tsx`, `input-area.tsx`, and any component that depends on the App-level Ctrl+C behavior.
- **Error propagation:** Renderer extension errors are already isolated by processEvent. No change to error propagation.
- **State lifecycle risks:** Changing `messages` from `string` to `{ turns, currentText }` affects all consumers: OutputRegion, SessionPlugin, StatusBar (token display). All must be updated to read `currentText` for streaming display.
- **API surface parity:** `SessionPluginDeps.getMessages` return type changes. `SessionMetadata.messages` format changes. `TuiState.messages` type changes.
- **Unchanged invariants:** The 13 AgentEvent types and their dispatch behavior remain the same. The TuiRegistry plugin registration API is unchanged. The selector subscription mechanism is unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| messages type change breaks OutputRegion and other consumers | Unit 3 changes the type; Unit 6 updates consumers in same PR |
| Session restore messages format incompatible with agent | Unit 4 handles format conversion when loading into agent |
| Removing App-level Ctrl+C handler breaks overlay cases | InputArea already has overlayActive prop that suppresses its handler; overlay components handle Escape directly |
| Renderer wiring changes event delivery timing | processEvent calls store.dispatch synchronously before renderers — same timing as before |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-19-tui-review-fixes-requirements.md](docs/brainstorms/2026-04-19-tui-review-fixes-requirements.md)
- Related code: `packages/tui/src/store.ts`, `packages/tui/src/app.tsx`
- Related plan: `docs/plans/2026-04-19-002-refactor-ink-tui-plan.md`
