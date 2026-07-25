---
date: 2026-04-20
topic: skill-system
---

# Skill System for Cortx Agent

> 历史说明（2026-07-26）：本文是早期 skill 需求记录。当前项目已采用 runtime-host 分层：core 不内置 skill discovery，workspace tools 不再位于 `@cortx/code`。当前 skill/SkillPack 口径见 `docs/architecture/sdk-and-core-extension-guide.md` 与 `docs/progress/2026-07-05-cortx-remaining-work.md`。

## Problem Frame

Cortx 目前没有 skill 系统——agent 只能通过 `CortxConfig.system` 注入全局系统提示和通过 `CortxPlugin` 钩子扩展行为。用户无法按任务粒度加载专业化的指令集。

工程化场景（非 TUI）下，需要两种激活模式：
1. **程序化主动调用** — 在定制流程中明确触发特定 skill
2. **运行时自动匹配** — agent 根据任务上下文自动识别并加载合适的 skill

## Requirements

**Skill 定义与发现**

- R1. Skill 以 `SKILL.md` 文件定义，包含 YAML frontmatter（`name`, `description`, 可选的 `arguments`, `model`）和 Markdown 指令体。
- R2. Skill 发现路径（按优先级从低到高）：配置的 `skillPaths` 目录 → 项目 `.cortx/skills/`（从 CWD 向上遍历）→ 用户 `~/.cortx/skills/`。高优先级路径的同名 skill 覆盖低优先级。
- R3. Skill 目录可包含伴随资源文件（如 `scripts/`、`references/`），系统在加载 skill 时列出这些文件路径供 agent 按需访问。

**显式调用**

- R4. 用户消息中的 `/skill-name` 前缀触发显式调用。系统在发送 LLM 前预解析，保证确定性触发。
- R5. 显式调用支持参数传递：`/skill-name arg1 arg2`，skill 指令体中的 `$ARGUMENTS` 和命名参数（如 `$0`, `$1`）被替换为实际值。
- R6. 显式调用的 skill 内容作为 user message 注入对话，模型遵循该指令执行任务。

**运行时自动匹配**

- R7. 系统提示中注入所有已发现 skill 的摘要列表（名称 + 描述），格式参考 Codex 的 `render_skills_section()` 模式，附带使用指导。
- R8. Agent 通过 `skill` 工具按需加载完整 skill 内容。模型判断任务匹配时调用 `skill({ name: 'xxx' })`，工具返回完整指令 + 伴随文件列表。
- R9. 摘要列表有上下文预算控制，避免大量 skill 时占用过多上下文窗口。

**与现有架构集成**

- R10. Skill 系统集成到 `@cortx/core` 的 `agentLoop` 中，不依赖 `@cortx/tui`。类型定义扩展 `@cortx/sdk`。
- R11. Skill 加载与现有 `CortxPlugin` 机制解耦——skill 是独立的轻量概念（Markdown 文件），不要求编写代码。
- R12. `CortxConfig` 新增 `skillPaths?: string[]` 配置项，用于指定额外的 skill 发现路径。
- R13. Skill frontmatter 中的 `model` 字段可覆盖该 skill 执行时使用的模型（可选能力，非 MVP 必须）。

## Success Criteria

- 用户通过 `for await (const event of cortx.run('/commit'))` 能确定性触发 `commit` skill
- Agent 在收到 "帮我审查这段代码" 时能自动调用 `review` skill（如果已发现）
- Skill 指令体中的 `$ARGUMENTS` 被正确替换
- 多个 skill 同时存在时，系统提示的摘要列表不超过合理上下文预算
- 不引入 `@cortx/tui` 依赖，纯 core 层实现

## Scope Boundaries

- **不做** 跨兼容发现（不扫描 `.claude/skills/`、`.agents/skills/` 等）
- **不做** TUI 层的 skill UI（`/skill` 命令面板、skill 管理界面）——留给后续迭代
- **不做** Fork/子 agent 执行模式——显式和自动都走 inline 注入
- **不做** 生命周期钩子（skill 级别的 `PreToolUse`/`PostToolUse`）——留给后续迭代
- **不做** 条件路径激活（`paths:` frontmatter 触发）——留给后续迭代
- **不做** 远程 skill 仓库（URL 拉取）——留给后续迭代

## Key Decisions

- **工具模式（非文件读取模式）**：采用 Claude Code 的工具按需加载模式，而非 Codex 的"模型自己读文件"模式。原因：cortx 的代码工具（`@cortx/code`）不一定在所有场景可用，专门的 `skill` 工具不依赖文件读取能力。
- **提及语法用 `/` 前缀**：与 Claude Code 一致使用 `/skill-name`，而非 Codex 的 `$skill-name`。原因：`/` 前缀在消息中更直观，且 `$` 在某些上下文中是环境变量语法。
- **预解析显式调用**：`/skill-name` 在 LLM 调用前由 agent loop 拦截解析，不依赖模型判断。原因：程序化使用需要确定性保证。
- **渐进加载指导**：系统提示中的 skill 摘要附带使用指导（参考 Codex 的 `render_skills_section()`），教模型如何按需加载和协调多个 skill。

## Dependencies / Assumptions

- 依赖 `@cortx/sdk` 中已有的 `Tool`、`CortxPlugin`、`AgentEvent` 类型
- 依赖 `@cortx/core` 中的 `agentLoop` 和 `Cortx` 类的现有钩子点（`system.transform`、`messages.transform`）
- 假设 skill 目录结构为 `<skill-name>/SKILL.md`，与 Claude Code / Codex 一致

## Outstanding Questions

### Deferred to Planning

- [Affects R2][Technical] Skill 发现时的缓存策略——是否按 CWD 缓存、何时刷新
- [Affects R7][Technical] 摘要列表的上下文预算具体数值——参考 Claude Code 的 1% 策略还是固定 token 数
- [Affects R8][Needs research] `skill` 工具的权限模型——是否复用现有 `CortxPlugin` 的 `tool.execute.before` 钩子
- [Affects R13][Technical] model 覆盖的实现方式——是否需要修改 `agentLoop` 的模型选择逻辑

## Next Steps

-> `/ce:plan` for structured implementation planning
