# DeepSeek Harness 桌面版 0.1.2

[English Release Notes](https://github.com/LTJ002/DeepSeek-Harness/releases/tag/v0.1.2) | 中文

---

DeepSeek Harness 桌面版是基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`0.1.0-rc.7`）内核的 Windows 桌面应用，将 `dsh web` 的 Web 界面封装为原生 Electron 应用——双击启动、自动拉起内置服务、无需 Node.js。MIT 协议。

## 功能特性

- **MCP 自动检测** — 扫描 Claude Desktop / Cursor / VS Code / Cline / Windsurf 的 MCP 配置并同步到桌面端
- **插件市场** — 内置 pnpm，免环境安装/更新插件；失败自动修复或回滚
- **对话与文件联动回滚** — `/rewind` 命令、悬停回滚、双击 Esc
- **检查更新** — 从 GitHub Releases 检测新版本
- **内置默认插件** — 首次启动自动安装 8 个插件
- **启动提速** — 正常退出跳过会话校验
- **全屏** — F11 切换，不隐藏任何操作入口

## 修复

- **便携版崩溃** — 改为解压到 exe 旁 `app\` 目录，不再使用系统临时目录
- **便携版升级** — 版本标记检测；新版 Portable.exe 自动重新解压
- **进度窗口** — 应用启动后自动关闭，不再阻塞应用
- **蓝色终端框** — Defender 排除脚本在安装/卸载时静默运行
- **打包失败** — 修复 pnpm 深路径超 260 字符导致的 NSIS 打包失败
- **内容一致性** — 与验证构建完全一致，不含任何用户配置或密钥

## 下载

- `DeepSeek Harness Setup 0.1.2.exe` — 安装版
- `DeepSeek Harness 0.1.2 Portable.exe` — 便携版