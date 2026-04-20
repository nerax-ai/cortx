---
title: "feat: Add skill system to cortx agent"
type: feat
status: active
date: 2026-04-20
origin: docs/brainstorms/skill-system-requirements.md
---

# feat: Add skill system to cortx agent

## Overview

Add a skill system to cortx that supports dual activation: programmatic explicit invocation via `/skill-name` message prefix, and runtime auto-matching via a `skill` tool. Skills are SKILL.md files with YAML frontmatter, discovered from `.cortx/skills/` directories. This is a pure `@cortx/core` + `@cortx/sdk` implementation with no TUI dependency.

## Problem Frame

Cortx agents can only inject global system prompts and use plugin hooks — no task-granular instruction loading. Engineering/programmatic users need to load specialized instruction sets on demand and have the agent automatically match skills to tasks. See origin document for full context.

## Requirements Trace

- R1. SKILL.md format with YAML frontmatter (`name`, `description`, optional `arguments`)
- R2. Skill discovery from config paths, `.cortx/skills/` (CWD walk-up), and `~/.cortx/skills/`
- R3. Companion resource file listing (scripts/, references/)
- R4. `/skill-name` prefix triggers explicit pre-parse before LLM
- R5. Argument substitution: `$ARGUMENTS` (all args), `$0`/`$1` (positional)
- R6. Explicit skill content injected as user message
- R7. Skill summary list in system prompt with usage guidance
- R8. `skill` tool for model-triggered on-demand loading
- R9. Context budget control for summary list
- R10. Core-layer only, no TUI dependency
- R11. Skills are Markdown files, no code required from skill authors
- R12. `CortxConfig.skillPaths` for additional discovery paths
- R13. ~~Model override~~ — deferred (see Scope Boundaries)

## Scope Boundaries

- **不做** TUI `/skill` command or skill management UI
- **不做** Fork/sub-agent execution mode
- **不做** Skill-level lifecycle hooks
- **不做** Conditional path activation (`paths:` frontmatter)
- **不做** Remote skill registry (URL pull)
- **不做** Cross-compatible discovery (`.claude/skills/`, `.agents/skills/`)
- **不做** Model override per skill (R13) — the frontmatter schema excludes `model` until this is planned

### Deferred to Separate Tasks

- TUI `/skill` command and skill browser UI: future iteration after core skill system ships
- Model override per skill (R13): requires restructuring `agentLoop` model resolution; deferred to avoid half-built schema

## Context & Research

### Relevant Code and Patterns

- `packages/sdk/src/index.ts` — `Tool`, `CortxPlugin`, `ToolResult`, `AgentEvent` types
- `packages/core/src/loop.ts` — `agentLoop` with `messages.transform` (line 119-122), `system.transform` (line 62-65), plugin tool merging (line 56)
- `packages/core/src/agent.ts` — `Cortx.run()` pushes user message at line 48, then calls `agentLoop`
- `packages/core/src/types.ts` — `CortxConfig` interface to extend with `skillPaths`
- `packages/code/src/index.ts` — Tool factory pattern: `createXxxTool(cwd): Tool`
- Bun runtime provides `Bun.YAML.parse()` for YAML — no external dependency needed

### Key Reference Projects

- Claude Code `src/skills/loadSkillsDir.ts` — skill discovery and frontmatter parsing
- Claude Code `src/tools/SkillTool/SkillTool.ts` — skill tool execution pipeline
- Codex `codex-rs/core/src/skills/injection.rs` — `$skill-name` mention parsing
- Codex `codex-rs/core/src/skills/render.rs` — `render_skills_section()` summary format

## Key Technical Decisions

- **Pre-parse via `messages.transform`**: An internal `CortxPlugin` is auto-injected by `agentLoop` to detect `/skill-name` in the last user message, load skill content, and replace the message. This is deterministic and requires no new hook points in the loop. (see origin document: Key Decisions section)
- **Skill tool auto-registered by core**: `@cortx/core` creates an internal `CortxPlugin` that provides the `skill` tool. Skill authors write no code — R11's "no code" claim means skill authors, not the system. (Resolves review finding: R11 vs R8 contradiction)
- **Project overrides user**: Skill discovery priority is `skillPaths` (lowest) → `~/.cortx/skills/` → `.cortx/skills/` (highest). This reverses the origin document's direction (which had user-level as highest). Rationale: `.editorconfig`/`.eslintrc` conventions establish project-level overrides as the norm — a project's `.cortx/skills/` should take precedence over a user's global skills for that project. The origin document should be updated to match. (Resolves review finding: R2 priority direction)
- **Replace, don't append**: When `/skill-name` is detected, the original user message is replaced with the expanded skill content in both the transformed array (sent to LLM) and the original `messages` array (persisted to `Cortx._messages`). This ensures multi-turn conversation history contains the expanded content, not the raw `/skill-name` prefix. `$ARGUMENTS` carries forward any text after the skill name. No duplicate messages. (Resolves review finding: R6 injection mechanism)
- **Message-start anchored matching**: `/skill-name` is only detected at the start of the message content (`/^\/([a-zA-Z0-9_-]+)/`). The plugin targets the last element of the `messages.transform` input array (which is always the just-pushed user message, since `agentLoop` prepends system messages at index 0). Avoids false positives from natural text like "I used /commit yesterday". (Resolves review finding: multi-turn parsing)
- **Bun built-in YAML**: Use `Bun.YAML.parse()` for frontmatter — no external dependency. If the API changes, fallback to a regex-based frontmatter extractor (split on `---` delimiters, parse the body as the raw text between them). (Resolves review finding: missing YAML parser)
- **`$1`-based positional arguments**: Positional substitution uses `$1` for the first argument, `$2` for the second (not `$0`/`$1`), consistent with shell and template conventions. `$ARGUMENTS` provides the raw unsplit text for multi-word values. Quoting is not supported in this version — use `$ARGUMENTS` for multi-word arguments.
- **Skill plugin cached on Cortx instance**: The skill plugin is stored as `Cortx._skillPlugin` and injected in both `run()` and `continue()`. Skills are discovered once in `run()` and reused in subsequent `continue()` calls.

## Open Questions

### Resolved During Planning

- YAML parser dependency: Bun provides `Bun.YAML.parse()` natively — no external lib needed. Regex fallback available.
- Pre-parse hook point: `messages.transform` internal plugin, runs before every LLM call
- R2 priority direction: reversed to project-overrides-user (overrides origin document; origin should be updated)
- R6 message replacement strategy: replace original message with skill content in BOTH the transformed array and the original messages array (persists to conversation history)
- R11 vs R8 tool registration: core auto-provides `skill` tool via internal plugin
- R13 model override: deferred entirely, removed from frontmatter schema
- Lifecycle hooks contradiction: the "不做" applies to skills declaring hooks; `tool.execute.before` infrastructure is different
- TUI `/` collision: not a blocker since TUI integration is deferred; document for future
- Positional arguments: `$1`-based indexing (not `$0`), consistent with shell conventions
- Skill plugin caching: stored as `Cortx._skillPlugin`, injected in both `run()` and `continue()`
- `messages.transform` array composition: system messages prepended at index 0; target last element for skill detection
- Frontmatter `arguments` field: defines parameter names for documentation/schema purposes (e.g., `["commit message", "scope"]`); does not affect `$N` substitution semantics

### Deferred to Implementation

- Context budget threshold: fixed token limit (e.g., 2000 tokens) vs percentage — implementation detail
- Skill caching strategy: per-CWD cache with invalidation — implementation detail
- Skill name deduplication when multiple paths define the same skill — implementation detail

## Output Structure

```
packages/sdk/src/
  skill.ts              # Skill type, SkillInfo, SkillFrontmatter
  index.ts              # (modified) re-export skill types

packages/core/src/
  skill/
    discover.ts         # Skill discovery (filesystem walk)
    parse.ts            # SKILL.md parsing (frontmatter + body)
    plugin.ts           # Internal CortxPlugin for skill system
    tool.ts             # `skill` tool definition
    substitute.ts       # $ARGUMENTS, $0/$1 substitution
    render.ts           # Skill summary rendering for system prompt
  index.ts              # (modified) re-export skill types
  types.ts              # (modified) add skillPaths to CortxConfig

packages/core/tests/
  skill/
    parse.test.ts       # Frontmatter parsing tests
    discover.test.ts    # Discovery path priority tests
    substitute.test.ts  # Argument substitution tests
    plugin.test.ts      # Integration: pre-parse + system prompt + tool
    e2e.test.ts         # End-to-end integration test
```

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

**Skill system as an internal plugin:** The entire skill system is encapsulated in a single `CortxPlugin` object created by `createSkillPlugin(discoveredSkills)`. This plugin:

1. **`system.transform`**: Appends the skill summary section (names + descriptions + usage guidance) to the system prompt. Respects a context budget.

2. **`messages.transform`**: Inspects the last user message for `/skill-name` prefix. If matched, loads the skill content, performs argument substitution, and replaces the user message with the expanded content.

3. **`tools`**: Provides the `skill` tool that the model can call for auto-matching. Returns full skill content + companion file listing.

The `Cortx` class orchestrates: on `run()`, discover skills, create the plugin, and pass it to `agentLoop` alongside user-provided plugins.

```
Cortx.run(userMessage)
  ├── discoverSkills(cwd, config.skillPaths)
  │     → Scan .cortx/skills/ (CWD→home), ~/.cortx/skills/, config paths
  │     → Parse each SKILL.md → SkillInfo[]
  ├── createSkillPlugin(skills)
  │     → Returns CortxPlugin with:
  │       - system.transform (summary injection)
  │       - messages.transform (/skill-name pre-parse)
  │       - tools: [skillTool]
  └── agentLoop({ ..., plugins: [skillPlugin, ...userPlugins] })
```

## Implementation Units

- [x] **Unit 1: Skill types and parsing**

**Goal:** Define the `Skill` type in `@cortx/sdk` and implement SKILL.md frontmatter parsing in `@cortx/core`.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Create: `packages/sdk/src/skill.ts`
- Modify: `packages/sdk/src/index.ts` (re-export)
- Create: `packages/core/src/skill/parse.ts`
- Create: `packages/core/tests/skill/parse.test.ts`

**Approach:**
- Define `SkillInfo` type: `{ name, description, arguments?, content, dirPath }`
- Parse SKILL.md: extract YAML between `---` delimiters, parse with `Bun.YAML.parse()`, validate `name` and `description` are present. Body is everything after the closing `---`.
- Define `SkillFrontmatter` type: `{ name: string, description: string, arguments?: string[] }`
- The `arguments` field is a documentation/schema hint listing expected parameter names (e.g., `["commit message", "scope"]`). It does not affect `$N` substitution semantics — positional args are always space-split from the invocation text.

**Patterns to follow:** Follow the duck-typed interface pattern from `packages/sdk/src/index.ts` (e.g., `CortxPlugin`).

**Test scenarios:**
- Happy path: parse valid SKILL.md with name, description, and body → returns correct SkillInfo
- Happy path: parse SKILL.md with optional `arguments` field → arguments array populated
- Edge case: SKILL.md with empty body after frontmatter → content is empty string
- Error path: missing `name` in frontmatter → throws/returns error
- Error path: missing `description` in frontmatter → throws/returns error
- Error path: no frontmatter delimiters → throws/returns error
- Edge case: YAML with extra unknown fields → ignored gracefully

**Verification:** All parse tests pass with `bun test`

---

- [x] **Unit 2: Skill discovery**

**Goal:** Walk configured directories to find and deduplicate SKILL.md files, with project-overrides-user priority.

**Requirements:** R2, R12

**Dependencies:** Unit 1

**Files:**
- Create: `packages/core/src/skill/discover.ts`
- Create: `packages/core/tests/skill/discover.test.ts`
- Modify: `packages/core/src/types.ts` (add `skillPaths` to `CortxConfig`)

**Approach:**
- Discovery sources in priority order (low→high): config `skillPaths` → `~/.cortx/skills/` → `.cortx/skills/` (walked from CWD up to home)
- Walk each source directory for `**/SKILL.md` files (max depth 6, following the pattern from Codex)
- Deduplicate by skill name: higher-priority source overwrites lower-priority
- Use `parseSkillFile()` from Unit 1 for each discovered file
- Add `skillPaths?: string[]` to `CortxConfig` in `types.ts`

**Patterns to follow:** Similar to how tools are factory-created in `packages/code/src/index.ts` — a `discoverSkills(cwd: string, config: CortxConfig): Promise<SkillInfo[]>` function.

**Test scenarios:**
- Happy path: single skill directory with one SKILL.md → one skill discovered
- Happy path: multiple directories, same skill name → higher-priority version wins
- Happy path: `skillPaths` config entry → skills found from that path
- Edge case: no `.cortx/skills/` directory exists → no error, empty from that source
- Edge case: `~/.cortx/skills/` doesn't exist → no error
- Edge case: project `.cortx/skills/` overrides user `~/.cortx/skills/` for same name → project version returned
- Edge case: skill directory with nested subdirectories containing SKILL.md → all discovered
- Error path: SKILL.md with invalid frontmatter → error collected, other skills still load

**Verification:** Discovery tests pass; priority override works correctly

---

- [x] **Unit 3: Argument substitution**

**Goal:** Replace `$ARGUMENTS`, `$0`, `$1`, etc. in skill Markdown body with actual values.

**Requirements:** R5

**Dependencies:** Unit 1

**Files:**
- Create: `packages/core/src/skill/substitute.ts`
- Create: `packages/core/tests/skill/substitute.test.ts`

**Approach:**
- Parse `/skill-name arg1 arg2 with spaces` into skill name + argument array via space-splitting
- `$ARGUMENTS` → entire argument string after skill name (raw, not split)
- `$1` → first argument, `$2` → second, etc. (`$1`-based, consistent with shell conventions)
- Substitution only outside fenced code blocks (between `` ``` `` markers)
- If no arguments provided, `$ARGUMENTS` and `$N` resolve to empty string
- Quoting is not supported in this version — `$ARGUMENTS` is the reliable mechanism for multi-word values

**Test scenarios:**
- Happy path: `/commit fix: typo` → `$ARGUMENTS` = "fix: typo", `$1` = "fix:", `$2` = "typo"
- Happy path: skill body with `$ARGUMENTS` in middle of text → correctly replaced
- Happy path: skill body with `$1`, `$2` → correctly replaced
- Edge case: no arguments in invocation → `$ARGUMENTS` and `$N` become empty string
- Edge case: more `$N` references than arguments → excess references become empty string
- Edge case: `$ARGUMENTS` inside a fenced code block → NOT substituted
- Edge case: argument text with special characters → preserved as-is

**Verification:** All substitution tests pass

---

- [x] **Unit 4: Skill summary rendering**

**Goal:** Render discovered skills as a summary section for system prompt injection, with context budget control.

**Requirements:** R7, R9

**Dependencies:** Unit 1

**Files:**
- Create: `packages/core/src/skill/render.ts`

**Approach:**
- Render skill list as: `- name: description` format
- Append usage guidance (modeled after Codex's `render_skills_section()`) instructing the model how/when to call the `skill` tool
- Truncate descriptions if total section exceeds budget (start with 2000 token soft limit)
- When no skills discovered, return empty string (no section injected)

**Test scenarios:**
- Happy path: 3 skills → formatted section with all names and descriptions
- Edge case: 0 skills → empty string
- Edge case: skill description very long → truncated to fit budget
- Happy path: section includes usage guidance for the `skill` tool

**Verification:** Render output is well-formatted and respects budget

---

- [x] **Unit 5: Skill plugin (integration)**

**Goal:** Create the internal `CortxPlugin` that wires together pre-parse, system prompt injection, and the `skill` tool. Integrate with `Cortx` class.

**Requirements:** R3, R4, R6, R7, R8, R10, R11, R12

**Dependencies:** Units 1-4

**Files:**
- Create: `packages/core/src/skill/plugin.ts`
- Create: `packages/core/src/skill/tool.ts`
- Create: `packages/core/tests/skill/plugin.test.ts`
- Modify: `packages/core/src/agent.ts` (wire skill discovery + plugin creation)
- Modify: `packages/core/src/index.ts` (re-export skill types)

**Approach:**
- `createSkillPlugin(skills: SkillInfo[], cwd: string): CortxPlugin` returns a plugin with:
  - `system.transform`: appends rendered skill summary (Unit 4)
  - `messages.transform`: receives `[systemMessage?, ...conversationMessages]` from `agentLoop` (system messages prepended at index 0). Detects `/skill-name` by inspecting the last element of the array (always the just-pushed user message). Performs substitution (Unit 3), replaces the message in the returned array AND mutates the original `messages` array entry so the expansion persists to `Cortx._messages`. If skill not found, injects error message instead.
  - `tools`: provides the `skill` tool
- `skill` tool: `inputSchema: { name: string }`, execute loads the SKILL.md content + lists companion files via filesystem scan (max 10 files). Returns content in a structured text block.
- Modify `Cortx.run()`: before calling `agentLoop`, discover skills, create plugin, store as `this._skillPlugin`, prepend to plugins array
- Modify `Cortx.continue()`: inject `this._skillPlugin` (cached from last `run()`) into the plugins array. No re-discovery.
- Companion files (R3): scan skill directory for non-SKILL.md files, list their paths in tool output. If file-access tools aren't available, paths are still listed but agent may not be able to read them.

**Patterns to follow:** Follow the inline plugin pattern used in existing tests (e.g., `packages/core/tests/loop.test.ts`).

**Test scenarios:**
- Happy path: `/commit fix: typo` in user message → pre-parsed, commit skill content injected, `$ARGUMENTS` replaced with "fix: typo"
- Happy path: model calls `skill({ name: 'review' })` → tool returns full skill content + file listing
- Happy path: system prompt contains skill summary section
- Edge case: `/unknown-skill` → error message injected (skill not found)
- Edge case: `/skill-name` appears mid-sentence ("I used /commit") → NOT matched (only message-start)
- Integration: explicit invocation (`/commit`) and model tool call (`skill({ name: 'review' })`) work in same session
- Edge case: no skills discovered → no summary section, `skill` tool still registered but lists no available skills
- Edge case: skill with companion `scripts/` directory → file paths listed in tool output

**Verification:** Full integration test: create temp skill directory, run agentLoop with `/skill-name` message, verify skill content appears in LLM input and events

---

- [x] **Unit 6: End-to-end validation**

**Goal:** Validate the complete skill system with a realistic skill definition.

**Requirements:** All (R1-R12)

**Dependencies:** Unit 5

**Files:**
- Create: `packages/core/tests/skill/e2e.test.ts`

**Approach:**
- Create a temp directory with `.cortx/skills/test-skill/SKILL.md`
- Create a mock language client that records the messages it receives
- Verify: `system.transform` injects skill summary
- Verify: `/test-skill arg1` triggers pre-parse, message contains expanded content with `arg1`
- Verify: `skill` tool call returns correct content
- Verify: argument substitution works end-to-end

**Test scenarios:**
- Integration: full flow from skill directory discovery through message transformation to LLM input
- Integration: companion files are listed when `skill` tool is called
- Integration: multiple skills in one session, system prompt lists all

**Verification:** E2E test passes, demonstrating the complete skill lifecycle

## System-Wide Impact

- **Interaction graph:** The skill plugin is injected before user plugins in the plugin array. User plugins' `messages.transform` runs after skill pre-parse, so they see the expanded message. User plugins' `system.transform` runs after skill summary injection.
- **Error propagation:** Skill parse errors are collected during discovery (non-fatal). Skill-not-found during pre-parse injects an error message as the user message. Skill tool errors return `ToolResult { success: false, error }`.
- **State lifecycle risks:** Skills are discovered once per `Cortx.run()` call and cached as `Cortx._skillPlugin`. `Cortx.continue()` reuses the cached plugin. If skill files change on disk between calls, the cache may be stale — acceptable for MVP.
- **Message persistence:** The skill plugin's `messages.transform` mutates the original `messages` array entry when replacing `/skill-name` with expanded content. This ensures multi-turn history contains the expanded skill content, not the raw prefix.
- **API surface parity:** `CortxConfig` gains `skillPaths` — additive, non-breaking. `@cortx/sdk` exports new types — additive, non-breaking.
- **Unchanged invariants:** The `agentLoop` function signature does not change. The `Tool` and `CortxPlugin` interfaces do not change. Existing tools, plugins, and TUI commands continue to work identically.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Skill directory scan latency on large project trees | Cap scan depth at 6 levels for all discovery sources; cache skills per `Cortx` instance |
| Large skill summary consuming too much context | Budget control truncates descriptions; start with 2000 token limit |
| `/skill-name` matching false positives | Message-start anchored regex only (`/^\/.../`) |
| Skill file not found at pre-parse time | Inject error message, don't crash the loop |
| Bun.YAML API changes across versions | Pin Bun version; frontmatter parsing is simple enough to fallback to regex |

## Sources & References

- **Origin document:** [docs/brainstorms/skill-system-requirements.md](docs/brainstorms/skill-system-requirements.md)
- **Ideation analysis:** [docs/ideation/skill-system-design.md](docs/ideation/skill-system-design.md)
- Claude Code skill loader: `src/skills/loadSkillsDir.ts`
- Claude Code skill tool: `src/tools/SkillTool/SkillTool.ts`
- Codex skill injection: `codex-rs/core/src/skills/injection.rs`
- Codex skill rendering: `codex-rs/core/src/skills/render.rs`
