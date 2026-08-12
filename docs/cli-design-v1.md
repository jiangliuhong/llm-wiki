# LLM Wiki CLI 设计与 npm 发布规格（V1）

> 状态：Proposal  
> 日期：2026-08-12  
> 对外 npm 包：`@llm-wiki/cli`  
> 对外命令：`llm-wiki`

## 1. 目标

CLI 是 LLM Wiki 的一等产品入口，不是 Desktop 的辅助工具。

用户仅安装 npm 包后，必须能够在没有 Desktop、没有 Rust 开发环境的情况下完成：

- 工作空间创建和注册；
- 文档索引、搜索和读取；
- 文件导入规划和写入；
- Pi 问答、总结和草稿生成；
- 草稿查看、冲突检查和应用；
- MCP stdio 服务；
- 状态和环境诊断。

V1 只注册 `llm-wiki`，不兼容 `llm-wiki-cli`，也不发布 `llm-wiki-mcp`。

## 2. 安装与运行组成

安装：

```bash
npm install -g @llm-wiki/cli
```

也支持临时执行：

```bash
npx @llm-wiki/cli --version
```

安装后：

```bash
llm-wiki --help
```

运行组成：

```text
@llm-wiki/cli npm 主包
├── bin/llm-wiki.js              # 平台检测和进程转发
├── pi-runtime/dist/index.js      # AI 命令使用
├── prompts/
├── skills/
└── optionalDependencies
    └── 当前平台 Rust 二进制包
```

Rust 二进制同时实现普通 CLI 和 MCP 子命令。

## 3. 工作空间语义

### 3.1 解析规则

依赖知识库数据的命令必须解析出唯一工作空间：

```text
1. --workspace <id|name|path>
2. LLM_WIKI_WORKSPACE
3. 从 cwd 向上查找 .llm-wiki/workspace.json
4. 返回 WORKSPACE_REQUIRED
```

不设置永久全局默认工作空间。

### 3.2 全局命令

以下命令不要求工作空间：

```bash
llm-wiki --version
llm-wiki doctor
llm-wiki workspace create ...
llm-wiki workspace add ...
llm-wiki workspace list
llm-wiki workspace show ...
llm-wiki workspace remove ...
llm-wiki pi status
llm-wiki pi login
llm-wiki pi models
llm-wiki pi doctor
llm-wiki mcp config
llm-wiki mcp doctor
```

### 3.3 工作空间命令

以下命令必须通过参数、环境变量或 cwd 解析工作空间：

```bash
llm-wiki index
llm-wiki search ...
llm-wiki status
llm-wiki document ...
llm-wiki import ...
llm-wiki ask ...
llm-wiki summarize ...
llm-wiki draft ...
```

### 3.4 当前工作空间

```bash
llm-wiki workspace current
```

输出当前解析来源：

```text
Workspace: P&L Wiki
ID: 9e093d88-95b9-45ce-8fc5-4d62e93840da
Root: /Users/jarome/Knowledge/pl-wiki
Resolved by: cwd
```

### 3.5 工作空间缺失

交互式文本错误：

```text
Error [WORKSPACE_REQUIRED]

No workspace could be resolved.

Run inside a workspace directory, or pass:
  --workspace <id|name|path>
```

JSON 错误：

```json
{
  "protocolVersion": "1",
  "ok": false,
  "error": {
    "code": "WORKSPACE_REQUIRED",
    "message": "No workspace could be resolved.",
    "details": {}
  }
}
```

## 4. 通用参数

所有合适的命令统一支持：

```text
--workspace <id|name|path>   显式工作空间
--json                       稳定 JSON 输出
--quiet                      减少非必要日志
--no-color                   禁用 ANSI 颜色
--no-input                   禁止交互输入
--yes                        确认高风险操作
--config <path>              覆盖全局配置路径
--verbose                    输出诊断信息到 stderr
```

规则：

- 业务结果写 stdout；
- 日志、警告和进度写 stderr；
- `--json` 时 stdout 只能包含一个有效 JSON 文档；
- 非 TTY 环境自动关闭 spinner；
- `--no-input` 下不得等待终端输入；
- 修改真实文件且启用 `--no-input` 时必须显式传入 `--workspace` 和 `--yes`。

## 5. 命令树

```text
llm-wiki
├── init
├── workspace
│   ├── create
│   ├── add
│   ├── list
│   ├── show
│   ├── current
│   └── remove
│
├── index
│   ├── run
│   ├── reset
│   ├── status
│   └── watch
│
├── search
├── status
├── doctor
│
├── document
│   ├── list
│   ├── read
│   ├── create
│   └── history
│
├── relations
│   ├── list
│   ├── propose
│   ├── approve
│   ├── reject
│   └── diagnostics
│
├── import
│   ├── plan
│   ├── apply
│   └── status
│
├── ask
├── summarize
│
├── draft
│   ├── list
│   ├── show
│   ├── create
│   ├── apply
│   └── discard
│
├── pi
│   ├── status
│   ├── login
│   ├── models
│   └── doctor
│
└── mcp
    ├── serve
    ├── config
    └── doctor
```

`llm-wiki index` 等同于 `llm-wiki index run`。

## 6. 工作空间命令

### 6.1 创建 Managed Workspace

```bash
llm-wiki workspace create "P&L Wiki" \
  --path ~/Knowledge/pl-wiki
```

创建：

```text
wiki/
attachments/
.llm-wiki/workspace.json
.llm-wiki/workspace.db
.llm-wiki/cache/
.llm-wiki/backups/
.llm-wiki/locks/
```

### 6.2 添加 Linked Workspace

```bash
llm-wiki workspace add ~/work/project \
  --name project-docs \
  --include docs \
  --include wiki \
  --read-write wiki
```

### 6.3 列表和详情

```bash
llm-wiki workspace list
llm-wiki workspace list --json
llm-wiki workspace show project-docs
llm-wiki workspace current
```

### 6.4 移除注册

```bash
llm-wiki workspace remove project-docs
```

默认只从全局注册表移除，不删除工作空间文件。删除本地数据不属于 V1。

## 7. 索引、搜索和读取

### 7.1 索引

```bash
llm-wiki index
llm-wiki index --workspace project-docs
llm-wiki index reset
llm-wiki index status
llm-wiki index watch
```

### 7.2 搜索

```bash
llm-wiki search "国家数据权限"
llm-wiki search "pl_forecast_result_monthly" \
  --workspace pl-wiki \
  --limit 20 \
  --json

# 正文命中之外附加一跳已批准关系
llm-wiki search "pl_forecast_result_monthly" --graph --json
```

结果必须包含：

```text
documentId
path
heading
startLine
endLine
pageNumber
preview
score
matchType
contentHash
graphContext
```

`graphContext` 是独立数组；每项至少包含 `seedFileId`、`relatedFileId`、`relatedPath`、`relationType`、`direction` 和可定位的 `evidence`。它不会改变正文 `hits` 的排序和计数。

### 7.3 文档

```bash
llm-wiki document list
llm-wiki document read wiki/pl/country-permission.md
llm-wiki document read wiki/pl/country-permission.md --lines 20:60
llm-wiki document history wiki/pl/country-permission.md
```

## 8. 导入命令

### 8.1 生成导入计划

```bash
llm-wiki import plan ./业务需求.docx
```

流程：

```text
保存附件
→ 提取文本
→ Pi 分析主题和拆分边界
→ 输出目标目录、文件名、摘要和冲突信息
→ 保存 import job
```

### 8.2 应用导入计划

```bash
llm-wiki import apply <job-id>
```

非交互：

```bash
llm-wiki import apply <job-id> \
  --workspace pl-wiki \
  --yes \
  --no-input
```

### 8.3 查看状态

```bash
llm-wiki import status
llm-wiki import status <job-id>
```

## 9. Pi AI 命令

### 9.1 问答

```bash
llm-wiki ask "这个项目如何控制国家数据权限？"
```

支持流式输出、取消和引用。

### 9.2 总结

```bash
llm-wiki summarize wiki/pl/
llm-wiki summarize wiki/pl/ --output draft
```

### 9.3 Pi 环境

```bash
llm-wiki pi status
llm-wiki pi login
llm-wiki pi models
llm-wiki pi doctor
```

AI 命令使用 npm 包内置 Pi Runtime。普通索引和搜索不依赖 Pi 登录。

结构化错误码至少包括：

```text
PI_AUTH_REQUIRED
PI_MODEL_NOT_CONFIGURED
PI_RUNTIME_NOT_FOUND
PI_RUNTIME_START_FAILED
PI_SESSION_FAILED
PI_TOOL_FAILED
```

## 10. 草稿命令

```bash
llm-wiki draft list
llm-wiki draft show <draft-id>
llm-wiki draft create --target wiki/new.md --content-file result.md
llm-wiki draft apply <draft-id>
llm-wiki draft discard <draft-id>
```

应用已有文档草稿时必须校验 `base_document_hash`。

交互式提交前显示：

```text
Workspace
Root
Operation
Target path
Base hash
Diff summary
```

## 11. MCP 命令

### 11.1 启动

```bash
llm-wiki mcp serve \
  --stdio \
  --workspace pl-wiki \
  --read-only
```

不允许无工作空间范围启动。

### 11.2 多工作空间

```bash
llm-wiki mcp serve \
  --stdio \
  --workspace pl-wiki \
  --workspace project-docs \
  --read-only
```

只读全局范围：

```bash
llm-wiki mcp serve \
  --stdio \
  --all-workspaces \
  --read-only
```

### 11.3 权限

```text
--read-only       只允许读取和检索
--allow-drafts    允许创建和更新草稿
--allow-apply     允许应用草稿
--allow-path      限制可写相对路径，可重复
```

V1 不提供删除 Tool。

### 11.4 协议输出

stdio 模式：

- stdin/stdout 只传输 MCP JSON-RPC；
- 普通日志只能写 stderr；
- 不显示 spinner；
- 不进行交互式询问；
- 客户端断开后进程退出。

### 11.5 配置生成

```bash
llm-wiki mcp config \
  --workspace pl-wiki \
  --client codex
```

输出示例：

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

## 12. JSON 输出协议

成功：

```json
{
  "protocolVersion": "1",
  "ok": true,
  "data": {
    "workspaceId": "pl-wiki",
    "results": []
  }
}
```

失败：

```json
{
  "protocolVersion": "1",
  "ok": false,
  "error": {
    "code": "WORKSPACE_NOT_FOUND",
    "message": "Workspace pl-wiki was not found.",
    "details": {
      "workspace": "pl-wiki"
    }
  }
}
```

协议要求：

- 字段使用 camelCase；
- `protocolVersion` 在破坏性调整时升级；
- 新增可选字段不视为破坏性调整；
- 不在 JSON 前后输出提示文本；
- 错误信息不包含密钥和敏感路径内容。

## 13. 退出码

| 退出码 | 含义 |
| ---: | --- |
| `0` | 成功 |
| `1` | 未分类运行错误 |
| `2` | 参数或用法错误 |
| `3` | 工作空间不存在或无法解析 |
| `4` | 权限或写入策略阻止 |
| `5` | 索引、文件或数据库错误 |
| `6` | Pi、模型或认证错误 |
| `7` | 文档哈希冲突 |
| `8` | MCP 初始化或协议错误 |
| `130` | 用户取消 |

## 14. npm 包结构

### 14.1 主包

```text
packages/cli/
├── bin/llm-wiki.js
├── pi-runtime/dist/index.js
├── prompts/
├── skills/
└── package.json
```

```json
{
  "name": "@llm-wiki/cli",
  "bin": {
    "llm-wiki": "./bin/llm-wiki.js"
  },
  "optionalDependencies": {
    "@llm-wiki/cli-darwin-arm64": "1.0.0",
    "@llm-wiki/cli-darwin-x64": "1.0.0",
    "@llm-wiki/cli-linux-arm64-gnu": "1.0.0",
    "@llm-wiki/cli-linux-x64-gnu": "1.0.0",
    "@llm-wiki/cli-win32-x64": "1.0.0"
  }
}
```

### 14.2 平台包

每个平台包只包含当前 target 的 Rust 二进制和许可证信息：

```text
packages/cli-darwin-arm64/
├── bin/llm-wiki
└── package.json
```

### 14.3 wrapper 职责

`bin/llm-wiki.js` 必须：

1. 识别 `process.platform` 和 `process.arch`；
2. 找到对应 optional dependency；
3. 设置 `LLM_WIKI_PI_RUNTIME_PATH`；
4. 使用继承式 stdio 启动 Rust 二进制；
5. 转发参数、退出码和 SIGINT/SIGTERM；
6. 在平台包缺失时给出清晰诊断；
7. 不修改 MCP stdout。

## 15. Rust crate 结构

```text
crates/
├── llm-wiki-core/
├── llm-wiki/            # 唯一 binary crate
├── llm-wiki-mcp/        # library crate
└── llm-wiki-protocol/
```

`llm-wiki` 在匹配 `mcp serve` 时调用：

```text
llm_wiki_mcp::serve(core, options)
```

内部模块化保留，但发布产物只有一个 `llm-wiki` 二进制。

## 16. 发布流程

```text
1. 运行 Rust、TypeScript 和协议测试
2. 编译各平台 llm-wiki 二进制
3. 构建 Pi Runtime JavaScript
4. 组装平台 npm 包
5. 组装 @llm-wiki/cli 主包
6. 执行 npm pack 和安装验证
7. 发布平台包
8. 发布 @llm-wiki/cli
9. 创建 GitHub Release
10. 在全新环境进行冒烟测试
```

所有平台包和主包使用同一版本号。

## 17. 发布验证

全新环境至少执行：

```bash
npm install -g @llm-wiki/cli
llm-wiki --version
llm-wiki doctor
llm-wiki workspace create "Test Wiki" --path ./test-wiki
cd ./test-wiki
llm-wiki index
llm-wiki search "welcome" --json
llm-wiki mcp serve --stdio --workspace . --read-only
```

还需验证：

```bash
npx @llm-wiki/cli --version
```

CI 应分别覆盖：

- macOS arm64；
- macOS x64；
- Linux x64；
- Linux arm64；
- Windows x64。

## 18. V1 验收标准

- npm 全局安装后只有 `llm-wiki` 命令；
- 不安装 Desktop 也能完成索引、搜索、读取、导入、Pi 问答和草稿流程；
- 普通命令可以从 cwd 自动发现工作空间；
- 无法发现时明确报错，不使用全局默认工作空间；
- 非交互写操作缺少显式工作空间和确认参数时被拒绝；
- MCP 通过 `llm-wiki mcp serve` 工作；
- MCP 不依赖 Pi，不要求 Desktop 运行；
- MCP 无显式 workspace scope 时拒绝启动；
- `--json` 输出可被脚本稳定解析；
- stdout/stderr 和退出码符合本规格；
- 主包不会下载所有平台二进制；
- Pi Runtime 缺失可以被 `llm-wiki pi doctor` 检测。
