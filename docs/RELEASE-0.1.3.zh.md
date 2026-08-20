# DeepSeek Harness Desktop 0.1.3 更新内容

[English Release Notes](https://github.com/LTJ002/DeepSeek-Harness/releases/tag/v0.1.3) | 中文

---

## 0.1.3 更新内容

- **内核升级 0.1.0-rc.8** — 增强多模态支持（DeepSeek 原生图片请求、`/goal`、`/plan` 图文输入、@ 菜单引用文件和会话）；Claude Code 与 Codex 子代理可按需安装为 Profile Bundle（Codex 支持非交互权限模式与多命名实例）；Windows PTY 持久 PowerShell 会话；修复图片载荷过大导致模型请求失败、取消流式生成后回复前缀丢失、OpenAI 兼容网关调用失败；优化 web_search 并发、子代理报告及时唤醒、SQLite 读写与分叉性能（存储格式不兼容）
- **窗口假死修复** — 内核重启换端口后窗口不再停在旧地址灰屏卡死，主进程自动重连新端口（10 秒防抖），无需手动重启
- **启动变慢修复** — 安装失败的默认插件不再每次启动重装（失败标记 + 延迟到启动完成后），冷启动明显提速
- **离线预装插件** — 默认插件随安装包内置（preloaded-plugins），全新安装免联网、首次启动更快
- **托盘图标修复** — 二值化透明通道图标（16x16/32x32 @2x），去除四角黑边，按 DPI 自动选高清
- **插件日志体验优化** — 日志自动收起窗口由 5 分钟缩短至 60 秒；「链接/命令安装」与「已安装」页新增「清除日志」按钮
- **内置更新日志** — 0.1.3 更新内容可在设置页内查看

## 下载

- `DeepSeek.Harness.0.1.3.Setup.exe` — 安装版（安装到自定义目录，创建开始菜单/桌面快捷方式，自动添加 Defender 排除，静默）
- `DeepSeek.Harness.0.1.3.Portable.exe` — 便携版（解压到 exe 旁 `app\` 目录，版本不符自动重新解压）