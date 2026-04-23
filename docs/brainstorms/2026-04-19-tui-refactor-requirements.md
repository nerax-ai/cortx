---
date: 2026-04-19
topic: tui-refactor
---

# Cortx TUI Refactoring

## Problem Frame

Cortx's CLI is an 88-line `cli.ts` using readline + raw stdout. This limits the product to single-line input, no interrupt capability during agent execution, no rich formatting, and no extensibility. Users lose conversations on exit, commands are hardcoded in an if-else chain, and markdown dumps to the terminal unrendered.

The refactoring replaces this minimal CLI with a full Ink-based TUI built as an extensible platform — where every built-in feature (markdown, status bar, tool panel, session management) is a first-party plugin using the same `@nerax-ai/plugin` registry that third-party plugins will use.

## Layout

```
┌──────────────────────────────────────────┐
│  Header: model · cwd · iteration          │
├──────────────────────────────────────────┤
│                                          │
│  Output Region                           │
│  (streaming markdown from text_delta)    │
│                                          │
├──────────────────────────────────────────┤
│  Tool Region                             │
│  (tool_use calls + tool_result output)   │
├──────────────────────────────────────────┤
│  Status: tokens · elapsed · status       │
├──────────────────────────────────────────┤
│  > Input area (multi-line, with editing) │
└──────────────────────────────────────────┘

Overlays (activated by key/command):
  - Command Palette (Ctrl+K or /)
  - Help Dialog
  - Confirmation Prompt
  - Session Picker (/resume)
```

## Requirements

**Plugin Extension System**

- R1. TUI extensions use the existing `@nerax-ai/plugin` registry with distinct extension types, separate from agent-level hooks in `CortxPlugin`
- R2. Extension types: `tui.command`, `tui.region`, `tui.renderer`, `tui.keybind` (future: `tui.theme` — reserved but out of scope for v1)
- R3. All built-in visual features (markdown, status bar, tool panel, session, command palette) are registered as first-party plugins via `ctx.register()` — validating the extension API from day one
- R4. TUI plugins share the same loading mechanism (npm, GitHub, local, inline) and lifecycle (`setup`/`teardown`) as agent plugins
- R4a. Plugin failures are isolated — a throwing renderer or command handler logs the error and continues; it does not crash the TUI

**Region-Based Layout**

- R5. Four fixed core regions: **output** (streaming text), **tools** (call/result pairs), **status** (one-line bar: model, iteration, tokens, elapsed), **input** (multi-line editor)
- R6. Plugin overlays: modal layers rendered on top of the fixed layout — command palette, help dialog, confirmation prompts, session picker
- R7. Only the region affected by an event redraws — `text_delta` triggers output region only, `tool_use`/`tool_result` triggers tool region only, `done`/`turn_start` triggers status bar only
- R8. Terminal resize is handled gracefully — regions adapt to the new width/height

**Streaming Markdown Renderer**

- R9. Incremental rendering: `text_delta` events are parsed as markdown in real-time, showing partial results as they stream (unclosed code fences, incomplete headings render correctly and update when closing tokens arrive)
- R10. Code blocks receive syntax highlighting with ANSI colors
- R11. Supported elements: headings, lists (ordered/unordered), inline code, bold, italic, links, code blocks with language tags, blockquotes
- R12. Tool results, error messages, and diffs render through the same markdown pipeline

**Multi-Line Input and Control**

- R13. Multi-line text input with backspace, arrow keys, Enter for newline, and a submit key (e.g., Ctrl+Enter or double Enter)
- R14. Ctrl+C interrupts a running agent mid-execution (wires to `AgentController.abort()`)
- R15. `$EDITOR` handoff: a keybinding (e.g., Ctrl+E) opens the user's editor for composing long input, and the content is submitted on editor close
- R16. Input history: up/down arrows cycle through previous inputs within the session

**Reactive State Store**

- R17. A plugin-accessible state store (not React Context only) that plugins can subscribe to via selector functions, receiving updates only when their selected slice changes
- R18. The store ingests `AgentEvent` streams from `CortxSession.subscribe()` and projects them into queryable state slices — distinct from the raw event subscription: the store aggregates cumulative state (e.g., total tokens, message history) while `CortxSession.subscribe()` provides the real-time event feed
- R19. State shape covers: message history, current iteration, pending tool calls, token usage (cumulative), elapsed time, session status (idle/running/error)

**Session Persistence**

- R20. Session is auto-saved to disk after each turn completes (`done` or `error` events) — serialized message array
- R21. `/resume` command lists past sessions with summaries (first user message + timestamp) and restores the selected one
- R22. On startup, if a previous session exists, offer to resume it
- R23. Session files stored via `@nerax-ai/storage` (already a project dependency)

**Command Registry and Palette**

- R24. Slash commands registered via `tui.command` extension type — each command provides: name, description, handler function
- R25. Command palette overlay (Ctrl+K or `/`) with fuzzy search across all registered commands
- R26. Auto-generated `/help` that lists all registered commands with descriptions
- R27. Plugins can register their own commands (e.g., `/model`, `/theme`, `/mcp`)

**Event-Driven Renderer Pipeline**

- R28. `AgentEvent` → region mapping: each event type is routed to the appropriate region(s) by the renderer registry
- R29. `tui.renderer` extension type allows plugins to register custom renderers for specific event types — overriding or augmenting default rendering
- R30. All 13 `AgentEvent` variants have dedicated rendering behavior:
  - `text_delta` → streaming markdown in output region
  - `thinking_delta` → collapsible thinking section in output region
  - `tool_use` → tool call card in tool region
  - `tool_progress` → progress update within tool card
  - `tool_result` → result display within tool card (truncated at 500 chars by default, user can expand to see full output)
  - `turn_start` → iteration counter in status bar
  - `turn_end` → summary update
  - `done` → completion indicator in status bar + token usage + session auto-save
  - `error` → error display in output region
  - `steered`/`follow_up` → notification in status bar
  - `context_overflow` → warning in output region

## Success Criteria

- Users can type multi-line input and submit it to the agent
- Ctrl+C interrupts a running agent and returns to the input prompt
- Markdown output renders with syntax highlighting in real-time as the agent streams
- A plugin can add a new slash command and a new overlay by implementing the `tui.command` and `tui.region` extension types — no core code changes required
- Conversations survive app restart (auto-save + `/resume`)
- The TUI runs without native dependencies (pure JS/TS via Ink)
- The current 88-line `cli.ts` is fully replaced

## Scope Boundaries

- **No virtual scrolling** — use terminal native scrollback for v1
- **No Vim/Emacs input modes** — standard input with future keybinding system
- **No mouse support** in v1
- **No theme system** in v1 — basic ANSI colors only; `tui.theme` extension type reserved for future use
- **No multi-session tabs** — single session at a time with `/resume` to switch
- **No Ink fork** — use vanilla Ink; fork only if specific rendering bottlenecks are proven
- **No changes to core agent loop** (`loop.ts`, `session.ts`) — the TUI is a pure consumer of `AsyncGenerator<AgentEvent>`
- **No changes to existing `CortxPlugin` interface** — TUI extensions are a parallel concern

## Key Decisions

- **Use Ink directly (not forked):** Vanilla Ink provides sufficient rendering for v1 (React reconciler, Yoga Layout, `useInput`, `useStdout`). Fork only when specific bottlenecks are measured. Claude Code's fork was needed at 146+ components; cortx starts with 4 regions.
- **Same @nerax-ai/plugin, separate extension types:** TUI plugins and agent plugins share the same loading mechanism and lifecycle but use different extension type prefixes (`tui.*` vs `agent.*`). This avoids coupling while keeping one plugin infrastructure.
- **Fixed regions + overlays:** Core layout has 4 fixed regions (output, tools, status, input). Plugins can add overlays (modals) but cannot create new fixed regions. This keeps the layout predictable while allowing rich interactions.
- **Built-in features as first-party plugins:** Markdown renderer, status bar, tool panel, session manager, and command palette are all implemented as plugins using the same `ctx.register()` API. This validates the extension model and ensures third-party plugins have real examples to follow.
- **State store separate from React Context:** Plugins need access to state without React's component tree. A custom selector-based store built on `CortxSession.subscribe()` serves both Ink components and plugin code.

## Dependencies / Assumptions

- `ink` and `react` will be added as dependencies to `@cortx/tui`
- `@nerax-ai/plugin` registry API (`ctx.register(type, id, factory)`) supports arbitrary type strings — planning must verify this first; if restricted, TUI extension types will need a wrapper adapter pattern
- `@nerax-ai/storage` supports writing arbitrary JSON files for session persistence — already used in `config.ts`, likely sufficient
- Ink's `useInput` hook provides sufficient raw key handling for Ctrl+C, Ctrl+Enter, Ctrl+K, arrow keys, and Enter
- A markdown-to-terminal library will be selected during planning (e.g., `cli-markdown`, `terminal-markdown`, or custom)
- A syntax highlighting library will be selected during planning (e.g., `highlight.js`, `prism`)
- The `$EDITOR` handoff depends on Ink's ability to temporarily release the terminal (alt-screen buffer or suspend)

## Outstanding Questions

### Resolve Before Planning

None — all product decisions have been resolved.

### Deferred to Planning

- [Affects R1-R4][Needs research] Verify `@nerax-ai/plugin`'s `ctx.register(type, id, factory)` accepts arbitrary type strings — if not, design an adapter wrapper
- [Affects R9][Technical] Which markdown-to-terminal library to use, or whether to build a custom streaming parser
- [Affects R10][Technical] Which syntax highlighting library to use for code blocks
- [Affects R15][Needs research] How Ink handles `$EDITOR` handoff — does it support suspending the TUI to run an external process?
- [Affects R17][Technical] Exact state store API shape — selector function signature, subscription mechanism, initial state
- [Affects R7][Technical] How Ink handles partial re-renders — does its built-in output diffing already prevent unnecessary redraws, or does cortx need custom region isolation?
- [Affects R5][Technical] Whether the tool region should be a persistent sidebar or a collapsible section between output and input

## Next Steps

-> `/ce:plan` for structured implementation planning
