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
- `defineToolFactory(factory)`
- `defineSessionPolicyFactory(factory)`
- `defineEventObserverFactory(factory)`
- `defineContributionFactory(type, factory)`
- `defineCapabilityContribution(type, id, factory, options?)`
- `defineRuntimeCapability(capability)`
- `normalizeCortxCapabilityContribution(contribution)`
- `normalizeRuntimeCapabilityDefinition(capability)`
- `registerRuntimeCapability(ctx, capability)`

这些 helper 不做运行时包装，只保留 TypeScript 的窄类型推断。

## Plugin Authoring 推荐路径

一个 Cortx 插件可以继续直接调用 `ctx.register(type, id, factory)`。
对于官方能力或第三方能力包，更推荐先把多个 contribution 声明成一个 runtime capability，再在 `setup()` 中注册。
这里的 runtime capability 只是 SDK 层的“贡献集合”，不代表自动启用；是否在某个 session 挂载，仍由 `@cortx/runtime`、server、TUI 或 Web 的 host 配置决定。

最小工具插件：

```ts
import { AGENT_TOOL, defineCortxPlugin, defineContributionFactory, defineTool } from '@cortx/sdk';

export default defineCortxPlugin({
  manifest: {
    manifestVersion: 1,
    id: 'fetch-tools',
    name: 'Fetch tools',
    version: '0.1.0',
    runtime: { main: 'dist/index.js' },
  },
  setup(ctx) {
    ctx.register(
      AGENT_TOOL,
      'fetch-url',
      defineContributionFactory(AGENT_TOOL, () =>
        defineTool({
          name: 'fetch_url',
          sideEffects: 'read',
          inputSchema: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
          },
          async execute(input, toolCtx) {
            const response = await fetch(String(input.url), { signal: toolCtx.signal });
            return { success: true, output: await response.text() };
          },
        }),
      ),
    );
  },
});
```

组合能力插件：

```ts
import {
  AGENT_EVENT_OBSERVER,
  AGENT_SESSION_POLICY,
  AGENT_TOOL,
  defineCapabilityContribution,
  defineCortxPlugin,
  defineEventObserver,
  defineEventObserverFactory,
  defineRuntimeCapability,
  defineSessionPolicy,
  defineSessionPolicyFactory,
  defineTool,
  defineToolFactory,
  registerRuntimeCapability,
} from '@cortx/sdk';

const reviewCapability = defineRuntimeCapability({
  id: 'review-helper',
  displayName: 'Review helper',
  description: 'Adds a read-only review tool, a write guard, and event telemetry.',
  contributions: [
    defineCapabilityContribution(
      AGENT_TOOL,
      'review-summary',
      defineToolFactory(() =>
        defineTool({
          name: 'review_summary',
          sideEffects: 'read',
          inputSchema: {},
          async execute() {
            return { success: true, output: 'Review workspace and report correctness findings first.' };
          },
        }),
      ),
      { displayName: 'Review summary tool' },
    ),
    defineCapabilityContribution(
      AGENT_SESSION_POLICY,
      'read-only-review',
      defineSessionPolicyFactory(() =>
        defineSessionPolicy({
          beforeToolCall({ tool }) {
            return tool?.sideEffects === 'write' || tool?.sideEffects === 'destructive'
              ? { action: 'deny', reason: 'Review sessions are read-only.' }
              : { action: 'allow' };
          },
        }),
      ),
    ),
    defineCapabilityContribution(
      AGENT_EVENT_OBSERVER,
      'review-events',
      defineEventObserverFactory(() =>
        defineEventObserver({
          onAgentEvent(event) {
            if (event.type === 'done') {
              // Send telemetry, update counters, or flush buffered observations.
            }
          },
        }),
      ),
    ),
  ],
});

export default defineCortxPlugin({
  manifest: {
    manifestVersion: 1,
    id: 'review-helper',
    name: 'Review helper',
    version: '0.1.0',
    runtime: { main: 'dist/index.js' },
  },
  setup(ctx) {
    registerRuntimeCapability(ctx, reviewCapability);
  },
});
```

推荐规则：

- 用 `defineTool()` 声明单个工具，用 `defineToolFactory()` 包住 `agent.tool` factory。
- 用 `defineSessionPolicy()` 表达权限、预算、delegation 等 session 级策略。
- 用 `defineCapabilityContribution()` 绑定 extension type、贡献 id、factory 和可选展示信息。
- 用 `defineRuntimeCapability()` 组合一组有顺序的 contributions。
- 用 `registerRuntimeCapability()` 在插件 `setup()` 中逐条注册到现有 registry。

### SDK capability schemaVersion

SDK capability declaration 当前版本是 `CORTX_EXTENSION_SCHEMA_VERSION = 1`。
普通插件作者不需要手写这个字段：`defineCapabilityContribution()` 和 `defineRuntimeCapability()` 会把缺省版本和历史 `schemaVersion: 0` 归一成当前 v1。
如果显式传入未来未支持版本，SDK 会在 helper 边界直接抛出 schemaVersion 错误，而不是等到 core resolver 才发现贡献 shape 不匹配。

这条版本边界只覆盖 SDK helper 声明对象：

- `defineCapabilityContribution({ schemaVersion, type, id, factory, options })`
- `defineRuntimeCapability({ schemaVersion, id, contributions })`
- `normalizeCortxCapabilityContribution()`
- `normalizeRuntimeCapabilityDefinition()`

直接使用 `ctx.register(type, id, factory)` 的插件仍然有效；它们走 `@nerax-ai/plugin` 的 manifest/registry 语义，不被强制改造成 capability object。
也就是说，schemaVersion 是官方 SDK authoring helper 的演进边界，不是 runtime mounting、插件安装或 marketplace 协议。

这些 helper 的类型测试位于 `packages/sdk/type-tests/`。
如果把 `agent.sessionPolicy` 的 factory 注册成 `agent.tool`，`bun run --cwd packages/sdk type-test` 会在编译期失败。
这类错误不需要等到插件运行或 core resolver 报错。

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

## Runtime-Mounted Capability

Core 扩展点只描述“单 agent loop 内可以发生什么”。一个能力是否默认启用、在哪个 workspace 启用、用什么工具模式启用、是否有审批通道，属于 `@cortx/runtime` 的 host 语义。

因此官方能力建议按两层组织：

- **Capability implementation**：用 `@cortx/sdk` / `@cortx/core` 的扩展点实现具体语义，例如工具、policy、system/messages transform、event observer。
- **Runtime mounting**：由 `@cortx/runtime` 或 server/TUI 的 runtime config 决定是否挂载该能力、传入哪个 working directory、使用什么 approval mode。

这能让同一个能力同时服务很小的 agent 和完整 coding agent 产品：

- 小 agent 可以只传一份 prompt、少量 `tools` 和几个 policy。
- TUI/server 可以用 runtime 默认能力挂载 workspace tools、skills bridge、sub-agent capability 和 approval policy。
- Web/Desktop 不需要知道能力如何实现，只消费 runtime 的 session/action/event contract。

### 什么时候写 Core 插件

当能力需要进入 agent loop 语义时，写 core 插件或 SDK contribution：

- 新模型可见工具：`agent.tool`
- 请求前上下文改写：`agent.systemTransform` / `agent.messagesTransform`
- 工具权限、参数修正、缓存：`agent.sessionPolicy` / `agent.toolBefore`
- 工具结果归一化：`agent.toolAfter`
- 事件采集：`agent.eventObserver`

### 什么时候写 Runtime Mount

当能力依赖宿主配置或 workspace 时，放到 runtime mount 层：

- 按 `toolMode` 装配 workspace tools。
- 按 `approvalMode` 决定 write/destructive 工具是否询问或默认拒绝。
- 按 session working directory 发现 skills。
- 按产品配置启用/禁用 sub-agent。
- 按 allowed workspace roots 拒绝非法目录。

当前 runtime 已经提供默认 capability 映射：

```ts
import { CortxRuntime } from '@cortx/runtime';

const runtime = new CortxRuntime({
  language,
  model: 'default',
  defaultWorkingDirectory: process.cwd(),
  allowedWorkspaceRoots: [process.cwd()],
  toolMode: 'coding',
  approvalMode: 'interactive',
  capabilities: {
    skills: true,
    subAgents: true,
    approval: true,
  },
});

const session = await runtime.createSession({
  workingDirectory: '.',
  metadata: { source: 'tui' },
});

await runtime.prompt(session.id, 'review this repository');
```

禁用默认能力时，runtime 会在 host 层不挂载对应 official capability：

```ts
const session = await runtime.createSession({
  toolMode: 'read-only',
  approvalMode: 'deny',
  capabilities: {
    skills: false,
    subAgents: false,
    approval: false,
  },
});
```

这不会删除 core 的底层执行能力；它只是让宿主明确声明“这个 session 不挂载这些 runtime 官方能力”。Core 不再接收 skills/sub-agent/default approval 的产品级开关，也不会自行发现或默认创建这些能力。

### Server 嵌入生命周期

`@cortx/server` 是 runtime 的 HTTP/SSE adapter。普通启动可以继续使用 `createServer(config)`；嵌入式宿主、测试和未来 desktop 更适合使用 `createServerRuntime(config)`，这样可以在退出时显式释放 runtime session、pending questions 和 idle timers。

```ts
import { createServerRuntime } from '@cortx/server';

const handle = createServerRuntime({
  apiKey: process.env.CORTX_API_KEY!,
  language,
  model: 'default',
  defaultWorkingDirectory: process.cwd(),
  allowedWorkspaceRoots: [process.cwd()],
});

const server = Bun.serve({ port: 3000, fetch: handle.app.fetch });

process.on('SIGTERM', () => {
  server.stop(true);
  handle.dispose();
});
```

### Skills、Sub-Agent 与 Approval 的当前状态

Skills 仍然是 `SKILL.md` 文件系统资产，不要求 skill 作者写 JavaScript 插件。当前实现中，skill discovery、summary injection、slash invocation expansion、`skill` tool 和 companion file listing 都位于 `@cortx/runtime` 的 official skills capability 内。

Sub-agent 的模型可见 `agent` tool、foreground/background child run、child session store 和生命周期事件也由 `@cortx/runtime` 的 official sub-agent capability 挂载。Core 保留 agent loop、controller、tool pipeline、policy hook 和 checkpoint primitive，但不再默认创建产品级 `agent` tool。

Default approval policy 也位于 runtime official approval capability。Runtime 在 `approvalMode: 'interactive'` 时通过统一 `user_request` / `user_answer` 事件传输结构化审批；在 `approvalMode: 'deny'` 或没有可用审批通道时，write/destructive 工具默认拒绝。

这是一条迁移边界，不是对 skill 作者或插件作者的新负担。

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
`ToolContext.runId` 是可选 host 事实，runtime-mounted tools 可用它记录 parent/child attribution；普通工具不需要依赖它。

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

如果要把贡献注册到插件 registry，优先用 factory helper 包住注册函数，避免插件作者手写 `CortxFactoryMap[...]` 泛型：

```ts
import { AGENT_TOOL, defineContributionFactory, defineTool } from '@cortx/sdk';

ctx.register(
  AGENT_TOOL,
  'fetch-url',
  defineContributionFactory(AGENT_TOOL, () =>
    defineTool({
      name: 'fetch_url',
      sideEffects: 'read',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      async execute(input, toolCtx) {
        const response = await fetch(String(input.url), { signal: toolCtx.signal });
        return { success: true, output: await response.text() };
      },
    }),
  ),
);
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
- schema version 不匹配时不会继续恢复，Core 会发出 `client_error` 事件，避免把 schema 问题静默降级成普通 continue 错误。

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
