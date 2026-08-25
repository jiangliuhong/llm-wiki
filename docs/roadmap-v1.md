# LLM Wiki V1 后续实施计划

> 目标：在现有 TypeScript graph 能力和 Desktop UI 壳的基础上，完成 Rust Core、Tauri Desktop、Pi Runtime、CLI 与 MCP 的真实能力接入。
>
> 当前状态：界面、工作区切换、Tauri 原生窗口、Rust Core 领域模型和只读协议骨架已经具备；真实 SQLite 查询、模型调用和安装包仍待接入。

## 1. Rust Core：真实存储与检索

### 1.1 SQLite adapter

- 读取工作区 `.llm-wiki/workspace.db`。
- 对齐 `packages/kb` 现有表结构：documents、chunks、FTS5、document_relations、relation_evidence。
- 统一连接生命周期、WAL、事务和只读连接模式。
- 将 SQLite 错误映射为稳定的 Core 错误码，不把底层 SQL 错误直接暴露给 UI 或 Agent。

### 1.2 扫描、切片和索引

- 将现有 scanner、chunker、indexer 的行为迁移为 Rust 实现。
- 使用 fixtures 建立 TypeScript/Rust parity 测试：同一输入必须得到相同文档 ID、切片范围、标题和索引结果。
- 支持增量索引、删除检测、索引锁和任务进度。
- 保留 FTS-only 降级路径，向量能力作为可选适配层接入。

### 1.3 查询与 graph

- 实现 `document_list`、`document_get`、`document_search`。
- 实现深度 1–3 的关系邻域、关系证据和搜索图上下文。
- 搜索命中与 graph 上下文保持独立字段，引用必须包含文档路径及可定位行号/页码信息。
- 为空工作区、损坏数据库、缺少 manifest 和索引未完成提供明确错误状态。

## 2. Tauri Desktop：从静态壳接入真实 Core

### 2.1 Command bridge

- 将 `workspace_status`、`document_search`、文档详情和 graph 查询接入 Rust Core。
- 前端不直接访问文件系统或 SQLite；所有查询和写入经过 Tauri commands。
- 增加 loading、空状态、错误、重试和 Core 未连接状态。

### 2.2 页面功能

- 文档页：真实文档树、搜索、阅读、引用定位和索引状态。
- 关系图谱页：真实节点、关系方向、证据详情和局部邻域展开。
- 任务页：扫描、索引、导入任务的真实状态和失败原因。
- 设置页：Core、SQLite、FTS5、Pi Runtime 和 MCP 权限状态。
- 工作区切换后刷新所有页面数据，并保持当前工作区上下文。

### 2.3 导入与草稿闭环

```text
选择文件 → 文本提取 → 导入规划 → 生成草稿 → Diff → 用户确认
→ 原子写入 wiki/ → 增量索引 → 记录审计事件
```

- 默认不直接覆盖现有文档。
- 写入前展示路径、变更摘要和冲突信息。
- 写入失败时保留草稿和可恢复状态。

## 3. Pi Runtime：接入真实模型与会话

- 完成 Pi SDK/model adapter 和模型配置读取。
- 支持 JSONL 流式事件：会话开始、文本增量、工具调用、工具结果、错误和完成。
- 支持会话恢复、取消、超时和断线重连。
- 工具调用必须经过 Host Bridge；Pi 不直接访问 SQLite 或任意文件路径。
- 默认只开放搜索、读取和 graph 查询；写入必须进入 draft/apply 流程。
- 在 Desktop 和 CLI 中统一 session、tool approval 和审计格式。

## 4. CLI：统一 `llm-wiki` 入口

- 完成 `workspace create/add/list/show/remove/current`。
- 完成 `index`、`search`、`document`、`status`、`ask`、`summarize`。
- 完成 `import plan`、`draft list/show/diff/apply`。
- 所有依赖知识库的命令统一使用：`--workspace` → `LLM_WIKI_WORKSPACE` → cwd 向上发现 manifest。
- 统一文本输出、`--json` 输出、退出码和错误码。
- 验证 npm 安装后只注册 `llm-wiki`，不再暴露 `llm-wiki-cli`。

## 5. MCP：完成 JSON-RPC 生命周期

- 实现 initialize、tools/list、tools/call、notifications/cancelled 和 shutdown。
- 固化工具 schema、协议版本、错误映射和审计事件。
- 默认 `--read-only`，明确限制 workspace scope。
- 直接调用 Rust Core，不经过 Pi Runtime。
- 为 Codex/Claude 等外部 Agent 增加 stdio fixtures 和端到端测试。

## 6. 打包、发布与兼容性

- Tauri 打包包含前端静态资源、Rust Core 和 Pi Runtime sidecar。
- 优先完成 macOS Apple Silicon 安装包，再补齐 Windows/Linux。
- 验证 workspace manifest、数据库迁移、旧 graph 数据和 CLI 命令升级路径。
- 增加首次启动、工作区损坏、无权限目录、sidecar 缺失和升级失败的恢复提示。
- 建立 GitHub Release 构建矩阵和产物校验。

## 7. 推荐执行顺序

| 阶段 | 交付目标             | 完成标准                                         |
| ---- | -------------------- | ------------------------------------------------ |
| P0   | Core SQLite 读路径   | Desktop 能读取真实文档、搜索结果和 graph         |
| P1   | Rust scanner/indexer | Rust 与 TypeScript fixtures parity，支持增量索引 |
| P2   | Desktop 真实页面     | 文档、graph、任务和状态页不再依赖静态示例数据    |
| P3   | Pi Runtime           | 能流式问答，工具权限和会话生命周期完整           |
| P4   | 导入/草稿写入        | Diff、确认、原子写入、增量索引和审计完整         |
| P5   | CLI/MCP 完整能力     | CLI 与外部 Agent 复用同一 Core 和错误协议        |
| P6   | 打包发布             | macOS 安装包可独立运行，CLI 可独立安装           |

## 8. 每阶段验收要求

- 新增功能必须有 Rust/TypeScript fixture parity 或端到端测试。
- Desktop 页面必须覆盖 loading、empty、error、offline 四种状态。
- 所有写入操作必须可预览、可取消、可恢复，并留下审计记录。
- MCP 默认只读，工作区 scope 不得隐式扩大。
- 不允许用静态数据掩盖未接入的 Core 能力；未完成能力返回明确 `*_PENDING` 或 `*_NOT_CONFIGURED`。

## 9. 常用验证命令

```bash
cargo test --workspace --offline
pnpm --filter @llm-wiki/desktop build
./node_modules/.bin/tsc -p packages/kb/tsconfig.json
./node_modules/.bin/tsc -p packages/cli/tsconfig.json
./node_modules/.bin/tsc -p apps/pi-runtime/tsconfig.json
node --test packages/kb/test/*.test.mjs
node --test packages/cli/test/*.test.mjs
node --test apps/pi-runtime/test/*.test.mjs
pnpm --filter @llm-wiki/desktop tauri build
```
