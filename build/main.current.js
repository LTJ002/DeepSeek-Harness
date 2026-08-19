// DeepSeek Harness 桌面版主进程
// 职责：启动内置的 dsh web 服务，在原生窗口里打开 Web 界面，
// 并提供桌面端扩展：MCP 检测、插件安装（内置 pnpm）、更新检查。
const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const https = require('https');
const yaml = require('js-yaml');
const { createCheckpointEngine } = require('./plugins/dsh-desktop-settings/lib/checkpoints.cjs');

const APP_NAME = 'DeepSeek Harness';
app.setName(APP_NAME);
let win = null;
let mcpWin = null;
let pluginWin = null;
let settingsWin = null;
let serverProc = null;
let serverUrl = null;
let externalServer = null;
let quitting = false;
let startupTimeout = null;
let reloadPromise = null;
let reloadingHarness = false;

// ---------- 路径 ----------
function resourcesRoot() {
  return app.isPackaged ? process.resourcesPath : __dirname;
}
function harnessDir() {
  return path.join(resourcesRoot(), 'harness');
}
function harnessBin() {
  return path.join(harnessDir(), 'lib', 'bin.js');
}
function runtimeDir() {
  return path.join(resourcesRoot(), 'runtime');
}
function nodeExe() {
  if (app.isPackaged) return path.join(runtimeDir(), 'node.exe');
  const bundled = path.join(__dirname, 'runtime', 'node.exe');
  return fs.existsSync(bundled) ? bundled : 'node';
}
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
// 对话与文件联动回滚引擎（与宿主插件共享 ~/.dsh/checkpoints 元数据）
const rewindEngine = createCheckpointEngine({ home: dshHome() });
function profileDir(name = 'web') {
  return path.join(dshHome(), 'profiles', name);
}
function workspaceDir() {
  return path.join(os.homedir(), 'DeepSeekHarness');
}
function logFile() {
  return path.join(app.getPath('userData'), 'harness.log');
}
function iconPath() {
  const p = path.join(__dirname, 'build', 'icon.ico');
  return fs.existsSync(p) ? p : undefined;
}

function appendLog(text) {
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    fs.appendFileSync(logFile(), text);
  } catch {}
}

// ---------- 启动标记 ----------
// 目的：只有“首次启动”或“上次进程异常退出（崩溃/强杀）”才做全量会话日志校验，
// 正常退出后的日常启动直接跳过，避免每次启动都扫描全部 session.jsonl.zstd。
function markerPath(name) {
  return path.join(dshHome(), name);
}
function writeJsonMarker(name, data) {
  try {
    const file = markerPath(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    appendLog(`[desktop] 写入启动标记 ${name} 失败：${err}\n`);
  }
}
function markRunning() {
  writeJsonMarker('desktop-running.json', { pid: process.pid, time: Date.now(), version: app.getVersion() });
}
function clearRunningMarker() {
  try { fs.rmSync(markerPath('desktop-running.json'), { force: true }); } catch {}
}
function markRepairedOnce() {
  writeJsonMarker('desktop-repaired-once.json', { time: Date.now(), version: app.getVersion() });
}
function shouldAutoRepairOnStartup() {
  try {
    if (fs.existsSync(markerPath('desktop-running.json'))) {
      return { repair: true, reason: '上次进程异常退出，校验会话日志' };
    }
    if (!fs.existsSync(markerPath('desktop-repaired-once.json'))) {
      return { repair: true, reason: '首次启动，全量校验一次历史会话日志' };
    }
    return { repair: false, reason: '上次为正常退出，跳过全量校验' };
  } catch (err) {
    return { repair: true, reason: `启动标记读取失败（${err?.message || err}），按保守策略校验` };
  }
}

function extractUrl(text) {
  const match = text.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/);
  return match ? match[1] : null;
}

// ---------- 复用已存在的 dsh web 服务 ----------
// 同时运行两个 dsh web 会并发写同一份 session.jsonl.zstd，是历史日志反复损坏的根因。
// 启动时若发现本机已有 dsh web 在监听，桌面端直接连它，不再自己起第二个服务。
function probeDshUrl(url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = http.get(url, { timeout: 2500 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return done(false); }
        let body = '';
        res.on('data', (c) => {
          body += c.toString();
          if (body.length > 40000) req.destroy();
        });
        res.on('end', () => done(body.includes('__DSH_BOOT__')));
        res.on('error', () => done(false));
      });
      req.on('error', () => done(false));
      req.on('timeout', () => { req.destroy(); done(false); });
    } catch { done(false); }
  });
}
function findExistingDshWeb() {
  return (async () => {
    if (process.platform !== 'win32') return null;
    let ps = null;
    try {
      // 异步 spawn：旧实现用 spawnSync(8s) 会在探测期间阻塞整个主进程（含窗口渲染）
      ps = await new Promise((resolve) => {
        let child;
        let out = '';
        let err = '';
        let settled = false;
        const done = (value) => { if (!settled) { settled = true; resolve(value); } };
        try {
          child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh' -and $_.CommandLine -match '\\sweb(\\s|$)' } | ForEach-Object { $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $_.ProcessId -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -ExpandProperty LocalPort -Unique); [PSCustomObject]@{ pid = $_.ProcessId; ports = $ports; cmd = $_.CommandLine } } | ConvertTo-Json -Compress"
          ], { windowsHide: true });
        } catch {
          return done(null);
        }
        const timer = setTimeout(() => {
          try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
          done(null);
        }, 8000);
        child.stdout.on('data', (c) => { out += c.toString(); });
        child.stderr.on('data', (c) => { err += c.toString(); });
        child.once('error', () => { clearTimeout(timer); done(null); });
        child.once('close', (code) => { clearTimeout(timer); done({ status: code, stdout: out, stderr: err }); });
      });
      if (!ps || ps.status !== 0) return null;
      const raw = String(ps.stdout || '').trim();
      if (!raw) return null;
      const list = JSON.parse(raw);
      const candidates = Array.isArray(list) ? list : [list];
      for (const c of candidates) {
        for (const port of c.ports ?? []) {
          const url = `http://127.0.0.1:${port}/`;
          if (await probeDshUrl(url)) {
            appendLog(`[desktop] 发现已有 dsh web 服务：${url} (pid ${c.pid})，将直接复用，避免双进程并发写会话日志\n`);
            return { url, pid: c.pid };
          }
        }
      }
    } catch (err) {
      appendLog(`[desktop] 检测已有 dsh web 失败：${err}\n`);
    }
    return null;
  })();
}

// ---------- Harness 服务 ----------
function stopHarness() {
  if (startupTimeout) { clearTimeout(startupTimeout); startupTimeout = null; }
  const child = serverProc;
  serverProc = null;
  if (!child) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {}
}
// 在直接修改会话文件（回滚/删除）前，先挂起一切正在写会话日志的 dsh web 进程。
// 否则运行中的服务可能在我们读取/截断后继续追加，造成新消息丢失或 seq 再次断层。
// 除了自己启动的 serverProc，还要清扫“复用的外部 dsh web”以及任何漏网进程：
// 只要有一个进程还持有会话内存并继续 append，截断就会被旧内容补回来。
function killDshWebWritersSync() {
  const pids = new Set();
  if (serverProc?.pid) pids.add(serverProc.pid);
  if (externalServer?.pid) pids.add(externalServer.pid);
  try {
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh' -and $_.CommandLine -match '\\sweb(\\s|$)' } | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId } } | ConvertTo-Json -Compress"
    ], { windowsHide: true, timeout: 8000, encoding: 'utf8' });
    if (ps.status === 0) {
      const raw = String(ps.stdout || '').trim();
      if (raw) {
        const list = JSON.parse(raw);
        for (const c of (Array.isArray(list) ? list : [list])) {
          const pid = Number(c?.pid);
          if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
        }
      }
    }
  } catch (err) {
    appendLog(`[desktop] 清扫 dsh web 进程失败：${err}\n`);
  }
  for (const pid of pids) {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      appendLog(`[desktop] 已终止 dsh web 写入进程 pid=${pid}\n`);
    } catch {}
  }
  externalServer = null;
  serverUrl = null;
}
function suspendHarness() {
  stopHarness();
  killDshWebWritersSync();
}

function startHarness() {
  return new Promise((resolve, reject) => {
    stopHarness();
    const wsDir = workspaceDir();
    try { fs.mkdirSync(wsDir, { recursive: true }); } catch {}
    appendLog(`\n===== ${new Date().toISOString()} dsh web start =====\n`);

    let settled = false;
    let stdoutBuf = '';
    let stderrBuf = '';
    let child;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (startupTimeout) { clearTimeout(startupTimeout); startupTimeout = null; }
      appendLog(`[desktop] startup failed: ${err}\n`);
      reject(err);
    };
    const succeed = (url) => {
      if (settled) return;
      settled = true;
      if (startupTimeout) { clearTimeout(startupTimeout); startupTimeout = null; }
      serverUrl = url;
      appendLog(`[desktop] web ui ready: ${url}\n`);
      resolve(url);
    };

    try {
      child = spawn(nodeExe(), [harnessBin(), '--profile', 'web', '--host', '127.0.0.1', '--port', '0'], {
        cwd: wsDir,
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      fail(err);
      return;
    }
    serverProc = child;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;
      appendLog(text);
      const url = extractUrl(stdoutBuf);
      if (url) succeed(url);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      appendLog(text);
    });
    child.on('error', (err) => fail(err));
    child.on('exit', (code, signal) => {
      const summary = `dsh web 进程已退出 (code=${code}, signal=${signal})`;
      appendLog(`[desktop] ${summary}\n${stderrBuf.slice(-8000)}\n`);
      if (!settled) fail(new Error(`${summary}\n${(stderrBuf || stdoutBuf || '').slice(-4000)}`));
      else if (!quitting && !reloadingHarness) showError(`${summary}\n\n${(stderrBuf || stdoutBuf || '').slice(-2000)}`);
    });

    startupTimeout = setTimeout(() => {
      fail(new Error(`启动超时（180 秒）\n\n${(stderrBuf || stdoutBuf || '').slice(-4000)}`));
      stopHarness();
    }, 180000);
  });
}

// ---------- 窗口 ----------
function isAppUrl(url) {
  return !!serverUrl && (url === serverUrl || url.startsWith(serverUrl + '/'));
}
function showLoading() {
  if (!win) return;
  if (!win.webContents.getURL().includes('loading.html')) {
    win.loadFile(path.join(__dirname, 'app', 'loading.html'));
  }
}
function showError(message) {
  if (!win || win.isDestroyed()) return;
  win.loadFile(path.join(__dirname, 'app', 'error.html'), {
    query: { message: String(message || '未知错误').slice(0, 1800) }
  });
}
function showSoftOverlay(text) {
  if (!win || win.isDestroyed()) return;
  const safe = String(text || '正在应用更改…');
  try {
    win.webContents.executeJavaScript(
      `(() => { let o = document.getElementById('dsh-soft-reload-overlay');
        if (!o) {
          o = document.createElement('div');
          o.id = 'dsh-soft-reload-overlay';
          o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(249,250,251,.88);display:flex;align-items:center;justify-content:center;font:500 14px/20px "Segoe UI","Microsoft YaHei",sans-serif;color:#0f1115';
          document.body && document.body.appendChild(o);
        }
        o.textContent = ${JSON.stringify(safe)};
        o.style.display = 'flex'; })()`
    ).catch(() => {});
  } catch {}
}
function connect() {
  showLoading();
  startHarness()
    .then((url) => { if (win && !win.isDestroyed()) win.loadURL(url); })
    .catch((err) => showError(err && err.message ? err.message : String(err)));
}
// 只重启内置 Harness 并刷新页面，不重启桌面应用本身（用于回滚/插件变更后的生效）。
// soft=true：不切到白鲸加载页，而是在当前页面上盖一层半透明提示层，服务就绪后原地刷新，
// 用于“消息旁回滚”这类高频操作，避免每次都像重新启动应用。
function reloadHarness(options = {}) {
  if (reloadPromise) return reloadPromise;
  reloadPromise = (async () => {
    if (!win || win.isDestroyed()) return { ok: false, msg: '窗口不可用' };
    reloadingHarness = true;
    const soft = options.soft === true;
    if (soft) showSoftOverlay(options.msg || '正在应用更改…');
    else showLoading();
    try {
      // 清扫所有正在写会话日志的 dsh web（含外部复用的服务），保证回滚/删除后内存状态与磁盘一致
      suspendHarness();
      const url = await startHarness();
      if (win && !win.isDestroyed()) win.loadURL(url);
      return { ok: true, msg: soft ? '已在当前窗口刷新' : '已刷新会话' };
    } catch (err) {
      showError(err && err.message ? err.message : String(err));
      return { ok: false, msg: String((err && err.message) || err) };
    } finally {
      reloadingHarness = false;
      reloadPromise = null;
    }
  })();
  return reloadPromise;
}
function runChildUntilClose(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: workspaceDir(), env: process.env, windowsHide: true, stdio: 'ignore' });
    } catch {
      return resolve();
    }
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
        }
      } catch {}
      resolve();
    }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); resolve(); });
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
}
async function ensureDesktopPlugin() {
  // 把“插件与 MCP”设置段插件直接放入 web profile（本地 link 依赖，不访问 npm 注册表）
  const marker = path.join(profileDir(), 'node_modules', 'dsh-desktop-settings', 'package.json');
  if (fs.existsSync(marker)) return true;
  const src = path.join(resourcesRoot(), 'plugins', 'dsh-desktop-settings');
  if (!fs.existsSync(path.join(src, 'package.json'))) return false;

  // profile 尚未初始化时先触发一次初始化（--help 只写 profile，不启动服务）。
  // 用异步 spawn 代替 spawnSync，避免首启时阻塞主进程。
  const manifest = path.join(profileDir(), 'package.json');
  if (!fs.existsSync(manifest)) {
    try {
      await runChildUntilClose(nodeExe(), [harnessBin(), '--profile', 'web', '--help'], 120000);
    } catch (err) { appendLog(`[desktop] profile init: ${err}\n`); }
  }

  const dest = path.join(profileDir(), 'node_modules', 'dsh-desktop-settings');
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true, force: true });

    if (fs.existsSync(manifest)) {
      const j = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      j.dependencies = j.dependencies ?? {};
      j.dependencies['dsh-desktop-settings'] = 'link:' + src.replace(/\\/g, '/');
      const bundles = j.dsh?.profile?.bundles ?? [];
      if (!bundles.includes('dsh-desktop-settings')) bundles.push('dsh-desktop-settings');
      j.dsh = j.dsh ?? {};
      j.dsh.profile = j.dsh.profile ?? {};
      j.dsh.profile.bundles = bundles;
      fs.writeFileSync(manifest, JSON.stringify(j, null, 2));
    }
    appendLog('[desktop] installed dsh-desktop-settings into web profile\n');
    return true;
  } catch (err) {
    appendLog(`[desktop] install settings plugin failed: ${err}\n`);
    return false;
  }
}

function createWindow(options = {}) {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1080, minHeight: 700,
    backgroundColor: '#f9fafb', title: APP_NAME, icon: iconPath(),
    autoHideMenuBar: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, 'app', 'loading.html'), { query: { first: options.firstRun ? '1' : '0' } });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  const wc = win.webContents;
  // F11 全屏只切换窗口全屏，不隐藏 Web 界面任何元素。
  // （此前版本会隐藏会话 header，导致“对话/轨迹”切换、子代理选择、
  //   Token 轨迹分析、Session log 等操作入口在全屏下不可用。）
  wc.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url) && /^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    if (key === 'f11') {
      event.preventDefault();
      if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
    } else if (key === 'escape' && win && !win.isDestroyed() && win.isFullScreen()) {
      event.preventDefault();
      win.setFullScreen(false);
    }
  });
}

// ---------- 桌面扩展：MCP 检测 ----------
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function readYamlSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
function parsePatchMcp(text) {
  const servers = [];
  let block = null;
  const flush = () => {
    if (!block) return;
    if (block.name && block.name.replace(/['"]/g, '') === '@deepseek-ai/dsh-mcp-client' && block.config) {
      servers.push({
        name: block.config.serverName || block.id || 'mcp-client',
        source: 'dsh profile',
        transport: block.config.transport || 'stdio',
        command: block.config.command || '',
        args: block.config.args || [],
        url: block.config.url || ''
      });
    }
  };
  for (const line of text.split(/\r?\n/)) {
    const start = /^\s*- (?:id|insert|name):/.exec(line);
    if (start) { flush(); block = { raw: [] }; }
    if (!block) continue;
    block.raw.push(line);
    let m = /^\s*name:\s*['"]?([^'"]+)['"]?/.exec(line);
    if (m && !block.name) block.name = m[1];
    m = /^\s*id:\s*['"]?([^'"]+)['"]?/.exec(line);
    if (m && !block.id) block.id = m[1];
    if (/^\s*config:\s*$/.test(line)) { block.config = {}; continue; }
    if (!block.config) continue;
    m = /^\s*serverName:\s*['"]?([^'"]+)['"]?/.exec(line);
    if (m) block.config.serverName = m[1];
    m = /^\s*transport:\s*['"]?([^'"]+)['"]?/.exec(line);
    if (m) block.config.transport = m[1];
    m = /^\s*command:\s*['"]?([^'"]+)['"]?/.exec(line);
    if (m) block.config.command = m[1];
    m = /^\s*url:\s*['"]?([^'"]+)['"]?/.exec(line);
    if (m) block.config.url = m[1];
    m = /^\s*args:\s*\[(.*)\]/.exec(line);
    if (m) block.config.args = [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]);
  }
  flush();
  return servers;
}
function commandAvailable(cmd) {
  if (!cmd || cmd.includes(' ')) cmd = cmd.split(/\s+/)[0];
  try {
    const r = spawnSync('where.exe', [cmd], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    return r.status === 0;
  } catch { return false; }
}
function httpReachable(url) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(false); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve(false);
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const sock = net.connect({ host: u.hostname, port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(2500, () => { sock.destroy(); resolve(false); });
  });
}
function scanClientMcp() {
  const clients = [
    ['Claude Desktop', path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')],
    ['Cursor', path.join(os.homedir(), '.cursor', 'mcp.json')],
    ['VS Code', path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'mcp.json')],
    ['Cline', path.join(os.homedir(), '.cline', 'mcp_settings.json')],
    ['Windsurf', path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json')]
  ];
  const servers = [];
  for (const [label, file] of clients) {
    if (!fs.existsSync(file)) continue;
    const cfg = readJsonSafe(file);
    const table = cfg && typeof cfg === 'object' ? (cfg.mcpServers ?? cfg) : null;
    if (!table || typeof table !== 'object') continue;
    for (const [name, def] of Object.entries(table)) {
      if (!def || typeof def !== 'object') continue;
      servers.push({
        name,
        source: label,
        transport: def.url ? 'http' : 'stdio',
        command: typeof def.command === 'string' ? def.command : '',
        args: Array.isArray(def.args) ? def.args : [],
        url: typeof def.url === 'string' ? def.url : ''
      });
    }
  }
  return servers;
}
let mcpCache = null;
async function detectMcp(force = false) {
  // MCP 检测会扫描多个配置并逐个探活（where/http），用 60 秒内存缓存避免设置页反复刷新时重复检测
  const now = Date.now();
  if (!force && mcpCache && now - mcpCache.at < 60 * 1000) return mcpCache.data;
  // 只扫描当前桌面端使用的 web profile：这里配的 MCP 才是本应用真正可调用的
  const servers = [];
  const patchFile = path.join(profileDir(), 'cordis.patch.yml');
  if (fs.existsSync(patchFile)) {
    const found = parsePatchMcp(readYamlSafe(patchFile));
    for (const s of found) s.source = 'dsh profile (web)';
    servers.push(...found);
  }
  for (const s of servers) {
    if (s.transport === 'stdio') s.status = commandAvailable(s.command) ? '可用' : '命令未找到';
    else s.status = (await httpReachable(s.url)) ? '可连接' : '无法连接';
  }
  mcpCache = { at: Date.now(), data: servers };
  return servers;
}

// ---------- 桌面扩展：插件安装（内置 pnpm） ----------
let pluginsCache = null;
function invalidatePluginsCache() { pluginsCache = null; }
function listPlugins() {
  if (pluginsCache) return pluginsCache;
  const manifest = readJsonSafe(path.join(profileDir(), 'package.json')) ?? {};
  pluginsCache = {
    dependencies: Object.keys(manifest.dependencies ?? {}),
    bundles: manifest.dsh?.profile?.bundles ?? []
  };
  return pluginsCache;
}
// 包名/安装源安全校验：npm 包名、github: 源、GitHub https 归档直链
function isValidPkgSpec(pkg) {
  if (typeof pkg !== 'string') return false;
  if (/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(pkg)) return true;
  if (/^github:[A-Za-z0-9._-]+\/[A-Za-z0-9._~#-]+$/i.test(pkg)) return true;
  return /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/archive\/refs\/heads\/[A-Za-z0-9._-]+\.tar\.gz$/i.test(pkg);
}
function isNpmPkgName(pkg) {
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(pkg || '');
}
// 带超时与单次结算保护的子进程运行：pnpm 卡死时杀掉进程树并返回失败，避免 UI 永久转圈
function runPluginChild(mode, pkg, env, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    let settled = false;
    let timer = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(nodeExe(), [harnessBin(), 'plugin', '--profile', 'web', mode, pkg], {
        cwd: workspaceDir(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      return done({ ok: false, log: String(e) });
    }
    timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
        }
      } catch {}
      done({ ok: false, log: `${out}\n${err}`.trim() + `\n（${mode} 超时，已终止）` });
    }, timeoutMs);
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', (e) => done({ ok: false, log: String(e) }));
    child.on('close', (code) => done({ ok: code === 0, log: `${out}\n${err}`.trim() }));
  });
}
// 安装的是 bundle 插件时，把它加入 dsh.profile.bundles，否则重启后 bundle 层不会生效
function syncBundleAfterInstall(pkg, result) {
  if (!isNpmPkgName(pkg)) return result;
  try {
    const pkgManifestPath = path.join(profileDir(), 'node_modules', pkg, 'package.json');
    if (!fs.existsSync(pkgManifestPath)) return result;
    const pkgManifest = JSON.parse(fs.readFileSync(pkgManifestPath, 'utf8'));
    if (!pkgManifest.dsh?.bundle?.patch) return result;
    const manifestPath = path.join(profileDir(), 'package.json');
    if (!fs.existsSync(manifestPath)) return result;
    const j = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const bundles = Array.isArray(j.dsh?.profile?.bundles) ? j.dsh.profile.bundles : [];
    if (!bundles.includes(pkg)) {
      bundles.push(pkg);
      j.dsh = j.dsh ?? {};
      j.dsh.profile = j.dsh.profile ?? {};
      j.dsh.profile.bundles = bundles;
      fs.writeFileSync(manifestPath, JSON.stringify(j, null, 2));
      result.bundleChanged = true;
      result.log += '\n（检测到 dsh.bundle，已启用 bundle 层）';
    }
  } catch (e) {
    result.log += '\n（启用 bundle 层失败：' + String(e && e.message || e) + '）';
  }
  return result;
}
// 卸载时同步移除 bundles 引用，否则 harness 下次启动会因无法解析 bundle 而失败
function syncBundleAfterUninstall(pkg, result) {
  if (!isNpmPkgName(pkg)) return result;
  try {
    const manifestPath = path.join(profileDir(), 'package.json');
    if (!fs.existsSync(manifestPath)) return result;
    const j = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const bundles = Array.isArray(j.dsh?.profile?.bundles) ? j.dsh.profile.bundles : [];
    if (bundles.includes(pkg)) {
      j.dsh = j.dsh ?? {};
      j.dsh.profile = j.dsh.profile ?? {};
      j.dsh.profile.bundles = bundles.filter((b) => b !== pkg);
      fs.writeFileSync(manifestPath, JSON.stringify(j, null, 2));
      result.bundleChanged = true;
      result.log += '\n（已从 dsh.profile.bundles 移除）';
    }
  } catch (e) {
    result.log += '\n（更新 bundles 失败：' + String(e && e.message || e) + '）';
  }
  return result;
}
function pnpmEnv() {
  // 优先使用系统 pnpm（与 profile 现有 node_modules 的 store 版本一致），
  // 没有 pnpm 时回退到内置 pnpm 11（新机器首次安装走这条路径）。
  const hasSystemPnpm = (() => {
    try { return spawnSync('where.exe', ['pnpm'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }).status === 0; }
    catch { return false; }
  })();
  return hasSystemPnpm
    ? { ...process.env }
    : { ...process.env, PATH: runtimeDir() + path.delimiter + (process.env.PATH || '') };
}
// 插件任务在主进程独立运行：关闭设置窗口/页面不会取消任务；所有窗口关闭时延迟退出，任务完成后再退出。
const pluginJobs = new Map();
let pluginJobCount = 0;
let quitDeferredForPluginJobs = false;
function pluginJobStatusList() {
  return [...pluginJobs.values()].map((job) => ({ ...job, log: String(job.log || '').slice(-4000) }));
}
function trackPluginJob(mode, pkg, task) {
  const id = `${mode}:${pkg}:${Date.now()}`;
  const job = { id, mode, pkg, startedAt: Date.now(), status: 'running', log: '' };
  pluginJobs.set(id, job);
  pluginJobCount++;
  appendLog(`[desktop] plugin ${mode} 开始：${pkg}\n`);
  return Promise.resolve()
    .then(() => task(job))
    .then((result) => {
      job.status = result && result.ok ? 'done' : 'error';
      job.log = String((result && result.log) || '');
      appendLog(`[desktop] plugin ${mode} ${job.status}：${pkg}\n${job.log.slice(-1200)}\n`);
      return result;
    })
    .finally(() => {
      pluginJobCount--;
      invalidatePluginsCache(); // 安装/卸载都会改 profile 依赖清单，内存缓存立即失效
      // 保留最近记录 60 秒，重开设置页能看到“刚刚完成/仍在进行”的状态
      setTimeout(() => pluginJobs.delete(id), 60000);
      if (pluginJobCount === 0 && quitDeferredForPluginJobs && BrowserWindow.getAllWindows().length === 0) {
        app.quit();
      }
    });
}
// github: 等非 npm 名安装成功后，从 profile 依赖里反查真实包名，确保 bundle 层被登记
function installedNameForSpec(pkg) {
  try {
    const manifest = readJsonSafe(path.join(profileDir(), 'package.json'));
    const deps = manifest?.dependencies ?? {};
    for (const [name, spec] of Object.entries(deps)) {
      if (spec === pkg) return name;
    }
  } catch {}
  return null;
}
function installPlugin(pkg) {
  if (!isValidPkgSpec(pkg)) {
    return Promise.resolve({ ok: false, log: '包名格式不正确' });
  }
  return trackPluginJob('add', pkg, async () => {
    const result = await runPluginChild('add', pkg, pnpmEnv(), 300000);
    if (!result.ok) return result;
    // 包名不是 npm 名（github:/https 归档）时按写入 profile 的实际包名登记 bundle 层
    const name = isNpmPkgName(pkg) ? pkg : installedNameForSpec(pkg);
    if (name) return syncBundleAfterInstall(name, result);
    return result;
  });
}
function uninstallPlugin(pkg) {
  if (!isValidPkgSpec(pkg)) {
    return Promise.resolve({ ok: false, log: '包名格式不正确' });
  }
  return trackPluginJob('remove', pkg, async () => {
    let result = await runPluginChild('remove', pkg, pnpmEnv(), 300000);
    if (!result.ok) {
      // 失败多为运行中的 Harness 占用 node_modules 文件：挂起服务重试一次，然后恢复服务
      suspendHarness();
      const retry = await runPluginChild('remove', pkg, pnpmEnv(), 300000);
      if (retry.ok) {
        result = retry;
        result.log = String(result.log || '') + '\n（首次卸载失败，已暂停 Harness 后重试成功）';
      }
      reloadHarness({ soft: true, msg: '正在恢复服务…' }).catch(() => {});
    }
    return syncBundleAfterUninstall(pkg, result);
  });
}

// ---------- 桌面扩展：更新检查 ----------
function bundledVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(harnessDir(), 'package.json'), 'utf8')).version || '未知'; }
  catch { return '未知'; }
}
function compareSemver(a, b) {
  const parse = (v) => {
    const m = String(v).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!m) return null;
    return { core: [+m[1], +m[2], +m[3]], pre: m[4] ?? '' };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i] ? 1 : -1;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1; // 正式版高于同版本号的预发布版
  if (!pb.pre) return -1;
  const sa = pa.pre.split('.');
  const sb = pb.pre.split('.');
  const n = Math.max(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const x = sa[i] ?? '';
    const y = sb[i] ?? '';
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) > Number(y) ? 1 : -1;
    if (nx) return -1;
    if (ny) return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
let updateCache = null;
function checkUpdate(force = false) {
  const now = Date.now();
  if (!force && updateCache && now - updateCache.at < 5 * 60 * 1000) return Promise.resolve(updateCache.value);
  return new Promise((resolve) => {
    const current = bundledVersion();
    const req = https.get('https://registry.npmmirror.com/@deepseek-ai/dsh/latest', { timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const latest = JSON.parse(body).version || '未知';
          const newer = typeof latest === 'string' && latest !== '未知' && compareSemver(latest, current) > 0;
          const value = { current, latest, newer };
          updateCache = { at: Date.now(), value };
          resolve(value);
        } catch {
          resolve({ current, latest: '未知', newer: false });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ current, latest: null, newer: false, error: String(e) }));
  });
}

// ---------- 桌面扩展：插件市场（awesome-dsh-plugin） ----------
function fetchText(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    if (u.protocol !== 'https:') return reject(new Error('only https'));
    const req = https.get(u, { headers: { 'user-agent': 'dsh-desktop' }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        let next;
        try {
          next = new URL(res.headers.location, u).toString();
        } catch (e) {
          return reject(new Error(`invalid redirect location: ${e && e.message || e}`));
        }
        return resolve(fetchText(next, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
let marketPromise = null;
let marketFetchedAt = 0;
const MARKET_CACHE_MS = 5 * 60 * 1000;
function parseMarketMd(md) {
  const groups = [];
  const items = [];
  let category = '其他';
  for (const line of md.split(/\r?\n/)) {
    const cat = /^###\s+(.*)$/.exec(line);
    if (cat) { category = cat[1].trim(); continue; }
    const item = /^-\s*\[([^\]]+)\]\(([^)]+)\)\s*—\s*(.*)$/.exec(line);
    if (!item) continue;
    const [, label, url, desc] = item;
    if (!/^https?:\/\//.test(url)) continue;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(label.trim())) continue;
    items.push({ repo: label.trim(), url, desc: desc.trim(), category });
  }
  for (const item of items) {
    const g = groups.find((x) => x.category === item.category);
    if (g) g.items.push(item); else groups.push({ category: item.category, items: [item] });
  }
  return groups;
}
function getMarketList(force = false) {
  const stale = Date.now() - marketFetchedAt > MARKET_CACHE_MS;
  if (!marketPromise || force || stale) {
    marketPromise = fetchText('https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/README.zh.md')
      .then((md) => {
        const groups = parseMarketMd(md);
        marketFetchedAt = Date.now();
        return { total: groups.reduce((n, g) => n + g.items.length, 0), groups, source: 'remote', fetchedAt: new Date().toISOString() };
      })
      .catch(() => {
        // 失败不缓存成功时间，并清空 promise：下次调用（刷新按钮）会重新尝试远程
        marketPromise = null;
        marketFetchedAt = 0;
        const bundled = path.join(__dirname, 'app', 'awesome-dsh-plugin.zh.md');
        const md = fs.existsSync(bundled) ? fs.readFileSync(bundled, 'utf8') : '';
        const groups = parseMarketMd(md);
        return { total: groups.reduce((n, g) => n + g.items.length, 0), groups, source: 'bundled', fetchedAt: new Date().toISOString() };
      });
  }
  return marketPromise;
}
const repoPkgCache = new Map();
async function resolveRepoPkg(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')) throw new Error('仓库名格式不正确');
  if (repoPkgCache.has(repo)) return repoPkgCache.get(repo);
  let lastErr;
  for (const branch of ['main', 'master']) {
    try {
      const url = `https://raw.githubusercontent.com/${repo}/${branch}/package.json`;
      const text = await fetchText(url);
      const pkg = JSON.parse(text).name;
      if (pkg) { const info = { name: pkg, branch }; repoPkgCache.set(repo, info); return info; }
    } catch (e) { lastErr = e; }
  }
  throw new Error(`无法从仓库 ${repo} 解析 npm 包名：${lastErr?.message || '未找到 package.json'}`);
}

// ---------- 桌面扩展：会话日志修复 ----------
const ZSTD_MAGIC = 4247762216;
function scanZstdFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    // 尾部残缺（torn tail）是崩溃后的正常形态：与 harness 的读取语义一致，
    // 忽略未写完的最后一帧，仅返回已完整提交的帧，由后续修复/回滚据此截断。
    if (buf.length - offset < 4) break;
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at ${offset}`);
    offset += 4;
    if (buf.length - offset < 1) break;
    const descriptor = buf.readUInt8(offset++);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buf.length - offset < headerBytes) break;
    offset += headerBytes;
    let complete = true;
    for (;;) {
      if (buf.length - offset < 3) { complete = false; break; }
      const blockHeader = buf.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('reserved block type');
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buf.length - offset < payloadBytes) { complete = false; break; }
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (!complete) break;
    if (checksum) {
      if (buf.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}
function sessionPlaintext(buf) {
  const zlib = require('zlib');
  return Buffer.concat(scanZstdFrames(buf).map((f) => zlib.zstdDecompressSync(buf.subarray(f.start, f.end))));
}
const CHUNK_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);
function chunkCount(node) {
  if (!node || typeof node !== 'object' || !CHUNK_TYPES.has(node.type)) return 0;
  const members = node.type === 'tool-call-chunks' ? node.data?.args : node.data?.texts;
  return Array.isArray(members) ? members.length : 0;
}
function sessionRowSeqs(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  if (CHUNK_TYPES.has(parsed.type)) {
    const n = chunkCount(parsed);
    return typeof parsed.seq0 === 'number' ? Array.from({ length: n }, (_, k) => parsed.seq0 + k) : [];
  }
  return typeof parsed.seq === 'number' ? [parsed.seq] : [];
}
// 收集一行里所有 seq/seq0 数字（chunk 行展开成每个 seq），用于 old→new 全量重映射
function collectSeqNumbers(node, out, seen) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const x of node) collectSeqNumbers(x, out, seen); return out; }
  const push = (v) => { if (!seen.has(v)) { seen.add(v); out.push(v); } };
  if (typeof node.seq === 'number') push(node.seq);
  if (CHUNK_TYPES.has(node.type) && typeof node.seq0 === 'number') {
    const n = chunkCount(node);
    for (let k = 0; k < n; k++) push(node.seq0 + k);
  } else if (typeof node.seq0 === 'number') {
    push(node.seq0);
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') collectSeqNumbers(v, out, seen);
  return out;
}
function remapSeqs(node, map) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) { for (const x of node) remapSeqs(x, map); return node; }
  if (typeof node.seq === 'number' && map.has(node.seq)) node.seq = map.get(node.seq);
  if (typeof node.seq0 === 'number' && map.has(node.seq0)) node.seq0 = map.get(node.seq0);
  if (Array.isArray(node.sourceEventSeqs)) {
    node.sourceEventSeqs = node.sourceEventSeqs.map((r) => (Number.isSafeInteger(r) && map.has(r) ? map.get(r) : r));
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') remapSeqs(v, map);
  return node;
}
function refProblem(parsed) {
  const raw = parsed?.sourceEventSeqs;
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return 'sourceEventSeqs 不是数组';
  if (raw.length === 0 && parsed.type !== 'assistant/message') return 'sourceEventSeqs 为空';
  const set = new Set();
  for (const r of raw) {
    if (!Number.isSafeInteger(r) || r < 0) return `sourceEventSeqs 含非法值 ${r}`;
    if (set.has(r)) return `sourceEventSeqs 重复 ${r}`;
    set.add(r);
  }
  const own = typeof parsed.seq === 'number' ? parsed.seq : (typeof parsed.seq0 === 'number' ? parsed.seq0 : null);
  if (own !== null) {
    const bad = raw.find((r) => r >= own);
    if (bad !== undefined) return `sourceEventSeqs ${bad} >= 当前 seq ${own}`;
  }
  return null;
}
function sanitizeRefs(parsed, dropped) {
  const raw = parsed?.sourceEventSeqs;
  if (!Array.isArray(raw)) return;
  const own = typeof parsed.seq === 'number' ? parsed.seq : (typeof parsed.seq0 === 'number' ? parsed.seq0 : null);
  const clean = [];
  const seen = new Set();
  for (const r of raw) {
    if (!Number.isSafeInteger(r) || r < 0) { dropped.push(`非法 ${r}`); continue; }
    if (own !== null && r >= own) { dropped.push(`越界 ${r}>=${own}`); continue; }
    if (seen.has(r)) { dropped.push(`重复 ${r}`); continue; }
    seen.add(r);
    clean.push(r);
  }
  if (clean.length === 0 && parsed.type !== 'assistant/message' && own !== null && own > 0) clean.push(own - 1);
  parsed.sourceEventSeqs = clean;
}
function verifySessionLines(lines) {
  let expected = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    let p;
    try { p = JSON.parse(lines[i]); } catch { return `line ${i} 无法解析`; }
    const s = sessionRowSeqs(p);
    if (s.length && s[0] !== expected) return `line ${i}: seq 不连续（期望 ${expected}，实际 ${s[0]}）`;
    if (s.length) expected = s[s.length - 1] + 1;
    const rp = refProblem(p);
    if (rp) return `line ${i}: ${rp}`;
  }
  return null;
}
function repairSessionFile(file) {
  try {
    const zlib = require('zlib');
    const buf = fs.readFileSync(file);
    if (buf.length === 0) return { ok: false, msg: '文件为空' };
    const frames = scanZstdFrames(buf);
    if (frames.length === 0) return { ok: false, msg: '没有完整的 zstd 帧（头部残缺）' };
    const torn = frames[frames.length - 1].end < buf.length;
    const plain = Buffer.concat(frames.map((f) => zlib.zstdDecompressSync(buf.subarray(f.start, f.end))));
    const lines = plain.toString('utf8').split('\n');
    const problem = verifySessionLines(lines);
    if (!problem && !torn) return { ok: true, repaired: false, msg: '会话日志完整，无需修复' };

    // 全量重映射：所有 seq/seq0 按行序重排为 0..N-1，sourceEventSeqs 同步映射，
    // 剩余非法/越界引用剔除（assistant/message 允许为空，其余回退引用前一条事件）。
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      let p;
      try { p = JSON.parse(lines[i]); } catch (e) { return { ok: false, msg: `line ${i} 无法解析` }; }
      rows.push({ i, p });
    }
    const map = new Map();
    const seen = new Set();
    let next = 0;
    for (const { p } of rows) {
      for (const v of collectSeqNumbers(p, [], seen)) if (!map.has(v)) map.set(v, next++);
    }
    const dropped = [];
    for (const { p } of rows) {
      remapSeqs(p, map);
      sanitizeRefs(p, dropped);
    }
    const header = lines[0] || '';
    const fixed = header + '\n' + rows.map((r) => JSON.stringify(r.p)).join('\n') + '\n';
    const after = verifySessionLines(fixed.split('\n'));
    if (after) return { ok: false, msg: `修复后校验失败：${after}` };

    const headerEnd = fixed.indexOf('\n');
    const opts = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
    const out = Buffer.concat([
      zlib.zstdCompressSync(Buffer.from(fixed.slice(0, headerEnd + 1), 'utf8'), opts),
      zlib.zstdCompressSync(Buffer.from(fixed.slice(headerEnd + 1), 'utf8'), opts)
    ]);
    const backup = `${file}.bak-${Date.now()}`;
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, out);
    return { ok: true, repaired: true, msg: `已修复（${problem || '尾部帧残缺，已截断'}；剔除非法引用 ${dropped.length} 个），备份：${backup}` };
  } catch (e) {
    return { ok: false, msg: String(e && e.message || e) };
  }
}
async function repairAllSessions() {
  const root = path.join(dshHome(), 'sessions');
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name === 'session.jsonl.zstd') files.push(p);
    }
  };
  if (fs.existsSync(root)) walk(root);
  const results = [];
  // 每处理一个文件就让出一次主线程，避免大量会话的同步解压把 UI 长时间卡死
  for (const file of files) {
    results.push(repairSessionFile(file));
    await new Promise((resolve) => setImmediate(resolve));
  }
  return results;
}
// 启动自动修复：必须在 harness 启动之前执行，避免运行中的进程按旧 seq 继续写入再次产生断层
async function autoRepairSessions() {
  const results = await repairAllSessions();
  let repaired = 0;
  for (const r of results) {
    if (r.ok && r.repaired) { repaired++; appendLog(`[desktop] auto-repair: ${r.msg}\n`); }
    else if (!r.ok) appendLog(`[desktop] auto-repair failed: ${r.msg}\n`);
  }
  return { repaired, results };
}

// ---------- 桌面扩展：对话回滚 ----------
function walkSessionFiles(cb) {
  const root = path.join(dshHome(), 'sessions');
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name === 'session.jsonl.zstd') cb(p);
    }
  };
  if (fs.existsSync(root)) walk(root);
}
function lastSplicedIndex(lines) {
  let last = -1;
  for (let i = lines.length - 1; i >= 1; i--) {
    let p;
    try { p = JSON.parse(lines[i]); } catch { continue; }
    if (p && p.type === 'agent/inbox/spliced' && Array.isArray(p.data?.inserted) && p.data.inserted.length > 0) {
      last = i;
      break;
    }
  }
  return last;
}
function userTextFromLine(line) {
  try {
    const p = JSON.parse(line);
    const inserted = p?.data?.inserted ?? [];
    const texts = [];
    for (const item of inserted) {
      for (const c of item?.content ?? []) if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text);
    }
    return texts.join(' ').slice(0, 120);
  } catch { return ''; }
}
// 会话列表改为后台异步扫描 + 缓存：旧实现每次在 IPC 里同步读取/解压全部
// session.jsonl.zstd，文件多时会把 Electron 主进程整段卡死（设置页“加载数据…”）。
// 现在：启动时后台预热缓存；设置页首次打开等待在途扫描；每处理 3 个文件让出主线程；
// 后续打开直接读缓存，点“刷新”才强制重扫。
let sessionListsCache = null;
let sessionScanPromise = null;
function scanSessionListsAsync(force = false) {
  if (sessionScanPromise) return sessionScanPromise;
  if (!force && sessionListsCache) return Promise.resolve(sessionListsCache);
  sessionScanPromise = (async () => {
    const rollback = [];
    const del = [];
    const files = [];
    walkSessionFiles((file) => files.push(file));
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const buf = fs.readFileSync(file);
        const lines = sessionPlaintext(buf).toString('utf8').split('\n');
        const header = JSON.parse(lines[0]);
        const idx = lastSplicedIndex(lines);
        const item = {
          file,
          id: header.id ?? path.basename(path.dirname(file)),
          cwd: header.cwd ?? '',
          lastUserText: idx === -1 ? '' : userTextFromLine(lines[idx]),
          time: idx === -1 ? '' : (() => { try { return new Date(JSON.parse(lines[idx]).time).toLocaleString(); } catch { return ''; } })()
        };
        if (idx !== -1) rollback.push(item);
        del.push(item);
      } catch {}
      if (i % 3 === 2) await new Promise((resolve) => setImmediate(resolve)); // 让出主线程，保持界面响应
    }
    sessionListsCache = { rollback, del, at: Date.now() };
    return sessionListsCache;
  })().finally(() => { sessionScanPromise = null; });
  return sessionScanPromise;
}
// 删除整个会话：把 session 目录移入 ~/.dsh/sessions-trash（可找回），不从磁盘抹除
function deleteSessionFile(file) {
  let suspended = false;
  try {
    const root = path.join(dshHome(), 'sessions');
    if (!file.startsWith(root + path.sep)) return { ok: false, msg: '文件不在会话目录内' };
    const dir = path.dirname(file);
    if (!path.basename(dir).startsWith('session-')) return { ok: false, msg: '无法识别的会话目录' };
    // 先停掉正在写会话日志的服务，避免 rename 后旧句柄继续写入 / 新消息丢失
    suspendHarness();
    suspended = true;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rel = path.relative(root, dir);
    const trashDir = path.join(dshHome(), 'sessions-trash', stamp);
    const dest = path.join(trashDir, rel);
    // 会话目录是 <项目>/<session-id> 两层结构：必须把中间的项目目录也建出来
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(dir, dest);
    sessionListsCache = null; // 会话已删除，缓存失效
    return { ok: true, msg: `已删除会话（已移入回收目录：${path.join('sessions-trash', stamp, rel)}）` };
  } catch (e) {
    if (suspended) connect();
    return { ok: false, msg: String(e && e.message || e) };
  }
}
function reverseEditsFrom(lines, startIdx, cwd) {
  // 收集被回滚轮次里的文件操作：
  // 1) edit / str_replace_editor：逆向替换 new_str -> old_str
  // 2) write 且结果是 Created file：文件是本轮新建的，回滚时移入回收目录
  const editOps = [];
  const createdOps = [];
  let lastCall = null;
  for (let i = startIdx; i < lines.length; i++) {
    let p;
    try { p = JSON.parse(lines[i]); } catch { continue; }
    if (p?.type === 'tool/call') {
      lastCall = p;
      continue;
    }
    if (p?.type === 'tool/result' && lastCall) {
      const name = String(lastCall.data?.name ?? '').toLowerCase();
      const isEdit = name.includes('str_replace') || name.includes('edit');
      const isWrite = name === 'write';
      if (!isEdit && !isWrite) continue;
      let args;
      try { args = JSON.parse(lastCall.data?.arguments); } catch { continue; }
      const file = args?.file_path || args?.filePath || args?.path;
      if (!file) continue;
      const resultText = JSON.stringify(p.data?.message ?? '');
      if (isEdit && typeof args.old_str === 'string' && typeof args.new_str === 'string') {
        editOps.push({ file, oldStr: args.old_str, newStr: args.new_str });
      } else if (isWrite && typeof args.content === 'string' && /Created file/.test(resultText)) {
        createdOps.push({ file, content: args.content });
      }
    }
  }
  return { editOps: editOps.reverse(), createdOps: createdOps.reverse() };
}
function applyReverseEdits(ops, cwd) {
  const restored = [];
  const createdRemoved = [];
  const trashRoot = path.join(dshHome(), 'rollback-trash');
  for (const e of ops.editOps) {
    const abs = path.isAbsolute(e.file) ? e.file : path.join(cwd || process.cwd(), e.file);
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      const content = fs.readFileSync(abs, 'utf8');
      if (!content.includes(e.newStr)) continue;
      // 只有当 new_str 在文件里唯一出现时才回退：全量替换会在重复文本处误改其他位置
      if (content.split(e.newStr).length !== 2) continue;
      const reverted = content.replace(e.newStr, e.oldStr);
      if (reverted === content) continue;
      fs.writeFileSync(abs, reverted, 'utf8');
      restored.push(e.file);
    } catch {}
  }
  for (const c of ops.createdOps) {
    const abs = path.isAbsolute(c.file) ? c.file : path.join(cwd || process.cwd(), c.file);
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      if (fs.readFileSync(abs, 'utf8') !== c.content) continue; // 文件已被后续修改，不删
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const destDir = path.join(trashRoot, stamp);
      fs.mkdirSync(destDir, { recursive: true });
      const rel = path.relative(cwd || process.cwd(), abs).replace(/[\\/:*?"<>|]/g, '_');
      fs.renameSync(abs, path.join(destDir, rel));
      createdRemoved.push(e.file);
    } catch {}
  }
  return { restored: [...new Set(restored)], createdRemoved };
}
function performRollback(file, idx, options = {}) {
  // 截断会话文件前必须挂起写入方：回滚期间继续追加会在截断处产生 seq 断层/丢消息。
  // 热回滚路径已在宿主插件内先收缩了内存日志，之后没有活跃写入者，可跳过挂起（suspend:false）。
  if (options.suspend !== false) suspendHarness();
  const buf = fs.readFileSync(file);
  const lines = sessionPlaintext(buf).toString('utf8').split('\n');
  const header = JSON.parse(lines[0]);
  const ops = reverseEditsFrom(lines, idx, header.cwd || '');
  // keepTargetSplice：联动回滚“到消息 M”时保留 M 这条用户消息本身，只删掉 M 之后的内容
  const fixedText = (options.keepTargetSplice ? lines.slice(0, idx + 1) : lines.slice(0, idx)).join('\n') + '\n';
  const headerEnd = fixedText.indexOf('\n');
  const zlib = require('zlib');
  const opts = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
  const out = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(fixedText.slice(0, headerEnd + 1), 'utf8'), opts),
    zlib.zstdCompressSync(Buffer.from(fixedText.slice(headerEnd + 1), 'utf8'), opts)
  ]);
  const backup = `${file}.bak-${Date.now()}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, out);
  sessionListsCache = null; // 会话内容已变，下一次打开设置页用新数据
  const undo = applyReverseEdits(ops, header.cwd || '');
  const parts = [];
  if (undo.restored.length) parts.push(`撤销了 ${undo.restored.length} 个文件修改：${undo.restored.join('、')}`);
  if (undo.createdRemoved.length) parts.push(`移除了 ${undo.createdRemoved.length} 个本轮新建文件：${undo.createdRemoved.join('、')}`);
  const filesMsg = parts.length ? `，${parts.join('；')}` : '';
  return { ok: true, msg: `已回滚到该轮之前${filesMsg}，备份：${backup}` };
}
function rollbackSession(file) {
  try {
    const root = path.join(dshHome(), 'sessions');
    if (!file.startsWith(root + path.sep)) return { ok: false, msg: '文件不在会话目录内' };
    suspendHarness(); // 读取到写入之间保持稳定快照
    const buf = fs.readFileSync(file);
    const lines = sessionPlaintext(buf).toString('utf8').split('\n');
    const idx = lastSplicedIndex(lines);
    if (idx === -1) {
      connect();
      return { ok: false, msg: '未找到可回滚的用户消息' };
    }
    return performRollback(file, idx);
  } catch (e) {
    connect();
    return { ok: false, msg: String(e && e.message || e) };
  }
}
function findSessionFile(sessionId) {
  let found = null;
  walkSessionFiles((file) => {
    try {
      const header = JSON.parse(sessionPlaintext(fs.readFileSync(file)).toString('utf8').split('\n')[0]);
      if (header.id === sessionId) found = file;
    } catch {}
  });
  return found;
}
function rollbackSessionByMessage(sessionId, messageId) {
  try {
    const file = findSessionFile(sessionId);
    if (!file) return { ok: false, msg: `未找到会话 ${sessionId}` };
    const buf = fs.readFileSync(file);
    const lines = sessionPlaintext(buf).toString('utf8').split('\n');
    let messageLine = -1;
    for (let i = lines.length - 1; i >= 1; i--) {
      let p;
      try { p = JSON.parse(lines[i]); } catch { continue; }
      if (p?.type === 'assistant/message' && (p.data?.message?.id === messageId || p.id === messageId || p.data?.messageId === messageId)) {
        messageLine = i;
        break;
      }
    }
    if (messageLine === -1) return { ok: false, msg: '未找到该消息' };
    // 找到这条消息之前最近的一条用户消息，从那里截断
    let idx = -1;
    for (let i = messageLine - 1; i >= 1; i--) {
      let p;
      try { p = JSON.parse(lines[i]); } catch { continue; }
      if (p?.type === 'agent/inbox/spliced' && Array.isArray(p.data?.inserted) && p.data.inserted.length > 0) { idx = i; break; }
    }
    if (idx === -1) return { ok: false, msg: '未找到对应的用户消息' };
    try {
      return performRollback(file, idx);
    } catch (e) {
      connect(); // performRollback 已挂起服务，失败时必须恢复
      return { ok: false, msg: String(e && e.message || e) };
    }
  } catch (e) {
    return { ok: false, msg: String(e && e.message || e) };
  }
}
// 从 user/message 事件 data 提取纯文本，用于回滚成功后回填输入框
function userMessageText(p) {
  try {
    const content = p?.data?.content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((c) => c && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
      .slice(0, 4000);
  } catch { return ''; }
}
// 长按用户消息 → 撤销回滚：先定位 user/message（data.id === 用户消息 id），
// 再回溯到把它插入 inbox 的那条 agent/inbox/spliced，从该处截断并还原文件修改。
function rollbackSessionByUserMessage(sessionId, userMessageId, keepTarget = false) {
  try {
    const file = findSessionFile(sessionId);
    if (!file) return { ok: false, msg: `未找到会话 ${sessionId}` };
    const lines = sessionPlaintext(fs.readFileSync(file)).toString('utf8').split('\n');
    let userLine = -1;
    let userText = '';
    for (let i = lines.length - 1; i >= 1; i--) {
      let p;
      try { p = JSON.parse(lines[i]); } catch { continue; }
      if (p?.type === 'user/message' && p.data?.id === userMessageId) { userLine = i; userText = userMessageText(p); break; }
    }
    if (userLine === -1) return { ok: false, msg: '未找到该用户消息' };
    let idx = -1;
    for (let i = userLine - 1; i >= 1; i--) {
      let p;
      try { p = JSON.parse(lines[i]); } catch { continue; }
      if (p?.type === 'agent/inbox/spliced' && Array.isArray(p.data?.inserted) && p.data.inserted.some((m) => m?.id === userMessageId)) { idx = i; break; }
    }
    if (idx === -1) {
      // 兜底：取该消息之前最近的一条非空 inbox splice
      for (let i = userLine - 1; i >= 1; i--) {
        let p;
        try { p = JSON.parse(lines[i]); } catch { continue; }
        if (p?.type === 'agent/inbox/spliced' && Array.isArray(p.data?.inserted) && p.data.inserted.length > 0) { idx = i; break; }
      }
    }
    if (idx === -1) return { ok: false, msg: '未找到该消息的 inbox 记录' };
    try {
      const result = performRollback(file, idx, { keepTargetSplice: keepTarget });
      if (userText) result.userMessage = userText; // 回滚成功的消息文本，UI 用于回填输入框
      return result;
    } catch (e) {
      connect(); // performRollback 已挂起服务，失败时必须恢复
      return { ok: false, msg: String(e && e.message || e) };
    }
  } catch (e) {
    return { ok: false, msg: String(e && e.message || e) };
  }
}

// ---------- 无感回滚（不重启 Harness / 不重启程序）----------
// 宿主插件先把运行中 Session 的内存日志收缩（/enh/truncate-session），
// 这里再同步截断磁盘文件并原地刷新当前页面；失败时返回 null 由调用方走兜底路径。
function requestHotTruncate(sessionId, messageId) {
  if (!serverUrl) return Promise.resolve(null);
  const target = `${serverUrl}/enh/truncate-session?sessionId=${encodeURIComponent(sessionId)}&messageId=${encodeURIComponent(messageId)}`;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = http.get(target, { timeout: 4000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c.toString(); if (body.length > 40000) req.destroy(); });
        res.on('end', () => { try { done(JSON.parse(body)); } catch { done(null); } });
        res.on('error', () => done(null));
      });
      req.on('error', () => done(null));
      req.on('timeout', () => { req.destroy(); done(null); });
    } catch { done(null); }
  });
}
// 把被撤销的消息文本暂存到页面 localStorage：刷新后由客户端插件回填输入框
function stashRollbackMessage(text) {
  if (!text || !win || win.isDestroyed()) return;
  try {
    const safe = JSON.stringify(String(text));
    win.webContents
      .executeJavaScript(`try{localStorage.setItem('dsh-rollback-last-message',${safe});localStorage.setItem('dsh-rollback-last-message-at',String(Date.now()));}catch{}`)
      .catch(() => {});
  } catch {}
}
async function hotRollbackSessionByUserMessage(sessionId, userMessageId) {
  const hot = await requestHotTruncate(sessionId, userMessageId);
  if (!hot || hot.ok !== true) return null;
  try {
    const file = findSessionFile(sessionId);
    if (!file) return null;
    const lines = sessionPlaintext(fs.readFileSync(file)).toString('utf8').split('\n');
    let userLine = -1;
    let userText = '';
    for (let i = lines.length - 1; i >= 1; i--) {
      let p;
      try { p = JSON.parse(lines[i]); } catch { continue; }
      if (p?.type === 'user/message' && p.data?.id === userMessageId) { userLine = i; userText = userMessageText(p); break; }
    }
    if (userLine === -1) return null;
    let idx = -1;
    for (let i = userLine - 1; i >= 1; i--) {
      let p;
      try { p = JSON.parse(lines[i]); } catch { continue; }
      if (p?.type === 'agent/inbox/spliced' && Array.isArray(p.data?.inserted) && p.data.inserted.some((m) => m?.id === userMessageId)) { idx = i; break; }
    }
    if (idx === -1) return null;
    // 内存日志已收缩，磁盘截断不再挂起服务；反向撤销该轮文件修改照旧执行
    const result = performRollback(file, idx, { keepTargetSplice: false, suspend: false });
    if (userText) result.userMessage = userText;
    appendLog(`[desktop] 热回滚(${sessionId}/${userMessageId}): ${result.msg}\n`);
    stashRollbackMessage(userText);
    if (win && !win.isDestroyed()) {
      try { win.webContents.reload(); } catch { win.loadURL(serverUrl); }
    }
    return result;
  } catch (e) {
    appendLog(`[desktop] 热回滚失败：${e?.message || e}\n`);
    return null;
  }
}

// ---------- IPC ----------
ipcMain.on('dsh:restart', () => {
  // “重启应用”：整进程重启最可靠（避免端口/文件句柄残留导致重启失败）
  try {
    stopHarness();
    app.relaunch();
    app.exit(0);
  } catch {
    connect();
  }
});
ipcMain.on('dsh:quit', () => app.quit());
ipcMain.handle('dsh:reload-harness', () => reloadHarness());
ipcMain.handle('dsh:reload-harness-soft', (_e, msg) => reloadHarness({ soft: true, msg: typeof msg === 'string' && msg ? msg : '正在应用更改…' }));
ipcMain.handle('dsh:get-log-path', () => logFile());
ipcMain.handle('dsh:detect-mcp', () => detectMcp());
ipcMain.handle('dsh:list-plugins', () => listPlugins());
ipcMain.handle('dsh:plugin-job-status', () => pluginJobStatusList());
ipcMain.handle('dsh:install-plugin', (_e, pkg) => installPlugin(pkg));
ipcMain.handle('dsh:uninstall-plugin', (_e, pkg) => uninstallPlugin(pkg));
ipcMain.handle('dsh:check-update', () => checkUpdate());
ipcMain.handle('dsh:market-list', (_e, force) => getMarketList(force === true));
ipcMain.handle('dsh:resolve-plugin', (_e, repo) => resolveRepoPkg(repo));
ipcMain.handle('dsh:repair-sessions', () => repairAllSessions());
ipcMain.handle('dsh:session-rollback-list', async (_e, force) => (await scanSessionListsAsync(force === true)).rollback);
ipcMain.handle('dsh:session-delete-list', async (_e, force) => (await scanSessionListsAsync(force === true)).del);
ipcMain.handle('dsh:session-delete', (_e, file) => deleteSessionFile(file));
ipcMain.handle('dsh:session-rollback', (_e, file) => rollbackSession(file));
ipcMain.handle('dsh:session-rollback-by-message', (_e, sessionId, messageId) => rollbackSessionByMessage(sessionId, messageId));
ipcMain.handle('dsh:session-rollback-by-user-message', (_e, sessionId, userMessageId) => rollbackSessionByUserMessage(sessionId, userMessageId));
// 消息旁“回滚到此消息”专用：优先无感热回滚（不重启程序）；不可用时退回“截断+页内提示层刷新”
ipcMain.handle('dsh:session-rollback-by-user-message-soft', async (_e, sessionId, userMessageId) => {
  const result = rollbackSessionByUserMessage(sessionId, userMessageId);
  appendLog(`[desktop] 消息回滚(${sessionId}/${userMessageId}): ok=${!!(result && result.ok)} msg=${result && result.msg}\n`);
  if (result && result.ok) {
    stashRollbackMessage(result.userMessage || '');
    const reload = await reloadHarness({ soft: true, msg: '正在撤销这条消息…' });
    result.reload = reload;
  }
  return result;
});
ipcMain.handle('dsh:session-rollback-by-user-message-hot', async (_e, sessionId, userMessageId) => {
  const hot = await hotRollbackSessionByUserMessage(sessionId, userMessageId);
  if (hot) return hot;
  const result = rollbackSessionByUserMessage(sessionId, userMessageId);
  appendLog(`[desktop] 消息回滚回退到整机路径(${sessionId}/${userMessageId}): ok=${!!(result && result.ok)} msg=${result && result.msg}\n`);
  if (result && result.ok) {
    stashRollbackMessage(result.userMessage || '');
    const reload = await reloadHarness({ soft: true, msg: '正在撤销这条消息…' });
    result.reload = reload;
  }
  return result;
});
// ---- 对话与文件联动回滚（Checkpoint / Rewind）----
ipcMain.handle('dsh:rewind-list', (_e, filter) => {
  try { return rewindEngine.list(filter || {}); } catch (e) { return { error: String(e && e.message || e) }; }
});
ipcMain.handle('dsh:rewind-preview', (_e, id) => {
  try { return { ok: true, ...rewindEngine.preview(id) }; }
  catch (e) { return { ok: false, msg: String(e && e.message || e), code: e && e.code }; }
});
ipcMain.handle('dsh:rewind-execute', async (_e, id, signature) => {
  try {
    suspendHarness(); // 恢复文件期间不允许任何写入方存活
    const result = rewindEngine.execute(id, signature);
    let conversation = null;
    const cp = result.checkpoint;
    if (cp && cp.sessionId && cp.messageId) {
      conversation = rollbackSessionByUserMessage(cp.sessionId, cp.messageId, true);
    }
    return { ...result, conversation };
  } catch (e) {
    connect(); // execute 前已挂起服务，失败时恢复
    return { ok: false, msg: String(e && e.message || e), code: e && e.code };
  }
});
ipcMain.handle('dsh:rewind-undo', (_e, guardId) => {
  try { return rewindEngine.undoLatest(guardId); }
  catch (e) { return { ok: false, msg: String(e && e.message || e), code: e && e.code }; }
});
ipcMain.on('dsh:open-mcp', () => openMcpWindow());
ipcMain.on('dsh:open-plugins', () => openPluginWindow());
ipcMain.on('dsh:open-settings', (_e, tab) => openSettingsWindow(tab));

function openMcpWindow() {
  if (mcpWin && !mcpWin.isDestroyed()) { mcpWin.show(); mcpWin.focus(); return; }
  mcpWin = new BrowserWindow({
    width: 780, height: 560, parent: win || undefined,
    backgroundColor: '#ffffff', title: '可用 MCP 服务器',
    autoHideMenuBar: false, icon: iconPath(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mcpWin.loadFile(path.join(__dirname, 'app', 'mcp.html'));
  mcpWin.on('closed', () => { mcpWin = null; });
}
function openPluginWindow() {
  if (pluginWin && !pluginWin.isDestroyed()) { pluginWin.show(); pluginWin.focus(); return; }
  pluginWin = new BrowserWindow({
    width: 720, height: 620, parent: win || undefined,
    backgroundColor: '#ffffff', title: '插件管理',
    autoHideMenuBar: false, icon: iconPath(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  pluginWin.loadFile(path.join(__dirname, 'app', 'plugins.html'));
  pluginWin.on('closed', () => { pluginWin = null; });
}
function openSettingsWindow(tab = 'market') {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    settingsWin.webContents.send('dsh:settings-tab', tab);
    return;
  }
  settingsWin = new BrowserWindow({
    width: 900, height: 680, parent: win || undefined,
    backgroundColor: '#ffffff', title: '设置',
    autoHideMenuBar: false, icon: iconPath(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  settingsWin.loadFile(path.join(__dirname, 'app', 'settings.html'), { query: { tab } });
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  app.whenReady().then(async () => {
    // 不显示原生菜单栏：设置入口都在 Web 界面自带的设置页与启动页里
    Menu.setApplicationMenu(null);
    // 先显示启动页：确保 profile 初始化（仅首次启动较慢）期间用户能看到界面。
    // 是否真·首次：桌面设置插件还没放进 profile 时才算首次。
    const firstRun = !fs.existsSync(path.join(profileDir(), 'node_modules', 'dsh-desktop-settings', 'package.json'));
    createWindow({ firstRun });
    // 记录“正在运行”标记：如果本次没能走到 before-quit（崩溃/强杀），下次启动会触发一次会话日志校验
    markRunning();
    // 后台预热会话列表缓存：设置页“对话回滚/删除对话”打开时直接可用，避免同步扫描卡住主进程
    scanSessionListsAsync().catch((err) => appendLog(`[desktop] 会话列表预热失败：${err}\n`));
    try { await ensureDesktopPlugin(); } catch (err) { appendLog(`[desktop] ensure plugin: ${err}\n`); }
    // 优先复用本机已有的 dsh web 服务（避免两个服务并发写同一份会话日志）；
    // 没有外部服务时再启动内置服务。会话日志全量校验只在首次启动/上次异常退出时执行，
    // 日常启动直接跳过，避免每次扫描全部 session.jsonl.zstd 拖慢加载。
    const repairDecision = shouldAutoRepairOnStartup();
    findExistingDshWeb().then((ext) => {
      if (ext) {
        markRepairedOnce();
        externalServer = ext;
        serverUrl = ext.url;
        if (win && !win.isDestroyed()) win.loadURL(ext.url);
      } else {
        const launch = () => connect();
        if (!repairDecision.repair) {
          appendLog(`[desktop] 启动自动修复：跳过（${repairDecision.reason}）\n`);
          markRepairedOnce();
          launch();
        } else {
          appendLog(`[desktop] 启动自动修复：${repairDecision.reason}\n`);
          autoRepairSessions()
            .then((r) => {
              appendLog(`[desktop] 启动自动修复完成：修复 ${r.repaired} 个会话，共扫描 ${r.results.length} 个\n`);
              markRepairedOnce();
              launch();
            })
            .catch((err) => {
              appendLog(`[desktop] 启动自动修复失败：${err}\n`);
              launch();
            });
        }
      }
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) { createWindow(); connect(); }
    });
  });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  quitting = true;
  stopHarness();
  clearRunningMarker();
});
