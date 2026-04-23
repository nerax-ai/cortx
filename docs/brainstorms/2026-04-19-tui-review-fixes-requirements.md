# TUI Review Fixes Requirements

Created: 2026-04-19
Status: active
Origin: Code review findings from `/ce-review` on TUI refactoring

## Problem Frame

The code review identified 41 findings across correctness, reliability, security, TypeScript quality, testing, and maintainability. Of these, 1 is P0 (critical breakage) and 14 are P1 (high-impact defects). The P0 issue (Ctrl+C double-fire) causes the app to exit immediately on a single Ctrl+C during agent runs, making the TUI unusable in practice. The session system is architecturally incomplete: restore doesn't load messages, auto-save only persists the last turn, and the auto-save wiring is fragile.

## Scope

Fix all P0 and P1 findings only. P2/P3 deferred to later work.

### In Scope (15 findings)

**P0-1: Ctrl+C double-fire**
- Both `app.tsx` and `input-area.tsx` handle Ctrl+C via Ink's `useInput`
- Ink delivers the event to both handlers simultaneously
- One press during `running` triggers abort (InputArea) AND exit (App)
- Fix: consolidate to single handler, use store status as canonical state

**P1-2: isResuming flag persistence**
- `loop.ts` flag only cleared in tool-calls branch
- Context overflow recovery can cause it to persist forever
- Silently drops all subsequent assistant messages
- Fix: reset flag at the start of each mainLoop iteration

**P1-3: Session restore doesn't load messages**
- `app.tsx:handleRestoreSession` calls `store.reset()` and `session.resume()`
- Never loads persisted messages into the Cortx agent
- `resume()` expects `this._messages` to contain prior conversation
- Fix: pass restored messages to agent before resume

**P1-4: Store only retains current turn**
- `turn_start` resets `messages` to empty string
- Auto-save reads from `store.getState().messages` — only last turn
- Makes session restore fundamentally incomplete
- Fix: accumulate messages across turns instead of resetting

**P1-5: TuiStore timer leak**
- `setInterval` for elapsed time never cleaned up on unmount
- No `dispose()` method on the store
- Fix: add `dispose()`, call from App's useEffect cleanup

**P1-6: Registry recreated on sessionList change**
- `useMemo` depends on `sessionList` state
- Opening session picker destroys and re-registers all plugins
- Fix: move sessionList to ref, remove from useMemo deps

**P1-7: renderer.ts is dead code**
- `processEvent()` never called in production
- App dispatches directly to `store.dispatch()`
- Renderer extension system unused
- Fix: either wire renderer pipeline into app.tsx or remove the module

**P1-8: markdown-plugin.ts is zero-behavior placeholder**
- Registers null component and noop renderer
- Adds indirection without behavior
- Fix: remove unless renderer pipeline is wired (depends on P1-7)

**P1-9: Down-arrow history guard wrong**
- Copy-paste bug: uses start-of-input check (row 0, col 0)
- Should check end-of-input for down navigation
- History navigation disabled for any non-empty input
- Fix: correct the guard condition

**P1-10: Zero React component test coverage**
- App, AppShell, CommandPalette, SessionPicker, InputArea — untested
- Only pure helper functions covered
- Fix: add integration tests for critical components

**P1-11: Session plugin runtime methods untested**
- `getAutoSaveHandler()`, `detectCrashedSessions()`, `restoreSession()` untested
- These are the primary production code paths
- Fix: add tests for each method

**P1-12: `as any` cast for session plugin**
- `(savePlugin as any).getAutoSaveHandler?.()` bypasses type system
- Silent failure if method renamed
- Fix: define explicit `SessionPluginInstance` interface

**P1-13: setStatus during render**
- `input-area.tsx` calls `setStatus()` during render phase
- React anti-pattern, can cause re-render loops
- Missing transition for `interrupting → idle`
- Fix: use `useEffect` to sync status from prop

**P1-14: Auto-save creates second plugin instance**
- Separate from registered plugin with independent `sessionStartTime`
- Timestamps can diverge between instances
- Fix: extract auto-save as standalone function, single source of truth

### Out of Scope (deferred)

- All P2 findings (26 items): security hardening, performance, code hygiene
- All P3 findings (6 items): minor naming, weak assertions, barrel exports

## Success Criteria

1. Single Ctrl+C during agent run aborts (does NOT exit). Second Ctrl+C exits.
2. Session auto-save persists the full conversation across all turns
3. Session restore loads messages back into the agent and resumes correctly
4. `isResuming` flag properly resets — no silent message drops
5. Down-arrow navigates to newer history entries from end-of-input
6. Timer cleanup on unmount — no leaked intervals
7. Registry stable across session picker open/close
8. All runtime methods tested, critical components tested
9. No `as any` casts in session plugin wiring
10. All existing 293 tests continue to pass

## Key Decisions

1. **Renderer pipeline**: Wire `processEvent()` into app.tsx's event stream OR remove renderer.ts and markdown-plugin.ts entirely. Recommendation: wire it — the extension system is the right architecture, it just isn't connected yet.

2. **Session message accumulation**: Store should accumulate `messages` as an array of turn objects rather than a single string. This enables full conversation display and persistence.

3. **Ctrl+C ownership**: Single source of truth. Recommendation: InputArea handles Ctrl+C exclusively (it has the state machine), App does NOT register a separate Ctrl+C handler.

4. **Auto-save architecture**: Extract from plugin pattern into a standalone function with explicit deps (getSessionId, getMessages, getModel). No second plugin instance.

## Dependencies

- P1-7/P1-8 (renderer + markdown-plugin) are coupled — decide together
- P1-3/P1-4 (session restore + message accumulation) are coupled — fix together
- P1-12/P1-14 (type safety + auto-save architecture) are coupled — fix together
- P1-10/P1-11 (testing) should follow the code fixes
