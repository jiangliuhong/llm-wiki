# LLM Wiki 桌面端、CLI 与 MCP 一体化设计（V1）

> 状态：Proposal  
> 日期：2026-08-12  
> 适用仓库：`jiangliuhong/llm-wiki-cli`

## 1. 背景

当前项目已经具备本地文档扫描、切片、SQLite FTS5 索引、实验性向量检索、CLI 搜索以及 Next.js 检索页面。下一阶段不再只把它视为一个 CLI，而是将其升级为一个本地优先的知识工作台：

- 桌面端负责工作空间管理、问答、文档浏览、导入、草稿 Diff 和用户确认；
- CLI 负责脚本化、自动化和无界面操作；
- MCP Server 负责向 Codex、Claude Code、Pi 及其他 Agent 暴露知识检索和受控写入能力；
- Pi 负责桌面端内置的模型调用、Agent 编排、问答、总结和文档规划；
- 共享 Knowledge Core 负责工作空间、文件、索引、搜索、草稿、权限和审计。

产品定位：

> LLM Wiki 是一个本地优先、多工作空间、可被人和 Agent 共同使用的知识库工作台。

## 2. 目标与非目标

### 2.1 V1 目标

1. 支持创建和添加多个本地工作空间。
2. 支持在工作空间内搜索、提问、总结并生成带引用的回答。
3. 支持上传文件，经过提取、分析、拆分方案和确认后写入工作空间。
4. 支持把回答或总结保存为新文档，或者以草稿形式更新已有文档。
5. 所有高风险写入统一经过“草稿 → Diff → 确认 → 写入 → 增量索引”。
6. 桌面端、CLI 和 MCP 共享同一套核心能力与数据格式。
7. CLI 和 MCP 不依赖桌面程序处于运行状态。
8. MCP 默认只读，并通过工作空间和路径白名单控制写入。
9. 第一阶段优先支持 macOS Apple Silicon，随后补齐 Windows 与 Linux。

### 2.2 V1 非目标

- 云端账号、云同步和多用户实时协作；
- 公网开放的远程 MCP 服务；
- Agent 不经确认直接删除、移动或覆盖文档；
- 默认向 Pi 暴露 Bash、任意文件读写或整个用户目录；
- 扫描 PDF OCR、图片 OCR、复杂表格还原等高成本能力；
- 一开始同时支持所有模型厂商和所有文件格式。

## 3. 核心设计原则

1. **Local-first**：工作空间、索引、会话、附件和审计数据默认保存在本机。
2. **Single Core**：桌面、CLI、MCP 共享核心领域模型，不各自实现一套搜索和写入逻辑。
3. **Pi 负责推理，Core 负责执行**：Pi 不直接操作 SQLite 和任意文件系统。
4. **外部 Agent 不套 Pi**：外部 Agent 通过 MCP 直接调用 Knowledge Core，避免 Agent 套 Agent。
5. **默认只读**：搜索和读取默认开放，真实写入必须显式授权。
6. **引用优先**：问答结果必须尽量返回文档路径、标题、行号或页码。
7. **渐进迁移**：现有 TypeScript `packages/kb` 作为行为基准，目标架构逐步迁移到 Rust Core，不做无测试保护的一次性重写。

## 4. 技术决策

| 领域 | V1 选型 | 决策说明 |
| --- | --- | --- |
| 桌面壳 | Tauri 2 | 负责窗口、系统能力、权限、Sidecar 生命周期和安装包 |
| 桌面前端 | React 19 + Vite | Tauri 更适合 SPA；不继续依赖 Next.js Server/API Routes |
| 基础 UI | HeroUI v3 | 保留现有 React 组件资产，用于表单、按钮、弹窗、菜单、表格等 |
| 样式 | Tailwind CSS v4 | 建立紧凑型桌面主题和布局系统 |
| 桌面专用 UI | 自建 `desktop-ui` 层 | 文件树、可调整分栏、右键菜单、命令面板、文档标签、Diff 等不直接依赖 HeroUI |
| 内置 AI | Pi SDK Sidecar | 负责模型、会话、Agent 编排、流式输出、问答和总结 |
| 共享核心 | Rust（目标架构） | 供 Tauri、CLI 和 MCP 复用；迁移期保留 TypeScript Core 作对照 |
| 本地存储 | SQLite + WAL + FTS5 | 全局注册表与每个工作空间独立数据库 |
| 向量检索 | 可选适配层 | 只有跨平台打包验证通过后才默认启用；始终支持 FTS-only 降级 |
| CLI | Rust CLI | 稳定 JSON 输出，供脚本和其他 Agent 使用 |
| MCP | Rust MCP Server | V1 使用 stdio，后续按需增加 Streamable HTTP |
| 发布 | Tauri 安装包 + GitHub Release + npm 二进制包装包 | 用户无需安装 Rust；CLI/MCP 可单独安装 |

## 5. 目标架构

```text
┌─────────────────────────────────────────────────────────────┐
│                         用户入口                            │
├──────────────────┬──────────────────┬───────────────────────┤
│ Desktop           │ CLI              │ MCP Server            │
│ React + Vite      │ llm-wiki         │ llm-wiki-mcp          │
│ HeroUI + Tailwind │                  │ stdio / HTTP（后续）   │
└─────────┬────────┴────────┬─────────┴──────────┬────────────┘
          │ Tauri invoke     │ Rust API           │ Rust API
          └──────────────────┼────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                     llm-wiki-core                           │
│                                                             │
│ Workspace / Document / Import / Index / Search / Draft      │
│ Write / Jobs / Locks / Backup / Audit / Migration           │
└───────────────────────┬───────────────────┬─────────────────┘
                        │                   │
                        │ host tools        │ SQLite / Files
                        ▼                   ▼
              ┌─────────────────┐  ┌──────────────────────────┐
              │ Pi Runtime      │  │ global.db / workspace.db │
              │ Node Sidecar    │  │ wiki/ / attachments/     │
              │ Pi SDK          │  │ cache/ / backups/        │
              └─────────────────┘  └──────────────────────────┘
```

关键约束：

- 桌面前端不直接访问工作空间文件和数据库；
- Pi Runtime 不直接打开工作空间数据库，也不拥有任意路径写权限；
- Tauri Host 负责启动、监控、重启和停止 Pi Sidecar；
- CLI 和 MCP 直接链接 Core，因此桌面应用关闭后仍然可用；
- 所有入口使用同一套工作空间 ID、文档 ID、错误码和审计格式。

## 6. Pi 集成设计

### 6.1 定位

Pi 负责生成式 AI 和 Agent 能力：

- 工作空间问答；
- 多轮检索与分析；
- 文档和会话总结；
- 文件导入后的主题识别与拆分建议；
- 生成 Markdown 文档草稿；
- 根据用户反馈继续修改草稿；
- 模型认证、模型选择、会话状态和流式事件。

Knowledge Core 负责确定性能力：

- 工作空间解析；
- 文档扫描和文本提取；
- 切片、索引和检索；
- 文档读取和引用定位；
- 草稿持久化和 Diff；
- 路径校验、权限判断、备份、写入和审计。

### 6.2 运行方式

正式架构采用独立 `llm-wiki-pi-runtime` Sidecar：

```text
Tauri WebView → Tauri Rust Host → JSONL → Pi Runtime → Pi SDK
```

选择 Sidecar 而不是把 Pi 直接放进 React WebView，原因是 WebView 不是完整 Node.js 运行环境。Sidecar 同时提供进程隔离、生命周期控制和独立崩溃恢复能力。

集成策略：

- 正式版本优先使用 Pi SDK，便于精确控制模型、会话、Tools 和事件；
- 原型阶段可以使用 `pi --mode rpc` 快速验证 JSONL 流程；
- Sidecar 使用应用自己的会话目录，不自动把项目状态写入工作空间源码目录；
- Pi 的认证状态可以复用，但 LLM Wiki 的工作空间、权限和产品设置独立存储。

### 6.3 Pi 可调用的 Host Tools

只读工具：

```text
workspace_get
workspace_status
document_list
document_search
document_read
document_read_range
```

草稿工具：

```text
document_draft_create
document_draft_update
document_draft_get
```

V1 不向 Pi 暴露：

```text
bash
write_file
edit_file
delete_file
move_file
document_draft_apply
```

Pi 可以生成和更新草稿，但不能绕过用户确认提交真实文件。

### 6.4 Host Bridge 协议

Tauri Host 与 Pi Runtime 使用 LF 分隔的 JSONL。协议必须包含请求 ID、会话 ID、工作空间 ID、事件类型和结构化错误码。

示例：

```json
{
  "id": "req-002",
  "type": "prompt",
  "sessionId": "session-001",
  "workspaceId": "pl-wiki",
  "message": "总结这个工作空间中的国家数据权限设计"
}
```

Pi 请求搜索：

```json
{
  "id": "tool-001",
  "type": "host_tool.request",
  "sessionId": "session-001",
  "tool": "document_search",
  "arguments": {
    "query": "国家数据权限",
    "limit": 10
  }
}
```

Rust Core 返回结果后，Pi 继续生成带引用的答案。协议需要支持：

- `assistant.delta`：流式文本；
- `tool.request` / `tool.result`：工具调用；
- `session.created` / `session.closed`；
- `generation.cancel`；
- `error`；
- 心跳与 Sidecar 重连。

### 6.5 外部 Agent 调用原则

```text
桌面内置 AI → Pi → Knowledge Core
外部 Agent → MCP → Knowledge Core
```

MCP 的搜索、读取和草稿工具不再调用 Pi。外部 Agent 已经具有推理能力，再套一层 Pi 会增加 Token、延迟和行为不确定性。

## 7. 多工作空间设计

### 7.1 工作空间类型

| 类型 | 含义 |
| --- | --- |
| Managed Workspace | 由 LLM Wiki 创建并管理的新目录 |
| Linked Workspace | 把已有项目或文档目录注册为工作空间 |

每个内容根目录必须标明访问模式：

- `read-write`：允许用户确认后写入，例如 `wiki/`；
- `read-only`：只能索引和检索，例如项目源码、已有 `docs/`。

### 7.2 工作空间目录

```text
my-workspace/
├── wiki/                         # 规范化知识文档，可读写
├── attachments/                  # 导入的原始文件
└── .llm-wiki/
    ├── workspace.json            # 工作空间身份与配置
    ├── workspace.db              # 索引、会话、任务、草稿、审计
    ├── cache/
    ├── backups/
    └── locks/
```

全局目录：

```text
~/.llm-wiki/
├── global.db                     # 工作空间注册、应用设置、最近访问
├── logs/
└── cache/
```

工作空间使用稳定 UUID。目录被移动后，可以通过 `.llm-wiki/workspace.json` 重新识别。

### 7.3 CLI 工作空间解析顺序

```text
1. --workspace 参数
2. LLM_WIKI_WORKSPACE 环境变量
3. 从当前目录向上查找 .llm-wiki/workspace.json
4. 全局默认工作空间
```

### 7.4 工作空间数据库

建议包含：

| 表 | 作用 |
| --- | --- |
| `documents` | 文档路径、哈希、类型、状态和元数据 |
| `chunks` | 文档切片和引用位置 |
| `chunks_fts` | FTS5 索引 |
| `chunk_embeddings` | 可选向量数据和模型版本 |
| `assets` | 导入原文件 |
| `ingestion_jobs` | 文件导入任务 |
| `index_jobs` | 索引任务和错误 |
| `chats` / `messages` | 桌面问答会话 |
| `message_citations` | 回答引用 |
| `drafts` | 待确认草稿 |
| `write_operations` | 文件写入及 Diff |
| `audit_logs` | Desktop、CLI、MCP 操作记录 |
| `schema_migrations` | 数据库版本迁移 |

### 7.5 并发与一致性

- SQLite 启用 WAL；
- 每个工作空间使用单写入队列；
- 写操作使用工作空间级文件锁；
- 文件采用临时文件 + 原子 rename；
- 修改已有文档时携带 `expectedHash`；
- 哈希不一致时拒绝覆盖并要求重新生成 Diff；
- 覆盖、移动或删除前创建备份；
- 写入和索引任务写入审计日志。

## 8. 搜索与引用

### 8.1 索引流程

```text
文件识别
  → 文本提取
  → 结构化切片
  → FTS5 索引
  → 可选 Embedding
  → 文档和索引状态入库
```

切片策略按类型区分：

- Markdown：标题层级 + 段落；
- 代码：class、function、method；
- JSON/YAML：顶层对象和节点；
- TXT：段落；
- PDF/DOCX：标题、段落和页码。

每个 chunk 至少保存：

```text
heading_path
start_line
end_line
page_number
token_count
source_hash
```

### 8.2 中文检索

当前默认 `unicode61` 对中文召回偏弱。V1 应优先解决：

1. 为中文内容采用 FTS5 trigram 或可替换的中文分词方案；
2. 保留文件名、路径和标识符精确匹配；
3. 可选增加真实 Embedding；
4. 使用 RRF 等稳定方式合并全文和向量结果；
5. 合并相邻 chunk，避免回答上下文被切断；
6. 向量不可用时明确退化到 FTS-only，不返回伪语义结果。

生成式问答由 Pi 完成，但搜索排序、引用定位和文档读取仍由 Core 完成。

## 9. 文件导入与受控写入

### 9.1 文件导入

```text
选择文件
  → 保存原文件到 attachments/
  → Core 提取文本
  → Pi 分析主题、拆分边界和目标文件名
  → 展示导入计划
  → 用户确认目录、名称和拆分方式
  → Core 写入 wiki/
  → 增量索引
```

V1 文件格式：

- Markdown、TXT；
- JSON、YAML；
- 常见代码文件；
- 可提取文本的 PDF；
- DOCX。

### 9.2 总结并写入

统一流程：

```text
Pi 检索并总结
  → 生成 Markdown 草稿
  → Core 保存 draft
  → 桌面端展示引用和 Diff
  → 用户确认
  → Core 备份并原子写入
  → 增量索引
  → 记录审计日志
```

草稿至少保存：

```text
draft_id
workspace_id
target_path
operation_type
base_document_hash
generated_content
source_citations
status
created_by
```

支持的操作依风险逐步开放：

1. 新建文档；
2. 追加内容；
3. 更新指定章节；
4. 覆盖文档；
5. 移动和删除放到后续版本。

## 10. 桌面端设计

### 10.1 页面结构

```text
┌──────────────────────────────────────────────────────────┐
│ Workspace ▼          全局搜索              索引状态 ●    │
├──────────────┬───────────────────────────────────────────┤
│ 对话         │                                           │
│ 文档         │     对话 / 文档 / 导入 / 任务 / 设置      │
│ 导入         │                                           │
│ 任务         │     可选右侧引用、大纲或草稿 Diff 面板     │
│ 设置         │                                           │
├──────────────┴───────────────────────────────────────────┤
│ 148 documents · 2,481 chunks · index ready               │
└──────────────────────────────────────────────────────────┘
```

核心页面：

- 工作空间管理；
- 带引用的对话；
- 文件树、Markdown 阅读与编辑；
- 文件导入计划；
- 草稿 Diff 和提交；
- 索引、导入和 Pi 任务状态；
- Pi 模型设置；
- MCP 权限和配置复制；
- 审计记录。

### 10.2 HeroUI + Tailwind 结论

结论：**继续使用，适合 Tauri 桌面端，但必须增加桌面专用 UI 层。**

HeroUI 适合：

- Button、Input、Select、Tabs；
- Modal、Popover、Menu、Toast；
- Form、Table、Tooltip；
- 设置页、导入对话框、确认流程和空状态。

HeroUI 不应单独承担：

- 文件树；
- 可调整分栏；
- 右键菜单；
- 命令面板；
- IDE 风格文档标签；
- 大规模虚拟列表；
- Markdown 编辑器和 Diff 编辑器。

新增 `packages/desktop-ui`，业务页面优先引用封装组件，避免直接到处绑定 HeroUI API。建议能力：

```text
WorkspaceSidebar
FileTree
ResizableLayout
ContextMenu
CommandPalette
DocumentTabs
MarkdownEditor
DocumentDiff
VirtualList
```

可选辅助库：

| 能力 | 候选方案 |
| --- | --- |
| 分栏 | `react-resizable-panels` |
| 虚拟滚动 | `@tanstack/react-virtual` |
| 拖放 | `dnd-kit` |
| Markdown 编辑 | CodeMirror 6 |
| 命令面板 | `cmdk` 或自建 Command Registry |
| Diff | CodeMirror Merge 或 Monaco Diff |

不要同时全量引入第二套设计系统。缺少组件可以参考开源实现，再统一封装到 `desktop-ui`。

### 10.3 桌面视觉密度

建议默认值：

```text
按钮高度：28–32px
输入框高度：30–34px
列表行高：28–32px
侧边栏字号：12–13px
正文：13–14px
圆角：6–8px
```

避免大面积 SaaS 卡片、过大的圆角、过度留白和移动端式布局。

## 11. CLI 设计

主命令建议逐步调整为 `llm-wiki`，并保留 `llm-wiki-cli` 兼容别名。

```bash
# 工作空间
llm-wiki workspace create "P&L Wiki" --path ~/Knowledge/pl
llm-wiki workspace add ~/work/project --name project-docs
llm-wiki workspace list
llm-wiki workspace use pl-wiki

# 检索与读取
llm-wiki search "国家数据权限" --workspace pl-wiki
llm-wiki document list
llm-wiki document read wiki/pl/country-permission.md --lines 20:60

# 导入和索引
llm-wiki import ./业务需求.docx --plan-only
llm-wiki index
llm-wiki index --reset
llm-wiki status
llm-wiki doctor

# Pi 问答和总结
llm-wiki ask "这个工作空间有哪些数据权限规则？"
llm-wiki summarize wiki/pl/ --output draft

# 草稿
llm-wiki draft show <draft-id>
llm-wiki draft apply <draft-id>
llm-wiki draft discard <draft-id>
```

CLI 的 `--json` 输出属于稳定接口，必须定义版本、结构化错误码和兼容策略。

## 12. MCP Server 设计

### 12.1 传输

- V1：stdio；
- 后续：Streamable HTTP；
- 不新增旧式 HTTP + SSE 实现，除非为兼容旧客户端。

### 12.2 Tools

只读：

```text
workspace_list
workspace_get
document_list
document_search
document_read
index_status
```

受控写入：

```text
document_draft_create
document_draft_get
document_draft_apply
document_import
index_run
```

V1 不提供无限制的 `write_file` 和删除工具。

### 12.3 权限模式

```bash
# 默认只读
llm-wiki-mcp --stdio --read-only

# 允许创建草稿，但不允许提交
llm-wiki-mcp --stdio --allow-drafts

# 显式允许指定工作空间写入
llm-wiki-mcp --stdio \
  --allow-write \
  --workspace pl-wiki \
  --allow-path wiki/ \
  --deny-delete
```

服务端必须自行验证工作空间、路径、哈希和写入策略，不能只依赖 MCP Tool annotations。

## 13. 安全设计

1. 所有路径 canonicalize 后再校验工作空间边界；
2. 拒绝 `../`、符号链接逃逸和未注册的绝对路径；
3. WebView 只能调用明确注册的 Tauri Commands；
4. Tauri Capability 只允许启动固定 Pi Sidecar，不允许任意 Shell；
5. Pi 禁用内置 Bash、Write、Edit 等高风险工具；
6. 不自动加载未审查的全局 Pi 扩展和第三方包；
7. MCP 默认只读，写入需要显式参数和白名单；
8. 文档内容只作为数据，不作为系统指令，防止知识库 Prompt Injection；
9. 密钥存储在系统 Keychain，不写入工作空间配置；
10. 所有真实写入记录 actor、目标路径、旧哈希、新哈希、时间和草稿 ID。

## 14. 目标仓库结构

```text
llm-wiki/
├── apps/
│   ├── desktop/                    # React + Vite 桌面前端
│   └── pi-runtime/                 # Pi SDK Sidecar
│       └── src/
│           ├── agent-session.ts
│           ├── host-bridge.ts
│           ├── tools/
│           ├── prompts/
│           └── skills/
│
├── packages/
│   ├── desktop-ui/                 # 桌面专用组件封装
│   ├── agent-protocol/             # Pi JSONL 协议与类型
│   ├── shared-types/
│   ├── cli/                        # npm CLI 包装
│   └── mcp-server/                 # npm MCP 包装
│
├── crates/
│   ├── llm-wiki-core/
│   ├── llm-wiki-cli/
│   ├── llm-wiki-mcp/
│   └── llm-wiki-protocol/
│
├── src-tauri/
│   ├── src/
│   │   ├── commands/
│   │   ├── agent_supervisor/
│   │   ├── permissions/
│   │   └── app_state.rs
│   └── capabilities/
│
├── fixtures/                       # TS/Rust 行为一致性测试语料
└── docs/
```

仓库可以在迁移完成前继续保留 `llm-wiki-cli` 名称；产品命令稳定后再决定是否重命名为 `llm-wiki`。

## 15. 迁移计划

### Phase 0：接口和测试基线

- 固化当前扫描、切片、索引和搜索 fixture；
- 定义 Workspace、Document、Chunk、Citation、Draft 和 Error Schema；
- 定义 CLI JSON 与 Pi Host Bridge 协议版本；
- 增加数据库 migration 机制。

### Phase 1：多工作空间

- 全局工作空间注册表；
- `workspace.json`；
- Managed/Linked Workspace；
- CLI `--workspace` 和自动解析；
- 工作空间级数据库、锁和审计。

### Phase 2：Rust Core 对齐

- 迁移 scanner、chunker、reader、indexer、search；
- 使用同一套 fixture 对比 TypeScript 与 Rust 行为；
- 完成后停止在 Next.js API Routes 中增加新的核心业务逻辑。

迁移期间可以保留 TypeScript Core 适配器用于验证和短期原型，但目标是让 Desktop、CLI、MCP 都依赖 Rust Core。

### Phase 3：Tauri Desktop MVP

- React + Vite 迁移；
- HeroUI 桌面主题；
- 工作空间切换；
- 文档树、阅读、搜索；
- 导入计划；
- 草稿 Diff；
- 索引和任务状态。

### Phase 4：Pi Runtime

- Sidecar 打包和生命周期；
- Pi SDK 会话；
- 模型和认证状态；
- 流式输出、取消和错误恢复；
- Host Tools；
- 带引用问答；
- 总结并生成草稿。

### Phase 5：CLI 与 MCP

- 稳定 CLI JSON；
- MCP stdio；
- 只读 Tools；
- 草稿 Tools；
- 写入白名单；
- npm 平台二进制包装和 GitHub Release。

### Phase 6：检索与平台完善

- 中文检索优化；
- 真实 Embedding 和混合检索；
- macOS 之外的平台打包；
- 可选 Streamable HTTP；
- 更多文件格式。

## 16. V1 验收标准

- 至少可以注册、创建、切换 3 个工作空间；
- Desktop、CLI、MCP 对同一工作空间返回一致的搜索结果和引用；
- Pi 可以完成多轮检索并输出可点击引用；
- 用户可以上传一个 DOCX/PDF/Markdown，查看拆分计划并确认写入；
- Pi 只能创建草稿，不能绕过确认修改真实文件；
- Diff 提交时可以检测并拒绝过期哈希；
- MCP 未开启写权限时，所有写入调用都被服务端拒绝；
- 桌面程序关闭后，CLI 和 MCP 仍能工作；
- Sidecar 崩溃不会破坏工作空间，桌面端可以显示错误并重新启动；
- 向量扩展不可用时系统仍可使用 FTS 搜索；
- 所有写入可以在审计记录中追溯。

## 17. 主要风险与控制

| 风险 | 控制方式 |
| --- | --- |
| Rust Core 迁移范围过大 | fixture 对照、分模块迁移、保留短期 TS 适配器 |
| Pi 获得过高本地权限 | 禁用内置高风险工具，只暴露 Host Tools |
| Sidecar 多平台打包复杂 | macOS arm64 先行，CI 按 target triple 构建 |
| SQLite/向量原生扩展打包失败 | FTS-only 永远可用，向量作为可选能力 |
| 中文搜索效果差 | trigram/中文分词、精确匹配、真实 Embedding、RRF |
| Desktop/CLI/MCP 并发写冲突 | WAL、单写队列、文件锁、expectedHash、原子写入 |
| HeroUI 页面仍像 Web SaaS | desktop-ui 层、紧凑主题、键盘和右键交互 |
| 外部文档包含 Prompt Injection | 文档视为数据、系统提示隔离、工具权限由 Core 判断 |

## 18. 参考项目与文档

- 当前仓库：<https://github.com/jiangliuhong/llm-wiki-cli>
- DBX：<https://github.com/t8y2/dbx>
- Pi：<https://pi.dev/docs/latest/rpc>
- Pi SDK：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md>
- Tauri Frontend：<https://v2.tauri.app/start/frontend/>
- Tauri Sidecar：<https://v2.tauri.app/develop/sidecar/>
- Tauri Capabilities：<https://v2.tauri.app/security/capabilities/>
- HeroUI：<https://heroui.com/en/docs/react/getting-started/quick-start>
- MCP Transports：<https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>
