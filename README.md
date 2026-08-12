# llm-wiki

一个本地知识库 Wiki 平台的命令行工具：扫描文档 → 切片 → SQLite FTS5 索引 → 本地检索，并通过一个命令把检索网页跑起来。实验性的 sqlite-vec 向量路径可按需启用。

所有数据都存在本地（`.llm-wiki/` 目录下的 `index.db`），不上传任何外部服务。

## 技术栈

| 关注点   | 选型                                       |
| -------- | ------------------------------------------ |
| 运行时   | Node.js 22+                                |
| 语言     | TypeScript（strict、ESM）                  |
| CLI 框架 | Commander.js                               |
| Web 框架 | Next.js 16（App Router）                   |
| UI 库    | HeroUI v3                                  |
| 样式     | Tailwind CSS v4（CSS-first 配置）          |
| 检索存储 | better-sqlite3 + sqlite-vec（FTS5 + 向量） |
| Monorepo | pnpm workspace                             |
| 代码规范 | ESLint（flat config）+ Prettier            |

---

## 使用指南

面向**使用 CLI 管理知识库与启动检索网页**的用户。

完整的命令参数、脚本调用方式和故障排查请参阅 [`docs/cli-usage.md`](./docs/cli-usage.md)。

## 环境要求

- Node.js 22 或更高
- pnpm 9.x（`npm i -g pnpm`）

## 安装

在仓库根目录：

```bash
pnpm install
```

## 让 `llm-wiki` 命令全局可用（可选）

```bash
pnpm --filter @llm-wiki/cli build
pnpm --filter @llm-wiki/cli link --global
```

链接后即可在任意目录运行 `llm-wiki`。

> 未链接时也可直接调用：
>
> ```bash
> # 开发态（直接跑 TypeScript 源码）
> pnpm --filter @llm-wiki/cli dev -- <command>
> # 构建产物
> node packages/cli/dist/index.js <command>
> ```

## 快速开始

在一个**空目录**里（或你希望作为知识库根目录的项目里）：

```bash
llm-wiki init        # 初始化：写配置 + 建 wiki/ 目录 + 安装项目 skills
# 把你的文档放进 wiki/（Markdown、代码、文本等均可）
llm-wiki index       # 索引：扫描 → 切片 → 嵌入 → 入库
llm-wiki search "你的查询词"   # 命令行检索
llm-wiki search "你的查询词" --graph # 同时返回一跳关联文档
llm-wiki relations list       # 审核 Agent 提出的关系候选
llm-wiki serve       # 启动网页，浏览器打开检索页
```

也可以把多个已有知识库注册到统一入口，在任意目录按 ID 操作：

```bash
llm-wiki workspace add backend /path/to/backend
llm-wiki workspace add product /path/to/product
llm-wiki --workspace backend search "部署流程"
llm-wiki serve --all
```

`init` 和 `workspace create` 会生成稳定的 `.llm-wiki/workspace.json`。在工作空间子目录中，`llm-wiki` 会向上发现该文件；也可以显式使用 `--workspace <id|path>`。

## 命令一览

```
llm-wiki --help
llm-wiki init [options]
llm-wiki index [options]
llm-wiki search <query> [options]
llm-wiki relations <command>
llm-wiki workspace <command>
llm-wiki serve [options]
```

### `init` — 初始化知识库

在当前工作目录创建 `.llm-wiki/config.json`、`wiki/` 内容目录（含一个占位 `welcome.md`），并在 `.agents/skills/` 安装 `kb-write-docs`、`kb-search-docs` 与 `kb-infer-relations`。
若配置或同名 skill 已存在，命令会保留已有内容；再次执行可补装缺失的内置 skill。

```bash
llm-wiki init [--title <标题>] [--port <端口>]
```

生成的配置示例：

```json
{
  "title": "My Wiki",
  "port": 3000,
  "kb": {
    "include": ["wiki"],
    "exclude": ["node_modules", ".git", ".llm-wiki", "dist", "build", "out"],
    "chunk": { "maxChars": 1200, "overlap": 200 },
    "embedding": { "enabled": false, "dimensions": 1536 }
  }
}
```

### `index` — 建立索引

扫描 `kb.include` 指定的目录（默认 `wiki/`），对支持的文件做切片、嵌入并写入 `.llm-wiki/index.db`。

```bash
llm-wiki index [--reset]
```

- **增量索引（默认）**：按 `sha256 + mtime + size` 判断文件是否变化，未变则跳过；已删除的文件会从索引中清除。
- `--reset`：先清空已有索引，再全量重建。修改 `chunk` 或 `embedding.dimensions` 后建议加 `--reset`。

支持索引的文件扩展名：`.js .mjs .cjs .ts .tsx .jsx .md .mdx .json .txt .yml .yaml`

### `search` — 命令行检索

```bash
llm-wiki search <query> [--limit <n>] [--json] [--graph]
```

- `-l, --limit <n>`：最大返回数，默认 `8`，范围 `1` 到 `50`。
- `--json`：以 JSON 输出，便于脚本/管道消费。

默认检索使用 FTS5 bm25。内置向量是确定性测试实现，不具备真实语义能力，因此默认关闭；显式设置 `kb.embedding.enabled: true` 后才启用向量 KNN，并按 `vector+fts` > `fts` > `vector` 分桶排序。

加 `--graph` 后，命令还会从文本命中的文档出发，返回最多一跳的已发布文档关系。Web 搜索默认启用这一扩展，但关联文档与文本命中分开展示。

示例输出：

```
wiki/技术文档.md:42-58  [fts]
  预览文本片段……
  bm25: -3.2100
```

### 文档关系与知识图谱

Markdown 文档可用 frontmatter 声明类型化关系，也可通过普通本地链接或 `[[WikiLink]]` 自动生成 `references`。关系、证据、标签、候选审核状态仍保存在 `.llm-wiki/index.db`；索引过程不调用 LLM。

```yaml
---
title: 索引架构
tags: [搜索, SQLite]
relations:
  - type: depends_on
    target: ./storage.md
---
```

内置 `kb-infer-relations` skill 可指导调用方 Agent 生成带证据的候选 JSON。候选必须通过 Web 的 `/relations/review` 或 CLI 审核后才进入正式图谱：

```bash
llm-wiki relations propose --input proposals.json
llm-wiki relations list --status pending
llm-wiki relations approve 1
llm-wiki relations reject 2
llm-wiki relations diagnostics
```

完整格式、解析规则和审核流程见 [`docs/wiki-graph.md`](./docs/wiki-graph.md)。

### `serve` — 启动检索网页

读取 `.llm-wiki/config.json`，在**进程内**启动 Next.js（不派生子进程、不调 shell），首页即为知识库检索页。

```bash
llm-wiki serve [-p, --port <端口>] [--prod] [--all]
```

- 默认端口取自配置（或 `3000`）。
- `-p, --port <端口>`：覆盖配置中的端口。
- `--prod`：使用构建产物（`.next`）而非 dev server。
- `--all`：启动一个服务并加载全局注册表中的全部知识库；页面和 API 按知识库 ID 隔离。

单库可从任意目录启动，多库服务会显示知识库切换器：

```bash
llm-wiki --root /path/to/wiki serve
llm-wiki --workspace backend serve
llm-wiki serve --all
```

多库页面使用 `/kbs/<id>`，API 使用 `/api/kbs/<id>/...`。每个知识库仍保留独立的
`.llm-wiki/index.db`，不会合并数据。

在 `serve --all` 模式下，顶部知识库切换器旁会显示 **Add knowledge base**。输入本机绝对
目录路径即可注册；如果目录尚未初始化，可以勾选初始化选项，WebUI 会创建默认
`.llm-wiki/config.json`、`wiki/welcome.md` 和空的独立索引库。已有但无法解析的配置不会被覆盖。

启动后：

```
✔ Server started at http://localhost:3000
```

网页功能：搜索框、source 徽标（vector / fts / vector+fts）、`file:line` 定位、内容预览，以及顶部的索引状态卡（文件数、块数、FTS/向量计数、向量是否启用、DB 路径）。

## 配置文件

位置：`.llm-wiki/config.json`（相对当前工作目录）。字段说明：

| 字段                      | 类型     | 默认值      | 说明                                 |
| ------------------------- | -------- | ----------- | ------------------------------------ |
| `title`                   | string   | `"My Wiki"` | 网页标题                             |
| `port`                    | number   | `3000`      | serve 端口（0–65535）                |
| `kb.include`              | string[] | `["wiki"]`  | 递归扫描的目录                       |
| `kb.exclude`              | string[] | 见上        | 扫描时跳过的目录名                   |
| `kb.chunk.maxChars`       | number   | `1200`      | 每个块最大字符数                     |
| `kb.chunk.overlap`        | number   | `200`       | 相邻块重叠字符数                     |
| `kb.embedding.enabled`    | boolean  | `false`     | 是否启用实验性确定性向量检索         |
| `kb.embedding.dimensions` | number   | `1536`      | 向量维度（必须与索引库 schema 一致） |

> `kb` 整段可选：旧版只有 `title`/`port` 的配置仍然有效，缺失字段会自动补默认值。

## 已知限制

详见 [`docs/known-limitations.md`](./docs/known-limitations.md)。摘要：

1. **中文 FTS 偏弱**：FTS5 默认分词器对中文无词界，中文查询可能无结果；英文/分词内容 FTS 正常。含特殊字符（如 `P&L`）会返回 `warning`。
2. **实验性向量限制**：内置确定性向量没有真实语义，默认关闭；显式启用后，`serve --prod` 仍可能因原生扩展加载失败而降级。

---

## 开发指南

面向**在本仓库内开发、扩展或贡献代码**的开发者。

## 仓库结构

```
llm-wiki/
├── package.json              # 根 workspace 脚本（dev/build/lint/format）
├── pnpm-workspace.yaml       # 声明 apps/* 与 packages/*
├── tsconfig.base.json        # 严格 TS 基础配置（共享）
├── eslint.config.mjs         # flat ESLint 配置（全仓库）
├── docs/                     # 文档（已知限制等）
├── apps/
│   └── web/                  # @llm-wiki/web —— Next.js 16 + HeroUI v3 检索页
│       ├── app/
│       │   ├── page.tsx           # 首页：KB 检索 UI
│       │   ├── layout.tsx
│       │   ├── globals.css        # Tailwind v4 CSS-first
│       │   └── api/kb/            # 只读 KB API 路由（stats/search/files/chunks）
│       ├── components/KbSearch.tsx
│       └── next.config.ts         # serverExternalPackages: better-sqlite3, sqlite-vec
└── packages/
    ├── cli/                  # @llm-wiki/cli —— Commander.js CLI
    │   └── src/
    │       ├── index.ts            # 命令注册入口
    │       ├── commands/           # init / index / search / serve
    │       ├── services/next-server.ts   # 进程内启动 Next.js
    │       ├── utils/              # config / paths / logger / kb-config
    │       └── types/
    └── kb/                   # @llm-wiki/kb —— 共享知识库引擎
        └── src/
            ├── scanner.ts         # 文件扫描
            ├── chunker.ts         # 切片
            ├── embedding.ts       # 确定性 fake embedding
            ├── indexer.ts         # 增量索引
            ├── search.ts          # 混合检索
            ├── reader.ts          # 只读查询（stats/files/chunks）
            ├── config.ts          # KB 默认配置 + 校验
            ├── types.ts           # 公共类型
            ├── index.ts           # 桶导出
            └── db/                # connection / schema / init
```

## 工作区与包约定

- 包命名：`@llm-wiki/<name>`（`@llm-wiki/cli`、`@llm-wiki/web`、`@llm-wiki/kb`）。
- `pnpm-workspace.yaml` 已声明 `apps/*` 与 `packages/*`，新增包会自动被发现。
- 跨包依赖用 `workspace:*` 引用，例如 `@llm-wiki/cli` 与 `@llm-wiki/web` 都依赖 `@llm-wiki/kb`。
- **例外**：CLI 不通过包依赖引用 Web，而是用 `getWebAppDir()` 按文件系统路径定位 `apps/web`，再在进程内 `import("next")` 启动。

## 常用脚本

在仓库根目录：

```bash
pnpm install          # 安装依赖（含原生模块编译）
pnpm build            # 构建所有包（按拓扑顺序）
pnpm lint             # 三个包各自 lint
pnpm format           # Prettier 格式化
```

单独构建/运行某个包：

```bash
pnpm --filter @llm-wiki/cli build
pnpm --filter @llm-wiki/web build
pnpm --filter @llm-wiki/kb build
```

## 本地开发工作流

**Web 热更新**（UI 开发）：

```bash
pnpm --filter @llm-wiki/web dev
```

**CLI 源码直跑**（用 `tsx`，无需先编译）：

```bash
pnpm --filter @llm-wiki/cli dev -- init
pnpm --filter @llm-wiki/cli dev -- index
pnpm --filter @llm-wiki/cli dev -- search "查询词"
pnpm --filter @llm-wiki/cli dev -- serve
```

> 注意：CLI 通过进程内 `import("next")` 启动 Web，因此 `serve` 会复用 `apps/web` 的源码；改动 Web 后重新 `serve` 即可看到变化（dev 模式下 Next 自带热更新）。

## 各包关键约定

### `packages/kb`（共享引擎）

- **模块规范**：`NodeNext` —— 所有相对导入必须带 `.js` 扩展名（如 `import { x } from "./types.js"`）。
- **类型严格**：继承 `tsconfig.base.json`，含 `strict`、`noUncheckedIndexedAccess`（索引访问返回 `T | undefined`）。
- **公开 API**：只通过 `src/index.ts` 桶导出；对外暴露的能力包括 `indexFiles`、`searchKnowledgeBase`、`getKbStats`、`listFiles`、`getFileDetail`、`getChunkDetail`、`openDatabase`、`mergeKbConfig` 等。
- **向量降级**：`openDatabase({ loadVector: true })` 在 sqlite-vec 加载失败时**不抛错**，仅置 `vectorEnabled = false` 并回调 `warn`。新增依赖向量的代码请始终判断该标志。
- **vec0 rowid 限制**：`better-sqlite3` 把 JS `number` 绑定为 REAL，而 sqlite-vec 的主键要求 INTEGER；写入 `vec_chunks` 时需用 `BigInt(chunkId)` 绑定 rowid（见 `indexer.ts`）。

### `packages/cli`（命令行）

- 新增命令模式：在 `src/commands/<name>.ts` 导出 `make<Name>Command(): Command`，在 `src/index.ts` 用 `program.addCommand(...)` 注册。
- 命令内错误处理统一用 `process.exitCode = 1`，**不要**直接 `process.exit()`；可恢复的业务问题用 `logger.warn`。
- 配置校验沿用**手写 `assertWikiConfig`**（非 zod）；新增配置字段需同步更新该校验与 `loadConfig` 的默认值合并逻辑。

### `apps/web`（检索页）

- **模块规范**：`Bundler` 解析 —— 相对导入**不带** `.js` 扩展名，可用 `@/*` 路径别名。
- API 路由必须声明 `export const runtime = "nodejs"`（原生 addon 不能跑在 Edge runtime）。
- 原生模块（`better-sqlite3`、`sqlite-vec`）已登记在 `next.config.ts` 的 `serverExternalPackages`，**切勿移除**，否则打包器会尝试 bundle `.node` 二进制导致报错。
- Web 不依赖 `@llm-wiki/cli`，需要读取配置时直接读 `.llm-wiki/config.json`（见 `app/api/_lib/kb-config.ts`）。

## 调试与验证建议

- **原生模块编译失败**：确保本机有 Python 与 C++ 编译工具链；macOS 一般有预编译产物，Linux/Windows 可能需源码编译。
- **检索无结果**：先用 `llm-wiki search <query> --json` 查看返回结构；中文查询可能因默认 FTS 分词限制而无法命中。
- **端口占用**：`serve` 遇 `EADDRINUSE` 会给出友好提示，换端口 `--port` 即可。

## 许可证

MIT
