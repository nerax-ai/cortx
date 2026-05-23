---
title: "feat: Agent parallel batching, background execution, and TUI viewer"
type: feat
status: active
date: 2026-04-25
---

# feat: Agent parallel batching, background execution, and TUI viewer

## Overview

Enhance cortx's sub-agent system with three capabilities: (1) guide the LLM to batch multiple independent agent calls in a single response, (2) support background agent execution that returns immediately while the agent works asynchronously, and (3) a TUI viewer that lets users drill into any agent's execution flow to see its thinking, text output, tool calls, and results in real-time.

## Problem Frame

The agent tool currently runs sub-agents as opaque black boxes. The TUI only sees `tool_progress` strings and the final `tool_result`. When multiple agents run, they execute sequentially because the LLM returns one agent call per turn. Users cannot inspect what a sub-agent actually did — no visibility into its reasoning, tool usage, or intermediate steps.

Reference: Claude Code solves (1) by explicitly instructing the LLM in the system prompt to batch independent agent calls. It solves (2) with a `run_in_background` parameter on the Agent tool. OpenCode demonstrates (3) by letting users navigate into sub-agent execution views.

## Requirements Trace

- R1. LLM returns multiple agent tool_calls in a single response when tasks are independent
- R2. Agent tool supports `run_in_background` mode — returns immediately, agent runs asynchronously
- R3. Sub-agent events (text, thinking, tool calls, results) are captured and stored
- R4. TUI can display a sub-agent's full execution flow in a dedicated view
- R5. Background agents emit completion notifications visible in the TUI
- R6. Agent viewer works for both foreground (completed) and background (live) agents

## Scope Boundaries

- No recursive nesting — sub-agents still cannot spawn their own sub-agents
- No inter-turn agent queuing — batching is limited to within a single LLM response
- No agent result ordering guarantee across parallel/background agents
- No persistence of sub-agent events to disk (in-memory only for this iteration)
- Agent viewer is read-only — users cannot steer or interact with a viewed sub-agent

### Deferred to Separate Tasks

- Agent result ordering (P2 from prior review): results arrive in phase order, not original toolCalls order
- Sub-agent event persistence and session replay
- Steering/interaction with viewed sub-agents

## Context & Research

### Relevant Code and Patterns

- `packages/core/src/loop.ts` — 3-phase tool execution: Phase 1 groups by sideEffects, Phase 2 runs read-only in parallel, Phase 3 runs write/destructive serially with agent batching via `Promise.allSettled`
- `packages/core/src/agent.ts` — `Cortx` class creates the agent tool as a closure in `createAgentTool()`. The tool's `execute()` runs a full `agentLoop()` and collects text output. Sub-agent events are currently discarded.
- `packages/core/src/session.ts` — `CortxSession` wraps `Cortx`, broadcasts events to listeners via `subscribe()`. The TUI subscribes here.
- `packages/sdk/src/index.ts` — `AgentEvent` discriminated union (15 types), `Tool`, `ToolResult`, `ToolContext`, `CortxPlugin` types
- `packages/tui/src/store.ts` — `TuiStore` ingests `AgentEvent` via `dispatch()`, selector-based subscriptions with `useSyncExternalStore`
- `packages/tui/src/types/tui-state.ts` — `TuiState`, `ToolCallEntry`, `TurnEntry` type definitions
- `packages/tui/src/renderer.ts` — `processEvent()` routes events to store, flush, and renderer extensions
- `packages/tui/src/types/tui-plugin.ts` — `tui.region`, `tui.renderer`, `tui.keybind`, `tui.command` extension types
- Prior plan: `docs/plans/2026-04-24-007-feat-parallel-tool-and-agent-execution-plan.md` — established sideEffects-based parallel execution and agent batching

### Key Insight: Event Capture Architecture

The core enabler for both background execution and the agent viewer is **capturing sub-agent events in a shared store**. Currently, the agent tool's `execute()` iterates `agentLoop()` events and discards everything except the final text. The plan introduces a `SubAgentSession` object that collects all events during execution and is accessible to both the agent tool (writer) and the TUI (reader).

### Institutional Learnings

- `processEvent()` was dead code for weeks — always verify pipelines are wired (Plan 003)
- `Promise.allSettled` over `Promise.all` for parallel execution — one failure must not cancel siblings
- `maxConcurrentAgents` must be clamped to min 1 to prevent infinite loops

## Key Technical Decisions

- **Sub-agent event storage**: A `Map<string, SubAgentSession>` on the `Cortx` instance, keyed by `toolCallId`. The agent tool writes to it during execution. The TUI reads from it via `session.cortx`. This avoids polluting the parent event stream with sub-agent events while keeping the data accessible.
- **Background completion notification**: The agent tool receives an `onComplete` callback (set by `CortxSession`). When a background agent finishes, it calls this callback, which emits a notification through the normal event stream.
- **Agent viewer reuse**: The viewer reuses the same rendering approach as the main OutputRegion/ToolRegion but reads from a `SubAgentSession`'s events instead of the main `TuiState`. This avoids duplicating rendering logic.
- **System prompt guidance over inter-turn queuing**: Like Claude Code, we instruct the LLM to batch agent calls rather than implementing complex cross-turn queuing. This is simpler, matches LLM behavior, and has zero carrying cost.

## Open Questions

### Resolved During Planning

- How to route sub-agent events without polluting the parent stream? → Separate `SubAgentSession` map, not parent event stream
- Where does the event store live? → On `Cortx` instance, accessible via `session.cortx.agentSessions`
- How does the viewer get events for background agents? → Same `SubAgentSession` map — background agents write to it in real-time

### Deferred to Implementation

- Exact keybinding for entering/exiting agent viewer (suggest Shift+A or Enter on focused agent in ToolRegion)
- Throttling strategy for live background agent event rendering in the viewer
- Whether to cap stored events per sub-agent to limit memory usage

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Data Flow

```
LLM response with 3 agent tool_calls
  ↓
loop.ts Phase 3: detect batch → Promise.allSettled
  ↓
agent tool execute() for each:
  ├─ Create SubAgentSession in cortx.agentSessions
  ├─ Emit agent_started event to parent stream
  ├─ Run agentLoop()
  │   ├─ Each yielded event → push to SubAgentSession.events[]
  │   └─ If background: return immediately, loop continues async
  ├─ Emit agent_completed event to parent stream
  └─ SubAgentSession.status = 'completed'
  ↓
TuiStore receives agent_started / agent_completed
  → Updates agentSessionIndex in TuiState
  ↓
User presses keybind on agent in ToolRegion
  → TuiState.activeAgentView = toolCallId
  → AgentViewer reads SubAgentSession.events
  → Renders output + tool calls from sub-agent's perspective
```

### SubAgentSession Structure

```
SubAgentSession {
  toolCallId: string
  description: string
  status: 'running' | 'completed' | 'error'
  events: AgentEvent[]
  output: string
  iterations: number
  toolCallCount: number
  isBackground: boolean
  startedAt: number
  completedAt?: number
}
```

### New AgentEvent Variants

Three new event types for agent lifecycle tracking — lightweight summaries that flow through the normal event stream:

```
agent_started    → { toolCallId, description }
agent_progress   → { toolCallId, text }
agent_completed  → { toolCallId, output, iterations, toolCallCount, isError }
```

The TuiStore handles these to maintain an index of active/completed agents. Full event details live in SubAgentSession.

### Agent Viewer State

```
TuiState additions:
  agentSessions: Map<string, AgentSessionSummary>  // lightweight index
  activeAgentView: string | null                    // toolCallId or null (main)
```

When `activeAgentView` is set, the AppShell renders `AgentViewer` instead of the main `OutputRegion`. The viewer reads the full event list from `cortx.agentSessions.get(activeAgentView)` and renders using the same text/tool rendering components.

## Implementation Units

- [ ] **Unit 1: Agent tool description for batch calling**

**Goal:** Update the agent tool's description to instruct the LLM to batch independent agent calls in a single response, following Claude Code's approach.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `packages/core/src/agent.ts`

**Approach:**
Expand the agent tool's `description` field to explicitly state that multiple agent calls can be issued in parallel when tasks are independent. Include guidance like: "When launching multiple independent sub-agents, issue all agent tool_calls in a single response so they execute concurrently." This is a description-only change — no code logic changes.

**Patterns to follow:**
- Claude Code's system prompt approach: explicit instruction to batch parallel calls
- The tool description is the LLM's primary source of behavioral guidance

**Test scenarios:**
- Test expectation: none — description text change only, no behavioral logic

**Verification:**
- Agent tool description contains explicit batching guidance
- LLM responses show multiple agent tool_calls when given independent tasks (manual verification)

---

- [ ] **Unit 2: SubAgentSession and event capture infrastructure**

**Goal:** Create the `SubAgentSession` type and `agentSessions` map on `Cortx`. Modify the agent tool to capture all sub-agent events into a session during execution.

**Requirements:** R3

**Dependencies:** None (parallel with Unit 1)

**Files:**
- Create: `packages/core/src/sub-agent-session.ts` — SubAgentSession class and types
- Modify: `packages/core/src/agent.ts` — inject event capture into agent tool execute()
- Modify: `packages/sdk/src/index.ts` — add `agent_started`, `agent_progress`, `agent_completed` event types to AgentEvent union
- Test: `packages/core/src/__tests__/sub-agent-session.test.ts`

**Approach:**
1. Define `SubAgentSession` class with push/complete/query methods and an internal `events: AgentEvent[]` buffer
2. Add `agentSessions: Map<string, SubAgentSession>` to the `Cortx` class
3. Modify `createAgentTool()` to create a session before running `agentLoop()`, push each yielded event into the session
4. Emit `agent_started` before the loop begins and `agent_completed` after it ends — these flow through the parent event stream as lightweight notifications
5. During execution, `agent_progress` events are emitted periodically (reusing the existing `ctx.reportProgress` messages)

**Patterns to follow:**
- `agentLoop()` is an async generator — iterate with `for await` and capture each event
- `CortxSession.subscribe()` pattern for event broadcasting

**Test scenarios:**
- Happy path: agent tool creates session, captures events, marks complete — verify session has all events in order
- Multiple agents: two concurrent agent calls each create separate sessions — verify events are isolated
- Error path: sub-agent throws mid-execution — verify session is marked as error, captured events up to failure are preserved
- Edge case: agent with 0 iterations (immediate completion) — verify session still created and completed

**Verification:**
- `cortx.agentSessions` contains entries for each sub-agent run
- Each entry has the correct status, all events, and final output
- New event types compile and flow through the event pipeline

---

- [ ] **Unit 3: Background agent execution**

**Goal:** Add `run_in_background` parameter to the agent tool. When true, the agent starts executing asynchronously and the tool returns immediately with a reference ID.

**Requirements:** R2, R5

**Dependencies:** Unit 2 (SubAgentSession infrastructure)

**Files:**
- Modify: `packages/core/src/agent.ts` — add `run_in_background` to inputSchema, implement non-blocking path
- Modify: `packages/core/src/session.ts` — add `onAgentComplete` callback wiring
- Test: `packages/core/src/__tests__/agent-background.test.ts`

**Approach:**
1. Add `run_in_background: { type: 'boolean', description: '...' }` to agent tool's inputSchema
2. In `execute()`: when `run_in_background` is true, start the `agentLoop()` in a fire-and-forget promise (do not await it). Return immediately with `{ success: true, output: "Background agent started (ID: {toolCallId})" }`
3. The fire-and-forget promise continues running the loop, pushing events to the SubAgentSession
4. When the background agent completes, invoke the `onComplete` callback (set by `CortxSession`) which broadcasts an `agent_completed` event to the parent stream
5. `CortxSession` sets the `onComplete` callback on the `Cortx` instance when it's created

**Key constraint:** Background agents are still subject to `maxConcurrentAgents`. The loop-level batching in Phase 3 already handles concurrent agents via `Promise.allSettled`. For background agents, the loop starts the agent and immediately creates a tool result — the LLM doesn't wait.

**Patterns to follow:**
- Fire-and-forget promise pattern: `(async () => { ... })()` without awaiting
- `onComplete` callback pattern for cross-concern notification

**Test scenarios:**
- Happy path: background agent starts, execute returns immediately, agent completes later — verify SubAgentSession is populated
- Multiple background agents: 3 background agents started in parallel — verify all 3 run concurrently, all 3 complete
- Background + foreground mix: 1 background + 1 foreground agent — foreground blocks, background runs alongside
- Error path: background agent throws — verify session marked as error, notification emitted
- Edge case: parent loop continues while background agent is still running — verify no interference

**Verification:**
- Agent tool returns immediately when `run_in_background` is true
- SubAgentSession shows live status for background agents
- Completion notification appears in the event stream

---

- [ ] **Unit 4: TUI agent session state management**

**Goal:** Add agent session tracking to `TuiState` and `TuiStore`. Handle the new `agent_started`, `agent_progress`, `agent_completed` events.

**Requirements:** R4, R6

**Dependencies:** Unit 2 (new event types)

**Files:**
- Modify: `packages/tui/src/types/tui-state.ts` — add `AgentSessionSummary`, `agentSessions`, `activeAgentView` to TuiState
- Modify: `packages/tui/src/store.ts` — handle new event types in dispatch(), add view navigation methods
- Test: `packages/tui/src/__tests__/store-agent-sessions.test.ts`

**Approach:**
1. Define `AgentSessionSummary` type with `toolCallId`, `description`, `status`, `isBackground`, `iterations`, `toolCallCount`
2. Add `agentSessions: Map<string, AgentSessionSummary>` and `activeAgentView: string | null` to `TuiState`
3. In `TuiStore.dispatch()`:
   - `agent_started` → create entry in agentSessions
   - `agent_progress` → update progress text on entry
   - `agent_completed` → update status, iterations, toolCallCount
4. Add `setActiveAgentView(toolCallId: string | null)` method to `TuiStore`
5. Add selectors: `selectAgentSessions`, `selectActiveAgentView`

**Patterns to follow:**
- Existing `dispatch()` switch/case pattern for new event types
- Selector-based subscription pattern from existing code

**Test scenarios:**
- Happy path: agent_started → agent_progress → agent_completed — verify summary is created, updated, and finalized
- Multiple agents: 3 concurrent agents — verify all 3 tracked independently
- View navigation: setActiveAgentView("id") sets it, setActiveAgentView(null) clears it
- Edge case: agent_completed without prior agent_started — verify graceful handling (skip unknown)
- State isolation: switching agent view doesn't affect main state (messages, toolCalls)

**Verification:**
- TuiState includes agentSessions map and activeAgentView
- Store correctly tracks agent lifecycle from start to completion
- Selectors return the right slices

---

- [ ] **Unit 5: TUI AgentViewer component**

**Goal:** Create the AgentViewer component that renders a sub-agent's execution flow. Integrate it into the AppShell with view switching.

**Requirements:** R4, R6

**Dependencies:** Unit 4 (TuiState agent session support)

**Files:**
- Create: `packages/tui/src/components/agent-viewer.tsx` — AgentViewer component
- Modify: `packages/tui/src/components/app-shell.tsx` — conditionally render AgentViewer when activeAgentView is set
- Modify: `packages/tui/src/components/tool-region.tsx` — add "view" action on agent entries
- Test: `packages/tui/src/__tests__/agent-viewer.test.tsx`

**Approach:**
1. `AgentViewer` component reads `SubAgentSession` events from `session.cortx.agentSessions.get(activeAgentView)`
2. Renders a header bar showing: agent description, status, iteration count, tool call count, and "Press Escape to return"
3. Below the header, reuses the same rendering approach as `OutputRegion` (text, thinking) and `ToolRegion` (tool calls with progress/results) but sourced from the sub-agent's event list
4. For running agents: subscribes to updates (re-render on new events) using a timer or selector subscription
5. `AppShell` conditionally renders `AgentViewer` instead of `OutputRegion` + `ToolRegion` when `activeAgentView` is set
6. Escape key exits the viewer (calls `store.setActiveAgentView(null)`)
7. In `ToolRegion`, when an agent tool entry is focused/selected, pressing Enter opens the viewer for that agent

**Patterns to follow:**
- `useSyncExternalStore` for subscribing to SubAgentSession updates
- Existing `ToolRegion` rendering patterns for tool call display
- Escape key handling pattern from existing input components

**Test scenarios:**
- Happy path: completed agent with 3 tool calls — viewer shows all text, thinking, and tool call details
- Live agent: background agent still running — viewer updates as new events arrive
- Empty agent: agent with no text output — viewer shows "no output" gracefully
- Navigation: Enter on agent in ToolRegion opens viewer, Escape returns to main view
- Multiple agents: view one agent, go back, view another — verify correct data shown each time

**Verification:**
- Agent viewer displays correct sub-agent execution details
- Navigation in and out of viewer works smoothly
- Live background agents update in real-time within the viewer

## System-Wide Impact

- **Interaction graph:** The agent tool's `execute()` method changes from synchronous to potentially asynchronous (background mode). The loop's Phase 3 agent batching needs to handle the case where execute() returns immediately — the tool result is ready without waiting.
- **Error propagation:** Sub-agent errors are captured in SubAgentSession and surfaced via `agent_completed` with `isError: true`. They do not crash the parent loop.
- **State lifecycle risks:** SubAgentSession objects accumulate in memory. A cap should be considered (deferred to implementation). Background agents that never complete (hanging) will leave sessions in `running` state forever.
- **API surface parity:** The new event types (`agent_started`, `agent_progress`, `agent_completed`) are additive — no existing event types change. `CortxPlugin` hooks that switch on event type will simply not match these new types (safe backward compatibility).
- **Integration coverage:** The new event types flow through `processEvent()` → `store.dispatch()` → renderer extensions. Plugins that subscribe to all events will see them. Plugins that only handle specific types won't be affected.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| LLM ignores batching guidance, still returns one agent per turn | Batching is best-effort. System prompt guidance is the industry-standard approach. Future: inter-turn queuing if needed |
| Background agents consume unbounded memory | Cap events per session (deferred to implementation). Limit concurrent background agents |
| Agent viewer performance with live background agents | Throttle re-renders (e.g., 100ms intervals). Only re-render visible content |
| New event types break existing plugins | Additive only — no existing types modified. Plugins that don't handle new types are unaffected |
| SubAgentSession on Cortx creates tight coupling with TUI | The session map is on Cortx (core package), TUI reads it. This is acceptable — TUI already depends on core |

## Sources & References

- Related code: `packages/core/src/agent.ts` (agent tool), `packages/core/src/loop.ts` (3-phase execution), `packages/tui/src/store.ts` (TuiStore)
- Prior plan: `docs/plans/2026-04-24-007-feat-parallel-tool-and-agent-execution-plan.md`
- Reference: Claude Code's system prompt approach to agent batching
- Reference: OpenCode's agent execution viewer pattern
