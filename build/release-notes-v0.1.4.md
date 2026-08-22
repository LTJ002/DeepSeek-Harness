# DeepSeek Harness 0.1.4

[English](https://github.com/LTJ002/DeepSeek-Harness/blob/main/docs/README.md) | [中文](https://github.com/LTJ002/DeepSeek-Harness/blob/main/docs/README.zh.md)

## 更新日志（v0.1.4 · 2026-08-22）

· 插件更新检测多来源支持：github: / git+ssh / git+https / tar.gz 归档全部可检测（此前 github: 源误判为 npm 查询失败）；GitHub 改用 Atom feed 检测，不再受 API 限流 403 影响
· 插件更新按钮修复：preload 补齐 pluginUpdateCheck 桥接，检测结果正常推送前端（此前按钮永不显示）；git 源检测 6 秒快速超时、检查中自动重试、首次检查提前至启动 5 秒
· 新增「全部更新」按钮：可更新卡片上一键串行更新全部插件（单个更新仍在已安装页）
· 更新失败回滚优化：更新插件失败时恢复更新前的原版本（此前直接卸载整个插件）；新装失败仍为卸载清理
· 插件市场已安装识别修复：GitHub 标签与 npm 包名大小写/前缀差异（Anionex/dsh-vision-toolkit ↔ @anionex/dsh-vision-toolkit）归一化匹配，已安装正确显示「已安装」
· 禁用管理优化：恢复仅撤销禁用状态、不再自动重新下载；市场被禁用插件显示「已禁用」，恢复统一在「禁用」页
· 已安装页依赖名可点击：GitHub 源跳仓库、npm 源跳 npmjs 包页
· 移除「软件更新」页冗余的视觉 API 密钥入口——视觉工具自带设置页完整配置（API 地址/模型/密钥保存）
· 打包/部署一致性：打包流程固化 no-console 补丁（黑窗口修复 + 启动自愈），源码打包→安装→启动与部署版逐字节一致
· harness 内核与依赖对齐 0.1.1-rc.2（package.json/锁文件/node_modules 与部署版一致）；清理旧版残留（lib.rc6/嵌套目录）与冗余备份目录
· 版本号统一为 0.1.4（内置 asar 与 exe 元数据同步）
· 内核更新（0.1.1-rc.1）：DeepSeek 适配器新增多模态视觉模型 DeepSeek-V4-Flash-Vision-Exp；修复输入框 @ 引用前编辑的布局问题、Bubblewrap 沙箱受限进程可经 /proc/<pid>/root 绕过限制的漏洞；优化会话 Markdown 表格自适应、99.x% 缓存命中率精度显示、子代理会话标题切换；ask_user_question 支持多行输入与 Shift+Enter 换行
· 内核更新（0.1.1-rc.2）：DeepSeek 适配器优先通过 Files API 上传图像并可复用已上传文件；图像预处理按模型要求自动缩放并转换格式

## Assets

- `DeepSeek Harness Setup 0.1.4.exe` — Installer
- `DeepSeek Harness 0.1.4 Portable.exe` — Portable
