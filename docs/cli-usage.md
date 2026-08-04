# `llm-wiki-cli` 命令行使用手册

`llm-wiki-cli` 用于在本地初始化、索引、检索和浏览文档知识库。配置与索引数据默认保存在当前项目的 `.llm-wiki/` 目录中，不会上传到外部服务。

## 1. 环境与安装

运行环境：

- Node.js 22 或更高版本
- pnpm 9.x

在仓库根目录安装为全局命令：

```bash
bash install.sh
```

安装完成后检查命令：

```bash
llm-wiki-cli --version
llm-wiki-cli --help
```

不安装全局命令也可以在仓库根目录运行：

```bash
# 直接运行 TypeScript 源码
pnpm --filter @llm-wiki/cli dev -- <command>

# 或先构建，再运行构建产物
pnpm --filter @llm-wiki/cli... run build
node packages/cli/dist/index.js <command>
```

下文统一使用全局命令 `llm-wiki-cli`。

## 2. 快速开始

进入准备作为知识库根目录的目录，然后依次执行：

```bash
llm-wiki-cli init --title "团队知识库"

# 将 Markdown、代码或文本文件放入 wiki/ 后建立索引
llm-wiki-cli index

# 在终端检索
llm-wiki-cli search "部署流程"

# 启动本地网页
llm-wiki-cli serve
```

默认网页地址为 <http://localhost:3000>。

> 兼容模式下路径相对于当前目录解析；也可以使用 `--root` 或注册后的 `--kb <id>`，无需先切换到知识库目录。

## 3. 全局选项

```text
llm-wiki-cli [options] [command]
```

| 选项              | 环境变量          | 说明                                                                     |
| ----------------- | ----------------- | ------------------------------------------------------------------------ |
| `-h, --help`      |                   | 显示帮助信息                                                             |
| `-v, --version`   |                   | 显示当前版本                                                             |
| `--kb <id>`       | `LLM_WIKI_KB`     | 使用全局注册表中的知识库 ID                                              |
| `--root <path>`   | `LLM_WIKI_ROOT`   | 知识库根目录，默认为当前目录。决定 `kb.include` 的解析基准与默认 DB 位置 |
| `--db <path>`     | `LLM_WIKI_DB`     | SQLite 索引文件路径，默认 `<root>/.llm-wiki/index.db`                    |
| `--config <path>` | `LLM_WIKI_CONFIG` | 配置文件路径，默认 `<root>/.llm-wiki/config.json`                        |

全局选项可放在子命令之前，优先级为：命令行标志 > 环境变量 > 默认值。这让编排层（如 pi-agents）可以一次性设置环境变量，在整条流水线中复用，而不必每次重复传参：

```bash
llm-wiki-cli \
  --root /path/to/knowledge-worktree \
  --config /path/to/config.json \
  --db /path/to/active.db \
  search "退款规则" --json --read-only
```

查看某个子命令的帮助：

```bash
llm-wiki-cli <command> --help
```

> 说明：`llm-wiki-cli` 没有仓库（git）的概念，只有目录的概念。所有 Git/MR/用户确认/索引切换由上层编排服务负责；本工具只负责「给定目录、配置、commit 标识，可靠地生成、验证和查询索引」。

### 3.1 全局知识库注册表

注册表默认位于 `$XDG_CONFIG_HOME/llm-wiki/registry.json`，未设置
`XDG_CONFIG_HOME` 时位于 `~/.config/llm-wiki/registry.json`。可通过
`LLM_WIKI_REGISTRY` 指定其他文件，适合测试和隔离环境。

```bash
llm-wiki-cli kb add backend /path/to/backend
llm-wiki-cli kb add product /path/to/product
llm-wiki-cli kb list
llm-wiki-cli kb show backend
llm-wiki-cli kb default backend
llm-wiki-cli kb remove product
```

`kb add` 只注册已经初始化的知识库，不移动文档或数据库。`kb remove` 也只删除注册信息，
不会删除项目中的 `.llm-wiki`、索引或文档。注册后可从任意目录运行：

```bash
llm-wiki-cli --kb backend index
llm-wiki-cli --kb backend search "部署流程"
llm-wiki-cli --kb backend status --json
```

显式的 `--root`、`--db`、`--config` 优先于注册表字段；未传 `--kb` 时继续使用当前目录，
因此旧项目不需要迁移。

## 4. `init`：初始化知识库

```text
llm-wiki-cli init [--title <title>] [--port <port>]
```

在当前目录中完成以下初始化操作：

- 创建 `.llm-wiki/config.json`；
- 创建默认内容目录 `wiki/`；
- 当 `wiki/` 不存在时，创建示例文件 `wiki/welcome.md`。
- 在 `.agents/skills/` 安装用于拆分写入与检索 Wiki 的项目 skills。

选项：

| 选项              | 默认值    | 说明                                     |
| ----------------- | --------- | ---------------------------------------- |
| `--title <title>` | `My Wiki` | 知识库标题，同时用于网页标题             |
| `--port <port>`   | `3000`    | 网页服务端口，可取 `0` 到 `65535` 的整数 |

示例：

```bash
mkdir my-wiki && cd my-wiki
llm-wiki-cli init --title "研发 Wiki" --port 3100
```

如果 `.llm-wiki/config.json` 或同名 skill 已存在，命令会保留已有内容；再次执行可补装缺失的内置 skill。

## 5. `index`：建立或更新索引

```text
llm-wiki-cli index [--reset] [--json] [--source-revision <sha>]
                   [--source-branch <name>] [--output-db <path>] [--seed-db <path>]
```

扫描配置中 `kb.include` 指定的目录，将支持的文件切片后写入索引 DB（默认 `<root>/.llm-wiki/index.db`，可由 `--db` 或 `--output-db` 覆盖）。

| 选项                      | 说明                                                                |
| ------------------------- | ------------------------------------------------------------------- |
| `--reset`                 | 清空已有索引并重新建立全量索引                                      |
| `--json`                  | 输出机器可读的结果对象，便于编排层判断成败与统计                    |
| `--source-revision <sha>` | 记录本次索引对应的来源版本（如合并后的 commit sha），写入索引元数据 |
| `--source-branch <name>`  | 记录来源分支标签，写入索引元数据                                    |
| `--output-db <path>`      | 在该文件中构建索引，不触碰当前活跃索引；便于编排层校验后原子切换    |
| `--seed-db <path>`        | 构建前先复制该旧索引再增量更新，加速大型知识库的重建                |

不带 `--reset` 时执行增量索引：

- 新文件会加入索引；
- 内容、修改时间或大小发生变化的文件会更新；
- 未变化的文件会跳过；
- 已从磁盘删除的文件会从索引中移除。

每次索引完成后，索引 DB 中会写入 provenance 元数据（schema 版本、来源 revision/branch、内容目录、configHash、构建时间、文件数、切片数），供 `status` / `search --json` / `validate` 读取。

支持的文件扩展名：

```text
.js .mjs .cjs .ts .tsx .jsx .md .mdx .json .txt .yml .yaml
```

常用示例：

```bash
# 日常增量更新
llm-wiki-cli index

# 修改切片参数、向量维度或索引策略后全量重建
llm-wiki-cli index --reset

# 在新文件中构建索引（活跃索引不受影响），记录来源 commit
llm-wiki-cli index \
  --output-db /path/to/indexes/abc123.tmp.db \
  --source-revision abc123 \
  --json
```

`--json` 成功输出示例：

```json
{
  "ok": true,
  "db": "/path/to/index.db",
  "stats": {
    "scanned": 12,
    "added": 2,
    "updated": 0,
    "skipped": 10,
    "deleted": 0,
    "chunks": 18,
    "vectorEnabled": false
  },
  "metadata": {
    "schemaVersion": 3,
    "sourceRevision": "abc123",
    "sourceBranch": "",
    "contentDirectories": ["wiki"],
    "configHash": "9f2c...",
    "builtAt": "2026-07-27T10:00:00.000Z",
    "fileCount": 12,
    "chunkCount": 18
  },
  "durationMs": 234
}
```

## 6. `search`：在终端检索

```text
llm-wiki-cli search <query> [-l, --limit <n>] [--json] [--graph] [--read-only]
```

参数与选项：

| 参数或选项        | 默认值 | 说明                                                         |
| ----------------- | ------ | ------------------------------------------------------------ |
| `<query>`         | 必填   | 查询文本；包含空格时应使用引号包裹                           |
| `-l, --limit <n>` | `8`    | 最大结果数，必须为 `1` 到 `50` 的整数                        |
| `--json`          | 关闭   | 输出便于脚本处理的 JSON，不添加终端样式                      |
| `--graph`         | 关闭   | 通过已审核的一跳文档关系扩展结果                             |
| `--read-only`     | 关闭   | 保证不创建或迁移 DB；DB 不存在时返回空结果（exit 0）而非报错 |

`--read-only` 适合编排层在首次索引前探测索引：不会因 DB 缺失而失败，语义上也明确表明本次检索不会产生任何写入。

示例：

```bash
llm-wiki-cli search "安装步骤"
llm-wiki-cli search "searchKnowledgeBase" --limit 3
llm-wiki-cli search "配置文件" --json
```

普通输出中的位置和来源示例：

```text
wiki/getting-started.md:12-28  [fts]
  文档内容预览……
  bm25: -3.2100
```

来源标记含义：

默认配置只启用可靠的 FTS 检索，因此结果通常标记为 `fts`。内置向量是确定性测试实现，不具备真实语义能力；只有显式设置 `kb.embedding.enabled: true` 后才会参与索引和检索。

| 标记         | 含义                     |
| ------------ | ------------------------ |
| `vector+fts` | 向量检索和全文检索均命中 |
| `fts`        | 仅全文检索命中           |
| `vector`     | 仅向量检索命中           |

JSON 输出的顶层字段包括：

```json
{
  "query": "配置文件",
  "limit": 8,
  "hits": [],
  "vectorEnabled": false,
  "index": {
    "schemaVersion": 3,
    "sourceRevision": "abc123",
    "builtAt": "2026-07-27T10:00:00.000Z"
  }
}
```

每个 `hits` 元素包含文件路径、起止行号、原始切片、预览、来源，以及命中方式对应的 `distance` 或 `bm25`。全文检索无法解析查询时，顶层还会包含 `warning`。`index` 字段携带本次检索所针对索引的 provenance（来源 commit、构建时间等），便于回答时标注知识来自哪个版本；索引尚无元数据时为 `null`。

脚本调用示例：

```bash
llm-wiki-cli search "配置文件" --json | jq '.hits[] | {path, startLine, source}'
```

## 7. `status`：查询索引状态

```text
llm-wiki-cli status [--json] [--target-revision <sha>] [--no-config-check]
```

报告当前索引 DB 的健康度与 provenance，并判断是否需要重建。专为编排层设计：比较索引记录的 `sourceRevision` 与期望的目标 revision，以及索引记录的 `configHash` 与当前配置的 hash。

| 选项                      | 说明                                                           |
| ------------------------- | -------------------------------------------------------------- |
| `--json`                  | 输出机器可读的状态对象                                         |
| `--target-revision <sha>` | 期望的来源 revision；与索引记录比较，不一致则标记 `mismatches` |
| `--no-config-check`       | 跳过当前配置 hash 与索引记录的比较                             |

DB 不存在是合法状态（非错误）：输出 `exists: false` 并以 exit 0 退出，调用方据此触发首次构建。

```bash
# 判断当前索引是否匹配目标分支最新 commit
llm-wiki-cli status --json --target-revision "$MERGED_SHA"
```

输出示例（DB 存在但 revision 不匹配）：

```json
{
  "ok": true,
  "db": "/path/to/index.db",
  "exists": true,
  "metadata": { "sourceRevision": "oldsha", "configHash": "...", "builtAt": "..." },
  "stats": { "files": 12, "chunks": 18, "tablesOk": true, "vectorEnabled": false },
  "upToDate": false,
  "configMatches": true,
  "mismatches": ["sourceRevision"]
}
```

## 8. `validate`：校验候选索引

```text
llm-wiki-cli validate --db <path> [--json]
```

在编排层把候选索引切换为正式索引之前，检查其完整性。`--db` 必填：validate 总是检查一个显式文件（通常是刚 `index --output-db` 产生的临时 DB）。

检查项：

- `PRAGMA integrity_check`（SQLite 物理一致性）
- 必需基础表（`files` / `chunks` / `chunks_fts`）存在
- `schema_version` 与当前代码期望值（`3`）一致
- 行数统计（files / chunks / fts）

任一检查失败则以退出码 `3`（DB）退出，调用方可据此把原子切换的闸门建立在一次干净的 validate 上。

```bash
llm-wiki-cli validate --db /path/to/indexes/abc123.tmp.db --json
```

## 9. `serve`：启动本地检索网页

```text
llm-wiki-cli serve [-p, --port <port>] [--prod] [--all]
```

| 选项                | 默认值              | 说明                                               |
| ------------------- | ------------------- | -------------------------------------------------- |
| `-p, --port <port>` | 配置文件中的 `port` | 仅为本次启动覆盖服务端口                           |
| `--prod`            | 关闭                | 使用已构建的 Next.js 生产产物，而不是开发服务器    |
| `--all`             | 关闭                | 加载注册表中的全部知识库，并在同一服务中按 ID 隔离 |

示例：

```bash
# 使用配置中的端口，以开发模式启动
llm-wiki-cli serve

# 临时改用 8080 端口
llm-wiki-cli serve --port 8080

# 使用生产构建；需事先构建 Web 应用
pnpm --filter @llm-wiki/web build
llm-wiki-cli serve --prod

# 从其他目录启动一个已注册知识库
llm-wiki-cli --kb backend serve

# 启动全部已注册知识库
llm-wiki-cli serve --all
```

多库服务的页面路径为 `/kbs/<kbId>`，API 路径为 `/api/kbs/<kbId>/...`。文件、搜索、
统计、图谱和关系审核都显式携带 `kbId`，不同知识库继续使用各自独立的 SQLite 文件。
顶部选择器用于切换知识库，左侧文件树只展示当前选中知识库的文档。

`serve --all` 模式还会显示 **Add knowledge base**：

- 输入本机绝对目录路径，可直接注册已经初始化的知识库；
- 如果没有 `.llm-wiki/config.json`，勾选初始化后会创建默认配置、`wiki/welcome.md`
  和独立的空索引数据库，再加入全局注册表；
- 已存在但格式损坏的配置不会被覆盖；
- 单库 `serve` 不开放注册表写入，因此不会显示添加按钮。

按 `Ctrl+C` 停止服务。

## 10. 配置文件

配置文件位于知识库根目录下的 `.llm-wiki/config.json`。默认内容如下：

```json
{
  "title": "My Wiki",
  "port": 3000,
  "kb": {
    "include": ["wiki"],
    "exclude": ["node_modules", ".git", ".llm-wiki", "dist", "build", "out"],
    "chunk": {
      "maxChars": 1200,
      "overlap": 200
    },
    "embedding": {
      "enabled": false,
      "dimensions": 1536
    }
  }
}
```

字段说明：

| 字段                      | 说明                                       |
| ------------------------- | ------------------------------------------ |
| `title`                   | 网页显示的知识库标题，不能为空             |
| `port`                    | 默认服务端口，取值为 `0` 到 `65535` 的整数 |
| `kb.include`              | 要递归扫描的目录列表，相对于知识库根目录   |
| `kb.exclude`              | 扫描时排除的目录名称列表                   |
| `kb.chunk.maxChars`       | 每个切片允许的最大字符数，必须为正整数     |
| `kb.chunk.overlap`        | 相邻切片重叠的字符数，必须为非负整数       |
| `kb.embedding.enabled`    | 是否启用实验性确定性向量，默认关闭         |
| `kb.embedding.dimensions` | 向量维度，必须为正整数                     |

`kb` 或其内部字段缺失时会自动使用默认值。修改切片参数或向量维度后，应运行：

```bash
llm-wiki-cli index --reset
```

## 11. 推荐工作流

日常维护知识库：

```bash
cd /path/to/my-wiki

# 编辑或新增 wiki/ 下的文档后
llm-wiki-cli index
llm-wiki-cli search "要查找的内容"
llm-wiki-cli serve
```

在 CI 或其他脚本中检索：

```bash
result="$(llm-wiki-cli search "发布检查" --limit 5 --json)"
printf '%s\n' "$result" | jq -e '.hits | length > 0'
```

## 12. 常见问题

### 退出码与 JSON 错误协议

`llm-wiki-cli` 使用稳定的退出码，便于编排层判断失败类别：

| 退出码 | 含义                                                                |
| ------ | ------------------------------------------------------------------- |
| `0`    | 成功（包括 `status` 报告 DB 不存在、`search --read-only` 空库）     |
| `1`    | 未预期的内部错误（兜底）                                            |
| `2`    | 配置问题：文件缺失、JSON 非法、校验失败                             |
| `3`    | 数据库/索引问题：无法打开、损坏、busy、schema 不匹配、validate 失败 |
| `4`    | 参数问题：非法 flag 值、空查询、limit 越界                          |

当命令以 `--json` 调用且失败时，stderr 会输出结构化错误对象，stdout 不产生成功体：

```json
{ "error": { "code": "CONFIG_ENOENT", "message": "Config file not found at ..." } }
```

`code` 是稳定的机器可读字符串（如 `CONFIG_ENOENT`、`DB_INDEX_FAILED`、`DB_OPEN_FAILED`、`DB_VALIDATE_FAILED`、`DB_QUERY_FAILED`、`ARGS_EMPTY_QUERY`）；更细粒度的原因在 `message` 中，供人类阅读但不应作为程序分支依据。

### 编排层（pi-agents）集成示例

```bash
# 1. 在 worktree 中构建新索引（不碰活跃索引）
llm-wiki-cli --root /worktree --db /srv/active.db \
  index --output-db /srv/indexes/$SHA.tmp.db --source-revision "$SHA" --json

# 2. 校验候选索引
llm-wiki-cli validate --db /srv/indexes/$SHA.tmp.db --json

# 3. 原子切换 active.db（由编排层负责，非本工具）

# 4. 只读检索，标注来源 commit
llm-wiki-cli --db /srv/active.db search "退款规则" --json --read-only
```

### 提示找不到配置文件

### 提示找不到配置文件

确认当前目录正确，并先初始化知识库：

```bash
llm-wiki-cli init
```

### 搜索不到刚修改的内容

索引不会在文件变化时自动刷新。修改文档后重新执行：

```bash
llm-wiki-cli index
```

### 修改配置后出现索引异常

修改 `kb.chunk` 或 `kb.embedding.dimensions` 后，使用全量重建：

```bash
llm-wiki-cli index --reset
```

### 中文查询或特殊字符查询效果不理想

当前中文全文检索能力有限；包含 `&` 等 FTS 特殊字符的查询也可能降级。可尝试改写查询、拆分特殊字符，详细说明见[已知限制](./known-limitations.md)。

### `serve --prod` 仅使用全文检索

仅当显式启用 `kb.embedding.enabled` 时此问题才适用。生产模式可能无法加载 `sqlite-vec`，此时会自动降级为 FTS-only。详细说明见[已知限制](./known-limitations.md)。

### 端口已被占用

为本次启动指定其他端口：

```bash
llm-wiki-cli serve --port 3001
```
