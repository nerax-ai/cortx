---
title: "refactor: Replace readline CLI with Ink-based extensible TUI"
type: refactor
status: active
date: 2026-04-19
origin: docs/brainstorms/2026-04-19-tui-refactor-requirements.md
---

# Refactor: Replace readline CLI with Ink-based extensible TUI

## Overview

Replace the 88-line readline CLI with a full Ink (React) TUI. The new TUI has 4 fixed regions (output, tools, status, input), overlay support (command palette, session picker), and a plugin extension system using the existing `@nerax-ai/plugin` registry with new `tui.*` extension types. All built-in features are first-party plugins validating the same API that third-party plugins will use.

## Problem Frame

Cortx's CLI is a minimal readline interface with no multi-line input, no interrupt capability during agent execution, no rich formatting, and no extensibility. Every attempt to add a visual feature entangles with the event loop. The `AsyncGenerator<AgentEvent>` architecture is rendering-independent by design — the TUI is simply a consumer. This refactoring gives cortx a professional TUI while preserving the clean event protocol. (see origin: `docs/brainstorms/2026-04-19-tui-refactor-requirements.md`)

## Requirements Trace

- R1. TUI extensions use `@nerax-ai/plugin` registry with distinct `tui.*` extension types
- R2. Extension types: `tui.command`, `tui.region`, `tui.renderer`, `tui.keybind` (future: `tui.theme`)
- R3. Built-in features are first-party plugins via `ctx.register()`
- R4. TUI plugins share same loading/lifecycle as agent plugins
- R4a. Plugin failures are isolated — throwing renderer/command logs error, continues
- R5. Four fixed core regions: output, tools, status, input
- R6. Plugin overlays: command palette, help, confirmation, session picker
- R7. Region-level selective redraw
- R8. Terminal resize handling
- R9-R12. Streaming markdown renderer with syntax highlighting
- R13-R16. Multi-line input with submit, abort, history, $EDITOR handoff
- R17-R19. Plugin-accessible reactive state store with selectors
- R20-R23. Session persistence with auto-save and /resume
- R24-R27. Command registry with fuzzy search palette
- R28-R30. Event-driven renderer pipeline routing all 13 AgentEvent types

## Scope Boundaries

- No virtual scrolling (terminal scrollback for v1)
- No Vim/Emacs input modes
- No mouse support in v1
- No theme system in v1 (basic ANSI colors)
- No multi-session tabs
- No Ink fork
- No changes to core agent loop (`loop.ts`, `session.ts`)
- No changes to existing `CortxPlugin` interface

### Deferred to Separate Tasks

- Theme system (`tui.theme` extension type reserved)
- Mouse support and advanced input modes
- Virtual scrolling / alt-screen scrollback buffer

## Context & Research

### Relevant Code and Patterns

- **Current CLI**: `packages/tui/src/cli.ts` — 88-line readline + stdout, the file being replaced
- **Agent event loop**: `packages/core/src/loop.ts` — `AsyncGenerator<AgentEvent>` with 13 event types
- **Session model**: `packages/core/src/session.ts` — `CortxSession.subscribe()` pub/sub
- **Plugin system**: `@nerax-ai/plugin` — `ctx.register(type, id, factory)` with arbitrary type strings
- **Storage**: `@nerax-ai/storage` — `getStorage(appName).state.writeJSON()` for session files
- **SDK types**: `packages/sdk/src/index.ts` — `AgentEvent`, `CortxPlugin`, `Tool`, `ToolContext`
- **AgentController**: `packages/core/src/types.ts` — `abort()`, `steer()`, `followUp()`, `isAborted`, `isSteered`
- **Goose TUI** (reference): `/Users/illuxiza/Gitwork/tools/goose/ui/text/` — production Ink v5.1.0 agent TUI
- **Config**: `packages/tui/src/config.ts` — `CortxConfig`, `loadConfig()`, `saveConfig()`
- **Language client**: `packages/tui/src/language.ts` — `createLanguageClient()`

### Institutional Learnings

- Goose TUI uses Ink v5.1.0 with `ink-text-input` — proven pattern for multi-line input
- Plugin registry already accepts arbitrary type strings — no adapter needed (confirmed by code inspection)
- `@nerax-ai/storage.state` is XDG-compliant and ready for session persistence
- Cortx's `AsyncGenerator<AgentEvent>` is rendering-independent — the TUI is a pure consumer
- AsyncGenerator guarantees event ordering — no tool event reordering concerns

### External References

- Ink documentation: https://github.com/vadimdemedes/ink
- Ink testing library: https://github.com/vadimdemedes/ink-testing-library

## Key Technical Decisions

- **Vanilla Ink (not forked)**: Sufficient for 4-region layout. Fork only if rendering bottlenecks proven.
- **State store as separate module**: Not React Context — plugins need state access without React component tree. Selector-based subscriptions (`store.select(fn)`) built on `CortxSession.subscribe()`.
- **Tool region as collapsible section**: Between output and input, shows latest tool call, expandable for history. Not a sidebar. This is a planning-level refinement of R5's "call/result pairs" — collapsible behavior is a UX improvement, not new scope.
- **Input stays active during streaming**: Users can type follow-ups while agent runs. Submit queues via `AgentController.followUp()`. Ctrl+C calls `AgentController.abort()`.
- **Interrupt state**: Status bar shows "Interrupting..." between abort() call and done/error event confirmation.
- **Each region is a separate React component** subscribing to its own state slice — React's reconciliation provides region isolation without custom diffing.
- **Streaming markdown**: Accumulate `text_delta` into a buffer, re-render markdown on each delta. Use `cli-highlight` for code block syntax highlighting.
- **Session files in state directory**: `@nerax-ai/storage` `.state.writeJSON()` with session ID filenames.
- **Crash recovery**: On startup, detect sessions without a terminal `done` event and offer resume/discard.

## Open Questions

### Resolved During Planning

- `@nerax-ai/plugin` accepts arbitrary type strings: **Confirmed** — uses generic `<TTypes extends string>`, no whitelist.
- Tool region layout: **Collapsible section** between output and input, not a sidebar.
- Input during streaming: **Active but labeled "Follow-up..."**, submit queues via `followUp()`.
- Ink region isolation: **Each region is a separate React component** with its own state slice. React's reconciliation handles selective re-rendering.

### Deferred to Implementation

- Exact markdown library choice (`cli-markdown`, custom parser, or hybrid)
- Exact syntax highlighting library (`cli-highlight` recommended)
- $EDITOR handoff mechanism (suspend Ink vs alt-screen buffer)
- Ink `useInput` key handling details (Ctrl+Enter, Ctrl+E, Ctrl+K)
- Test infrastructure setup (`ink-testing-library` vs custom)

## Output Structure

```
packages/tui/src/
├── cli.ts                    (modify — new TUI bootstrap)
├── app.tsx                   (new — Ink root component)
├── config.ts                 (existing — unchanged)
├── language.ts               (existing — unchanged)
├── store.ts                  (new — reactive state store)
├── tui-registry.ts           (new — TUI plugin registration wrapper)
├── renderer.ts               (new — event → region routing)
├── types/
│   ├── tui-plugin.ts         (new — TuiExtension, CommandDef, RegionDef)
│   └── tui-state.ts          (new — TuiState shape)
├── components/
│   ├── app-shell.tsx          (new — layout with 4 regions + overlay slot)
│   ├── output-region.tsx      (new — streaming text display)
│   ├── tool-region.tsx        (new — tool call/result cards, collapsible)
│   ├── status-bar.tsx         (new — model, iteration, tokens, elapsed)
│   ├── input-area.tsx         (new — multi-line input with history)
│   ├── markdown.tsx           (new — streaming markdown renderer)
│   ├── command-palette.tsx    (new — fuzzy search overlay)
│   └── session-picker.tsx     (new — session resume overlay)
└── plugins/
    ├── markdown-plugin.ts     (new — first-party: output region + text_delta renderer)
    ├── status-plugin.ts       (new — first-party: status region + done/turn_start)
    ├── tool-plugin.ts         (new — first-party: tool region + tool_use/result)
    ├── session-plugin.ts      (new — first-party: /resume command + auto-save)
    └── command-plugin.ts      (new — first-party: palette overlay + /help)
```

## Implementation Units

### Phase 1: Foundation

- [ ] **Unit 1: Project Setup + TUI Shell**

**Goal:** Add Ink/React dependencies, create minimal TUI entry point that replaces readline CLI, verify Ink renders in the terminal.

**Requirements:** Setup (no specific R# — this unit creates the scaffolding that Units 2-8 build on)

**Dependencies:** None

**Files:**
- Modify: `packages/tui/package.json` — add `ink`, `react`, `@types/react`
- Modify: `packages/tui/src/cli.ts` — replace readline with Ink render bootstrap
- Create: `packages/tui/src/app.tsx` — root Ink component
- Create: `packages/tui/src/components/app-shell.tsx` — minimal 4-region layout shell (skeleton placeholders)
- Create: `packages/tui/src/components/input-area.tsx` — basic single-line text input (multi-line comes in Unit 6)
- Create: `packages/tui/src/components/output-region.tsx` — plain text output (markdown comes in Unit 5)
- Create: `packages/tui/src/components/status-bar.tsx` — static status line (dynamic updates come in Unit 4)
- Create: `packages/tui/src/components/tool-region.tsx` — empty placeholder (event routing comes in Unit 4)
- Test: `packages/tui/src/__tests__/app.test.ts` — basic render test

**Approach:**
- Add `ink` (v5.x) and `react` (v18.x) to `@cortx/tui` dependencies
- Rewrite `cli.ts` to: create Cortx + CortxSession → create Ink app → wire session events to app state
- `app.tsx` is the Ink root: manages session lifecycle, passes events to child regions
- Each region component receives only its relevant data via props initially (state store comes in Unit 2)
- Keep the existing `askUser` callback pattern working for tool permission prompts
- Use Ink's `render()` function with `exitOnCtrlC: false` to handle Ctrl+C manually

**Patterns to follow:**
- Goose TUI `app.tsx` pattern: single root component managing session lifecycle
- Current `cli.ts` agent initialization pattern (Cortx constructor, config, language client)

**Test scenarios:**
- Happy path: Ink app renders without error, shows input prompt
- Happy path: User input reaches agent, text_delta events appear in output region
- Edge case: Ctrl+C during idle shows clean exit
- Integration: Full loop — type message → agent runs → output appears → returns to prompt

**Verification:** Run `bun src/cli.ts` and interact with the basic TUI. Message sends to agent, text appears, status shows model name.

---

- [ ] **Unit 2: Reactive State Store**

**Goal:** Build a selector-based state store that ingests AgentEvents and exposes queryable state slices for both React components and plugins.

**Requirements:** R17, R18, R19

**Dependencies:** Unit 1

**Files:**
- Create: `packages/tui/src/store.ts` — TuiStore class
- Create: `packages/tui/src/types/tui-state.ts` — state shape types
- Modify: `packages/tui/src/app.tsx` — wire store to session events
- Test: `packages/tui/src/__tests__/store.test.ts`

**Approach:**
- `TuiStore` holds the full state object: `{ messages, iteration, toolCalls, tokenUsage, elapsed, status, error }`
- `store.select(selector)` returns `{ get(), subscribe(listener) }` — listener called only when selector result changes (shallow equality)
- `store.dispatch(event)` ingests an AgentEvent and updates the relevant state slice:
  - `text_delta` → append to current message buffer
  - `tool_use` → add to toolCalls map
  - `tool_result` → update toolCalls entry
  - `done` → set status to idle, update tokenUsage
  - `turn_start` → increment iteration, set status to running
  - `error` → set status to error
- Store is a plain TypeScript class, not tied to React. Ink components use `useSyncExternalStore` to subscribe.
- `CortxSession.subscribe()` feeds events into `store.dispatch()`
- Elapsed time: start a timer on `turn_start`, clear on `done`/`error`

**Patterns to follow:**
- `CortxSession` pattern: simple listener Set with subscribe/unsubscribe
- Redux/Zustand selector pattern: `select(state) => derivedValue`

**Test scenarios:**
- Happy path: dispatch text_delta → selector for messages returns updated buffer
- Happy path: dispatch done → status changes to idle, token usage updates
- Edge case: selector returns same value → subscriber not notified
- Edge case: multiple rapid text_delta events → state accumulates correctly
- Integration: full turn_start → text_delta → tool_use → tool_result → done cycle

**Verification:** Unit tests pass. Store correctly tracks state through a full agent turn cycle.

---

- [ ] **Unit 3: Plugin Extension API**

**Goal:** Define TUI extension types and create the registration wrapper that lets plugins (both built-in and third-party) register commands, regions, renderers, and keybindings.

**Requirements:** R1, R2, R3, R4, R4a

**Dependencies:** Unit 2 (state store needed for plugin access)

**Files:**
- Create: `packages/tui/src/types/tui-plugin.ts` — TuiExtension interfaces
- Create: `packages/tui/src/tui-registry.ts` — wraps @nerax-ai/plugin for TUI concerns
- Modify: `packages/tui/src/app.tsx` — initialize TUI registry, load built-in plugins
- Create: `packages/tui/src/plugins/command-plugin.ts` — built-in command palette + /help
- Test: `packages/tui/src/__tests__/tui-registry.test.ts`

**Approach:**
- Define extension type constants: `tui.command`, `tui.region`, `tui.renderer`, `tui.keybind`
- Each extension type has a factory that returns the extension value:
  - `tui.command` factory returns `CommandHandler` (name, description, handler function)
  - `tui.region` factory returns `RegionComponent` (id, position, React component, event subscriptions)
  - `tui.renderer` factory returns `EventRenderer` (event type, render function)
  - `tui.keybind` factory returns `KeyBinding` (key sequence, action)
- `TuiRegistry` wraps the `@nerax-ai/plugin` `PluginRegistry`:
  - `getCommands()` — lists all registered `tui.command` extensions
  - `getRegions(position)` — lists regions for a given layout position
  - `getRenderers(eventType)` — lists renderers for a given event type
  - `executeCommand(name, args)` — looks up and calls command handler with error isolation
- Built-in plugins (command-plugin, etc.) register via `ctx.register()` in their `setup()` function
- Plugin error isolation: wrap every handler invocation in try/catch, log errors, continue TUI operation
- The command plugin registers: `/exit`, `/clear`, `/config`, `/help`, and the palette overlay trigger

**Patterns to follow:**
- `@nerax-ai/plugin` registration pattern: `ctx.register(type, id, factory)`
- Current tool registration in `packages/code/src/` — individual factories collected into arrays
- Goose TUI command handling pattern

**Test scenarios:**
- Happy path: register tui.command → getCommands() returns it
- Happy path: register tui.region → getRegions('main') returns it
- Edge case: plugin handler throws → error logged, TUI continues
- Edge case: register duplicate command id → latest wins (or warning)
- Integration: load built-in command plugin → /help lists all commands

**Verification:** Unit tests pass. Built-in commands (/exit, /clear, /config, /help) are registered and callable through the registry.

### Phase 2: Layout & Rendering

---

- [ ] **Unit 4: Region Layout + Event Renderer Pipeline**

**Goal:** Implement the full 4-region layout with selective redraw and the AgentEvent → region routing pipeline.

**Requirements:** R5, R6, R7, R8, R28, R29, R30

**Dependencies:** Unit 2, Unit 3

**Files:**
- Modify: `packages/tui/src/components/app-shell.tsx` — full region layout with Yoga flexbox
- Modify: `packages/tui/src/components/output-region.tsx` — subscribe to output state slice
- Modify: `packages/tui/src/components/tool-region.tsx` — subscribe to tool state slice
- Modify: `packages/tui/src/components/status-bar.tsx` — subscribe to status state slice
- Create: `packages/tui/src/renderer.ts` — event → region routing
- Test: `packages/tui/src/__tests__/renderer.test.ts`

**Approach:**
- `app-shell.tsx` uses Ink's `<Box>` with Yoga flexbox: vertical stack of output (flex-grow), tools (auto height), status (1 line), input (auto height)
- Each region component uses `useSyncExternalStore` with the state store selector for its data slice — this achieves selective redraw because React only re-renders a component when its `useSyncExternalStore` subscription detects a change in the selected value. If `text_delta` updates the message buffer, only the output region's selector fires; the status bar's selector returns the same value and React skips that component.
- Tool region is collapsible: shows latest tool call summary by default, expandable via key press
- Overlay slot: absolutely positioned `<Box>` rendered on top when active (command palette, session picker)
- `renderer.ts` maps event types to state updates and region notifications:
  - `text_delta` / `thinking_delta` / `text` / `thinking` → output region
  - `tool_use` / `tool_progress` / `tool_result` → tool region
  - `turn_start` / `turn_end` / `done` / `error` → status bar
  - `steered` / `follow_up` / `context_overflow` → status bar (notifications)
- `tui.renderer` extensions can override or augment default rendering per event type
- Terminal resize: Ink handles SIGWINCH internally via Yoga relayout
- Header line in app-shell shows: model name · working directory · iteration count

**Patterns to follow:**
- Ink `<Box>` flexbox layout: `flexDirection="column"`, `flexGrow`, `height` props
- Goose TUI layout pattern with region separation

**Test scenarios:**
- Happy path: 4 regions render with correct proportions
- Happy path: text_delta updates output region only, status bar unchanged
- Happy path: tool_use updates tool region only
- Edge case: terminal resize → regions adapt
- Edge case: overlay opens → renders on top of content
- Integration: full agent turn → all regions update in correct sequence

**Verification:** Run TUI, send a message that triggers tool use, verify each region updates independently.

---

- [ ] **Unit 5: Streaming Markdown Renderer**

**Goal:** Build an incremental markdown renderer that handles streaming text_delta events, with syntax-highlighted code blocks.

**Requirements:** R9, R10, R11, R12

**Dependencies:** Unit 4 (Unit 1 creates a skeleton output-region.tsx; Unit 4 makes it functional with state subscriptions; Unit 5 replaces it with the markdown renderer)

**Files:**
- Create: `packages/tui/src/components/markdown.tsx` — streaming markdown component
- Create: `packages/tui/src/plugins/markdown-plugin.ts` — registers as tui.region + tui.renderer
- Modify: `packages/tui/src/components/output-region.tsx` — use Markdown component
- Test: `packages/tui/src/__tests__/markdown.test.ts`

**Approach:**
- Markdown component receives accumulated text buffer, renders as terminal-formatted output
- Streaming approach: maintain a running text buffer. On each `text_delta`, append delta to buffer, re-render the full markdown. Ink's reconciliation handles diffing.
- Partial token handling: if buffer ends mid-fence (odd number of ```), render the fence as visible text. When closing fence arrives, render as code block.
- Supported elements: headings (bold + underline), lists (indented with bullets/numbers), inline code (colored background), bold/italic (ANSI bold/italic), links (URL in dim text), code blocks (syntax highlighted), blockquotes (indented with │ prefix)
- Syntax highlighting: use `cli-highlight` (wraps highlight.js) for code blocks. Detect language from fence info string.
- Tool results, error messages, and diffs route through the same markdown pipeline (R12)
- Register as a first-party plugin: `tui.region('output')` + `tui.renderer('text_delta')`

**Patterns to follow:**
- Goose TUI message rendering pattern
- Current cli.ts text_delta handling (line 46) — just writes to stdout

**Test scenarios:**
- Happy path: plain text renders without formatting
- Happy path: code block with language tag renders with syntax highlighting
- Happy path: heading, list, inline code, bold, link all render correctly
- Edge case: unclosed code fence renders as visible backticks, closes properly when fence arrives
- Edge case: empty code block (opening fence immediately followed by closing fence)
- Edge case: very long line wraps to terminal width
- Integration: streaming text_delta sequence renders incrementally

**Verification:** Send a message that returns markdown with code blocks, lists, and headings. Verify formatting renders correctly in real-time.

### Phase 3: Interaction & UX

---

- [ ] **Unit 6: Multi-Line Input with Control**

**Goal:** Replace basic text input with a full multi-line input component supporting submit, abort, history, and $EDITOR handoff.

**Requirements:** R13, R14, R15, R16

**Dependencies:** Unit 4 (input region exists)

**Files:**
- Modify: `packages/tui/src/components/input-area.tsx` — full multi-line implementation
- Modify: `packages/tui/src/app.tsx` — wire Ctrl+C to abort, follow-up queue
- Test: `packages/tui/src/__tests__/input.test.ts`

**Approach:**
- Use Ink's `useInput` hook for raw key capture
- Multi-line editing: Enter inserts newline, Ctrl+Enter (or double Enter on empty line) submits
- During agent streaming: input shows "Follow-up..." label, submit queues via `AgentController.followUp()`
- Ctrl+C behavior depends on state:
  - Idle: clears current input (or exits if input is empty)
  - Running: calls `AgentController.abort()`, status bar shows "Interrupting..."
  - Interrupting: second Ctrl+C forces exit
- Input history: maintain an array of past inputs. Up/Down arrows navigate history when input is empty or at start of line.
- $EDITOR handoff: Ctrl+E spawns `$EDITOR` with a temp file. On editor close, read file contents and submit. Requires releasing the terminal temporarily (unmount Ink → spawn → remount).
- The component exposes its state (current value, isFocused) so plugins can interact with it.

**Patterns to follow:**
- Ink `useInput` hook for key capture
- Goose TUI Ctrl+C handling pattern
- Current cli.ts readline.question pattern (single-line, no history)

**Test scenarios:**
- Happy path: type message, Ctrl+Enter submits, agent receives it
- Happy path: Enter inserts newline in multi-line mode
- Happy path: Ctrl+C during streaming → abort, returns to prompt
- Happy path: Up arrow on empty input → shows previous input
- Edge case: Ctrl+C when idle with empty input → clean exit
- Edge case: Ctrl+C during interrupting state → force exit
- Edge case: submit empty message → no action
- Integration: type → submit → agent runs → type follow-up → follow-up queued

**Verification:** Type multi-line input, submit it. Interrupt agent with Ctrl+C. Navigate input history with arrows. Trigger $EDITOR with Ctrl+E.

---

- [ ] **Unit 7: Command Registry + Palette Overlay**

**Goal:** Implement the command palette overlay with fuzzy search across all registered commands.

**Requirements:** R24, R25, R26, R27

**Dependencies:** Unit 3 (registry exists), Unit 4 (overlay slot exists)

**Files:**
- Create: `packages/tui/src/components/command-palette.tsx` — fuzzy search overlay
- Modify: `packages/tui/src/plugins/command-plugin.ts` — register /help, palette trigger
- Modify: `packages/tui/src/components/app-shell.tsx` — wire overlay slot
- Test: `packages/tui/src/__tests__/command-palette.test.ts`

**Approach:**
- Command palette opens on Ctrl+K or `/` at start of input
- Lists all registered `tui.command` extensions with name + description
- Fuzzy filter as user types (simple substring matching for v1, no external fuzzy library)
- Arrow keys navigate, Enter executes selected command, Escape closes
- `/help` command auto-generated: lists all commands with descriptions
- Plugin commands appear automatically via registry lookup
- Palette is an overlay: renders on top of the main layout, captures keyboard input exclusively while open

**Patterns to follow:**
- OpenCode command palette pattern
- `tui.command` registry from Unit 3

**Test scenarios:**
- Happy path: Ctrl+K opens palette showing all commands
- Happy path: type filter → matching commands shown, select with arrows, Enter executes
- Happy path: Escape closes palette, returns to input
- Edge case: no matching commands → shows "No commands found"
- Integration: plugin registers new command → appears in palette without core changes

**Verification:** Open palette with Ctrl+K, search for a command, execute it. Verify /help lists all commands.

---

- [ ] **Unit 8: Session Persistence + Resume**

**Goal:** Auto-save sessions to disk and provide /resume command with session listing and restore.

**Requirements:** R20, R21, R22, R23

**Dependencies:** Unit 3 (command registry), Unit 4 (overlay slot for session picker)

**Files:**
- Create: `packages/tui/src/plugins/session-plugin.ts` — auto-save + /resume + startup check
- Create: `packages/tui/src/components/session-picker.tsx` — session selection overlay
- Modify: `packages/tui/src/store.ts` — add session ID tracking
- Modify: `packages/tui/src/app.tsx` — startup session detection
- Test: `packages/tui/src/__tests__/session-plugin.test.ts`

**Approach:**
- Each session gets a unique ID (already exists in agent loop: `sess_${Date.now}_*`)
- On `done` or `error` events: serialize message array + metadata (model, start time, first user message) to `@nerax-ai/storage` state directory as JSON
- `/resume` command: list past sessions with first user message + timestamp, arrow-key select, Enter restores
- Session picker is an overlay (reuses overlay slot from app-shell)
- On startup: check for recent sessions. If one exists without a `done` event (crash recovery), offer to resume
- Session restore: replace current message array with saved messages, call `CortxSession.resume()` if last message has pending tool calls
- Auto-cleanup: keep last 50 sessions, delete older ones

**Patterns to follow:**
- `@nerax-ai/storage` state directory pattern (already used in config.ts)
- `CortxSession.resume()` for continuing from tool calls
- Agent loop `skipInitialLlm` option for resuming

**Test scenarios:**
- Happy path: agent completes turn → session file written to state dir
- Happy path: /resume lists past sessions with summaries
- Happy path: select session → messages restored, conversation continues
- Edge case: startup with crashed session → offer to resume
- Edge case: session file is corrupted → graceful error, skip
- Edge case: 50+ sessions → oldest deleted on next save
- Integration: save → exit → restart → resume → continue conversation

**Verification:** Run agent, complete a turn, exit. Restart cortx, run /resume, select session, verify conversation continues.

## System-Wide Impact

- **Interaction graph:** The TUI replaces the only CLI entry point. All user interaction flows through the new Ink app. The agent loop (`loop.ts`) and session model (`session.ts`) are unchanged — they emit the same `AsyncGenerator<AgentEvent>` stream.
- **Error propagation:** Plugin errors (renderers, commands) are caught and logged. Agent errors (from the event stream) display in the output region. Fatal TUI errors (Ink crash) fall back to raw stdout with an error message.
- **State lifecycle risks:** The state store must handle rapid text_delta events without blocking the event loop. Store updates should be synchronous and lightweight. Session auto-save is async and must not block the TUI.
- **API surface parity:** The `CortxPlugin` interface in `packages/sdk/src/index.ts` is unchanged. The new `TuiExtension` types are defined separately in `packages/tui/src/types/tui-plugin.ts`. No existing APIs are modified.
- **Integration coverage:** The full agent turn cycle (turn_start → text_delta → tool_use → tool_result → done) must flow through the TUI without loss. This is verified by the integration test in Unit 1 and the renderer test in Unit 4.
- **Unchanged invariants:** The agent loop's behavior, event types, and plugin hooks remain identical. The TUI is a pure consumer of `AsyncGenerator<AgentEvent>`.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Ink rendering performance under rapid streaming | Each region subscribes to its own state slice; React reconciliation skips unchanged regions |
| Streaming markdown re-render on every text_delta causes flicker | Ink's built-in output diffing minimizes terminal writes; if flicker observed, batch deltas (16ms debounce) |
| $EDITOR handoff may not work on all terminals | Feature degrades gracefully — if terminal release fails, show error and keep inline input |
| Plugin error crashes TUI | All plugin handler invocations wrapped in try/catch with error logging |
| Session file grows large for long conversations | Truncate tool results in session files (already truncated in agent loop at `toolResultBudget`) |
| Ink + Bun compatibility issues | Ink v5 supports Bun; test early in Unit 1 |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-19-tui-refactor-requirements.md](docs/brainstorms/2026-04-19-tui-refactor-requirements.md)
- **Ideation document:** [docs/ideation/2026-04-18-tui-refactor-ideation.md](docs/ideation/2026-04-18-tui-refactor-ideation.md)
- **Current CLI:** `packages/tui/src/cli.ts`
- **Agent loop:** `packages/core/src/loop.ts`
- **Session model:** `packages/core/src/session.ts`
- **Plugin system:** `@nerax-ai/plugin` registry
- **Storage:** `@nerax-ai/storage` state directory
- **Reference TUI:** Goose Ink TUI (`/Users/illuxiza/Gitwork/tools/goose/ui/text/`)
