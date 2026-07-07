# Cortx 官方插件架构

本文档记录当前官方插件拆分口径：Cortx 的核心包不内置具体产品能力，官方能力通过 `cortx-plugins` 项目提供。

## 分层结论

| 层 | 职责 |
| --- | --- |
| `@cortx/core` | 单 agent loop、tool pipeline、event、checkpoint、extension hooks |
| `@cortx/runtime` | 多 session、workspace 验证、插件 tool profile 挂载、approval/sub-agent/skill host 能力 |
| `@cortx/server` | 加载插件源、暴露 REST/SSE、按 config/API key 控制 session |
| `@cortx/tui` | local mode 加载插件源或 remote mode 连接 server |
| `@cortx/web` | remote-only，只消费 server API，不加载本地工具插件 |
| `cortx-plugins` | 官方工具、策略、观察器和可选能力实现 |

## 当前官方插件

`../cortx-plugins/workspace-tools` 提供 `@cortx-ai/workspace-tools`：

- `@cortx-ai/workspace-tools/read`
- `@cortx-ai/workspace-tools/write`
- `@cortx-ai/workspace-tools/edit`
- `@cortx-ai/workspace-tools/bash`
- `@cortx-ai/workspace-tools/grep`
- `@cortx-ai/workspace-tools/find`
- `@cortx-ai/workspace-tools/ls`

插件还通过 `runtime.toolProfile` 声明工具集。`toolMode` 在 runtime/session API 中保留字段名，但语义已经变成“选择哪个插件贡献的 tool profile”：

| `toolMode` / profile id | 挂载 contribution |
| --- | --- |
| `none` | 不挂载 workspace tools |
| `read-only` | `read`、`grep`、`find`、`ls` |
| `coding` | `read`、`bash`、`edit`、`write` |
| `all` | 全部 workspace tools |

这些值不是 runtime 内置枚举。安装新的插件后，插件可以声明新的 profile，例如 `ops`：

```json
{
  "contributes": {
    "runtime.toolProfile": [
      {
        "id": "ops",
        "name": "Ops",
        "tools": [
          "@cortx-ai/ops-tools/read-logs",
          "@cortx-ai/ops-tools/kubectl",
          "@cortx-ai/ops-tools/metrics"
        ]
      }
    ]
  }
}
```

## Server 加载方式

server 启动时会按以下顺序决定 workspace tools 插件源：

1. `cortx.json` 中的 `workspaceToolsPlugin`。
2. 环境变量 `CORTX_WORKSPACE_TOOLS_PLUGIN`。
3. 默认兄弟目录 `../cortx-plugins/workspace-tools`。
4. 如果显式配置 `workspaceToolsPlugin: false`，则禁用官方 workspace tools。

示例：

```json
{
  "model": "default",
  "toolMode": "coding",
  "workspaceToolsPlugin": "../cortx-plugins/workspace-tools",
  "plugins": ["../my-cortx-plugin"]
}
```

通常不需要手写 `agentPlugins` 来挂载 workspace tools；runtime 会根据每个 session 的 `workingDirectory` 和 `toolMode` 找到对应 tool profile，再自动生成对应配置。

## 后续官方插件候选

- `repo-policy`：仓库级系统提示词、提交规范、review policy。
- `browser-tools`：浏览器导航、截图、交互验证工具。
- `git-tools`：diff/status/commit/branch 等更精细的 Git 工具。
- `diagnostics`：event observer、trace exporter、usage exporter。

新增官方能力优先放入 `cortx-plugins`。只有当能力是所有 agent 都绕不开的单 agent 执行语义时，才考虑进入 `@cortx/core`。
