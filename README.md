# DeepSeek Harness Desktop

[English](README.md) | [中文](README.zh.md)

## Overview

DeepSeek Harness Desktop (`dsh-desktop`) is a Windows desktop application built on the [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) kernel (`0.1.0-rc.7`). It wraps the `dsh web` Web UI into a native Electron shell.

- Double-click to launch: auto-starts the bundled `dsh web` server (`http://127.0.0.1:<random port>`) and opens the UI in a native window
- Fully self-contained: bundles Electron 43 + Node.js 22.19 + the complete `@deepseek-ai/dsh@0.1.0-rc.7` package — no system Node.js required
- Shares `~/.dsh` with the CLI version (profiles / sessions / storage all shared)
- Default working directory: `%USERPROFILE%\DeepSeekHarness`

## Features

### Desktop Extensions

| Feature | Description |
| --- | --- |
| MCP auto-detection | Scans MCP configs from Claude Desktop / Cursor / VS Code / Cline / Windsurf and syncs them into the desktop app |
| Plugin market | Bundled pnpm — install/update plugins without extra setup; one-click update with auto repair or rollback on failure |
| Update checker | Detects new releases from GitHub Releases and prompts download |
| Conversation & file rollback | `/rewind` command, "Rollback to this message" on hover, double-press `Esc` with empty input |
| Fullscreen | `F11` toggles fullscreen without hiding any controls |

### Bundled Default Plugins

Installed automatically on first launch (dsh-better-sidebar, dsh-at-file, dsh-token-usage and 8 more) — ready to use out of the box.

## Installation

| Artifact | Description |
| --- | --- |
| `DeepSeek Harness Setup 0.1.2.exe` | Installer: installs to a chosen directory, creates Start Menu / desktop shortcuts, adds Defender exclusion silently |
| `DeepSeek Harness 0.1.2 Portable.exe` | Portable: extracts to `app\` beside the exe, instant relaunch; auto re-extracts when version mismatches (supports upgrades) |

### Portable Notes

- First run shows an "Initializing" progress window, which disappears automatically once the app launches
- Green / no registry writes; extract location = wherever the exe lives

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `F11` | Toggle fullscreen |
| `Esc` | Exit fullscreen |
| Double-press `Esc` with empty input | Open "Conversation Rollback" in Web Settings |

## Directory Structure

```
dsh-desktop/
├── main.js             Electron main process (launches harness + loads URL + lifecycle)
├── preload.js          Minimal desktop bridge for local pages (restart / log path)
├── app/                Launch page and error pages
├── harness/            Complete @deepseek-ai/dsh package (kernel, incl. node_modules)
├── runtime/node.exe    Bundled Node 22.19 runtime
├── build/
│   ├── icon.ico        App icon
│   ├── installer.nsi   NSIS installer script
│   ├── portable.nsi    NSIS portable script
│   └── tools/          Local packaging tools (NSIS, rcedit)
└── dist/               Assembly and packaging output
```

## Logs

- Desktop app log: `%APPDATA%\DeepSeek Harness\harness.log`
- Harness data: `~/.dsh`

Startup optimization: `~/.dsh/desktop-running.json` is written on start and cleared on normal exit; a full session-log validation only runs on first launch or after an abnormal exit, keeping everyday startups fast.

## Local Development

```powershell
npm install --ignore-scripts
# First time: manually download the Electron runtime:
# https://npmmirror.com/mirrors/electron/v43.4.0/electron-v43.4.0-win32-x64.zip
# Extract to node_modules/electron/dist and write path.txt (content: electron.exe)
npm start
```

## Repackaging (fully manual, no electron-builder)

1. Assemble the app directory: copy `node_modules/electron/dist` + `harness/` + `runtime/` (node.exe, pnpm and pnpm.cmd), then package `resources/app.asar` with `@electron/asar`
2. `build\rcedit-x64.exe` writes the exe icon/version info
3. `build\tools\nsis\Bin\makensis.exe /DROOT=$root /V2 build\installer.nsi` (installer) / `build\portable.nsi` (portable)

> Note: `d3dcompiler_47.dll` cannot be written to `dist\` under its original name in the packaging sandbox — it is staged as `dist\extra\d3dcompiler_47_new.dll` and restored via NSIS `/oname=d3dcompiler_47.dll` at install time.

## FAQ

- **Blue terminal window during install?** Fixed: the Defender exclusion script now runs silently (`-WindowStyle Hidden`) — no window on install or uninstall.
- **Portable first launch is slow?** The first run extracts ~151 MB (30k+ files); subsequent launches are instant.
- **No update detected?** The update source is GitHub Releases (`LTJ002/DeepSeek-Harness`) — new versions must be published there.

## License

Built on the MIT-licensed [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness); this project is licensed under the [MIT License](LICENSE).
