# LLM Wiki 桌面端、CLI 与 MCP 一体化设计（V1）

> 状态：Proposal  
> 日期：2026-08-12  
> 适用仓库：`jiangliuhong/llm-wiki`

## 1. 背景与产品定位

当前项目已经具备本地文档扫描、切片、SQLite FTS5 索引、实验性向量检索、CLI 搜索以及 Next.js 检索页面。下一阶段将其升级为一个本地优先、多工作空间、可同时被人和 Agent 使用的知识工作台。

产品提供两种独立使用形态：

1. **Desktop**：提供工作空间管理、Pi 问答、文档浏览、文件导入、草稿 Diff、任务状态和设置界面；
2. **CLI**：通过 npm 独立安装，在不安装 Desktop 的情况下完成工作空间、索引、检索、导入、Pi 问答、草稿以及 MCP 服务。

MCP 不再作为单独产品、npm 包或独立命令发布，而是 CLI 的运行模式：

```bash
llm-wiki mcp serve --stdio --workspace <workspace> --read-only
```

产品定位：

> LLM Wiki 是一个本地优先、多工作空间、同时面向桌面用户、命令行用户和外部 Agent 的知识库工作台。

## 2. V1 目标与非目标

### 2.1 V1 目标

1. 支持创建、添加、查看和移除多个本地工作空间；
2. 支持在工作空间内索引、搜索、读取文档并返回路径、标题、行号或页码引用；
3. 支持使用 Pi 在 Desktop 或 CLI 中进行提问、总结、导入规划和草稿生成；
4. 支持上传文件，经过文本提取、内容分析、拆分方案和用户确认后写入工作空间；
5. 所有高风险写入统一经过“草稿 → Diff → 确认 → 原子写入 → 增量索引”；
6. Desktop、CLI 和 MCP 使用同一套 Knowledge Core、工作空间格式和权限规则；
7. 用户可以仅执行 `npm install -g @llm-wiki/cli`，无需安装 Desktop 或 Rust；
8. CLI 内置 `llm-wiki mcp serve`，无需安装独立 MCP Server；
9. MCP 默认只读，必须显式声明允许访问的工作空间；
10. 第一阶段优先支持 macOS Apple Silicon，随后补齐 Windows 与 Linux。

### 2.2 V1 非目标

- 云端账号、云同步和多用户实时协作；
- 公网开放的远程 MCP 服务；
- 独立发布 `llm-wiki-mcp` 命令或 `@llm-wiki/mcp-server` 包；
- 不兼容旧命令 `llm-wiki-cli`，安装后唯一命令名为 `llm-wiki`；
- Agent 不经确认直接删除、移动或覆盖文档；
- 默认向 Pi 暴露 Bash、任意文件读写或整个用户目录；
- 扫描 PDF OCR、图片 OCR、复杂表格还原等高成本能力；
- 一开始同时支持所有模型厂商和所有文件格式。

## 3. 核心设计原则

1. **Local-first**：工作空间、索引、会话、附件、草稿和审计数据默认保存在本机；
2. **Single Core**：Desktop、CLI、MCP 共享核心领域模型，不各自实现搜索和写入逻辑；
3. **One CLI**：对外只有 `llm-wiki` 一个命令；
4. **Desktop 可选**：所有非图形化能力都必须能够通过 npm CLI 独立使用；
5. **Pi 负责推理，Core 负责执行**：Pi 不直接操作 SQLite 和任意文件系统；
6. **外部 Agent 不套 Pi**：MCP 直接调用 Core，避免 Agent 套 Agent；
7. **明确工作空间**：依赖知识库数据的命令必须解析出唯一工作空间，但不要求用户每次手动传参；
8. **默认只读**：搜索和读取默认开放，真实写入必须显式确认或授权；
9. **引用优先**：回答必须尽量返回可定位的文档来源；
10. **渐进迁移**：现有 TypeScript `packages/kb` 作为行为基准，逐步迁移到 Rust Core。

## 4. 技术决策

| 领域 | V1 选型 | 决策说明 |
| --- | --- | --- |
| 桌面壳 | Tauri 2 | 窗口、系统能力、权限、Pi Sidecar 生命周期和安装包 |
| 桌面前端 | React 19 + Vite | 采用 SPA，不继续依赖 Next.js Server/API Routes |
| 基础 UI | HeroUI v3 | 表单、按钮、弹窗、菜单、表格等通用组件 |
| 样式 | Tailwind CSS v4 | 紧凑型桌面主题和布局系统 |
| 桌面专用 UI | 自建 `desktop-ui` 层 | 文件树、分栏、右键、命令面板、标签页和 Diff |
| 内置 AI | Pi SDK Runtime | 模型、认证、会话、Agent 编排、流式问答和总结 |
| 共享核心 | Rust（目标架构） | 供 Tauri、CLI 和 MCP 模式复用 |
| 本地存储 | SQLite + WAL + FTS5 | 全局工作空间注册表和每个工作空间独立数据库 |
| 向量检索 | 可选适配层 | 打包验证通过后启用，始终支持 FTS-only 降级 |
| CLI | Rust CLI + npm 包装 | 唯一命令为 `llm-wiki` |
| MCP | CLI 子命令 + Rust library crate | `llm-wiki mcp serve --stdio`，不发布独立二进制 |
| 发布 | Tauri 安装包 + `@llm-wiki/cli` + GitHub Release | Desktop 与 CLI 可独立安装 |

## 5. 产品交付形态

### 5.1 Desktop

Desktop 安装包包含：

- Tauri 应用；
- React + Vite 前端；
- Rust Knowledge Core；
- Pi Runtime Sidecar；
- 工作空间和索引数据库能力；
- MCP 配置生成和权限设置页面。

Desktop 不依赖用户预先安装 npm CLI。

### 5.2 npm CLI

安装方式：

```bash
npm install -g @llm-wiki/cli
```

安装后只注册：

```bash
llm-wiki
```

CLI 包包含或解析：

- 当前平台的 Rust `llm-wiki` 二进制；
- 编译后的 Pi Runtime JavaScript；
- 内置 prompts、skills 和协议定义；
- npm 平台检测和进程转发脚本。

用户不安装 Desktop 也可以使用：

```bash
llm-wiki workspace add ~/work/project --name project-docs
llm-wiki index
llm-wiki search "权限模型"
llm-wiki ask "这个项目如何做数据权限控制？"
llm-wiki import plan ./requirements.docx
llm-wiki mcp serve --stdio --workspace project-docs --read-only
```

## 6. 目标架构

```text
┌───────────────────────────────────────────────────────────────┐
│                           用户入口                            │
├───────────────────────────────┬───────────────────────────────┤
│ Desktop                        │ npm CLI                       │
│ Tauri + React + Vite           │ llm-wiki                      │
│ HeroUI + Tailwind              │ 普通命令 / Pi / MCP stdio      │
└───────────────┬───────────────┴───────────────┬───────────────┘
                │ Tauri invoke / Rust API        │ Rust API
                └────────────────────┬───────────┘
                                     ▼
┌───────────────────────────────────────────────────────────────┐
│                      llm-wiki-core                            │
│                                                               │
│ Workspace / Document / Import / Index / Search / Draft        │
│ Write / Jobs / Locks / Backup / Audit / Migration             │
└──────────────────────┬───────────────────────┬────────────────┘
                       │                       │
             host tools│                       │SQLite / Files
                       ▼                       ▼
            ┌──────────────────┐    ┌──────────────────────────┐
            │ Pi Runtime       │    │ global.db / workspace.db │
            │ SDK / JSONL      │    │ wiki/ / attachments/     │
            └──────────────────┘    │ cache/ / backups/        │
                                    └──────────────────────────┘

外部 Agent
    └── 启动 llm-wiki mcp serve --stdio
            └── llm-wiki-mcp library
                    └── llm-wiki-core
```

关键约束：

- Desktop 前端不直接访问工作空间文件和数据库；
- Pi Runtime 不直接打开工作空间数据库，也不拥有任意路径写权限；
- Desktop 负责管理自己的 Pi Sidecar；
- npm CLI 在需要 AI 时启动包内置 Pi Runtime；
- `llm-wiki mcp serve` 直接调用 Core，不经过 Pi；
- Desktop 关闭后，CLI 和 MCP 模式仍然可用；
- 所有入口使用相同的工作空间 ID、文档 ID、错误码和审计格式。

## 7. Knowledge Core 职责

Knowledge Core 负责确定性能力：

- 工作空间注册、发现和解析；
- 文档扫描和文本提取；
- 结构化切片、索引和检索；
- 文档关系解析、证据保存、局部图查询和关系诊断；
- Agent 关系候选的持久化、审核和重建；
- 文件列表、文档读取和引用定位；
- 导入任务和索引任务；
- 草稿持久化、Diff 和冲突检测；
- 路径校验、权限判断、备份、写入和审计；
- Desktop、CLI 和 MCP 的统一错误模型。

Core 不负责：

- 生成式回答；
- 文档主题判断；
- 自然语言总结；
- 模型认证和模型选择。

这些能力由 Pi Runtime 提供。

## 8. 多工作空间设计

### 8.1 工作空间类型

| 类型 | 含义 |
| --- | --- |
| Managed Workspace | 由 LLM Wiki 创建和管理的新目录 |
| Linked Workspace | 将已有项目或文档目录注册为工作空间 |

每个内容根目录必须标明访问模式：

- `read-write`：允许在确认后写入，例如 `wiki/`；
- `read-only`：只能索引和检索，例如项目源码或已有 `docs/`。

### 8.2 工作空间目录

```text
my-workspace/
├── wiki/                         # 规范化知识文档，可读写
├── attachments/                  # 导入的原始文件
└── .llm-wiki/
    ├── workspace.json            # 工作空间身份和配置
    ├── workspace.db              # 索引、会话、任务、草稿和审计
    ├── cache/
    ├── backups/
    └── locks/
```

全局目录：

```text
~/.llm-wiki/
├── global.db                     # 工作空间注册和全局设置
├── logs/
└── cache/
```

工作空间使用稳定 UUID。目录移动后，可以通过 `.llm-wiki/workspace.json` 重新识别。

### 8.3 工作空间解析规则

不是所有命令都要求用户显式传入 `--workspace`，但所有依赖知识库数据的命令都必须解析出唯一工作空间。

解析顺序：

```text
1. --workspace <id|name|path>
2. LLM_WIKI_WORKSPACE 环境变量
3. 从当前目录向上查找 .llm-wiki/workspace.json
4. 找不到则返回 WORKSPACE_REQUIRED
```

不设置永久的全局默认工作空间，避免在错误目录下将数据写入其他知识库。

不依赖工作空间的全局命令包括：

```text
llm-wiki --version
llm-wiki doctor
llm-wiki workspace create|add|list|show|remove
llm-wiki pi status|login|models|doctor
llm-wiki mcp config|doctor
```

必须解析工作空间的命令包括：

```text
llm-wiki index
llm-wiki search
llm-wiki status
llm-wiki document ...
llm-wiki import ...
llm-wiki ask
llm-wiki summarize
llm-wiki draft ...
```

在工作空间目录内可以直接使用：

```bash
cd ~/Knowledge/pl-wiki
llm-wiki index
llm-wiki search "国家数据权限"
```

在任意目录使用时可以显式指定：

```bash
llm-wiki search "国家数据权限" --workspace pl-wiki
```

### 8.4 非交互写入规则

交互式写操作可以使用当前目录解析出的工作空间，但必须在确认前显示工作空间名称、根路径和目标文件。

在 `--no-input` 模式下，修改真实文件的命令必须同时满足：

```text
显式 --workspace
显式 --yes
通过路径权限校验
通过 expectedHash 冲突校验
```

例如：

```bash
llm-wiki draft apply draft-123 \
  --workspace pl-wiki \
  --yes \
  --no-input
```

### 8.5 工作空间数据库

建议包含：

| 表 | 作用 |
| --- | --- |
| `documents` | 文档路径、哈希、类型、状态和元数据 |
| `chunks` | 文档切片和引用位置 |
| `chunks_fts` | FTS5 索引 |
| `chunk_embeddings` | 可选向量数据和模型版本 |
| `relation_types` | 关系类型定义和方向语义 |
| `document_relations` | 已发布的文档关系边 |
| `relation_evidence` | 文档链接、frontmatter 或 Agent 证据 |
| `relation_proposals` | 待审核的 Agent 关系候选 |
| `unresolved_relation_refs` | 无效或多义关系引用诊断 |
| `tags` / `document_tags` | 文档标签及标签关联 |
| `assets` | 导入原文件 |
| `ingestion_jobs` | 文件导入任务 |
| `index_jobs` | 索引任务和错误 |
| `chats` / `messages` | Desktop 和 CLI 问答会话 |
| `message_citations` | 回答引用 |
| `drafts` | 待确认草稿 |
| `write_operations` | 文件写入及 Diff |
| `audit_logs` | Desktop、CLI、MCP 操作记录 |
| `schema_migrations` | 数据库版本迁移 |

### 8.6 并发与一致性

- SQLite 启用 WAL；
- 每个工作空间使用单写入队列；
- 写操作使用工作空间级文件锁；
- 文件采用临时文件 + 原子 rename；
- 修改已有文档时携带 `expectedHash`；
- 哈希不一致时拒绝覆盖并要求重新生成 Diff；
- 覆盖、移动或删除前创建备份；
- 写入和索引任务写入审计日志。

## 9. 搜索与引用

### 9.1 索引流程

```text
文件识别
  → 文本提取
  → 结构化切片
  → FTS5 索引
  → 可选 Embedding
  → 显式关系解析与目标解析
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

### 9.2 中文检索

V1 应优先解决：

1. 为中文内容采用 FTS5 trigram 或可替换的中文分词方案；
2. 保留文件名、路径和标识符精确匹配；
3. 可选增加真实 Embedding；
4. 使用 RRF 等稳定方式合并全文和向量结果；
5. 合并相邻 chunk，避免回答上下文被切断；
6. 向量不可用时明确退化到 FTS-only，不返回伪语义结果。

生成式问答由 Pi 完成，但搜索排序、引用定位和文档读取仍由 Core 完成。

关系扩展必须与正文命中分离：搜索结果中的 `graphContext` 只表示经批准的一跳关联文档，不能伪装成正文命中。文档详情提供最多三层的局部图，Agent 推断关系只有审核通过后才能参与导航、图查询和搜索扩展。

## 10. 文件导入与受控写入

### 10.1 文件导入

```text
选择文件或传入文件路径
  → 保存原文件到 attachments/
  → Core 提取文本
  → Pi 分析主题、拆分边界和目标文件名
  → Desktop 或 CLI 展示导入计划
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

### 10.2 总结并写入

```text
Pi 检索并总结
  → 生成 Markdown 草稿
  → Core 保存 draft
  → Desktop 展示 Diff，或 CLI 输出摘要/Diff
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

V1 依风险逐步开放：

1. 新建文档；
2. 追加内容；
3. 更新指定章节；
4. 覆盖文档；
5. 移动和删除放到后续版本。

## 11. Pi 集成设计

### 11.1 职责

Pi 负责：

- 工作空间问答；
- 多轮检索与分析；
- 文档和会话总结；
- 文件导入后的主题识别与拆分建议；
- Markdown 草稿生成和修改；
- 模型认证、模型选择、会话状态和流式事件。

Pi 不直接负责：

- 打开工作空间数据库；
- 任意文件读写；
- Bash 和进程执行；
- 应用草稿到真实文档。

### 11.2 Desktop 运行方式

```text
Tauri WebView → Tauri Rust Host → JSONL → Pi Runtime Sidecar → Pi SDK
```

Tauri Host 负责启动、监控、重启和停止 Pi Sidecar。

### 11.3 CLI 运行方式

仅安装 npm CLI 的用户也必须能使用 Pi：

```text
llm-wiki ask / summarize / import plan
  → Rust CLI
  → 启动 @llm-wiki/cli 内置 Pi Runtime JavaScript
  → Pi 调用 Core Host Tools
  → 流式输出结果
```

npm wrapper 向 Rust CLI 注入 Pi Runtime 路径，例如：

```text
LLM_WIKI_PI_RUNTIME_PATH=<npm-package>/pi-runtime/dist/index.js
```

没有 Pi 认证或模型时，非 AI 命令仍然正常使用；AI 命令返回明确错误码。

### 11.4 Pi Host Tools

只读工具：

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

草稿工具：

```text
document_draft_create
document_draft_update
document_draft_get
relation_proposal_create
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

### 11.5 Host Bridge

Host 与 Pi Runtime 使用 LF 分隔 JSONL，协议包含：

- 请求 ID；
- 会话 ID；
- 工作空间 ID；
- 事件类型；
- Tool 请求和响应；
- 流式文本；
- 取消；
- 心跳和重连；
- 结构化错误码。

## 12. Desktop 设计

### 12.1 页面结构

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
- 带引用的 Pi 对话；
- 文件树、Markdown 阅读与编辑；
- 文档关系侧栏、上游/下游和一跳局部图；
- Agent 关系候选审核与 unresolved relation diagnostics；
- 文件导入计划；
- 草稿 Diff 和提交；
- 索引、导入和 Pi 任务状态；
- Pi 模型设置；
- MCP 命令和客户端配置生成；
- 审计记录。

### 12.2 HeroUI + Tailwind

结论：**继续使用，适合 Tauri 桌面端，但必须增加桌面专用 UI 层。**

HeroUI 适合：

- Button、Input、Select、Tabs；
- Modal、Popover、Menu、Toast；
- Form、Table、Tooltip；
- 设置页、导入对话框、确认流程和空状态。

新增 `packages/desktop-ui`，提供：

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

桌面默认采用紧凑视觉密度，避免大面积 SaaS 卡片、过大圆角和过度留白。

## 13. CLI 产品设计

详细实施规格见 [`cli-design-v1.md`](./cli-design-v1.md)。本节固定架构级约束。

### 13.1 唯一命令

对外只提供：

```bash
llm-wiki
```

不注册、不兼容：

```text
llm-wiki-cli
llm-wiki-mcp
```

### 13.2 命令树

```text
llm-wiki
├── init
├── workspace create|add|list|show|current|remove
├── index [run]|reset|status|watch
├── search
├── status
├── document list|read|create|history
├── relations list|propose|approve|reject|diagnostics
├── import plan|apply|status
├── ask
├── summarize
├── draft list|show|create|apply|discard
├── pi status|login|models|doctor
├── mcp serve|config|doctor
└── doctor
```

### 13.3 通用参数

```text
--workspace <id|name|path>
--json
--quiet
--no-color
--no-input
--config <path>
```

CLI 结果写入 stdout，诊断和日志写入 stderr。`--json` 模式必须保持 stdout 为纯 JSON。

### 13.4 稳定自动化接口

`--json` 是稳定协议，必须包含：

- `protocolVersion`；
- `ok`；
- `data` 或 `error`；
- 结构化错误码；
- 明确退出码；
- 向后兼容策略。

## 14. MCP 通过 CLI 提供

### 14.1 运行方式

MCP 不是独立安装项。CLI 子命令直接进入 MCP stdio 服务模式：

```bash
llm-wiki mcp serve --stdio --workspace pl-wiki --read-only
```

内部仍保留 `llm-wiki-mcp` library crate，以隔离协议、Tools、权限和测试，但不生成独立二进制。

### 14.2 工作空间范围

MCP 必须显式声明访问范围，不使用当前目录自动发现：

```bash
# 单工作空间只读
llm-wiki mcp serve \
  --stdio \
  --workspace pl-wiki \
  --read-only

# 多工作空间只读
llm-wiki mcp serve \
  --stdio \
  --workspace pl-wiki \
  --workspace project-docs \
  --read-only

# 显式开放全部已注册工作空间，只允许只读
llm-wiki mcp serve \
  --stdio \
  --all-workspaces \
  --read-only
```

不允许在没有 `--workspace` 或 `--all-workspaces` 时启动 MCP。

### 14.3 权限模式

```bash
# 只允许检索和读取
llm-wiki mcp serve --stdio --workspace pl-wiki --read-only

# 允许创建草稿，不允许提交
llm-wiki mcp serve --stdio --workspace pl-wiki --allow-drafts

# 允许应用草稿到指定路径
llm-wiki mcp serve \
  --stdio \
  --workspace pl-wiki \
  --allow-drafts \
  --allow-apply \
  --allow-path wiki/
```

V1 不提供删除文档的 MCP Tool。

### 14.4 MCP Tools

只读：

```text
workspace_list
workspace_get
document_list
document_search
document_read
index_status
document_relations
document_neighborhood
```

受控写入：

```text
document_draft_create
document_draft_get
document_draft_apply
document_import
index_run
relation_proposal_create
```

MCP 直接调用 Knowledge Core，不调用 Pi。

### 14.5 客户端配置示例

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "llm-wiki",
      "args": [
        "mcp",
        "serve",
        "--stdio",
        "--workspace",
        "pl-wiki",
        "--read-only"
      ]
    }
  }
}
```

stdio 模式下，协议消息只能写 stdout，日志必须写 stderr。

## 15. npm 分发设计

### 15.1 主包

```json
{
  "name": "@llm-wiki/cli",
  "bin": {
    "llm-wiki": "./bin/llm-wiki.js"
  }
}
```

主包负责：

1. 检测操作系统和 CPU 架构；
2. 解析对应平台二进制；
3. 注入 Pi Runtime 路径；
4. 转发参数、信号、stdout、stderr 和退出码；
5. 输出平台不支持或二进制缺失的诊断信息。

### 15.2 平台包

```text
@llm-wiki/cli-darwin-arm64
@llm-wiki/cli-darwin-x64
@llm-wiki/cli-linux-arm64-gnu
@llm-wiki/cli-linux-x64-gnu
@llm-wiki/cli-win32-x64
```

主包通过 `optionalDependencies` 选择当前平台包，不下载全部平台二进制。

不再创建：

```text
@llm-wiki/mcp-server
@llm-wiki/mcp-*
```

同一个 Rust `llm-wiki` 二进制同时支持普通 CLI 和 `mcp serve`。

### 15.3 Pi Runtime

Pi Runtime JavaScript 随 `@llm-wiki/cli` 主包发布：

```text
@llm-wiki/cli/
├── bin/llm-wiki.js
├── pi-runtime/dist/index.js
├── prompts/
├── skills/
└── package.json
```

### 15.4 发布顺序

```text
1. 编译各平台 Rust llm-wiki 二进制
2. 构建 Pi Runtime JavaScript
3. 测试各平台包
4. 发布平台二进制包
5. 发布 @llm-wiki/cli
6. 创建 GitHub Release
7. 在全新环境验证 npm 全局安装和 MCP 启动
```

## 16. 安全设计

1. 所有路径 canonicalize 后再校验工作空间边界；
2. 拒绝 `../`、符号链接逃逸和未注册绝对路径；
3. WebView 只能调用明确注册的 Tauri Commands；
4. Tauri Capability 只允许启动固定 Pi Sidecar，不允许任意 Shell；
5. Pi 禁用内置 Bash、Write、Edit 等高风险工具；
6. 不自动加载未审查的全局 Pi 扩展和第三方包；
7. MCP 必须显式声明工作空间范围，默认只读；
8. 非交互真实写入必须显式 `--workspace --yes`；
9. 文档内容只作为数据，不作为系统指令；
10. 密钥存储在系统 Keychain 或受保护的 Pi 认证存储中；
11. 所有真实写入记录 actor、目标路径、旧哈希、新哈希、时间和草稿 ID。

## 17. 目标仓库结构

```text
llm-wiki/
├── apps/
│   ├── desktop/                    # React + Vite 桌面前端
│   └── pi-runtime/                 # Pi SDK Runtime 源码
│
├── packages/
│   ├── desktop-ui/                 # 桌面专用组件封装
│   ├── agent-protocol/             # Pi JSONL 协议与类型
│   ├── shared-types/
│   ├── cli/                        # @llm-wiki/cli 主包装包
│   ├── cli-darwin-arm64/
│   ├── cli-darwin-x64/
│   ├── cli-linux-arm64-gnu/
│   ├── cli-linux-x64-gnu/
│   └── cli-win32-x64/
│
├── crates/
│   ├── llm-wiki-core/
│   ├── llm-wiki/                   # 唯一 Rust 二进制
│   ├── llm-wiki-mcp/               # library crate，不生成独立命令
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

仓库、产品和对外命令统一使用 `llm-wiki`；`.llm-wiki/` 仅作为工作空间内部数据目录保留。

## 18. 迁移计划

### Phase 0：接口和测试基线

- 固化扫描、切片、索引、搜索和 graph fixture；
- 定义 Workspace、Document、Chunk、Citation、Draft 和 Error Schema；
- 定义 CLI JSON 与 Pi Host Bridge 协议版本；
- 增加数据库 migration 机制；
- 固定唯一命令名 `llm-wiki`。

### Phase 1：多工作空间

- 全局工作空间注册表；
- `workspace.json`；
- Managed/Linked Workspace；
- CLI `--workspace`、环境变量和 cwd 自动解析；
- 删除全局默认工作空间设计；
- 工作空间级数据库、锁和审计。

### Phase 2：Rust Core 对齐

- 迁移 scanner、chunker、reader、indexer、search、relation parser 和 graph query；
- 使用同一套 fixture 对比 TypeScript 与 Rust 行为；
- 完成后停止在 Next.js API Routes 中增加新的核心逻辑。

### Phase 3：CLI MVP

- 实现唯一 Rust `llm-wiki` 二进制；
- 工作空间、索引、搜索、文档和状态命令；
- 稳定 JSON、错误码和退出码；
- npm 主包和第一批平台包；
- 全新环境执行 `npm install -g @llm-wiki/cli` 验证。

### Phase 4：Tauri Desktop MVP

- React + Vite 迁移；
- HeroUI 桌面主题；
- 工作空间切换；
- 文档树、阅读、搜索；
- 文档关系侧栏和关系审核；
- 导入计划；
- 草稿 Diff；
- 索引和任务状态。

### Phase 5：Pi Runtime

- Desktop Sidecar 打包和生命周期；
- npm CLI 内置 Pi Runtime；
- 模型和认证状态；
- 流式输出、取消和错误恢复；
- Host Tools；
- 带引用问答、总结和导入规划。

### Phase 6：MCP CLI 模式

- `llm-wiki mcp serve --stdio`；
- `llm-wiki-mcp` library crate；
- 显式工作空间范围；
- graph 只读工具和 proposal 权限；
- 只读、草稿和应用权限；
- MCP 客户端配置生成；
- 不发布独立 MCP npm 包和二进制。

### Phase 7：检索与平台完善

- 中文检索优化；
- 真实 Embedding 和混合检索；
- macOS 之外的平台打包；
- 更多文件格式；
- 根据真实需求评估 Streamable HTTP。

## 19. V1 验收标准

### 19.1 CLI 独立安装

在未安装 Desktop 的全新环境：

```bash
npm install -g @llm-wiki/cli
llm-wiki --version
llm-wiki doctor
```

必须能够：

- 创建或添加工作空间；
- 建立索引；
- 搜索和读取文档；
- 使用 Pi 提问和总结；
- 创建、查看和应用草稿；
- 启动 MCP stdio 模式。

### 19.2 工作空间

- 至少可以注册、创建和切换使用 3 个工作空间；
- 在工作空间目录内无需显式 `--workspace`；
- 在其他目录可使用 `--workspace` 或环境变量；
- 无法解析工作空间时返回 `WORKSPACE_REQUIRED`，不静默选择默认空间；
- 非交互真实写入缺少 `--workspace` 或 `--yes` 时必须拒绝。

### 19.3 Desktop、CLI 与 MCP 一致性

- Desktop、CLI、MCP 对同一工作空间返回一致的搜索结果和引用；
- Desktop 关闭后，CLI 和 MCP 模式仍然可用；
- Pi 可以完成多轮检索并输出可定位引用；
- Pi 只能创建草稿，不能绕过确认修改真实文件；
- Diff 提交可以检测并拒绝过期哈希；
- MCP 未显式授权时，所有写入调用都被拒绝；
- 向量扩展不可用时仍可使用 FTS 搜索；
- 所有写入可以在审计记录中追溯。

### 19.4 MCP CLI 模式

以下命令必须在不安装 Desktop、不安装独立 MCP 包的环境中启动：

```bash
llm-wiki mcp serve \
  --stdio \
  --workspace test-workspace \
  --read-only
```

stdout 必须保持纯 MCP 协议输出，日志写入 stderr。

## 20. 主要风险与控制

| 风险 | 控制方式 |
| --- | --- |
| Rust Core 迁移范围过大 | fixture 对照、分模块迁移、保留短期 TS 适配器 |
| Pi 获得过高本地权限 | 禁用内置高风险工具，只暴露 Host Tools |
| CLI 与 Desktop 行为漂移 | 共享 Core、共享 schema、共享协议测试 |
| npm 平台二进制发布复杂 | 主包 + optionalDependencies + 平台安装测试 |
| Pi Runtime 在 npm 包内定位失败 | wrapper 注入固定环境变量并由 doctor 验证 |
| MCP 访问错误工作空间 | 启动时强制显式 workspace scope |
| SQLite/向量扩展打包失败 | FTS-only 永远可用，向量作为可选能力 |
| 中文搜索效果差 | trigram/中文分词、精确匹配、真实 Embedding、RRF |
| 并发写冲突 | WAL、单写队列、文件锁、expectedHash、原子写入 |
| HeroUI 页面仍像 Web SaaS | desktop-ui 层、紧凑主题、键盘和右键交互 |
| 外部文档包含 Prompt Injection | 文档视为数据、系统提示隔离、工具权限由 Core 判断 |

## 21. 相关文档

- [CLI 设计与 npm 发布规格（V1）](./cli-design-v1.md)
- [桌面端交互原型](./prototypes/desktop/)
- [当前 CLI 使用指南](./cli-usage.md)
- [当前已知限制](./known-limitations.md)

## 22. 参考项目与文档

- 当前仓库：<https://github.com/jiangliuhong/llm-wiki>
- DBX：<https://github.com/t8y2/dbx>
- Pi：<https://pi.dev/docs/latest/rpc>
- Pi SDK：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md>
- Tauri Frontend：<https://v2.tauri.app/start/frontend/>
- Tauri Sidecar：<https://v2.tauri.app/develop/sidecar/>
- Tauri Capabilities：<https://v2.tauri.app/security/capabilities/>
- HeroUI：<https://heroui.com/en/docs/react/getting-started/quick-start>
- MCP Transports：<https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>
