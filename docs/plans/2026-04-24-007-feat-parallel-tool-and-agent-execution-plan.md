---
title: 并行工具执行与多 Agent 并发调度
type: feat
status: active
date: 2026-04-24
origin: docs/ideation/2026-04-18-agent-core-loop-ideation.md (Ideas #3, #5)
---

# 并行工具执行与多 Agent 并发调度

## Overview

为 cortx 的 `agentLoop()` 添加并行执行能力。当 LLM 返回多个 tool_calls 时，read-only 工具并行执行；当 LLM 返回多个 agent tool_calls 时，多个子 Agent 并发运行。通过声明式 `sideEffects` 元数据控制调度策略，工具作者声明一次，核心循环自动分组调度。

## Problem Frame

cortx 的 agent loop 中工具执行是串行的（`loop.ts:289` 的 `for...of` 循环）。当 LLM 返回 5 个 Read tool_calls 时，cortx 比需要的慢 5 倍。子 Agent 同样阻塞父循环——多个 sub-agent 无法并行运行。这对真实使用场景（代码审查需要同时读取多个文件、并行执行研究任务）是不可接受的性能瓶颈。

## Requirements Trace

- R1. LLM 返回多个 tool_calls 时，read-only 工具并行执行
- R2. 工具通过声明式元数据声明副作用等级
- R3. write/destructive 工具保持串行执行以保证安全性
- R4. 并行工具执行的事件顺序与串行时一致（tool_use → tool_progress → tool_result）
- R5. 多个子 Agent 可以并发运行，各自独立执行后汇总结果
- R6. 并行执行遵守 controller 的 abort/steer 信号
- R7. 现有工具无需修改即可继续工作（向后兼容）

## Scope Boundaries

- 不包含：工具超时/取消（AbortSignal）、流式工具执行（async generator tools）、工作树隔离、上下文预算分配
- 不包含：插件单例移除（`@nerax-ai/plugin` 的 `getInstance()` 问题）——这是独立优化
- 并行度不依赖外部调度器或线程池——纯 `Promise.all` 实现

### Deferred to Separate Tasks

- 工具超时与取消：需要 ToolContext 接入 AbortSignal，是独立增强
- 流式工具执行：工具返回 AsyncGenerator，是架构扩展
- 子 Agent 的工作树隔离：文件系统级隔离属于插件关注点

## Context & Research

### Relevant Code and Patterns

- `packages/sdk/src/index.ts` — Tool 接口、CortxPlugin、AgentEvent 类型
- `packages/core/src/loop.ts:289-371` — 当前串行工具执行循环
- `packages/core/src/agent.ts:103-174` — 当前 agent tool 实现（阻塞式）
- `packages/code/src/` — 现有 7 个工具（read/grep/find/ls = read-only, bash/write/edit = write）
- `docs/ideation/2026-04-18-agent-core-loop-ideation.md` — 并行执行设计提案（Ideas #3, #5）

### Key Technical Findings

- `agentLoop()` 是纯函数式 async generator，嵌套调用天然安全——每个子 Agent 有独立的 messages 数组和 controller
- 当前 agent tool 过滤掉自身（`filter(t => t.name !== 'agent')`），子 Agent 不能递归嵌套
- `CortxPlugin['tool.execute.before']` 已支持 skip 返回值，可用于并行时的权限控制
- `ctx.reportProgress()` 是简单的字符串数组累积，并行时需要区分不同工具的进度
- LLM 返回的 tool_calls 有唯一 `toolCallId`，天然适合并行执行后的结果映射

### Institutional Learnings

- 构思文档的依赖图建议：先并行工具执行，再并行子 Agent。子 Agent 依赖并行执行基础设施
- 声明式 `sideEffects` 优于硬编码白名单（claude-code 的 `canRunInParallel` 方式）
- 默认 `'write'` 保证安全——未知工具不会意外并行执行

## Key Technical Decisions

- **声明式 `sideEffects` 元数据**：工具作者在 Tool 定义上声明 `'none' | 'read' | 'write' | 'destructive'`。核心循环根据声明自动分组。默认 `'write'` 确保安全（see origin: Idea #3）
- **分组执行策略**：`'none'` 和 `'read'` 工具并行执行（`Promise.all`）；`'write'` 和 `'destructive'` 工具串行执行。两组之间串行
- **子 Agent 作为标准工具**：不引入新的核心原语。agent tool 内部用 `Promise.all` 并发运行多个 `agentLoop()`。父循环无需知道（see origin: Idea #5）
- **事件顺序保持一致**：并行工具在 `tool_use` 事件之后批量 emit `tool_result`，保持 `tool_use → tool_result` 的因果顺序
- **并行度限制**：`maxConcurrentTools`（默认 5）和 `maxConcurrentAgents`（默认 3）防止资源耗尽

## Open Questions

### Resolved During Planning

- 默认 sideEffects 值：`'write'`（最安全的选择，未知工具不会意外并行）
- agent tool 的 sideEffects：设为 `'write'`（子 Agent 有状态副作用）
- 并行工具间的进度报告：每个工具的 progress 独立收集，不互相干扰

### Deferred to Implementation

- 具体的 maxConcurrentTools/maxConcurrentAgents 默认值是否需要根据运行环境调整
- 并行工具执行时的错误处理策略（一个失败是否取消其他）

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### 并行工具执行流程

```
LLM returns tool_calls: [A(read), B(read), C(write), D(read), E(destructive)]

1. Group by safety:
   - parallel_group: [A, B, D]  (sideEffects = 'read')
   - serial_queue: [C]           (sideEffects = 'write')
   - serial_queue: [E]           (sideEffects = 'destructive')

2. Execute parallel_group:
   - Emit tool_use for A, B, D
   - Promise.all([A.execute(), B.execute(), D.execute()])
   - Emit tool_result for A, B, D (order preserved by toolCallId)

3. Execute C serially:
   - Emit tool_use, execute, emit tool_result

4. Execute E serially:
   - Emit tool_use, execute, emit tool_result

5. Push all results to messages, continue loop
```

### 并行子 Agent 执行流程

```
LLM returns tool_calls: [agent(prompt1), agent(prompt2), agent(prompt3)]

1. All are sideEffects='write' → serialized by default
2. But agent tool detects multiple calls to itself:
   - Batch them, execute with Promise.allSettled()
   - Each agentLoop() runs independently with its own messages/controller
   - Results aggregated into individual tool_result events
3. Fallback: if only 1 agent call, behaves exactly like today
```

## Implementation Units

- [ ] **Unit 1: 扩展 Tool 接口添加 `sideEffects` 元数据**

**Goal:** 为 Tool 类型添加声明式副作用声明字段，作为并行执行的基础。

**Requirements:** R2, R7

**Dependencies:** None

**Files:**
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/src/index.ts` (类型编译验证)

**Approach:**
- `Tool` 接口添加可选字段 `sideEffects?: 'none' | 'read' | 'write' | 'destructive'`
- 不提供时默认视为 `'write'`（在 loop.ts 中通过 `tool.sideEffects ?? 'write'` 实现）
- 现有工具不声明此字段 = 自动获得 `'write'` 行为 = 串行执行 = 向后兼容

**Patterns to follow:**
- 现有 Tool 接口的可选字段模式（如 `description?: string`）

**Test scenarios:**
- 编译验证：带 `sideEffects` 的 Tool 定义通过类型检查
- 编译验证：不带 `sideEffects` 的 Tool 定义仍通过类型检查（向后兼容）
- 类型验证：`sideEffects` 只接受 `'none' | 'read' | 'write' | 'destructive'` 四个值

**Verification:**
- `tsc --noEmit` 通过，现有代码无类型错误

---

- [ ] **Unit 2: 为现有工具标注 `sideEffects`**

**Goal:** 为 cortx 内置的 7 个工具正确标注副作用等级。

**Requirements:** R2

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/code/src/read.ts`
- Modify: `packages/code/src/grep.ts`
- Modify: `packages/code/src/find.ts`
- Modify: `packages/code/src/ls.ts`
- Modify: `packages/code/src/bash.ts`
- Modify: `packages/code/src/write.ts`
- Modify: `packages/code/src/edit.ts`
- Modify: `packages/core/src/agent.ts` (agent tool → `'write'`)

**Approach:**
- `read`, `grep`, `find`, `ls` → `sideEffects: 'read'`
- `bash` → `sideEffects: 'destructive'`（bash 可执行任何操作）
- `write`, `edit` → `sideEffects: 'write'`
- `agent` → `sideEffects: 'write'`

**Patterns to follow:**
- 现有工具定义的工厂函数模式（如 `createReadTool(cwd): Tool`）

**Test scenarios:**
- 每个 read-only 工具的 `sideEffects` 字段值为 `'read'`
- bash 工具的 `sideEffects` 字段值为 `'destructive'`
- write/edit 的 `sideEffects` 字段值为 `'write'`
- agent tool 的 `sideEffects` 字段值为 `'write'`

**Verification:**
- 所有工具创建后 `sideEffects` 字段正确

---

- [ ] **Unit 3: 并行工具执行核心逻辑**

**Goal:** 改造 `loop.ts` 的工具执行循环，支持按副作用分组并行执行。

**Requirements:** R1, R3, R4, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/core/src/loop.ts`
- Modify: `packages/core/src/types.ts` (CortxConfig 增加 `maxConcurrentTools`)
- Test: `packages/core/tests/loop.test.ts`

**Approach:**
- 替换当前 `for (const tc of toolCalls)` 串行循环为分组执行：
  1. 将 toolCalls 按副作用分为两组：`parallelGroup`（`'none'` | `'read'`）和 `serialQueue`（`'write'` | `'destructive'`）
  2. 先执行 `parallelGroup`：emit 所有 `tool_use` 事件，然后用 `Promise.all` 并行执行，最后按原始顺序 emit `tool_result` 事件
  3. 再串行执行 `serialQueue` 中的每个 tool call
- 每个工具执行前后检查 `controller.isAborted` 和 `controller.isSteered`
- `tool.execute.before` / `tool.execute.after` 钩子在单个工具级别调用
- `maxConcurrentTools` 配置项限制并行组大小（默认 5），超出的降级为串行
- 工具执行结果截断逻辑保持不变（per-tool truncation）

**Execution note:** 先写并行执行的失败测试（验证分组逻辑和事件顺序），再实现核心逻辑。

**Patterns to follow:**
- 现有工具执行的整体结构（abort 检查、plugin hooks、error handling）
- 现有 `Promise.all` 用法（`agent.ts:18` 的 plugin resolution）

**Test scenarios:**
- Happy path: 3 个 read tools 并行执行，返回 3 个 tool_result 事件
- Happy path: 2 个 read + 1 个 write tool，read 并行后 write 串行
- Edge case: 全部 write tools → 全部串行，行为与当前一致
- Edge case: 空 tool_calls 数组 → 不执行
- Event ordering: tool_use 事件在 tool_result 事件之前
- Event ordering: tool_result 事件按 toolCallId 顺序（即使并行完成顺序不同）
- Abort: 并行执行中被 abort → 已完成的正常返回，未开始的跳过
- Steer: 并行执行中被 steer → 已完成的正常返回，未开始的跳过，循环重入
- Error: 并行组中一个工具失败 → 其他继续执行，失败的 tool_result isError=true
- Plugin hooks: tool.execute.before 返回 skip 时并行组中的其他工具不受影响
- Truncation: 并行执行的大结果仍被截断
- maxConcurrentTools: 超过限制时多出的工具降级为串行

**Verification:**
- 所有并行执行测试通过
- 现有串行执行测试不受影响（全部 write 的场景）

---

- [ ] **Unit 4: 并行子 Agent 执行**

**Goal:** 多个 agent tool_calls 可以并发运行，各自独立完成后汇总结果。

**Requirements:** R5, R6

**Dependencies:** Unit 3

**Files:**
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/types.ts` (CortxConfig 增加 `maxConcurrentAgents`)
- Test: `packages/core/tests/loop.test.ts`

**Approach:**
- 修改 `createAgentTool()`：当检测到同一轮中有多个 agent tool_calls 时，用 `Promise.allSettled` 并发运行多个 `agentLoop()`
- 每个 sub-agent 有独立的 messages、controller（子 controller，传播 abort 信号）、system prompt
- 并行度限制 `maxConcurrentAgents`（默认 3），超出的排队等待
- 进度报告独立：`ctx.reportProgress` 调用时带 description 前缀区分不同子 Agent
- 结果聚合：每个 sub-agent 的输出作为独立的 tool_result 返回
- 错误隔离：一个 sub-agent 失败不影响其他，失败的结果 isError=true
- 子 Agent 不能嵌套：保持现有 `filter(t => t.name !== 'agent')` 限制

**Execution note:** 并行子 Agent 的实现依赖于 Unit 3 的并行基础设施。agent tool 的 sideEffects='write'，所以会被放入 serialQueue。需要在 loop.ts 中增加特殊处理：当 serialQueue 中有多个同名的 agent tool_calls 时，将它们批量传给 tool 的 execute（或使用专门的并行执行路径）。

**Technical design:**

有两种实现路径：

**路径 A — Agent tool 内部批处理：** loop.ts 的串行执行中，检测连续的 agent tool_calls，批量收集后一次性传给 agent tool 的 execute（修改 execute 接受数组）。agent tool 内部用 `Promise.allSettled` 并发执行。

**路径 B — Loop 层识别并并行化：** loop.ts 在分组时特别识别 agent tool_calls 组，将它们从 serialQueue 中提取出来用 `Promise.allSettled` 并行执行，每个调用标准 agent tool 的 execute。

推荐路径 B——不改变 Tool.execute 签名，loop 层拥有完整的调度控制权。

**Patterns to follow:**
- 现有 agent tool 的 `agentLoop()` 嵌套调用模式
- Unit 3 的并行执行基础设施

**Test scenarios:**
- Happy path: 2 个 agent tool_calls 并发运行，各自返回独立结果
- Error isolation: agent1 成功 + agent2 失败 → 两个 tool_result 独立返回
- Abort: 并行 sub-agents 被 abort → 已完成的正常返回，运行中的终止
- Progress: 并行 sub-agents 各自报告进度，不互相干扰
- maxConcurrentAgents: 5 个 agent calls + limit=3 → 前 3 个并行，后 2 个等前 3 个完成后执行
- Single agent: 1 个 agent call → 行为与修改前完全一致
- Nested prevention: sub-agent 不能再创建 sub-agent

**Verification:**
- 并行子 Agent 测试通过
- 单个子 Agent 的行为与修改前一致

## System-Wide Impact

- **Interaction graph:** `tool.execute.before` / `tool.execute.after` 钩子在并行执行时可能被同时调用。现有钩子实现必须是线程安全的（JavaScript 单线程所以天然安全，但钩子不应假设执行顺序）
- **Error propagation:** 并行组中一个工具失败不传播到其他工具。所有结果收集后统一 push 到 messages
- **State lifecycle risks:** 并行工具执行共享同一个 `progressMessages` 数组——需要改为 per-tool-call 的进度收集
- **API surface parity:** Tool 接口新增可选字段，现有工具无需修改。AgentEvent 类型不变。CortxPlugin 钩子签名不变
- **Unchanged invariants:** abort/steer 检查语义不变。消息格式不变。插件钩子调用语义不变

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 工具作者错误标注 sideEffects 导致不安全并行 | 默认 `'write'` 确保安全；只有主动声明 `'read'` 才会并行 |
| 并行工具间通过文件系统产生隐式依赖 | `'write'` 工具串行执行，读写互斥自然保证；多个 `'read'` 之间无冲突 |
| 并行子 Agent 同时写同一文件 | 用户层面的约束，不在此计划范围内。文档说明风险即可 |
| 进度报告在并行时交错混乱 | 每个工具/sub-agent 的进度独立收集，不共享缓冲区 |
| 测试覆盖并行场景的复杂度 | 使用 mock LanguageClient 返回多 tool_calls，验证执行顺序和结果正确性 |

## Sources & References

- **Origin document:** [docs/ideation/2026-04-18-agent-core-loop-ideation.md](docs/ideation/2026-04-18-agent-core-loop-ideation.md)
- Core loop: `packages/core/src/loop.ts`
- Agent class: `packages/core/src/agent.ts`
- SDK types: `packages/sdk/src/index.ts`
- Code tools: `packages/code/src/`
- Existing tests: `packages/core/tests/loop.test.ts`
