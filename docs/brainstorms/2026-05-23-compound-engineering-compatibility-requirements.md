---
date: 2026-05-23
topic: compound-engineering-compatibility
---

# Compound Engineering Skill Pack Compatibility

## Problem Frame

cortx 已经具备基础 skill 系统和通用 sub-agent 能力，但目前还不能完整运行 Compound Engineering 这类大型工程工作流集合。

关键点不在于 cortx 是否能启动 sub-agent，而在于 Compound Engineering 的核心能力依赖一组可复用的 **agent set**：这些 agent 不是新的运行时类型，而是一批带有元数据的角色提示文件，例如 `ce-correctness-reviewer`、`ce-security-reviewer`、`ce-repo-research-analyst`。skill 在执行时需要能按名称调度这些角色，并继承它们的模型偏好、工具范围、输出格式和任务边界。

因此 cortx 的目标不是原生识别某个具体平台的 plugin manifest，也不是把 Compound Engineering 做成特殊分支；目标是补齐一个通用的 **skill pack** 能力：任何来源的内容最终都安装成普通 `SKILL.md`、相关资源文件、可选 agent 定义文件和少量通用运行约束。运行时只理解这套通用资产模型。

## Definitions

**Skill**

以 `SKILL.md` 定义的任务级指令。skill 负责描述什么时候使用、怎么执行、需要读取哪些参考文件、是否要调度 agent、最终产出什么。

**Related files**

skill 目录下的 `references/`、`scripts/`、模板、示例、校验脚本等伴随文件。它们不是独立能力，但必须能被 skill 按需发现和读取。

**Agent definition**

一个可复用的 sub-agent 角色定义文件，通常包含 frontmatter 和正文提示。frontmatter 可描述：

- `name`：agent 的稳定调用名
- `description`：什么时候应该使用这个 agent
- `model`：模型偏好，支持 `inherit` 表示继承当前会话模型
- `tools`：允许或期望使用的工具集合
- `color` 或其他 UI 元数据：仅作为展示信息，不影响核心执行

agent definition 的正文是该 agent 的系统提示、方法论、输出格式和边界约束。

**Agent set**

一组 agent definition 的集合。它不是运行时能力本身；运行时能力仍然是 cortx 已有的 sub-agent loop。agent set 只是让 sub-agent 从“通用执行器”变成“命名角色执行器”。

**Skill pack**

一组可安装资产的集合，包括 skills、related files、agents 和可选的 pack 元数据。Compound Engineering 可以被转换或安装成一个 skill pack，但 cortx 运行时不需要识别 `.codex-plugin/plugin.json` 或 `.claude-plugin/plugin.json`。

## Requirements

**资产模型**

- R1. cortx 必须继续支持普通 `SKILL.md` 作为 skill 的最小单元。
- R2. cortx 必须允许一个 skill pack 同时包含多个 skill、相关文件和 agent definition。
- R3. cortx 运行时不直接依赖 Codex、Claude、Cursor 等平台的 plugin manifest。外部 plugin 可以通过安装器转换成 cortx 的普通 skill pack 目录。
- R4. skill pack 的目录结构应尽量直观，允许迁移 Compound Engineering 这类项目时保留 `skills/`、`agents/`、`references/`、`scripts/` 等自然组织方式。
- R5. 同名 skill 或 agent 的覆盖规则必须确定，优先级应与现有 skill 发现策略一致：项目级覆盖用户级，显式配置路径可参与优先级排序。

**Skill 加载**

- R6. skill 发现不能因为单个 `SKILL.md` 大于 64KB 而静默失去核心能力。大型 skill 应可被发现，并在真正加载时再受上下文预算控制。
- R7. skill 摘要注入应保持轻量，只注入名称、描述和使用方式；完整内容通过 `skill` 工具按需加载。
- R8. `skill` 工具返回完整 skill 内容时，必须列出相关文件，并允许 agent 按需读取这些文件。
- R9. skill 内容中的 `$ARGUMENTS`、位置参数等替换能力需要继续保留。
- R10. skill 显式调用和自动匹配都必须使用同一套加载逻辑，避免 `/skill-name` 和 `skill` 工具行为分叉。

**Agent set 支持**

- R11. cortx 必须能发现并解析 agent definition 文件。
- R12. cortx 必须提供“按名称启动 agent”的能力。调用方可以指定 agent 名称、任务 prompt、是否后台执行、是否只读、并发上限等运行参数。
- R13. 命名 agent 启动时，应把 agent definition 正文作为 sub-agent 的系统提示或系统提示的一部分。
- R14. agent frontmatter 中的 `model: inherit` 应继承当前 cortx 配置；明确模型名只作为偏好，是否允许切换由运行环境决定。
- R15. agent frontmatter 中的 `tools` 应能映射到 cortx 当前工具集合。不存在的工具不能导致整个工作流崩溃，应清晰报告缺失能力。
- R16. agent definition 不应强制绑定 Compound Engineering。其他项目也能用同样格式定义自己的 named agents。
- R17. skill 不需要把所有 agent 属性内联配置在自身 frontmatter 中。推荐模型是 skill 调度命名 agent，agent 自己携带角色属性。只有确实需要临时覆盖时，skill 调度参数再覆盖少量运行选项。

**工具兼容层**

- R18. cortx 需要一层通用工具别名映射，使跨平台 skill 中的 `Read`、`Write`、`Edit`、`Bash`、`Grep`、`Glob`、`LS` 能可靠映射到 cortx 的 `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls` 等工具或等价能力。
- R19. 工具映射应以能力为中心，而不是硬编码某个插件。比如 `Glob` 可以映射到 `find` 或未来更专门的文件发现工具。
- R20. 缺失能力必须显式暴露给模型和用户，例如 Browser、Proof、Xcode、Slack、GitHub CLI、MCP 工具不可用时，skill 应能降级或说明跳过原因。
- R21. 只读工具应继续允许并发执行；写工具和破坏性工具必须保持有序和可控。

**用户交互**

- R22. cortx TUI 必须实现真实的阻塞用户提问能力。不能继续默认回答 `yes`。
- R23. 用户提问能力需要支持文本回答、单选、多选和取消。
- R24. skill 中提到的 `AskUserQuestion`、`request_user_input`、`ask_user` 等平台能力，应统一映射到 cortx 的交互抽象。
- R25. 在非交互或 headless 场景中，必须有明确策略：自动选择默认项、失败退出、或由调用方预置答案。

**任务跟踪与编排**

- R26. cortx 需要一个轻量 task tracking 抽象，用于支持 `ce-plan`、`ce-work`、`lfg` 等流程中的阶段、任务状态和进度更新。
- R27. task tracking 不必复制 Codex 的 `update_plan` 形态，但必须能表达待办、进行中、完成、阻塞等基础状态。
- R28. sub-agent 并发应作为一等能力保留。很多工程流需要并行只读探索、并行 review persona、agent team 分工，而不是串行化。
- R29. 并发 agent 必须支持隔离：至少包括独立消息历史、独立工具结果、独立日志 namespace，以及可选的只读工具策略。
- R30. background agent 的结果必须可查询、可汇总、可失败恢复，不能只返回“已启动”后丢失上下文。

**外部集成**

- R31. Browser、Proof、Xcode、Slack、GitHub 等能力不应进入 skill 核心模型，但 cortx 需要可插拔的 capability registry。
- R32. skill 或 agent 请求外部能力时，运行时应能回答“可用、不可用、需要认证、需要安装、当前环境不支持”。
- R33. 对 Compound Engineering 来说，缺少外部集成时允许部分 workflow 降级，但必须清楚记录哪些步骤被跳过。

**安装与更新**

- R34. cortx 不直接识别 plugin marketplace 作为运行时模型，但可以提供安装器把远程仓库、压缩包或本地目录转换为 skill pack。
- R35. 安装器可以读取 `.codex-plugin/plugin.json`、`.claude-plugin/plugin.json` 或其他 manifest 作为输入线索，但转换后的结果必须是 cortx 通用资产。
- R36. 安装结果应支持版本记录、更新、卸载和冲突检测。
- R37. 安装器不能把平台专用残留混入运行时目录，例如过期的旧 skill 名称、重复 alias、无效 symlink。

## Success Criteria

- Compound Engineering 的核心 skill 名称可以按官方当前名称被发现，例如 `ce-brainstorm`、`ce-plan`、`ce-code-review`、`ce-work`、`ce-commit`。
- 大于 64KB 的核心 skill 不会被跳过。
- `ce-code-review` 能调度多个命名 reviewer agent，并汇总它们的结果。
- `ce-plan` 能在需要时调度 repo research、document review、feasibility review 等命名 agent。
- TUI 中遇到 skill 的阻塞问题时，用户能真实选择，而不是自动 `yes`。
- 缺少 Browser、Proof、Slack、Xcode 等外部能力时，workflow 能明确降级或停止，并说明原因。
- 普通第三方项目也可以按同一结构安装自己的 skill pack 和 agent set，不需要伪装成 Compound Engineering。

## Scope Boundaries

- **不做** 将 Compound Engineering 写死成 cortx 内置功能。
- **不做** 运行时直接依赖 `.codex-plugin/plugin.json`、`.claude-plugin/plugin.json` 或某个平台 marketplace。
- **不做** 要求每个 skill 内联配置所有 agent 属性。agent 属性应属于 agent definition。
- **不做** 一次性实现所有外部集成。先提供 capability registry 和清晰降级。
- **不做** 因为部分 workflow 需要并发而放弃安全边界。并发和隔离需要同时存在。
- **不做** 为兼容旧版本地 `.cortx/skills` 中的历史命名增加长期兼容层。当前项目可清理旧内容，保持结构干净。

## Key Decisions

- **统一成 skill pack，而不是 plugin runtime**：cortx 运行时只理解普通 skills、agents 和相关文件。plugin manifest 只属于安装器输入。
- **agent set 是角色定义集合，不是新的执行器**：cortx 现有 sub-agent loop 继续负责执行；agent set 负责给 sub-agent 提供命名角色、工具边界和输出契约。
- **skill 调度 agent，agent 自带属性**：skill 只需要说“启动哪个 agent 做什么任务”。agent 的模型、工具、角色提示、输出格式由 agent definition 管理。
- **能力映射优先于平台映射**：兼容 `Read`、`AskUserQuestion`、`TaskCreate` 等平台词汇时，映射到 cortx 的能力抽象，而不是复制某个平台 API。
- **缺失能力显式化**：大型 workflow 可以降级，但不能假装执行成功。

## Current Gaps Observed

- `packages/core/src/skill/discover.ts` 当前有 64KB `SKILL.md` 大小限制，会跳过官方 `ce-code-review` 这类大型 skill。
- `packages/core/src/agent.ts` 当前只提供通用 `agent` 工具，没有 named agent registry，也不会加载 `agents/*.md`。
- `packages/tui/src/cli.tsx` 当前 `askUser` 默认返回 `yes`，不能满足交互型 skill 的要求。
- `packages/core/src/loop.ts` 已支持只读工具并发和连续 agent 调用并发，但缺少 agent 属性、只读 agent 策略和结果编排层。
- `packages/code` 提供小写基础代码工具，但缺少跨平台工具名和能力名映射。
- 当前 `.cortx/skills` 中存在历史转换命名，与官方 Compound Engineering 当前 skill 名称不完全一致。

## Dependencies / Assumptions

- 依赖现有 `Cortx`、`agentLoop`、`CortxPlugin`、`Tool` 和 `AgentController` 抽象继续作为核心运行层。
- 依赖 nerax plugin/storage/logger 的基础能力保持稳定，用于后续安装、日志隔离和状态管理。
- 假设安装器可以把不同来源的插件内容转换成 cortx skill pack，不要求 cortx core 自己拉取远程仓库。

## Open Questions

### Resolve Before Planning

- agent definition 文件应放在 skill pack 根目录的 `agents/`，还是允许每个 skill 目录下局部 `agents/`？推荐先支持 pack 根目录 `agents/`，必要时再加局部覆盖。
- named agent 的调用接口是扩展现有 `agent` 工具，还是新增 `agent_run` / `agent` 参数 `name`？推荐扩展现有 `agent`，避免多套 sub-agent 工具。

### Deferred to Planning

- 工具别名映射的具体配置位置。
- task tracking 的最小数据结构和 UI 展示方式。
- capability registry 的类型定义。
- skill pack 安装目录、版本记录和卸载策略。
- 大型 skill 的上下文预算和分段加载策略。

## Next Steps

-> `/ce-plan` for structured implementation planning
