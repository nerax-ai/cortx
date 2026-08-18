# Cortx SDK、Core 与 Runtime 扩展指南

本文描述当前插件扩展合同。SDK 定义类型和 descriptor/binding 协议，Core 只执行 agent loop，Runtime/Host 负责插件发现、贡献解析、作用域、重建和产品能力装配。

## 1. 职责边界

- `@cortx/sdk`：扩展点常量、贡献值类型、Manifest descriptor、typed binding、Host context 和运行事件合同。
- `@cortx/core`：模型循环、controller、tool pipeline、policy hook、checkpoint；不发现插件、不创建 Registry，也不接受插件配置。
- `@cortx/runtime`：持有 session/run/child 生命周期，借用 Host 注入的 `ProjectDomain`，按 canonical contribution reference 创建扩展值。
- 产品 Host：创建唯一的持久 `ProjectDomain`，决定插件管理权限、workspace ceiling、tool profile、session ACL 和关闭顺序。

Core 不提供 Registry 隐式兜底路径。在线 Server、嵌入式应用和本地组合必须显式共享同一个 `ProjectDomain`；远程客户端只能调用 Host 暴露的 `PluginAdminService` 和 Runtime transport，永远不创建本地 Manager。

## 2. 插件声明：descriptor + `ctx.bind()`

贡献的身份、展示信息、JSON schema、默认值和 `executable` 只在 Manifest descriptor 中声明。`setup()` 只绑定可执行 factory，不能重新声明 metadata。

```ts
import {
  AGENT_TOOL,
  defineContributionBinding,
  defineCortxContributionDescriptor,
  defineCortxPlugin,
  defineTool,
  defineToolFactory,
} from '@cortx/sdk';

export default defineCortxPlugin({
  manifest: {
    manifestVersion: 1,
    id: '@example/fetch-tools',
    name: 'Fetch tools',
    version: '1.0.0',
    runtime: { main: 'dist/index.js' },
    contributes: {
      [AGENT_TOOL]: [
        defineCortxContributionDescriptor({
          id: 'fetch-url',
          displayName: 'Fetch URL',
          executable: true,
          schema: {
            fields: [{ name: 'timeoutMs', type: 'number', default: 10_000 }],
          },
        }),
      ],
    },
  },
  setup(ctx) {
    ctx.bind(
      defineContributionBinding(
        AGENT_TOOL,
        'fetch-url',
        defineToolFactory((options, host) =>
          defineTool({
            name: 'fetch_url',
            sideEffects: 'read',
            inputSchema: {
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url'],
            },
            async execute(input, toolCtx) {
              const signal = AbortSignal.any([host.signal, toolCtx.signal ?? new AbortController().signal]);
              const response = await fetch(String(input.url), { signal });
              return { success: true, output: await response.text() };
            },
          }),
        ),
      ),
    );
  },
});
```

约束：

- Manifest 内 descriptor 的 `id` 是插件内短 ID；Host 配置必须使用 `@scope/plugin/contribution` 形式的 canonical reference。
- executable descriptor 必须有且只有一个同 ID、同 type 的 binding。
- `runtime.toolProfile` 是 metadata-only descriptor，不能绑定 factory，也不能解析为 executable lease。
- `defineCortxPlugin()` 会把 `setup(ctx)` 精确推断为 `CortxPluginContext`；例如把 `agent.sessionPolicy` factory 绑定成 `agent.tool` 会在 type-test 阶段失败。

## 3. Agent 扩展点

| 类型                      | 职责                                  | contribution value                   |
| ------------------------- | ------------------------------------- | ------------------------------------ |
| `agent.tool`              | 模型可调用工具                        | `Tool`                               |
| `agent.systemTransform`   | 修改 system prompt                    | `AgentSystemTransformContribution`   |
| `agent.messagesTransform` | 修改模型请求消息                      | `AgentMessagesTransformContribution` |
| `agent.toolBefore`        | 工具执行前 rewrite/deny/short-circuit | `AgentToolBeforeContribution`        |
| `agent.toolAfter`         | 工具执行后归一化结果                  | `AgentToolAfterContribution`         |
| `agent.errorRecover`      | 模型错误后的 retry/decline            | `AgentErrorRecoverContribution`      |
| `agent.contextOverflow`   | 上下文溢出恢复                        | `AgentContextOverflowContribution`   |
| `agent.eventObserver`     | 观察 agent events                     | `AgentEventObserverContribution`     |
| `agent.sessionPolicy`     | turn/model/tool/sub-agent 横切策略    | `AgentSessionPolicyContribution`     |

添加新扩展点时，SDK 负责类型和值容器，Core 只增加明确的 pipeline 调用位置，Runtime 决定是否、何时挂载。

## 4. ProjectDomain 与统一插件管理

持久本地 Host 使用 `createFilesystemProjectDomain()` 创建唯一 writer：

```ts
import { createFilesystemProjectDomain } from '@cortx/runtime';

const projectDomain = createFilesystemProjectDomain({
  appName: 'cortx',
  runtimeDomainId: projectIdentity.runtimeDomainId,
  secretsBackend,
});

await projectDomain.start();
```

Host 也可以把显式创建的 `PluginRegistry` 交给 `ProjectDomain`，但构造参数必须在 `domain` 和 `registry` 中二选一。这里没有进程级全局 Registry、隐式默认 Registry 或兼容 shim。Runtime、Synax 和 Server 借用同一个 ProjectDomain；只有创建它的 composition root 负责关闭。

`runtimeDomainId` 必须来自持久 project identity，不能从可移动的目录名临时推导。同一 runtime domain 的第二个 production Manager 会被 writer lease 拒绝。

在线插件管理通过共享 serializable contract 暴露：

```ts
import { CortxPluginAdminService } from '@cortx/runtime';

const pluginAdminService = new CortxPluginAdminService({
  projectDomain,
  authorize: (context, grant) => hostPolicy.allows(context, grant),
});
```

Server 把该 service 挂到 `/api/plugins/*`。CLI、Web、远程 TUI 和 agent adapter 使用相同的 action/result、snapshot、operation、event cursor 和稳定错误码；transport 不复制 Registry/Manager state。离线 descriptor inspection 使用 lease-free inspector，也不会启动 Manager、写 desired state 或执行插件 `setup()`。

Standalone、embedded、remote 三种 topology 都是异步关闭：

```ts
import { createStandaloneCortxTopology } from '@cortx/runtime';

const topology = createStandaloneCortxTopology({ projectDomain, synax, runtime, logger, storage });

try {
  await runApplication(topology);
} finally {
  await topology.close();
}
```

Standalone 依次关闭 Runtime、Synax、ProjectDomain、logger 和 storage，并聚合失败；embedded 只关闭自己拥有的 Runtime/Synax，借入的 ProjectDomain 由外层 Host 关闭；remote 只关闭 transport clients。

## 5. 作用域与 generation 变更

生命周期层级：

```text
application
└── session
    ├── run / continue
    │   └── foreground-child
    └── background-child
```

- session scope 保存长生命周期会话状态。
- 每次 `prompt()` 和 `resume()` 都创建新的 run scope，并在该 scope 内重新解析、调用 contribution lease。
- foreground child 属于当前 run；background child 属于 session，但拥有独立 child contribution values。
- 所有 scope 都异步逆序清理；超时、失败和 stuck cleanup 会保留 retry handle，不能假报成功。

插件 generation refresh、disable、uninstall、policy loss 或 Manager close 会撤销 lease。撤销会同步 abort 对应 Host scope，Runtime 再把 scope signal 传给当前 Cortx controller，因此旧 run 不能继续进入已撤销的扩展。

generation 变更采用 **revoke-then-rebuild**：

- 不承诺跨插件 runtime 与产品 Host 的无缝、原子替换。
- 旧 generation 先撤销；当前 run 被取消并关闭旧值。
- 下一次 run 重新解析当前 authoritative generation。
- 插件暂时不可用时，run 创建明确失败；重新启用后可创建全新的 contribution values。

同一 generation 内的 Host 配置更新仍可 make-before-break：候选 Host 创建失败时保留旧配置，成功 cutover 后再清理旧 scope。

## 6. Tool Profile 与持久会话

`none`、`read-only`、`coding`、`all` 只是 UI alias。Runtime 会解析并持久化 canonical `runtime.toolProfile` reference，同时持久化该 session 的 canonical contribution configs。

恢复 durable session 时，Runtime 使用 snapshot 中的 contributions 和 profile 重新建立 Host；不会退回 Runtime 全局默认插件集合。

```ts
const session = await runtime.createSession({
  toolMode: 'coding',
  contributions: [{ use: '@example/review/read-only-policy', options: { strict: true } }],
});

console.log(session.toolProfile); // @cortx-ai/workspace-tools/coding
```

## 7. 取消、工具和子 Agent

插件 factory 应把 `CortxContributionHostContext.signal` 与每次调用的 `ToolContext.signal` 组合起来：前者覆盖 generation、run/session 和 Host 关闭，后者覆盖单次 tool timeout 与调用取消。

子 Agent store 对外返回 detached snapshot，调用者修改查询结果不会改变内部状态。abort 可以早于实际 aborter 注册；pending abort 会在注册后立即交付。Runtime 在 session abort/destroy/close 时枚举全部 running child，等待其进入 terminal 状态。

child scope cleanup 失败与 session/run cleanup 一样进入 `listCleanupFailures()`，可通过 `retryCleanup(id)` 重试。

## 8. Core 合同

`agentLoop()` 只接收已经组装好的 `AgentRuntimeExtensions`。它不认识 Manifest、Registry、ProjectDomain 或 plugin source。

Core 的主要 phase：

- `model`：messages transform、model policy、provider stream、error recovery、context overflow。
- `tool.prepare`：tool policy、toolBefore、输入准备。
- `tool.execute`：执行、超时、toolAfter。
- `completion/control`：done、follow-up、steer、abort、checkpoint。

`AgentController.onAbort` 会传播到 provider stream 和 tool context signal。Runtime 额外把 Host run scope signal 桥接到 controller，从而使插件 generation 撤销进入同一取消路径。

## 9. 验证门禁

SDK/Core/Runtime 修改至少运行：

```bash
bun run --cwd packages/sdk type-test
bun run --cwd packages/sdk lint
bun run --cwd packages/core lint
bun run --cwd packages/runtime lint
bun test packages/sdk/tests packages/core/tests packages/runtime/tests
bun run build
bun run test:package
git diff --check
```

最终扫描不得保留旧的 imperative registration API、进程级全局 Registry accessor、Core plugin resolver、非 canonical contribution ID、source-path copy 或 query credential 等旧边界。
