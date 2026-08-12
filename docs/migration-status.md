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
- 原有 TypeScript graph、CLI 和 workspace manifest 测试保持通过。

## 下一阶段

以下部分仍需要接入真实存储和运行时，当前代码会明确返回 `*_PENDING` 或 `*_NOT_CONFIGURED`，不会伪装成已完成：

1. Rust SQLite adapter：读取 `workspace.db`，复用现有 documents、FTS、relations 和 evidence 表。
2. Rust scanner/chunker/indexer/search：与 `packages/kb` 建立 fixture parity 后，再切换 Desktop、CLI 和 MCP 的查询入口。
3. MCP JSON-RPC 完整生命周期：初始化、工具 schema、错误映射、取消和审计事件。
4. Pi SDK/model adapter：接入真实模型、会话恢复、tool approval 和 draft/apply 生命周期。
5. Tauri 打包与原生 sidecar：把 Rust Core、Pi Runtime 和前端静态资源纳入 macOS/Linux/Windows 构建。
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
