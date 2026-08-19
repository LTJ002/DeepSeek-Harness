// dsh-desktop-settings host half.
// 对话与文件联动回滚 v1：
//   1. 监听 `session/event`，在每条用户消息（agent/inbox/spliced）到达时登记待建检查点，并立即尝试创建。
//   2. 监听 `tools/execute`（prepend）：任何工具执行前确保该消息的检查点已建立；建立失败即抛错，阻断后续工具执行。
//      这覆盖 write/edit/str_replace_editor，也覆盖 bash/pwsh 等绕过 fs 事件的写入路径。
//   3. 检查点数据落在 ~/.dsh/checkpoints/，由 Electron 主进程（桌面端 UI）与宿主插件共享读取。
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { createCheckpointEngine } = require("./checkpoints.cjs");

const engine = createCheckpointEngine();
const inject = ["commands"];

// 在线会话登记表：热截断用——桌面端请求在“不重启 Harness”的前提下收缩会话内存日志
const liveSessions = new Map();

/** 热截断：直接收缩运行中 Session 的内存日志，页面原地刷新即可生效，无需重启程序。
 *  只允许在截断点之后没有未闭合 turn/start 时执行（活跃轮次交给桌面端整机重启路径）。 */
function truncateSessionInMemory(sessionId, messageId) {
  const session = liveSessions.get(sessionId);
  if (!session) return { ok: false, code: 'OFFLINE', error: '会话当前不在线' };
  const log = session.log;
  if (!Array.isArray(log) || !Number.isInteger(log.length)) return { ok: false, code: 'READONLY', error: '会话日志不可收缩' };
  let userIdx = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]?.type === 'user/message' && log[i]?.data?.id === messageId) { userIdx = i; break; }
  }
  if (userIdx === -1) return { ok: false, code: 'NO_MESSAGE', error: '未找到该用户消息' };
  let spliceIdx = -1;
  for (let i = userIdx - 1; i >= 0; i--) {
    const item = log[i];
    if (item?.type === 'agent/inbox/spliced' && Array.isArray(item.data?.inserted) && item.data.inserted.some((m) => m?.id === messageId)) {
      spliceIdx = i;
      break;
    }
  }
  if (spliceIdx === -1) return { ok: false, code: 'NO_SPLICE', error: '未找到该消息的 inbox 记录' };
  let activeTurn = false;
  for (let i = spliceIdx; i < log.length; i++) {
    if (log[i]?.type === 'turn/start') activeTurn = true;
    else if (log[i]?.type === 'turn/end') activeTurn = false;
  }
  if (activeTurn) return { ok: false, code: 'ACTIVE_TURN', error: '该消息对应的轮次仍在运行，无法原地回滚' };
  const removed = log.length - spliceIdx;
  log.splice(spliceIdx);
  session.eventsSnapshot = undefined; // 让 events getter 重新生成快照
  return { ok: true, removed, newLength: log.length, spliceIdx };
}

// ---------- /rewind 命令 ----------
// 宿主端只做只读计划与参数解析；文件恢复 + 会话截断交给 Electron 主进程（dsh:rewind-execute）。
// Web 客户端在 command/executed 事件里拉取本路由里的 pending 动作并调用 window.dshDesktop 完成联动。
let pendingRewindAction = null;
const REWIND_PENDING_TTL_MS = 60 * 1000;

function parseRewindInput(raw) {
  // 命令框架传进来的是去掉 `/rewind` 之后的原文；这里也容忍测试时带斜杠的完整行
  const text = String(raw ?? "").trim().replace(/^\/rewind\b/i, "").trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  const first = (tokens[0] || "").toLowerCase();
  if (first === "") return { verb: "list", arg: "" };
  if (first === "help") return { verb: "help", arg: "" };
  if (first === "list") return { verb: "list", arg: "" };
  if (first === "preview") return { verb: "preview", arg: tokens.slice(1).join(" ") };
  if (first === "guard") return { verb: "guard", arg: tokens.slice(1).join(" ") };
  if (first === "step") return { verb: "execute", arg: tokens[1] || "" };
  if (/^\d+$/.test(first)) return { verb: "execute", arg: first }; // 裸数字视作 step N
  return { verb: "execute", arg: text };
}
function resolveRewindTarget(arg, records) {
  if (!arg) return null;
  if (/^\d+$/.test(arg)) return records[Number(arg) - 1] || null; // step N：1 起，列表最新在前
  const exact = records.find((r) => r.id === arg);
  if (exact) return exact;
  const prefix = records.filter((r) => r.id.startsWith(arg));
  return prefix.length === 1 ? prefix[0] : null;
}
function rewindUsage() {
  return "用法：/rewind list | /rewind preview <id|step N> | /rewind <id|step N> | /rewind guard <id>";
}
function rewindListText(records) {
  if (!records.length) return "当前没有检查点（发送消息后自动生成）。" + rewindUsage();
  const lines = records.slice(0, 20).map((r, i) => {
    const kind = r.type === "guard" ? "保护" : "普通";
    const summary = r.summary ? ` · ${String(r.summary).slice(0, 60)}` : "";
    return `${i + 1}. [${kind}] ${r.id} ${new Date(r.createdAt).toLocaleString()}${summary}`;
  });
  if (records.length > 20) lines.push(`… 共 ${records.length} 个（仅显示最近 20 个，可用 /rewind step N 或 id 定位）`);
  return lines.join("\n");
}
function rewindDiffText(plan) {
  if (!plan.diffs.length) return "（工作区无差异）";
  return plan.diffs.slice(0, 100).map((d) =>
    `${d.status === "added" ? "＋" : d.status === "deleted" ? "－" : "～"} ${d.path}` +
    (d.lineChanges ? ` (+${d.lineChanges.added}/-${d.lineChanges.removed})` : "")
  ).join("\n") + (plan.diffs.length > 100 ? `\n… 共 ${plan.diffs.length} 个文件` : "");
}
function runRewindCommand(invocation) {
  try {
    const parsed = parseRewindInput(invocation?.rawInput);
    if (parsed.verb === "help") return { kind: "success", text: rewindUsage() };
    const identity = sessionIdentity(invocation?.agent?.session);
    let records = identity.cwd ? engine.list({ cwd: identity.cwd }) : engine.list();
    if (!records.length) records = engine.list();
    if (parsed.verb === "list") return { kind: "success", text: rewindListText(records) };
    if (parsed.verb === "preview") {
      const target = resolveRewindTarget(parsed.arg, records);
      if (!target) return { kind: "error", text: `未找到检查点“${parsed.arg}”。${rewindUsage()}` };
      const plan = engine.preview(target.id);
      return { kind: "success", text: `回滚预览（${target.id}）：共 ${plan.total} 个文件变更\n${rewindDiffText(plan)}` };
    }
    if (parsed.verb === "guard") {
      const guards = records.filter((r) => r.type === "guard");
      const guard = parsed.arg
        ? guards.find((r) => r.id === parsed.arg) || (/^\d+$/.test(parsed.arg) ? guards[Number(parsed.arg) - 1] : null)
        : guards[0] || null;
      if (!guard) return { kind: "error", text: `未找到保护检查点“${parsed.arg}”。${rewindUsage()}` };
      pendingRewindAction = { undo: guard.id, at: Date.now() };
      return { kind: "success", text: `正在把工作区文件恢复到保护检查点 ${guard.id} …` };
    }
    // execute：<id> 或 step N。只做计划并把签名交棒给桌面端，保证“预览后变化即失效”的陈旧检测
    const target = resolveRewindTarget(parsed.arg, records);
    if (!target) return { kind: "error", text: `未找到检查点“${parsed.arg}”。${rewindUsage()}` };
    const plan = engine.preview(target.id);
    pendingRewindAction = { id: target.id, signature: plan.signature, at: Date.now() };
    return {
      kind: "success",
      text: `回滚计划（${target.id}）：共 ${plan.total} 个文件变更\n${rewindDiffText(plan)}\n正在恢复文件、截断对话并自动刷新…`
    };
  } catch (error) {
    return { kind: "error", text: `回滚命令失败：${error?.message || error}` };
  }
}

function textOfMessage(message) {
  try {
    if (!message || !Array.isArray(message.content)) return "";
    return message.content
      .filter((part) => part && typeof part.text === "string")
      .map((part) => part.text)
      .join(" ")
      .slice(0, 80);
  } catch {
    return "";
  }
}
function sessionIdentity(session) {
  return {
    id: typeof session?.id === "string" ? session.id : typeof session?.meta?.id === "string" ? session.meta.id : null,
    cwd: typeof session?.meta?.cwd === "string" ? session.meta.cwd : typeof session?.cwd === "string" ? session.cwd : null
  };
}

function apply(ctx) {
  // sessionId -> 待建检查点绑定（用户消息到达后、其首个工具执行前）
  const pending = new Map();

  // 视觉工具名集合（vision-toolkit 注册的工具）
  const VISION_TOOL_NAMES = new Set([
    'vision_ground', 'vision_detect', 'vision_trace', 'vision_pixel_diff',
    'vision_crop', 'vision_long_screenshot_ocr', 'vision_extract_foreground',
    'vision_html_screenshot', 'vision_dominant_colors'
  ]);
  // 读取 ~/.dsh/.credentials.yaml，判断指定 credential 是否已配置（按行首 key 匹配）
  function visionCredentialConfigured(credentialName) {
    try {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      const file = path.join(home, '.credentials.yaml');
      if (!fs.existsSync(file)) return false;
      const text = fs.readFileSync(file, 'utf8');
      const key = credentialName || 'VISION_API_KEY';
      return text.split(/\r?\n/).some((line) => {
        const t = line.trim();
        return t.startsWith(key + ':') || t.startsWith(key + ' :');
      });
    } catch { return false; }
  }

  // 手动重试桥：Web 端调用 /enh/retry-now?retryId=... → 中止 llm-retry 的等待定时器，立即开始重试
  // /rewind 交棒桥：/enh/rewind-pending 取走宿主命令算出的回滚动作（幂等：取一次即清空，60s 过期）
  let enhRoutesRegistered = false;
  function sendJson(res, body) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }
  function registerEnhRoutes(webServer) {
    if (enhRoutesRegistered || !webServer) return;
    enhRoutesRegistered = true;
    webServer.register({
      kind: "exact",
      path: "/enh/retry-now",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://dsh.local");
          const retryId = url.searchParams.get("retryId");
          if (typeof retryId !== "string" || retryId === "") return sendJson(res, { ok: false, error: "缺少 retryId" });
          const service = ctx.reflect.get("llmRetry", false);
          if (!service || typeof service.retryNow !== "function") return sendJson(res, { ok: false, error: "重试服务不可用" });
          sendJson(res, { ok: service.retryNow(retryId) });
        } catch (error) {
          sendJson(res, { ok: false, error: String(error?.message || error) });
        }
      }
    });
    webServer.register({
      kind: "exact",
      path: "/enh/rewind-pending",
      handler: async (req, res) => {
        const fresh = pendingRewindAction && Date.now() - pendingRewindAction.at < REWIND_PENDING_TTL_MS;
        const action = fresh
          ? { id: pendingRewindAction.id || null, signature: pendingRewindAction.signature || null, undo: pendingRewindAction.undo || null }
          : null;
        pendingRewindAction = null;
        sendJson(res, { ok: true, action });
      }
    });
    webServer.register({
      kind: "exact",
      path: "/enh/truncate-session",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://dsh.local");
          const sessionId = url.searchParams.get("sessionId");
          const messageId = url.searchParams.get("messageId");
          if (typeof sessionId !== "string" || sessionId === "" || typeof messageId !== "string" || messageId === "") {
            return sendJson(res, { ok: false, error: "缺少 sessionId/messageId" });
          }
          sendJson(res, truncateSessionInMemory(sessionId, messageId));
        } catch (error) {
          sendJson(res, { ok: false, error: String(error?.message || error) });
        }
      }
    });
    webServer.register({
      kind: "exact",
      path: "/enh/dispose-session",
      handler: async (req, res) => {
        // 删除会话前卸载内存中的 live Session：页面无需重启即可“无感删除”。
        // 卸载后 session/disposed 事件会让前端关闭该会话；磁盘由 Electron 主进程移动到回收站。
        try {
          const url = new URL(req.url, "http://dsh.local");
          const sessionId = url.searchParams.get("sessionId");
          if (typeof sessionId !== "string" || sessionId === "") return sendJson(res, { ok: false, error: "缺少 sessionId" });
          const sessions = ctx.reflect.get("sessions", false);
          const entry = sessions?.store?.get(sessionId);
          if (!entry) return sendJson(res, { ok: true, disposed: false });
          if (typeof entry.detach === "function") entry.detach();
          sendJson(res, { ok: true, disposed: true });
        } catch (error) {
          sendJson(res, { ok: false, error: String(error?.message || error) });
        }
      }
    });
  }
  registerEnhRoutes(ctx.reflect.get("webServer", false));
  ctx.on("internal/service", (name, value) => {
    if (name === "webServer") registerEnhRoutes(value);
  });
  // 注册 /rewind 命令（不发给模型：list / preview / step / guard / 直接回滚）
  ctx.commands.register({
    name: "rewind",
    description: "对话与文件联动回滚：list/preview/step/guard/回滚到检查点",
    input: { hint: "<id | step N | guard <id> | list | preview <id>>" },
    recordInput: false,
    handler: (invocation) => runRewindCommand(invocation)
  });

  async function ensureCheckpoint(session, bind) {
    const identity = sessionIdentity(session);
    const cwd = bind?.cwd || identity.cwd;
    if (!identity.id || !cwd) return null;
    return engine.ensureCheckpoint({
      cwd,
      sessionId: identity.id,
      messageId: bind?.messageId || null,
      turn: bind?.turn ?? null,
      summary: bind?.summary || null
    });
  }

  ctx.on("session/event", (session, event) => {
    try {
      const identity = sessionIdentity(session);
      if (identity.id) liveSessions.set(identity.id, session);
      if (!event || event.type !== "agent/inbox/spliced") return;
      // 只对“最近 5 分钟”内的消息建检查点，避免插件加载/历史回放时把旧消息绑定到当前工作区
      if (typeof event.time === "number" && Date.now() - event.time > 5 * 60 * 1000) return;
      const inserted = event.data?.inserted;
      if (!Array.isArray(inserted) || inserted.length === 0) return;
      if (!identity.id || !identity.cwd) return;
      const first = inserted[0];
      const bind = {
        messageId: typeof first?.id === "string" ? first.id : `seq:${event.seq ?? ""}`,
        summary: textOfMessage(first),
        turn: typeof event.data?.turn === "number" ? event.data.turn : null,
        cwd: identity.cwd
      };
      pending.set(identity.id, bind);
      // 立即异步创建（不阻塞消息投递）；tools/execute 处会再次强制确认，失败则阻断工具
      ensureCheckpoint(session, bind).catch((error) => {
        console.error("[dsh-desktop-settings] 检查点创建失败（消息到达时）：", error?.message || error);
      });
    } catch (error) {
      console.error("[dsh-desktop-settings] session/event 处理失败：", error?.message || error);
    }
  });

  ctx.on("tools/execute", async (exec, next) => {
    const session = exec?.agent?.session;
    if (!session) return next();
    // 视觉工具执行前检查：若视觉 API 密钥未配置，阻断并提示
    if (exec && typeof exec.name === 'string' && VISION_TOOL_NAMES.has(exec.name)) {
      if (!visionCredentialConfigured()) {
        throw new Error('视觉模型 API 密钥未配置：请到 设置 → 更新 → 视觉 API 密钥 粘贴并保存后再使用视觉工具。');
      }
    }
    const identity = sessionIdentity(session);
    const bind = pending.get(identity.id);
    if (!bind) return next();
    try {
      await ensureCheckpoint(session, bind); // 失败会抛错 → 工具链被阻断，满足“检查点创建失败禁止执行文件写入”
      pending.delete(identity.id);
    } catch (error) {
      const detail = error?.message || String(error);
      console.error("[dsh-desktop-settings] 工具执行前检查点创建失败，阻断本轮工具：", detail);
      throw new Error(`文件回滚检查点创建失败，已阻止工具执行：${detail}`);
    }
    return next();
  }, { prepend: true });
}

export { apply, inject, parseRewindInput, truncateSessionInMemory, liveSessions };
