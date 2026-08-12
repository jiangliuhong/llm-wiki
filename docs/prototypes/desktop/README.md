# LLM Wiki 桌面端交互原型

该目录保存与 [`../../architecture-v1.md`](../../architecture-v1.md) 对应的桌面端交互原型。

## 查看方式

直接使用 Chrome、Edge、Safari 或 Firefox 打开 [`index.html`](./index.html)。也可以在仓库根目录启动任意静态文件服务器后访问该目录。

原型覆盖：

- 多工作空间切换；
- Pi AI 问答和带引用回答；
- 文档树、文档阅读与定位；
- 文件导入和拆分方案；
- 待确认草稿与 Diff；
- 索引、导入和 Pi 后台任务；
- MCP、Pi、权限和本地存储设置；
- 命令面板、弹窗、快捷键和页面切换。

## 文件说明

- `index.html`：原型入口和加载器；
- `payload-*.js`：由独立 HTML 原型压缩生成的静态载荷，保证原型可离线打开；
- 所有数据和交互均为演示内容，不会读写真实工作空间。

## 说明

这是一份产品交互原型，不是 Tauri 生产代码。正式实现应按照架构文档迁移为 React + Vite 页面，通过 Tauri Commands 调用 Knowledge Core，并通过受控 Sidecar 接入 Pi。

原始独立 HTML SHA-256：`9c0676e3e1e26c39602f3922f6a39e2164297542b4592abc8e91418666f48201`。
