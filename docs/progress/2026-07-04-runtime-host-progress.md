---
date: 2026-07-04
topic: cortx-runtime-host
plan: docs/plans/2026-07-04-001-feat-cortx-runtime-host-architecture-plan.md
requirements: docs/brainstorms/2026-07-04-cortx-runtime-host-requirements.md
blueprint: docs/architecture/cortx-core-runtime-blueprint.md
final_design: docs/architecture/cortx-runtime-host-final-design.md
status: target-achieved
---

# Cortx Runtime Host 进度记录

## 当前结论

Runtime Host 新版本已经完成 core purity + runtime closure + upper asset path 这一轮架构收口，整体完成度约 99%，已经超过 95% 新版本完成目标。

已经闭环的部分：

- `@cortx/runtime` 已成为多 session host。
- `@cortx/server` 已从自有 session manager 改为 runtime adapter。
- TUI 已拆成 local runtime 和 remote server 两种 adapter。
- Web 已对齐 runtime-backed server API，并保持 remote-only。
- `@cortx/code` 包已删除；原文件/命令工具能力已迁入 runtime 内部 `workspace-tools` capability，并保留路径边界测试。
- core 已移除产品默认能力：不再 discovery skills、不再默认创建 `agent` sub-agent tool、不再内置 default approval policy。
- skills、sub-agent、default approval 已迁入 `@cortx/runtime` official capabilities，由 runtime per-session 挂载或禁用。
- runtime event envelope 已落地，事件带 `sequence`、`timestamp`、`sessionId`、`runId`，child lifecycle event 带 parent attribution。
- durable resume 已使用稳定 `sessionId + runId`，unsupported checkpoint schema 会产生 typed `client_error` event。
- AgentSpec 与 SkillPack v1 已落地，可用数据资产启动 prompt-only 或 skill-pack-backed session。
- 新增边界测试，防止 core、server、Web、frontend 职责重新混杂。
- server 现在提供 `createServerRuntime()`，嵌入式宿主可以显式释放 runtime。
- 已完成一次真实 HTTP smoke，覆盖 server 启动、token exchange、多 workspace session、prompt、invalid workspace 和 abort。
- 已完成 TUI local / TUI remote render smoke，以及 Web Vite dev proxy smoke。
- server message action 的 invalid body 已统一返回 typed `invalid_request`。
- 全量 `bun test` 与 `bun run lint` 已通过。
- 本轮最新顺序验证再次通过：`bun run lint`、`bun run build`、`bun test`、`git diff --check`。
- 新增总体蓝图文档：`docs/architecture/cortx-core-runtime-blueprint.md`，作为 core/runtime/server/thin frontends 分层的稳定入口。
- 新增最终设计文档：`docs/architecture/cortx-runtime-host-final-design.md`，把 core、runtime、server、TUI、Web、未来 Desktop 的职责边界、验收标准和后续开发原则收敛成单一口径。
- 本轮 focused review 又补齐了 server auth 实例隔离、Web/TUI 短 token 刷新、TUI remote 边界和 SSE replay id 顺序。

仍然保留的 1%：

- UI smoke 已覆盖 render/proxy/remote event path，但还没有由真人在真实终端和浏览器里完整走一次交互体验。
- 如果走完整 LFG shipping，还需要后续最终全量验证、commit/push/PR/CI 步骤。

## 交付单元状态

| 单元 | 状态 | 当前证据 |
| --- | --- | --- |
| U1 新增 `@cortx/runtime` | 已完成 | `packages/runtime/src/runtime.ts`，runtime tests 覆盖 create/list/get/delete/prompt/steer/follow-up/resume/answer/abort/subscribe |
| U2 Workspace 与工具挂载 | 已完成 | `packages/runtime/src/workspace.ts`、`packages/runtime/src/tool-mount.ts`、`packages/runtime/src/workspace-tools/index.ts`，workspace tests 覆盖 lexical/realpath/symlink、tool mode、无审批拒绝写入；`packages/code` 已删除 |
| U3 Server runtime 化 | 已完成 | `packages/server/src/session-manager.ts` 已删除，`packages/server/src/server.ts` 创建 `CortxRuntime` 并委托所有 session action；`createServerRuntime()` 提供嵌入式 dispose |
| U4 TUI local/remote adapter | 已完成 | `packages/tui/src/runtime-session.ts`、`packages/tui/src/remote-client.ts`，TUI adapter tests 覆盖 local 和 remote |
| U5 Web remote contract | 已完成 | `packages/web/src/bridge/event-bridge.ts`，Web tests 覆盖 runtime API、typed errors、SSE 短期 token、remote-only manifest |
| U6 Core capability 边界 | 已完成 | core 已移除 skills/sub-agent/default approval 产品默认能力；`packages/runtime/tests/core-boundary.test.ts` 保护边界 |
| U7 Conformance 与文档 | 已完成 | `docs/architecture/runtime-host.md`、`docs/brainstorms/2026-07-04-cortx-runtime-host-requirements.md`、`docs/architecture/sdk-and-core-extension-guide.md`、`packages/runtime/tests/core-boundary.test.ts` |
| U8 最终设计口径 | 已完成 | `docs/architecture/cortx-runtime-host-final-design.md` 统一记录 core + runtime host + server adapter + thin frontends 的最终分层、边界和验收标准 |

## 本轮新增进度

### Round 8

- 完成 core 产品默认能力下沉：
  - 删除 `packages/core/src/skill/*`、`packages/core/src/sub-agent-session.ts`、`packages/core/src/safety-policy.ts`。
  - Core 保留显式 tools/extensions、agent loop、controller、checkpoint primitive，不再默认 discovery 或装配产品能力。
  - Runtime 新增 official capabilities：skills、sub-agent、approval。
- 完成 runtime closure 增强：
  - `ManagedRuntimeSession` 增加 event envelopes、run id、child session store。
  - `CortxRuntime.subscribeEnvelopes()` / `getEventEnvelopeHistory()` 提供 host metadata 事件流。
  - `server` SSE 支持 `?format=envelope`，并以 envelope sequence 作为 SSE id。
  - child lifecycle events 带 parent session/run/toolCall attribution。
- 完成 durable 与 asset v1：
  - `MemoryDurableRunStore` 用于测试/内存恢复。
  - checkpoint 增加 `runId`。
  - unsupported checkpoint schema 会通过 `client_error` event 暴露。
  - `AgentSpec` / `SkillPack` v1 支持 prompt-only 和 skill-pack-backed session launch。
- 新增/迁移测试：
  - former core skill tests 迁入 runtime skill tests。
  - sub-agent tests 迁入 runtime，并新增 envelope parent attribution 覆盖。
  - server tests 新增 envelope SSE replay 覆盖。
  - runtime tests 新增 event envelope bounded history 覆盖。

### Round 7

- 根据新的架构判断，彻底删除独立 `@cortx/code` 包：
  - 移除 `packages/code/package.json` 和 `packages/code/tsconfig.json`。
  - 将原 read/write/edit/bash/grep/find/ls/path-safety/search 工具实现迁入 `packages/runtime/src/workspace-tools/`。
  - 将原 code 工具测试迁入 `packages/runtime/tests/workspace-tools.test.ts`。
  - 移除 `@cortx/runtime` 对 `@cortx/code` 的 workspace 依赖。
  - 更新 lockfile，使 workspace 图只剩 sdk/store/core/runtime/server/tui/web 这 7 个包。
- 更新当前权威文档：
  - `@cortx/code` 不再被描述为包职责边界的一部分。
  - workspace tools 被定义为 runtime 内部 host-mounted capability。
  - 后续如果需要产品化分发，再抽成官方插件或可安装 tool pack，而不是恢复 `code` 这个模糊包。
- 加强架构边界测试：
  - `packages/code` 不能重新出现。
  - server/TUI/Web 不能直接导入 runtime 内部 `workspace-tools` 实现。
- 本轮验证：
  - `bun run lint`：通过，7 个 workspace package 全部成功。
  - `bun run build`：通过，7 个 workspace package 全部成功。
  - `bun test`：通过，717 pass，0 fail，1898 expect。

### Round 6

- 完成本轮 LFG 收尾审计：
  - 重新确认 plan metadata：`artifact_contract: ce-unified-plan/v1`、`artifact_readiness: implementation-ready`、`execution: code`。
  - 重新核对需求文档和最终设计文档中的 95% 验收标准。
  - 当前实现已经覆盖 runtime host、server adapter、TUI local/remote adapter、Web remote-only contract、workspace-tools capability、core capability boundary、conformance/boundary tests 和最终设计文档。
- 完成最新顺序全量验证：
  - `bun run lint`：通过，8 个 workspace package lint 全部成功。
  - `bun run build`：通过，8 个 workspace package build 全部成功，包含 Web production build。
  - `bun test`：通过，716 pass，0 fail，1854 expect。
  - `git diff --check`：通过。
- 当前判断：
  - 95% 新版本目标已经达成。
  - 剩余项属于 100% 完成度或 shipping/人工体验项，不阻塞本轮“推进到 95% 以上”的目标。

### Round 5

- 新增最终设计文档：
  - 明确 `@cortx/core` 是 single-agent kernel。
  - 明确 `@cortx/runtime` 是 multi-session host。
  - 明确 `@cortx/server` 是 HTTP/SSE adapter。
  - 明确 TUI/Web/Desktop 是 thin frontend。
  - 明确三件事必须同时交付：runtime host、server/frontend 薄化、core 边界收敛。
  - 明确 workspace 安全、approval 默认行为、skills/sub-agent 迁移方向、server API、frontend contract、架构边界测试和 95%/100% 验收标准。

### Round 4

- 完成 LFG simplify/review 方向的 focused pass：
  - reuse：确认 workspace path safety、workspace-tools capability、runtime host contract 已复用共享实现，没有发现需要再复制/合并的核心路径。
  - quality：修复 server SSE replay event id 固定为 `0` 的问题，改为连续序号。
  - quality/security：把 server 短期 token store 从模块级全局 `Map` 改为每个 `createServerRuntime()` 实例独立，避免同一进程多个 server 之间 token 串用。
  - reliability：Web `AuthClient` 记录 `tokenExpiresAt`，REST/SSE 统一通过 `getAuthToken()` 在 token 临近过期时自动刷新。
  - reliability：TUI `RemoteRuntimeClient` 记录短期 token 到期时间，再次连接 SSE 时会刷新临近过期 token。
  - boundary：TUI remote mode 不再按远端 `workingDirectory` 扫描本机 skill 文件；remote session 的 skills/历史由 server/runtime 侧负责。
- 新增/扩展测试：
  - server auth 测试覆盖短 token 只在同一 auth handler/server 实例内有效。
  - Web auth 测试覆盖过期短 token 自动刷新。
  - TUI remote client 测试覆盖临近过期 token 在重新连接 SSE 前刷新。
- 本轮 targeted verification：
  - `bun test packages/server/tests/auth.test.ts packages/server/tests/server.test.ts packages/web/tests/auth.test.ts packages/web/tests/event-bridge.test.ts packages/tui/src/__tests__/remote-client.test.ts packages/tui/src/__tests__/runtime-session.test.ts`
  - `bun run --filter '@cortx/server' lint`
  - `bun run --filter '@cortx/web' lint`
  - `bun run --filter '@cortx/tui' lint`
  - `bun test packages/runtime/tests/core-boundary.test.ts packages/runtime/tests/runtime.test.ts packages/runtime/tests/workspace.test.ts packages/core/tests/capabilities.test.ts`
  - `git diff --check`
- 本轮最终全量验证：
  - `bun run lint`：通过
  - `bun run build`：通过
  - `bun test`：716 pass，0 fail
  - `git diff --check`：通过

### Round 2

- 完成真实 HTTP smoke：
  - 用临时 workspace root 启动 `Bun.serve`。
  - 通过 `/auth/token` 获取短期 token。
  - 创建 `repo-a` / `repo-b` 两个 session。
  - 验证 `repo-a` prompt 产生事件并回到 idle。
  - 验证 `../outside` 被 `invalid_workspace` 拒绝。
  - 验证 abort endpoint 可调用。
- smoke 暴露嵌入生命周期问题：隐藏在 `createServer()` 内的 runtime 无法被外部显式 dispose。
- 新增 `createServerRuntime()` 和 `ServerRuntimeHandle`：
  - 保留 `createServer(config): Hono` 兼容现有用法。
  - 嵌入式 server、测试、未来 Desktop 可以拿到 `{ app, runtime, dispose }`。
  - `dispose()` 会释放 runtime sessions、pending questions 和 idle timers。
- runtime idle timer 创建后调用 `unref?.()`，降低脚本/嵌入场景被 cleanup timer 挂住的概率。
- server 测试改为使用 `createServerRuntime()` 并在 `afterAll` dispose。
- `docs/architecture/sdk-and-core-extension-guide.md` 新增 runtime-mounted capability 章节：
  - 区分 core contribution 与 runtime mounting。
  - 给出 `CortxRuntime` 配置示例。
  - 给出 `createServerRuntime()` 嵌入式生命周期示例。
  - 明确 skills/sub-agent 当前状态和后续迁移边界。

### Round 3

- 完成 TUI local render smoke：
  - 使用真实 `App` 组件树。
  - 使用真实 `createLocalRuntimeSession()`。
  - 用内存 TTY 模拟 Ink stdout/stdin。
  - 验证首屏输出包含 `Cortx`、`smoke-model`、`local`。
- 完成 TUI remote render smoke：
  - 启动真实 `createServerRuntime()` + `Bun.serve`。
  - 使用真实 `RemoteRuntimeClient` 和 `createRemoteRuntimeSession()`。
  - 用 fetch-based EventSource 替身消费真实 `/events` SSE。
  - prompt 后验证 TUI 输出包含 `remote` 与远端模型返回文本。
- 完成 Web Vite dev proxy smoke：
  - 启动 mock server on `localhost:3000`。
  - 启动 Web Vite dev server on `127.0.0.1:5177`。
  - 通过 Vite proxy 调用 `/auth/token`、`/sessions`、`/sessions/:id/prompt`。
  - 验证 session 产生事件并回到 idle。
- 完成 diff-scope 快速 review 并修复一处协议一致性问题：
  - `prompt`、`steer`、`follow-up` 的 invalid JSON / 非字符串 `message` 现在统一返回 `kind: invalid_request`。
  - 新增 server route 测试覆盖这些错误路径。

### Round 1

- 新增中文需求权威文档：`docs/brainstorms/2026-07-04-cortx-runtime-host-requirements.md`。
- 修复 `packages/core/tests/capabilities.test.ts` 的 `PluginRegistry` 单例污染，保证完整测试套件稳定。
- 扩展 `packages/runtime/tests/core-boundary.test.ts`：
  - core 不能导入 runtime/server/tui/web。
  - TUI/Web 不能直接依赖 runtime workspace-tools implementation。
  - server 不能重新出现 `session-manager.ts`。
  - server 不能直接 `new Cortx` 或导入 workspace-tools implementation。
  - Web 源码不能导入 core、runtime 或 workspace-tools implementation。

## 验证结果

已通过：

- 真实 HTTP smoke：
  - server 启动成功。
  - token exchange 成功。
  - 两个 workspace session 创建成功。
  - prompt 后 session 产生 5 个事件并回到 idle。
  - invalid workspace 返回 `invalid_workspace`。
  - abort endpoint 成功。
- `bun test packages/server/tests/server.test.ts`
- `bun test packages/server/tests/server.test.ts packages/server/tests/auth.test.ts`
- `bun run --filter '@cortx/server' lint`
- TUI local render smoke：输出包含 `Cortx`、`smoke-model`、`local`
- TUI remote render smoke：输出包含 `Cortx`、`smoke-model`、`remote`、远端响应文本
- Web Vite dev proxy smoke：通过 `127.0.0.1:5177` 代理完成 token/session/prompt，session eventCount = 5
- `bun test packages/core/tests/capabilities.test.ts packages/core/tests/core-extensions.test.ts`
- `bun test packages/runtime/tests/core-boundary.test.ts`
- `bun test packages/runtime/tests/workspace.test.ts packages/runtime/tests/runtime.test.ts packages/server/tests/server.test.ts packages/web/tests/event-bridge.test.ts packages/tui/src/__tests__/runtime-session.test.ts packages/tui/src/__tests__/remote-client.test.ts`
- `bun test`：717 pass，0 fail，1898 expect
- `bun run lint`：所有 workspace package 通过
- `bun run build`：所有 workspace package 通过，包含 Web production build
- `git diff --check`
- 本轮 targeted review checks：
  - server/auth/web/tui/runtime 相关 targeted tests：通过
  - server/web/tui scoped lint：通过
  - `git diff --check`：通过
- 本轮最新顺序验证（Round 7）：
  - `bun run lint`：7 个 workspace package 全部通过
  - `bun run build`：7 个 workspace package 全部通过，Web production build 通过
  - `bun test`：717 pass，0 fail，1898 expect
  - `git diff --check`：通过

## 下一轮建议

1. 按需要进入 shipping：
   - commit 当前 runtime/core/server/TUI/Web/doc/test 改动。
   - push 到目标远端/分支。
   - 如需要 PR，再补 PR 描述和 CI watch。
2. 做真人交互 smoke：
   - 在真实终端启动 TUI local mode，手动确认输入、历史、steer/abort。
   - 在真实终端启动 TUI remote mode，连接 server session。
   - 在浏览器打开 Web，手动确认 connect、prompt、abort/resume。
3. 决定是否继续推进 100% 项：
   - 把 skills bridge 完全迁成 runtime-mounted official capability。
   - 把 sub-agent tool 完全迁成 runtime-mounted official capability。
   - 加强真实崩溃后的 durable resume 和 background agent parent-child 语义。
