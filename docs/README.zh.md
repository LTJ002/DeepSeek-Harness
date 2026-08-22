# DeepSeek Harness 桌面版 0.1.4

[English](README.md) | 中文

## 项目简介

DeepSeek Harness 桌面版（`dsh-desktop`）是一款 Windows 桌面应用，将 `dsh web` 的 Web 界面封装为原生 Electron 桌面应用。

- 双击启动，自动拉起内置 `dsh web` 服务，在原生窗口打开界面
- 完全自包含：内置 Electron 43 + Node.js 22 + 完整 `@deepseek-ai/dsh` 包，不依赖系统 Node.js
- 与命令行版共享 `~/.dsh`（profile / 会话 / 存储全部通用）
- Windows 黑框修复：子进程不再弹出黑色控制台窗口

## 功能特性

| 功能 | 说明 |
| --- | --- |
| MCP 自动检测 | 扫描 MCP 配置并同步到桌面端 |
| 插件市场 | 内置 pnpm，免环境安装/更新插件 |
| 检查更新 | 从 GitHub Releases 检测新版本 |
| 离线预装插件 | 默认插件随安装包内置，全新安装免联网 |
| 黑框修复 | 子进程（git/pnpm/node）不再弹出黑色控制台窗口 |
| 窗口自动重连 | 内核重启后自动重连，不再灰屏卡死 |

### 内置默认插件（v0.1.4）

`dsh-vision-toolkit` 0.1.38 · `dsh-anchored-standard` 0.1.0 · `dsh-at-file` 0.6.7 · `dsh-better-sidebar` 0.13.1

## 安装与下载（v0.1.4）

| 产物 | 说明 | 下载 |
| --- | --- | --- |
| DeepSeek Harness Setup 0.1.4.exe | 安装版：安装到自定义目录，创建快捷方式，自动添加 Defender 排除 | [下载](https://github.com/LTJ002/DeepSeek-Harness/releases/download/v0.1.4/DeepSeek%20Harness%20Setup%200.1.4.exe) |
| DeepSeek Harness 0.1.4 Portable.exe | 便携版：绿色免安装，解压到 exe 旁，二次启动秒开 | [下载](https://github.com/LTJ002/DeepSeek-Harness/releases/download/v0.1.4/DeepSeek%20Harness%200.1.4%20Portable.exe) |

> GitHub Release：https://github.com/LTJ002/DeepSeek-Harness/releases/tag/v0.1.4

## 快捷键

| 按键 | 功能 |
| --- | --- |
| `F11` | 进入 / 退出全屏 |
| `Esc` | 退出全屏 |

## 运行日志

- 桌面端日志：`%APPDATA%\DeepSeek Harness\harness.log`
- Harness 数据目录：`~/.dsh`

## 开源协议

本项目基于 MIT 协议的 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 二次开发，遵循 [MIT License](https://github.com/LTJ002/DeepSeek-Harness/blob/main/LICENSE)。
