---
date: 2026-04-18
topic: tui-refactor
focus: Compare claude-code and opencode TUI approaches, generate ideas for refactoring cortx TUI
---

# Ideation: Cortx TUI Refactoring

## Codebase Context

### Reference Projects Analyzed

**Claude Code TUI** (React + custom Ink fork):
- React-based with custom reconciler, double-buffered screen, virtual scrolling
- Yoga Layout for flexbox, character/style/hyperlink pooling for memory efficiency
- DOM-like event system (capture/bubble), incremental diff rendering
- Rich input: Vim/Emacs modes, Kitty keyboard protocol, mouse tracking
- React Context-based state management (AppStateStore + 11 Context Providers)
- 146+ React/Ink components, theme system, error boundaries, accessibility
- Extremely powerful but extremely complex (core rendering engine is ~100KB+)

**OpenCode TUI** (Solid.js + @opentui/core):
- Solid.js fine-grained reactivity (not virtual DOM) at 60 FPS target
- Worker thread for API calls (separates UI from network), SSE-based real-time state sync
- 14+ context providers (Route, SDK, Sync, Theme, Dialog, Command, etc.)
- Route-based navigation, dialog stack management, command palette with fuzzy search
- 40+ themes, Kitty keyboard protocol, mouse support, leader key sequences
- ~103 Solid.js components, JSON-based theme definitions

**Cortx TUI** (Current state — the refactoring target):
- **No real TUI framework** — just readline + ANSI escape codes (88 lines in `cli.ts`)
- Async generator event-driven architecture: `for await (const event of agent.run(msg)) { ... }`
- 13 typed AgentEvent variants (`text_delta`, `tool_use`, `tool_result`, `thinking_delta`, `done`, etc.)
- Plugin system with hooks (`messages.transform`, `tool.execute.before/after`, `error.recover`)
- Provider-agnostic LLM abstraction (`@synax-ai/core`, `@synax-ai/sdk`)
- Minimal: no scrolling, no mouse, no multi-line input, no rich formatting
- Clean core loop (260 lines), but CLI blocks on readline, dumps raw text to stdout
- `CortxSession` already has `subscribe()` pub/sub model — halfway to a reactive store

### Key Architectural Insight

Cortx's `AsyncGenerator<AgentEvent>` is **already a rendering-independent protocol**. Claude Code built a React reconciler because they started with React. OpenCode built opentui because they started with Solid.js. Cortx starts with a protocol — the TUI question is not "which framework?" but "which consumer?" This is fundamentally easier to solve, iterate on, and replace.

---

## Ranked Ideas

### 1. Event-Driven Renderer Architecture
**Description:** Replace the 88-line `cli.ts` switch statement with a formal event-to-renderer registry. Each `AgentEvent` type maps to a registered render function `(event, screen) => void`. The core loop stays pure — renderers are pluggable. Adding any visual feature (markdown, syntax highlighting, spinners) becomes an isolated module, not entangled in the event loop.
**Rationale:** This is the single highest-leverage investment. cli.ts already does this inline (30-line switch on event types). Formalizing it means every UI enhancement is additive. This is exactly how claude-code's 146 components work — each subscribes to specific event types. The compounding effect: theme systems, accessibility, and non-terminal output (web UI, IDE panel) all become different renderer subscriptions.
**Downsides:** Requires defining the "screen" abstraction first (cursor positioning, regions, color).
**Confidence:** 95%
**Complexity:** Medium
**Status:** Unexplored

### 2. Raw Input Layer (Kill readline)
**Description:** Replace `readline.createInterface()` with raw-mode stdin + a key matcher (~200 lines). Input becomes a state machine: accumulate characters, handle backspace/arrows/enter, support modifier keys (Ctrl, Alt, Shift), detect interrupts. Enables multi-line editing, Ctrl+C abort, Escape steer, `$EDITOR` handoff, and future vim mode.
**Rationale:** Readline is the single biggest ceiling on cortx's TUI. It makes multi-line input impossible, prevents interrupting a running agent (can't press Ctrl+C during `agent.run()` because readline owns stdin), and prevents any keybinding beyond what readline supports. Every serious TUI (claude-code, opencode) uses raw mode. The cortx core already has `AgentLoopController` with `steer()`, `followUp()`, and `abort()` APIs — the CLI just never wires them to keyboard input.
**Downsides:** Must handle all key parsing yourself (but existing patterns make this ~200 lines).
**Confidence:** 92%
**Complexity:** Medium
**Status:** Unexplored

### 3. Reactive State Store
**Description:** A tiny pub-sub store (~50 lines) with selector functions. UI components subscribe to specific state slices (messages, tool calls, token usage) and re-render only when their slice changes. Built on top of `CortxSession.subscribe()` which already exists.
**Rationale:** Without this, adding any UI feature means the entire TUI re-renders on every `text_delta` event. Claude-code built `AppStateStore.ts` + 11 Context Providers. OpenCode uses Solid.js signals. Cortx only needs a 50-line selector store. This is the foundation for keeping the TUI responsive under load — a token counter re-renders only on `done` events, a tool panel re-renders only on `tool_use`/`tool_result`, and the message list re-renders on text deltas.
**Downsides:** Must define the store shape and selector contract upfront.
**Confidence:** 90%
**Complexity:** Low
**Status:** Unexplored

### 4. Region-Based Rendering (tmux-style, no layout engine)
**Description:** Divide the terminal into fixed regions (output area, tool panel, status bar, input area) using ANSI absolute cursor positioning (`\x1b[row;colH`). Only redraw the region that changed. No Yoga Layout, no flexbox, no layout engine. A region model is ~100 lines of code. Includes terminal capability auto-probe (Kitty keyboard, truecolor, bracketed paste) so features degrade gracefully.
**Rationale:** Claude-code imported Yoga Layout. OpenCode uses opentui's flexbox. Cortx doesn't need flexbox — it has 3-4 fixed regions that map directly to event types: `text_delta`/`thinking_delta` → output region, `tool_use`/`tool_result` → tool panel, `done` → status bar (model, iteration, tokens, elapsed time). The status bar alone (one ANSI line with save/restore cursor) gives users 80% of the "at-a-glance" information that claude-code's full header provides, in ~20 lines of code.
**Downsides:** Must handle terminal resize events; not flexible for arbitrary layouts.
**Confidence:** 88%
**Complexity:** Medium
**Status:** Unexplored

### 5. Streaming Markdown Renderer
**Description:** A terminal markdown renderer that incrementally processes `text_delta` events — correctly handles partial tokens (unclosed code fences, incomplete headings). Syntax-highlights code blocks via ANSI colors. Handles headings, lists, inline code, bold/italic, links. Maintains parse state so partial tokens render correctly and update when the closing token arrives.
**Rationale:** Single biggest improvement to perceived output quality. Cortx currently dumps raw markdown (including code fences like ` ```python `) straight to the terminal. Claude-code has `src/outputStyles/`. OpenCode has dedicated `markdown.tsx` and `code.tsx` components. The streaming requirement is critical: buffering the entire response means the user sees nothing until completion. Once you have a markdown renderer, tool results, error messages, and diffs all render for free.
**Downsides:** Handling partial markdown state is tricky; syntax highlighting adds a dependency.
**Confidence:** 92%
**Complexity:** Medium
**Status:** Unexplored

### 6. Session Persistence + Resume
**Description:** Serialize the message array to disk after each turn (on `done`/`error` events). On startup, detect existing sessions and offer to resume. A `/resume` command lists past sessions with summaries and restores the selected one.
**Rationale:** Every time cortx exits, the entire conversation is lost. The agent already maintains a complete message array; it just never saves it. `@nerax-ai/storage` is already imported in the project. This low-effort investment prevents the most frustrating failure mode (crash, accidental close) and unlocks session branching and sharing. Claude-code has `ResumeConversation.tsx`. OpenCode has `--continue` and `--session <id>` flags.
**Downsides:** Message array must be serializable (check for circular references).
**Confidence:** 90%
**Complexity:** Low
**Status:** Unexplored

### 7. Extensible Command Registry with Fuzzy Search
**Description:** Replace the hardcoded `/exit`, `/clear`, `/config` if-else with a command registry where each slash command is a self-contained module (name, description, handler). Add a fuzzy-search palette (Ctrl+K or `/`) that lists all available commands. Plugins can register their own commands.
**Rationale:** Highest discoverability ROI. Cortx has 3 commands hidden in an if-else. Claude-code has 50+. OpenCode has a full command palette. The registry means: plugins can add commands, the help menu is auto-generated, and every future capability (model switching, MCP control, theme selection) has a natural home. Users discover features through the palette rather than memorizing commands.
**Downsides:** Requires raw input layer (for capturing Ctrl+K while typing in palette).
**Confidence:** 88%
**Complexity:** Low-Medium
**Status:** Unexplored

---

## Recommended Build Order

```
Phase 1 — Foundation (makes everything else possible):
  1. Reactive State Store (#3)     — ~50 lines, everything subscribes to this
  2. Event-Driven Renderer (#1)    — decouples rendering from event stream
  3. Raw Input Layer (#2)          — unlocks multi-line, interrupt, keybindings

Phase 2 — Architecture (how the screen is organized):
  4. Region-Based Rendering (#4)   — fixed regions, no layout engine
  5. Streaming Markdown (#5)       — single biggest quality improvement

Phase 3 — UX Features (what users see and touch):
  6. Session Persistence (#6)      — reliability and trust
  7. Command Registry (#7)         — discoverability multiplier
```

Phase 1 total: ~300-400 lines (same size as current cli.ts) but unlocks an architecture that scales to claude-code's capability level without claude-code's coupling.

---

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Headless Server + Thin Client ("The Double") | Premature for TUI refactoring; follow-up, not v1 |
| 2 | Structured Output Protocol (DAP for Agents) | Valuable but separate from TUI; different output formatting concern |
| 3 | Editor Protocol Bridge (LSP/DAP) | Long-term vision, not TUI refactoring scope |
| 4 | Bun-Native Renderer (FFI/TTY) | Too speculative; locks cortx into Bun runtime |
| 5 | tmux Native Integration | Too niche; TUI should be self-contained |
| 6 | Concurrent Tool Execution | Changes core agent loop, not TUI; out of scope |
| 7 | Permission System via Plugin | Important core feature, not primarily a TUI concern |
| 8 | MCP-as-Plugin Architecture | Important core feature, not a TUI concern |
| 9 | Keybinding System with Modes | Depends on raw input layer; build later |
| 10 | Virtual Scrolling Buffer | Premature optimization for v1; start with terminal scrollback |
| 11 | Alt-Screen Scrollback | Design decision within region renderer, not standalone |
| 12 | Defer to Pager for Rich Content | Breaks conversational flow; users expect inline rendering |
| 13 | Thinking/Reasoning Toggle | Lower priority; can be a command or plugin |
| 14 | Render Plugin Hook | Overlaps with event-driven renderer (already pluggable by design) |
| 15 | In-Place Tool Output (ANSI rewrite) | Merged into region renderer (tool region) |
| 16 | Terminal Auto-Probe + Adaptive Rendering | Merged into region renderer (prerequisite) |
| 17 | Streaming Ring Buffer | Merged into event-driven renderer (implementation detail) |
| 18 | Interrupt-and-Steer Mid-Execution | Merged into raw input layer (unlocked once readline is gone) |
| 19 | Multi-Line Input with Editor Handoff | Merged into raw input layer (unlocked once readline is gone) |
| 20 | Persistent Command History | Merged into extensible command registry + session persistence |
| 21 | Single Status Bar | Merged into region renderer (one region) |
| 22 | Token Usage Tracker | Merged into region renderer (status region) |

---

## Session Log
- 2026-04-18: Initial ideation — ~40 raw ideas generated across 4 frames, ~25 after dedup, 7 survived adversarial filtering
