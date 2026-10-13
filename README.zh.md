<div align="right">

[English](README.md) | [中文](README.zh.md) 

</div>

<div align="center">

# ExtraLife <sub>续命</sub>

**Codex 额度用尽时，把当前会话整理成可交给其他 AI 工具继续处理的工作简报。**

ExtraLife 从本机 Codex 会话中提取任务目标、当前进度、待办事项、失败尝试和重要文件，生成便于交接的文档。

<img src="docs/images/hero.webp" alt="Codex 额度耗尽后，使用 npx extralife --here 导出交接文档，再到 DeepSeek 继续工作" width="820">

```bash
npx @rroy233/extralife --here
```

[![node](https://img.shields.io/badge/node-%E2%89%A518-informational)](docs/reference.md#installation)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

</div>

## 功能

- 浏览 Codex 会话并查看额度状态，可按当前项目或目录缩小范围，也可查看归档会话。
- 导出任务目标、工作进度、下一步、失败尝试、文件变更、命令记录和对话摘要。
- 标注内容来自会话记录或上下文推断，方便接手者核对。
- 支持纯文本、Markdown 和 JSON 格式，可选择内容、详细程度和 token 预算。
- 默认清理常见凭据；会话数据在本机处理，不上传、不发送遥测。
- 生成的文档可交给 Codex、Claude Code、Cursor、Gemini、DeepSeek 或其他 AI 工具继续使用。

## 快速开始

需要 Node.js 18 或更新版本。进入项目目录后运行：

```bash
npx @rroy233/extralife --here
```

运行后按以下步骤选择会话、设置导出内容并生成交接文档：

### 1. 选择会话

列表会显示项目、分支、最近活动和额度状态。选择需要交接的会话即可查看详情。

<div align="center">
<img src="docs/images/picker.png" alt="ExtraLife 会话选择界面，显示 Codex 会话列表、额度状态和选中会话的摘要" width="820">
</div>

### 2. 选择导出内容

按需选择任务状态、下一步、失败尝试、文件变更等内容，也可以调整详细程度和 token 预算。

<div align="center">
<img src="docs/images/options.png" alt="ExtraLife 导出选项界面，可选择交接文档章节并查看 token 估算" width="820">
</div>

### 3. 交给其他 AI 工具

导出的文档会整理当前进度和下一步，方便另一个 AI 工具接着处理。

<div align="center">
<img src="docs/images/handoff.png" alt="ExtraLife 生成的交接文档示例，列出中断任务和后续步骤" width="620">
</div>

不需要交互选择时，可直接导出当前项目最近会话并复制到剪贴板：

```bash
npx @rroy233/extralife --here -y --copy
```

更多命令、导出格式和隐私说明见[命令参考](docs/reference.md)。读取压缩会话需要 Node.js 22.15 或更新版本。

## 隐私

ExtraLife 在本机读取 Codex 会话。凭据清理默认开启；分享前请检查生成的文档。不要公开原始会话文件、私有项目代码或凭据。

## 许可

MIT，详见 [LICENSE](LICENSE)。ExtraLife 与 OpenAI 无隶属关系；“Codex”指 OpenAI 的编程代理。
