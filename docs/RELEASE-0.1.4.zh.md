# DeepSeek Harness 桌面版 0.1.4

[English Release Notes](https://github.com/LTJ002/DeepSeek-Harness/releases/tag/v0.1.4) | 中文

---
## 0.1.4 更新内容

- **多源更新检测与按钮修复** — 插件更新检测现已支持 GitHub（github:）、git+ssh、git+https 及 tar.gz 归档；GitHub 改用 Atom 订阅源规避 API 速率限制；更新按钮已修复（补齐 preload 桥接），检测结果正常推送至 UI，并具备 6 秒快速超时与自动重试；首次检查提前至启动后 5 秒执行。

- **“全部更新”按钮与失败回滚** — 可更新卡片上新增“全部更新”按钮，可一键串行更新全部插件（单插件更新仍在已安装页）；更新失败时自动回退至前一版本（不再直接卸载），新装失败仍执行清理卸载。

- **市场已安装识别与禁用管理优化** — 已安装状态识别改进，可处理大小写及前缀差异（如 Anionex/… 与 @anionex/… 归一化匹配），正确显示“已安装”；禁用管理精细化：恢复仅撤销禁用状态（不再自动重下），市场中禁用插件显示“已禁用”，统一在“禁用”页恢复启用。

- **依赖链接与界面清理** — 已安装页依赖名可点击：GitHub 源跳转仓库，npm 源跳转 npmjs 包页；移除“软件更新”页冗余的视觉 API 密钥入口——视觉工具已自带独立设置页，可完整配置 API 地址、模型与密钥保存。

- **打包与部署一致性** — 打包流程固化 no-console 补丁（修复黑窗口 + 启动自愈），源码打包→安装→启动与部署版逐字节一致；harness 内核与依赖对齐 0.1.1-rc.2，清理旧版残留（lib.rc6/嵌套目录）与冗余备份目录；版本号统一为 0.1.4（asar 与 exe 元数据同步）。

- **内核升级至 0.1.1-rc.2** — 聚合 rc.1 与 rc.2 变更：DeepSeek 适配器新增多模态视觉模型 DeepSeek-V4-Flash-Vision-Exp；修复输入框 @ 引用前编辑的布局问题，并修补 Bubblewrap 沙箱绕过漏洞；优化会话 Markdown 表格自适应、99.x% 缓存命中率精度显示、子代理会话标题切换；ask_user_question 支持多行输入与 Shift+Enter 换行；DeepSeek 优先通过 Files API 上传图像并复用已上传文件，图像预处理按模型要求自动缩放与格式转换。

## 下载

- `DeepSeek.Harness.0.1.4.Setup.exe` — 安装版（安装到自定义目录，创建开始菜单/桌面快捷方式，自动添加 Defender 排除，静默）
- `DeepSeek.Harness.0.1.4.Portable.exe` — 便携版（解压到 exe 旁 `app\` 目录，版本不符自动重新解压）
