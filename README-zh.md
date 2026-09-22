# EmbeddingZotero

这是一个内置 Streamable HTTP MCP 服务器和语义检索功能的 Zotero 插件。本仓库基于 [cookjohn/zotero-mcp](https://github.com/cookjohn/zotero-mcp) 修改，沿用原项目的 [MIT 许可证](LICENSE)；原项目作者和贡献者保留其署名。

[English](README.md)

## 当前版本

插件包版本为 **1.6.4**。本分支的主要改动：

- 为 `qwen3.7-text-embedding` 发送配置的输出维度，并核对 API 实际返回的维度。
- 扫描数据库中所有向量的维度，按维度显示向量数与文献数；仅对维度不符、仍存在于文库的文献重新嵌入。新向量成功写入前保留旧向量。
- 在设置页调整索引文献并发数，范围 **1–1000**，默认 **5**；新值从下一批任务开始生效。
- 将界面的“已索引文献数”与 Zotero 当前文库核对，避免把旧索引行直接算作现有文献。

**并发文献数不是嵌入 API 的全局请求速率上限。**每篇文献会分成许多文本块，多篇文献同时处理时会连续发出请求。遇到服务商返回 HTTP 429 时，请先降低并发，并核对该账户与模型当前的请求和 token 限额。

## 安装与使用

1. 下载[最新 `.xpi` 安装包](https://github.com/Max101Johnston/EmbeddingZotero/releases/latest/download/zotero-mcp-plugin.xpi)，或按下方步骤从源码构建。
2. 在 Zotero 的“工具 → 附加组件”中安装 `.xpi`，然后重启 Zotero。
3. 打开“设置 → Zotero MCP Plugin”，按需启用 MCP 服务器。默认 Streamable HTTP 地址为 `http://127.0.0.1:23120/mcp`。
4. 配置嵌入 API，点击“测试连接”，先确认模型实际输出的维度。
5. 在“索引”区域点击“检测维度”查看数据库分布。只有确定要替换其他维度的向量时，才点击“重嵌入维度不符文献”；此操作会调用嵌入 API，可能产生费用。

本分支保留上游 Zotero 插件 ID，安装此 `.xpi` 会替换已安装的上游版本。切换版本前建议备份 Zotero 配置目录。

## 从源码构建

需要 Zotero 7–10、Node.js 18 或更新版本，以及 npm。

```sh
cd zotero-mcp-plugin
npm ci
npm run build
```

安装包位于仓库根目录下的 `zotero-mcp-plugin/.scaffold/build/zotero-mcp-plugin.xpi`。构建输出、本地数据库、API 密钥和环境文件不应提交到 Git；密钥请在 Zotero 设置中填写。

## 向量精度说明

Int8 是用于本地相似度计算的近似表示；原始 Float32 向量也保存在 `vectors_f32`。界面显示“Int8 优化 100%”只代表所有已存向量都有 Int8 副本，不代表所有文献已索引或维度均正确。当前检索通常直接依据 Int8 分数排序，并未对所有候选结果用 Float32 重排。维度检测也无法区分两个输出维度相同的不同模型。

## 上游与许可证

本项目基于 cookjohn 和贡献者的 [Zotero MCP](https://github.com/cookjohn/zotero-mcp)；许可证见 [LICENSE](LICENSE)。本仓库的修改不代表上游项目对其背书。
