# 对话与文件联动回滚 — 使用与实现说明（v1）

## 功能

每条用户消息到达后、其触发的**任何工具执行前**，自动为当前工作区创建检查点（Git 仓库用 Git 对象快照，否则自动降级为文件复制快照）。

在 Web 设置页 →“对话回滚”分区可以：

1. 查看检查点列表（时间、消息摘要、工作区）。
2. 对任意检查点生成**回滚计划**（只读，不改文件）：新增 / 修改 / 删除文件及行数变化。
3. 确认后执行：先建保护检查点 → 恢复文件 → 按消息截断会话日志 → 自动刷新会话。
4. “撤销上次回滚”：把文件恢复到回滚前状态。
5. 预览后工作区若再次变化，执行会被拒绝并要求重新预览（陈旧计划检测）。

## `/rewind` 命令（不发给模型）

| 命令 | 行为 |
| --- | --- |
| `/rewind list` | 列出当前工作区的检查点（保护/普通、时间、消息摘要） |
| `/rewind preview <id\|step N>` | 只读预览：列出将要恢复的文件差异 |
| `/rewind <id\|step N>` | 执行联动回滚：文件恢复 + 按消息截断对话 + 自动刷新 |
| `/rewind guard <id>` | 撤销最近一次回滚：把工作区文件恢复到保护检查点 |
| `/rewind help` | 显示用法 |

- `step N` 从 1 开始，1 = 最新检查点；`id` 支持完整 ID 或唯一前缀。
- 执行类命令由宿主端做只读计划，再通过 `command/executed` → `/enh/rewind-pending` 交棒给 Electron 主进程完成文件恢复与会话截断，签名保证“预览后工作区变化即失效”。

## 其他交互入口

- 每条用户消息悬停操作里的 **回滚到此消息** 按钮：撤销该消息及其后的对话，并还原该轮文件修改。
- **输入框为空时双击 Esc**：直接打开 Web 设置页的“对话回滚”分区。

## 数据位置

- 检查点元数据：`~/.dsh/checkpoints/index.json`
- 文件复制快照：`~/.dsh/checkpoints/snapshots/<id>/`
- Git 快照：存在于工作区 `.git` 对象库中（`commit-tree` 对象），不污染分支/工作区
- 保留策略：普通检查点 50 个、保护检查点 10 个，超出自动清理（Git 对象保留至 `git gc`）

## 安全保证

- 所有路径 `path.resolve` 后强制前缀校验，并对存在的符号链接做 `realpath` 二次校验；拒绝 `..`、绝对路径、盘符、UNC。
- 恢复只写/删快照内记录的路径，不触碰 `.git`、`node_modules`、`.dsh`。
- 恢复前必须先成功创建保护检查点；失败即中断，不执行回滚。
- 预览阶段只读。

## 实现位置

| 模块 | 文件 |
| --- | --- |
| 核心引擎（两进程共用） | `plugins/dsh-desktop-settings/lib/checkpoints.cjs` |
| 自动检查点钩子 + `/rewind` 命令（Cordis 宿主） | `plugins/dsh-desktop-settings/lib/index.js` |
| Web UI（列表/预览/确认/撤销）+ 命令交棒 + 双击 Esc | `plugins/dsh-desktop-settings/lib/client.js` |
| Electron IPC 与对话截断联动 | `main.js` / `preload.js` |
| 单元测试 | `plugins/dsh-desktop-settings/test/checkpoints.test.cjs` |
| `/rewind` 解析单测 | `plugins/dsh-desktop-settings/test/rewind-command.test.cjs` |
| 10,000 文件性能基准 | `plugins/dsh-desktop-settings/test/bench-10000.test.cjs` |
| 阶段 0 调研 | `docs/REWIND-RESEARCH.md` |

## 生效与验证

- 宿主插件改动需要**重启桌面端**（或重启 harness）。
- Web UI 改动刷新页面（F5）。
- 运行单测：

```powershell
runtime\node.exe --test plugins\dsh-desktop-settings\test\checkpoints.test.cjs
runtime\node.exe --test plugins\dsh-desktop-settings\test\rewind-command.test.cjs
```

- 运行性能基准（10,000 文件，约 3 分钟）：

```powershell
runtime\node.exe --test plugins\dsh-desktop-settings\test\bench-10000.test.cjs
```

## 性能基准（2026-08-16 实测）

10,000 个文件（10 目录 × 1000），改动 2000 / 新建 500 / 删除 500：

| 阶段 | 实测耗时 |
| --- | --- |
| 创建检查点（文件复制快照） | 24.5s |
| 差异预览（10,000 文件全量清单 + 3,000 差异） | 19.0s |
| 执行回滚（保护检查点 + 恢复 + 清理） | 135.3s |
| 全链路 | 178.8s |

阈值按宽松防退化设置（每阶段 180s）；Git 仓库下快照走 `write-tree`，通常远快于文件复制。

## v1 已知边界

- 元数据为 JSON 原子文件，未用 SQLite（规格允许的 v1 偏差，后续可迁移）。
- 超大二进制差异只给大小/状态，不给逐行 patch（有 512KB 上限）。
- `/rewind` 执行类命令依赖桌面端 Electron 桥（`window.dshDesktop` + `/enh/rewind-pending`）；纯 CLI `dsh web` 下 `list`/`preview` 可用，`<id>`/`guard` 只生成计划文本、不自动恢复文件（避免只恢复文件不截断对话的半联动）。
