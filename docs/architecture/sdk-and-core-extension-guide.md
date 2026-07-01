# Cortx SDK 与 Core 扩展指南

本文档描述当前官方扩展面。Cortx 的核心原则是：SDK 只定义稳定契约，Core 只编排 agent loop，具体能力通过明确扩展点接入。

## SDK 模块边界

`@cortx/sdk` 仍保留顶层导出，但内部类型已经按职责拆分：

- `tools.ts`：`Tool`、`ToolContext`、`ToolResult`、`SideEffects`
- `events.ts`：`AgentEvent`、`ErrorCode`
- `policy.ts`：`agent.sessionPolicy` 的输入和每个 hook 专属 decision 类型
- `extensions.ts`：agent 扩展点常量、runtime extension 容器、插件 factory map
- `runtime.ts`：`AgentRunRecorder`、`AgentTracer`、`AgentRunLimits`、`AgentDurableRunStore`

插件作者优先从 `@cortx/sdk` 顶层导入；分文件是 SDK 内部维护边界，不要求使用者记住物理路径。

SDK 也提供薄 helper，用于让插件代码保持类型清晰：

- `defineTool(tool)`
- `defineSessionPolicy(policy)`
- `defineSystemTransform(transform)`
- `defineMessagesTransform(transform)`
- `defineToolBefore(hook)`
- `defineToolAfter(hook)`
- `defineErrorRecover(hook)`
- `defineContextOverflow(hook)`
- `defineEventObserver(observer)`

这些 helper 不做运行时包装，只保留 TypeScript 的窄类型推断。

## Agent 扩展点

| 扩展点                    | 用途                                  | 返回值                           |
| ------------------------- | ------------------------------------- | -------------------------------- |
| `agent.tool`              | 注册模型可调用工具                    | `Tool`                           |
| `agent.systemTransform`   | 修改 system prompt                    | `{ system }`                     |
| `agent.messagesTransform` | 修改模型请求消息                      | `{ messages }`                   |
| `agent.toolBefore`        | 工具执行前 rewrite/deny/short-circuit | `AgentToolBeforeResult`          |
| `agent.toolAfter`         | 工具执行后修改结果                    | `{ result }`                     |
| `agent.errorRecover`      | 模型流错误后的 retry/decline          | `AgentErrorRecoverResult`        |
| `agent.contextOverflow`   | 上下文溢出后的 compact/recover        | `AgentContextOverflowResult`     |
| `agent.eventObserver`     | 观察 agent events，不影响主流程       | `onAgentEvent(event)`            |
| `agent.sessionPolicy`     | 会话级策略：turn/model/tool/sub-agent | `AgentSessionPolicyContribution` |

## Session Policy

`agent.sessionPolicy` 是用于横切控制面的策略扩展。每个 hook 的 decision 类型是独立的，避免一个 hook 返回另一个 hook 才能处理的 action。

```ts
import { AGENT_SESSION_POLICY, defineCortxPlugin } from '@cortx/sdk';

export default defineCortxPlugin({
  manifest: {
    manifestVersion: 1,
    id: 'read-only-policy',
    name: 'Read-only policy',
    version: '0.1.0',
    runtime: { main: 'dist/index.js' },
  },
  setup(ctx) {
    ctx.register(AGENT_SESSION_POLICY, 'read-only', () => ({
      beforeModelRequest({ tools }) {
        return {
          action: 'rewriteTools',
          tools: tools.filter((tool) => tool.sideEffects !== 'write' && tool.sideEffects !== 'destructive'),
        };
      },
      beforeToolCall({ tool }) {
        if (tool?.sideEffects === 'write' || tool?.sideEffects === 'destructive') {
          return { action: 'deny', reason: 'This session is read-only.' };
        }
        return { action: 'allow' };
      },
    }));
  },
});
```

工具建议用 `defineTool()` 声明。`ToolContext.signal` 是合作式取消入口：当用户 abort、turn timeout、tool timeout 发生时，Core 会触发 signal。旧工具可以忽略它，新工具应该在长任务、轮询、外部请求前检查它。

```ts
import { defineTool } from '@cortx/sdk';

export const fetchTool = defineTool({
  name: 'fetch_url',
  sideEffects: 'read',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
  },
  async execute(input, ctx) {
    const response = await fetch(String(input.url), { signal: ctx.signal });
    return { success: true, output: await response.text() };
  },
});
```

常用策略场景：

- `beforeTurn`：限制最大业务轮次、检查会话状态、根据 workspace 状态拒绝继续。
- `beforeModelRequest`：隐藏工具、插入/改写消息、在 provider 调用前拒绝请求。
- `beforeToolCall`：按工具 side effect 做权限控制、修正工具参数、从缓存短路工具执行。
- `beforeSubAgent`：限制子 agent 数量、拒绝后台 agent、按任务描述做 delegation policy。

## Core Pipeline Contract

Core 的 loop 现在围绕 `AgentLoopRuntime` 编排。每个 phase 只接收共享 runtime 加上本 phase 的局部输入。

当前 phase：

- `model`：messages transform、model request policy、provider stream、错误恢复、context overflow。
- `completion`：无工具调用时的 done、auto-continue、follow-up。
- `tool.prepare`：tool_use 事件、tool policy、toolBefore、输入解析。
- `tool.execute`：read-only 并发、write 串行、agent 工具批处理、toolAfter。
- `turn/control`：abort、steer、max iteration、turn_start/turn_end。

新增横切接缝：

- `AgentTracer`：Core 会为 `agent.model`、`agent.completion`、`agent.tool.prepare`、`agent.tool.execute` 创建 span。
- `AgentRunRecorder`：Core 会记录所有经由 pipeline 发出的 events，并带上 `{ sessionId, iteration, phase }`。
- `AgentRunLimits`：Core 已接入 `maxIterations`、`maxRetries`、`maxOverflowRecoveries`、`turnTimeoutMs`、`toolTimeoutMs`、`tokenBudget`。
- `AgentDurableRunStore`：Core 会在 `turn_start`、`tool_result`、`turn_end`、`done/error` 写 checkpoint，包含 `{ schemaVersion, phase, lastEvent, terminal, messages, pendingToolResults }`。`Cortx.continue()` 会优先读取同一 `sessionId` 的非 terminal checkpoint，并从 checkpoint messages 与 pending tool results 恢复到最近安全点。

## Durable Resume

Checkpoint schema 当前版本为 `AGENT_RUN_CHECKPOINT_SCHEMA_VERSION = 1`。持久化实现需要原样保存 `AgentRunCheckpoint`：

```ts
import type { AgentDurableRunStore, AgentRunCheckpoint } from '@cortx/sdk';

const checkpoints = new Map<string, AgentRunCheckpoint>();

export const durableStore: AgentDurableRunStore = {
  saveCheckpoint(checkpoint) {
    checkpoints.set(checkpoint.sessionId, checkpoint);
  },
  loadCheckpoint(sessionId) {
    return checkpoints.get(sessionId);
  },
};
```

恢复语义：

- terminal checkpoint 不会自动恢复，避免重复提交已经结束的 run。
- `tool_result` checkpoint 会先把 `pendingToolResults` 转成 model-visible tool message，再进入下一次 model request。
- `turn_end` checkpoint 会直接从已保存的 messages 继续下一轮。
- schema version 不匹配时不会恢复，Core 会把它视为不可用 checkpoint。

这套设计把“可恢复状态”限制在 checkpoint schema 内，避免 storage、server、UI 侵入 agent loop。

## Runtime Limits 语义

`limits` 是新代码优先使用的运行限制入口；旧的顶层字段仍作为兼容配置存在。

| 字段                    | 当前语义                                                                                                               | 事件结果                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `maxIterations`         | 覆盖顶层 `maxIterations`                                                                                               | terminal `error`，`code: "max_iterations"`   |
| `maxRetries`            | 模型流错误恢复的最大重试次数                                                                                           | 超出后使用原始错误分类                       |
| `maxOverflowRecoveries` | context overflow recover 最大次数                                                                                      | terminal `error`，`code: "context_overflow"` |
| `turnTimeoutMs`         | 单轮 agent turn 的 wall-clock deadline，覆盖模型流、tool policy、toolBefore、tool execute，并触发 runtime abort signal | terminal `error`，`code: "timeout"`          |
| `toolTimeoutMs`         | 单个工具调用的 result timeout，触发该工具的 `ToolContext.signal`，合作式工具可主动停止                                 | `tool_result`，`isError: true`               |
| `tokenBudget`           | provider 返回 usage 后的 post-response budget guard                                                                    | terminal `error`，`code: "budget_exceeded"`  |

注意：`tokenBudget` 只能在 provider usage 返回后判断，因此可能已经产生 `text_delta/text` 事件；它的价值是阻止继续进入工具或后续 turn，而不是预估请求前 token。

## 设计约束

- 扩展点要表达语义，不把 UI 或平台细节塞进 Core。
- SDK 类型保持窄：每个 hook 只允许返回自己能处理的 action。
- Core phase 通过 `AgentLoopRuntime` 获得共享服务，不在 phase 间传一长串重复参数。
- Recorder/tracer 不应该改变事件顺序；observer 失败会被隔离记录，recorder/durable store 当前按强一致运行接缝处理。
- Durable execution 只通过 checkpoint 接口进入，不让持久化逻辑散落在 phase 中。
- 取消是合作式取消：Core 会触发 `AbortSignal` 并尽快产出结构化事件；底层 provider 或工具如果完全忽略 signal，Core 仍会停止等待，但无法强杀外部进程。
- 子 agent 继承父 tool call 的取消语义，并记录 `parentSessionId/runId`，方便后续 UI、server、store 做事件归属和恢复。
