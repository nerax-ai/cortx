---
date: 2026-07-05
topic: cortx-remaining-work
baseline_commit: c06a513
latest_audit_commit: 6301cc5
status: partially-closed
language: zh-CN
---

# Cortx 当前剩余缺口

## 当前判断

Cortx 的核心架构方向已经基本成立：`@cortx/core` 已经收敛成最小 agent kernel，`@cortx/runtime` 承担多 session、多目录、workspace tools、skills、sub-agent、approval、AgentSpec 和 SkillPack 等 host 能力，server/TUI/Web 也已经按薄前端和 runtime host 分层。

因此当前缺口不再是“核心方向是否正确”，而是从架构底座走向长期可用产品所需的最后几块：真实端到端验证、TUI/Web 体验、SDK 易用性、AgentSpec/SkillPack 产品入口，以及更高阶的运维能力。

## 2026-07-05 最新审计更新

截至本轮工作，已经关闭本文件原先最硬的 P0/P1 后端产品化缺口，并补上两个 P2 运维缺口：

- P0 真实持久化 resume：已新增 `FileDurableRunStore`，持久化 checkpoint、runtime session snapshot 和 sub-agent snapshot；runtime 已提供 `restoreDurableSessions({ autoResume })`，server 启动时使用 file durable store 并显式 restore。
- P0 Background/Sub-Agent 生命周期：parent abort/destroy 已取消 live child controller；child snapshot 已持久化并可在 restore 后 hydrate；child lifecycle envelope 保留 parent session/run/toolCall attribution。
- P1 SDK 作者体验：已新增 `defineContributionFactory()`、`defineToolFactory()`、`defineSessionPolicyFactory()`、`defineEventObserverFactory()`，并有导出测试与文档。
- P1 AgentSpec/SkillPack 产品化：runtime 可从 JSON 文件启动 AgentSpec，server 暴露 `POST /agent-specs/launch`，Web bridge 与 TUI remote client 可直接调用该 endpoint；`examples/skill-packs/basic` 提供无需 JavaScript plugin code 的 skill-pack 示例。
- Web 多 session 基础：当前 Web 已有 server session list、按 workspace/project 分组、同一 project 多 session 切换、tool/control 独立创建 session、approval/abort/resume/follow-up client path。
- P2 durable event store：runtime durable store 已新增 event envelope snapshot，FileDurableRunStore 会按 session/sequence 持久化事件并按 retention window 裁剪旧事件，restore 时回填 bounded event history，server/frontend 在进程重启后仍可 replay 关键历史。
- P2 schema migration：durable file records 现在统一经过 migration parser；v0 session/sub-agent/event 记录可迁到当前 schema，invalid/unsupported records 仍会跳过；event replay methods 也变成 optional durable capability，旧 custom store 不会因此失去 session/sub-agent 持久化能力。
- P2 server 权限边界：server 已支持多 API key principal、短 token 继承 principal scope、按 token workspace roots 过滤 session list，并在 session action/SSE/AgentSpec file launch 前做 scope 检查；tool/control mode scope 也不能被 request body 越权。

仍然没有被这轮完全关闭的项：

- TUI 与 Web 的真实长会话 dogfood 仍需要人工/真实 provider 回归，尤其长输出复制、断线重连、approval + abort/resume + sub-agent 组合流程。
- 完整 SaaS 级多用户权限模型、长会话压测、数据库/压缩/归档策略和 streaming-time token preemption 仍属于后续运维级增强；其中 file-backed event replay 已具备默认 bounded retention，server 已具备本地产品阶段的 token-scoped workspace/mode 授权边界。
- `@synax-ai/*` `link:` 依赖按本轮要求暂不清理，因为当前仍以本地测试为主。

当前参考验证状态：

- 最新架构收口提交：`c06a513 feat(runtime): complete core boundary host`
- 当前全量测试：`bun test` 通过，`758 pass / 0 fail / 2144 expect`
- 当前包边界：`core / runtime / sdk / server / store / tui / web`
- `packages/code` 已删除，workspace tools 已迁入 runtime-hosted capability
- `@cortx/core` 不再默认 discovery skills、不再默认创建 `agent` tool、不再内置 default approval policy

## 总体完成度

| 维度 | 当前状态 | 判断 |
| --- | --- | --- |
| Core 架构 | 已基本完成 | `@cortx/core` 已接近通用 agent kernel |
| Runtime host | 已基本完成 | 多 session、多目录、能力挂载、event envelope、durable resume、durable event replay 已落地 |
| Server adapter | 较成熟 | HTTP/SSE、token、session action、runtime delegation 已稳定 |
| SDK | 可用但还不够顺手 | 底层类型清楚，但缺更高层插件作者 helper 和版本策略 |
| TUI | 能用但仍需打磨 | local/remote adapter 已通，真实日常体验还不够成熟 |
| Web | 桌面工作台骨架已成型 | remote-only 方向正确，已有 sidebar/conversation/inspector/composer/session list，但真实长流程体验仍要 dogfood |
| 产品化完整度 | 未完成 | 还缺端到端验证、TUI/Web polish、插件/asset 生态入口和高阶运维能力 |

整体判断：

- 作为通用 Agent 底座：约 `95% - 97%`
- 作为完整可长期使用产品：约 `84% - 88%`

## P0：真实持久化 Resume

### 当前状态

已关闭 P0。Runtime 已经有 `FileDurableRunStore`、checkpoint schema、`sessionId + runId` 语义、runtime session snapshot、sub-agent snapshot、event envelope snapshot、durable snapshot migration layer，以及 `restoreDurableSessions({ autoResume })`。

### 缺口

- 缺 sqlite/database backend；当前 file backend 足够支撑本地产品阶段。

### 后续验收

- 进程 A 跑到非终态 checkpoint 后退出。
- 进程 B 用同一 workspace/session storage 启动。
- Runtime 能发现并恢复 session。
- Resume 后不需要调用者手动重建隐藏 core state。
- unsupported schema 能给出 typed error，而不是静默失败。

## P0：Background / Sub-Agent 生命周期

### 当前状态

已关闭 P0。Sub-agent 已经从 core 迁入 runtime capability，支持 foreground/background，parent abort/destroy 会取消 live child controller；child snapshot 和 parent attribution 已可持久化并恢复。

### 缺口

- 多 child 并发时 UI 归属、排序、失败状态需要统一。
- child run 的资源释放、超时、错误传播策略需要更明确。

### 后续验收

- parent session abort 后，foreground child 和 background child 都能收到可合作取消信号。
- child terminal event 必须带 parent session/run/toolCall attribution。
- runtime restart 后能恢复 parent-child 关系。
- TUI/Web 能基于同一事件语义展示 child lifecycle。

## P1：TUI 真实产品体验

### 当前状态

TUI 已经支持 local runtime 和 remote server 两种模式，输入历史、steer、markdown、thinking、tool region、session restore 等都有测试覆盖。

### 缺口

- 长输出、滚动、复制体验还需要真实终端打磨。
- tool/sub-agent 展示还不够接近 Claude Code / Codex 的成熟感。
- approval 交互还需要更清楚的默认体验。
- markdown/code block/thinking 展示仍需要继续 polish。
- 多 session、多目录、多 agent 切换还没有完整产品化。

### 后续验收

- 真实终端中跑完整 coding session。
- 能稳定查看和复制长输出。
- 能清楚区分 assistant text、thinking、tool use、tool result、sub-agent lifecycle。
- steer/abort/follow-up/history/session restore 在真实使用中可预期。

## P1：Web 产品能力

### 当前状态

Web 保持 remote-only 薄前端，并已从单栏聊天页升级为桌面式 workspace：

- 左侧 sidebar 展示 session、workspace、model、tool/approval 和 run facts。
- 中间 conversation canvas 区分 user、assistant/streaming、thinking、error 和 empty state。
- 底部 composer 支持 prompt/follow-up/awaiting-user 状态。
- 右侧 inspector 展示 runtime facts、tool tabs、sub-agent tabs 和稳定空状态。
- Approval dialog 已迁到 Base UI dialog，tool card 使用 Base UI collapsible，inspector 使用 Base UI tabs。
- 连接页已有 connecting/error/retry 基础状态。
- Web 仍通过 `EventBridge` 访问 server/runtime，不直接依赖 core/runtime/workspace-tools 内部实现。

### 缺口

- session 列表、多 project 分组和同 project 多 session 切换已有第一版；多目录、多 agent 管理体验还需要真实 dogfood 后继续打磨。
- 缺完整 event replay UI。
- Approval dialog、tool/result、sub-agent 可视化已有第一版，但还缺真实长会话 dogfood 后的细节打磨。
- 缺断线、重连、恢复体验。
- 缺真实 server/provider 环境下的 Web remote 长流程验证。

### 后续验收

- Web 能连接 server，创建多个不同 workspace session。
- Web 能显示 session 列表和 event replay。
- Web 能处理 approval、abort、resume、follow-up。
- Web 不直接依赖 core/runtime/workspace-tools 内部实现。

## P1：SDK 插件作者体验

### 当前状态

底层 extension/policy/tool/event 类型已经拆清楚，core/runtime 边界也比之前稳定。SDK 已新增 `defineContributionFactory()`、`defineToolFactory()`、`defineSessionPolicyFactory()`、`defineEventObserverFactory()`，并有导出测试和文档。

### 缺口

- helper 已有第一版，但还可以继续打磨更贴近官方插件模板的 `defineRuntimeCapability()` 等组合 helper。
- 缺 tsd 级别的独立编译期类型测试。
- 缺 extension schemaVersion 和 migration 策略。
- 缺官方插件开发手册。
- 缺错误示例、推荐组合方式和最小可运行样例。

### 后续验收

- 插件作者不需要理解 core loop 内部即可写出 tool/policy/event observer。
- 错误 contribution factory 能在编译期或注册边界被清楚拦截。
- 文档覆盖最小插件、workspace capability、approval、skills、sub-agent、server/TUI/Web 使用边界。

## P1：AgentSpec / SkillPack 产品化

### 当前状态

AgentSpec 和 SkillPack v1 已落地，可以作为 runtime asset 启动 prompt-only 或 skill-pack-backed session。Runtime 支持 JSON 文件启动，server/Web bridge/TUI remote client 已有启动入口。

### 缺口

- 缺安装、发现、启用入口。
- 缺 manifest 规范和版本策略。
- 官方示例包已有 basic 版本，但还缺覆盖更多真实官方插件集场景的示例。
- 缺 Web/TUI 中面向用户的 AgentSpec 选择器；底层 API 已就绪。
- 缺 skill pack 与普通 `SKILL.md`、companion files、prompt template 的完整官方约定。

### 后续验收

- 一个 prompt-only AgentSpec 可以无需 JavaScript plugin code 运行。
- 一个 SkillPack 可以安装到本地、被 runtime discovery、被 session enable。
- TUI/server/Web 至少有一种入口能选择并启动 AgentSpec。

## P1：真实端到端验证

### 当前状态

已有大量单测、conformance、smoke test。它们证明架构边界和主要协议成立，但仍缺真人真实环境的完整回归。

### 缺口

- 缺 TUI local mode 完整 coding session。
- 缺 TUI remote mode 连接 server 跑完整 session。
- 缺 Web 连接 server 跑完整 session。
- 缺多目录、多 session、多 agent 同时运行验证。
- 缺 abort/resume/approval/sub-agent 的组合场景验证。

### 后续验收

- 用真实 provider 跑 local TUI。
- 用真实 server 跑 remote TUI。
- 用浏览器跑 Web。
- 同时创建多个 workspace session。
- 中途触发 approval、abort、resume、sub-agent，并确认事件、状态、UI、资源释放一致。

## P2：性能与运维细节

### 缺口

- Runtime event history 已 bounded，真实 file-backed durable event envelope store、snapshot migration layer、event retention window 已落地；数据库/压缩/归档策略仍可作为更高阶后端增强。
- Long-running session 的内存、timer、pending request、sub-agent store 需要压测。
- Streaming token budget 目前仍以后验 usage 为主，缺 streaming-time preemption。
- Server 已有多 token / 多 workspace root 的本地产品级授权边界，但完整多用户账号、审计、TLS、组织权限仍未做。

### 后续验收

- 长会话不会无限增长内存，file-backed event replay 也不会无限增长 event files。
- abort/dispose 后不会留下 pending timer 或 pending user request。
- 多 session 并发时 event envelope sequence 和 session attribution 稳定。
- API key A 不能访问、操作或订阅 API key B workspace 下的 session。

## 建议推进顺序

1. 做一次真人端到端 dogfood：TUI local、TUI remote、Web remote。
2. 基于 dogfood 修 TUI 体验和 Web 基础产品能力。
3. 补长会话压测、streaming-time token preemption 和多用户权限模型。
4. 打磨 SDK helper、类型测试、官方插件开发手册。
5. 产品化 AgentSpec / SkillPack 的安装、发现、选择器和更多官方示例入口。

## 结论

Cortx 当前已经从“架构是否自洽”的阶段，进入“是否能成为长期可用 Agent 产品底座”的阶段。

下一轮不应再优先大改 core。更应该围绕 TUI/Web dogfood、SDK 体验、asset 产品化和高阶运维能力继续推进。只要这些补齐，Cortx 就能从 95% 左右的架构完成度，推进到接近 9.5 分的整体可用度。
