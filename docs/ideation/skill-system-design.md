---
title: Skill System Design for Cortx
created: 2026-04-20
status: active
focus: Comparative analysis of skill systems across claude-code, codex, opencode, openclaw; design recommendation for cortx
---

# Skill System Comparative Analysis & Cortx Design Recommendation

> 历史说明（2026-07-26）：本文是早期 skill system 设计稿。当前语义是：Skills 是 `SKILL.md` 文件系统资产，不要求作者写 JavaScript plugin code；skill discovery、summary injection、slash expansion 和 `skill` tool 位于 `@cortx/runtime` 的 official skills capability，而不是 `@cortx/core` 或已删除的 `@cortx/code`。

## 1. Four Projects' Skill Systems

### 1.1 Claude Code

**Architecture:** SKILL.md (YAML frontmatter + Markdown) injected into conversation as user messages.

**Discovery hierarchy (6 sources, priority order):**
1. Bundled skills (compiled into binary, TypeScript `BundledSkillDefinition`)
2. Built-in plugin skills (toggleable via `/plugin`)
3. File-based skills (`.claude/skills/` walked up to home + `~/.claude/skills/`)
4. Plugin skills (namespaced `plugin-name:skill-name`)
5. MCP skills (provided by MCP servers)
6. Legacy `.claude/commands/` (backward compat)

**Frontmatter schema (rich):** `name`, `description`, `allowed-tools`, `when_to_use`, `arguments`, `model` (override), `context` (inline/fork), `agent`, `hooks`, `paths` (conditional activation), `effort`, `shell`, `version`.

**Execution model:**
- **Inline** (default): Skill body injected as user message, argument substitution (`$ARGUMENTS`, named `$foo`), inline shell execution via `!\`cmd\`` syntax
- **Forked** (`context: fork`): Runs as isolated sub-agent via `runAgent()`, gets its own context window

**Pros:**
- Most mature and feature-rich skill system
- Conditional activation via `paths:` (skill auto-activates when matching files are touched)
- Forked execution enables isolation for complex skills
- Model/effort override per skill
- Lifecycle hooks integration (`PreToolUse`, `PostToolUse`, `Stop`)
- Budget-aware prompt generation (truncates descriptions to fit 1% of context)
- `skillify` bundled skill lets users capture sessions into reusable SKILL.md

**Cons:**
- Complex: 6 source types with subtle precedence rules
- Heavy TypeScript codebase (~800+ lines just for skill loading)
- Forked execution adds latency and context duplication
- System prompt injection via skill listing competes for context budget
- The `Skill` tool (model-facing) and `/skill` slash command have overlapping concerns

---

### 1.2 Codex CLI (OpenAI)

**Architecture:** SKILL.md (YAML frontmatter + Markdown) + companion `agents/openai.yaml` for rich metadata. Rust implementation.

**Discovery hierarchy (4 scopes):**
1. Repo (`.codex/skills/` or `.agents/skills/` walked up from CWD)
2. User (`$CODEX_HOME/skills/`, `$HOME/.agents/skills/`)
3. System (`$CODEX_HOME/skills/.system`)
4. Admin (`/etc/codex/skills/`)

**Dual metadata model:**
- `SKILL.md` frontmatter: `name`, `description`, `metadata.short-description`
- `agents/openai.yaml`: `interface` (display_name, icons, brand_color, default_prompt), `dependencies.tools` (MCP tool deps), `policy` (allow_implicit_invocation), `permissions` (network/filesystem/macos)

**Execution model:** Skills are injected into the system prompt as instructions. The agent decides when to use them based on the task.

**Implicit invocation:** `invocation_utils.rs` builds path indexes from skill scripts/references, and the agent can invoke skills implicitly when a user's task matches.

**Pros:**
- Clean separation: SKILL.md for content, openai.yaml for metadata/interface
- Strong permission model (per-skill network, filesystem, seatbelt profiles)
- MCP tool dependency declaration (skill can declare it needs specific MCP tools)
- Implicit invocation via path indexing
- Companion resources: `references/` (knowledge), `scripts/` (executable Python)
- Validation with size limits (name 64 chars, description 1024 chars, scan depth 6)

**Cons:**
- No explicit user invocation (no `/skill-name` command)
- Rust implementation means skill loading is tightly coupled to the runtime
- The openai.yaml metadata file is easy to misplace or forget
- No argument substitution in SKILL.md body
- Skills can't override model or execution context

---

### 1.3 OpenCode

**Architecture:** SKILL.md (YAML frontmatter + Markdown) loaded via a `skill` Tool. TypeScript.

**Discovery (4 layers, project overwrites global):**
1. External global (`.claude/skills/`, `.agents/skills/` under `$HOME`)
2. External project (walked up from CWD)
3. `.opencode/skill/` or `.opencode/skills/` (config directories)
4. Config `skills.paths` + `skills.urls` (remote skill discovery)

**Frontmatter schema (simple):** `name`, `description`, `model` (e.g., `opencode/kimi-k2.5`), `color`, `subtask`.

**Execution model:** Model calls the `skill` tool -> loads SKILL.md content -> returns as tool output in `<skill_content>` block with file listing. The model then follows the loaded instructions.

**Also has "agents" and "commands":**
- `.opencode/agent/*.md` - Role-based prompt templates (e.g., "expert technical documentation writer")
- `.opencode/command/*.md` - Task-specific prompts with `!\`cmd\`` shell execution (e.g., commit, issues)

**Pros:**
- Simplest implementation (~190 lines for skill loading)
- Cross-compatible: reads `.claude/skills/` and `.agents/skills/` (interoperability)
- URL-based skill discovery (pull from remote registries)
- Permission-gated: skills filtered by agent permissions before exposure to model
- Companion files automatically discovered via ripgrep
- Agent/command distinction is clean and easy to understand

**Cons:**
- No argument substitution in skill content
- No conditional activation (always loaded, never dormant)
- No forked execution or sub-agent spawning
- Skills are model-triggered only (no user slash-command invocation)
- Simple frontmatter means no tool permissions, hooks, or model override
- The agent/command/skill split is conceptually muddy (all are just prompts)

---

### 1.4 OpenClaw

**Architecture:** 5-layer extensibility model - the most ambitious system.

| Layer | Format | Capability |
|-------|--------|------------|
| Pi Extensions | `.pi/extensions/*.ts` | Commands, lifecycle hooks, TUI rendering |
| Pi Prompts | `.pi/prompts/*.md` | Simple prompt templates with `$ARGUMENTS` |
| OpenClaw Plugins | `extensions/` (jiti) | registerTool, registerHook, registerProvider, etc. |
| OpenClaw Skills | `skills/SKILL.md` | Instruction packs in system prompt |
| Built-in Extensions | TypeScript (compiled) | compaction-safeguard, context-pruning |

**Plugin API surface (23 lifecycle hooks):** `before_model_resolve`, `llm_input`, `llm_output`, `tool_result_persist`, `session_start`, `subagent_spawning`, etc.

**Discovery (6 sources, workspace > personal > managed > bundled):**
1. Config extra dirs
2. Bundled skills (55 skills)
3. Managed/local (`~/.openclaw/skills`)
4. Personal agent skills (`~/.agents/skills`)
5. Project agent skills (`<workspace>/.agents/skills`)
6. Workspace skills (`<workspace>/skills`)

**Pros:**
- Most powerful extensibility model - code extensions, not just prompts
- Full plugin API with typed lifecycle hooks
- Skills are instruction packs (lightweight) while plugins are code (heavyweight) - clean separation
- jiti for TypeScript plugin loading (no build step)
- TUI rendering from extensions (interactive terminal UIs)
- Built-in extensions for advanced features (compaction safeguard, context pruning)

**Cons:**
- Highest complexity by far (5 distinct extensibility layers)
- Pi SDK dependency creates coupling to upstream
- The `.pi/` vs `extensions/` vs `skills/` split is confusing for users
- TypeScript extensions run arbitrary code (security surface)
- No clear migration path between layers (when does a skill become a plugin?)

---

## 2. Comparative Matrix

| Feature | Claude Code | Codex | OpenCode | OpenClaw |
|---------|-------------|-------|----------|----------|
| **Format** | SKILL.md + frontmatter | SKILL.md + openai.yaml | SKILL.md + frontmatter | SKILL.md (instruction pack) |
| **User invocation** | `/skill-name` | No | No (model-triggered) | Via Pi commands |
| **Model invocation** | Skill tool | System prompt injection | skill tool | System prompt injection |
| **Argument substitution** | `$ARGUMENTS`, `$name` | No | No | `$ARGUMENTS` |
| **Model override** | Yes | No | Yes | No |
| **Tool permissions** | Per-skill `allowed-tools` | Per-skill permission profile | Agent permissions only | Plugin registration |
| **Conditional activation** | `paths:` frontmatter | Implicit via path index | No | No |
| **Forked execution** | `context: fork` | No | No | Via Pi sub-agents |
| **Shell execution** | `` !`cmd` `` inline | Python scripts | `` !`cmd` `` inline | Via Pi `exec()` |
| **Remote discovery** | No | No | URL-based | No |
| **Plugin integration** | Yes (skills in plugins) | Yes (plugin skill roots) | No | Yes (full plugin API) |
| **Lifecycle hooks** | Per-skill hooks | No | No | 23 hook points |
| **Implementation** | TypeScript | Rust | TypeScript | TypeScript |
| **Complexity** | High | Medium | Low | Very High |

---

## 3. Design Recommendation for Cortx

### 3.1 Where to add the skill system

Cortx has a clean layered architecture:
- `@cortx/sdk` - Types and interfaces
- `@cortx/core` - Agent loop and session management
- `@cortx/code` - Built-in tools
- `@cortx/tui` - Terminal UI with command plugin

**Recommendation: Add skill support at TWO layers:**

1. **`@cortx/sdk`** - Define `Skill` type, `SkillLoader` interface, and `CortxPlugin` skill-related extensions
2. **`@cortx/core`** - Implement skill discovery, loading, and injection into the agent loop
3. **`@cortx/tui`** - Add `/skill` command and skill listing in the command palette

This mirrors cortx's existing pattern: types in sdk, logic in core, UI in tui.

### 3.2 Recommended Design

#### Phase 1: Core Skill System (start here)

**Format:** SKILL.md with YAML frontmatter + Markdown body.

```yaml
---
name: my-skill
description: What this skill does
model: optional-model-override
arguments: [arg1, arg2]
---
Skill instructions as Markdown body.
Supports $ARGUMENTS and $arg1 substitution.
```

**Discovery (3 sources, simplest that works):**
1. Project: `.cortx/skills/**/SKILL.md` (walked up from CWD)
2. User: `~/.cortx/skills/**/SKILL.md`
3. Config: `skills.paths` in cortx config

**Execution model:**
- Skills inject content via the `system.transform` plugin hook (already exists in `CortxPlugin`)
- Or better: add a dedicated `skill` tool that the model calls on demand (like OpenCode)
- Companion files (scripts, references) auto-discovered and listed

**Invocation:**
- User: `/skill-name` in TUI (via existing command plugin system)
- Model: Via a `skill` tool definition

#### Phase 2: Enhanced Features

- **Argument substitution** (`$ARGUMENTS`, named params)
- **Inline shell execution** (`` !`cmd` `` syntax)
- **Model override** per skill
- **Conditional activation** via `paths:` frontmatter
- **Skill metadata** (icons, descriptions for TUI display)

#### Phase 3: Advanced (optional)

- **Remote skill discovery** (URL-based, like OpenCode)
- **Cross-compatible skill loading** (read `.claude/skills/` and `.agents/skills/` too)
- **Forked execution** for complex skills

### 3.3 What to take from each project

| Take from | What | Why |
|-----------|------|-----|
| **OpenCode** | Simple skill loader + `skill` tool pattern | Cortx's closest architectural match; easy to implement |
| **Claude Code** | Frontmatter schema, argument substitution, conditional activation | Most mature feature set; well-tested patterns |
| **Codex** | Companion resources pattern (references/, scripts/), size validation | Clean separation of skill content vs supporting materials |
| **OpenClaw** | Nothing directly | Too complex; cortx already has its own plugin system |

### 3.4 Key Design Decisions

**Decision 1: Skill as tool vs. system prompt injection**

- **Tool (recommended):** Model calls `skill` tool -> loads content -> follows instructions
  - Pros: Lazy loading (only uses context when needed), explicit, model decides
  - Cons: Requires an LLM call before skill content is available
- **System prompt injection:** All skill descriptions injected into system prompt
  - Pros: Always available, no extra tool call
  - Cons: Wastes context budget, all skills always loaded

**Recommended: Tool-based with system prompt listing.** Inject only skill names/descriptions (like Claude Code's budget-aware listing), load full content on demand via tool.

**Decision 2: Where skills live in the plugin system**

Cortx already has `CortxPlugin` with hooks. Skills should be a **separate concept** that integrates with plugins:
- A plugin CAN provide skills (via `plugin.skills`)
- A skill can exist without a plugin (standalone SKILL.md)
- Skills use the existing `system.transform` hook for injection

**Decision 3: Execution context**

Start with inline only (content injection). Forked execution can be added later if needed. Cortx doesn't currently have sub-agent infrastructure, so forking would require significant new code.

---

## 4. Surviving Ideas (Ranked)

### Idea 1: Minimal Skill Tool (Highest Priority)
**What:** Add a `skill` tool to `@cortx/code` that loads SKILL.md files on demand. Add discovery logic to `@cortx/core`. Add `/skill` command to TUI.
**Why:** This is the foundation everything else builds on. Simplest possible starting point.
**Evidence:** OpenCode's ~190-line implementation proves this can be minimal and functional.

### Idea 2: Cross-Compatible Skill Discovery
**What:** Also scan `.claude/skills/` and `.agents/skills/` directories so cortx can use skills authored for Claude Code and Codex.
**Why:** Reduces friction for users migrating from other tools. OpenCode does this successfully.
**Evidence:** OpenCode's `EXTERNAL_DIRS = [".claude", ".agents"]` pattern.

### Idea 3: Argument Substitution & Shell Execution
**What:** Support `$ARGUMENTS` and named `$param` substitution in skill Markdown, plus `` !`cmd` `` inline shell execution.
**Why:** Makes skills significantly more powerful and reusable. Both Claude Code and OpenCode support this.
**Evidence:** Claude Code's `argumentSubstitution.ts` and OpenCode's command format both use this.

### Idea 4: Skill-Provided Tools
**What:** Allow skills to declare tool dependencies or provide their own tools (like Codex's `dependencies.tools`).
**Why:** Skills that need MCP tools or custom tooling can express this requirement.
**Evidence:** Codex's `SkillToolDependency` model.

### Idea 5: Conditional Skill Activation
**What:** Skills with `paths:` frontmatter stay dormant until matching files are touched.
**Why:** Prevents context pollution from irrelevant skills while keeping them discoverable.
**Evidence:** Claude Code's `activateConditionalSkillsForPaths()`.

### Idea 6: Remote Skill Registry
**What:** Config option to pull skills from URLs (like OpenCode's `skills.urls`).
**Why:** Enables shared skill libraries across teams without git submodules.
**Evidence:** OpenCode's `Discovery.pull(url)`.

---

## Session Log

- 2026-04-20: Initial analysis completed. Researched claude-code, codex, opencode, openclaw skill systems. Analyzed cortx architecture. Generated 6 ranked ideas.
