// dsh-desktop-settings client half.
// Registers a "插件与 MCP" section inside the built-in Web Settings page.
window.__ModuleLoader__.load({
  id: "dsh-desktop-settings",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const jsx = jsxRuntime.jsx;
    const { useState, useEffect, useDeferredValue } = react;

    const inject = ["slots", "locale"];

    // 中文/英文词典：key 即中文文案，避免大规模改写组件；t("中文") 在英文环境返回译文
    const NS = "dsh-desktop-settings";
    const zh = {};
    const en = {
      "插件与 MCP": "Plugins & MCP",
      "对话回滚": "Conversation Rollback",
      "删除对话": "Delete Sessions",
      "归档管理": "Archive Management",
      "更新": "Updates",
      "插件市场": "Plugin Market",
      "MCP 服务器": "MCP Servers",
      "已安装插件": "Installed Plugins",
      "搜索插件（名称 / 描述）": "Search plugins (name / description)",
      "全部": "All",
      "已安装依赖": "Installed Dependencies",
      "已启用的 Bundle 层": "Enabled Bundle Layers",
      "无": "None",
      "正在加载插件市场…": "Loading plugin market…",
      "加载失败：": "Load failed: ",
      "没有匹配的插件": "No matching plugins",
      "刷新失败（当前显示上次数据）：": "Refresh failed (showing previous data): ",
      "刷新中…": "Refreshing…",
      "刷新": "Refresh",
      "安装中…": "Installing…",
      "任务进行中…": "Task in progress…",
      "安装": "Install",
      "已安装": "Installed",
      "卸载": "Uninstall",
      "依赖": "Dependency",
      "正在检测…": "Detecting…",
      "检测失败：": "Detection failed: ",
      "当前 web 端未配置 MCP 服务器": "No MCP servers configured for the web profile",
      "可用": "Available",
      "可连接": "Reachable",
      "无法连接": "Unreachable",
      "命令未找到": "Command not found",
      "插件变更完成，重启后生效": "Plugin changes will take effect after restart",
      "重启应用": "Restart App",
      "可回滚的会话": "Rollbackable Sessions",
      "选择会话回滚最后一轮：撤销 edit 修改、移除本轮新建文件，完成后自动刷新会话。": "Roll back the latest turn of a session: revert file edits and remove files created this turn, then refresh automatically.",
      "回滚": "Rollback",
      "回滚中…": "Rolling back…",
      "正在回滚…": "Rolling back…",
      "没有可回滚的会话": "No rollbackable sessions",
      "正在扫描会话…": "Scanning sessions…",
      "扫描失败：": "Scan failed: ",
      "文件检查点（对话与文件联动回滚）": "File Checkpoints (conversation + file rollback)",
      "每条用户消息在工具执行前自动建立检查点。预览差异 → 确认 → 恢复文件并回滚对话；执行前会自动创建可撤销的保护检查点。": "A checkpoint is created automatically before tools run for each user message. Preview the diff, confirm, then restore files and roll back the conversation; a restorable guard checkpoint is created before execution.",
      "预览": "Preview",
      "撤销上次回滚": "Undo Last Rollback",
      "没有可用的保护检查点": "No guard checkpoint available",
      "预览失败：": "Preview failed: ",
      "暂无检查点（发送消息后自动生成）": "No checkpoints yet (created automatically after sending a message)",
      "正在读取检查点…": "Loading checkpoints…",
      "读取失败：": "Load failed: ",
      "回滚计划": "Rollback Plan",
      "取消": "Cancel",
      "确认回滚": "Confirm Rollback",
      "正在生成回滚计划…": "Generating rollback plan…",
      "删除": "Delete",
      "删除中…": "Deleting…",
      "正在删除…": "Deleting…",
      "删除整个会话：记录会移入桌面版数据目录的 sessions-trash 回收目录，不会直接抹除。": "Delete the whole session: records are moved to the sessions-trash recycle folder in the desktop data directory.",
      "没有会话": "No sessions",
      "回收站": "Recycle Bin",
      "可恢复或彻底删除已归档会话，也可打开回收站文件夹手动清理。": "Restore or permanently delete archived sessions, or open the trash folder to clean manually.",
      "打开文件夹": "Open Folder",
      "彻底删除": "Delete Permanently",
      "恢复": "Restore",
      "恢复中…": "Restoring…",
      "正在恢复…": "Restoring…",
      "没有已删除的会话": "No deleted sessions",
      "归档时间：": "Trashed: ",
      "后台任务": "Background Jobs",
      "安装/卸载正在后台运行，关闭设置页也不会中断。": "Install/uninstall is running in the background; closing this page will not interrupt it.",
      "软件更新": "Software Updates",
      "检查官方 GitHub Releases 是否有新版本安装包。有新版本时可下载并启动安装（配置与会话保留在 ~/.dsh）。": "Check GitHub Releases for a newer installer. When available, download and run it (config and sessions are kept in ~/.dsh).",
      "更新日志": "Changelog",
      "检查更新": "Check for Updates",
      "查询中…": "Checking…",
      "正在查询…": "Checking…",
      "有 {n} 个插件可更新": "There {n, plural, =1{is 1 plugin update available} other{are # plugin updates available}}",
      "重新检查": "Recheck",
      "已装 {from} → {to}（{source}）": "Installed {from} → {to} ({source})",
      "视觉模型 API 密钥": "Vision Model API Key",
      "视觉 API 密钥": "Vision API Key",
      "粘贴视觉模型 API 密钥并保存。若未配置，使用视觉工具时会提示。": "Paste the vision model API key and save. If not configured, you will be prompted when using vision tools.",
      "保存": "Save",
      "保存中…": "Saving…",
      "收起": "Collapse"
    };
    for (const key of Object.keys(en)) zh[key] = key;

    const S = {
      wrap: { display: "flex", flexDirection: "column", gap: 12, fontSize: 14, color: "var(--dsw-alias-label-primary, #0f1115)" },
      nav: { display: "flex", gap: 6, flexWrap: "wrap" },
      navBtn: (active) => ({
        border: "1px solid " + (active ? "transparent" : "var(--dsw-alias-border-l2, #d5d8df)"),
        background: active ? "var(--dsw-specific-sidebar-nav-item-active, #eef1f4)" : "transparent",
        color: active ? "var(--dsw-alias-label-primary, #0f1115)" : "var(--dsw-alias-label-secondary, #4b5563)",
        padding: "6px 13px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: active ? 500 : 400
      }),
      chip: (active) => ({
        border: "1px solid " + (active ? "transparent" : "var(--dsw-alias-border-l2, #d5d8df)"),
        background: active ? "var(--dsw-specific-sidebar-nav-item-active, #eef1f4)" : "transparent",
        color: active ? "var(--dsw-alias-label-primary, #0f1115)" : "var(--dsw-alias-label-secondary, #4b5563)",
        padding: "4px 11px", borderRadius: 999, cursor: "pointer", fontSize: 12.5, lineHeight: 1.4, fontWeight: active ? 600 : 400
      }),
      chips: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10, marginBottom: 4 },
      btn: { border: "1px solid var(--dsw-alias-border-l2, #d5d8df)", background: "var(--dsw-specific-input-major, #fff)", color: "var(--dsw-alias-label-primary, #0f1115)", padding: "6px 12px", borderRadius: 7, cursor: "pointer", fontSize: 13 },
      btnSmall: { border: "1px solid var(--dsw-alias-border-l2, #d5d8df)", background: "var(--dsw-specific-input-major, #fff)", color: "var(--dsw-alias-label-primary, #0f1115)", padding: "3px 9px", borderRadius: 6, cursor: "pointer", fontSize: 12 },
      input: { flex: 1, minWidth: 140, border: "1px solid var(--dsw-alias-border-l2, #d5d8df)", background: "var(--dsw-specific-input-major, #fff)", color: "var(--dsw-alias-label-primary, #0f1115)", borderRadius: 8, padding: "8px 10px", fontSize: 13, outline: "none" },
      cat: { fontSize: 14, fontWeight: 600, color: "var(--dsw-alias-label-tertiary, #81858c)", margin: "12px 0 6px" },
      card: { border: "1px solid var(--dsw-alias-border-l2, #ececf0)", background: "var(--dsw-alias-bg-layer-1, transparent)", borderRadius: 12, padding: "12px 14px", marginBottom: 8, contentVisibility: "auto", containIntrinsicSize: "auto 84px" },
      name: { fontFamily: "Consolas, monospace", fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary, #0f1115)" },
      badge: (bad) => ({ borderRadius: 6, padding: "3px 9px", fontSize: 12.5, whiteSpace: "nowrap", background: bad === "bad" ? "var(--dsw-alias-state-error-tertiary, #fdecec)" : bad === "warn" ? "var(--dsw-alias-state-warn-tertiary, #fdf3e7)" : "var(--dsw-alias-interactive-bg-hover, #eef1f4)", color: bad === "bad" ? "var(--dsw-alias-state-error-primary, #dc2626)" : bad === "warn" ? "var(--dsw-alias-state-warn-primary, #b45309)" : "var(--dsw-alias-label-primary, #0f1115)" }),
      mono: { fontFamily: "Consolas, monospace", fontSize: 13, color: "var(--dsw-alias-label-secondary, #4b5563)", wordBreak: "break-all", whiteSpace: "pre-wrap", marginTop: 6, lineHeight: 1.7 },
      desc: { color: "var(--dsw-alias-label-secondary, #4b5563)", fontSize: 13, marginTop: 6, lineHeight: 1.7 },
      status: { color: "var(--dsw-alias-label-tertiary, #81858c)", fontSize: 12, marginTop: 6 },
      h2: { fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary, #0f1115)", lineHeight: 1.5 },
      rollbackHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 },
      empty: { color: "var(--dsw-alias-label-tertiary, #81858c)", textAlign: "center", padding: "24px 0", fontSize: 13 },
      row: { display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" },
      sub: { color: "var(--dsw-alias-label-tertiary, #81858c)", fontSize: 13 },
      pre: { background: "var(--dsw-alias-markdown-code-block, #f6f7f9)", border: "1px solid var(--dsw-alias-border-l2, #ececf0)", color: "var(--dsw-alias-label-primary, #0f1115)", borderRadius: 10, padding: 10, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 220, overflow: "auto" },
      li: { display: "flex", justifyContent: "space-between", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--dsw-alias-border-l2, #ececf0)", fontSize: 14 },
      liName: { fontFamily: "Consolas, monospace", fontWeight: 600, fontSize: 14, color: "var(--dsw-alias-label-primary, #0f1115)" }
    };

    function esc(s) {
      return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    // “侧边卡片”设置里的功能卡片（资源管理器/终端等）：启用态用黑白灰主题的强选中态，
    // 黑边框 + 深灰底 + 左侧黑色竖条 + 反黑图标块，一眼可辨且不与整体配色冲突。
    function installSideCardStyle() {
      if (typeof document === "undefined" || document.getElementById("dsh-desktop-sidecard-style")) return;
      const tag = document.createElement("style");
      tag.id = "dsh-desktop-sidecard-style";
      tag.textContent = [
        "._8F0CBq_cardOn{border-color:rgba(15,17,21,.75)!important;background:#eef1f4!important;box-shadow:inset 0 0 0 1px rgba(15,17,21,.12)!important;position:relative!important}",
        "._8F0CBq_cardOn::before{content:'';position:absolute;left:-1px;top:10px;bottom:10px;width:3px;border-radius:2px;background:#0f1115}",
        "._8F0CBq_cardOn ._8F0CBq_cardIconChip{border-color:#0f1115!important;background:#0f1115!important;color:#ffffff!important}",
        "._8F0CBq_cardCheck{display:none!important}",
        "._8F0CBq_cardOn ._8F0CBq_cardDesc{color:#4b5563!important}"
      ].join("");
      document.head.appendChild(tag);
    }
    installSideCardStyle();

    // ---------- /rewind 命令交棒 ----------
    // 宿主 /rewind 只做只读计划；这里拉取 pending 动作，交给 Electron 主进程完成
    // “恢复文件 → 截断会话 → 刷新页面”的原子联动（签名保证预览后变化即失效）。
    function installRewindCommandBridge(ctx) {
      return ctx.on("command/executed", (sessionId, commandName, result) => {
        if (commandName !== "rewind" || !result || result.kind !== "success") return;
        const api = window.dshDesktop;
        if (!api || typeof api.rewindExecute !== "function") return;
        let timer = null;
        try {
          const controller = typeof AbortController === "function" ? new AbortController() : null;
          timer = setTimeout(() => { if (controller) controller.abort(); }, 5000);
          fetch("/enh/rewind-pending", { headers: { accept: "application/json" }, signal: controller ? controller.signal : undefined })
            .then((r) => r.json())
            .then(async (body) => {
              if (timer) clearTimeout(timer);
              const action = body && body.action;
              if (!action) return;
              if (action.undo) {
                const r = await api.rewindUndo(action.undo);
                if (!r || !r.ok) window.alert("撤销回滚失败：" + (r && r.msg ? r.msg : "未知错误"));
                return;
              }
              if (typeof action.id === "string" && typeof action.signature === "string") {
                const r = await api.rewindExecute(action.id, action.signature);
                if (r && r.ok) {
                  if (typeof api.reloadHarness === "function") await api.reloadHarness();
                } else {
                  window.alert("回滚失败：" + (r && r.msg ? r.msg : "未知错误"));
                }
              }
            })
            .catch(() => { if (timer) clearTimeout(timer); });
        } catch { if (timer) clearTimeout(timer); }
      });
    }

    // ---------- 输入框为空时双击 Esc：打开 Web 设置页的“对话回滚”分区 ----------
    function installDoubleEscShortcut() {
      let lastEscAt = 0;
      const isEditable = (el) => !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable === true);
      const isEmpty = (el) => el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? !String(el.value || "").trim() : !String(el.textContent || "").trim();
      function openRollbackSettings() {
        try {
          const trigger = Array.from(document.querySelectorAll('button[aria-haspopup="dialog"]'))
            .find((b) => b.getAttribute("aria-expanded") !== null);
          if (trigger && trigger.getAttribute("aria-expanded") !== "true") trigger.click();
          const tryClickSection = () => {
            const panel = document.querySelector('[role="dialog"][aria-modal="true"]');
            if (!panel) return false;
            const navButton = Array.from(panel.querySelectorAll("nav button"))
              .find((b) => ["归档管理", "Archive Management"].some((name) => (b.textContent || "").includes(name)));
            if (!navButton) return false;
            navButton.click();
            return true;
          };
          if (!tryClickSection()) {
            let attempts = 0;
            const interval = setInterval(() => { if (tryClickSection() || ++attempts > 20) clearInterval(interval); }, 100);
          }
        } catch {}
      }
      function onKeyDown(event) {
        if (event.key !== "Escape") return;
        const el = event.target;
        if (!isEditable(el) || !isEmpty(el)) return;
        const now = Date.now();
        if (now - lastEscAt > 0 && now - lastEscAt <= 800) {
          lastEscAt = 0;
          openRollbackSettings();
        } else {
          lastEscAt = now;
        }
      }
      document.addEventListener("keydown", onKeyDown, true);
      return () => document.removeEventListener("keydown", onKeyDown, true);
    }

    // ---------- 回滚成功后把被撤销的消息回填到输入框 ----------
    // 主进程在刷新前把消息文本写入 localStorage，这里在页面重新挂载后读取并写回 composer textarea。
    function installRollbackMessageRestore() {
      const restore = () => {
        try {
          const key = "dsh-rollback-last-message";
          const at = Number(window.localStorage.getItem("dsh-rollback-last-message-at") || 0);
          const text = window.localStorage.getItem(key) || "";
          if (!text || Date.now() - at > 60 * 1000) { window.localStorage.removeItem(key); window.localStorage.removeItem("dsh-rollback-last-message-at"); return; }
          window.localStorage.removeItem(key);
          window.localStorage.removeItem("dsh-rollback-last-message-at");
          const setInput = () => {
            const el = document.querySelector('textarea[data-phase]');
            if (!el) return false;
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
            if (setter) setter.call(el, text); else el.value = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            try { el.focus(); } catch {}
            return true;
          };
          if (setInput()) return;
          let attempts = 0;
          const iv = setInterval(() => { if (setInput() || ++attempts > 50) clearInterval(iv); }, 100);
        } catch {}
      };
      const t1 = setTimeout(restore, 700);
      const t2 = setTimeout(restore, 2600); // 页面较慢时二次兜底
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }

    function installPluginJobNotifier() {
      if (typeof window === "undefined" || !window.dshDesktop?.pluginJobStatus) return () => {};
      // 页面加载时间：装后验证/热更新会重载页面，事件监听器随之销毁；
      // 用该时间窗判断"本次会话刚完成的任务"（5 分钟内开始，覆盖长安装），重载后补弹 toast
      const PAGE_LOAD_TIME = Date.now();
      const seen = new Map();
      // 悬浮任务面板：右下角显示安装/卸载任务实时状态与日志
      // 显示条件：有运行中任务，或任务完成/失败后 30 秒内；无任务自动隐藏
      const currentJobs = new Map();
      let panelEl = null;
      const renderPanel = () => {
        try {
          if (!document.body) { setTimeout(renderPanel, 500); return; }
          const now = Date.now();
          const active = [...currentJobs.values()].filter((j) =>
            j.status === "running" || (now - (j.updatedAt || 0)) < 30000
          );
          if (!active.length) {
            if (panelEl) { panelEl.remove(); panelEl = null; }
            return;
          }
          // 用户手动关闭后：若无运行中任务，60 秒内不再弹面板；有新任务立即重新显示
          if (window.__dshPanelClosedAt && !active.some((j) => j.status === "running") && now - window.__dshPanelClosedAt < 60000) {
            if (panelEl) { panelEl.remove(); panelEl = null; }
            return;
          }
          if (!panelEl) {
            panelEl = document.createElement("div");
            panelEl.id = "dsh-task-panel";
            Object.assign(panelEl.style, {
              position: "fixed", right: "16px", bottom: "16px", zIndex: 2147483646,
              width: "340px", maxHeight: "280px", overflowY: "auto",
              padding: "10px 14px", borderRadius: "12px", fontSize: "13px",
              boxShadow: "0 8px 24px rgba(0,0,0,.14), 0 2px 6px rgba(0,0,0,.08)",
              border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
              background: "var(--dsw-specific-menu, #ffffff)",
              color: "var(--dsw-alias-label-primary, #111827)",
              fontFamily: "var(--dsw-font-family, 'Segoe UI', system-ui, sans-serif)"
            });
            document.body.appendChild(panelEl);
            // 注入一次加载动画 keyframes
            if (!document.getElementById("dsh-panel-style")) {
              const st = document.createElement("style");
              st.id = "dsh-panel-style";
              st.textContent = "@keyframes dshSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}.dsh-spin{display:inline-block;animation:dshSpin 1s linear infinite}";
              document.head.appendChild(st);
            }
          }
          // 重建前记录日志滚动位置：用户未手动上翻（在底部）→ 新日志自动跟随；手动上翻 → 保持原位
          const oldPres = panelEl ? [...panelEl.querySelectorAll("pre")] : [];
          const prevLogScroll = oldPres.map((p) => ({
            atBottom: p.scrollHeight - p.scrollTop - p.clientHeight < 30,
            top: p.scrollTop
          }));
          panelEl.innerHTML = active.map((job, idx) => {
            const modeText = job.mode === "add" ? "安装" : "卸载";
            const running = job.status === "running";
            const color = job.status === "done" ? "#16a34a" : job.status === "error" ? "#dc2626" : "#2563eb";
            const icon = job.status === "done" ? "✓" : job.status === "error" ? "✕" : "⟳";
            const statusText = running ? (job.stage || "进行中…") : (job.status === "done" ? "完成" : "失败");
            const logPreview = String(job.log || "").split("\n").filter(Boolean).slice(-30).join("\n");
            const iconHtml = running ? `<span class="dsh-spin" style="color:${color}">⟳</span>` : `<span style="color:${color}">${icon}</span>`;
            return `<div style="padding:6px 0;border-bottom:1px solid rgba(128,128,128,.15)"><div style="font-weight:600">${iconHtml} ${modeText} ${esc(job.pkg)} <span style="color:${color};font-weight:500">${esc(statusText)}</span></div>${logPreview ? `<pre data-log-idx="${idx}" style="margin:4px 0 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#4b5563);white-space:pre-wrap;max-height:140px;overflow-y:auto">${esc(logPreview)}</pre>` : ""}</div>`;
          }).join("");
          // 恢复滚动位置：按索引对应
          const newPres = [...panelEl.querySelectorAll("pre")];
          newPres.forEach((p) => {
            const st = prevLogScroll[Number(p.getAttribute("data-log-idx") || 0)];
            if (st) {
              if (st.atBottom) p.scrollTop = p.scrollHeight;
              else p.scrollTop = st.top;
            } else {
              p.scrollTop = p.scrollHeight;
            }
          });
          // 面板头部：标题 + 手动关闭叉号（点击后 60 秒内不再自动弹出，有新任务立即恢复）
          const header = `<div style="display:flex;align-items:center;justify-content:space-between;position:sticky;top:-10px;background:inherit;padding:2px 0 6px;margin:-4px 0 2px"><span style="font-weight:600;font-size:12px;color:var(--dsw-alias-label-secondary,#4b5563)">插件任务</span><button onclick="window.__dshPanelClosedAt=Date.now();var el=document.getElementById('dsh-task-panel');if(el)el.remove()" style="border:none;background:transparent;cursor:pointer;font-size:14px;line-height:1;color:var(--dsw-alias-label-secondary,#4b5563);padding:2px 4px">✕</button></div>`;
          panelEl.insertAdjacentHTML("afterbegin", header);
        } catch {}
      };
      const showToast = (job) => {
        try {
          // 完成/失败提示音：成功两音上升，失败两音下降（Web Audio 生成，无需音频文件）
          try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) {
              const actx = new Ctx();
              const tone = (freq, delay, dur) => {
                const o = actx.createOscillator();
                const g = actx.createGain();
                o.type = "sine";
                o.frequency.value = freq;
                const t = actx.currentTime + delay;
                g.gain.setValueAtTime(0.0001, t);
                g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
                g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
                o.connect(g);
                g.connect(actx.destination);
                o.start(t);
                o.stop(t + dur + 0.05);
              };
              if (job.status === "done") { tone(880, 0, 0.15); tone(1318, 0.16, 0.22); }
              else { tone(392, 0, 0.2); tone(311, 0.22, 0.3); }
              setTimeout(() => { try { actx.close(); } catch {} }, 2000);
            }
          } catch {}
          // 右上角固定 toast（不跟随齿轮：设置入口在侧边栏底部左侧，跟随会跑到左下）。
          const el = document.createElement("div");
          Object.assign(el.style, {
            position: "fixed",
            top: "16px",
            right: "16px",
            zIndex: 2147483647,
            minWidth: "220px",
            maxWidth: "360px",
            padding: "12px 16px",
            borderRadius: "12px",
            fontSize: "13px",
            lineHeight: "20px",
            boxShadow: "0 8px 24px rgba(0,0,0,.14), 0 2px 6px rgba(0,0,0,.08)",
            border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
            background: "var(--dsw-specific-menu, #ffffff)",
            color: "var(--dsw-alias-label-primary, #111827)",
            display: "flex",
            alignItems: "flex-start",
            gap: "10px",
            pointerEvents: "auto",
            fontFamily: "var(--dsw-font-family, 'Segoe UI', system-ui, sans-serif)"
          });
          const modeText = job.mode === "add" ? "插件安装" : "插件卸载";
          const statusText = job.status === "done" ? "完成" : "失败";
          const color = job.status === "done" ? "#16a34a" : "#dc2626";
          const icon = job.status === "done" ? "✓" : "✕";
          // 合并重启提示：bundle 插件变更后，安装/卸载完成弹框内直接提供“重启应用”按钮
          const restartBtn = job.needRestart
            ? `<button style="margin-top:6px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-specific-input-major,#fff);color:var(--dsw-alias-label-primary,#111827);padding:4px 12px;border-radius:7px;cursor:pointer;font-size:12px;display:block" onclick="window.dshDesktop && window.dshDesktop.restart && window.dshDesktop.restart()">重启应用</button>`
            : "";
          el.innerHTML = `<span style="flex:none;width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;background:${color};line-height:1">${icon}</span><span style="min-width:0;flex:1"><span style="display:block;font-weight:600">${modeText}<span style="color:${color};margin-left:6px;font-weight:500">${statusText}</span></span><span style="display:block;color:var(--dsw-alias-label-secondary,#4b5563);word-break:break-all;margin-top:2px">${esc(job.pkg)}</span>${restartBtn}</span>`;
          // body 未就绪时（页面刚重载）等待后重试，避免 appendChild 抛错导致 toast 丢失
          const appendToast = () => {
            try {
              if (!document.body) { setTimeout(appendToast, 500); return; }
              document.body.appendChild(el);
              setTimeout(() => el.remove(), 5000);
            } catch {}
          };
          appendToast();
        } catch {}
      };
      const poll = async () => {
        try {
          const jobs = await window.dshDesktop.pluginJobStatus();
          if (!Array.isArray(jobs)) return;
          const now = Date.now();
          for (const job of jobs) {
            currentJobs.set(job.id, { ...job, updatedAt: now });
            const prev = seen.get(job.id);
            if (prev === "running" && (job.status === "done" || job.status === "error")) showToast(job);
            else if (!prev && (job.status === "done" || job.status === "error") && job.startedAt && job.startedAt > PAGE_LOAD_TIME - 300000) {
              // 页面重载后补弹：任务在本页面加载前 5 分钟内开始且已完成（装后验证/热更新重载导致的）
              showToast(job);
              // 记录完整日志供设置页展示（AI 诊断过程等），并广播事件
              try {
                window.__dshLastJob = job;
                window.dispatchEvent(new Event("dsh:plugin-job-log"));
              } catch {}
            }
            seen.set(job.id, job.status);
          }
          const ids = new Set(jobs.map((j) => j.id));
          for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id);
          renderPanel();
        } catch {}
      };
      // 主进程任务完成事件（推荐）：任务完成/失败立即推送，不依赖轮询时序（快速任务也能弹）
      const onEvent = (job) => {
        if (!job) return;
        if (job.status !== "running" && !seen.has(job.id)) {
          seen.set(job.id, job.status);
          showToast(job);
        } else {
          seen.set(job.id, job.status);
        }
      };
      const offEvent = window.dshDesktop.onPluginJobEvent ? window.dshDesktop.onPluginJobEvent(onEvent) : null;
      poll();
      const iv = setInterval(poll, 2000);
      return () => { clearInterval(iv); if (typeof offEvent === "function") offEvent(); };
    }


    function DesktopSettingsSection({ t }) {
      const [tab, setTab] = useState("market");
      const [market, setMarket] = useState({ loading: true });
      const [marketRefreshing, setMarketRefreshing] = useState(false);
      const [mcp, setMcp] = useState({ loading: true });
      const [plugins, setPlugins] = useState({ dependencies: [], bundles: [] });
      const [pkg, setPkg] = useState("");
      const [busy, setBusy] = useState({});
      const [installing, setInstalling] = useState(false);
      const [installLog, setInstallLog] = useState("");
const [aiBusy, setAiBusy] = useState(false);
const [aiLog, setAiLog] = useState("");
const [lastFailed, setLastFailed] = useState(null);
const [uninstallingPkg, setUninstallingPkg] = useState(null);
      const [query, setQuery] = useState("");
      const deferredQuery = useDeferredValue(query); // 搜索框输入时延迟过滤，保持输入流畅
      const [catFilter, setCatFilter] = useState("全部");
      const [showRestart, setShowRestart] = useState(false);
      const [pluginJobs, setPluginJobs] = useState([]);
      const [pluginUpdates, setPluginUpdates] = useState(null);
      // 后台定期插件更新检查结果（main.js 每 24 小时自动检查，仅提示不自动安装）
      useEffect(() => {
        const api2 = window.dshDesktop;
        if (!api2 || typeof api2.pluginUpdateCheck !== 'function') return;
        let alive = true;
        api2.pluginUpdateCheck().then((r) => {
          if (alive && r && r.ok && Array.isArray(r.updates)) setPluginUpdates(r);
        }).catch(() => {});
        return () => { alive = false; };
      }, []);
      // 重启倒计时：插件变更后自动重启生效，可取消/立即重启
      const [restartCountdown, setRestartCountdown] = useState(null);
      const RESTART_COUNTDOWN_SECONDS = 10;
      useEffect(() => {
        if (!showRestart) { setRestartCountdown(null); return; }
        setRestartCountdown(RESTART_COUNTDOWN_SECONDS);
        const timer = setInterval(() => {
          setRestartCountdown((s) => {
            if (s === null) return s;
            if (s <= 1) { clearInterval(timer); setShowRestart(false); api.restart(); return 0; }
            return s - 1;
          });
        }, 1000);
        return () => clearInterval(timer);
      }, [showRestart]);
      function cancelRestart() { setShowRestart(false); setRestartCountdown(null); }

      const api = window.dshDesktop;

      // 插件市场：无感刷新——旧数据继续显示，新数据到后再替换；只在首次加载时显示占位。
      async function refreshMarket(force = false) {
        setMarketRefreshing(true);
        try {
          const data = await api.marketList(force === true);
          setMarket({ data });
        } catch (e) {
          setMarket((prev) => (prev && prev.data ? { ...prev, error: String(e && e.message || e) } : { error: String(e && e.message || e) }));
        } finally {
          setMarketRefreshing(false);
        }
      }
      async function refresh() {
        refreshMarket(false);
        try { setMcp({ data: await api.detectMcp() }); } catch (e) { setMcp({ error: String(e && e.message || e) }); }
        try { setPlugins(await api.listPlugins()); } catch (e) {}
      }
      useEffect(() => { refresh(); }, []);
      // 页面重载后恢复最近任务的完整日志（含 AI 诊断过程），避免回滚/刷新导致日志丢失
      useEffect(() => {
        const showJobLog = () => {
          try {
            const job = window.__dshLastJob;
            if (!job || !job.log) return;
            if (Date.now() - (job.startedAt || 0) > 300000) return;
            setInstallLog(`${job.mode === "add" ? "插件安装" : "插件卸载"} ${job.pkg}（${job.status === "done" ? "完成" : "失败"}）\n${job.log}`);
          } catch {}
        };
        window.addEventListener("dsh:plugin-job-log", showJobLog);
        showJobLog();
        return () => window.removeEventListener("dsh:plugin-job-log", showJobLog);
      }, []);
      // 后台安装/卸载任务轮询：关闭设置页再打开仍能看到任务进度，任务本身在主进程继续执行
      useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const jobs = await api.pluginJobStatus();
            if (alive) setPluginJobs(jobs || []);
          } catch {}
        };
        tick();
        const iv = setInterval(tick, 1500);
        return () => { alive = false; clearInterval(iv); };
      }, []);

      async function installRepo(repo, desc) {
        if (installing) return;
        setInstalling(true);
        setBusy((b) => ({ ...b, [repo]: "解析包名…" }));
        const specs = [];
        // 1) 描述里明确写了 npm 包名时优先使用
        const explicit = /npm\s+包名\s*[`：:]\s*([^\s`，。]+)/.exec(desc || "");
        if (explicit) specs.push(explicit[1]);
        // 2) 从 GitHub package.json 解析 npm 包名 + 分支
        let branch = null;
        try {
          const info = await api.resolvePlugin(repo);
          if (info && info.name) specs.push(info.name);
          if (info && info.branch) branch = info.branch;
        } catch {}
        // 3) GitHub-only 插件：HTTPS 归档直链（不走 SSH）
        if (branch) specs.push(`https://github.com/${repo}/archive/refs/heads/${branch}.tar.gz`);
        specs.push("github:" + repo);
        let last = null;
        try {
          for (const spec of [...new Set(specs)]) {
            try {
              setBusy((b) => ({ ...b, [repo]: `正在安装 ${spec}…` }));
              const r = await api.installPlugin(spec);
              if (r.ok) {
                setBusy((b) => ({ ...b, [repo]: `✔ ${spec} 安装完成` }));
                // 热更新：软刷新重启 harness + 页面，让插件（含修改 UI 的）立即生效，无需重启应用
                refresh();
                return;
              }
              last = r;
            } catch (e) { last = { ok: false, log: String(e && e.message || e) }; }
          }
          setBusy((b) => ({ ...b, [repo]: `✖ ${(last?.log || "").slice(-600)}` }));
          setLastFailed({ pkg: repo, type: "market" });
          aiInstallPkg(repo);
        } finally {
          setInstalling(false);
        }
        refresh();
      }
      // 解析安装输入：支持 npm 包名 / github:owner/repo / tar.gz 链接 / dsh plugin --profile web add <包名> 命令行
      function parseInstallSpec(input) {
        const s = String(input || "").trim();
        if (!s) return "";
        if (/dsh\s+plugin\b/i.test(s)) {
          const m = /\b(add|install)\b/.exec(s);
          if (m) {
            const tok = s.slice(m.index + m[0].length).trim().split(/\s+/).find((x) => x && !x.startsWith("-"));
            return tok || "";
          }
          return "";
        }
        return s;
      }
      async function installPkg() {
        const spec = parseInstallSpec(pkg);
        if (!spec || installing) return;
        setInstalling(true);
        setAiLog("");
        setLastFailed(null);
        setInstallLog(`$ pnpm add ${spec}\n`);
        try {
          const r = await api.installPlugin(spec);
          setInstallLog((l) => l + (r.log || "(无输出)") + (r.ok ? "\n✔ 安装完成" : "\n✖ 安装失败"));
          if (r.ok) { /* 后端已做装后验证并刷新 */ }
          else {
            setLastFailed({ pkg: spec, type: "manual" });
            setInstallLog((l) => l + "\n\n—— 正在自动启动 AI 诊断修复 ——");
            aiInstallPkg(spec);
          }
        } catch (e) {
          setInstallLog((l) => l + "\n✖ " + String(e && e.message || e));
          setLastFailed({ pkg: spec, type: "manual" });
          aiInstallPkg(spec);
        } finally {
          setInstalling(false);
        }
        refresh();
      }
      async function aiInstallPkg(targetOverride) {
        const target = targetOverride || lastFailed?.pkg || pkg.trim();
        if (!target || aiBusy) return;
        setAiBusy(true);
        setAiLog("AI 安装启动：正在请求当前 AI 服务分析失败原因…");
        try {
          const r = await api.aiInstallPlugin(target);
          setAiLog((r.log || "(无输出)") + (r.ok ? "\n✔ AI 安装完成" : "\n✖ AI 安装未成功"));
          if (r.ok) { /* 后端已做装后验证并刷新 */ }
        } catch (e) {
          setAiLog("✖ AI 安装调用失败：" + String(e && e.message || e));
        } finally {
          setAiBusy(false);
          refresh();
        }
      }
      async function uninstallPkg(dep, force) {
        if (installing) return;
        if (!window.confirm(`确定卸载 ${dep} 吗？`)) return;
        setInstalling(true);
        setUninstallingPkg(dep);
        setInstallLog(`$ pnpm remove ${dep}\n`);
        try {
          const r = await api.uninstallPlugin(dep, force === true);
          setInstallLog((l) => l + (r.log || "(无输出)") + (r.ok ? "\n✔ 卸载完成" : "\n✖ 卸载失败"));
          if (r.blocked && Array.isArray(r.dependents) && r.dependents.length) {
            setInstallLog((l) => l + "\n\n⚠ 检测到依赖，需确认是否强制卸载。");
            if (window.confirm(`以下已装插件依赖 ${dep}，卸载后将无法正常加载：\n\n${r.dependents.join("\n")}\n\n仍要强制卸载吗？（建议先卸载依赖方）`)) {
              setUninstallingPkg(dep);
              const r2 = await api.uninstallPlugin(dep, true);
              setInstallLog((l) => l + "\n" + (r2.log || "(无输出)") + (r2.ok ? "\n✔ 强制卸载完成" : "\n✖ 强制卸载失败"));
            } else {
              setInstallLog((l) => l + "\n已取消卸载（可先卸载依赖方：\n" + r.dependents.join("\n") + ")");
            }
          } else if (r.ok) {
            // 热更新：软刷新让插件移除生效，无需重启应用
            /* 后端已统一做卸载后软刷新 */
            setPlugins((p) => ({
              ...p,
              dependencies: (p.dependencies || []).filter((d) => d !== dep),
              bundles: (p.bundles || []).filter((b) => b !== dep)
            }));
          }
        } catch (e) {
          setInstallLog((l) => l + "\n✖ " + String(e && e.message || e));
        } finally {
          setInstalling(false);
          setUninstallingPkg(null);
        }
        refresh();
      }

      // 已安装且可更新的插件名集合（来自插件更新检查）
      const updatable = new Set((pluginUpdates && Array.isArray(pluginUpdates.updates) ? pluginUpdates.updates : [])
        .filter((u) => u.updateAvailable).map((u) => u.name));
      async function updatePlugin(name) {
        if (installing) return;
        setInstalling(true);
        setAiLog("");
        setLastFailed(null);
        setInstallLog(`$ 更新 ${name}\n`);
        try {
          const r = await api.updatePlugin(name);
          setInstallLog((l) => l + (r.log || "(无输出)") + (r.ok ? "\n✔ 更新完成" : "\n✖ 更新失败"));
          if (!r.ok) setLastFailed({ pkg: name, type: "manual" });
        } catch (e) {
          setInstallLog((l) => l + "\n✖ " + String(e && e.message || e));
        } finally {
          setInstalling(false);
        }
        refresh();
        try { const r2 = await api.pluginUpdateCheck(); if (r2 && r2.ok) setPluginUpdates(r2); } catch {}
      }
      const pluginBusy = installing || pluginJobs.some((job) => job.status === "running");
      const tabs = [["market", t("插件市场")], ["mcp", t("MCP 服务器")], ["plugins", t("已安装插件")]];

      return jsx("div", { style: S.wrap, children: [
        jsx("div", { style: S.nav, children: tabs.map(([id, label]) =>
          jsx("button", { key: id, style: S.navBtn(tab === id), onClick: () => setTab(id), children: label })
        ) }),
        pluginUpdates && Array.isArray(pluginUpdates.updates) && pluginUpdates.updates.length > 0 && jsx("div", { style: S.card, children: [
          jsx("div", { style: S.row, children: [
            jsx("span", { style: S.h2, children: t("有 {n} 个插件可更新", { n: pluginUpdates.updates.length }) }),
            jsx("button", { style: S.btnSmall, onClick: () => { const a3 = window.dshDesktop; if (a3 && a3.pluginUpdateCheck) a3.pluginUpdateCheck().then((r) => { if (r && r.ok) setPluginUpdates(r); }).catch(() => {}); }, children: t("重新检查") })
          ] }),
          ...pluginUpdates.updates.map((u) => jsx("div", { key: u.name, style: S.li, children: [
            jsx("span", { style: S.liName, children: esc(u.name) }),
            jsx("span", { style: S.sub, children: t("已装 {from} → {to}（{source}）", { from: esc(u.installedVersion || "?"), to: esc(u.latestVersion || "?"), source: esc(u.source) }) })
          ] }))
        ] }),
        pluginJobs.some((job) => job.status === "running") && jsx("div", { style: S.card, children: [
          jsx("div", { style: S.h2, children: t("后台任务") }),
          ...pluginJobs.filter((job) => job.status === "running").map((job) => jsx("div", { key: job.id, style: S.li, children: [
            jsx("span", { style: S.liName, children: esc(job.mode + " " + job.pkg) }),
            jsx("span", { style: S.sub, children: esc(job.status) })
          ] })),
          jsx("div", { style: S.sub, children: t("安装/卸载正在后台运行，关闭设置页也不会中断。") })
        ] }),
        tab === "market" && jsx("div", { children: [
          jsx("input", { style: S.input, value: query, placeholder: t("搜索插件（名称 / 描述）"), onChange: (e) => setQuery(e.target.value) }),
          jsx("div", { style: { display: "flex", gap: 8, marginTop: 10, alignItems: "center" }, children: [
            jsx("span", { style: { ...S.sub, whiteSpace: "nowrap" }, children: "链接 / 命令安装" }),
            jsx("input", { style: { ...S.input, flex: 1 }, value: pkg, placeholder: "npm 包名 / github:owner/repo / tar.gz 链接 / dsh plugin add <包名>", onChange: (e) => setPkg(e.target.value) }),
            jsx("button", { style: S.btn, disabled: pluginBusy, onClick: installPkg, children: pluginBusy ? t("任务进行中…") : t("安装") })
          ] }),
          installLog && jsx("pre", { style: S.pre, children: installLog }),
          lastFailed && !aiBusy && jsx("div", { style: S.card, children: [
            jsx("div", { style: S.row, children: [
              jsx("span", { style: { fontSize: 13 }, children: `常规安装失败：${esc(lastFailed.pkg)}，可让 AI 自动诊断修复` }),
              jsx("button", { style: S.btn, disabled: pluginBusy, onClick: aiInstallPkg, children: "AI 安装" })
            ] })
          ] }),
          aiBusy && jsx("div", { style: S.card, children: jsx("span", { style: { fontSize: 13 }, children: "AI 安装进行中（分析失败原因→自动修复→重试）…" }) }),
          aiLog && jsx("pre", { style: S.pre, children: aiLog }),
          !market.data && !market.error && jsx("div", { style: S.empty, children: t("正在加载插件市场…") }),
          market.error && !market.data && jsx("div", { style: S.empty, children: t("加载失败：") + esc(market.error) }),
          market.data && jsx("div", { children: [
            jsx("div", { style: S.chips, children: [
              jsx("button", { key: "全部", style: S.chip(catFilter === "全部"), onClick: () => setCatFilter("全部"), children: t("全部") + " · " + (market.data?.total ?? 0) }),
              ...(market.data?.groups || []).map((g) =>
                jsx("button", { key: g.category, style: S.chip(catFilter === g.category), onClick: () => setCatFilter(g.category), children: esc(g.category) + " · " + g.items.length })
              )
            ] }),
            market.error && jsx("div", { style: S.empty, children: t("刷新失败（当前显示上次数据）：") + esc(market.error) }),
            (() => {
              const q = deferredQuery.trim().toLowerCase();
              const groups = (market.data.groups || [])
                .filter((g) => catFilter === "全部" || g.category === catFilter)
                .map((g) => ({ ...g, items: g.items.filter((it) => !q || (it.repo + " " + it.desc).toLowerCase().includes(q)) }))
                .filter((g) => g.items.length);
              if (!groups.length) return jsx("div", { style: S.empty, children: t("没有匹配的插件") });
              return jsx("div", { children: [
                jsx("div", { style: S.row, children: [
                  jsx("span", { style: S.sub, children: `数据源：awesome-dsh-plugin · 共 ${market.data.total} 个插件（匹配 ${groups.reduce((n, g) => n + g.items.length, 0)} 个）· ${market.data.source === "remote" ? "在线" : market.data.source === "local-snapshot" ? "本地快照" : "内置快照"}` }),
                  jsx("span", { style: { flex: 1 } }),
                  jsx("button", { style: S.btnSmall, disabled: marketRefreshing, onClick: () => refreshMarket(true), children: marketRefreshing ? t("刷新中…") : t("刷新") })
                ] }),
                showRestart && jsx("div", { style: S.card, children: [
                  jsx("div", { style: S.row, children: [
                    jsx("span", { style: { fontSize: 13 }, children: `插件变更完成，${restartCountdown ?? ""} 秒后自动重启` }),
                    jsx("button", { style: S.btn, onClick: () => api.restart(), children: t("立即重启") }),
                    jsx("button", { style: S.btnSmall, onClick: cancelRestart, children: t("取消") })
                  ] })
                ] }),
                ...groups.map((g) => jsx("div", { key: g.category, children: [
                  jsx("div", { style: S.cat, children: esc(g.category) }),
                  ...g.items.map((it) => {
                    const status = busy[it.repo];
                    const repoName = it.repo.split("/")[1];
                    const explicitName = (/npm\s+包名\s*[`：:]\s*([^\s`，。]+)/.exec(it.desc || "") || [])[1];
                    const installed = plugins.dependencies.includes(repoName) ||
                      plugins.dependencies.includes(explicitName) ||
                      plugins.bundles.includes(repoName) ||
                      plugins.bundles.includes(explicitName);
                    const installedName = (plugins.dependencies.includes(repoName) || plugins.bundles.includes(repoName)) ? repoName : explicitName;
                    const canUpdate = installed && installedName && updatable.has(installedName);
                    return jsx("div", { key: it.repo, style: S.card, children: [
                      jsx("div", { style: S.row, children: [
                        jsx("span", { style: S.name, children: esc(it.repo) }),
                        jsx("a", { href: it.url, target: "_blank", rel: "noopener", style: { fontSize: 12 }, children: "仓库↗" }),
                        jsx("span", { style: { flex: 1 } }),
                        installed
                          ? (canUpdate
                            ? jsx("button", { style: S.btnSmall, disabled: pluginBusy || !!status, onClick: () => updatePlugin(installedName), children: status || (pluginBusy ? t("任务进行中…") : t("更新")) })
                            : jsx("span", { style: S.badge(""), children: t("已安装") }))
                          : jsx("button", { style: S.btnSmall, disabled: pluginBusy || !!status, onClick: () => installRepo(it.repo, it.desc), children: status || (pluginBusy ? t("任务进行中…") : t("安装")) })
                      ] }),
                      jsx("div", { style: S.desc, children: esc(it.desc) })
                    ] });
                  })
                ] }))
              ] });
            })()
          ] })
        ] }),
        tab === "mcp" && jsx("div", { children: mcp.loading
          ? jsx("div", { style: S.empty, children: t("正在检测…") })
          : mcp.error
            ? jsx("div", { style: S.empty, children: t("检测失败：") + esc(mcp.error) })
            : mcp.data.length === 0
              ? jsx("div", { style: S.empty, children: t("当前 web 端未配置 MCP 服务器") })
              : mcp.data.map((s) => {
                  const bad = (s.status === "无法连接" || s.status === "命令未找到") ? "bad" : (s.status !== "可用" && s.status !== "可连接" ? "warn" : "");
                  return jsx("div", { key: s.name, style: S.card, children: [
                    jsx("div", { style: S.row, children: [
                      jsx("span", { style: S.name, children: esc(s.name) }),
                      jsx("span", { style: S.badge(bad), children: esc(t(s.status) || s.status) }),
                      jsx("span", { style: S.sub, children: esc(s.source) + " · " + esc(s.transport) })
                    ] }),
                    jsx("div", { style: S.mono, children: s.transport === "stdio" ? `${s.command} ${(s.args || []).join(" ")}` : esc(s.url) })
                  ] });
                })
        }),
        tab === "plugins" && jsx("div", { children: [
          jsx("div", { style: S.cat, children: t("已安装依赖") }),
          plugins.dependencies.length
            ? plugins.dependencies.map((d) => jsx("div", { key: d, style: S.li, children: [
                jsx("span", { style: S.liName, children: esc(d) }),
                jsx("div", { style: S.row, children: [
                  jsx("span", { style: S.sub, children: t("依赖") }),
                  updatable.has(d) && jsx("button", { style: S.btnSmall, disabled: pluginBusy, onClick: () => updatePlugin(d), children: pluginBusy ? t("任务进行中…") : t("更新") }),
                  jsx("button", { style: S.btnSmall, disabled: pluginBusy, onClick: () => uninstallPkg(d), children: uninstallingPkg === d ? "卸载中…" : t("卸载") })
                ] })
              ] }))
            : jsx("div", { style: S.empty, children: t("无") }),
          jsx("div", { style: S.cat, children: t("已启用的 Bundle 层") }),
          plugins.bundles.length ? plugins.bundles.map((b) => jsx("div", { key: b, style: S.li, children: [
            jsx("span", { style: S.liName, children: esc(b) }),
            jsx("div", { style: S.row, children: [
              jsx("span", { style: S.sub, children: "bundle" }),
              jsx("button", { style: S.btnSmall, disabled: pluginBusy, onClick: () => uninstallPkg(b), children: uninstallingPkg === b ? "卸载中…" : t("卸载") })
            ] })
          ] })) : jsx("div", { style: S.empty, children: t("无") }),
          installLog && jsx("pre", { style: S.pre, children: installLog }),
          lastFailed && !aiBusy && jsx("div", { style: S.card, children: [
            jsx("div", { style: S.row, children: [
              jsx("span", { style: { fontSize: 13 }, children: `常规安装失败：${esc(lastFailed.pkg)}，可让 AI 自动诊断修复` }),
              jsx("button", { style: S.btn, disabled: pluginBusy, onClick: aiInstallPkg, children: "AI 安装" })
            ] })
          ] }),
          aiBusy && jsx("div", { style: S.card, children: jsx("span", { style: { fontSize: 13 }, children: "AI 安装进行中（分析失败原因→自动修复→重试）…" }) }),
          aiLog && jsx("pre", { style: S.pre, children: aiLog }),
          showRestart && jsx("div", { style: S.card, children: [
            jsx("div", { style: S.row, children: [
              jsx("span", { style: { fontSize: 13 }, children: `插件变更完成，${restartCountdown ?? ""} 秒后自动重启` }),
              jsx("button", { style: S.btn, onClick: () => api.restart(), children: t("立即重启") }),
              jsx("button", { style: S.btnSmall, onClick: cancelRestart, children: t("取消") })
            ] })
          ] })
        ] })
      ] });
    }

    function RollbackSection({ t }) {
      const [rollbackList, setRollbackList] = useState(null);
      const [busy, setBusy] = useState(false);
      const [checkpoints, setCheckpoints] = useState({ loading: true });
      const [preview, setPreview] = useState(null);
      const api = window.dshDesktop;

      async function loadRollback(force = false) {
        // 无感刷新：已有数据时保留旧列表，后台拉新后原位替换
        setRollbackList((prev) => (prev && prev.data ? { ...prev, refreshing: true } : { loading: true }));
        try {
          const data = await api.sessionRollbackList(force === true);
          setRollbackList((prev) => ({ data, refreshing: false }));
        } catch (e) {
          setRollbackList((prev) => (prev && prev.data ? { ...prev, refreshing: false, error: String(e && e.message || e) } : { error: String(e && e.message || e) }));
        }
      }
      async function loadCheckpoints() {
        setCheckpoints({ loading: true });
        try {
          const list = await api.rewindList();
          setCheckpoints({ data: Array.isArray(list) ? list : (list && list.error ? (() => { throw new Error(list.error); })() : []) });
        } catch (e) {
          setCheckpoints({ error: String(e && e.message || e) });
        }
      }
      async function doDelete(item) {
        if (busy) return;
        if (!window.confirm("确定删除这个会话吗？删除后会移入回收站，可恢复。")) return;
        setBusy(true);
        setRollbackList((prev) => ({ ...prev, status: t("正在删除…") }));
        try {
          const r = await api.deleteSession(item.file);
          if (r && r.ok) {
            setRollbackList((prev) => ({
              ...prev,
              status: "✔ 已删除（可到回收站恢复）",
              data: prev && prev.data ? prev.data.filter((x) => x.file !== item.file) : prev.data
            }));
            loadRollback(true);
          } else {
            setRollbackList((prev) => ({ ...prev, status: "✖ " + ((r && r.msg) || "删除失败") }));
          }
        } catch (e) {
          setRollbackList((prev) => ({ ...prev, status: "✖ " + String(e && e.message || e) }));
        } finally {
          setBusy(false);
        }
      }
      async function doRollback(item) {
        if (busy) return;
        if (!window.confirm("确定回滚这一轮对话吗？（会删除这条消息及之后的内容，并自动刷新会话）")) return;
        setBusy(true);
        setRollbackList((prev) => ({ ...prev, status: t("正在回滚…") }));
        try {
          // 优先无感热回滚：不杀进程、不整页重启，只收缩内存日志 + 截断磁盘 + 主窗口原地刷新
          const canHot = item && item.id && item.lastUserMessageId && typeof api.sessionRollbackByUserMessageHot === "function";
          const r = canHot
            ? await api.sessionRollbackByUserMessageHot(item.id, item.lastUserMessageId)
            : await api.sessionRollback(item.file);
          if (r.ok) {
            setRollbackList((prev) => ({ ...prev, status: "✔ " + r.msg + "，正在刷新会话…" }));
            if (canHot) {
              loadRollback(true); // 后台复核真实清单；主窗口已由热回滚路径原地刷新
            } else if (typeof api.reloadHarness === "function") {
              const rel = await api.reloadHarness();
              if (!rel?.ok) setRollbackList((prev) => ({ ...prev, status: "✖ " + (rel?.msg || "刷新失败") }));
            } else {
              setRollbackList((prev) => ({ ...prev, status: "✔ " + r.msg + "。当前版本需重启一次应用，之后回滚会自动刷新。" }));
            }
          } else {
            setRollbackList((prev) => ({ ...prev, status: "✖ " + r.msg }));
            loadRollback();
          }
        } catch (e) {
          setRollbackList((prev) => ({ ...prev, status: "✖ " + String(e && e.message || e) }));
        } finally {
          setBusy(false);
        }
      }
      async function doPreview(cp) {
        if (busy) return;
        setBusy(true);
        setPreview({ loading: true, cp });
        try {
          const r = await api.rewindPreview(cp.id);
          setPreview(r && r.ok ? { data: r, cp } : { error: r?.msg || "预览失败" });
        } catch (e) {
          setPreview({ error: String(e && e.message || e) });
        } finally {
          setBusy(false);
        }
      }
      async function doExecuteCheckpoint() {
        const plan = preview && preview.data;
        if (!plan || busy) return;
        if (!window.confirm(`确定回滚到该检查点吗？\n将恢复 ${plan.total} 个文件，并自动刷新会话。`)) return;
        setBusy(true);
        try {
          const r = await api.rewindExecute(plan.checkpoint.id, plan.signature);
          if (r && r.ok) {
            let msg = "✔ " + (plan.total === 0 ? "工作区无差异" : `已恢复 ${plan.total} 个文件`);
            if (r.conversation && !r.conversation.ok) msg += "；对话回滚：" + r.conversation.msg;
            setRollbackList((prev) => ({ ...prev, status: msg + "，正在刷新会话…" }));
            if (typeof api.reloadHarness === "function") {
              const rel = await api.reloadHarness();
              if (!rel?.ok) setRollbackList((prev) => ({ ...prev, status: "✖ " + (rel?.msg || "刷新失败") }));
            }
          } else {
            setRollbackList((prev) => ({ ...prev, status: "✖ " + (r?.msg || "回滚失败") }));
          }
          setPreview(null);
          loadCheckpoints();
        } catch (e) {
          setRollbackList((prev) => ({ ...prev, status: "✖ " + String(e && e.message || e) }));
        } finally {
          setBusy(false);
        }
      }
      async function doUndo() {
        if (busy) return;
        const guard = (checkpoints.data || []).find((c) => c.type === "guard");
        if (!guard) { setRollbackList((prev) => ({ ...prev, status: t("没有可用的保护检查点") })); return; }
        if (!window.confirm("撤销最近一次回滚，把工作区文件恢复到回滚前状态？")) return;
        setBusy(true);
        try {
          const r = await api.rewindUndo(guard.id);
          setRollbackList((prev) => ({ ...prev, status: r && r.ok ? "✔ 已恢复到保护检查点" : "✖ " + (r?.msg || "撤销失败") }));
          loadCheckpoints();
        } catch (e) {
          setRollbackList((prev) => ({ ...prev, status: "✖ " + String(e && e.message || e) }));
        } finally {
          setBusy(false);
        }
      }
      useEffect(() => {
        loadRollback(false);
        loadCheckpoints();
        // 每 20 秒无感自动刷新：外部删除/回滚会话后列表自动同步
        const iv = setInterval(() => loadRollback(false), 20000);
        return () => clearInterval(iv);
      }, []);

      return jsx("div", { style: S.wrap, children: [
        jsx("div", { style: S.rollbackHead, children: [
          jsx("div", { style: { flex: 1, minWidth: 0 }, children: [
            jsx("div", { style: S.h2, children: t("可回滚的会话") }),
            jsx("div", { style: { ...S.sub, marginTop: 4 }, children: t("选择会话回滚最后一轮：撤销 edit 修改、移除本轮新建文件，完成后自动刷新会话。") })
          ] }),
          jsx("div", { style: { ...S.row, alignItems: "center", flexWrap: "nowrap" }, children: [
            rollbackList && !rollbackList.loading && !rollbackList.error
              ? jsx("span", { style: { ...S.sub, whiteSpace: "nowrap" }, children: "共 " + rollbackList.data.length + " 个" })
              : null,
            jsx("button", { style: S.btnSmall, disabled: !!rollbackList?.loading || busy, onClick: () => loadRollback(true), children: rollbackList?.loading ? t("刷新中…") : t("刷新") })
          ] })
        ] }),
        rollbackList?.status && jsx("pre", { style: S.pre, children: rollbackList.status }),
        !rollbackList ? null
          : !rollbackList.data && rollbackList.error ? jsx("div", { style: S.empty, children: t("扫描失败：") + esc(rollbackList.error) })
          : !rollbackList.data && rollbackList.loading ? jsx("div", { style: S.empty, children: t("正在扫描会话…") })
          : rollbackList.data && rollbackList.error ? jsx("div", { style: S.empty, children: t("刷新失败（当前显示上次数据）：") + esc(rollbackList.error) })
          : !rollbackList.data.length ? jsx("div", { style: S.empty, children: t("没有可回滚的会话") })
          : rollbackList.data.map((s) => jsx("div", { key: s.file, style: S.card, children: [
              jsx("div", { style: S.row, children: [
                jsx("span", { style: { ...S.name, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "38%" }, children: esc(s.id) }),
                jsx("span", { style: { ...S.sub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "32%" }, children: esc(s.cwd) }),
                jsx("span", { style: { flex: 1 } }),
                jsx("button", { style: S.btnSmall, disabled: busy, onClick: () => doRollback(s), children: busy ? t("回滚中…") : t("回滚") }),
                  jsx("button", { style: S.btnSmall, disabled: busy, onClick: () => doDelete(s), children: busy ? t("删除中…") : t("删除") })
              ] }),
              jsx("div", { style: S.desc, children: esc(s.lastUserText) }),
              jsx("div", { style: S.status, children: "发送时间：" + esc(s.time) })
            ] })),
        jsx("div", { style: S.rollbackHead, children: [
          jsx("div", { style: { flex: 1, minWidth: 0 }, children: [
            jsx("div", { style: S.h2, children: t("文件检查点（对话与文件联动回滚）") }),
            jsx("div", { style: { ...S.sub, marginTop: 4 }, children: t("每条用户消息在工具执行前自动建立检查点。预览差异 → 确认 → 恢复文件并回滚对话；执行前会自动创建可撤销的保护检查点。") })
          ] }),
          jsx("div", { style: { ...S.row, alignItems: "center", flexWrap: "nowrap" }, children: [
            (checkpoints.data || []).some((c) => c.type === "guard")
              ? jsx("button", { style: S.btnSmall, disabled: busy, onClick: doUndo, children: t("撤销上次回滚") })
              : null,
            jsx("button", { style: S.btnSmall, disabled: !!checkpoints?.loading || busy, onClick: loadCheckpoints, children: checkpoints?.loading ? t("刷新中…") : t("刷新") })
          ] })
        ] }),
        checkpoints.loading ? jsx("div", { style: S.empty, children: t("正在读取检查点…") })
          : checkpoints.error ? jsx("div", { style: S.empty, children: t("读取失败：") + esc(checkpoints.error) })
          : !checkpoints.data.length ? jsx("div", { style: S.empty, children: t("暂无检查点（发送消息后自动生成）") })
          : checkpoints.data.map((c) => jsx("div", { key: c.id, style: S.card, children: [
              jsx("div", { style: S.row, children: [
                jsx("span", { style: S.name, children: esc(c.type === "guard" ? "🛡 保护" : "● " + new Date(c.createdAt).toLocaleString()) }),
                jsx("span", { style: S.sub, children: esc(c.root || c.cwd || "") }),
                jsx("span", { style: { flex: 1 } }),
                jsx("button", { style: S.btnSmall, disabled: busy, onClick: () => doPreview(c), children: t("预览") })
              ] }),
              c.summary && jsx("div", { style: S.desc, children: esc(c.summary) })
            ] })),
        preview && (preview.loading
          ? jsx("div", { style: S.empty, children: t("正在生成回滚计划…") })
          : preview.error
            ? jsx("pre", { style: S.pre, children: t("预览失败：") + esc(preview.error) })
            : jsx("div", { style: S.card, children: [
                jsx("div", { style: S.row, children: [
                  jsx("span", { style: S.name, children: t("回滚计划") }),
                  jsx("span", { style: S.sub, children: `目标检查点：${esc(preview.data.checkpoint.id)} · 共 ${preview.data.total} 个文件变更` }),
                  jsx("span", { style: { flex: 1 } }),
                  jsx("button", { style: S.btnSmall, disabled: busy, onClick: () => setPreview(null), children: t("取消") }),
                  jsx("button", { style: S.btnSmall, disabled: busy, onClick: doExecuteCheckpoint, children: t("确认回滚") })
                ] }),
                jsx("pre", { style: S.pre, children: (preview.data.diffs || []).slice(0, 200).map((d) =>
                  `${d.status === "added" ? "＋" : d.status === "deleted" ? "－" : "～"} ${d.path}${d.lineChanges ? ` (+${d.lineChanges.added}/-${d.lineChanges.removed})` : ""}`
                ).join("\n") || "（无差异）" })
              ] }))
      ] });
    }

    function DeleteSection({ t }) {
      const [list, setList] = useState(null);
      const [busy, setBusy] = useState(false);
      const [trashPath, setTrashPath] = useState("");
      const api = window.dshDesktop;

      async function load(force = false) {
        if (typeof api.sessionTrashList !== "function" || typeof api.deleteTrashSession !== "function") {
          setList({ data: [], error: "请重启 DeepSeek Harness 后使用回收站管理。" });
          return;
        }
        // 无感刷新：已有数据时保留旧列表，后台拉新数据后原位替换
        setList((prev) => (prev && prev.data ? { ...prev, refreshing: true } : { loading: true }));
        try {
          const data = await api.sessionTrashList(force === true);
          setList((prev) => ({ data, refreshing: false }));
        } catch (e) {
          setList((prev) => (prev && prev.data ? { ...prev, refreshing: false, error: String(e && e.message || e) } : { error: String(e && e.message || e) }));
        }
      }
      async function doDelete(dir) {
        if (busy) return;
        if (!window.confirm("确定彻底删除这个已归档会话吗？\n此操作会直接删除回收站里的数据，不可恢复。")) return;
        setBusy(true);
        setList((prev) => ({ ...prev, status: t("正在删除…") }));
        try {
          const r = await api.deleteTrashSession(dir);
          if (r.ok) {
            // 先乐观地从列表移除，不闪加载
            setList((prev) => ({
              ...prev,
              status: "✔ " + r.msg,
              data: prev && prev.data ? prev.data.filter((item) => item.dir !== dir) : (prev && prev.data)
            }));
            load(true); // 后台复核真实清单
          } else {
            setList((prev) => ({ ...prev, status: "✖ " + r.msg }));
            load(false);
          }
        } catch (e) {
          setList((prev) => ({ ...prev, status: "✖ " + String(e && e.message || e) }));
        } finally {
          setBusy(false);
        }
      }
      async function doRestore(dir) {
        if (busy) return;
        if (!window.confirm("确定恢复这个归档会话吗？\n它会移回正常的会话目录，可继续使用。")) return;
        setBusy(true);
        setList((prev) => ({ ...prev, status: "正在恢复…" }));
        try {
          const r = await api.restoreTrashSession(dir);
          if (r.ok) {
            setList((prev) => ({
              ...prev,
              status: "✔ " + r.msg,
              data: prev && prev.data ? prev.data.filter((item) => item.dir !== dir) : (prev && prev.data)
            }));
            load(true);
          } else {
            setList((prev) => ({ ...prev, status: "✖ " + r.msg }));
            load(false);
          }
        } catch (e) {
          setList((prev) => ({ ...prev, status: "✖ " + String(e && e.message || e) }));
        } finally {
          setBusy(false);
        }
      }
      useEffect(() => {
        load(false);
        if (api.getTrashPath) api.getTrashPath().then(setTrashPath).catch(() => {});
        // 每 20 秒无感自动刷新：外部（其他窗口/页面）删除/恢复会话后列表自动同步
        const iv = setInterval(() => load(false), 20000);
        return () => clearInterval(iv);
      }, []);

      return jsx("div", { style: S.wrap, children: [
        jsx("div", { style: S.rollbackHead, children: [
          jsx("div", { style: { flex: 1, minWidth: 0 }, children: [
            jsx("div", { style: S.h2, children: t("回收站") }),
            jsx("div", { style: { ...S.sub, marginTop: 4 }, children: t("可恢复或彻底删除已归档会话，也可打开回收站文件夹手动清理。") })
          ] }),
          jsx("div", { style: { ...S.row, alignItems: "center", flexWrap: "nowrap" }, children: [
            list && !list.loading && !list.error
              ? jsx("span", { style: { ...S.sub, whiteSpace: "nowrap" }, children: "共 " + list.data.length + " 个" })
              : null,
            jsx("button", { style: S.btnSmall, disabled: !!list?.loading || busy, onClick: () => load(true), children: list?.loading ? t("刷新中…") : t("刷新") })
          ] })
        ] }),
        trashPath && jsx("div", { style: { ...S.row, alignItems: "center", flexWrap: "nowrap", marginTop: 4 }, children: [
          jsx("span", { style: { ...S.mono, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: esc(trashPath) }),
          jsx("button", { style: S.btnSmall, onClick: () => api.openTrashFolder && api.openTrashFolder(), children: t("打开文件夹") })
        ] }),
        list?.status && jsx("pre", { style: S.pre, children: list.status }),
        !list ? null
          : !list.data && list.error ? jsx("div", { style: S.empty, children: t("扫描失败：") + esc(list.error) })
          : !list.data && list.loading ? jsx("div", { style: S.empty, children: t("正在扫描会话…") })
          : list.data && list.error ? jsx("div", { style: S.empty, children: t("刷新失败（当前显示上次数据）：") + esc(list.error) })
          : !list.data.length ? jsx("div", { style: S.empty, children: t("没有已删除的会话") })
          : list.data.map((s) => jsx("div", { key: s.dir, style: S.card, children: [
              jsx("div", { style: S.row, children: [
                jsx("span", { style: S.name, children: esc(String(s.id).slice(0, 8) + "…") }),
                jsx("span", { style: S.sub, children: esc(s.cwd) }),
                jsx("span", { style: { flex: 1 } }),
                jsx("button", { style: S.btnSmall, disabled: busy, onClick: () => doRestore(s.dir), children: busy ? t("恢复中…") : t("恢复") }),
                jsx("button", { style: S.btnSmall, disabled: busy, onClick: () => doDelete(s.dir), children: busy ? t("删除中…") : t("彻底删除") })
              ] }),
              s.lastUserText ? jsx("div", { style: S.desc, children: esc(s.lastUserText) }) : null,
              jsx("div", { style: S.status, children: (s.time ? "最后消息：" + esc(s.time) + " · " : "") + t("归档时间：") + esc(s.trashedAt || "") })
            ] }))
      ] });
    }

    function ArchiveSection({ t }) {
      const [tab, setTab] = useState("trash");
      return jsx("div", { style: S.wrap, children: [
        jsx("div", { style: S.nav, children: [
          jsx("button", { style: S.navBtn(tab === "rollback"), onClick: () => setTab("rollback"), children: t("回滚") }),
          jsx("button", { style: S.navBtn(tab === "trash"), onClick: () => setTab("trash"), children: t("回收站") })
        ] }),
        tab === "rollback" ? jsx(RollbackSection, { t }) : jsx(DeleteSection, { t })
      ] });
    }

    const CHANGELOG = [
      {
        version: "0.1.2",
        date: "2026-08-19",
        items: [
          "插件一键更新：已安装插件有新版时按钮变为「更新」，点击直接升级（git 源自动拉最新），失败自动 AI 修复或回滚",
          "内置默认插件自动安装：新装环境开箱即用，插件配置与开发环境一致（已装则跳过，升级不受影响）",
          "MCP 自动检测（类似 Claude Code / opencode）：启动时从 ~/.claude.json 与 opencode 配置同步 MCP 服务器，手动配置保留，变化热重载生效",
          "「链接 / 命令安装」入口移至插件市场顶部",
          "插件配置模板与发布环境对齐，新装用户与开发环境插件列表一致",
          "修复：git 黑框（dsh-better-sidebar）；MCP 绝对路径命令误报「命令未找到」"
        ]
      },
      {
        version: "0.1.1",
        date: "2026-08-18",
        items: [
          "内核升级 0.1.0-rc.7：LLM 重试机制重构、前端 UI 组件大量更新，全部本地补丁重新应用并验证",
          "AI 安装：常规安装失败自动接手诊断修复（参数真实生效），插件不兼容直接回滚明确提示，失败自动清理残留",
          "插件任务悬浮面板：右下角实时显示安装/卸载/AI 诊断进度、加载动画、可滚动日志，完成 30 秒收起可手动关闭",
          "插件安装/卸载完成播放成功/失败提示音",
          "归档管理新增「删除」按钮（删除进回收站可恢复），回滚/回收站列表 20 秒自动刷新",
          "设置分区专属图标（插件与MCP/归档管理/更新/视觉工具/Token用量）",
          "检查更新显示内置版本与内核版本；官方尚未发布安装包时提示“官方尚未发布”，不再误报查询失败",
          "插件热更新：安装/卸载后自动软刷新生效，无需重启应用",
          "启动提速：Harness 服务驻留复用 + V8 编译缓存，热启动秒开、冷启动不再重复编译 500MB 依赖",
          "终端命令提速约 70 倍：修复提示符协议不匹配导致每次命令多等 3.5 秒超时",
          "修复每次启动误判异常退出而全量扫描会话的问题，正常退出后启动跳过全量校验",
          "修复安装/加载插件、源代码管理 git、LSP 启动时弹出终端黑框",
          "修复主进程 IPC 处理器重复注册导致启动报错",
          "插件安装/卸载完成或失败时 toast 事件推送即时提示（不依赖轮询）",
          "安装成功自动验证插件能否加载，不兼容插件自动回滚并明确提示",
          "视觉 API 密钥快速输入：更新分区新增入口，粘贴即保存到 ~/.dsh/.credentials.yaml",
          "插件定期更新检查：自动检测已装插件（npm / GitHub / 归档）是否有新版本并提示",
          "安装/卸载插件提示弹框改为右上角固定并优化视觉样式",
          "设置页新增功能跟随中英文语言切换"
        ]
      },
      {
        version: "0.1.0",
        date: "2026-08-16",
        items: [
          "对话与文件联动回滚：检查点/预览/确认/撤销、/rewind 命令、双击 Esc 入口、消息旁无感回滚并回填输入框",
          "LLM 请求失败时支持手动立即重试",
          "插件安装/卸载：关闭设置页不中断、失败自动重试、已安装列表与插件市场无感刷新、GitHub 插件自动登记 bundle",
          "会话列表后台异步加载 + 内存缓存，设置页切换不再卡顿",
          "正常启动跳过全量会话校验、探测异步化，加快启动",
          "设置页跟随中英文语言切换",
          "黑白灰主题下明确的选中/启用状态",
          "F11 全屏保留全部操作入口",
          "删除会话无感刷新，移入回收站可找回",
          "会话列表持久化缓存：启动/刷新不再全量解压，未变化的会话毫秒级加载",
          "回滚/删除/插件卸载全程异步清场，主进程不再被 PowerShell 卡死",
          "设置页“回滚”按钮改为无感热回滚，不杀正在运行的会话"
        ]
      }
    ];

    function UpdateSection({ t }) {
      const [updateText, setUpdateText] = useState("");
      const [checking, setChecking] = useState(false);
      const [showKeyInput, setShowKeyInput] = useState(false);
      const [apiKeyInput, setApiKeyInput] = useState("");
      const [keyStatus, setKeyStatus] = useState("");
      const [keyBusy, setKeyBusy] = useState(false);
      const [updateInfo, setUpdateInfo] = useState(null);
      const [downloading, setDownloading] = useState(false);
      const api = window.dshDesktop;

      async function checkUpdate() {
        if (checking) return;
        setChecking(true);
        setUpdateText(t("查询中…"));
        try {
          const info = await api.checkUpdate();
          const newer = info.newer === true || (info.newer === undefined && info.latest && info.latest !== "未知" && info.latest !== info.current);
          const failed = info.latest == null && info.error;
          setUpdateInfo(info);
          setUpdateText(`内置版本：${info.current}${info.kernel ? `（内核 ${info.kernel}）` : ""}\n最新发布：${info.latest ?? (info.notPublished ? "暂无（官方尚未发布安装包）" : "查询失败")}\n\n` +
            (failed ? `查询失败：${info.error}` : newer ? `发现新版本 ${info.latest}。重新打包安装包并覆盖安装即可更新（配置与会话保留在 ~/.dsh）。` : info.notPublished ? "官方尚未发布安装包。" : "当前已是最新。"));
        } catch (e) {
          setUpdateText("查询失败：" + String(e && e.message || e));
        } finally {
          setChecking(false);
        }
      }
      async function downloadUpdate() {
        const uapi = window.dshDesktop;
        if (!uapi || typeof uapi.updateDownload !== 'function' || !updateInfo || !updateInfo.downloadUrl) return;
        setDownloading(true);
        setUpdateText("正在下载更新…");
        try {
          const r = await uapi.updateDownload(updateInfo.downloadUrl);
          setUpdateText(r && r.ok ? r.msg || "已启动更新" : "更新失败：" + (r && r.msg ? r.msg : "未知错误"));
        } catch (e) { setUpdateText("更新失败：" + String(e && e.message || e)); }
        finally { setDownloading(false); }
      }
      async function saveVisionKey() {
        const kapi = window.dshDesktop;
        if (!kapi || typeof kapi.visionConfigSaveKey !== 'function') { setKeyStatus("当前版本不支持直接保存（请重新打包后使用）"); return; }
        if (!apiKeyInput.trim()) { setKeyStatus("请粘贴 API 密钥"); return; }
        setKeyBusy(true); setKeyStatus("保存中…");
        try {
          const r = await kapi.visionConfigSaveKey({ credential: "VISION_API_KEY", apiKey: apiKeyInput.trim() });
          if (r && r.ok) { setKeyStatus("已保存视觉模型 API 密钥（VISION_API_KEY）。"); }
          else { setKeyStatus("保存失败：" + (r && r.msg ? r.msg : "未知错误")); }
        } catch (e) { setKeyStatus("保存失败：" + String(e && e.message || e)); }
        finally { setKeyBusy(false); }
      }

      return jsx("div", { style: S.wrap, children: [
        jsx("div", { style: S.h2, children: t("软件更新") }),
        jsx("div", { style: S.sub, children: t("检查内置 Harness 是否有新版本可用。") }),
        jsx("div", { style: S.row, children: [
          jsx("button", { style: S.btn, disabled: checking, onClick: checkUpdate, children: checking ? t("查询中…") : t("检查更新") }),
          jsx("button", { style: S.btn, onClick: () => setShowKeyInput((v) => !v), children: showKeyInput ? t("收起") : t("视觉 API 密钥") }),
          updateInfo && updateInfo.newer && updateInfo.downloadUrl && jsx("button", { style: S.btn, disabled: downloading, onClick: downloadUpdate, children: downloading ? "下载中…" : "下载并更新" })
        ] }),
        updateText && jsx("pre", { style: S.pre, children: updateText }),
        showKeyInput && jsx("div", { style: S.card, children: [
          jsx("div", { style: S.h2, children: t("视觉模型 API 密钥") }),
          jsx("div", { style: S.desc, children: t("粘贴视觉模型 API 密钥并保存。若未配置，使用视觉工具时会提示。") }),
          jsx("div", { style: { display: "flex", gap: 8, marginTop: 8, alignItems: "center" }, children: [
            jsx("input", { style: S.input, type: "password", value: apiKeyInput, placeholder: "粘贴 API 密钥…", onChange: (e) => setApiKeyInput(e.target.value) }),
            jsx("button", { style: S.btn, disabled: keyBusy, onClick: saveVisionKey, children: keyBusy ? t("保存中…") : t("保存") })
          ] }),
          keyStatus && jsx("div", { style: S.status, children: keyStatus })
        ] }),
        jsx("div", { style: { ...S.card, maxHeight: 340, overflowY: "auto", paddingRight: 6 }, children: [
          jsx("div", { style: { ...S.cat, margin: 0, paddingBottom: 6 }, children: t("更新日志") }),
          ...CHANGELOG.map((v, idx) => jsx("div", { key: v.version, style: { padding: "8px 0", borderBottom: idx < CHANGELOG.length - 1 ? "1px solid rgba(128,128,128,.18)" : "none" }, children: [
            jsx("div", { style: S.row, children: [
              jsx("span", { style: S.name, children: "v" + v.version }),
              jsx("span", { style: S.sub, children: v.date })
            ] }),
            jsx("div", { style: { ...S.mono, whiteSpace: "pre-wrap", lineHeight: 1.6 }, children: v.items.map((line) => "· " + line).join("\n") })
          ] }))
        ] })
      ] });
    }


    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-desktop-settings: dictionaries");
      const t = ctx.locale.bind(NS);
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "dsh-desktop-settings",
        order: 40,
        locale: NS,
        label: () => t("插件与 MCP"),
        inject: () => ({})
      }, DesktopSettingsSection));
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "dsh-desktop-archive",
        order: 41,
        locale: NS,
        label: () => t("归档管理"),
        inject: () => ({})
      }, ArchiveSection));
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "dsh-desktop-update",
        order: 43,
        locale: NS,
        label: () => t("更新"),
        inject: () => ({})
      }, UpdateSection));
      // /rewind 命令执行交棒 + 空输入双击 Esc 打开“对话回滚”
      ctx.effect(() => installRewindCommandBridge(ctx), "dsh-desktop-settings: rewind command bridge");
      ctx.effect(() => installDoubleEscShortcut(), "dsh-desktop-settings: double-esc rollback shortcut");
      ctx.effect(() => installRollbackMessageRestore(), "dsh-desktop-settings: restore rolled-back message");
      ctx.effect(() => installPluginJobNotifier(), "dsh-desktop-settings: plugin job notifier");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
