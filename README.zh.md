# DeepSeek Harness 桌面版

[English](README.md) | 中文

## 项目简介

DeepSeek Harness 桌面版（`dsh-desktop`）是一款 Windows 桌面应用，内核基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`0.1.0-rc.8`）二次开发，将 `dsh web` 的 Web 界面封装为原生 Electron 桌面应用。

- 双击启动，自动拉起内置的 `dsh web` 服务（`http://127.0.0.1:<随机端口>`），在原生窗口打开界面
- 完全自包含：内置 Electron 43 + Node.js 22.19 + 完整 `@deepseek-ai/dsh@0.1.0-rc.8`，不依赖系统 Node.js
- 与命令行版共享 `~/.dsh`（profile / 会话 / 存储全部通用）
- 默认工作目录：`%USERPROFILE%\DeepSeekHarness`

## 功能特性

### 桌面端扩展

| 功能 | 说明 |
| --- | --- |
| MCP 自动检测 | 扫描 Claude Desktop / Cursor / VS Code / Cline / Windsurf 的 MCP 配置并同步到桌面端 |
| 插件市场 | 内置 pnpm，免环境安装/更新插件；一键更新，失败自动诊断修复或回滚 |
| 检查更新 | 从 GitHub Releases 检测新版本，提示下载安装 |
| 对话与文件联动回滚 | `/rewind` 命令、消息悬停"回滚到此消息"、输入框为空双击 Esc |
| 全屏 | F11 进入/退出全屏，不隐藏任何操作入口 |
| 多模态内核（rc.8） | DeepSeek 原生图片请求、`/goal`/`/plan` 图文输入、@ 菜单引用文件和会话；Claude Code 与 Codex 子代理可按需安装为 Profile Bundle；Windows PTY 持久 PowerShell 会话 |
| 窗口自动重连 | 内核重启换端口后窗口自动重连新地址（10 秒防抖），不再灰屏卡死，无需手动重启 |
| 离线预装插件 | 默认插件随安装包内置，全新安装免联网、首次启动更快；启动失败插件不再重复安装 |
| 日志体验 | 插件安装日志 60 秒自动收起，「链接/命令安装」与「已安装」页可一键清除日志；托盘图标去除黑边、高清显示 |

### 内置默认插件

首次启动自动安装（dsh-better-sidebar、dsh-at-file、dsh-token-usage 等 8 个），开箱即用；随安装包内置（preloaded-plugins），免联网。

## 安装与使用

| 产物 | 说明 |
| --- | --- |
| `DeepSeek Harness Setup 0.1.3.exe` | 安装版：安装到自定义目录，创建开始菜单/桌面快捷方式，自动添加 Defender 排除（静默） |
| `DeepSeek Harness 0.1.3 Portable.exe` | 便携版：解压到 exe 旁 `app\` 目录，二次启动秒开；版本不符自动重新解压（支持更新换代） |

### 便携版说明

- 首次运行显示"正在初始化"进度窗口，解压完成后自动启动，进度窗口自动消失
- 绿色免安装，不写注册表，解压位置 = exe 所在位置（放哪个盘就在哪个盘）

## 快捷键

| 按键 | 功能 |
| --- | --- |
| `F11` | 进入 / 退出全屏 |
| `Esc` | 退出全屏 |
| 输入框为空时双击 `Esc` | 打开 Web 设置页的"对话回滚"分区 |

## 目录结构

```
dsh-desktop/
├── main.js             Electron 主进程（拉起 harness + 加载 URL + 生命周期）
├── preload.js          本地页面最小桌面桥（重启 / 日志路径）
├── app/                启动页与错误页
├── harness/            @deepseek-ai/dsh 完整包（内核，含 node_modules）
├── runtime/node.exe    内置 Node 22.19 运行时
├── build/
│   ├── icon.ico        应用图标
│   ├── installer.nsi   NSIS 安装包脚本
│   ├── portable.nsi    NSIS 便携版脚本
│   └── tools/          本地打包工具（NSIS、rcedit）
└── dist/               组装与打包产物
```

## 运行日志

- 桌面端日志：`%APPDATA%\DeepSeek Harness\harness.log`
- Harness 数据目录：`~/.dsh`

启动优化：`~/.dsh/desktop-running.json` 启动时写入、正常退出时清除；只有首次启动或异常退出才全量校验会话日志，日常启动跳过校验，加快加载。

## 本地开发

```powershell
npm install --ignore-scripts
# 首次需手动下载 electron 运行时：
# https://npmmirror.com/mirrors/electron/v43.4.0/electron-v43.4.0-win32-x64.zip
# 解压到 node_modules/electron/dist，并写入 path.txt（内容 electron.exe）
npm start
```

## 重新打包（全手工，不依赖 electron-builder）

1. 组装应用目录：复制 `node_modules/electron/dist` + `harness/` + `runtime/`（node.exe、pnpm 及其 pnpm.cmd），用 `@electron/asar` 打包 `resources/app.asar`
2. `build\rcedit-x64.exe` 写入 exe 图标/版本信息
3. `build\tools\nsis\Bin\makensis.exe /DROOT=$root /V2 build\installer.nsi`（安装版）/ `build\portable.nsi`（便携版）

> 注意：`d3dcompiler_47.dll` 在本机打包沙箱中不允许以原名写入 `dist\`，需以 `dist\extra\d3dcompiler_47_new.dll` 别名暂存，NSIS 脚本用 `/oname=d3dcompiler_47.dll` 在安装时恢复原名。

## 常见问题

- **安装时会出现蓝色终端框？** 已修复：Defender 排除脚本静默运行（`-WindowStyle Hidden`），安装/卸载均无窗口。
- **便携版首次启动慢？** 首次需解压约 151MB（3 万+ 文件），属正常；之后秒开。
- **更新检测不到？** 更新源为 GitHub Releases（`LTJ002/DeepSeek-Harness`），需仓库发布新版本。

## 开源协议

本项目基于 MIT 协议的 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 二次开发，遵循 [MIT License](LICENSE)。
