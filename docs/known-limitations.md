# 已知限制与注意事项

本文档记录当前知识库系统在检索与运行时方面的两个已知限制，供使用与后续改进参考。

---

## 1. 中文全文检索（FTS）偏弱

### 现象

对**中文**查询，FTS5 全文检索往往无法命中。默认配置已关闭无真实语义能力的确定性向量，因此这类查询会明确返回无结果，而不会用随机近邻填充结果。
对英文、以及本身以空格/标点分隔的查询（如代码标识符 `searchKnowledgeBase`），FTS 表现正常，通常能命中 `fts`。

### 根因

- 当前 `chunks_fts` 使用 SQLite FTS5 的**默认 `unicode61` 分词器**：
  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
  USING fts5(content, content='chunks', content_rowid='id');
  ```
- `unicode61` 按空格与 Unicode 标点切分 token，**中文没有词边界**，整段中文常被当作单个 token，导致 MATCH 命中率极低。
- 这一点在参考系统的 `技术文档.md` 中也已明确指出：「切片策略与分词未针对中文优化……真正稳定可依赖的是 FTS（对英文/分词内容）」。
- 此外，含特殊字符的查询（如 `P&L`）会直接触发 FTS5 语法错误；当前实现会返回空结果及 `warning`，前端/CLI 会提示用户拆分特殊字符或换词。如果显式启用了实验性向量，已有向量结果仍会保留。

### 现状下的影响

中文场景下的召回能力有限，但系统不会再把确定性 fake embedding 的近邻包装成可靠搜索结果。实验性向量只能通过 `kb.embedding.enabled: true` 显式开启，接入真实 embedding 前不建议在生产环境启用。

### 改进方向（未实现）

- 为 `chunks_fts` 指定支持中文的分词器：可选 SQLite 自带的 `trigram`（`tokenize = 'trigram'`，按 3 字滑窗，对 CJK 较友好，但会有更多误命中），或接入 ICU / jieba 等外部分词方案。
- 换分词器通常需要**重建索引**（`llm-wiki-cli index --reset`）。

---

## 2. 实验性向量及 `serve --prod` 降级

### 现象

| 模式 | 命令 | 向量检索 | 说明 |
|---|---|---|---|
| 默认配置 | `llm-wiki-cli serve` | 关闭 | `kb.embedding.enabled` 默认为 `false`，仅使用 FTS |
| 开发模式（显式启用） | `llm-wiki-cli serve` | ⚠️ 实验性 | sqlite-vec 可用，但内置 embedding 无真实语义 |
| 生产模式 | `llm-wiki-cli serve --prod` | ⚠️ 降级为 FTS-only | 原生扩展在生产打包进程内加载失败 |

- 默认配置下搜索结果返回 `vectorEnabled: false`，不会生成或查询向量。
- 显式启用后，dev 模式下 `GET /api/kb/stats` 可返回 `vectorEnabled: true`。
- `--prod` 模式下返回 `vectorEnabled: false`、`vectorRecords: 0`，搜索只走 FTS。
- **磁盘上的向量数据仍然存在**（CLI 的 `index` 已写入 `vec_chunks` 表，可被独立加载读取），只是 Web 生产进程在运行期无法加载 `sqlite-vec` 扩展。

### 根因

- `sqlite-vec` 与 `better-sqlite3` 都是**原生 Node addon**（`.node` / `.dylib` 二进制）。
- Next.js 16（Turbopack）在生产服务器进程内加载这些原生模块时，扩展加载链路（`db.loadExtension(...)`）与 dev server 表现不一致，导致 `vec0` 模块注册失败。
- `next.config.ts` 中已按 Next 16 规范配置 `serverExternalPackages`，避免打包器尝试 bundle 这些原生模块：
  ```ts
  const nextConfig: NextConfig = {
    reactStrictMode: true,
    transpilePackages: ["@heroui/react"],
    serverExternalPackages: ["better-sqlite3", "sqlite-vec"],
  };
  ```
  这一步是必须的（否则 API 路由直接报打包错误），但它无法解决运行期扩展加载的问题。

### 现状下的影响

系统**始终可用**：向量默认关闭；显式启用但加载失败时，`openDatabase` 仅发出 warning、置 `vectorEnabled = false`，检索退化为纯 FTS。
- 日常开发与检索保持默认的 FTS-only 配置。
- 只有验证 sqlite-vec 集成或替换为真实 embedding 后，才建议启用向量。

### 改进方向（未实现）

- 排查 Next 16 生产运行期 `loadExtension` 的加载路径解析，确认是否因 `cwd` / 二进制查找路径导致。
- 或在 `serve` 启动前预加载扩展并固化到进程，避免 Turbopack 运行时重新解析。

---

## 附：与本次改动无关的既有问题

`pnpm -r run lint` 在三个包内均失败，根因是根目录的 ESLint 共享依赖在 workspace 包内无法解析（`@eslint/js` 等 `Cannot find module`）。这是本次改动前就存在的环境问题，**与知识库功能无关**；类型检查（`tsc --noEmit`）与 `build` 均通过。
