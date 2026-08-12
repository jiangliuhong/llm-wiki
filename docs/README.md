# 项目文档

## 产品与架构

- [LLM Wiki 桌面端、CLI 与 MCP 一体化设计（V1）](./architecture-v1.md)  
  说明 Desktop 与 npm CLI 的独立产品形态、多工作空间、Pi Runtime、Tauri 桌面端、HeroUI + Tailwind、MCP CLI 模式、安全边界、迁移计划和 V1 验收标准。
- [LLM Wiki CLI 设计与 npm 发布规格（V1）](./cli-design-v1.md)  
  说明唯一 `llm-wiki` 命令、工作空间解析、命令树、Pi AI、`llm-wiki mcp serve`、JSON 协议、退出码、平台二进制包和 npm 发布流程。
- [LLM Wiki 桌面端交互原型](./prototypes/desktop/)  
  可离线打开的 HTML 原型，覆盖工作空间、Pi 问答、文档、导入、草稿、任务和 MCP 设置等主要流程。

## 当前版本使用与限制

- [CLI 使用指南](./cli-usage.md)
- [已知限制与注意事项](./known-limitations.md)
- [知识图谱设计与关系审核](./wiki-graph.md)
- [V1 改造状态](./migration-status.md)
- [V1 后续实施计划](./roadmap-v1.md)

> `architecture-v1.md`、`cli-design-v1.md` 与桌面端原型描述目标架构和后续迁移方案；CLI 使用指南与已知限制描述当前仓库已经实现的能力。二者不要混淆。
