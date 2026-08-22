# DeepSeek Harness Desktop 0.1.4

[English](README.md) | [中文](README.zh.md)

## Overview

DeepSeek Harness Desktop (`dsh-desktop`) is a Windows desktop application that wraps the `dsh web` Web UI into a native Electron shell.

- Double-click to launch: auto-starts the bundled `dsh web` server and opens the UI in a native window
- Fully self-contained: bundles Electron 43 + Node.js 22 + the complete `@deepseek-ai/dsh` package — no system Node.js required
- Shares `~/.dsh` with the CLI version (profiles / sessions / storage all shared)
- Windows no-console fix: child processes no longer pop black console windows

## Features

| Feature | Description |
| --- | --- |
| MCP auto-detection | Scans MCP configs and syncs them into the desktop app |
| Plugin market | Bundled pnpm — install/update plugins without extra setup |
| Update checker | Detects new releases from GitHub Releases |
| Offline preloaded plugins | Default plugins bundled — offline fresh install |
| No-console fix | Child processes (git/pnpm/node) never open visible console windows |
| Window auto-reconnect | Auto-reconnects after kernel restarts — no grey freeze |

### Bundled Default Plugins (v0.1.4)

`dsh-vision-toolkit` 0.1.38 · `dsh-anchored-standard` 0.1.0 · `dsh-at-file` 0.6.7 · `dsh-better-sidebar` 0.13.1

## Download (v0.1.4)

| Artifact | Description | Link |
| --- | --- | --- |
| DeepSeek Harness Setup 0.1.4.exe | Installer: chosen directory, shortcuts, silent Defender exclusion | [Download](https://github.com/LTJ002/DeepSeek-Harness/releases/download/v0.1.4/DeepSeek%20Harness%20Setup%200.1.4.exe) |
| DeepSeek Harness 0.1.4 Portable.exe | Portable: green, extracts beside the exe, instant relaunch | [Download](https://github.com/LTJ002/DeepSeek-Harness/releases/download/v0.1.4/DeepSeek%20Harness%200.1.4%20Portable.exe) |

> GitHub Release: https://github.com/LTJ002/DeepSeek-Harness/releases/tag/v0.1.4

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `F11` | Toggle fullscreen |
| `Esc` | Exit fullscreen |

## Logs

- Desktop app log: `%APPDATA%\DeepSeek Harness\harness.log`
- Harness data: `~/.dsh`

## License

Built on the MIT-licensed [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness); this project is licensed under the [MIT License](https://github.com/LTJ002/DeepSeek-Harness/blob/main/LICENSE).
