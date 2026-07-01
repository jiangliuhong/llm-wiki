# 已知限制与注意事项

本文档记录当前知识库系统在检索与运行时方面的两个已知限制，供使用与后续改进参考。

---

## 1. 中文全文检索（FTS）偏弱

### 现象

对**中文**查询，FTS5 全文检索往往无法命中，结果通常只来自向量检索（`source = vector`）。
对英文、以及本身以空格/标点分隔的查询（如代码标识符 `searchKnowledgeBase`），FTS 表现正常，能命中 `fts` 甚至 `vector+fts`。

### 根因

- 当前 `chunks_fts` 使用 SQLite FTS5 的**默认 `unicode61` 分词器**：
  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
  USING fts5(content, content='chunks', content_rowid='id');
  ```
- `unicode61` 按空格与 Unicode 标点切分 token，**中文没有词边界**，整段中文常被当作单个 token，导致 MATCH 命中率极低。
- 这一点在参考系统的 `技术文档.md` 中也已明确指出：「切片策略与分词未针对中文优化……真正稳定可依赖的是 FTS（对英文/分词内容）」。
- 此外，含特殊字符的查询（如 `P&L`）会直接触发 FTS5 语法错误；当前实现已做**优雅降级**——FTS 失败时保留向量结果并在返回中带 `warning`，前端/CLI 也会提示用户拆分特殊字符或换词。

### 现状下的影响

混合检索仍可用，但中文查询的语义召回主要依赖向量（而当前向量是**确定性 fake embedding**，无真实语义价值）。因此中文场景下的整体检索质量有限。

### 改进方向（未实现）

- 为 `chunks_fts` 指定支持中文的分词器：可选 SQLite 自带的 `trigram`（`tokenize = 'trigram'`，按 3 字滑窗，对 CJK 较友好，但会有更多误命中），或接入 ICU / jieba 等外部分词方案。
- 换分词器通常需要**重建索引**（`llm-wiki-cli index --reset`）。

---

## 2. `serve --prod` 生产模式下向量检索会降级为 FTS-only

### 现象

| 模式 | 命令 | 向量检索 | 说明 |
|---|---|---|---|
| 开发模式（默认） | `llm-wiki-cli serve` | ✅ 可用 | Next dev server 进程内加载 sqlite-vec 成功 |
| 生产模式 | `llm-wiki-cli serve --prod` | ⚠️ 降级为 FTS-only | 原生扩展在生产打包进程内加载失败 |

- dev 模式下 `GET /api/kb/stats` 返回 `vectorEnabled: true`、向量计数正确。
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

系统**始终可用**：这是设计阶段就预留的「向量优雅降级」机制——加载失败时 `openDatabase` 仅发出 warning、置 `vectorEnabled = false`，`indexer`/`search` 全部跳过向量分支，检索退化为纯 FTS，不会抛错。
- 日常开发与检索以 `serve`（dev）为主，向量功能正常。
- `--prod` 下若需向量，可单独验证扩展加载环境。

### 改进方向（未实现）

- 排查 Next 16 生产运行期 `loadExtension` 的加载路径解析，确认是否因 `cwd` / 二进制查找路径导致。
- 或在 `serve` 启动前预加载扩展并固化到进程，避免 Turbopack 运行时重新解析。

---

## 附：与本次改动无关的既有问题

`pnpm -r run lint` 在三个包内均失败，根因是根目录的 ESLint 共享依赖在 workspace 包内无法解析（`@eslint/js` 等 `Cannot find module`）。这是本次改动前就存在的环境问题，**与知识库功能无关**；类型检查（`tsc --noEmit`）与 `build` 均通过。
