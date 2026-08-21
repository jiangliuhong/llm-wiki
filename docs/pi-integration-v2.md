# LLM Wiki Pi 集成设计（V2）

- 状态：方案确认，待实施
- 适用范围：LLM Wiki Desktop 的 AI 对话与 Pi Runtime
- 替代范围：`architecture-v1.md` 第 11 章中的 Desktop Pi 集成细节

## 1. 决策摘要

LLM Wiki 不集成、嵌入或依赖 Pi Hub 产品，也不复用 Pi Hub UI。

LLM Wiki 继续自行构建全部对话 UI，并在项目内部集成 Pi SDK。实现上借鉴 Pi Hub 的 AgentSession 管理方式，包括统一的 Session Wrapper、应用级 Session Registry、运行状态管理和生命周期清理。

Desktop 最终采用以下结构：

```text
LLM Wiki React UI
        │
        ▼
AgentClient
        │ Tauri command / event
        ▼
Tauri Rust Host
        │ JSONL stdio
        ▼
单个 Node Agent Runtime
        │
        ▼
Pi SDK
        │ tool_request / tool_result
        ▼
Rust Knowledge Core
```

核心决策：

1. 一个 Desktop 应用只启动一个 Node Agent Runtime，不再按工作空间启动多个 sidecar。
2. React 不直接管理 Pi SDK、子进程或底层传输，通过统一的 `AgentClient` 使用 Agent 能力。
3. Tauri 保留为可信边界，但仅承担进程监管、协议透传、凭据读取、工作空间授权和 Core 工具执行。
4. Agent Runtime 负责 Pi SDK、模型运行时、会话、流式事件、取消、压缩和并发状态。
5. Pi 通过双向 Host Tool Bridge 调用 Rust Knowledge Core，不直接读取 SQLite，也不为 Desktop 额外启动 MCP 子进程。
6. Pi JSONL 保存对话运行数据；LLM Wiki SQLite 保存产品级会话元数据；localStorage 不再保存完整对话。
7. API Key 存入系统 Keychain，不写入工作区配置文件。
8. Session 恢复失败后的自动新建与问题重放可以保留，本方案不对自动重放增加额外约束。

## 2. 目标

- 在 LLM Wiki 内部稳定集成 Pi SDK。
- 保留 LLM Wiki 自有的桌面 UI 和产品交互。
- 统一模型、会话、流式消息和 Agent 生命周期。
- 消除 React、Rust Host 与 Node Runtime 之间重复的会话状态。
- 让 Pi 只能通过受控工具访问 Knowledge Core。
- 支持多工作空间、多会话、取消、压缩和进程重启恢复。
- 保持 Desktop 的 Tauri 权限边界，不暴露本地 Agent HTTP 端口。
- 为将来的 CLI Pi Runtime 复用保留清晰的 Runtime 边界。

## 3. 非目标

- 不集成 Pi Hub 应用。
- 不通过 iframe、WebView 页面或远程服务使用 Pi Hub。
- 不复用 Pi Hub UI。
- 不把 Desktop 改造成 Next.js 服务。
- 不允许 Pi 直接执行 Bash 或任意文件读写。
- 不让 Pi 直接打开 `.llm-wiki/index.db`。
- 不在 Desktop 内为每个工作空间启动一个 MCP Server。
- 本方案不处理自动重放的幂等性约束。

## 4. 当前实现的问题

当前链路为：

```text
React
→ Tauri invoke / event
→ Rust sidecar registry
→ JSONL
→ 自定义 SessionHost
→ Pi SDK
```

主要问题包括：

### 4.1 多套会话状态

当前完整对话保存在前端 localStorage，Pi Runtime 另行保存 JSONL 和 `index.json`，Rust 又维护 sidecar 与 pending request。三层状态可能出现不一致：

- UI 有对话但 Pi session 已不存在；
- Pi session 存在但 UI 已删除对话；
- Runtime 已输出事件但 React 没有路由到目标消息；
- sidecar 重启后前端和 Runtime 对 session 状态判断不同。

### 4.2 多 sidecar

当前按工作空间维护 Node 进程。每个进程都有独立的 ModelRuntime、Session Registry 和请求计数器，增加了进程数量、资源消耗、请求路由和重启恢复的复杂度。

### 4.3 Rust Host 承担过多 Agent 逻辑

Rust Host 当前同时负责：

- 子进程查找与启动；
- JSONL 请求 ID；
- pending request；
- 流式事件转发；
- 超时；
- sidecar 重启；
- 模型配置与 API Key 持久化。

其中会话和模型相关职责应归 Agent Runtime 所有。

### 4.4 Runtime 直接读取 SQLite

当前 Runtime 的默认 Host Tools 使用 `node:sqlite` 读取工作区数据库。这会复制 Core 查询逻辑，并违背“Pi 负责推理，Core 负责执行”的边界。

### 4.5 凭据明文持久化

模型配置当前允许把 `apiKey` 写入 `<workspace>/.llm-wiki/config.json`。工作区文件不应保存模型密钥。

## 5. 目标架构

### 5.1 组件关系

```text
┌──────────────────────────────────────────┐
│ LLM Wiki React UI                        │
│                                          │
│ ChatView → AgentClient → Agent Reducer   │
└────────────────────┬─────────────────────┘
                     │ Tauri command/event
┌────────────────────▼─────────────────────┐
│ Tauri Rust Host                          │
│                                          │
│ - Agent Runtime supervisor               │
│ - Keychain                               │
│ - Workspace authorization                │
│ - Knowledge Core tool execution          │
│ - Thin protocol routing                  │
└───────────────┬────────────────▲─────────┘
                │ JSONL stdio    │ tool_result
┌───────────────▼──────────────────────────┐
│ Node Agent Runtime                       │
│                                          │
│ - Pi SDK                                 │
│ - AgentSessionWrapper                    │
│ - SessionRegistry                        │
│ - Pi JSONL sessions                      │
│ - model / thinking / compact / abort     │
│ - customTools → tool_request             │
└──────────────────────────────────────────┘
```

### 5.2 为什么保留 Tauri IPC

Pi Hub 使用 HTTP/SSE 是因为它本身运行在 Web Server 中。Desktop 已有 Tauri command/event 通道，不需要额外开放 localhost HTTP 服务。

保留 Tauri IPC 可以避免：

- 端口发现和冲突；
- CSP 与 CORS 配置；
- localhost 服务认证；
- WebView 持有本地服务 token；
- 防火墙提示；
- SSE 连接恢复与状态补偿。

借鉴 Pi Hub 的重点是 Session 管理和运行状态模型，而不是照搬其 HTTP 部署方式。

## 6. 组件职责

### 6.1 React UI

React 负责：

- 对话列表与消息渲染；
- 输入、停止、重新生成等用户操作；
- thinking、回答、工具调用和错误状态展示；
- 通过 reducer 消费标准化 Agent 事件；
- 工作空间和当前会话选择；
- 输入草稿及纯 UI 偏好。

React 不负责：

- 创建 Pi SDK 实例；
- 维护 sidecar；
- 解析 Pi session 文件；
- 自行恢复 AgentSession；
- 保存完整消息副本；
- 按 token 维护多套错误和恢复 Map。

前端统一通过以下抽象调用 Agent：

```ts
interface AgentClient {
  createSession(input: CreateSessionInput): Promise<SessionInfo>;
  listSessions(workspaceId: string): Promise<SessionInfo[]>;
  getSession(sessionId: string): Promise<SessionSnapshot>;
  prompt(sessionId: string, text: string): Promise<RunInfo>;
  cancel(sessionId: string): Promise<void>;
  compact(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
```

### 6.2 Tauri Rust Host

Rust Host 负责：

- 启动一个固定的 Agent Runtime；
- 健康检查、异常退出检测和应用退出清理；
- Tauri command 与 Runtime 请求的薄转发；
- Runtime 事件到 Tauri event 的薄转发；
- 从系统 Keychain 读取模型凭据；
- 验证 workspaceId 与 workspaceRoot；
- 执行 Pi 发起的受控 Core Tool 请求；
- 返回结构化 Core Tool 结果。

Rust Host 不负责：

- Pi session 内部状态；
- 消息拼接；
- 模型目录解析；
- thinking 与 text delta 合并；
- Pi session 文件恢复；
- Agent 运行状态推导。

### 6.3 Node Agent Runtime

Agent Runtime 负责：

- 初始化 Pi SDK；
- 管理 ModelRuntime；
- 创建和恢复 AgentSession；
- 维护应用级 Session Registry；
- 保证同一 session 的运行状态一致；
- prompt、cancel、compact、fork 和 delete；
- 订阅 Pi 事件并输出标准化 Runtime 事件；
- 管理 Pi JSONL session；
- 将 LLM Wiki customTools 转换为 Host Tool 请求；
- 空闲 session 清理和 Runtime shutdown。

Runtime 的 Session 管理可借鉴 Pi Hub 的实现思想，但代码应成为 LLM Wiki 自己的模块，不依赖 Pi Hub 包或服务。

## 7. Runtime 与会话模型

### 7.1 单 Runtime、多工作空间

Runtime 为应用级单例：

```text
AgentRuntime
└── SessionRegistry
    ├── workspace-a / session-1
    ├── workspace-a / session-2
    └── workspace-b / session-3
```

每个请求必须显式携带：

```ts
interface RuntimeScope {
  workspaceId: string;
  workspaceRoot: string;
  sessionId?: string;
  runId?: string;
}
```

Runtime 不根据进程当前目录隐式推断工作空间。

### 7.2 AgentSessionWrapper

每个 Pi AgentSession 使用统一 Wrapper，至少提供：

- `isAlive()`；
- `isRunning()`；
- `sendPrompt()`；
- `cancel()`；
- `compact()`；
- `fork()`；
- `dispose()`；
- `getState()`；
- `subscribe()`。

Wrapper 统一处理：

- Pi 原始事件标准化；
- 运行状态；
- session shutdown；
- idle cleanup；
- model 和 thinking level；
- tool execution 状态。

### 7.3 Session Registry

Registry 必须：

- 使用真实 Pi sessionId 作为主键；
- 防止同一 session 被重复构造；
- 统一保存启动中的 Promise；
- 在恢复时打开既有 Pi session 文件；
- 在 session dispose 后清理 registry；
- 支持不同 session 并行执行；
- 避免同一 session 出现相互冲突的运行操作。

## 8. 数据所有权

| 数据 | 所有者 | 存储位置 |
|---|---|---|
| 用户消息、助手消息、thinking、tool call | Pi Runtime | Pi JSONL session |
| Pi 上下文、分支、compact 信息 | Pi Runtime | Pi JSONL session |
| workspaceId 与 sessionId 映射 | LLM Wiki | SQLite |
| 对话标题、归档、收藏、排序 | LLM Wiki | SQLite |
| 文档引用和回答引用 | LLM Wiki | SQLite 或消息关联表 |
| 输入草稿和纯 UI 状态 | React | localStorage |
| Provider、模型 ID、thinking 默认值 | LLM Wiki | `.llm-wiki/config.json` 或全局设置 |
| API Key / OAuth 凭据 | Rust Host | 系统 Keychain |

完整对话不再序列化到 localStorage。UI 打开会话时，从 Runtime 获取 Pi session snapshot，再订阅增量事件。

删除对话时必须同时处理：

1. 删除或归档 LLM Wiki 会话元数据；
2. 调用 Runtime 删除 Pi session；
3. 清理当前 UI 状态；
4. 任一步骤失败时返回可恢复的结构化错误。

## 9. 双向 Host Tool Bridge

### 9.1 原则

Pi 负责推理，Rust Knowledge Core 负责数据访问和业务执行。

Agent Runtime 不允许：

- 直接打开 SQLite；
- 任意读取工作空间文件；
- 执行 Bash；
- 绕过草稿审核修改文档。

### 9.2 只读工具

首批保留以下工具：

```text
workspace_get
workspace_status
document_list
document_search
document_read
document_read_range
document_relations
document_neighborhood
```

### 9.3 调用流程

```text
Pi 调用 customTool
→ Runtime 输出 tool_request
→ Rust 校验 workspace 和工具名
→ Rust 调用 Knowledge Core
→ Rust 返回 tool_result
→ Runtime 完成 customTool Promise
→ Pi 继续执行
```

请求示例：

```json
{
  "protocolVersion": "2",
  "id": "request-id",
  "type": "tool_request",
  "sessionId": "session-id",
  "workspaceId": "workspace-id",
  "toolCallId": "tool-call-id",
  "tool": "document_search",
  "input": {
    "query": "退款规则",
    "limit": 10
  }
}
```

响应示例：

```json
{
  "protocolVersion": "2",
  "id": "request-id",
  "type": "tool_result",
  "toolCallId": "tool-call-id",
  "ok": true,
  "output": []
}
```

Desktop 不需要为了该调用额外启动 MCP Server。MCP 仍用于外部 Agent 和 CLI 集成，与 Desktop 内部 Host Tool Bridge 分开。

## 10. 协议设计

协议继续使用 LF 分隔 JSONL，但升级协议版本，并支持双向消息。

### 10.1 Host → Runtime

```text
ping
session_new
session_list
session_get
session_prompt
session_cancel
session_compact
session_fork
session_delete
runtime_shutdown
tool_result
```

### 10.2 Runtime → Host

```text
ready
pong
response
event
tool_request
runtime_error
```

### 10.3 标准事件

```text
session_created
session_restored
agent_start
thinking_delta
text_delta
tool_execution_start
tool_execution_end
agent_end
agent_error
session_deleted
```

每条会话事件至少包含：

```ts
interface AgentEventEnvelope {
  protocolVersion: "2";
  sessionId: string;
  workspaceId: string;
  runId?: string;
  event: AgentEvent;
}
```

请求 ID 必须在整个 Agent Runtime 范围内唯一，不能由每个工作空间进程分别从 `host-1` 开始编号。

## 11. 模型与凭据

工作区配置只保存非敏感数据，例如：

```json
{
  "model": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-5",
    "baseUrl": null,
    "thinkingLevel": "medium",
    "credentialId": "llm-wiki:anthropic:default"
  }
}
```

规则：

- `apiKey` 不得写入 `.llm-wiki/config.json`；
- `apiKey` 不得写入 Pi session；
- `apiKey` 不得出现在日志、事件和错误详情中；
- Rust 根据 `credentialId` 从系统 Keychain 读取凭据；
- 凭据只在创建或恢复模型运行时注入 Runtime；
- Runtime 只在内存中持有凭据。

## 12. 自动恢复与重放

本方案允许保留现有行为：当 session 无法恢复时，可以创建新的 Pi session 并重新发送当前问题。

自动重放不属于本方案的评审约束，本阶段不新增幂等键、运行查询或重放确认机制。

重放后的新 sessionId 必须同步更新到 LLM Wiki 的会话元数据，避免 UI 继续引用失效 session。

## 13. 错误模型

Runtime 与 Host 返回稳定错误码，不要求 React 解析错误字符串：

```text
PI_RUNTIME_NOT_FOUND
PI_RUNTIME_START_FAILED
PI_RUNTIME_EXITED
PI_MODEL_NOT_CONFIGURED
PI_AUTH_REQUIRED
PI_SESSION_NOT_FOUND
PI_SESSION_BUSY
PI_SESSION_FAILED
PI_SESSION_CANCELLED
PI_EMPTY_RESPONSE
PI_TOOL_NOT_ALLOWED
PI_TOOL_FAILED
PI_PROTOCOL_ERROR
```

错误必须包含：

```ts
interface AgentError {
  code: string;
  message: string;
  retryable: boolean;
  sessionId?: string;
  runId?: string;
}
```

React 只根据错误码决定展示、恢复或回退行为。

## 14. 迁移计划

### 阶段 1：建立 Agent Runtime 内核

- 新建应用级 `AgentSessionWrapper`；
- 新建应用级 `SessionRegistry`；
- 将 Runtime 从“每工作区一个进程”改为“每应用一个进程”；
- 保留现有只读工具作为临时兼容实现；
- 增加真实模型冒烟测试。

### 阶段 2：统一前端 AgentClient

- 新建 `AgentClient`；
- 将 Tauri invoke/event 封装在 Client 内；
- 使用 reducer 管理会话运行状态；
- ChatView 不再直接维护 Pi transport Map；
- 完整消息不再写入 localStorage。

### 阶段 3：实现双向 Core Tool Bridge

- 增加 `tool_request` 和 `tool_result`；
- Rust Host 执行 Knowledge Core 工具；
- 删除 Runtime 中的 `node:sqlite` 查询；
- 增加 workspace scope、工具白名单和参数验证测试。

### 阶段 4：会话元数据迁移

- 在 LLM Wiki SQLite 中增加会话元数据表；
- 迁移 localStorage 中仍可识别的历史会话映射；
- UI 从 Pi session snapshot 加载消息；
- 删除会话时同步清理 Runtime 和产品元数据。

### 阶段 5：凭据迁移

- 接入系统 Keychain；
- 配置文件改存 `credentialId`；
- 检测并迁移已有明文 API Key；
- 迁移成功后从配置文件删除明文密钥。

### 阶段 6：删除旧实现

完成真实模型、恢复、工具调用和打包验收后，删除：

- 每工作区 sidecar registry；
- Runtime 直接 SQLite Host Tools；
- 前端完整对话 localStorage；
- ChatView 内部 transport 恢复和 delta 路由代码；
- 明文 API Key 配置路径。

## 15. 测试要求

### Runtime 单元测试

- 创建、恢复、切换、取消、压缩和删除 session；
- 同一 session 的运行状态互斥；
- 不同 session 可并行；
- 多工作空间共用一个 Runtime；
- Runtime shutdown 清理全部 session；
- Pi 事件正确转换为标准事件。

### Host Tool Bridge 测试

- 只允许白名单工具；
- workspaceId 与 workspaceRoot 不匹配时拒绝；
- `tool_request` 与 `tool_result` 正确关联；
- Core 错误映射为稳定错误码；
- Runtime 不能直接打开 SQLite；
- Pi 不获得 Bash、Write 或 Edit 工具。

### Desktop 集成测试

- 创建对话并收到流式文本；
- thinking 和回答阶段正确切换；
- 停止生成；
- 切换工作空间后原会话仍可恢复；
- 删除对话同步删除 Pi session；
- Runtime 崩溃后可以重启；
- session 恢复失败时可新建 session 并重放当前问题；
- 未配置模型时回退本地搜索。

### 安全测试

- 工作区配置中不存在明文 API Key；
- 日志和事件中不存在凭据；
- Runtime 只能访问授权工作空间；
- 未知工具和越权路径被拒绝；
- WebView 不直接访问本地 Agent 网络端口。

## 16. 验收标准

方案完成后必须满足：

1. LLM Wiki UI 完全独立于 Pi Hub。
2. 项目运行时不依赖 Pi Hub 包、进程、页面或 API。
3. Desktop 只启动一个 Node Agent Runtime。
4. 多工作空间和多会话可由同一 Runtime 管理。
5. 对话消息以 Pi JSONL 为真实来源，不在 localStorage 保存完整副本。
6. LLM Wiki SQLite 保存 session 与 workspace 的产品级映射。
7. Pi 的文档工具全部通过 Rust Knowledge Core 执行。
8. Agent Runtime 不直接读取 SQLite。
9. API Key 只保存在系统 Keychain。
10. 真实模型可以完成创建会话、流式回答、取消、恢复和删除的端到端流程。
