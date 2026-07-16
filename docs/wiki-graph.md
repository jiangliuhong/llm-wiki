# Wiki 文档知识图谱

知识图谱以索引中的文档为主节点，支持显式关系、Markdown 链接、WikiLink、标签和经人工审核的 Agent 候选。全部数据保存在 `.llm-wiki/index.db`，不依赖外部图数据库。

## 声明关系

```yaml
---
title: 搜索架构
slug: search-architecture
summary: 搜索服务的边界与依赖
tags: [搜索, SQLite]
relations:
  - type: depends_on
    target: ./storage.md
  - type: implements
    target: wiki/spec/search.md
---
```

内置关系类型为 `references`、`depends_on`、`implements`、`extends`、`related_to`。其他名称会规范化为 `snake_case` 自定义类型。

- `./` 和 `../` 相对当前文档解析，其他路径相对项目根目录。
- 普通 Markdown 本地链接和 `[[WikiLink]]` 生成 `references`。
- URL、页内锚点和图片不生成文档关系。
- WikiLink 只有在路径、slug、标题或文件名唯一匹配时才解析。
- 无效和多义目标可通过 `llm-wiki-cli relations diagnostics` 查看。

## Agent 候选

`llm-wiki-cli init` 会安装 `kb-infer-relations` skill。调用方 Agent 只生成候选文件，不直接修改数据库：

```json
{
  "version": 1,
  "proposals": [
    {
      "source": "wiki/architecture.md",
      "target": "wiki/storage.md",
      "type": "depends_on",
      "confidence": 0.9,
      "rationale": "架构文档明确使用存储契约。",
      "evidence": {
        "path": "wiki/architecture.md",
        "startLine": 18,
        "endLine": 20,
        "text": "索引层将文档写入本地存储。"
      }
    }
  ]
}
```

导入后使用 CLI 或 Web `/relations/review` 审核。`pending` 和 `rejected` 候选不参与导航及搜索；批准后的边保留 `agent` 来源、证据、理由和置信度。

## 查询与展示

- 文档页右侧显示入边、出边、关系来源、标签关联和一跳局部图。
- Web 搜索默认展示图关系扩展；CLI 使用 `search --graph` 显式启用。
- 图扩展不会伪装成正文命中，返回值位于独立的 `graphContext` 字段。
- 首版局部图最多遍历三层 API 深度，搜索仅使用一跳、每个种子最多三个关联文档。
