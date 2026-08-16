# V1 改造状态

本文记录从现有 TypeScript graph 能力迁移到 Rust Core、Tauri Desktop 和 Pi Runtime 的实际落地范围。产品命令和 npm 包统一使用 `llm-wiki`；`.llm-wiki/` 仍是工作空间的内部目录名。

## 已完成

- Rust workspace 已建立：`llm-wiki-core`、`llm-wiki-protocol`、`llm-wiki-mcp` 和 `llm-wiki`。
- Core 已定义工作空间 manifest、文档节点、关系证据、关系邻域和搜索图上下文模型。图上下文保持独立字段，不把关系内容混入全文命中结果。
- `KnowledgeCore` 已提供深度 1–3 的局部邻域遍历，以及每个 seed 最多 10 条关系的搜索上下文；关系证据的 `confidence` 使用与现有 SQLite/TypeScript graph 相同的 `0..1` 数值。
- MCP scope 已实现显式工作空间约束、`--read-only` 写入拒绝和只读 graph 工具白名单。
- Rust CLI 已提供 `llm-wiki doctor`、`llm-wiki workspace current` 和 `llm-wiki mcp serve --stdio` 骨架。
- Tauri Desktop 已提供工作空间、聊天、文档、关系、导入、草稿、任务和设置页面壳，并通过 command bridge 访问 Core；前端不直接读文件或 SQLite。
- Pi Runtime 已提供 JSONL host bridge，只暴露工作空间状态和只读文档/graph 工具名；未知工具、协议版本和未配置 Core 能力都会返回结构化错误，日志只写 stderr。
- Pi SDK（`@earendil-works/pi-coding-agent`）已作为依赖嵌入 `apps/pi-runtime`，进程内创建 AgentSession：内置工具全部禁用，Core 只读工具注册为 customTools；模型凭据来自请求或环境变量，不读写 `~/.pi/agent`。JSONL 协议新增 `session_new/list/switch/fork/delete/cancel/compact` 与 `prompt`（流式返回 `text_delta`、tool execution、`agent_end`、`session_switched` 事件），多会话为进程内 in-memory 管理。
- pi-runtime 内置实现全部 8 个只读宿主工具（`node:sqlite` 直读 `.llm-wiki/index.db`，只读连接）：document_list/search/read/read_range/relations/neighborhood。FTS 查询对每个关键词加引号前缀（`"词"*`），改善中文整段分词下的命中率。
- Desktop 已接通 Pi 问答：Tauri Rust 宿主（`src-tauri/src/pi.rs`）按工作区管理 pi-runtime sidecar 子进程，`pi_config_get/set`（模型配置存 `.llm-wiki/config.json`）、`pi_session_new/prompt/delete` 命令；`text_delta` 经 `pi-event` 事件流式转发到前端。聊天页在模型已配置时走 Pi 流式回答（Markdown 渲染），未配置时回退 FTS5 检索并明确提示；设置页支持模型目录选择与智谱 GLM Coding Plan 预设（中国 `open.bigmodel.cn/api/anthropic`、国际 `open.z.ai/api/anthropic`，Anthropic 兼容协议 + baseUrl 覆盖，支持 `ZHIPU_API_KEY` / `Z_AI_API_KEY` 环境变量）。
- Pi 问答端到端错误链路已闭合：`pi_prompt`/`pi_session_delete`/`pi_session_cancel` 检查 sidecar `ok` 并把 `/error/message` 作为命令错误返回前端；前端处理 `pi-event` 的 `error` 事件并在消息中展示失败原因（保留已流出的部分回答）；sidecar stderr 转发到宿主日志、请求超时清理 pending 条目、应用退出时 kill 全部 sidecar。
- Pi 会话已跨进程持久化：会话 JSONL 落盘 `.llm-wiki/pi-sessions/`，元数据索引（标题/模型/文件名，不含 API key）存 `index.json`；sidecar 重启后按 sessionId 懒恢复（`SessionManager.open` 重建 AgentSession），`prompt` 请求携带工作区模型配置用于恢复时重新注入凭据；`session_delete` 同步清理 JSONL 与索引。
- Tauri 打包已纳入 Pi Runtime：`apps/pi-runtime` 经 esbuild 打成单文件 `dist/pi-runtime.bundle.js`（仅 `node:*` 外置），`tauri build` 前由 `scripts/prepare-pi-runtime.mjs` 暂存到 `src-tauri/pi-runtime/index.js` 并作为 Tauri resource 随包分发；运行时优先从 resource 目录解析（同时保留 `LLM_WIKI_PI_RUNTIME` 覆盖与 dev 布局探测），未安装 Node.js 时返回中文提示。
- 原有 TypeScript graph、CLI 和 workspace manifest 测试保持通过。

## 下一阶段

以下部分仍需要接入真实存储和运行时，当前代码会明确返回 `*_PENDING` 或 `*_NOT_CONFIGURED`，不会伪装成已完成：

1. Rust SQLite adapter：读取 `workspace.db`，复用现有 documents、FTS、relations 和 evidence 表。
2. Rust scanner/chunker/indexer/search：与 `packages/kb` 建立 fixture parity 后，再切换 Desktop、CLI 和 MCP 的查询入口。
3. MCP JSON-RPC 完整生命周期：初始化、工具 schema、错误映射、取消和审计事件。
4. Pi/model adapter 剩余项：tool approval 和 draft/apply 生命周期；真实模型端到端问答需在设置页配置模型后验证。
5. Tauri 打包收尾：Pi Runtime sidecar 已随包分发（依赖系统 Node.js），剩余为 Linux/Windows 目标的安装验证。
6. Desktop 的真实搜索、关系详情和草稿确认流程。

## 验证命令

```bash
cargo test --workspace --offline
./node_modules/.bin/tsc -p packages/kb/tsconfig.json
./node_modules/.bin/tsc -p packages/cli/tsconfig.json
./node_modules/.bin/tsc -p apps/pi-runtime/tsconfig.json
(./node_modules/.bin/tsc -p apps/desktop/tsconfig.json)
(cd apps/desktop && ../../node_modules/.bin/vite build)
(cd packages/kb && node --test test/*.test.mjs)
(cd packages/cli && node --test test/*.test.mjs)
node --test apps/pi-runtime/test/*.test.mjs
```

Desktop 的 TypeScript、Vite 构建和 macOS Tauri `dev` 启动均已通过。完整安装包仍执行 `pnpm --filter @llm-wiki/desktop tauri build`。
