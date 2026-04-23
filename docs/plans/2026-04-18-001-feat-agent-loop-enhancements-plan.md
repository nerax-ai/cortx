---
title: Agent Loop 核心增强
type: feat
status: active
date: 2026-04-18
origin: docs/brainstorms/2026-04-18-agent-loop-enhancements.md
---

# Agent Loop 核心增强

## Overview

增强 cortx 的 `agentLoop()` 核心循环，修复 bug（thinking 丢失、错误类型不透明、输出截断），并添加最小必要健壮性能力（重试、上下文溢出处理、工具结果截断）。所有新增能力都通过插件钩子可覆盖。核心循环从 260 行增长到约 350 行。

## Problem Frame

cortx 的 agent loop 在生产使用中有 6 个关键缺陷（详见 origin 文档）。对比 claude-code 的 1500 行 query loop，cortx 不需要复杂的状态机或 5 层压缩管线，但需要内置最小必要能力保证不崩溃，同时通过插件保持可扩展性。

## Requirements Trace

- R1. Thinking 内容保留在消息历史中
- R2. error 事件携带结构化 code 字段
- R3. 输出截断时自动继续
- R4. 可恢复错误的默认重试策略
- R5. 上下文溢出检测与插件钩子
- R6. 工具结果默认截断
- R7. 新增 error.recover 插件钩子
- R8. 新增 context.overflow 插件钩子

## Scope Boundaries

- 不包含：高级压缩管线、工具并行执行、流式工具执行、子 Agent、模型 fallback、预取机制
- 所有新增能力都是内置默认 + 插件可覆盖

## Context & Research

### Relevant Code and Patterns

- `packages/sdk/src/index.ts` — AgentEvent 联合类型、CortxPlugin 接口、ToolResult、ToolContext
- `packages/core/src/loop.ts` — 260 行核心循环，async generator 模式
- `packages/core/src/types.ts` — AgentLoopController、CortxConfig、PluginConfig
- `packages/core/src/agent.ts` — Cortx 类
- `packages/core/src/session.ts` — CortxSession 类
- `@synax-ai/sdk` — LanguageMessage 支持 LanguageReasoningContent、SynaxError 有 code/statusCode、LanguageStreamPart 有 finish.finishReason

### Key Technical Findings

- `LanguageAssistantMessage.content` 已支持 `LanguageReasoningContent` 类型，thinking 保留在类型层面无障碍
- `SynaxError` 有 `code: string` 和 `statusCode: number`，可区分速率限制（429）、上下文溢出（413）、服务端错误（5xx）
- `LanguageStreamPart` 包含 `{ type: 'finish'; finishReason: FinishReason }` 和 `{ type: 'error'; error: unknown }`
- `CortxPlugin` 所有钩子都是可选属性，新增钩子天然向后兼容
- 测试框架：Bun test，`packages/core/tests/loop.test.ts` 已有 233 行覆盖全面的循环测试

## Key Technical Decisions

- **SynaxError.statusCode 用于错误分类**：速率限制=429，上下文溢出=413，服务端错误=5xx。不自己发明分类逻辑（see origin: Key Decisions）
- **thinking 保留用 LanguageReasoningContent**：直接用 SDK 已有的类型，不自定义格式
- **自动继续用内部 followUp 注入**：不修改 loop 控制流，复用 `messages.push()` + `continue mainLoop`（see origin: Key Decisions）
- **error.recover 和 context.overflow 是可选 CortxPlugin 属性**：与现有钩子模式一致，向后兼容（see origin: Key Decisions）
- **工具结果截断在 tool.execute.after 之前**：先截断，再让插件有机会修改

## Open Questions

### Resolved During Planning

- thinking 格式：SDK 已支持 `LanguageReasoningContent`，直接使用
- 错误检测：`SynaxError.statusCode` 可区分错误类型，`LanguageStreamPart` 有 `type: 'error'` 事件
- CortxPlugin 向后兼容：可选属性，无需改动现有插件
- ToolResult 截断：`ToolResult.output` 是 `unknown`，截断后设为 string

### Deferred to Implementation

- FinishReason 的具体值（`'length'` vs `'max_tokens'` 等）取决于 provider 实现，需要在实现时确认 `@synax-ai/sdk` 中 `FinishReason` 的定义
- `LanguageReasoningContent` 的确切结构需要在实现时确认 SDK 类型定义

## Implementation Units

- [ ] **Unit 1: 扩展 SDK 类型定义**

**Goal:** 为 AgentEvent、CortxPlugin 添加新类型，作为后续所有单元的基础。

**Requirements:** R2, R7, R8

**Dependencies:** None

**Files:**
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/src/index.ts` (类型测试，编译验证)

**Approach:**
- AgentEvent.error 增加可选 `code` 字段：`'context_overflow' | 'rate_limited' | 'max_iterations' | 'user_abort' | 'stream_error' | 'tool_failure'`
- AgentEvent 增加新变体：`{ type: 'context_overflow'; messages: LanguageMessage[] }`
- CortxPlugin 增加可选属性：`'error.recover'` 和 `'context.overflow'`
- 所有新增字段都是可选的，现有代码无需改动

**Patterns to follow:**
- 现有 AgentEvent 联合类型的判别模式（`type` 字段作为判别符）
- 现有 CortxPlugin 的可选钩子属性模式

**Test scenarios:**
- 编译验证：修改后的类型在现有代码中通过类型检查
- AgentEvent.error 带 code 字段应被 TypeScript 接受
- AgentEvent.error 不带 code 字段仍应被接受（向后兼容）

**Verification:**
- `bun run typecheck`（或 `tsc --noEmit`）通过

---

- [ ] **Unit 2: Thinking 持久化（R1）**

**Goal:** 修复 thinking 内容丢失的 bug。将 thinkingBuffer 中的内容包含在 assistant 消息中。

**Requirements:** R1

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/core/src/loop.ts`
- Test: `packages/core/tests/loop.test.ts`

**Approach:**
- 在 loop.ts 中，当 pushing assistant message（约 177-183 行），将 thinkingBuffer 作为 `LanguageReasoningContent` 加入 content 数组
- 需要确认 `LanguageReasoningContent` 的确切结构（从 `@synax-ai/sdk` 获取）
- 如果 thinkingBuffer 为空则不加入
- thinking 内容同时作为事件发出（现有行为不变）和存入消息历史（新行为）

**Patterns to follow:**
- 现有 textBuffer 已在 assistant message 中以 `LanguageTextContent` 形式保留，thinking 保留遵循相同模式

**Test scenarios:**
- Happy path: 模型产生 reasoning-delta 时，assistant 消息的 content 应包含 thinking block
- Edge case: 模型不产生 reasoning-delta 时，assistant 消息不含 thinking block
- Happy path: 下一轮 LLM 调用的 messages 中应包含上一轮的 thinking 内容

**Verification:**
- 新测试通过
- 现有测试不受影响

---

- [ ] **Unit 3: 结构化错误类型（R2）**

**Goal:** 为所有 error 发出点添加 code 字段，使调用者能程序化处理不同错误。

**Requirements:** R2

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/core/src/loop.ts`
- Test: `packages/core/tests/loop.test.ts`

**Approach:**
- loop.ts 中有 5 处发出 error 事件的位置，每处添加对应的 code：
  - controller.isAborted → `{ code: 'user_abort' }`
  - maxIterations → `{ code: 'max_iterations' }`
  - stream error catch → 根据错误类型设置 `'rate_limited'`、`'context_overflow'` 或 `'stream_error'`
  - abort during tools → `{ code: 'user_abort' }`
  - tool execution error → 保持现有行为（tool_result isError=true），不触发 error 事件
- 使用 `SynaxError.statusCode` 判断错误类型：429→rate_limited，413→context_overflow，其他→stream_error
- code 为可选字段，不影响现有消费者

**Patterns to follow:**
- 现有 error 事件发出模式：`{ type: 'error', error: Error }`

**Test scenarios:**
- abort 场景发出 code='user_abort'
- max iterations 场景发出 code='max_iterations'
- 速率限制错误发出 code='rate_limited'
- 上下文溢出错误发出 code='context_overflow'
- 通用流式错误发出 code='stream_error'

**Verification:**
- 所有 error 事件测试验证 code 字段

---

- [ ] **Unit 4: 输出截断自动继续（R3）**

**Goal:** 检测 finishReason 指示截断时，自动注入继续消息让模型接上。

**Requirements:** R3

**Dependencies:** Unit 2 (需要 assistant message 正确构造)

**Files:**
- Modify: `packages/core/src/loop.ts`
- Modify: `packages/core/src/types.ts` (CortxConfig 增加 autoContinueLimit)
- Test: `packages/core/tests/loop.test.ts`

**Approach:**
- 在 loop.ts 的 `isToolUse` 判断后（约 154-175 行之间），增加 finishReason 截断检测
- 当 `finishReason === 'length'`（或 SDK 定义的截断值）且 autoContinueCount < limit 时：
  - push assistant message（含 thinking + text + toolCalls）
  - push 继续消息：`{ role: 'user', content: 'Continue where you left off.' }`
  - emit turn_end 和 follow_up 事件
  - continue mainLoop
- 在 AgentLoopOptions 中增加 `autoContinueLimit` 默认值 2，tracking 变量 `autoContinueCount`
- 超过 limit 后正常发出 done 事件

**Patterns to follow:**
- 现有 controller.followUp() 注入消息的模式（loop.ts 157-166 行）

**Test scenarios:**
- finishReason='length' 时循环继续并注入继续消息
- 连续截断 2 次后循环正常终止
- finishReason='stop' 时不触发自动继续
- 自动继续消息出现在 messages 历史中

**Verification:**
- 模拟截断场景的端到端测试通过

---

- [ ] **Unit 5: 工具结果截断（R6）**

**Goal:** 工具结果超过阈值时自动截断，防止撑爆上下文。

**Requirements:** R6

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/core/src/loop.ts`
- Modify: `packages/core/src/types.ts` (CortxConfig 增加 toolResultBudget)
- Test: `packages/core/tests/loop.test.ts`

**Approach:**
- 在 loop.ts 中 tool.execute() 返回结果后（约 233 行），在 tool.execute.after 钩子之前：
  - 如果结果字符串长度超过 toolResultBudget（默认 10240 字符）
  - 截断为前 4096 + `\n... (truncated, {total} chars total)\n` + 后 4096
- CortxConfig 增加 `toolResultBudget?: number`，默认 10240
- 截断后的结果仍是合法的 ToolResult
- plugin 的 tool.execute.after 可以进一步修改（包括恢复完整内容）

**Patterns to follow:**
- 现有 tool result 处理模式（loop.ts 239-242 行）

**Test scenarios:**
- 工具返回 < 10KB 结果时不截断
- 工具返回 > 10KB 结果时截断并保留前后各 4KB
- 截断标记包含原始大小信息
- tool.execute.after 钩子仍能修改截断后的结果

**Verification:**
- 大结果场景测试通过

---

- [ ] **Unit 6: 重试与 error.recover 钩子（R4, R7）**

**Goal:** LLM 临时错误时自动重试，插件可通过 error.recover 钩子覆盖策略。

**Requirements:** R4, R7

**Dependencies:** Unit 3

**Files:**
- Modify: `packages/core/src/loop.ts`
- Modify: `packages/sdk/src/index.ts` (CortxPlugin 增加 error.recover)
- Test: `packages/core/tests/loop.test.ts`

**Approach:**
- 在 loop.ts 的 stream error catch（约 139-142 行）中：
  1. 首先检查是否有 error.recover 钩子注册
  2. 如果有，调用钩子获取 `{ retry, delay }` 决策
  3. 如果没有钩子，用默认策略：statusCode 429 或 5xx 时 retry=true, delay=1000
  4. 如果 retry=true 且 retryCount < 1，等待 delay 后 continue mainLoop
  5. 否则 emit error 并 return
- 增加 tracking 变量 `retryCount`，在每次迭代开始时检查

**Patterns to follow:**
- 现有 plugin hook 调用模式（如 tool.execute.before 的循环调用）

**Test scenarios:**
- 速率限制（429）触发自动重试，第二次成功
- 服务端错误（500）触发自动重试
- 不可恢复错误（如 auth 401）不重试
- error.recover 插件覆盖默认重试策略
- error.recover 插件返回 retry=false 时不重试
- 重试超过限制后正常终止

**Verification:**
- 重试相关测试全部通过

---

- [ ] **Unit 7: 上下文溢出处理与 context.overflow 钩子（R5, R8）**

**Goal:** 上下文溢出时发出事件并给插件"最后机会"压缩消息。

**Requirements:** R5, R8

**Dependencies:** Unit 3, Unit 6

**Files:**
- Modify: `packages/core/src/loop.ts`
- Modify: `packages/sdk/src/index.ts` (CortxPlugin 增加 context.overflow)
- Test: `packages/core/tests/loop.test.ts`

**Approach:**
- 在 loop.ts 的 stream error catch 中，检测到 context_overflow 错误时：
  1. emit `{ type: 'context_overflow', messages }` 事件
  2. 调用 `context.overflow` 插件钩子（如果注册）
  3. 如果插件返回新的消息数组，替换 messages 并 continue mainLoop
  4. 如果插件返回 null 或未注册，emit error（code='context_overflow'）并 return
- 此处理在 Unit 6 的 retry 逻辑之前执行（上下文溢出不是可重试错误）
- emit context_overflow 事件让所有 event 钩子都能感知

**Patterns to follow:**
- 现有 messages.transform 钩子模式（可以修改消息数组）

**Test scenarios:**
- 上下文溢出错误触发 context_overflow 事件
- context.overflow 插件返回压缩消息后循环继续
- context.overflow 插件返回 null 后循环终止
- 无插件注册时发出 error（code='context_overflow'）并终止
- 压缩后重试成功

**Verification:**
- 上下文溢出场景端到端测试通过

## System-Wide Impact

- **Interaction graph:** 所有消费 AgentEvent 的代码需要处理新的 `context_overflow` 事件类型（可选，该类型在现有 switch/if 链中会被忽略）
- **Error propagation:** error 事件新增可选 `code` 字段，现有消费者无需改动
- **State lifecycle risks:** 无。auto-continue 有硬性上限（2 次），retry 有上限（1 次），不会无限循环
- **API surface parity:** CortxPlugin 新增两个可选钩子，与现有 5 个钩子模式一致
- **Unchanged invariants:** 所有现有事件类型和行为不变。CortxSession、Cortx 类的公共 API 不变

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| SynaxError 可能不总是可用（非 SDK 抛出的错误） | 类型守卫检查 `instanceof SynaxError`，不可识别时默认 stream_error |
| FinishReason 值因 provider 不同而异 | 使用 `@synax-ai/sdk` 中的 FinishReason 枚举，不硬编码字符串 |
| LanguageReasoningContent 结构不确定 | 实现时确认 SDK 类型定义，必要时用 providerMetadata 标记 |
| 工具结果截断可能破坏依赖完整输出的工具 | 默认阈值 10KB 较大，仅影响极端情况；可通过 tool.execute.after 恢复 |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-18-agent-loop-enhancements.md](docs/brainstorms/2026-04-18-agent-loop-enhancements.md)
- Core loop: `packages/core/src/loop.ts`
- SDK types: `packages/sdk/src/index.ts`
- Agent types: `packages/core/src/types.ts`
- Existing tests: `packages/core/tests/loop.test.ts`
- Claude Code reference: `/Users/illuxiza/Gitwork/tools/claude-code/src/query.ts`
