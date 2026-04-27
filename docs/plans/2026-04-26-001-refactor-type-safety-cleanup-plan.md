---
title: "refactor: Eliminate all `any` and unsafe type casts, fix review issues"
type: refactor
status: active
date: 2026-04-26
---

# Refactor: Type Safety Cleanup and Review Issue Fixes

## Overview

Eliminate all 6 instances of `any` / unsafe type casts (`as unknown as`, `as any`, `as unknown`) across the cortx monorepo source, then address 4 remaining code quality issues from the prior review pass (duplicated formatting functions, silent error swallowing, dead method, redundant return pattern).

## Problem Frame

The parallel tool execution feature introduced several type escape hatches (`as unknown as LanguageMessage`, `as any`) and accumulated code quality debt. The codebase currently has:
- **6 unsafe type casts** across 3 packages (core, tui)
- **3 near-duplicated tool-summary formatting functions** across packages
- **1 silent error catch** in background agent path
- **1 dead public method** (`remove()` on SubAgentSessionStore)
- **1 redundant return pattern** in `runSubAgentLoop`

## Requirements Trace

- R1. Zero `any` or `as unknown as` casts in production source files (test files excluded)
- R2. Tool input formatting logic shared across packages, not duplicated
- R3. Background agent failures are logged, not silently swallowed
- R4. Dead code removed or documented as intentional API surface

## Scope Boundaries

- No behavioral changes — all refactoring is type-level or structural cleanup
- No new features or API changes
- Test files may retain `as any` / casts where needed for mocking — out of scope
- `@synax-ai/sdk` and `@synax-ai/core` are external linked packages — we cannot modify their types. Fixes must work within our codebase

## Key Technical Decisions

- **Helper functions over inline casts**: Introduce small, well-typed helper functions that construct properly-typed objects instead of casting. This is the idiomatic TypeScript approach when consuming opaque external types.
- **Extract shared utility to SDK package**: The duplicated tool-summary formatting logic belongs in `@cortx/sdk` as a shared utility, since both `core` and `tui` depend on it.
- **Keep `remove()` as public API**: It's used in tests and represents a legitimate session management operation. Dead code in production callers doesn't mean dead API — it was added for completeness.

## Context & Research

### Relevant Code and Patterns

- `packages/core/src/loop.ts:130` — shows `LanguageMessage` construction pattern: `{ role: 'system' as const, content: [{ type: 'text' as const, text: ... }] }` works without casts when TypeScript can infer the full union type from the const assertion.
- `packages/sdk/src/index.ts` — SDK package re-exports types from `@synax-ai/sdk`. This is the right place for shared utilities.
- `packages/tui/src/store.ts:79-82` — `as unknown` on `lastValue` is type erasure for a heterogeneous generic map. The fix requires a `SelectorEntry<T>` generic pattern.

### Type Cast Inventory

| # | File | Line | Cast | Root Cause |
|---|------|------|------|------------|
| 1 | `core/src/agent.ts` | 183 | `as unknown as LanguageMessage` | Constructing user message for sub-agent — object literal not assignable to opaque union |
| 2 | `core/src/skill/plugin.ts` | 31 | `as unknown as LanguageMessage` | Spreading message and replacing content — spread loses discriminated union narrowing |
| 3 | `core/src/loop.ts` | 139 | `as unknown[]` | Filtering heterogeneous content array for tool-call items |
| 4 | `tui/src/app.tsx` | 61 | `as unknown as LanguageMessage[]` | Restoring session messages from JSON — runtime data lacks type information |
| 5 | `tui/src/language.ts` | 17 | `as any` | Provider config type mismatch between config schema and Synax API |
| 6 | `tui/src/store.ts` | 81 | `as unknown` | Generic selector map storing heterogeneous typed values |

## Implementation Units

- [ ] **Unit 1: Add message construction helpers to core**

**Goal:** Eliminate `as unknown as LanguageMessage` casts in agent.ts and skill/plugin.ts by introducing properly-typed helper functions.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Create: `packages/core/src/message-helpers.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/skill/plugin.ts`
- Test: `packages/core/tests/message-helpers.test.ts`

**Approach:**
Create a `packages/core/src/message-helpers.ts` module with two helpers:
- `createUserMessage(text: string): LanguageMessage` — constructs a user message with the correct content array shape. Uses the same pattern that already works in `loop.ts:130` where TypeScript infers the union type from const assertions.
- `replaceMessageContent(msg: LanguageMessage, content: LanguageMessage['content']): LanguageMessage` — returns a new message with replaced content, preserving the role. Uses `satisfies` or explicit return type annotation instead of spread + cast.

Both helpers should use explicit return type annotations (`: LanguageMessage`) so TypeScript validates the construction at the helper boundary rather than at each call site.

In `agent.ts`, replace the inline construction at line 183 with `createUserMessage(prompt)`.
In `skill/plugin.ts`, replace the `replaceLastMessage` body with a call to `replaceMessageContent`.

**Test scenarios:**
- Happy path: `createUserMessage('hello')` returns object with role='user', content=[{ type: 'text', text: 'hello' }]
- Happy path: `replaceMessageContent` with existing message replaces content while preserving role
- Edge case: empty string input to `createUserMessage` still produces valid message structure
- Integration: messages produced by helpers are accepted by agentLoop without type errors

**Verification:**
- `bunx tsc --noEmit` passes in packages/core with zero errors
- No `as unknown` or `as any` remain in agent.ts or skill/plugin.ts
- All existing tests pass

---

- [ ] **Unit 2: Fix `as unknown[]` content filter in loop.ts**

**Goal:** Replace the unsafe `as unknown[]` cast with a proper type guard function.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `packages/core/src/loop.ts`

**Approach:**
Extract the inline type predicate into a named `isToolCallContent(item: unknown): item is LanguageToolCallContent` type guard function. The filter at line 139 already contains the logic (`typeof c === 'object' && c !== null && 'type' in c && c.type === 'tool-call'`) — extract it into a reusable guard.

The `LanguageToolCallContent` type is imported from `@cortx/sdk` which re-exports it from `@synax-ai/sdk`. The content array on `LanguageMessage` is typed as the full union of content types. TypeScript won't let you filter a union array to a subset without a type guard — this is the correct pattern, the current code just uses `as unknown[]` to bypass it.

With a named guard, change `(last.content as unknown[]).filter(...)` to `last.content.filter(isToolCallContent)` — if the content array type allows `.filter()` with type predicates, this works directly. If not (because the content type is `string | ContentPart[]` or similar), use `Array.from(last.content).filter(isToolCallContent)` with the content cast to `unknown[]` inside the helper itself, containing the cast to one well-typed boundary.

**Test scenarios:**
- Happy path: filtering an array containing tool-call items returns only those items with correct type
- Edge case: empty content array returns empty array
- Edge case: content with mixed types (text + tool-call + tool-result) filters correctly
- Error path: null/undefined items in array are excluded by the guard

**Verification:**
- `bunx tsc --noEmit` passes in packages/core
- The inline `as unknown[]` is eliminated from loop.ts
- All existing loop tests pass

---

- [ ] **Unit 3: Fix session restoration cast in app.tsx**

**Goal:** Replace `as unknown as LanguageMessage[]` in session restoration with a validated parsing approach.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `packages/tui/src/app.tsx`

**Approach:**
The session restoration code at line 61 reads JSON from disk and needs to convert it to `LanguageMessage[]`. Since this is runtime data from a file, a cast is inherently needed — the types don't exist at runtime. The fix is to contain the unsafe cast inside a dedicated `parseAgentMessages(data: unknown): LanguageMessage[]` function that:
1. Accepts `unknown` input
2. Performs basic runtime validation (is array, each item has role/content)
3. Returns `LanguageMessage[]` with the cast contained inside the function

This follows the "parse, don't validate" pattern — the function becomes the single trusted boundary where untyped data enters the typed system.

**Test scenarios:**
- Happy path: valid JSON message array produces correct LanguageMessage[]
- Edge case: `null` or `undefined` input returns empty array
- Edge case: missing `agentMessages` field falls back to mapping from TurnEntry format
- Error path: malformed data (non-array) returns empty array without throwing

**Verification:**
- `bunx tsc --noEmit` passes in packages/tui
- No `as unknown as` remains in app.tsx
- Session restore flow still works (manual verification or existing E2E test)

---

- [ ] **Unit 4: Fix `as any` provider cast in language.ts**

**Goal:** Eliminate `as any` in the provider registration loop.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `packages/tui/src/language.ts`

**Approach:**
The `p as any` cast at line 17 exists because `CortxConfig.providers` is typed as `ProviderConfig[]` (from `@synax-ai/sdk`) and `synax.addProvider()` expects a different type. Since both types are from the same external package (`@synax-ai/sdk` / `@synax-ai/core`), the mismatch may be a version skew or a genuine interface difference.

Investigation needed at implementation time:
- If `ProviderConfig` satisfies `addProvider()` after a type widening, use `Parameters<Synax['addProvider']>[0]` to cast to the expected parameter type
- If the types are genuinely incompatible (config schema differs from runtime schema), add a runtime adapter function that maps config providers to runtime providers
- If it's just a TypeScript structural typing issue (e.g., optional fields), use `satisfies` or explicit type annotation

This is the one unit where the fix depends on inspecting the actual `addProvider` signature — deferred to implementation.

**Test scenarios:**
- Happy path: providers load and register without type errors
- Edge case: empty providers list doesn't error
- Edge case: single provider loads correctly

**Verification:**
- `bunx tsc --noEmit` passes in packages/tui
- No `as any` remains in language.ts
- Language client creation still works

---

- [ ] **Unit 5: Fix generic selector map type in store.ts**

**Goal:** Replace `as unknown` type erasure in TuiStore selector subscriptions with a properly-typed generic pattern.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `packages/tui/src/store.ts`

**Approach:**
The `lastValue: selector(this.state) as unknown` cast at line 81 exists because `selectorSubs` is a `Map<TuiSelector<unknown>, { listeners: ..., lastValue: unknown }>` — a heterogeneous map storing results of different selector types. The `as unknown` is doing type erasure so all selector results can live in one map.

The fix: introduce a `SelectorEntry<T>` interface and use a type-safe wrapper:
- Define `SelectorEntry<T> = { listeners: Set<() => void>; lastValue: T }`
- The map type remains `Map<TuiSelector<unknown>, SelectorEntry<unknown>>` but the `select<T>` method internally creates `SelectorEntry<T>` and stores it with a single `as SelectorEntry<unknown>` cast at the map boundary
- This contains the erasure to one well-defined location (the map set operation) instead of spreading it to the value construction

**Test scenarios:**
- Happy path: selectors return correct values from state
- Integration: selector subscriptions fire on state changes
- Integration: multiple concurrent selectors track independently

**Verification:**
- `bunx tsc --noEmit` passes in packages/tui
- No `as unknown` on `lastValue` construction
- All existing store tests pass

---

- [ ] **Unit 6: Consolidate duplicated formatting functions**

**Goal:** Extract shared tool-summary formatting into `@cortx/sdk` and use it across core and tui packages.

**Requirements:** R2

**Dependencies:** None (can run in parallel with Units 1-5)

**Files:**
- Create: `packages/sdk/src/tool-format.ts`
- Modify: `packages/sdk/src/index.ts` (export the new utility)
- Modify: `packages/core/src/agent.ts` (replace `formatToolProgress` with shared version)
- Modify: `packages/tui/src/store.ts` (replace `formatToolInput` with shared version)
- Modify: `packages/tui/src/components/tool-region.tsx` (replace inline `formatToolSummary` with shared version)
- Test: `packages/sdk/tests/tool-format.test.ts`

**Approach:**
Create `packages/sdk/src/tool-format.ts` with a unified `formatToolSummary(toolName: string, input: unknown, options?: { maxLength?: number }): string` function that:
- Handles all known tool types: `agent`, `bash`, `read`, `write`, `edit`, `grep`
- Has a configurable max length (defaults differ by caller but the function accepts an option)
- Safely parses string input as JSON with fallback

Merge the logic from the three existing functions:
- `formatToolProgress` in `core/src/agent.ts` — short summaries (60 chars)
- `formatToolInput` in `tui/src/store.ts` — longer summaries (100-120 chars) + agent description
- `formatToolSummary` in `tui/src/components/tool-region.tsx` — medium summaries (60-80 chars) + agent description

The unified function should accept an `options` parameter for max length and whether to include agent description detail.

**Test scenarios:**
- Happy path: bash tool returns command excerpt
- Happy path: read/write/edit returns file path
- Happy path: grep returns pattern excerpt
- Happy path: agent returns description + prompt
- Happy path: unknown tool returns empty string or JSON preview
- Edge case: string input that is not valid JSON returns safe fallback
- Edge case: null/undefined input returns empty string
- Edge case: maxLength truncation works correctly

**Verification:**
- All three duplicated functions removed
- Single shared import used across packages
- `bun test` passes across all packages
- No change in TUI rendering output

---

- [ ] **Unit 7: Add error logging in background agent catch**

**Goal:** Log background agent failures instead of silently swallowing them.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `packages/core/src/agent.ts`

**Approach:**
In the background agent IIFE catch block (lines 196-199), add error logging:
- Capture the error parameter: `catch (e)` instead of bare `catch`
- Log via the sub-agent's logger context (pass `ctx.logger` into the IIFE closure, already available)
- Keep the existing completion/error event emission

The foreground path already has error logging in its try/catch (line 215-219). The background path should match that pattern.

**Test scenarios:**
- Error path: background agent that throws logs the error message
- Integration: `agent_completed` event with `isError: true` still fires correctly after logging

**Verification:**
- Background agent catch block captures and logs error
- Existing background agent tests pass

---

- [ ] **Unit 8: Simplify runSubAgentLoop return pattern**

**Goal:** Remove the redundant `SubAgentRunResult` return type from `runSubAgentLoop`.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `packages/core/src/agent.ts`

**Approach:**
`runSubAgentLoop` currently mutates the `session` object in place AND returns a `SubAgentRunResult` with the same fields. The return value is used in both call sites (lines 193, 207). Simplify by:
- Removing the `SubAgentRunResult` interface
- Changing the return type to `void`
- Updating call sites to read from `session` directly (e.g., `result.output` → `session.output`)
- The function already mutates session — making it void-returning makes the mutation contract explicit

**Test scenarios:**
- Integration: foreground agent completes with correct output from session
- Integration: background agent records events and output in session
- Integration: progress reporting still works via callbacks

**Verification:**
- `SubAgentRunResult` interface removed
- Both call sites read from session instead of return value
- All agent tests pass

## System-Wide Impact

- **Interaction graph:** No callbacks, middleware, or observers affected — all changes are local to the modified files
- **Error propagation:** Background agent errors now logged instead of silently swallowed
- **API surface parity:** `formatToolSummary` becomes a shared SDK export — consumers should import from `@cortx/sdk`
- **Unchanged invariants:** Agent loop behavior, event emission order, tool execution semantics all unchanged

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `LanguageMessage` type from external package may have constraints we can't satisfy without casts | Helpers contain the cast in one place rather than spreading it across call sites. If a cast is truly unavoidable, the helper's explicit return type documents the assumption |
| `@synax-ai/core` `addProvider` signature unknown | Unit 4 is intentionally deferred to implementation — inspect at runtime |
| Formatting function merge may subtly change TUI output | Test with maxLength options to match current behavior per call site |

## Deferred to Implementation

- Exact `addProvider` parameter type (Unit 4) — needs runtime inspection of the `@synax-ai/core` package
- Whether `last.content.filter()` works directly on the union-typed array or needs `Array.from()` wrapper (Unit 2) — depends on the exact content type definition
