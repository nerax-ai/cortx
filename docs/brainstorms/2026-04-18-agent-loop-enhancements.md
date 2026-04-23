---
date: 2026-04-18
topic: agent-loop-enhancements
---

# Agent Loop 核心增强

## Problem Frame

cortx 的 `agentLoop()` 是一个 260 行的 async generator，设计简洁、插件优先。但在生产使用中有几个关键缺陷：

1. **Thinking 内容丢失**：推理模型（Claude thinking、DeepSeek）产生的 thinking 内容只作为事件发出，不存入消息历史，下一轮模型看不到自己的推理
2. **错误即死亡**：任何 LLM 错误（503、速率限制、上下文溢出）直接终止循环，没有恢复机会
3. **输出静默截断**：模型输出达到 token 上限时，`finishReason` 被忽略，用户看到不完整的回复
4. **上下文溢出无处理**：长会话必然溢出上下文窗口，但循环直接崩溃
5. **工具结果无限制**：一个大文件读取就能撑爆上下文
6. **错误类型不可区分**：所有失败都是同一个 `error` 事件，调用者无法程序化处理

对比 claude-code 的 query loop（~1500 行），cortx 不需要 5 层压缩管线或复杂的状态机，但需要**最小必要能力**保证生产可用，同时保持插件可覆盖的设计哲学。

## Requirements

**Bug 修复（Tier 1）**

- R1. Thinking 内容必须保留在消息历史中。当 provider 产生 reasoning-delta 时，累积的 thinking 内容应包含在 assistant 消息的 content 中，作为 thinking 类型的 content block 传递给下一轮 LLM 调用。仅在 provider/模型支持 thinking 时保留。
- R2. `error` 事件必须携带结构化的 `code` 字段，区分以下场景：`context_overflow`、`rate_limited`、`max_iterations`、`user_abort`、`stream_error`。`code` 为可选字段，保持向后兼容。
- R3. 当 LLM 返回的 `finishReason` 指示输出被截断时（如 `'length'`），循环必须自动注入一条继续消息并重新调用 LLM，让模型接上被截断的内容。自动继续最多 2 次，超过后正常发出 done 事件。使用现有的 `controller.followUp()` 机制实现。

**健壮性增强（Tier 2）**

- R4. LLM 流式调用失败时，循环必须检查错误是否可恢复（速率限制、服务端 5xx）。如果是可恢复错误，等待 1 秒后自动重试，最多重试 1 次。插件可通过新的 `error.recover` 钩子覆盖此默认行为——如果插件注册了该钩子，由插件决定是否重试。
- R5. 当 LLM 调用因上下文过长失败时，循环必须发出 `context.overflow` 事件并调用新的 `context.overflow` 插件钩子，传入当前消息数组。如果插件返回压缩后的消息，循环使用压缩后的消息重试 LLM 调用。如果插件返回 null 或未注册，循环发出 error 事件并终止。
- R6. 工具执行结果超过默认阈值（10KB）时，循环必须自动截断结果，保留前后各 4KB，中间插入截断标记。此截断发生在 `tool.execute.after` 钩子之前，插件可通过 `tool.execute.after` 进一步修改。

**插件系统扩展（Tier 2）**

- R7. 新增 `error.recover` 插件钩子。签名：`(event: AgentEvent) => Promise<{ retry: boolean, delay?: number }>`。当 LLM 流式错误发生时调用。如果插件返回 `{ retry: true }`，循环等待指定延迟后重试。如果无插件注册，使用 R4 的默认策略。
- R8. 新增 `context.overflow` 插件钩子。签名：`(messages: LanguageMessage[]) => Promise<LanguageMessage[] | null>`。当上下文溢出时调用。如果插件返回新的消息数组，循环用它重试。如果返回 null，循环终止。

## Success Criteria

- 一个 50+ 轮的长对话不会因上下文溢出而静默崩溃（前提是注册了 context.overflow 插件，或至少发出结构化的 context_overflow 错误）
- 推理模型（Claude thinking、DeepSeek）的 thinking 内容在多轮对话中正确保留
- 模型输出被截断时，用户看到完整的回复而非残缺内容
- LLM 的临时错误（503、速率限制）不会终止整个会话
- 循环核心代码量从 260 行增长到不超过 370 行
- 所有新增能力都可以被插件覆盖或禁用
- 现有插件无需任何改动即可继续工作（向后兼容）

## Scope Boundaries

- **不包含**：高级上下文压缩（5 层压缩管线）。cortx 只提供 `context.overflow` 钩子，压缩策略由插件实现
- **不包含**：工具并行执行。这是独立的增强，不在本次范围内
- **不包含**：流式工具执行。现有 `reportProgress` 机制已足够
- **不包含**：子 Agent / Agent Team。这是工具层功能，不涉及核心循环
- **不包含**：模型 fallback 链。cortx 是 provider 无关的，fallback 策略由 `error.recover` 插件处理
- **不包含**：预取机制（memory/skill prefetch）。属于优化项，不改变核心循环行为

## Key Decisions

- **内置默认 + 插件可覆盖**：每个增强能力都有工作正常的默认实现，但插件可以完全接管。这保证开箱即用，同时不限制定制能力。
- **用 followUp 实现自动继续**：复用现有的 `controller.followUp()` 机制，不引入新的控制流概念。
- **error.recover 而非内置重试管线**：重试策略是插件职责，核心只提供"是否重试"的决策点和默认值。不引入指数退避、断路器等复杂机制。
- **context.overflow 是最后机会，不是常规操作**：上下文管理应该由 `messages.transform` 插件在每次 LLM 调用前主动处理。`context.overflow` 只在已经溢出时作为"紧急出口"。
- **工具结果截断是默认行为**：不截断工具结果是危险的（可能撑爆上下文）。默认截断是安全的，需要更大结果的插件可以通过 `tool.execute.after` 移除截断。

## Dependencies / Assumptions

- `@synax-ai/core` 的 `LanguageClient.stream()` 必须能够报告可区分的错误类型（速率限制 vs 上下文溢出 vs 通用错误）。如果当前 SDK 不区分这些错误类型，需要先扩展 SDK。
- `finishReason` 的值（`'length'`、`'stop'`、`'tool-calls'`）取决于 provider 实现。不同 provider 可能使用不同的值，需要在 `@synax-ai/sdk` 层做标准化。
- thinking 内容的保留格式（content block type）取决于 provider。Claude 使用 `thinking` 类型，其他 provider 可能有不同约定。

## Outstanding Questions

### Resolve Before Planning

- 无阻塞问题。方向已确认。

### Deferred to Planning

- [Affects R1][Technical] thinking 内容在 `LanguageMessage` 中的具体格式是什么？需要检查 `@synax-ai/sdk` 的类型定义
- [Affects R2][Technical] `LanguageClient.stream()` 当前如何报告错误？错误对象的结构是什么？
- [Affects R5][Technical] 上下文溢出的错误如何被检测到？是 provider 抛出特定异常，还是返回特定的 finishReason？
- [Affects R6][Technical] `ToolResult` 类型当前的定义是什么？截断后的结果如何保留在现有类型系统中？
- [Affects R7/R8][Technical] `CortxPlugin` 接口当前的定义是什么？新增钩子如何保持向后兼容？

## Next Steps

-> `/ce:plan` for structured implementation planning
