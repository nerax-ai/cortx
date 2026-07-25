# Cortx 文档索引

本文档是当前 Cortx 文档体系的入口。先读这里，再进入具体架构、接口、规划或历史资料。

## 当前权威文档

| 文档 | 用途 |
| --- | --- |
| [../README.md](../README.md) | 项目入口、包结构、启动命令、当前路线图 |
| [architecture/cortx-core-runtime-blueprint.md](architecture/cortx-core-runtime-blueprint.md) | 当前最高层架构蓝图：`core + runtime + server + thin frontends + plugins` |
| [architecture/sdk-and-core-extension-guide.md](architecture/sdk-and-core-extension-guide.md) | SDK、core 扩展点、runtime-mounted capability、policy、checkpoint 语义 |
| [architecture/cortx-official-plugins.md](architecture/cortx-official-plugins.md) | 官方插件拆分口径，尤其 workspace-tools 与 `runtime.toolProfile` |
| [server-api.md](server-api.md) | Server HTTP/SSE API、认证、session、事件历史、AgentSpec、SkillPack |
| [progress/2026-07-05-cortx-remaining-work.md](progress/2026-07-05-cortx-remaining-work.md) | 当前完成度、剩余缺口和下一步推进顺序 |

## 当前项目事实

当前包边界是：

- `packages/core`
- `packages/runtime`
- `packages/sdk`
- `packages/server`
- `packages/store`
- `packages/tui`
- `packages/web`

`packages/code` 已删除。具体 workspace 工具已经迁到兄弟项目 `../cortx-plugins/workspace-tools`，由插件提供工具和 `runtime.toolProfile`，runtime 只负责按 session 配置挂载。

当前分层口径：

- `core`：单 agent 执行内核，不包含具体产品能力。
- `runtime`：多 session、多目录、capability、approval、skills、sub-agent、AgentSpec、SkillPack、durable resume 和 event replay 的 host 层。
- `server`：runtime 的 HTTP/SSE adapter。
- `tui`：local runtime 或 remote server 的终端前端。
- `web`：remote-only 的 React 工作台。
- `sdk`：插件作者和工具作者使用的稳定契约。
- `store`：共享 event reducer。
- `cortx-plugins`：官方工具、策略、观察器和可选能力实现。

## 推荐阅读顺序

1. 先读 [../README.md](../README.md)，了解项目是什么和如何启动。
2. 再读 [architecture/cortx-core-runtime-blueprint.md](architecture/cortx-core-runtime-blueprint.md)，理解为什么 core 要保持最小、runtime 为什么是唯一 host。
3. 如果要接入客户端，读 [server-api.md](server-api.md)。
4. 如果要写插件或工具，读 [architecture/sdk-and-core-extension-guide.md](architecture/sdk-and-core-extension-guide.md) 和 [architecture/cortx-official-plugins.md](architecture/cortx-official-plugins.md)。
5. 如果要决定下一步做什么，读 [progress/2026-07-05-cortx-remaining-work.md](progress/2026-07-05-cortx-remaining-work.md)。

## 历史文档

以下目录保留为历史设计过程，不应直接当成当前实现事实：

- `brainstorms/`
- `ideation/`
- `plans/`

其中 2026-07-04 以前的部分文档会提到旧的 `@cortx/code` / `packages/code`、旧的 4 包结构、core 内置 skill discovery、core 内置 sub-agent tool，或 TUI/server 自己管理 agent session。这些描述已经被 runtime-host 架构取代。

读取历史文档时遵循这个规则：

- 架构事实以 [architecture/cortx-core-runtime-blueprint.md](architecture/cortx-core-runtime-blueprint.md) 为准。
- 插件和工具边界以 [architecture/cortx-official-plugins.md](architecture/cortx-official-plugins.md) 为准。
- API 事实以 [server-api.md](server-api.md) 为准。
- 当前缺口以 [progress/2026-07-05-cortx-remaining-work.md](progress/2026-07-05-cortx-remaining-work.md) 为准。

## 文档维护规则

- 新增当前设计时，优先更新本索引并明确权威文档。
- 历史 brainstorm/plan 可以保留，但如果会误导读者，应在顶部标注历史说明。
- 不再把 `@cortx/code` 或 `packages/code` 描述为当前包。
- 新工具、工具集、策略和可选能力优先进入 `cortx-plugins`，不要写成 core/runtime 内置产品能力。
- 根目录文档使用英文；`docs/` 下可以使用中文，方便内部规划和审查。
