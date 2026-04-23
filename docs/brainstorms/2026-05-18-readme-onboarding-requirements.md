---
date: 2026-05-18
topic: readme-onboarding-documentation
---

# README & Onboarding Documentation

## Problem Frame

cortx has zero onboarding documentation. There is no README.md, no getting-started guide, no architecture overview, and no AI agent instruction file (AGENTS.md). Every new user — whether evaluating the framework for adoption or joining as a contributor — must read source code to understand what the project is, how it works, or how to use it. This is the single biggest adoption and contribution barrier.

The project is well-structured (~9K lines, clean 4-package monorepo, async generator architecture) but this structure is invisible without documentation.

## Requirements

**Project README (README.md)**

- R1. README.md exists at the project root and serves as the primary entry point for anyone encountering the repository
- R2. Includes a concise project description: what cortx is (agent framework), what it's for (building coding agents with LLMs), and what makes it distinct (async generator architecture, provider-agnostic, plugin-first)
- R3. Includes an architecture overview showing the 4-package monorepo structure (`@cortx/sdk`, `@cortx/core`, `@cortx/code`, `@cortx/tui`) with a brief description of each package's responsibility and the dependency relationships between them
- R4. Includes a quick start guide covering: prerequisites (Bun runtime), installation (`bun install`), configuration (provider setup in `cortx.json`), and running the TUI (`bun run packages/tui/src/cli.tsx` or `cortx` binary)
- R5. Documents how to write a plugin: explains the 7 plugin hooks (`messages.transform`, `system.transform`, `tool.execute.before`, `tool.execute.after`, `error.recover`, `context.overflow`, `event`), shows a minimal plugin example, and explains registration via config
- R6. Documents how to write a skill: explains the SKILL.md format (YAML frontmatter with `name`, `description`, `arguments` + markdown body), shows a minimal skill example, explains discovery (`.cortx/skills/` directories), and covers argument substitution
- R7. Documents how to use cortx programmatically (headless/SDK mode): shows creating a `Cortx` instance, registering tools, and consuming the `AsyncGenerator<AgentEvent>` stream without the TUI
- R8. Includes a development section: build (`bun run build`), test (`bun test`), lint (`bun run lint`), format (`bun run format`), and clean (`bun run clean`)
- R9. Lists the key external dependencies and their roles: `@synax-ai/core` (LLM provider abstraction), `@synax-ai/sdk` (language client types), `@nerax-ai/plugin` (plugin registry), `@nerax-ai/storage` (config/state persistence), `@nerax-ai/logger` (logging), Ink (TUI rendering)

**AI Agent Instructions (AGENTS.md)**

- R10. AGENTS.md exists at the project root and provides structured instructions for AI coding assistants (Claude, Copilot, etc.) working on the codebase
- R11. Documents the package structure and import conventions so AI agents know where to find and add code
- R12. Documents the testing patterns (test file location, test runner, assertion style) so AI agents generate tests that match existing conventions
- R13. Documents the coding conventions: TypeScript strict mode, ES modules, async generator patterns, and the plugin hook interface
- R14. Lists known gotchas and architectural constraints (e.g., `@synax-ai` packages are linked not published, TUI uses Ink + React 19, skill discovery walks CWD-to-home)

## Success Criteria

- A developer with no prior cortx knowledge can read README.md and understand what the project is and how its pieces fit together
- A developer can follow the quick start guide to get a working cortx TUI running
- A developer can write and register a custom plugin by following the plugin documentation
- An AI coding assistant given AGENTS.md can correctly navigate the codebase and generate code that follows project conventions

## Scope Boundaries

- No tutorial or walkthrough — the README links to concepts, not step-by-step lessons
- No API reference — types are documented via TypeScript declarations, not prose
- No changelog or version history
- No deployment or distribution guide (npm publish, Docker, etc.) — the project is pre-release
- No architecture decision records (ADRs) — may be added later as the project matures
- AGENTS.md does not replace skill files — it documents the codebase structure for AI assistants, not skill instructions

## Key Decisions

- **Two-file approach (README.md + AGENTS.md):** README serves human newcomers; AGENTS.md serves AI-assisted development. Both are standard patterns in well-documented agent projects. Low carrying cost, high leverage.
- **Include programmatic usage (R7):** Even though the headless mode isn't fully packaged yet, the `Cortx` class and `agentLoop()` are already public. Documenting usage now establishes the API surface and prevents breaking changes later.
- **Link dependency packages, not vendor docs:** `@synax-ai` and `@nerax-ai` packages are locally linked (not published). The README documents their roles but doesn't link to external docs that don't exist.

## Outstanding Questions

### Deferred to Planning

- [Affects R4][Technical] Exact quick start commands depend on whether `cortx` binary is installable via `bunx` or must be run from source — planner should verify the intended distribution method
- [Affects R5][Technical] Plugin example should use a real hook — planner should choose which hook makes the best minimal example
- [Affects R10][Needs research] AGENTS.md format is not standardized — planner should check if any convention exists in the `@synax-ai` or `@nerax-ai` ecosystem

## Next Steps

-> `/ce:plan` for structured implementation planning
