---
title: feat: TUI Visual Polish and Interaction Enhancement
type: feat
status: active
date: 2026-04-24
origin: docs/brainstorms/2026-04-19-tui-refactor-requirements.md
---

# feat: TUI Visual Polish and Interaction Enhancement

## Overview

Upgrade cortx TUI from functional-but-rough to production-quality terminal experience. Covers visual redesign of input area (removing cluttered ASCII borders, adding activity indicators), wiring the disconnected Markdown/ToolRegion components into layout, implementing thinking-block rendering, diff formatting for file edits, and mouse wheel scrolling in content area. Style target: Claude Code's information density combined with OpenCode's visual quality.

## Problem Frame

The current TUI is architecturally sound (Ink v7, alternate screen, incremental rendering, reactive store) but visually unpolished:

- Input area uses clunky ASCII border decorations (`┌── ❤ idle │ glm-5.1 ──┐`) that add visual noise
- "Waiting for output..." shown when conversation is empty — should be quiet
- Status information is crammed into a dim, hard-to-read line in the input border
- `thinking_delta` events are completely ignored in the store — no reasoning visibility
- `ToolRegion` component exists but is not wired into `AppShell` layout — tool calls render as inline text
- No diff rendering for file edits — changes shown as raw text
- Mouse wheel has no effect — users expect scroll-wheel-to-scroll-content like OpenCode
- `Markdown` component (639 lines of streaming parser + syntax highlighting) exists but is unused — `OutputRegion` does its own plain-text line rendering

## Requirements Trace

From origin `2026-04-19-tui-refactor-requirements.md`:
- R7. Only the region affected by an event redraws
- R9. Incremental markdown rendering with streaming support  
- R10. Code blocks with syntax highlighting
- R11. Supported elements: headings, lists, code, bold, italic, links, blockquotes
- R12. Tool results, errors, and diffs through same pipeline
- R30-iii. `thinking_delta` → collapsible thinking section
- R30-v. `tool_use` → tool call card in tool region
- R30-vii. `tool_result` → result display within tool card

Additional requirements from brainstorm dialogue:
- R31. Input area: clean visual design, no ASCII border decorations
- R32. Activity status shown in input area (e.g. `⏳ Thinking...`, `⚙️ Executing...`)
- R33. Content area supports mouse wheel scrolling (scrolls content, not input)
- R34. Empty content area shows nothing (remove "Waiting for output...")
- R35. File edits rendered as colored diffs (additions/deletions)

## Scope Boundaries

### In Scope
- Input area visual redesign (remove ASCII borders, compact status line, activity indicator)
- Wire `Markdown` component into `OutputRegion` for proper markdown-formatted AI responses
- Wire `ToolRegion` into `AppShell` layout as collapsible section between output and input
- Add thinking buffer to store, render thinking blocks
- Diff formatting for tool results (read/write/edit tool calls)
- Mouse wheel scrolling in content area
- Remove "Waiting for output..." empty state text

### Out of Scope
- Theme system (`tui.theme` extension type reserved but not implemented)
- Multi-session tabs
- Vim/Emacs input modes
- Color customization UI (hardcoded palette is fine)
- Canvas-based or image-based rendering
- Mouse click support (scroll wheel only)
- The markdown-plugin.ts refactoring — keep as extension placeholder, actual rendering lives in components

### Deferred to Separate Tasks
- Thinking block expand/collapse toggle via keyboard — future keybinding
- Syntax highlighting theme selection — future
- Drag-to-resize regions — future

## Context & Research

### Relevant Code and Patterns

- `packages/tui/src/store.ts` — TuiStore class, selector-based reactive state. All new state slices follow this pattern.
- `packages/tui/src/components/app-shell.tsx` — Layout container. ToolRegion and any new section go here.
- `packages/tui/src/components/output-region.tsx` — Message display pipeline. `flattenToLines()` is the function that needs to use `Markdown` component instead of plain text.
- `packages/tui/src/components/input-area.tsx` — Input + status bar. The redesign target.
- `packages/tui/src/components/markdown.tsx` — Full streaming markdown renderer (639 lines), wired but unused by OutputRegion.
- `packages/tui/src/components/tool-region.tsx` — Collapsible tool call panel, wired but not in layout.
- `packages/tui/src/types/tui-state.ts` — `TuiState` type definition. Needs `currentThinking` field.
- `packages/tui/src/cli.tsx` — Ink `render()` call. Mouse option configuration point.

**State subscription pattern** (every component must follow this):
```typescript
const value = useSyncExternalStore(
  useCallback((listener) => store.select((s) => s.someSlice).subscribe(listener), [store]),
  useCallback(() => store.select((s) => s.someSlice).get(), [store]),
);
```

### Institutional Learnings

- **Single `useInput` ownership**: InputArea is the sole owner of Ctrl+C and global keys. Never duplicate handlers across components. (From P0 fix in `2026-04-19-003-fix-tui-review-findings-plan.md`)
- **Never put mutable state in `useMemo` deps**: Registry must be stable across UI interactions. Use refs for ephemeral data like sessionList. (From P1 fix)
- **Pre-flatten to uniform lines for virtual scroll**: `flattenToLines()` converts variable-height content to uniform lines before computing viewport offset. (From `2026-04-21-005-feat-fullscreen-tui-ink-v7-plan.md`)
- **`setInterval` always needs `dispose()`**: Any new timers (spinner animation) must clean up. (From P1 fix)
- **Verify pipelines are actually wired**: The `processEvent()` was dead code for weeks. Always check. (From P1 fix)

### External References

- Ink v7 docs: `useInput` supports mouse events with `key.mouse` field
- Goose TUI (`/Users/illuxiza/Gitwork/tools/goose/ui/text/src/app.tsx`): Reference pattern for color palette as named constants, single `useInput` entry point
- Claude Code TUI: Activity indicators (⏳ Thinking... / ⚙️ Executing...), collapsible thinking blocks, compact status bar
- OpenCode TUI: Mouse wheel scrolling in content area, clean separator-based layout

## Key Technical Decisions

1. **Wire Markdown into OutputRegion, don't replace it**: Keep OutputRegion's virtual scroll + message routing logic, but have assistant messages use the `<Markdown>` component for rendering instead of plain `<Text>`. User messages and tool headers keep their current colored styling. This preserves the scroll viewport while upgrading content quality.

2. **Thinking as a separate message slice**: Add `currentThinking: string` to `messages` in `TuiState`. `thinking_delta` events append to it; `thinking` events finalize it. Thinking is stored alongside turns but rendered as a visually distinct collapsible block, not a regular message.

3. **ToolRegion as a persistent collapsible section**: Insert `ToolRegion` between OutputRegion and InputArea in AppShell. Show collapsed by default (1 line: icon + latest tool). Expand on keyboard toggle (`Shift+T`). Remove inline tool rendering from OutputRegion's `flattenToLines()`.

4. **Activity indicator in InputArea header**: Replace `┌── ❤ idle │ glm-5.1 ──┐` with a single-line activity bar. When running: `⏳ Thinking...  │  glm-5.1  │  iter: 3`. When tool executing: `⚙️ Running bash...  │  glm-5.1`. When idle: `✓ Ready  │  glm-5.1  │  tokens: 1.2k+450`. This is inspired by Claude Code's pattern.

5. **Mouse wheel via terminal raw mode**: Ink's `useInput` has limited mouse support. For scroll wheel, enable SGR mouse tracking (`\x1b[?1003h`) on stdin, parse scroll events in a `useEffect` with raw mode listener. This approach works independently of Ink's React reconciler and won't interfere with keyboard `useInput` handlers.

6. **Diff rendering as a utility function**: Create a pure `renderDiff(oldText, newText): string` utility using line-level comparison with `+`/`-` prefixes. Color-add additions green, deletions red. Use for read/write/edit tool results. Simple enough to build without a diff library dependency.

## Open Questions

### Resolved During Planning

- *Markdown in OutputRegion vs line-by-line?* → Wire the `<Markdown>` component for assistant text, keep colored styling for user/tool.
- *ToolRegion: persistent or overlay?* → Persistent collapsible section between output and input.
- *Mouse scroll: Ink built-in or raw mode?* → Raw mode SGR mouse tracking for reliability.
- *Status bar location?* → Input area header, not separate top bar.

### Deferred to Implementation

- *Exact mouse escape sequence parsing*: Depends on terminal emulator behavior; capture a few scroll events and reverse-engineer the sequence format.
- *Mouse tracking enable/disable lifecycle*: Whether to enable once at startup or toggle only when needed.
- *Diff granularity*: Line-level vs word-level highlighting. Start with line-level, upgrade if visual quality is insufficient.
- *ToolRegion max height when expanded*: Depends on screen real estate; likely 25-30% of viewport.
- *Spinner animation interval*: 100ms or 250ms — depends on visual feel. Start with 250ms.

## High-Level Technical Design

### Layout After Changes

```
┌────────────────────────────────────────┐
│                                        │
│  Output Region (flexGrow=1)            │
│  - Markdown-rendered AI responses      │
│  - Thinking blocks (collapsible)       │
│  - Colored user messages               │
│  - Virtual scroll via mouse/keyboard   │
│                                        │
├────────────────────────────────────────┤
│  Tool Region (collapsible)             │
│  ⚙️ bash: npm run test  [3 tools]    │  ← collapsed (1 line)
│  ─ OR ─                                │
│  ✓ bash: npm test                      │  ← expanded (multiple lines)
│    > 15 passing, 0 failing             │
│  ✓ read: src/file.ts                   │
│  ✓ write: src/file.ts [+12 -3]         │
│    + added line                         │  ← diff rendering
│    - removed line                       │
├────────────────────────────────────────┤
│  ⏳ Thinking...  │  glm-5.1  │  iter 3 │  ← activity indicator
│  > user types here _                    │  ← input prompt
│  Ctrl+K palette │ Ctrl+E editor │ ...  │  ← help line
└────────────────────────────────────────┘
```

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### State Shape Addition

```
TuiState.messages.currentThinking: string  // streaming thinking buffer
```

### Mouse Event Flow

```
process.stdin (raw mode, SGR tracking)
  → parse escape sequence (scroll up/down + amount)
  → store.scrollUp(n) / store.scrollDown(n)
  → selector notification → OutputRegion re-render
```

## Implementation Units

- [ ] **Unit 1: Store — Add thinking buffer**

**Goal:** Add `currentThinking` to state and handle `thinking_delta` / `thinking` events.

**Requirements:** R30-iii

**Dependencies:** None

**Files:**
- Modify: `packages/tui/src/types/tui-state.ts`
- Modify: `packages/tui/src/store.ts`
- Test: `packages/tui/src/__tests__/store.test.ts`

**Approach:**
- Add `currentThinking: string` to `TuiState.messages` (alongside `turns` and `currentText`)
- In `store.dispatch()`: `thinking_delta` appends to `messages.currentThinking`; `thinking` replaces with finalized content; `turn_start` resets `currentThinking` to `''`
- Follow exact same pattern as `text_delta` / `text` handling for consistency

**Patterns to follow:**
- `packages/tui/src/store.ts` lines 143-152 (text_delta handler)
- `packages/tui/src/types/tui-state.ts` messages field

**Test scenarios:**
- Happy path: `thinking_delta` events accumulate into `currentThinking`
- Happy path: `thinking` event replaces `currentThinking` with finalized content
- Happy path: `turn_start` resets `currentThinking` to empty string
- Edge case: `thinking_delta` with empty string (no-op)
- Edge case: Multiple `thinking_delta` events without a `thinking` event — should still accumulate
- Integration: `turn_start` persists any non-empty `currentThinking` as part of the previous turn

**Verification:**
- Store tests pass: `thinking_delta` accumulation, `thinking` finalization, `turn_start` reset
- Existing store tests continue to pass (no regression in text_delta/text handling)

---

- [ ] **Unit 2: Input Area — Visual Redesign**

**Goal:** Replace cluttered ASCII border with clean activity indicator + compact status line. Add activity state display.

**Requirements:** R31, R32, R34

**Dependencies:** None

**Files:**
- Modify: `packages/tui/src/components/input-area.tsx`
- Test: `packages/tui/src/__tests__/input.test.ts`

**Approach:**
- Replace `┌── ❤ idle │ glm-5.1 ──┐` / `└──┘` border with a single thin separator line (Unicode `─` repeated) above the input area
- Add a compact activity status line between separator and prompt:
  - Running: `⏳ Thinking... │ {model} │ iter: {n}`
  - Tool executing: `⚙️ {toolName} │ {model} │ {elapsed}s`
  - Idle: `✓ Ready │ {model} │ tokens: {in}+{out} │ {total}s`
- Keep input prompt `> _` and help line, but make help line more compact
- Remove the `getBorderColor()` / `getStatusIcon()` helpers or simplify them
- Keep Heart icon (❤️ idle) only as a tiny prefix — replace with ✓ for cleanliness
- Subscribe to store's `toolCalls` to detect tool-executing state for activity display

**Activity state derivation** (pure function, exported for testing):
```typescript
type ActivityState = 'idle' | 'thinking' | 'executing' | 'interrupting' | 'error';
function deriveActivity(status, toolCalls, currentThinking): ActivityState
```
- `running` + no tool calls → 'thinking' (agent is reasoning)
- `running` + pending tool calls → 'executing' (show latest tool name)
- `interrupting` → 'interrupting'
- `error` → 'error'
- `idle` → 'idle'

**Patterns to follow:**
- Goose TUI color palette as named constants pattern
- Claude Code activity indicator design

**Test scenarios:**
- Happy path: idle status shows "✓ Ready | model | tokens | elapsed"
- Happy path: running with no tools shows "⏳ Thinking... | model | iter: N"
- Happy path: running with tool shows "⚙️ {toolName} | model | {elapsed}s"
- Happy path: interrupting shows "⏹ Interrupting..."
- Happy path: error shows "✗ {error message}"
- Edge case: transitioning from running to idle clears activity indicator
- Edge case: empty input shows prompt with cursor
- Edge case: help line renders correctly with keyboard shortcuts
- Integration: `Ctrl+C` during running sets interrupting status, activity indicator updates

**Verification:**
- Input area renders without ASCII border decorations
- Activity indicator correctly reflects all 5 states
- Existing input tests (history, Ctrl+C state machine, editor handoff) continue to pass

---

- [ ] **Unit 3: Output Region — Wire Markdown Renderer + Thinking Blocks**

**Goal:** Replace plain-text assistant message rendering with the existing `Markdown` component. Add thinking block display. Remove "Waiting for output...".

**Requirements:** R7, R9, R10, R11, R12, R30-iii, R34

**Dependencies:** Unit 1 (thinking buffer in store)

**Files:**
- Modify: `packages/tui/src/components/output-region.tsx`
- Modify: `packages/tui/src/components/markdown.tsx` (add ThinkingBlock support if needed)
- Test: `packages/tui/src/__tests__/output-region.test.ts`

**Approach:**
- Refactor `OutputRegion` to use `<Markdown>` component for assistant message content instead of `<Text>{line.text}</Text>`
- User messages keep their `color="cyan" bold` styling
- Tool messages (headers/results) keep their current colored styling until Unit 4 moves them out
- Add `ThinkingBlock` inline component: shows `▶ Thinking...` (collapsed, dim) or the full thinking text (expanded, dim italic). Default collapsed.
- Thinking text is rendered through the Markdown component too (thinking content may contain markdown)
- Remove the "Waiting for output..." empty state text — render nothing when `totalLines === 0`
- `flattenToLines()` needs to interleave thinking blocks into the output line stream

**Revised flattenToLines logic:**
1. Iterate through `turns` array
2. For each assistant turn with associated thinking, emit a `thinking` type line (or render ThinkingBlock component)
3. For assistant text, pass through Markdown component instead of splitting to lines
4. User messages: split to lines with cyan bold
5. Tool entries: current behavior preserved until Unit 4

> The thinking-to-turn association: thinking is captured during the `running` phase before the first tool call or assistant text. When `turn_start` fires, any accumulated thinking belongs to the previous turn. The store should optionally store a `thinking` field on `TurnEntry`. This is a deferred implementation decision — start simple by rendering thinking as an inline block before the assistant text.

**Patterns to follow:**
- `packages/tui/src/components/markdown.tsx` — existing Markdown component API
- `packages/tui/src/components/output-region.tsx` — existing virtual scroll + `flattenToLines()` pattern

**Test scenarios:**
- Happy path: plain text assistant message renders through Markdown component
- Happy path: markdown with code blocks renders with syntax highlighting
- Happy path: markdown with lists/headings renders formatted
- Happy path: thinking text displays as collapsed "▶ Thinking..." by default
- Happy path: empty conversation renders nothing (no "Waiting for output...")
- Edge case: streaming partial markdown (unclosed code fence) renders correctly
- Edge case: very long assistant message — scroll viewport still works
- Edge case: consecutive thinking blocks from multiple turns
- Integration: thinking_delta events → store → OutputRegion re-render within the same turn

**Verification:**
- Markdown rendering visible in output (code blocks highlighted, lists indented, headings bold)
- No "Waiting for output..." text shown on empty conversation
- Thinking blocks appear when agent emits thinking_delta events
- Virtual scroll (PageUp/PageDown/Shift+J/Shift+K) continues to work

---

- [ ] **Unit 4: Tool Region — Wire into Layout**

**Goal:** Add `ToolRegion` as a persistent collapsible section in AppShell. Remove inline tool rendering from OutputRegion.

**Requirements:** R30-v, R30-vii

**Dependencies:** Unit 3 (so we don't conflict on OutputRegion changes)

**Files:**
- Modify: `packages/tui/src/components/app-shell.tsx`
- Modify: `packages/tui/src/components/tool-region.tsx`
- Modify: `packages/tui/src/components/output-region.tsx`
- Test: `packages/tui/src/__tests__/output-region.test.ts`

**Approach:**
- Insert `<ToolRegion store={store} collapsed={!toolExpanded} />` between OutputRegion and InputArea in AppShell
- Add `toolExpanded` state to AppShell (default false)
- Toggle with `Shift+T` keybinding in AppShell's `useInput` (when no overlay active)
- Remove tool-header/tool-result type handling from `OutputRegion.flattenToLines()` — tool entries are no longer emitted as inline lines
- `ToolRegion` already handles collapsed/expanded states correctly via `collapsed` prop
- When collapsed: 1 line showing latest tool (icon + name + count badge)
- When expanded: full list with tool names and results (truncated to 200 chars currently, keep that)
- Consider a reasonable max height for expanded tool region (e.g. `Math.min(10, toolCalls.size * 3)` lines) so it doesn't consume the whole screen

**Patterns to follow:**
- `packages/tui/src/components/tool-region.tsx` — existing component, already has collapsed/expanded modes
- AppShell's existing scroll keybinding pattern for adding `Shift+T` toggle

**Test scenarios:**
- Happy path: tool calls appear in ToolRegion, not in OutputRegion
- Happy path: collapsed mode shows 1-line summary (latest tool icon + name + count)
- Happy path: expanded mode shows all tools with names and truncated results
- Happy path: `Shift+T` toggles between collapsed and expanded
- Edge case: no tool calls → ToolRegion renders null (no empty space consumed)
- Edge case: multiple concurrent tools → count badge shows "2/3 running"
- Edge case: tool error → error tool shown with ✗ icon in red
- Integration: ToolRegion is not active during session picker or command palette overlays

**Verification:**
- ToolRegion visible in layout between content and input area
- Tool calls not duplicated in OutputRegion
- Toggle with Shift+T works
- No layout shift or height jump when ToolRegion appears/disappears

---

- [ ] **Unit 5: Diff Rendering**

**Goal:** Render file edits as colored diffs in tool results. Green for additions, red for deletions.

**Requirements:** R35, R12

**Dependencies:** Unit 4 (diffs appear in tool results, now rendered in ToolRegion)

**Files:**
- Create: `packages/tui/src/components/diff.tsx`
- Modify: `packages/tui/src/components/tool-region.tsx`
- Test: `packages/tui/src/__tests__/diff.test.ts`

**Approach:**
- Create a pure `DiffView({ oldText, newText })` Ink component
- Use a simple line-level diff algorithm: split both inputs by `\n`, compare lines, mark added/removed/changed lines
- Render with ANSI color coding:
  - Added lines: green background or green `+` prefix with green text
  - Removed lines: red background or red `-` prefix with red text
  - Context lines: dim, no prefix
- Apply diff rendering to tool results from `read`, `write`, `edit` tool calls (detect by toolName)
- For `write`: show full file diff (empty → new content, or old content → new content)
- For `edit`: show the changed section with surrounding context
- For `read`: no diff needed (just file contents), but can show with syntax highlighting via cli-highlight
- No external diff library — a simple LCS or Myers-like line diff is sufficient and avoids dependency overhead. If implementation reveals this is more complex than expected, defer to a lightweight library like `diff`.

**Patterns to follow:**
- `packages/tui/src/components/markdown.tsx` — `CodeBlockWithHighlight` rendering pattern
- Tool result display in `tool-region.tsx` — result truncation pattern

**Test scenarios:**
- Happy path: file with additions only → lines show green `+` prefix
- Happy path: file with deletions only → lines show red `-` prefix
- Happy path: file with both additions and deletions → mixed colors
- Happy path: unchanged file → all lines dim (or single "No changes")
- Edge case: empty old content (new file) → all lines as additions
- Edge case: empty new content (file deleted) → all lines as deletions
- Edge case: very long diff (>200 lines) → truncated with "... N more lines" indicator
- Edge case: single character change on a long line → shows line as change

**Verification:**
- Diff output visible in ToolRegion for file-editing tools
- Colors clearly distinguish additions (green) from deletions (red)
- Non-file tool results unaffected

---

- [ ] **Unit 6: Mouse Wheel Scrolling**

**Goal:** Mouse wheel in content area scrolls conversation history, not input.

**Requirements:** R33

**Dependencies:** None

**Files:**
- Modify: `packages/tui/src/cli.tsx`
- Modify: `packages/tui/src/components/app-shell.tsx`
- Test: `packages/tui/src/__tests__/integration.test.ts`

**Approach:**
- Enable SGR mouse tracking mode on stdin: emit `\x1b[?1003h\x1b[?1006h` on mount, `\x1b[?1003l\x1b[?1006l` on unmount
- Register a `data` listener on `process.stdin` to capture mouse escape sequences
- Parse SGR mouse sequences (format: `\x1b[<{button};{x};{y}{action}`) where button 64 = scroll up, 65 = scroll down
- Map scroll events: scroll up → `store.scrollUp(3)`, scroll down → `store.scrollDown(3)`
- Scroll events are only handled when no overlay (palette/session picker) is active
- Add a `mouseEnabled` option to the store or pass via prop to control this
- This runs outside Ink's React reconciler — pure stdin event handling — so it won't cause re-renders except through the normal store notification path

**Important constraint:** Mouse tracking escape sequences are interleaved with normal stdin data. The listener must buffer input and only process complete SGR sequences (delimited by `m` or `M`). Non-mouse data is ignored (Ink handles keyboard via its own mechanism).

**Patterns to follow:**
- `packages/tui/src/store.ts` — `scrollUp(n)` / `scrollDown(n)` methods
- AppShell scroll keybinding pattern — same scroll methods, different trigger

**Test scenarios:**
- Happy path: scroll up event → content scrolls up by 3 lines
- Happy path: scroll down event → content scrolls down by 3 lines
- Happy path: scroll to bottom → autoFollow re-enables
- Edge case: scroll when at top → offset clamped at 0
- Edge case: scroll when at bottom with autoFollow → autoFollow disables on scroll up
- Edge case: scroll events ignored when command palette is open
- Edge case: scroll events ignored when session picker is open
- Edge case: rapid scroll events → no backlog or lag (throttle if needed)
- Integration: mouse tracking disabled on TUI exit (escape sequence sent)
- Edge case: terminal doesn't support SGR mouse mode → graceful fallback, no crash

**Verification:**
- Mouse wheel scrolls content area up/down
- Input area stays fixed
- Keyboard scrolling (PageUp/PageDown) still works
- No interference with normal keyboard input
- Exiting TUI restores terminal mouse mode

---

- [ ] **Unit 7: Final Polish — Visual Consistency Pass**

**Goal:** Ensure consistent color usage, spacing, and visual hierarchy across all components.

**Requirements:** R31, R32

**Dependencies:** Units 1-6

**Files:**
- Modify: `packages/tui/src/components/input-area.tsx`
- Modify: `packages/tui/src/components/output-region.tsx`
- Modify: `packages/tui/src/components/tool-region.tsx`
- Modify: `packages/tui/src/components/markdown.tsx`
- Modify: `packages/tui/src/components/command-palette.tsx`
- Modify: `packages/tui/src/components/session-picker.tsx`
- Test: `packages/tui/src/__tests__/integration.test.ts`

**Approach:**
- Audit all components for color consistency — same colors for same semantics
- Extract a `colors` object literal (not a theme system) to co-locate color definitions:
  ```typescript
  const colors = {
    userMessage: 'cyan',
    assistantText: undefined, // default
    toolSuccess: 'green',
    toolPending: 'yellow',
    toolError: 'red',
    activityThinking: 'yellow',
    activityExecuting: 'cyan',
    activityIdle: 'green',
    activityError: 'red',
    border: 'gray',
    dimText: 'dimColor',
    prompt: 'green',
    diffAdd: 'green',
    diffRemove: 'red',
    link: 'cyan',
    inlineCode: 'white',
    inlineCodeBg: 'gray',
  } as const;
  ```
- Ensure consistent padding and margin across regions
- Thin separator between regions (Unicode `─` repeated to terminal width)
- Verify layout doesn't break at minimum terminal size (80x24)

**Test scenarios:**
- Happy path: all components render with consistent colors at 80x24
- Happy path: all components render correctly at 120x40
- Edge case: resize from large to small terminal → layout adjusts
- Edge case: rapid status transitions → no visual flicker
- Integration: full conversation flow (user input → thinking → tool execution → response) renders cleanly

**Verification:**
- Visual inspection: consistent colored borders, no mixed-style elements
- No layout breakage at standard terminal sizes
- All existing tests pass (no regression from earlier units)

## System-Wide Impact

- **Interaction graph:** Changes touch the full vertical stack — store (Unit 1), output rendering (Unit 3), layout (Unit 4), input (Unit 2), and stdin handling (Unit 6). Each unit is independently testable but Units 3-7 are sequenced to avoid merge conflicts.
- **Error propagation:** Mouse tracking failure must not crash the TUI. Wrapped in try/catch with fallback to log.
- **State lifecycle risks:** New `currentThinking` field must be properly reset on `turn_start` and serialized/deserialized in session persistence (auto-save and session restore).
- **API surface parity:** The TUI plugin extension system (`TuiRegistry`, `tui.renderer`, `tui.region`) is unaffected — all changes are in core components, not extension points.
- **Integration coverage:** End-to-end test: full agent turn with thinking → tool execution → markdown response → session save → restore. The `integration.test.ts` should cover this flow.
- **Unchanged invariants:** `CortxSession` API, `AgentEvent` types, plugin extension type constants, command registration pattern, session persistence format (adds optional `thinking` field, backward-compatible), virtual scroll state management.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Markdown component may have edge cases when handling very long streaming content | Existing `parseMarkdown` handles unclosed fences; integration test with 5000+ character streaming content |
| SGR mouse tracking may not work in all terminals (tmux, screen, Windows Terminal, VS Code terminal) | Graceful fallback — if mouse sequence parsing fails, mouse scrolling simply doesn't work but keyboard scrolling does. No crash. |
| ToolRegion height management in expanded mode | Cap expanded height at `Math.min(10, viewportHeight * 0.3)` lines |
| Diff rendering may be slow for large files | Truncate diff output to 200 lines; show "Diff truncated" indicator |
| Thinking block/turn association may be ambiguous | Start with simple approach: thinking before first text in turn. Refine if needed. |

## Sources & References

- **Origin document:** `docs/brainstorms/2026-04-19-tui-refactor-requirements.md`
- Related code: `packages/tui/src/store.ts` (TuiStore), `packages/tui/src/components/markdown.tsx` (Markdown renderer), `packages/tui/src/components/tool-region.tsx` (Tool call panel)
- Related plans: `docs/plans/2026-04-21-005-feat-fullscreen-tui-ink-v7-plan.md`, `docs/plans/2026-04-19-003-fix-tui-review-findings-plan.md`
- Reference: Goose TUI at `/Users/illuxiza/Gitwork/tools/goose/ui/text/src/app.tsx`
