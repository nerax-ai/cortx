---
date: 2026-04-18
topic: agent-core-loop-comparison
focus: Compare cortx and claude-code core agent loops, identify features to add to cortx and areas where cortx already excels
---

# Ideation: Cortx vs Claude Code Agent Core Loop

## Codebase Context

**cortx** is a minimal agent framework (~260-line core loop) using an async generator pattern with a clean plugin hook system, provider-agnostic LLM abstraction (`@synax-ai/core`), and 7 basic tools. Its architecture prioritizes simplicity, composability, and extensibility.

**claude-code** is a production-grade coding agent (~100KB core loop) with a 5-stage context compaction chain, parallel tool execution, model fallback/retry, sub-agent spawning with worktree isolation, token budget management, a full permission system, and 40+ tools. Its architecture prioritizes robustness and feature completeness.

**Key architectural differences:**
- cortx: async generator yielding events, plugin hooks at well-defined points, provider-agnostic
- claude-code: imperative loop with deeply interleaved orchestration, Anthropic-specific, React-based state management
- cortx: 260 lines, ~7 tools, no context management
- claude-code: ~100KB, ~40 tools, 5-stage compaction + retry + fallback

**Where cortx already excels:**
- Provider-agnostic LLM abstraction (claude-code is Anthropic-bound)
- Clean async generator architecture (claude-code's loop is imperative and mixed-concern)
- Plugin-first extensibility (claude-code hardcodes what cortx makes pluggable)
- AgentController with steer/followUp/abort (claude-code has no clean equivalent)
- 260 lines of readable core vs 100KB (a significant maintainability advantage)

## Ranked Ideas

### 1. Composable Tool Middleware Pipeline
**Description:** Extend cortx's existing `tool.execute.before/after` hooks into a full middleware chain with error/finally hooks, short-circuit capability, and composable ordering. Every cross-cutting concern (retry, permission gating, logging, metrics, rate limiting) becomes a plugin rather than a core loop change.
**Rationale:** Single highest-leverage addition. All 4 ideation agents independently converged on this. cortx already has the right hooks — the gap is small but the payoff is massive. Retry logic (which claude-code built 15+ code paths for) becomes a 20-line plugin. Permission gating becomes a plugin. Result budget enforcement becomes a plugin. cortx's 260 lines stay 260 lines while the capability set grows unboundedly.
**Downsides:** Requires defining a clean middleware interface and ordering semantics. A poorly designed middleware system can be worse than none.
**Confidence:** 95%
**Complexity:** Medium
**Status:** Unexplored
**Cortx advantage:** claude-code has ~100KB of hardcoded retry, permission, and recovery logic that cannot be refactored into this pattern.

### 2. Plugin-Based Context Window Management
**Description:** Emit a `context.overflow` event when token usage crosses a configurable threshold. Plugins handle compression strategy (summarization, sliding window, event-sourced projection). The core loop never compresses — it only signals.
**Rationale:** Context overflow is the #1 failure mode in long agent sessions. claude-code built a 5-stage compaction chain (snip→micro→auto→collapse→reactive) spanning thousands of lines. cortx's `messages.transform` hook is already at exactly the right injection point. A single plugin can handle the entire problem.
**Downsides:** Plugin authors must implement high-quality compression. Requires a token counter (can be approximate).
**Confidence:** 90%
**Complexity:** Medium
**Status:** Unexplored
**Cortx advantage:** claude-code cannot make its compression optional — it's deeply woven into query.ts. cortx makes it pluggable and replaceable.

### 3. Parallel Tool Execution with Declarative Safety
**Description:** Add a `sideEffects: 'none' | 'read' | 'write' | 'destructive'` field to tool definitions. When the LLM returns multiple tool calls, execute tools with `sideEffects: 'none'` or `'read'` in parallel. Serialize everything else. No thread pool, no scheduler needed.
**Rationale:** cortx executes tools sequentially in a `for` loop (loop.ts:187). When the LLM requests 5 file reads, cortx is 5x slower than it needs to be. All 4 agents flagged this. The declarative approach means tool authors express intent once, and scheduling happens automatically.
**Downsides:** Requires tool authors to correctly declare side effects. Parallel safety under complex interactions can be hard to reason about.
**Confidence:** 90%
**Complexity:** Low
**Status:** Unexplored
**Cortx advantage:** claude-code hardcodes a `canRunInParallel` whitelist. cortx can do it cleanly via metadata.

### 4. Streaming Tool Execution (Async Generator Composition)
**Description:** Allow tools to return async generators, not just values. The core loop `yield*`s tool output directly into the event stream. Long-running tools (builds, web scraping) emit progress in real-time. Cancellation is just closing the generator.
**Rationale:** cortx currently buffers all progress messages and only emits them after the tool finishes (loop.ts:216 vs 235-238). The user sees nothing during execution. cortx's async generator architecture makes this a natural extension — tools already live in a yield-based world.
**Downsides:** Requires updating the tool interface. Existing tools need minimal changes.
**Confidence:** 85%
**Complexity:** Low
**Status:** Unexplored
**Cortx advantage:** claude-code built streaming tool execution as a special case with dedicated infrastructure. cortx's generator composition is architecturally natural.

### 5. Sub-Agent as Tool (Not Core Primitive)
**Description:** Define "spawn agent" as a standard tool. The tool receives a prompt, runs a nested `agentLoop()`, and returns results. The parent treats it like any other tool call. Worktree isolation, if needed, is a plugin concern, not core.
**Rationale:** All 4 agents independently agreed on this: sub-agents should be a tool. claude-code has a 233KB AgentTool with worktree management, lifecycle coordination, and multi-agent syncing. cortx's plugin/tool architecture means this can be added with zero core loop changes.
**Downsides:** Pushes context scoping, result aggregation, and resource limiting to the plugin author. Needs some guard against spawning 100 sub-agents unboundedly.
**Confidence:** 80%
**Complexity:** Medium
**Status:** Unexplored
**Cortx advantage:** cortx's `agentLoop()` is already a standalone function with its own message array and controller — nesting it is trivial. claude-code's sub-agents are tightly coupled to React state and permissions.

### 6. Thinking Preservation Across Turns
**Description:** When the model produces thinking/reasoning content, include it in the message history sent on subsequent turns. Currently, `thinkingBuffer` is emitted as an event but silently discarded from the `messages` array (loop.ts:177-183).
**Rationale:** This is a bug, not a feature request. Extended-thinking models (Claude, DeepSeek) need to see their prior reasoning to maintain coherence. cortx already captures thinking deltas — it just doesn't persist them. The fix is adding thinking content when pushing to messages. A ~5-line fix.
**Downsides:** Thinking tokens can be large, increasing context size. Should be gated behind a config flag or provider capability check.
**Confidence:** 95%
**Complexity:** Low
**Status:** Unexplored

### 7. Structured Error Types (Typed Terminal States)
**Description:** Replace the generic `{ type: 'error'; error: Error }` with typed variants: `context_overflow`, `rate_limited`, `max_iterations`, `user_abort`, `tool_failure`, each with recovery hints.
**Rationale:** Currently every failure produces the same error event. A consumer (TUI, API server, SDK user) cannot programmatically decide whether to retry, compact, switch models, or rephrase. claude-code has a `Terminal` return type with structured exit reasons. cortx's `AgentEvent` union is already discriminated by `type` — adding subtypes is a non-breaking extension.
**Downsides:** Requires all consumers to handle new subtypes. Must design the type taxonomy carefully.
**Confidence:** 85%
**Complexity:** Low
**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Retry with exponential backoff | Subsumed by middleware pipeline (#1) — retry becomes a plugin |
| 2 | Permission via event hooks | Already covered by `tool.execute.before` — just needs deny/escalate return value |
| 3 | Event-sourced agent memory | Interesting but not table-stakes. Lower priority than context management (#2) |
| 4 | Controller-as-middleware | Promising but speculative. Current controller works for known use cases |
| 5 | Controller strategy pattern | Premature abstraction — no evidence of needing multiple strategies yet |
| 6 | Event replay/checkpointing | Premature optimization. Nice-to-have, not table-stakes |
| 7 | Hot-swappable prompt strategy | `system.transform` already does this. Not enough delta |
| 8 | Zero-orchestration loop (pure reduction) | Too abstract/academic. Not actionable as a product improvement |
| 9 | Dynamic tool registration | Already works via plugins. Not a distinct feature |
| 10 | Capability discovery via metadata | Premature at 7 tools. Revisit at 30+ |
| 11 | Tool result size budget | Subsumed by context management plugin (#2) |
| 12 | Tool timeout/cancellation | Subsumed by streaming tools (#4) — AbortSignal is part of tool execution |
| 13 | Token budget auto-continue | Subsumed by context management (#2) — auto-continue is a compression trigger |
| 14 | Context prefetch | Premature. Requires domain-specific knowledge. Not grounded |
| 15 | Explicit non-goals declaration | Not a technical improvement. Valuable governance, not a codebase change |
| 16 | Streaming-native retry (resume-from-checkpoint) | Overlaps with middleware pipeline (#1). Can be implemented as a plugin if needed |

## Compounding Dependency Map

```
Middleware Pipeline (#1)
  ├── makes Retry trivial (20-line plugin)
  ├── makes Permission Gating trivial (plugin)
  ├── makes Metrics/Logging trivial (plugin)
  └── makes Streaming Tools (#4) cleaner

Context Management (#2)
  ├── prevents the #1 production failure mode
  ├── enables Sub-Agent (#5) to manage nested context
  └── complements Structured Errors (#7) with overflow signal

Sub-Agent as Tool (#5)
  ├── enabled by Parallel Execution (#3) for concurrent sub-agents
  └── enables hierarchical task decomposition
```

## Session Log
- 2026-04-18: Initial ideation — 39 raw candidates generated across 4 agents, 23 deduped, 7 survived adversarial filtering
