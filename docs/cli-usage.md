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

> 所有项目路径都相对于执行命令时的当前目录解析。应先进入包含 `.llm-wiki/config.json` 的知识库根目录，再运行 `index`、`search` 或 `serve`。

## 3. 全局选项

```text
llm-wiki-cli [options] [command]
```

| 选项            | 说明         |
| --------------- | ------------ |
| `-h, --help`    | 显示帮助信息 |
| `-v, --version` | 显示当前版本 |

查看某个子命令的帮助：

```bash
llm-wiki-cli <command> --help
```

## 4. `init`：初始化知识库

```text
llm-wiki-cli init [--title <title>] [--port <port>]
```

在当前目录中完成以下初始化操作：

- 创建 `.llm-wiki/config.json`；
- 创建默认内容目录 `wiki/`；
- 当 `wiki/` 不存在时，创建示例文件 `wiki/welcome.md`。

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

如果 `.llm-wiki/config.json` 已存在，命令会给出提示并停止，不会覆盖已有配置或文档。

## 5. `index`：建立或更新索引

```text
llm-wiki-cli index [--reset]
```

扫描配置中 `kb.include` 指定的目录，将支持的文件切片后写入 `.llm-wiki/index.db`。

| 选项      | 说明                           |
| --------- | ------------------------------ |
| `--reset` | 清空已有索引并重新建立全量索引 |

不带 `--reset` 时执行增量索引：

- 新文件会加入索引；
- 内容、修改时间或大小发生变化的文件会更新；
- 未变化的文件会跳过；
- 已从磁盘删除的文件会从索引中移除。

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
```

完成后会输出本次扫描、新增、更新、跳过、删除的文件数以及生成的切片数。

## 6. `search`：在终端检索

```text
llm-wiki-cli search <query> [-l, --limit <n>] [--json]
```

参数与选项：

| 参数或选项        | 默认值 | 说明                                    |
| ----------------- | ------ | --------------------------------------- |
| `<query>`         | 必填   | 查询文本；包含空格时应使用引号包裹      |
| `-l, --limit <n>` | `8`    | 最大结果数，必须为 `1` 到 `50` 的整数  |
| `--json`          | 关闭   | 输出便于脚本处理的 JSON，不添加终端样式 |

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
  "vectorEnabled": false
}
```

每个 `hits` 元素包含文件路径、起止行号、原始切片、预览、来源，以及命中方式对应的 `distance` 或 `bm25`。全文检索无法解析查询时，顶层还会包含 `warning`。

脚本调用示例：

```bash
llm-wiki-cli search "配置文件" --json | jq '.hits[] | {path, startLine, source}'
```

## 7. `serve`：启动本地检索网页

```text
llm-wiki-cli serve [-p, --port <port>] [--prod]
```

| 选项                | 默认值              | 说明                                            |
| ------------------- | ------------------- | ----------------------------------------------- |
| `-p, --port <port>` | 配置文件中的 `port` | 仅为本次启动覆盖服务端口                        |
| `--prod`            | 关闭                | 使用已构建的 Next.js 生产产物，而不是开发服务器 |

示例：

```bash
# 使用配置中的端口，以开发模式启动
llm-wiki-cli serve

# 临时改用 8080 端口
llm-wiki-cli serve --port 8080

# 使用生产构建；需事先构建 Web 应用
pnpm --filter @llm-wiki/web build
llm-wiki-cli serve --prod
```

服务启动后可在网页中搜索、查看结果来源、打开文件内容，以及检查索引文件数、切片数和向量状态。按 `Ctrl+C` 停止服务。

## 8. 配置文件

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

## 9. 推荐工作流

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

## 10. 常见问题

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
