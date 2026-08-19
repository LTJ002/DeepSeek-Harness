# 对话与文件联动回滚 — 阶段 0 调研报告（DSH 0.1.0-rc.6）

结论日期：2026-08。调研对象：本机安装的 `@deepseek-ai/dsh@0.1.0-rc.6`（`harness/` 内完整源码）与桌面端 `dsh-desktop` 集成代码。

## 1. 插件框架

- DSH 使用 **Cordis**（`@deepseek-ai/cordis`，本机随包版本 0.1.x）。
- 插件通过 `package.json` 的 `dsh.bundle.patch` 进入 profile 组合；宿主半声明 `export function apply(ctx)` / `export const inject`。
- `ctx.on(name, listener, options)` 支持 `{ prepend: true }`，可在既有监听器之前插入。
- 事件总线语义：`waterfall(...)` 会把 `next` 作为最后一个参数追加给监听器；监听器自行决定是否调用 `next()`。因此在 `fs/write-intent` 这类 waterfall 上用 `prepend` 才能保证在 fs-observation-policy 之前执行。

## 2. 可用事件（本实现实际采用）

| 事件 | 负载 | 用途 |
| --- | --- | --- |
| `session/event` | `(session, event)` | 监听 `agent/inbox/spliced`（用户消息被接受）登记待建检查点；session 可取得 `id` / `meta.cwd` |
| `tools/execute` | `(exec, next)` | **任意工具执行前**（prepend）。exec 含 `name`、`agent`（可回溯 `agent.session`）。此处确保检查点已建立，失败抛错即阻断工具链 |
| `fs/write-intent` | `(target, actor[, next])` waterfall | write 工具走此事件；本实现没有单独挂它，因为 `tools/execute` 覆盖更广（bash/pwsh 等 shell 写入不经过 fs 事件） |
| `fs/edit-intent` | `(target, actor[, next])` waterfall | edit / str_replace 的版本校验点（同上，由 tools/execute 覆盖） |
| `tools/post-execute` | `(exec, result, next)` | 后续可用于“写入后增量记录” |

**关键结论**：`tools/execute` + `prepend` 是唯一能覆盖“用户消息接受后、Agent 任何工具执行前”的阻塞点，也是满足“检查点创建失败则禁止文件写入”的正交点。

## 3. 对话存储与消息/轮次映射

- 持久化：`~/.dsh/sessions/<项目key>/<session-id>/session.jsonl.zstd`。
- 物理格式：首帧 = header JSONL（`type:"session"`, `id`, `cwd`, `createdAt`...），后续帧为 zstd(JSONL 事件批次)。
- 用户消息：`agent/inbox/spliced` 行，`data.inserted[]` 是插入的消息，消息 `id` 位于 `inserted[i].id`。
- 消息呈现：`user/message` 行，`data.id === 消息 ID`。
- 轮次：`turn/start` / `turn/end`；工具调用 `tool/call` / `tool/result` 行内含 `data.name`（write / edit / str_replace_editor / bash / pwsh ...）。
- 桌面端已有“按消息 ID 截断会话日志”的能力：定位该消息之前最近一条 `agent/inbox/spliced`，把文件截到该行（可选保留该行）。

## 4. 工具执行链路

- `write`：`dsh-tool-fs` 内 `ctx.waterfall("fs/write-intent", target, exec, () => void 0)` → `ctx.fs.writeText(...)`。
- `edit` / `str_replace_editor`：走 `fs/edit-intent`，要求先 `read`（未观察会拒绝）。
- `bash` / `pwsh` 等 shell 工具绕过 fs 事件 → 再次确认必须挂 `tools/execute`。

## 5. UI 形态

- 本项目 UI 是 **Web GUI**（Electron 包装 `dsh web`）。
- 客户端插件通过 `window.__ModuleLoader__.load` 注入；设置页分区通过 `settings.section` 插槽注册。
- v1 交互选择：设置页“对话回滚”分区内提供 **检查点列表 + 差异预览 + 确认执行 + 撤销**；勾选“至少支持一种交互方式”。
- 已补齐全部交互入口：每条用户消息旁“回滚到此消息”按钮、`/rewind` 命令（list / preview / step N / guard / 直接回滚）、输入框为空时双击 Esc 打开“对话回滚”分区。

## 6. 与规格的偏差（v1 记录）

1. 元数据用 `~/.dsh/checkpoints/index.json` + 原子写 + 锁文件，不用 SQLite（后续可换）。
2. 检查点“消息接受时立即创建”为异步尽力而为；强一致由 `tools/execute` 前的同步确认保证。
3. 对话回滚复用桌面端现有 session-log 截断实现（保留目标用户消息本体）。
4. Git 快照用临时 `GIT_INDEX_FILE` 完成 add/write-tree/commit-tree，不污染用户真实 index；恢复用临时 index + checkout-index，不用 `git clean`。
5. 文件复制快照默认排除 `.git`、`node_modules`、`.dsh`。
