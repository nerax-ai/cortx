---
title: "feat: Full-Screen TUI with Ink v7 and Virtual Scroll"
type: feat
status: active
date: 2026-04-21
origin: docs/brainstorms/2026-04-21-fullscreen-tui-ink-v7-requirements.md
---

# feat: Full-Screen TUI with Ink v7 and Virtual Scroll

## Overview

Upgrade the TUI from Ink v5 to v7, enable alternate screen buffer rendering, add incremental rendering to eliminate flicker, and implement a virtual scroll viewport so users can scroll through conversation history in full-screen mode.

## Problem Frame

The TUI renders incrementally in the primary terminal buffer. Rapid content updates cause visual glitches, layout jumps, and broken display. User input messages disappear into scrollback. The alternate screen buffer (like vim/htop) eliminates these problems, but requires in-app virtual scrolling since terminal native scrollback is disabled.

(see origin: docs/brainstorms/2026-04-21-fullscreen-tui-ink-v7-requirements.md)

## Requirements Trace

- R1. TUI renders in alternate screen buffer; exiting restores terminal state
- R2. No visual glitches during streaming, tool results, or status changes
- R3. Layout reflows correctly on terminal resize
- R4. User messages visible in conversation output
- R5. All existing functionality preserved (palette, commands, session restore, input)
- R6. Users can scroll conversation history with PageUp/PageDown and j/k keys; auto-scrolls to bottom on new content

## Scope Boundaries

- No visual redesign — same layout, proper rendering
- No multi-pane split views
- No mouse support
- No color theme system

## Context & Research

### Relevant Code and Patterns

- `packages/tui/src/cli.tsx` — Ink `render()` entry point (currently v5, no `alternateScreen`)
- `packages/tui/src/components/output-region.tsx` — Linear rendering of turns + tools + streaming text, no virtualization
- `packages/tui/src/components/input-area.tsx` — Input handling with `useInput`, no PageUp/PageDown bindings
- `packages/tui/src/store.ts` — State management with selector subscriptions, turns stored as flat array
- `packages/tui/src/components/app-shell.tsx` — Top-level layout, palette/session overlays

### External References

- Ink v7: `alternateScreen`, `incrementalRendering`, `useWindowSize()` — verified in `/tmp/ink-test2/node_modules/ink/`
- Ink v7 requires React 19 (`react >=19.2.0` peer dep)
- opencode uses `@opentui/solid` for its full-screen TUI (different framework, same concept)

## Key Technical Decisions

- **Upgrade path: Ink v5 → v7 (skip v6)** — v7 is the latest with all needed features. No reason to stop at v6.
- **React 18 → 19** — Required by Ink v7. Only TUI package uses React. `useSyncExternalStore` works identically.
- **Custom virtual scroll over third-party** — The output region has variable-height content (Markdown, tool results). Third-party Ink scroll libraries assume uniform-height items. A custom offset + slice approach gives us control over variable heights and is simpler than adapting a library.
- **Scroll mode vs input mode** — Need a mode toggle: when focused on output (scroll mode), j/k/PageUp/PageDown scroll. When focused on input, those keys type. Use a focus state or modifier key (e.g., Shift+PageUp for scroll) to avoid mode confusion.

## Open Questions

### Deferred to Implementation

- **Scroll keybinding design**: Shift+PageUp/PageDown vs separate scroll mode toggle vs Esc to enter scroll mode. Decide during implementation based on what feels natural.
- **Variable-height line calculation**: Flatten rendered content into lines array and count, or pre-measure with Ink's `measureElement`. Try simple flatten-first approach.

## Implementation Units

- [ ] **Unit 1: Upgrade Ink and React versions**

**Goal:** Bump Ink to v7 and React to 19, fix any compatibility issues, verify existing tests pass.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `packages/tui/package.json` — update `ink` and `react` versions
- Modify: `packages/tui/package.json` — update `@types/react` to v19

**Approach:**
- Update `ink` to `^7.0.1`, `react` to `^19.1.0`, `@types/react` to `^19.x`
- Run `bun install` to resolve
- Run existing tests to verify no API breakage
- Fix any import or type changes needed

**Patterns to follow:** Existing package.json dependency patterns

**Test scenarios:**
- Happy path: `bun test` passes with all 384+ tests after upgrade
- Edge case: `bun run packages/tui/src/cli.tsx` starts without errors

**Verification:** All tests pass, TUI starts and renders basic output

---

- [ ] **Unit 2: Enable alternate screen and incremental rendering**

**Goal:** Enable Ink v7's `alternateScreen` and `incrementalRendering` in the render call, add `useWindowSize()` for resize-aware layout.

**Requirements:** R1, R2, R3

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/tui/src/cli.tsx` — add render options

**Approach:**
- Add `alternateScreen: true` and `incrementalRendering: true` to `render()` options
- Add `useWindowSize()` in `app-shell.tsx` to get terminal dimensions
- Pass `rows` down to OutputRegion for viewport height calculation
- Test that exiting TUI (Ctrl+C twice, or `/exit`) restores terminal content

**Patterns to follow:** Ink v7 render API from `/tmp/ink-test2/node_modules/ink/build/render.js`

**Test scenarios:**
- Happy path: TUI opens in alternate screen, exit restores terminal
- Happy path: Terminal resize reflows layout without corruption
- Edge case: Rapid content updates don't cause flicker

**Verification:** TUI runs in alternate screen buffer; no visible glitches during streaming; exit restores terminal

---

- [ ] **Unit 3: Add user messages to output and fix output region rendering**

**Goal:** Ensure user input appears in the output region as cyan `> message` lines, and all content (user, assistant, tools) renders cleanly.

**Requirements:** R4

**Dependencies:** Unit 2

**Files:**
- Modify: `packages/tui/src/store.ts` — `addUserMessage()` method (already added in prior work)
- Modify: `packages/tui/src/app.tsx` — call `store.addUserMessage(value)` in handleSubmit (already added)
- Modify: `packages/tui/src/components/output-region.tsx` — render user turns with cyan styling (already done)

**Approach:**
- Verify the user message display from prior session works with Ink v7
- Test that user messages, assistant text, and tool calls all render without overlap or duplication

**Patterns to follow:** Current output-region.tsx linear rendering

**Test scenarios:**
- Happy path: User types "hello" and sees `> hello` in cyan above the response
- Happy path: `/ce:ideate` shows skill invocation and tool calls in order
- Edge case: Empty input is not displayed

**Verification:** User messages visible in output; tool calls display correctly; no content duplication

---

- [ ] **Unit 4: Virtual scroll viewport for output region**

**Goal:** Implement a scrollable output region that tracks scroll offset and renders only the visible window of content. PageUp/PageDown and j/k scroll through history; auto-scrolls to bottom when new content arrives.

**Requirements:** R6

**Dependencies:** Unit 2, Unit 3

**Files:**
- Modify: `packages/tui/src/components/output-region.tsx` — add scroll state and viewport logic
- Modify: `packages/tui/src/components/input-area.tsx` — bind PageUp/PageDown/Shift+j/k for scroll
- Modify: `packages/tui/src/components/app-shell.tsx` — pass scroll state between input and output
- Test: `packages/tui/src/__tests__/output-region.test.ts` (new — scroll logic tests)
- Test: `packages/tui/src/__tests__/store.test.ts` — verify scroll state in store

**Approach:**
- Add `scrollOffset` and `autoFollow` state to the store or a shared ref
- Flatten all content (turns + tool calls + streaming text) into a lines array
- Compute visible window: `lines.slice(scrollOffset, scrollOffset + viewportHeight)`
- Render visible window inside a `<Box height={viewportHeight}>` container
- When `autoFollow` is true and new content arrives, scroll to bottom
- User scrolls up → `autoFollow = false`; new content arrives while scrolled up → show "new content" indicator; user scrolls to bottom → `autoFollow = true`
- Bind scroll keys in input-area or app-shell: PageUp/PageDown adjust scrollOffset; Shift+j/k for line-by-line scroll

**Execution note:** Test the scroll offset calculation logic as a pure function before integrating with the component.

**Technical design:** Scroll state management — directional guidance, not implementation specification:

```
ScrollState = { offset: number, autoFollow: boolean }
lines = flattenAllContent(turns, toolCalls, currentText)
viewportHeight = rows - inputAreaHeight - statusBarHeight
visibleLines = lines.slice(offset, Math.min(offset + viewportHeight, lines.length))
```

**Patterns to follow:** Store's selector-based subscription pattern

**Test scenarios:**
- Happy path: PageUp scrolls up; PageDown scrolls down; content updates correctly
- Happy path: New content auto-scrolls to bottom when `autoFollow` is true
- Edge case: Scrolling up stops auto-follow; scrolling back to bottom re-enables it
- Edge case: Scroll offset clamped to [0, max(0, totalLines - viewportHeight)]
- Edge case: Empty content — no scroll, "Waiting for output..." shown
- Edge case: Content shorter than viewport — no scroll needed, all content visible

**Verification:** PageUp/PageDown scrolls through history; new content auto-follows; j/k line scroll works

## System-Wide Impact

- **Interaction graph:** All TUI components affected by new viewport height calculation. Input area and output region need coordinated key handling for scroll vs input mode.
- **State lifecycle risks:** Scroll state must sync with content updates — new turns must update total line count and possibly auto-scroll.
- **Unchanged invariants:** Core agent loop, skill system, plugin registry — none of these change. Only the TUI rendering layer.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Ink v7 API incompatibility with current code | Upgrade first, run tests before adding features |
| Variable-height content breaks line-count scroll | Flatten to character lines; if needed, use fixed-width wrapping |
| React 19 breaks `useSyncExternalStore` | Already available since React 18 — verify during upgrade |
| Scroll key conflicts with input (j/k typing vs scrolling) | Use Shift modifier or separate scroll mode — decide in implementation |

## Sources & References

- **Origin document:** docs/brainstorms/2026-04-21-fullscreen-tui-ink-v7-requirements.md
- Ink v7 API: verified in `/tmp/ink-test2/node_modules/ink/build/`
- opencode TUI: `/Users/illuxiza/Gitwork/tools/opencode/packages/opencode/` (uses `@opentui/solid`)
