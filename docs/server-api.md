# Cortx Server API 接口说明

最后核对：2026-07-07，对照 `packages/server/src/server.ts` 当前实现。

本文档描述 `@cortx/server` 暴露给 Web、TUI、桌面端或第三方客户端的 HTTP/SSE 接口。Server 的职责是作为 thin client 背后的支撑端：认证、workspace 授权、多 session 管理、AgentSpec/SkillPack 资产发现、运行时事件回放和实时推送。真正的 agent 执行由 `@cortx/runtime` 承接，`@cortx/core` 仍保持为无宿主状态的 agent 基座。

## 1. 基本约定

### 1.1 Base URL

本地开发默认常见地址：

```text
http://localhost:3000
```

Web 开发服务器一般通过 Vite proxy 访问这些接口，因此浏览器侧代码可能直接请求 `/sessions`、`/models` 等相对路径。

### 1.2 认证方式

除 `GET /health` 外，所有接口都需要认证。

支持三种传递方式：

```http
Authorization: Bearer <apiKey-or-shortToken>
```

```text
?key=<apiKey>
```

```text
?token=<shortToken>
```

推荐普通 HTTP 请求使用 `Authorization: Bearer ...`。SSE 如果使用原生 `EventSource`，因为浏览器不能自定义 header，可以先调用 `POST /auth/token` 换短 token，再用 `?token=` 打开事件流。

### 1.3 API key scope

一个 API key 可以带独立的 principal scope：

```ts
interface ServerAuthKey {
  id?: string;
  key: string;
  allowedWorkspaceRoots?: string[];
  toolMode?: string;
  approvalMode?: 'deny' | 'interactive' | 'full-access';
}
```

Server 会在以下位置执行 scope 约束：

- `workingDirectory` 必须位于允许的 workspace roots 内。
- `toolMode` 不能超过 API key 允许的工具 profile。
- `approvalMode` 不能超过 API key 允许的权限模式。
- session、AgentSpec、SkillPack 列表会过滤当前 principal 不可访问的项目。

### 1.4 JSON Body 约定

支持空 body，空 body 会被解析成 `{}`。

如果 body 非空，必须是 JSON object。数组、字符串、数字等顶层 JSON 会返回 `invalid_request`。

### 1.5 通用错误响应

Runtime 类型错误会保持稳定结构：

```json
{
  "error": "Message is required",
  "kind": "invalid_request",
  "details": {}
}
```

常见 `kind` 与 HTTP status：

| kind | HTTP | 含义 |
| --- | ---: | --- |
| `invalid_request` | 400 | 请求体、query 或字段类型错误 |
| `invalid_workspace` | 400 | workspace 不存在、不可访问或不是目录 |
| `permission_denied` | 403 | 超出当前 API key 的 workspace/tool/approval scope |
| `session_not_found` | 404 | session 不存在，且 durable store 中也无法恢复 |
| `session_busy` | 409 | 当前 session 正在运行，不能再次启动 run |
| `capacity_exceeded` | 429 | 同时运行中的 session 数超过 `maxSessions` |
| `runtime_failure` | 500 | 未归类运行时错误 |

认证失败固定返回：

```json
{ "error": "Unauthorized" }
```

## 2. 主要资源模型

### 2.1 Session

`Session` 是 server/runtime 管理的 agent 会话。一个 session 有独立工作目录、模型、工具 profile、权限模式、技能挂载和事件历史。

```ts
interface RuntimeSessionInfo {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  workingDirectory: string;
  model: string;
  reasoningEffort?: string;
  system?: string;
  maxIterations?: number;
  contextWindowTokens?: number;
  contextWindowSource?: 'provider' | 'runtime_exact' | 'runtime_estimate' | 'configured' | 'model_metadata' | 'unknown';
  toolMode: string;
  approvalMode: 'deny' | 'interactive' | 'full-access';
  capabilities: {
    skills?: boolean;
    subAgents?: boolean;
    approval?: boolean;
  };
  skillPaths?: string[];
  skillPacks?: string[];
  promptHistory?: string[];
  usage?: AgentDoneUsage;
  isRunning: boolean;
  eventCount: number;
  metadata?: Record<string, unknown>;
}
```

`usage` 是会话累计 provider usage；其中 `usage.context` 描述最近一次完成请求的上下文窗口、缓存命中和 breakdown。

### 2.2 Tool Profile

工具不是 server 固定写死的模式，而是由 runtime registry/plugin 贡献 `runtime.toolProfile`。

默认至少存在：

```json
{
  "id": "none",
  "use": "none",
  "name": "None",
  "description": "Do not mount any tool profile tools.",
  "tools": []
}
```

官方或第三方插件可以贡献更多 profile，例如 coding、read-only、ops 等。`toolMode` 可以使用 profile 的 `id`、`use`、`pluginId` 或 `pluginId/id`。

### 2.3 Approval Mode

| approvalMode | 含义 |
| --- | --- |
| `deny` | 默认拒绝需要用户确认的工具调用 |
| `interactive` | 对写入/破坏性工具通过 `user_request` 事件向客户端请求确认 |
| `full-access` | 放行需要确认的工具调用 |

### 2.4 Agent Event

Server 支持两种事件格式：

- plain `AgentEvent`：历史兼容格式。
- envelope：推荐格式，额外包含 `sequence`、`timestamp`、`sessionId`、`runId` 和 sub-agent parent attribution。

推荐所有新客户端使用 envelope。

```ts
interface RuntimeAgentEventEnvelope {
  sequence: number;
  timestamp: number;
  sessionId: string;
  runId: number;
  event: AgentEvent;
  parent?: {
    sessionId: string;
    runId?: number;
    toolCallId?: string;
  };
}
```

常见 `AgentEvent.type`：

| type | 说明 |
| --- | --- |
| `user_message` | 用户消息，来源可能是 `prompt` 或 `follow_up` |
| `turn_start` / `turn_end` | agent loop 回合开始/结束 |
| `text_delta` / `text` | 模型文本流式片段或完整文本 |
| `thinking_delta` / `thinking` | 思考流式片段或完整思考文本 |
| `tool_use` | 即将调用工具 |
| `tool_progress` | 工具运行中进度 |
| `tool_result` | 工具调用结果，可能带 `details` 供 UI 展示 |
| `user_request` | 需要用户选择或确认，例如工具审批 |
| `user_question` / `user_answer` | askUser 问答事件 |
| `agent_started` / `agent_progress` / `agent_completed` | sub-agent 生命周期 |
| `done` | run 正常完成，可能带 usage |
| `error` | run 错误终止 |

## 3. 接口总览

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| GET | `/health` | 健康检查，不需要认证 |
| POST | `/auth/token` | 用 API key 换短 token，主要给 SSE 使用 |
| GET | `/models` | 获取 server 可选模型和推理强度信息 |
| GET | `/tool-profiles` | 获取当前 principal 可用工具 profile |
| GET | `/workspaces/directories` | 浏览允许 scope 内的服务端目录 |
| POST | `/sessions` | 创建 session |
| GET | `/sessions` | 列出当前 principal 可见 session |
| GET | `/sessions/:id` | 获取 session 详情 |
| PATCH | `/sessions/:id` | 更新 session 配置 |
| DELETE | `/sessions/:id` | 删除 session，并清理 durable runtime session |
| GET | `/sessions/:id/skills` | 列出 session 当前可用 skills |
| POST | `/sessions/:id/prompt` | 启动一次用户 prompt run |
| POST | `/sessions/:id/steer` | 当前 run 中插入 steer 指令 |
| POST | `/sessions/:id/follow-up` | 当前 run 中追加 follow-up，完成后自动继续 |
| POST | `/sessions/:id/resume` | 从当前 messages/checkpoint 继续运行 |
| POST | `/sessions/:id/abort` | 中止当前运行中的 session |
| POST | `/sessions/:id/answer` | 回答 `user_request` 或 askUser 问题 |
| GET | `/sessions/:id/events/history` | 一次性读取 session 事件历史，支持分页 |
| GET | `/sessions/:id/events` | 打开 session SSE 实时事件流 |
| GET | `/agent-specs` | 发现当前 principal 可见 AgentSpec |
| POST | `/agent-specs/launch` | 通过 AgentSpec 启动新 session |
| GET | `/skill-packs` | 列出已安装且可见 SkillPack |
| POST | `/skill-packs/install` | 安装本地 SkillPack 到 server registry |

## 4. 系统与认证接口

### 4.1 `GET /health`

健康检查。不需要认证。

响应：

```json
{
  "status": "ok",
  "uptime": 123.45,
  "sessions": 3,
  "runningSessions": 1,
  "maxSessions": 10
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `status` | 固定为 `ok` |
| `uptime` | Node 进程已运行秒数 |
| `sessions` | runtime 当前加载的 session 数 |
| `runningSessions` | 正在运行中的 session 数 |
| `maxSessions` | 允许同时运行的 session 上限 |

### 4.2 `POST /auth/token`

用长期 API key 换 15 分钟有效的短 token。短 token 继承原 API key 的 workspace/tool/approval scope。

请求：

```http
POST /auth/token
Authorization: Bearer <apiKey>
```

响应：

```json
{
  "token": "4b5c...",
  "expiresAt": 1780000000000
}
```

`expiresAt` 是毫秒时间戳。

## 5. 模型、工具与 Workspace

### 5.1 `GET /models`

返回 server 配置中的模型目录，供 UI 做模型选择器。

响应：

```json
{
  "models": [
    {
      "id": "claude-sonnet-4",
      "name": "Claude Sonnet 4",
      "contextWindowTokens": 200000,
      "reasoningEfforts": [
        { "value": "low", "label": "Light" },
        { "value": "medium", "label": "Medium" }
      ]
    }
  ]
}
```

实现会从 `config.modelCatalog`、`config.models` 中读取模型信息。如果当前默认 `config.model` 不在列表里，会补一个只包含 `id/name/contextWindowTokens` 的记录。

### 5.2 `GET /tool-profiles`

返回当前 principal 可用的工具 profile。profile 由 runtime registry/plugin 提供，server 会按 API key 的 `toolMode` scope 过滤。

响应：

```json
{
  "toolProfiles": [
    {
      "id": "none",
      "use": "none",
      "name": "None",
      "description": "Do not mount any tool profile tools.",
      "tools": []
    },
    {
      "id": "coding",
      "use": "@cortx-ai/workspace-tools/coding",
      "name": "Coding",
      "description": "Read, search, edit and run workspace commands.",
      "pluginId": "@cortx-ai/workspace-tools",
      "packageName": "@cortx-ai/workspace-tools",
      "tools": [
        { "use": "@cortx-ai/workspace-tools/read" },
        { "use": "@cortx-ai/workspace-tools/edit" }
      ]
    }
  ]
}
```

### 5.3 `GET /workspaces/directories`

浏览服务端文件系统中的目录。只返回当前 principal 允许访问的 roots 内的目录。

Query：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 可选。要浏览的目录；不传时使用当前 principal 的第一个 allowed root |

请求：

```http
GET /workspaces/directories?path=/Users/me/project
Authorization: Bearer <token>
```

响应：

```json
{
  "roots": ["/Users/me"],
  "current": "/Users/me/project",
  "parent": "/Users/me",
  "entries": [
    { "name": "app", "path": "/Users/me/project/app" },
    { "name": "packages", "path": "/Users/me/project/packages" }
  ]
}
```

说明：

- `entries` 只包含目录或可解析到授权目录的 symlink。
- `parent` 只有在父目录也可访问时才返回。
- 如果请求目录超出 scope，会返回 `permission_denied` 或 `invalid_workspace`。

## 6. Session 生命周期

### 6.1 `POST /sessions`

创建一个新的 runtime session。

请求体：

```ts
interface RuntimeSessionCreateRequest {
  id?: string;
  workingDirectory?: string;
  model?: string;
  reasoningEffort?: string;
  system?: string;
  maxIterations?: number;
  contextWindowTokens?: number;
  tools?: Tool[];
  toolMode?: string;
  approvalMode?: 'deny' | 'interactive' | 'full-access';
  capabilities?: {
    skills?: boolean;
    subAgents?: boolean;
    approval?: boolean;
  };
  skillPaths?: string[];
  skillPacks?: string[];
  registry?: unknown;
  plugins?: unknown[];
  metadata?: Record<string, unknown>;
}
```

常用请求：

```json
{
  "workingDirectory": "/Users/me/project",
  "model": "claude-sonnet-4",
  "reasoningEffort": "medium",
  "toolMode": "coding",
  "approvalMode": "interactive",
  "skillPacks": ["engineering"],
  "metadata": {
    "client": "web"
  }
}
```

响应状态：`201 Created`

```json
{
  "sessionId": "sess_1780000000000_abcd12",
  "session": {
    "id": "sess_1780000000000_abcd12",
    "workingDirectory": "/Users/me/project",
    "model": "claude-sonnet-4",
    "toolMode": "coding",
    "approvalMode": "interactive",
    "isRunning": false,
    "eventCount": 0
  }
}
```

授权行为：

- `workingDirectory` 会被解析到 allowed workspace roots 内。
- `toolMode` 和 `approvalMode` 会被 API key scope 限制。
- 如果 API key 自带 `toolMode` 或 `approvalMode`，请求未传时会自动补上 scope 默认值。

### 6.2 `GET /sessions`

列出当前 principal 可见的 session。

响应：

```json
{
  "sessions": [
    {
      "id": "sess_1780000000000_abcd12",
      "workingDirectory": "/Users/me/project",
      "model": "claude-sonnet-4",
      "toolMode": "coding",
      "approvalMode": "interactive",
      "promptHistory": ["帮我检查这个项目"],
      "usage": {
        "inputTokens": 4200,
        "outputTokens": 900
      },
      "isRunning": false,
      "eventCount": 128
    }
  ]
}
```

说明：

- 调用前会尝试从 durable store 恢复 session snapshot。
- 不可访问 workspace 的 session 会被过滤，不会导致整个列表失败。

### 6.3 `GET /sessions/:id`

获取单个 session 详情。若内存中没有该 session，会尝试从 durable store 恢复。

响应：

```json
{
  "session": {
    "id": "sess_1780000000000_abcd12",
    "createdAt": 1780000000000,
    "lastActivityAt": 1780000001000,
    "workingDirectory": "/Users/me/project",
    "model": "claude-sonnet-4",
    "toolMode": "coding",
    "approvalMode": "interactive",
    "capabilities": {
      "skills": true,
      "subAgents": true,
      "approval": true
    },
    "isRunning": false,
    "eventCount": 128
  }
}
```

### 6.4 `PATCH /sessions/:id`

更新 session 配置。适合 Web/TUI 在当前 session 内切换模型、思考强度、工具 profile 或权限模式，不应该因此新建 session。

请求体：

```ts
interface RuntimeSessionUpdateRequest {
  model?: string;
  reasoningEffort?: string | null;
  toolMode?: string;
  approvalMode?: 'deny' | 'interactive' | 'full-access';
  contextWindowTokens?: number;
  capabilities?: {
    skills?: boolean;
    subAgents?: boolean;
    approval?: boolean;
  };
  skillPaths?: string[];
  skillPacks?: string[];
  metadata?: Record<string, unknown>;
}
```

示例：

```json
{
  "model": "claude-opus-4",
  "reasoningEffort": "high",
  "toolMode": "read-only",
  "approvalMode": "interactive"
}
```

响应：

```json
{
  "session": {
    "id": "sess_1780000000000_abcd12",
    "model": "claude-opus-4",
    "reasoningEffort": "high",
    "toolMode": "read-only"
  }
}
```

说明：

- `reasoningEffort: null` 表示清空思考强度。
- 如果变更会影响 host，例如工具、技能、模型等，runtime 会在下一次 run 前 rebuild session host。

### 6.5 `DELETE /sessions/:id`

删除 session。

响应：

```json
{ "ok": true }
```

说明：

- 删除前会 abort 当前 run。
- 会清理 runtime durable session snapshot。
- 删除后再次访问该 id 会返回 `session_not_found`。

### 6.6 `GET /sessions/:id/skills`

列出当前 session 可发现的 skills。

响应：

```json
{
  "skills": [
    {
      "name": "code-review",
      "description": "Review code changes for bugs, regressions, and missing tests.",
      "arguments": ["target"],
      "dirPath": "/Users/me/project/.cortx/skills/code-review"
    }
  ]
}
```

说明：

- 如果 session capability `skills` 为 `false`，返回空数组。
- 返回内容不包含 skill 正文，只包含 UI 需要展示的元信息。

## 7. Session 操作接口

### 7.1 `POST /sessions/:id/prompt`

启动一次新的用户 prompt run。

请求体：

```json
{
  "message": "帮我 review 当前改动"
}
```

响应：

```json
{ "ok": true }
```

说明：

- `message` 必须是非空字符串。
- 如果 session 已在运行，返回 `session_busy`。
- 成功后 runtime 会广播 `user_message`，并把原始用户输入写入 `promptHistory`。

### 7.2 `POST /sessions/:id/steer`

向当前正在运行的 agent 插入 steer 指令。steer 用于改变本轮正在执行的方向，不会作为新的 prompt 启动 run。

请求体：

```json
{
  "message": "先不要修改文件，只给我分析"
}
```

响应：

```json
{ "ok": true }
```

说明：

- `message` 必须是非空字符串。
- runtime 会调用 `controller.steer(message)`。
- 不会写入 `promptHistory`。

### 7.3 `POST /sessions/:id/follow-up`

在当前 run 中追加后续消息。适合 UI 做“运行中追加消息，等当前工具/回合安全点后自动处理”的交互。

请求体：

```json
{
  "message": "另外把测试也跑一下"
}
```

响应：

```json
{ "ok": true }
```

说明：

- 会广播 `user_message`，`source` 为 `follow_up`。
- 会写入 `promptHistory`。
- runtime 会调用 `controller.followUp(message)`。

### 7.4 `POST /sessions/:id/resume`

让 session 从当前 messages/checkpoint 继续运行。

请求体：可为空。

响应：

```json
{ "ok": true }
```

说明：

- 如果 session 正在运行，返回 `session_busy`。
- 常用于 durable restore 后继续未完成工作，或 UI 显式继续。

### 7.5 `POST /sessions/:id/abort`

中止当前运行。

请求体：可为空。

响应：

```json
{ "ok": true }
```

说明：

- 会 abort 主 agent、running sub-agents 和 pending user questions。
- 当前实现会等待旧 run promise 完成清理后再解锁 session。

### 7.6 `POST /sessions/:id/answer`

回答 agent 发出的用户请求。主要用于：

- 工具审批：`user_request.kind = "tool_approval"`。
- 工具或 sub-agent 主动问用户：`user_question`。

请求体：

```json
{
  "toolCallId": "toolu_123",
  "response": "yes"
}
```

响应：

```json
{ "ok": true }
```

错误：

- `toolCallId` 或 `response` 不是字符串：`invalid_request`。
- 没有匹配的 pending question：`invalid_request`。

说明：

- 审批类请求的可选响应由事件里的 `request.allowedResponses` 表达，客户端应渲染为选择控件，而不是要求用户手输 yes/no。

## 8. 事件历史与 SSE

### 8.1 推荐消费流程

Web/桌面端推荐：

1. `GET /sessions/:id/events/history?format=envelope&limit=200`
2. 用返回的 `page.lastSequence` 打开：
   `GET /sessions/:id/events?format=envelope&replay=false&after=<lastSequence>`
3. 后续分页加载更早历史：
   `GET /sessions/:id/events/history?format=envelope&before=<firstSequence>&limit=200`

这样可以快速切换旧 session，不需要 SSE 连接一开始重放大量历史。

### 8.2 `GET /sessions/:id/events/history`

一次性读取事件历史。

Query：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `format` | string | 传 `envelope` 时返回 envelope；不传时返回 plain `AgentEvent[]` |
| `after` | number | 只返回 sequence 大于该值的 envelope |
| `before` | number | 只返回 sequence 小于该值的 envelope |
| `limit` | number | 最多返回条数，最大 2000 |

Envelope 请求：

```http
GET /sessions/sess_123/events/history?format=envelope&limit=200
```

Envelope 响应：

```json
{
  "events": [
    {
      "sequence": 1,
      "timestamp": 1780000000000,
      "sessionId": "sess_123",
      "runId": 1,
      "event": {
        "type": "user_message",
        "message": "帮我 review",
        "source": "prompt"
      }
    }
  ],
  "page": {
    "hasMoreBefore": false,
    "hasMoreAfter": true,
    "firstSequence": 1,
    "lastSequence": 200
  }
}
```

Plain 请求响应：

```http
GET /sessions/sess_123/events/history
```

```json
{
  "events": [
    { "type": "text", "content": "..." }
  ]
}
```

说明：

- `after/before/limit` 只对 envelope 分页路径生效。
- 历史读取会从 durable event store 和内存事件合并。
- 对于缺少 `tool_result.details` 的旧 edit 事件，server 会尽量根据工具输入和当前文件状态补充文件编辑详情，方便 UI 展示 diff。

### 8.3 `GET /sessions/:id/events`

打开 SSE 实时事件流。

Query：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `format` | string | 传 `envelope` 时使用推荐 envelope 格式 |
| `replay` | string | 默认 replay 历史；传 `false` 只订阅 live event |
| `after` | number | envelope 模式下只回放 sequence 大于该值的事件 |
| `token` | string | 短 token，给原生 EventSource 使用 |

推荐请求：

```text
GET /sessions/sess_123/events?format=envelope&replay=false&after=200&token=<shortToken>
```

SSE event：

```text
id: 201
data: {"sequence":201,"timestamp":1780000000000,"sessionId":"sess_123","runId":2,"event":{"type":"text_delta","delta":"hello"}}
```

Heartbeat：

```text
data: {}
```

说明：

- Envelope SSE 使用 `sequence` 作为 SSE `id`。
- Server 先订阅 live event，再读取 snapshot，并缓冲窗口内 live event，避免快照和订阅之间漏事件。
- 客户端应忽略 `{}` heartbeat。
- 客户端仍建议按 `sequence` 去重，尤其是断线重连或旧客户端 replay 场景。

## 9. AgentSpec 接口

AgentSpec 是一个声明式 agent 启动规格。它可以来自服务端发现的 JSON 文件，也可以通过 inline body 直接提交。

### 9.1 AgentSpec 格式

```ts
interface AgentSpec {
  schemaVersion?: 1;
  name?: string;
  prompt: string;
  system?: string;
  model?: string;
  workingDirectory?: string;
  toolMode?: string;
  approvalMode?: 'deny' | 'interactive' | 'full-access';
  capabilities?: {
    skills?: boolean;
    subAgents?: boolean;
    approval?: boolean;
  };
  skillPaths?: string[];
  skillPacks?: string[];
  tools?: Tool[];
  metadata?: Record<string, unknown>;
}
```

`prompt` 必填且不能为空。

### 9.2 `GET /agent-specs`

发现当前 principal 可见的 AgentSpec。

发现 roots：

- 如果配置了 `config.agentSpecRoots`，使用这些 roots。
- 否则扫描：
  - `~/.cortx/agents`
  - `~/.cortx/agent-specs`
  - `<workspace>/.cortx/agents`
  - `<workspace>/.cortx/agent-specs`
- 已安装 SkillPack 中声明的 agent spec 也会进入 discovery。

响应：

```json
{
  "agentSpecs": [
    {
      "path": "/Users/me/project/.cortx/agents/reviewer.json",
      "relativePath": "reviewer.json",
      "sourceRoot": "/Users/me/project/.cortx/agents",
      "schemaVersion": 1,
      "name": "basic-reviewer",
      "promptPreview": "Review the current repository...",
      "workingDirectory": "/Users/me/project",
      "toolMode": "coding",
      "approvalMode": "interactive",
      "skillPacks": ["engineering"],
      "metadata": {}
    }
  ]
}
```

说明：

- 无效 AgentSpec 会被跳过。
- 不可访问的 spec path 或 `workingDirectory` 会被过滤。

### 9.3 `POST /agent-specs/launch`

按 AgentSpec 启动新 session。启动成功后会自动执行 spec 中的 `prompt`。

方式一：通过 path 启动。

```json
{
  "path": ".cortx/agents/reviewer.json"
}
```

方式二：通过 inline spec 启动。

```json
{
  "spec": {
    "name": "quick-review",
    "prompt": "Review this repository and list correctness risks.",
    "workingDirectory": "/Users/me/project",
    "toolMode": "read-only"
  }
}
```

也可以直接把 AgentSpec 作为 body：

```json
{
  "name": "quick-review",
  "prompt": "Review this repository and list correctness risks.",
  "toolMode": "read-only"
}
```

响应状态：`201 Created`

```json
{
  "sessionId": "sess_1780000000000_abcd12",
  "session": {
    "id": "sess_1780000000000_abcd12",
    "isRunning": true
  }
}
```

说明：

- path 会相对 `defaultWorkingDirectory` 解析。
- relative `skillPaths` 和 path-like `skillPacks` 会相对 AgentSpec 的 source root 解析。
- `workingDirectory`、`toolMode`、`approvalMode` 仍受当前 API key scope 约束。

## 10. SkillPack 接口

SkillPack 是一组 filesystem assets，可以包含 skills 和 agents，不需要写 JavaScript plugin code。

### 10.1 SkillPack manifest

支持两个 manifest 位置：

- `skill-pack.json`
- `.cortx/skill-pack.json`

格式：

```ts
interface SkillPackManifest {
  schemaVersion?: 1;
  name?: string;
  version?: string;
  description?: string;
  skillPaths?: string[];
  agentSpecPaths?: string[];
  metadata?: Record<string, unknown>;
}
```

如果没有 manifest，会使用默认约定：

- `skills/`
- `.cortx/skills/`
- `agents/`

### 10.2 `GET /skill-packs`

列出已安装到 server registry 且当前 principal 可访问的 SkillPack。

响应：

```json
{
  "skillPacks": [
    {
      "schemaVersion": 1,
      "id": "engineering",
      "name": "Engineering",
      "version": "0.1.0",
      "description": "Engineering workflow skills",
      "path": "/Users/me/cortx-packs/engineering",
      "sourcePath": "/Users/me/cortx-packs/engineering",
      "installedAt": 1780000000000,
      "skillPaths": ["/Users/me/cortx-packs/engineering/skills"],
      "agentSpecPaths": ["/Users/me/cortx-packs/engineering/agents"],
      "metadata": {}
    }
  ]
}
```

### 10.3 `POST /skill-packs/install`

安装本地 SkillPack 到 server registry。

请求体：

```json
{
  "path": "../cortx-plugins/skill-packs/engineering",
  "id": "engineering"
}
```

响应状态：`201 Created`

```json
{
  "skillPack": {
    "id": "engineering",
    "name": "Engineering",
    "sourcePath": "/Users/me/cortx-plugins/skill-packs/engineering",
    "installedAt": 1780000000000
  }
}
```

说明：

- `path` 必填。
- `id` 可选；不传时会从 pack name 或 path 归一化生成。
- `path` 相对 `defaultWorkingDirectory` 解析。
- install 只记录本地路径，不会复制文件。
- 安装后，普通 session 可通过 `skillPacks: ["engineering"]` 启用；AgentSpec discovery 也会扫描该 pack 的 agents。

## 11. 客户端接入建议

### 11.1 Web/桌面端推荐启动流程

1. 用长期 API key 调 `POST /auth/token`。
2. 并行加载：
   - `GET /models`
   - `GET /tool-profiles`
   - `GET /sessions`
   - `GET /agent-specs`
   - `GET /skill-packs`
3. 用户选择或添加项目目录时，用 `GET /workspaces/directories` 做服务端目录浏览。
4. 创建 session：`POST /sessions`。
5. 切换模型、工具和权限：`PATCH /sessions/:id`，不要新建 session。
6. 发送消息：`POST /sessions/:id/prompt`。
7. 历史加载 + 实时流：
   - 先 `GET /events/history?format=envelope&limit=200`
   - 再 `GET /events?format=envelope&replay=false&after=<lastSequence>`

### 11.2 运行中追加消息

- 改变当前 run 的行为：用 `POST /steer`。
- 排队追加后续任务：用 `POST /follow-up`。
- 中止：用 `POST /abort`。

### 11.3 用户确认

客户端收到：

```json
{
  "type": "user_request",
  "request": {
    "requestId": "toolu_123",
    "kind": "tool_approval",
    "prompt": "Allow edit?",
    "allowedResponses": ["yes", "no"]
  }
}
```

应该渲染为明确选择控件。用户选择后调用：

```http
POST /sessions/:id/answer
```

```json
{
  "toolCallId": "toolu_123",
  "response": "yes"
}
```

### 11.4 分页加载旧历史

客户端维护当前已渲染 envelope 的最小和最大 sequence：

- 加载更旧：`before=<firstSequence>&limit=200`
- 追实时：`after=<lastSequence>&replay=false`

加载更旧历史时，UI 应保持滚动锚点，不应自动滚到底部。

## 12. 接口与代码位置

当前所有 route 均定义在：

```text
packages/server/src/server.ts
```

关键类型位置：

| 类型 | 文件 |
| --- | --- |
| `ServerConfig` | `packages/server/src/types.ts` |
| `AuthPrincipal` / token exchange | `packages/server/src/auth.ts` |
| `RuntimeSessionInfo` / create/update request | `packages/runtime/src/session.ts` |
| `RuntimeToolProfile` | `packages/runtime/src/tool-mount.ts` |
| `AgentSpec` | `packages/runtime/src/assets/agent-spec.ts` |
| `SkillPack` / install registry | `packages/runtime/src/assets/skill-pack.ts`, `packages/runtime/src/assets/skill-pack-registry.ts` |
| `AgentEvent` / `RuntimeAgentEventEnvelope` | `packages/sdk/src/events.ts` |
