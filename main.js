// DeepSeek Harness 桌面版主进程
// 职责：启动内置的 dsh web 服务，在原生窗口里打开 Web 界面，
// 并提供桌面端扩展：MCP 检测、插件安装（内置 pnpm）、更新检查。
const { app, BrowserWindow, Menu, Tray, nativeImage, shell, ipcMain, clipboard, screen } = require('electron');
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
let tray = null;
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
let lastReconnectAt = 0;    // 主页面加载失败自动重连的防抖时间戳

// 方案A：harness 驻留（延迟杀）。应用退出后保留 dsh web 子进程一段时间，
// 期间重新启动直接复用已就绪的服务端口，实现热启动秒开。
const HARNESS_RESIDENT_MS = 60 * 1000;   // 退出后驻留时长：60s 内重启直接复用
const HARNESS_REUSE_WINDOW_MS = 90 * 1000; // 允许复用驻留 harness 的时间窗
let residentProc = null;   // 退出时驻留的 harness 子进程
let harnessResidentTimer = null; // 延迟杀驻留进程的定时器
let lastExitTime = 0;      // 上次退出时间戳（用于热启动判断）

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
function trashRoot() {
  return path.join(dshHome(), 'sessions-trash');
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
// 内核版本变化时强制冷启动：清除驻留 harness 的缓存（URL/退出时间），
// 避免覆盖安装/升级后复用旧内核进程（旧内核可能缺少新功能或与插件不兼容）
function ensureFreshKernelOnUpgrade() {
  try {
    const kf = path.join(dshHome(), 'desktop-last-kernel.txt');
    let prev = '';
    if (fs.existsSync(kf)) prev = String(fs.readFileSync(kf, 'utf8')).trim();
    const cur = bundledVersion();
    if (prev && prev !== cur) {
      try { fs.rmSync(path.join(dshHome(), 'cache', 'harness-url.txt'), { force: true }); } catch {}
      try { fs.rmSync(path.join(dshHome(), 'cache', 'harness-last-exit.txt'), { force: true }); } catch {}
      appendLog(`[desktop] 检测到内核变化（${prev} → ${cur}），已清除驻留缓存，强制冷启动\n`);
    }
    try { fs.writeFileSync(kf, cur, 'utf8'); } catch {}
  } catch {}
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
          const url = `http://127.0.0.1:${port}`;
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
    ], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
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
// 异步版清场：PowerShell 查询用 spawn 异步执行，主线程不再被 5 秒同步等待卡住；
// 只有真正 taskkill 的瞬间是同步的（毫秒级）。用于删除会话等需要清场的异步路径。
function killDshWebWritersAsync() {
  return new Promise((resolve) => {
    const pids = new Set();
    if (serverProc?.pid) pids.add(serverProc.pid);
    if (externalServer?.pid) pids.add(externalServer.pid);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      for (const pid of pids) {
        try {
          spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          appendLog(`[desktop] 已终止 dsh web 写入进程 pid=${pid}\n`);
        } catch {}
      }
      externalServer = null;
      serverUrl = null;
      resolve();
    };
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh' -and $_.CommandLine -match '\\sweb(\\s|$)' } | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId } } | ConvertTo-Json -Compress"
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return finish();
    }
    let out = '';
    const timer = setTimeout(() => {
      try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
      finish();
    }, 5000);
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', () => {});
    child.once('error', () => { clearTimeout(timer); finish(); });
    child.once('close', () => {
      clearTimeout(timer);
      try {
        const raw = String(out || '').trim();
        if (raw) {
          const list = JSON.parse(raw);
          for (const c of (Array.isArray(list) ? list : [list])) {
            const pid = Number(c?.pid);
            if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
          }
        }
      } catch {}
      finish();
    });
  });
}
async function suspendHarness(options = {}) {
  stopHarness();
  if (options.skipSweep) {
    // 调用方已确认过写入进程（或只需重启自己的服务）：跳过 PowerShell 清场
    externalServer = null;
    serverUrl = null;
  } else {
    await killDshWebWritersAsync();
  }
}

// 启动失败时诊断：从输出中提取不兼容的插件名并提示（可到“设置 → 插件与 MCP → 已安装插件”中移除）
function diagnoseStartupPlugins(text) {
  try {
    const buf = String(text || '');
    if (!buf) return;
    const names = new Set();
    let m;
    // 1) cordis loader entry 错误：failed to apply loader entry xxx (plugin-name)
    const re1 = /failed to apply loader entry [\w-]+ \(([\w@/-]+)\)/g;
    while ((m = re1.exec(buf))) names.add(m[1]);
    // 2) 崩溃堆栈：at new apply (file:///...profiles/web/node_modules/<pkg>/(lib|dist|scripts)/
    const re2 = /profiles\/web\/node_modules\/([^/"\\]+)\/(?:lib|dist|scripts|adapter|engine)\//g;
    while ((m = re2.exec(buf))) names.add(m[1]);
    // 3) web-app 报错的 bundle 名
    const re3 = /failed to apply loader entry (\w[\w-]*) \(([\w@/-]+)\)/g;
    while ((m = re3.exec(buf))) names.add(m[2]);
    if (names.size) {
      const list = [...names].join('、');
      appendLog(`[desktop] 启动失败，可能与插件不兼容有关：${list}\n可在“设置 → 插件与 MCP → 已安装插件”中移除这些插件后重启\n`);
    }
  } catch {}
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
      diagnoseStartupPlugins(stdoutBuf + '\n' + stderrBuf);
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
      // V8 编译缓存：首次启动把解析/编译的字节码落盘，之后冷启动跳过重复编译，显著加快
      const compileCacheDir = path.join(dshHome(), 'cache', 'node-compile');
      try { fs.mkdirSync(compileCacheDir, { recursive: true }); } catch {}
      const harnessEnv = Object.assign({}, process.env, { NODE_COMPILE_CACHE: compileCacheDir });
      child = spawn(nodeExe(), [harnessBin(), '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
        cwd: wsDir,
        env: harnessEnv,
        windowsHide: true,
        // Windows 下必须 detached：否则主进程退出时 job object 会回收 harness 子进程，
        // 导致“退出后驻留、快速重启复用”失效（方案A）
        detached: process.platform === 'win32',
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
        if (!document.getElementById('dsh-spin-style')) {
          const st = document.createElement('style');
          st.id = 'dsh-spin-style';
          st.textContent = '@keyframes dshSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}.dsh-spin{display:inline-block;width:18px;height:18px;border:2.5px solid rgba(37,99,235,.25);border-top-color:#2563eb;border-radius:50%;animation:dshSpin .8s linear infinite}';
          document.head.appendChild(st);
        }
        o.innerHTML = '<span class="dsh-spin" style="margin-right:12px"></span><span>' + ${JSON.stringify(safe)} + '</span>';
        o.style.display = 'flex'; })()`
    ).catch(() => {});
  } catch {}
}
// 探测一个 HTTP 地址是否仍然存活（用于复用驻留 harness）
function probeUrl(url) {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, { timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve(false); });
      req.on('error', () => resolve(false));
    } catch { resolve(false); }
  });
}
// 尝试复用退出时驻留的 harness 服务（方案A）。成功返回 URL，否则 null。
async function tryReuseHarness() {
  const cacheDir = path.join(dshHome(), 'cache');
  try {
    const urlFile = path.join(cacheDir, 'harness-url.txt');
    if (!fs.existsSync(urlFile)) return null;
    const url = String(fs.readFileSync(urlFile, 'utf8')).trim();
    if (!url) return null;
    // 只要探测到服务健康就直接复用（不设时间窗）：
    // 正常退出走“驻留 60s 后杀”；异常强杀时驻留进程会一直存活，
    // 此时复用它可避免再次冷启动（约 3 分钟）并避免新老服务端口并存。
    if (!(await probeUrl(url))) return null;
    // 复用成功：撤销延迟杀，驻留进程改由本实例接管
    if (harnessResidentTimer) { clearTimeout(harnessResidentTimer); harnessResidentTimer = null; }
    residentProc = null;
    appendLog(`[desktop] 复用驻留 harness：${url}\n`);
    return url;
  } catch { return null; }
}
function connect() {
  showLoading();
  tryReuseHarness()
    .then((url) => {
      if (url) {
        serverUrl = url;
        if (win && !win.isDestroyed()) { win.loadURL(url); warmSessionListsSoon(); warmCachesSoon(true); }
      } else {
        startHarness()
          .then((u) => { if (win && !win.isDestroyed()) { win.loadURL(u); warmSessionListsSoon(); warmCachesSoon(false); } })
          .catch((err) => showError(err && err.message ? err.message : String(err)));
      }
    })
    .catch(() => {
      startHarness()
        .then((u) => { if (win && !win.isDestroyed()) { win.loadURL(u); warmSessionListsSoon(); warmCachesSoon(false); } })
        .catch((err) => showError(err && err.message ? err.message : String(err)));
    });
}
let cachesWarmupTimer = null;
function warmCachesSoon(isHot) {
  // 启动后自动预热/刷新各设置分区数据：打开设置页直接呈现，不再首次点击才加载
  if (cachesWarmupTimer) return;
  const hot = !!isHot;
  cachesWarmupTimer = setTimeout(() => {
    cachesWarmupTimer = null;
    if (hot) {
      // 方案F：热启动（复用驻留 harness）时跳过强制网络请求，只做本地预热；
      // 延迟到 60s 后再静默补一次完整刷新，避免每次热启动都抢网络/首屏
      try { listPlugins(); } catch {}
      setTimeout(() => {
        getMarketList(true).catch(() => {});
        detectMcp(true).catch(() => {});
        checkUpdate(true).catch(() => {});
      }, 60000);
    } else {
      getMarketList(true).catch(() => {});   // 插件市场：强制拉最新在线列表，失败降级内置快照
      detectMcp(true).catch(() => {});       // MCP：后台逐项探活（异步，不阻塞界面）
      try { listPlugins(); } catch {}        // 已安装插件：预热内存缓存
      checkUpdate(true).catch(() => {});     // 更新检查：预热结果，打开“更新”分区即显示
    }
  }, hot ? 1500 : 4000);
  // 定时自动刷新插件市场并保存本地快照：每 6 小时后台拉取一次
  if (!marketRefreshTimer) {
    marketRefreshTimer = setInterval(() => {
      getMarketList(true).catch(() => {});
    }, MARKET_SNAPSHOT_REFRESH_MS);
  }
}
let sessionWarmupTimer = null;
// 启动时间：用于识别“启动时 Web UI 自动新建的空会话”（仅清理这些）
let dshStartupTime = 0;
let startupEmptyCleanupDone = false;
// 清理启动时 Web UI 自动创建的空会话（无任何用户/助手消息，只有初始化 seed 事件）。
// 只处理“启动后新建”且“无消息”的会话，且每次启动只执行一次；空会话无恢复价值，直接删除，
// 不再移入回收站（避免回收站堆积非用户删除的垃圾记录）。
async function cleanupStartupEmptySessions() {
  if (startupEmptyCleanupDone) return;
  const files = [];
  walkSessionFiles((f) => files.push(f));
  const sessionsRoot = path.join(dshHome(), 'sessions');
  const cleaned = [];
  for (const file of files) {
    try {
      const st = await fs.promises.stat(file);
      if (st.mtimeMs < dshStartupTime) continue; // 只处理启动后新建的
      const summary = await sessionSummaryFromBuf(await fs.promises.readFile(file));
      if (summary && !summary.lastUserMessageId) {
        const dir = path.dirname(file);
        await fs.promises.rm(dir, { recursive: true, force: true });
        cleaned.push(path.relative(sessionsRoot, dir));
      }
    } catch {}
    await new Promise((resolve) => setImmediate(resolve));
  }
  startupEmptyCleanupDone = true;
  if (cleaned.length) {
    appendLog('[desktop] 清理启动产生的空会话 ' + cleaned.length + ' 个（直接删除）：' + cleaned.join('、') + '\n');
    invalidateSessionListsCache();
  }
}

function warmSessionListsSoon() {
  // 等 Web UI 完成首屏后再后台预热会话列表，避免和 Harness 冷启动抢 CPU 造成首屏卡顿
  if (sessionWarmupTimer) return;
  sessionWarmupTimer = setTimeout(() => {
    sessionWarmupTimer = null;
    scanSessionListsAsync().catch((err) => appendLog(`[desktop] 会话列表预热失败：${err}\n`));    scanSessionListsAsync().catch((err) => appendLog(`[desktop] 会话列表预热失败：${err}\n`));
    cleanupStartupEmptySessions().catch(() => {}); // 清理启动自动新建的空会话
  }, 3000);
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
    // overlay:false = 静默刷新（装后验证/回滚等后台流程），不打断用户，状态由右下角任务面板呈现
    if (soft && options.overlay !== false) showSoftOverlay(options.msg || '正在应用更改…');
    else if (!soft) showLoading();
    try {
      // 调用方（回滚/删除/卸载重试）在进入 reloadHarness 前已经清场；这里只需停掉自己的服务再重启，避免二次同步 PowerShell 卡顿
      await suspendHarness({ skipSweep: true });
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
// 比较插件目录关键文件内容是否一致（升级安装时识别旧版/损坏版并覆盖更新）
function bufferEquals(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function pluginFilesMatch(src, dest) {
  const files = ['package.json', 'cordis.patch.yml', 'lib/client.js', 'lib/index.js', 'lib/checkpoints.cjs'];
  for (const rel of files) {
    const a = path.join(src, rel);
    const b = path.join(dest, rel);
    const ha = fs.existsSync(a), hb = fs.existsSync(b);
    if (ha !== hb) return false;
    if (ha) {
      try {
        if (!bufferEquals(fs.readFileSync(a), fs.readFileSync(b))) return false;
      } catch { return false; }
    }
  }
  return true;
}

// 类似 Claude Code / opencode：从用户级配置文件自动检测 MCP 服务器并同步到 web profile
const CLAUDE_MCP_FILE = path.join(os.homedir(), '.claude.json');
const OPENCODE_MCP_FILES = [
  path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
  path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc'),
];
function stripJsoncComments(text) {
  let out = '', inStr = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] || ''; i += 2; continue; }
      if (ch === '"') inStr = false;
      i++; continue;
    }
    if (ch === '"') { inStr = true; out += ch; i++; continue; }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += ch; i++;
  }
  return out;
}
function readOpencodeMcpServers() {
  for (const f of OPENCODE_MCP_FILES) {
    if (!fs.existsSync(f)) continue;
    let cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {
      try { cfg = JSON.parse(stripJsoncComments(fs.readFileSync(f, 'utf8'))); } catch { continue; }
    }
    const mcp = cfg && typeof cfg === 'object' ? cfg.mcp : null;
    if (mcp && typeof mcp === 'object') return mcp;
  }
  return null;
}
function mcpEntryFromClaude(name, cfg) {
  if (cfg.type === 'http' && cfg.url) {
    return { id: 'mcp-' + name, name: '@deepseek-ai/dsh-mcp-client', config: { transport: 'streamable-http', serverName: name, url: cfg.url, headers: cfg.headers || {} } };
  }
  if (cfg.command) {
    const entry = { id: 'mcp-' + name, name: '@deepseek-ai/dsh-mcp-client', config: { transport: 'stdio', serverName: name, command: cfg.command, args: cfg.args || [] } };
    if (cfg.env && Object.keys(cfg.env).length) entry.config.env = cfg.env;
    return entry;
  }
  return null;
}
function mcpEntryFromOpencode(name, cfg) {
  if (!cfg || typeof cfg !== 'object' || cfg.enabled === false) return null;
  if (cfg.type === 'local' && cfg.command) {
    const cmd = Array.isArray(cfg.command) ? cfg.command : [cfg.command];
    const entry = { id: 'mcp-' + name, name: '@deepseek-ai/dsh-mcp-client', config: { transport: 'stdio', serverName: name, command: String(cmd[0]), args: cmd.slice(1) } };
    if (cfg.env && Object.keys(cfg.env).length) entry.config.env = cfg.env;
    return entry;
  }
  if (cfg.type === 'http' && cfg.url) {
    return { id: 'mcp-' + name, name: '@deepseek-ai/dsh-mcp-client', config: { transport: 'streamable-http', serverName: name, url: cfg.url, headers: cfg.headers || {} } };
  }
  // remote（SSE 端点）与 claude 风格：SSE 协议 dsh 客户端不支持，跳过避免覆盖手动桥接；claude 风格交给 Claude Code 来源处理
  return null;
}
function findMcpEntry(doc, name) {
  const want = 'mcp-' + name;
  for (const el of doc) {
    if (el && Array.isArray(el.insert)) {
      const e = el.insert.find((x) => x && x.id === want && x.name === '@deepseek-ai/dsh-mcp-client');
      if (e) return e;
    }
    if (el && el.id === want && el.name === '@deepseek-ai/dsh-mcp-client') return el;
  }
  return null;
}
async function ensureMcpAutoSync() {
  const sources = [];
  try {
    const servers = fs.existsSync(CLAUDE_MCP_FILE) ? (JSON.parse(fs.readFileSync(CLAUDE_MCP_FILE, 'utf8')).mcpServers || {}) : {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg && typeof cfg === 'object') {
        const entry = mcpEntryFromClaude(name, cfg);
        if (entry) sources.push({ name, entry, from: 'claude' });
      }
    }
  } catch {}
  try {
    const oc = readOpencodeMcpServers();
    if (oc) {
      for (const [name, cfg] of Object.entries(oc)) {
        const entry = mcpEntryFromOpencode(name, cfg);
        if (entry) sources.push({ name, entry, from: 'opencode' });
      }
    }
  } catch {}
  if (!sources.length) return;
  const patchPath = path.join(profileDir(), 'cordis.patch.yml');
  if (!fs.existsSync(patchPath)) return;
  let doc;
  try { doc = yaml.load(fs.readFileSync(patchPath, 'utf8')); } catch { return; }
  if (!Array.isArray(doc)) return;
  let changed = 0;
  let added = 0;
  for (const { name, entry } of sources) {
    const found = findMcpEntry(doc, name);
    if (found) {
      if (JSON.stringify(found.config) !== JSON.stringify(entry.config)) { found.config = entry.config; changed++; }
    } else {
      let insertEl = doc.find((el) => el && Array.isArray(el.insert));
      if (!insertEl) { insertEl = { insert: [] }; doc.unshift(insertEl); }
      insertEl.insert.push(entry);
      added++;
    }
  }
  if (!changed && !added) return;
  try { fs.writeFileSync(patchPath, yaml.dump(doc, { lineWidth: -1, noRefs: true })); }
  catch (e) { appendLog(`[desktop] MCP 同步写回失败：${e && e.message || e}\n`); return; }
  const byFrom = {};
  for (const { from } of sources) byFrom[from] = (byFrom[from] || 0) + 1;
  const desc = Object.entries(byFrom).map(([k, v]) => `${k} ${v} 个`).join('、');
  appendLog(`[desktop] 已自动检测 MCP（${desc}）：更新 ${changed} 个、新增 ${added} 个（${sources.map((s) => s.name).join('、')}）\n`);
  try { await verifyPluginAfterInstall(); } catch {}
}


// 打包分发时内置的默认插件（首次启动自动安装；已安装则跳过，老用户升级不受影响）
// 默认插件：随安装包离线预装（preloaded-plugins），开箱即用；用户卸载后写入禁用名单，
// 下次启动不再强制装回（尊重用户自由卸载，避免内核更新后插件不适配时无法卸载）
const DEFAULT_PROFILE_PLUGINS = {
  '@anionex/dsh-vision-toolkit': '^0.1.6',
  '@huanlin/dsh-plugin-better-sidebar-plugin-office': '^0.1.0',
  'dsh-anchored-standard': 'git+https://github.com/xiaobright/dsh-anchored-standard.git',
  'dsh-at-file': 'git+https://github.com/omdsh-dev/dsh-at-file.git',
  'dsh-better-sidebar': '^0.13.1',
  'dsh-digipet': 'https://github.com/swaylq/dsh-digipet/archive/refs/heads/main.tar.gz',
};
// 用户主动卸载的默认插件名单：卸载后不再自动装回，尊重"用户自由卸载"
const DISABLED_MARKER = path.join(profileDir(), '.default-plugins-disabled.json');
function readDisabledDefaults() {
  try { return readJsonSafe(DISABLED_MARKER) || {}; } catch { return {}; }
}
function saveDisabledDefaults(map) {
  try { fs.writeFileSync(DISABLED_MARKER, JSON.stringify(map, null, 2), 'utf8'); } catch {}
}
function markDefaultPluginDisabled(pkg) {
  if (typeof pkg !== 'string' || !pkg) return;
  const map = readDisabledDefaults();
  if (!map[pkg]) { map[pkg] = Date.now(); saveDisabledDefaults(map); }
}
async function ensureDefaultPlugins() {
  // 离线预装：安装包分发时附带 resources/preloaded-plugins（do-pack 打包时从
  // profile 抓取的已装插件+依赖平铺副本）。存在该目录则直接复制，不再在线 pnpm。
  const preloaded = path.join(resourcesRoot(), 'preloaded-plugins');
  if (fs.existsSync(preloaded)) {
    let copied = 0;
    const fails = [];
    const disabled = readDisabledDefaults();
    for (const name of Object.keys(DEFAULT_PROFILE_PLUGINS)) {
      if (disabled[name]) continue;
      const rel = name.split('/');
      const src = path.join(preloaded, ...rel);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(profileDir(), 'node_modules', ...rel);
      if (fs.existsSync(dest)) continue;
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(src, dest, { recursive: true, force: true });
        copied++;
      } catch (e) {
        fails.push(`${name}: ${String(e && e.message || e)}`);
      }
    }
    if (copied) appendLog(`[desktop] 已离线预装默认插件 ${copied} 个（免联网）\n`);
    for (const f of fails) appendLog(`[desktop] 离线预装插件失败 ${f}\n`);
    if (copied || fails.length) { try { await verifyPluginAfterInstall(); } catch {} }
    return;
  }
  const manifest = readJsonSafe(path.join(profileDir(), 'package.json')) || {};
  const deps = manifest.dependencies || {};
  // 失败标记：安装失败的默认插件只尝试一次，后续启动跳过（避免每次启动都重跑
  // pnpm 安装与 harness 冷启动抢 CPU，导致加载环境时窗口长时间无响应/未响应）
  const FAILED_MARKER = path.join(profileDir(), '.default-plugins-failed.json');
  let failed = {};
  try { failed = readJsonSafe(FAILED_MARKER) || {}; } catch {}
  const saveFailed = () => {
    try { fs.writeFileSync(FAILED_MARKER, JSON.stringify(failed, null, 2), 'utf8'); } catch {}
  };
  const disabled = readDisabledDefaults();
  const todo = [];
  for (const [name, spec] of Object.entries(DEFAULT_PROFILE_PLUGINS)) {
    if (disabled[name]) continue;
    const installed = fs.existsSync(path.join(profileDir(), 'node_modules', name));
    if (!installed && !deps[name] && !failed[name]) todo.push([name, spec]);
  }
  if (!todo.length) return;
  appendLog(`[desktop] 首次启动：自动安装内置默认插件 ${todo.length} 个…\n`);
  for (const [name, spec] of todo) {
    try {
      const r = await runPluginChild('add', spec, await pnpmEnv(), 300000, []);
      const tail = String(r.log || '').split('\n').filter(Boolean).pop() || r.ok ? 'ok' : 'failed';
      appendLog(`[desktop] 默认插件 ${name}：${r.ok ? '安装成功' : '安装失败 ' + tail}\n`);
      if (!r.ok) { failed[name] = Date.now(); saveFailed(); }
    } catch (e) {
      appendLog(`[desktop] 默认插件 ${name} 安装异常：${String(e && e.message || e)}\n`);
      failed[name] = Date.now();
      saveFailed();
    }
  }
  try { await verifyPluginAfterInstall(); } catch {}
}
async function ensureDesktopPlugin() {
  // 把“插件与 MCP”设置段插件直接放入 web profile（本地 link 依赖，不访问 npm 注册表）
  const src = path.join(resourcesRoot(), 'plugins', 'dsh-desktop-settings');
  if (!fs.existsSync(path.join(src, 'package.json'))) return false;
  const marker = path.join(profileDir(), 'node_modules', 'dsh-desktop-settings', 'package.json');
  if (fs.existsSync(marker)) {
    // 已安装：与内置版本内容一致则跳过；不一致（旧版/损坏版）则覆盖更新，老用户升级自动修复
    const dest = path.join(profileDir(), 'node_modules', 'dsh-desktop-settings');
    if (pluginFilesMatch(src, dest)) return true;
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true, force: true });
      appendLog('[desktop] updated dsh-desktop-settings in web profile (content mismatch)\n');
      return true;
    } catch (err) {
      appendLog(`[desktop] update settings plugin failed: ${err}\n`);
      return false;
    }
  }

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
  const isWin = process.platform === 'win32';
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1080, minHeight: 700,
    // 深色玻璃无边框（系统按钮方案）：titleBarStyle:hidden 隐藏标题栏文字、内容上浮，
    // titleBarOverlay 提供 Win11 系统最小化/最大化/关闭按钮（Electron 43 的 frame:false 失效的可靠替代）
    backgroundColor: '#16181d',
    title: APP_NAME, icon: iconPath(),
    autoHideMenuBar: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
      backgroundThrottling: false
    }
  });

  win.loadFile(path.join(__dirname, 'app', 'loading.html'), { query: { first: options.firstRun ? '1' : '0' } });
  win.once('ready-to-show', () => win.show());
  // Win11 深色玻璃（Mica）：运行时设置，titleBarStyle:hidden 下也生效
  if (isWin && win.setBackgroundMaterial) {
    try { win.setBackgroundMaterial('mica'); } catch {}
  }
  win.on('close', (event) => {
    // 关闭默认隐藏到系统托盘（仅真正退出时销毁窗口）
    if (!quitting && !pluginJobCount) {
      event.preventDefault();
      if (win && !win.isDestroyed()) { win.hide(); }
      if (tray) tray.displayBalloon({ title: APP_NAME, content: '已最小化到系统托盘，继续在后台运行。', icon: balloonIcon(), iconType: 'none' });
    }
  });
  win.on('closed', () => { win = null; });
  win.on('maximize', () => { if (win && !win.isDestroyed()) win.webContents.send('dsh:win-maximized-change', true); });
  win.on('unmaximize', () => { if (win && !win.isDestroyed()) win.webContents.send('dsh:win-maximized-change', false); });

  const wc = win.webContents;
  // 诊断：捕获渲染进程无响应/崩溃/加载失败（"灰色禁用/无法点击"现象的根因排查）
  wc.on('unresponsive', () => appendLog('[desktop] webContents unresponsive!\n'));
  wc.on('responsive', () => appendLog('[desktop] webContents responsive again\n'));
  wc.on('render-process-gone', (e, details) => appendLog(`[desktop] render-process-gone: reason=${details.reason} exitCode=${details.exitCode}\n`));
  wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    appendLog(`[desktop] did-fail-load: code=${code} desc=${desc} url=${url}\n`);
    // harness 崩溃/重启会换端口：窗口若停留在旧 URL，页面挂起表现为灰屏“未响应”。
    // 主 frame 加载失败时自动重新 connect（复用/重启 harness 并加载最新 URL），防抖 10s。
    if (!isMainFrame) return;
    const aborted = code === -3 || code === -21 || code === -6 || code === -7;
    if (!aborted) return;
    const now = Date.now();
    if (now - lastReconnectAt < 10000) return;
    lastReconnectAt = now;
    appendLog('[desktop] 主页面加载失败，自动重新连接 harness…\n');
    connect();
  });
  // 加载超时保护：loading 阶段长时间未就绪时强制刷新一次（避免灰屏卡死）
  const loadingWatch = setInterval(() => {
    try {
      if (!win || win.isDestroyed()) { clearInterval(loadingWatch); return; }
      const cur = win.webContents.getURL();
      if (cur.includes('loading.html') || cur === '' || cur === 'about:blank') {
        appendLog(`[desktop] loading watch: still loading after 90s, url=${cur}\n`);
        clearInterval(loadingWatch);
        try { win.reload(); } catch {}
      } else {
        clearInterval(loadingWatch);
      }
    } catch { clearInterval(loadingWatch); }
  }, 90000);
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

// ---------- 系统托盘：关闭窗口默认隐藏到托盘 ----------
function balloonIcon() {
  // 气泡通知图标：优先 32x32 二值化 PNG（清晰），回退 icon.ico
  const hi = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray@2x.png'));
  if (!hi.isEmpty()) return hi;
  return nativeImage.createFromPath(iconPath());
}
function createTray() {
  try {
    // 优先使用 build/tray.png（16x16 + tray@2x.png 32x32，alpha 已二值化，
    // 无半透明像素，避免 HICON 转换产生黑色边缘）；不做 resize，
    // 由 Electron 按 DPI 自动选择 @2x 表示，系统负责最终缩放。
    let img = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png'));
    if (!img.isEmpty()) {
      appendLog(`[desktop] tray: using tray.png size=${img.getSize().width}x${img.getSize().height}\n`);
    } else {
      img = nativeImage.createFromPath(iconPath());
      if (!img.isEmpty()) {
        const sf = (screen.getPrimaryDisplay() || {}).scaleFactor || 1;
        const target = Math.max(16, Math.round(16 * sf));
        const s = img.getSize();
        if (s.width !== target || s.height !== target) {
          img = img.resize({ width: target, height: target, quality: 'best' });
        }
        appendLog(`[desktop] tray: ico fallback scale=${sf} target=${target} size=${img.getSize().width}x${img.getSize().height}\n`);
      }
    }
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip(APP_NAME);
    const showMain = () => {
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
      } else {
        createWindow();
        connect();
      }
    };
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 ' + APP_NAME, click: showMain },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', showMain);
    tray.on('double-click', showMain);
  } catch (err) {
    appendLog(`[desktop] tray 初始化失败：${err}\n`);
    tray = null;
  }
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
  if (!cmd) return Promise.resolve(false);
  if (cmd.includes(' ')) cmd = cmd.split(/\s+/)[0];
  // 绝对路径：where.exe 只查 PATH 不支持绝对路径，直接检查文件存在
  if (/^[a-zA-Z]:[\\/]/.test(cmd)) return Promise.resolve(fs.existsSync(cmd));
  // 异步 where 查询：MCP 检测会逐个探活，同步 spawnSync 会把主进程整段卡住
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('where.exe', [cmd], { windowsHide: true, stdio: 'ignore' });
    } catch {
      return resolve(false);
    }
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => {
      try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
      done(false);
    }, 5000);
    child.once('error', () => { clearTimeout(timer); done(false); });
    child.once('close', (code) => { clearTimeout(timer); done(code === 0); });
  });
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
let mcpPromise = null;
async function detectMcp(force = false) {
  // MCP 检测会扫描多个配置并逐个探活（where/http），用 60 秒内存缓存避免设置页反复刷新时重复检测；
  // 进行中的检测共用同一个 promise，启动预热和设置页同时打开时不会重复探测
  const now = Date.now();
  if (!force && mcpCache && now - mcpCache.at < 60 * 1000) return mcpCache.data;
  if (!force && mcpPromise) return mcpPromise;
  const run = (async () => {
    // 只扫描当前桌面端使用的 web profile：这里配的 MCP 才是本应用真正可调用的
    const servers = [];
    const patchFile = path.join(profileDir(), 'cordis.patch.yml');
    if (fs.existsSync(patchFile)) {
      const found = parsePatchMcp(readYamlSafe(patchFile));
      for (const s of found) s.source = 'dsh profile (web)';
      servers.push(...found);
    }
    for (const s of servers) {
      if (s.transport === 'stdio') s.status = (await commandAvailable(s.command)) ? '可用' : '命令未找到';
      else s.status = (await httpReachable(s.url)) ? '可连接' : '无法连接';
    }
    mcpCache = { at: Date.now(), data: servers };
    return servers;
  })();
  let wrapped;
  wrapped = run.finally(() => { if (mcpPromise === wrapped) mcpPromise = null; });
  mcpPromise = wrapped;
  return mcpPromise;
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
  if (/^git\+https:\/\/.+/i.test(pkg)) return true;
  if (/^git\+ssh:\/\/.+/i.test(pkg)) return true;
  if (/^https:\/\/.+\/.*\.git$/i.test(pkg)) return true;
  return /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/archive\/refs\/heads\/[A-Za-z0-9._-]+\.tar\.gz$/i.test(pkg);
}
function isNpmPkgName(pkg) {
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(pkg || '');
}
// 带超时与单次结算保护的子进程运行：pnpm 卡死时杀掉进程树并返回失败，避免 UI 永久转圈
function runPluginChild(mode, pkg, env, timeoutMs, extraArgs = [], job) {
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
    // 实时输出到任务日志（前端悬浮面板可见）
    const jobAppend = (text) => {
      if (job && text) {
        job.log += text;
        if (job.log.length > 12000) job.log = job.log.slice(-12000);
      }
    };
    try {
      child = spawn(nodeExe(), [harnessBin(), 'plugin', '--profile', 'web', mode, pkg, ...extraArgs], {
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
    child.stdout.on('data', (c) => { out += c.toString(); jobAppend(c.toString()); });
    child.stderr.on('data', (c) => { err += c.toString(); jobAppend(c.toString()); });
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
async function pnpmEnv() {
  // 优先使用系统 pnpm（与 profile 现有 node_modules 的 store 版本一致），
  // 没有 pnpm 时回退到内置 pnpm 11（新机器首次安装走这条路径）。
  const hasSystemPnpm = await commandAvailable('pnpm');
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
  const job = { id, mode, pkg, startedAt: Date.now(), status: 'running', stage: mode === 'remove' ? '卸载中…' : '安装中…', log: '' };
  pluginJobs.set(id, job);
  pluginJobCount++;
  appendLog(`[desktop] plugin ${mode} 开始：${pkg}\n`);
  // 向主窗口推送插件任务事件（完成/失败立即通知前端弹 toast，不依赖轮询时序）
  const sendEvent = () => {
    try {
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.send('dsh:plugin-job-event', {
          id: job.id,
          mode: job.mode,
          pkg: job.pkg,
          status: job.status,
          stage: job.stage,
          needRestart: job.needRestart === true
        });
      }
    } catch {}
  };
  // 任务内部可通过 job 实时更新阶段/日志（前端面板可见）
  const setStage = (stage, logLine) => {
    job.stage = stage;
    if (logLine) { job.log += String(logLine) + '\n'; appendLog('[desktop] ' + String(logLine) + '\n'); }
    sendEvent();
  };
  return Promise.resolve()
    .then(() => task(job))
    .then((result) => {
      job.status = result && result.ok ? 'done' : 'error';
      job.stage = job.status === 'done' ? '完成' : '失败';
      job.log = String((result && result.log) || '');
      job.needRestart = !!(result && result.bundleChanged === true);
      appendLog(`[desktop] plugin ${mode} ${job.status}：${pkg}\n${job.log.slice(-1200)}\n`);
      sendEvent();
      return result;
    })
    .catch((err) => {
      job.status = 'error';
      job.log = String(err && err.message || err) + '\n' + String(err && err.stack || '');
      job.needRestart = false;
      appendLog(`[desktop] plugin ${mode} 异常：${pkg}\n${job.log.slice(-3000)}\n`);
      sendEvent();
      return { ok: false, log: job.log };
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
// ---------- 插件装后验证 + 自动回滚 ----------
// 安装成功（pnpm 返回 0）不等于插件能加载：不兼容的插件会在 harness 重启时
// 崩溃或在前端显示加载失败。安装后自动重启验证，失败即回滚，避免破坏工作区。
const PLUGIN_LOAD_FAIL_MARKERS = [
  'Failed to load plugins',
  'failed to apply loader entry',
  'cannot get property',
  'requires options.id',
  'dsh web 进程已退出'
];
function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }
// 等待页面加载完成并检查是否出现插件加载失败提示
async function waitForPluginLoadCheck(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  while (Date.now() < deadline) {
    try {
      if (!win || win.isDestroyed()) return { ok: false, reason: '窗口不可用' };
      const text = await win.webContents.executeJavaScript(`document.body ? (document.body.innerText || '') : ''`);
      lastText = text || '';
      if (!lastText || /loading|加载中/i.test(lastText.slice(0, 200))) {
        await sleepMs(1200);
        continue;
      }
      for (const marker of PLUGIN_LOAD_FAIL_MARKERS) {
        if (lastText.includes(marker)) {
          return { ok: false, reason: '页面显示插件加载失败（' + marker + '）' };
        }
      }
      // 无失败标记即视为加载成功（页面已渲染主内容）
      return { ok: true };
    } catch {
      await sleepMs(1200);
    }
  }
  return { ok: false, reason: '加载验证超时（页面未就绪）' };
}
// 安装后验证：软刷新重启 harness + 检查页面加载
async function verifyPluginAfterInstall() {
  try {
    const reload = await reloadHarness({ soft: true, overlay: false, msg: '正在验证插件加载…' });
    if (!reload || reload.ok !== true) {
      return { ok: false, reason: 'Harness 重启失败：' + ((reload && reload.msg) || '未知错误') };
    }
    return await waitForPluginLoadCheck();
  } catch (e) {
    return { ok: false, reason: '验证异常：' + String(e && e.message || e) };
  }
}
// 回滚：卸载插件 + 移除 bundle + 恢复 harness
async function rollbackPluginInstall(pkg, name, job) {
  const parts = [];
  try {
    if (name) syncBundleAfterUninstall(name, { ok: true });
    const env = await pnpmEnv();
    const rm = await runPluginChild('remove', name || pkg, env, 300000, [], job);
    parts.push(rm.ok ? '已卸载' : '卸载失败：' + String(rm.log || '').slice(-200));
  } catch (e) {
    parts.push('卸载异常：' + String(e && e.message || e));
  }
  try {
    const reload = await reloadHarness({ soft: true, overlay: false, msg: '已恢复服务…' });
    parts.push(reload && reload.ok ? '服务已恢复' : '服务恢复失败');
  } catch {}
  return parts.join('；');
}
function installPlugin(pkg) {
  if (!isValidPkgSpec(pkg)) {
    return Promise.resolve({ ok: false, log: '包名格式不正确' });
  }
  return trackPluginJob('add', pkg, async (job) => {
    try {
      let result = await runPluginChild('add', pkg, await pnpmEnv(), 300000, [], job);
      if (!result.ok) {
        // 常规安装失败（如网络/registry 问题）：自动升级为 AI 安装（诊断 → 白名单修复 → 重试）
        if (job) job.stage = 'AI 诊断中…';
        appendLog('[desktop] 常规安装失败，自动启动 AI 诊断…\n');
        return aiInstallPlugin(pkg, job, result);
      }
      // 包名不是 npm 名（github:/https 归档）时按写入 profile 的实际包名登记 bundle 层
      const name = isNpmPkgName(pkg) ? pkg : installedNameForSpec(pkg);
      if (name) result = syncBundleAfterInstall(name, result);
      // 装后验证：重启 harness 确认插件能加载，失败自动回滚
      const verify = await verifyPluginAfterInstall();
      if (!verify.ok) {
        // 插件不兼容（能装但加载失败）：回滚后直接明确返回失败，不再自动 AI 诊断
        // （这是插件自身兼容问题，AI 修复无意义，重复尝试只会让面板一直"安装中"让用户困惑）
        if (job) job.stage = '回滚中（插件不兼容）…';
        const rollback = await rollbackPluginInstall(pkg, name, job);
        const msg = `插件已安装但加载失败：${verify.reason}\n已自动回滚：${rollback}\n\n提示：该插件与当前内核（${bundledVersion()}）不兼容，可尝试其他版本或等待插件更新。`;
        appendLog('[desktop] 插件加载失败已回滚，不再重试：' + verify.reason + '\n');
        return { ok: false, log: String(result.log || '') + '\n\n⚠ ' + msg, rolledBack: true };
      }
      result.log = String(result.log || '') + '\n（插件加载验证通过）';
      return result;
    } catch (err) {
      // 兜底：异常时依赖可能已写入 profile，尝试回滚，避免残留导致下次启动崩溃
      let rb = '';
      try {
        const name = isNpmPkgName(pkg) ? pkg : installedNameForSpec(pkg);
        rb = await rollbackPluginInstall(pkg, name, job);
      } catch {}
      const msg = '安装异常：' + String(err && err.message || err) + (rb ? '\n已自动回滚：' + rb : '');
      // 异常兜底：异常多为代码缺陷，重试无意义，直接返回失败（含清理状态）
      return { ok: false, log: msg, rolledBack: !!rb };
    }
  });
}
// 卸载前检查：扫描 profile node_modules 里所有插件，找 peerDependencies/dependencies 里引用了目标插件的已装插件
// （如 dsh-git-remotes 通过 peerDependencies.dsh-better-sidebar 声明依赖，卸载主插件后它将因服务缺失而无法加载）
function findPluginDependents(pkg) {
  try {
    const depsDir = path.join(profileDir(), 'node_modules');
    if (!fs.existsSync(depsDir)) return [];
    const out = new Set();
    const scanDir = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const p = path.join(dir, e.name);
        if (e.name.startsWith('@')) { scanDir(p); continue; }
        const mf = path.join(p, 'package.json');
        if (!fs.existsSync(mf)) continue;
        try {
          const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
          const name = m && m.name;
          if (!name || name === pkg) continue;
          const pd = (m.peerDependencies && typeof m.peerDependencies === 'object') ? m.peerDependencies : {};
          const d = (m.dependencies && typeof m.dependencies === 'object') ? m.dependencies : {};
          if (Object.prototype.hasOwnProperty.call(pd, pkg) || Object.prototype.hasOwnProperty.call(d, pkg)) {
            out.add(name);
          }
        } catch {}
      }
    };
    scanDir(depsDir);
    return Array.from(out);
  } catch {
    return [];
  }
}
function uninstallPlugin(pkg, force) {
  if (!isValidPkgSpec(pkg)) {
    return Promise.resolve({ ok: false, log: '包名格式不正确' });
  }
  return trackPluginJob('remove', pkg, async (job) => {
    // 卸载前检查：有插件依赖此插件（如 dsh-git-remotes 依赖 dsh-better-sidebar）时先阻断并提示，避免卸载后孤儿插件启动报错
    if (!force) {
      const dependents = findPluginDependents(pkg);
      if (dependents.length) {
        return {
          ok: false,
          blocked: true,
          dependents,
          log: `检测到 ${dependents.length} 个已装插件依赖此插件：${dependents.join('、')}。卸载后这些插件将因缺少服务而无法加载。建议先卸载它们；仍要卸载请强制卸载。`
        };
      }
    }
    // 仅存在于 bundle 层、不在 dependencies 里的插件：不需要 pnpm remove，直接移除 bundle 配置即可
    const manifest = readJsonSafe(path.join(profileDir(), 'package.json')) ?? {};
    const deps = manifest.dependencies ?? {};
    const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
    const inDeps = Object.prototype.hasOwnProperty.call(deps, pkg);
    const inBundles = bundles.includes(pkg);
    if (!inDeps && inBundles) {
      const r = syncBundleAfterUninstall(pkg, { ok: true, log: '仅从 bundle 层移除（未在 dependencies 中，无需 pnpm remove）' });
      markDefaultPluginDisabled(pkg);
      // 统一热更新：卸载成功后软刷新让移除生效（与安装路径一致，不依赖前端手动调用）
      await reloadHarness({ soft: true, msg: '插件已卸载，正在生效…' }).catch(() => {});
      return r;
    }
    let result = await runPluginChild('remove', pkg, await pnpmEnv(), 300000, [], job);
    if (!result.ok) {
      // 失败多为运行中的 Harness 占用 node_modules 文件：挂起服务重试一次，然后恢复服务
      await suspendHarness();
      const retry = await runPluginChild('remove', pkg, await pnpmEnv(), 300000, [], job);
      if (retry.ok) {
        result = retry;
        result.log = String(result.log || '') + '\n（首次卸载失败，已暂停 Harness 后重试成功）';
      } else {
        result.log = String(result.log || '') + '\n（暂停 Harness 后重试仍失败，未修改插件清单）';
      }
      reloadHarness({ soft: true, msg: '正在恢复服务…' }).catch(() => {});
    }
    if (result.ok) {
      const r = syncBundleAfterUninstall(pkg, result);
      markDefaultPluginDisabled(pkg);
      // 统一热更新：卸载成功后软刷新让移除生效
      await reloadHarness({ soft: true, msg: '插件已卸载，正在生效…' }).catch(() => {});
      return r;
    }
    return result;
  });
}

// ---------- 桌面扩展：AI 安装（失败自动诊断修复） ----------
// 常规安装失败时，把错误日志交给 LLM 分析并给出白名单内的修复方案，自动执行后重试。
// 只允许安全的环境变量与 pnpm 参数，绝不让 AI 执行任意 shell 命令或删除文件。
const AI_INSTALL_ALLOWED_FLAGS = new Set([
  '--registry', '--ignore-scripts', '--no-optional', '--force',
  '--prefer-offline', '--resolution-mode', '--strict-peer-dependencies',
  '--no-strict-peer-dependencies', '--prod', '--save-prod', '--verbose'
]);
function aiInstallKey() {
  try {
    const cred = readCredentialsYaml();
    return cred['DSH_AI_INSTALL_KEY'] || cred['DEEPSEEK_API_KEY'] || null;
  } catch { return null; }
}
function readSettingsYamlLocal() {
  try {
    return yaml.load(fs.readFileSync(path.join(dshHome(), 'settings.yaml'), 'utf8')) || {};
  } catch { return {}; }
}
// AI 安装使用的服务：参考 Token 用量分析 —— 复用“当前默认模型服务”的配置与密钥
// （settings.yaml 的 agent-default-model + llm-pi-ai.providers），不复用视觉模型密钥。
// 当前默认服务是什么，就用谁的 baseUrl/model/密钥；未配置时回退到默认 DeepSeek。
async function aiInstallConfig() {
  try {
    const settings = readSettingsYamlLocal();
    const agentModel = settings['agent-default-model'] || {};
    const providerName = agentModel.provider;
    const prov = (settings['llm-pi-ai']?.providers || {})[providerName] || {};
    const cred = readCredentialsYaml();
    const key = (prov.apiKeyEnv && (cred[prov.apiKeyEnv] || process.env[prov.apiKeyEnv]))
      || cred['DEEPSEEK_API_KEY'] || process.env['DEEPSEEK_API_KEY'];
    if (key) {
      const baseUrl = String(prov.baseURL || 'https://api.deepseek.com').replace(/\/+$/, '');
      const model = String(agentModel.model || (Array.isArray(prov.models) ? prov.models[0] : null) || 'deepseek-chat');
      return { baseUrl, model, key, protocol: 'openai', from: providerName || '默认服务', provider: providerName || 'default' };
    }
  } catch {}
  const key = aiInstallKey();
  if (key) {
    return { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', key, protocol: 'openai', from: 'DeepSeek', provider: 'deepseek' };
  }
  return null;
}
function aiInstallPrompt(pkg, log) {
  return `你是 DeepSeek Harness 的插件安装诊断专家。用户尝试安装 npm 插件 "${pkg}" 失败，以下是安装过程输出（stdout+stderr）。请分析失败根因并给出修复方案。

只返回 JSON（不要 markdown 代码块、不要注释），格式：
{"action":"env|registry|retry|advice","env":{"环境变量名":"值"},"command":"pnpm add 可附加的合法参数","reason":"简短中文原因"}

约束：
- action=env：设置环境变量后重试（如 HTTP_PROXY/HTTPS_PROXY/NODE_OPTIONS 等）
- action=registry：更换 npm registry（command 写 --registry=https://...）
- action=retry：直接重试（command 留空）
- action=advice：无法自动修复，reason 给人工建议（command 留空）
- command 只允许这些参数：--registry --ignore-scripts --no-optional --force --prefer-offline --resolution-mode --strict-peer-dependencies --no-strict-peer-dependencies --prod --save-prod --verbose
- 禁止建议删除文件、执行任意 shell 命令、安装系统级软件

[安装输出开始]
${String(log || '').slice(-4000)}
[安装输出结束]`;
}
function callAiDiagnose(pkg, log, cfg) {
  if (!cfg || !cfg.key) {
    return Promise.resolve({ ok: false, msg: '未配置 AI 服务密钥：请在 ~/.dsh/.credentials.yaml 配置当前默认模型服务对应的密钥（如 OPENCODE_GO_API_KEY / DEEPSEEK_API_KEY）后重试' });
  }
  return new Promise((resolve) => {
    let body;
    try {
      const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
      body = JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: aiInstallPrompt(pkg, log) }],
        temperature: 0.2,
        max_tokens: 700,
        response_format: { type: 'json_object' }
      });
    } catch (e) { return resolve({ ok: false, msg: '构造请求失败：' + String(e && e.message || e) }); }
    let req;
    try {
      req = https.request(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + cfg.key, 'user-agent': 'dsh-desktop' },
        timeout: 30000
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            const content = j.choices?.[0]?.message?.content || '';
            const cleaned = String(content).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
            const parsed = JSON.parse(cleaned);
            if (!parsed || typeof parsed.action !== 'string' || !['env', 'registry', 'retry', 'advice'].includes(parsed.action)) {
              throw new Error('AI 返回的 action 不合法');
            }
            return resolve({ ok: true, fix: parsed });
          } catch (e) {
            return resolve({ ok: false, msg: 'AI 返回解析失败：' + String(e && e.message || e) + ' raw=' + String(data).slice(0, 300) });
          }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('AI 请求超时')); });
      req.on('error', (e) => resolve({ ok: false, msg: 'AI 请求失败：' + String(e && e.message || e) }));
      req.end(body);
    } catch (e) {
      return resolve({ ok: false, msg: 'AI 请求异常：' + String(e && e.message || e) });
    }
  });
}
function sanitizeAiEnv(env) {
  const out = {};
  if (!env || typeof env !== 'object') return out;
  for (const [k, v] of Object.entries(env)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && v.length < 500) out[k] = v;
  }
  return out;
}
function sanitizeAiCommand(command) {
  const parts = String(command || '').trim().split(/\s+/).filter(Boolean);
  const allowed = [];
  for (const p of parts) {
    if (!p.startsWith('--')) continue;
    const flag = p.split('=')[0];
    if (AI_INSTALL_ALLOWED_FLAGS.has(flag)) allowed.push(p);
  }
  return allowed;
}
async function aiInstallPlugin(pkg, job, initialResult = null) {
  if (!isValidPkgSpec(pkg)) return { ok: false, log: '包名格式不正确', ai: null };
  const logParts = [];
  const push = (t) => {
    logParts.push(String(t));
    appendLog('[desktop] AI安装: ' + String(t) + '\n');
    // 实时写入任务日志与阶段（前端面板可见）
    if (job) { job.log += 'AI安装: ' + String(t) + '\n'; }
  };
  const setStage = (stage) => { if (job) job.stage = stage; };
  const rounds = [];
  let lastResult = null;
  const baseEnv = await pnpmEnv();
  setStage('AI 诊断中…');
  if (initialResult && initialResult.ok === false) {
    // 常规安装已失败：直接用已发生的失败日志进入诊断，不重复安装浪费时间
    lastResult = initialResult;
    push('常规安装已失败，基于失败日志直接诊断…');
  } else {
    push('第一步：常规安装 ' + pkg);
    lastResult = await runPluginChild('add', pkg, baseEnv, 300000, [], job);
    if (lastResult.ok) {
      const name = isNpmPkgName(pkg) ? pkg : installedNameForSpec(pkg);
      if (name) lastResult = syncBundleAfterInstall(name, lastResult);
      push('✔ 常规安装成功，验证插件加载…');
      const verify = await verifyPluginAfterInstall();
      if (!verify.ok) {
        const rollback = await rollbackPluginInstall(pkg, name, job);
        push('⚠ 插件已安装但加载失败：' + verify.reason + '；已自动回滚：' + rollback);
        return { ok: false, log: logParts.join('\n'), ai: { rounds }, rolledBack: true };
      }
      push('✔ 插件加载验证通过');
      return { ok: true, log: logParts.join('\n'), ai: { rounds } };
    }
    push('✖ 常规安装失败，启动 AI 诊断（最多 3 轮自动修复）…');
  }
  const aiCfg = await aiInstallConfig();
  if (!aiCfg) {
    push('未配置 AI 服务密钥：请在 ~/.dsh/.credentials.yaml 配置当前默认模型服务对应的密钥（如 OPENCODE_GO_API_KEY / DEEPSEEK_API_KEY）后重试');
    return { ok: false, log: logParts.join('\n'), ai: { rounds } };
  }
  push(`使用 AI 服务：${aiCfg.from}（${aiCfg.baseUrl}，模型 ${aiCfg.model}）`);
  let currentEnv = baseEnv;
  for (let round = 1; round <= 3; round++) {
    const diag = await callAiDiagnose(pkg, lastResult.log || '', aiCfg);
    if (!diag.ok) {
      push(`第 ${round} 轮 AI 诊断失败：${diag.msg}`);
      break;
    }
    const fix = diag.fix;
    const reason = String(fix.reason || fix.action || '').slice(0, 300);
    rounds.push({ round, action: fix.action, reason, env: sanitizeAiEnv(fix.env), command: String(fix.command || '').slice(0, 200) });
    if (fix.action === 'advice') {
      push(`第 ${round} 轮 AI 建议人工处理：${reason}`);
      break;
    }
    const newEnv = { ...currentEnv, ...sanitizeAiEnv(fix.env) };
    const flags = sanitizeAiCommand(fix.command);
    const envDesc = Object.keys(sanitizeAiEnv(fix.env)).length ? ' 环境变量：' + Object.keys(sanitizeAiEnv(fix.env)).join(',') : '';
    push(`第 ${round} 轮 AI 方案：${reason}${flags.length ? ' 参数：' + flags.join(' ') : ''}${envDesc}`);
    try {
      lastResult = await runPluginChild('add', pkg, newEnv, 300000, flags, job);
    } catch (e) {
      lastResult = { ok: false, log: String(e && e.message || e) };
    }
    if (lastResult.ok) {
      const name = isNpmPkgName(pkg) ? pkg : installedNameForSpec(pkg);
      if (name) lastResult = syncBundleAfterInstall(name, lastResult);
      push(`✔ 第 ${round} 轮 AI 修复后安装成功，验证插件加载…`);
      const verify = await verifyPluginAfterInstall();
      if (!verify.ok) {
        const rollback = await rollbackPluginInstall(pkg, name);
        push(`⚠ 插件已安装但加载失败：${verify.reason}；已自动回滚：${rollback}`);
        return { ok: false, log: logParts.join('\n'), ai: { rounds }, rolledBack: true };
      }
      push('✔ 插件加载验证通过');
      return { ok: true, log: logParts.join('\n'), ai: { rounds } };
    }
    currentEnv = newEnv;
  }
  // AI 全失败：清理可能的部分残留（某轮 pnpm 可能写入依赖），避免下次启动加载损坏
  let cleanup = '';
  try {
    const name = isNpmPkgName(pkg) ? pkg : installedNameForSpec(pkg);
    if (name) {
      const rm = await runPluginChild('remove', name, currentEnv, 300000);
      syncBundleAfterUninstall(name, { ok: true });
      cleanup = rm.ok ? '已清理残留依赖' : '残留清理失败（' + String(rm.log || '').slice(-150) + '）';
    }
  } catch {}
  push('✖ AI 自动修复未成功，最后错误：' + String(lastResult?.log || '').slice(-600));
  const tail = '✖ AI 自动修复未成功，最后错误：' + String(lastResult?.log || '').slice(-1500) + (cleanup ? '\n' + cleanup : '');
  return { ok: false, log: logParts.join('\n') + '\n--- 最后一次错误 ---\n' + String(lastResult?.log || '').slice(-1500) + (cleanup ? '\n（' + cleanup + '）' : ''), ai: { rounds } };
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
// 发布仓库：GitHub Releases 存放安装包（LTJ002/DeepSeek-Harness）
const UPDATE_REPO = 'LTJ002/DeepSeek-Harness';
// 双源更新：GitHub 主源 + Gitee 备用源（Gitee 仓库创建后填入地址即可生效）
const UPDATE_SOURCES = [
  {
    name: 'github',
    label: 'GitHub',
    api: 'https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest',
    repo: 'https://github.com/' + UPDATE_REPO
  },
  {
    name: 'gitee',
    label: 'Gitee',
    api: 'https://gitee.com/api/v5/repos/LTJ002/DeepSeek-Harness/releases/latest',
    repo: 'https://gitee.com/LTJ002/DeepSeek-Harness',
    // Gitee API 需要权限token；未配置 token 时走匿名（仅公开仓库可读）。留空则自动尝试。
    token: ''
  }
];
// 本地打包版本号（随打包版本变化；若与 harness 内置一致则读顶层）
function localAppVersion() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return p.version || bundledVersion();
  } catch { return bundledVersion(); }
}
// 下载 release 资产（安装包）到 ~/.dsh/update/
// 分片下载：HTTP Range 分段下载，失败自动重试该分片；支持多源回退（urls 数组按优先级）。
const DOWNLOAD_CHUNK_SIZE = 8 * 1024 * 1024; // 8MB/片
const DOWNLOAD_CHUNK_RETRY = 3;
const DOWNLOAD_HEAD_RETRY = 2;

function httpGetStream(url, headers, redirects = 3) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const req = https.get(u, { headers, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpGetStream(new URL(res.headers.location, u).toString(), headers, redirects - 1));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function probeDownload(urls) {
  // 返回 { fileUrl, size, acceptRanges }；head 失败退化为 GET 探测
  const probe = (url) => httpGetStream(url, { 'user-agent': 'dsh-desktop', Range: 'bytes=0-0' })
    .then((res) => {
      const size = parseSizeFromContentRange(res.headers['content-range'], res.headers['content-length']);
      const acceptRanges = /bytes/i.test(String(res.headers['accept-ranges'] || ''));
      res.resume();
      return { fileUrl: url, size, acceptRanges };
    });
  const loop = (i) => {
    if (i >= urls.length) return null;
    return probe(urls[i]).catch(() => (i + 1 < urls.length ? loop(i + 1) : null));
  };
  return loop(0);
}

function parseSizeFromContentRange(cr, cl) {
  if (cr) { const m = /bytes\s+\d+-\d+\/(\d+)/.exec(cr); if (m && m[1] && m[1] !== '*') return Number(m[1]); }
  if (cl) { const n = Number(cl); if (isFinite(n)) return n; }
  return 0;
}

function downloadRange(url, start, end, filePath, fd) {
  return new Promise((resolve) => {
    httpGetStream(url, { 'user-agent': 'dsh-desktop', Range: `bytes=${start}-${end - 1}` }).then((res) => {
      if (res.statusCode !== 206 && res.statusCode !== 200) { res.resume(); return resolve({ ok: false, msg: 'HTTP ' + res.statusCode }); }
      let written = 0;
      res.on('data', (chunk) => {
        try { fs.writeSync(fd, chunk, 0, chunk.length, start + written); written += chunk.length; } catch (e) { res.destroy(e); }
      });
      res.on('end', () => resolve({ ok: true, written }));
      res.on('error', (e) => resolve({ ok: false, msg: String(e && e.message || e) }));
    }).catch((e) => resolve({ ok: false, msg: String(e && e.message || e) }));
  });
}

function downloadUpdateAsset(urlOrList, targetDir) {
  return new Promise((resolve) => {
    const urls = Array.isArray(urlOrList) ? urlOrList.filter(Boolean) : [urlOrList];
    if (urls.length === 0) return resolve({ ok: false, msg: '无效的下载地址' });
    let u;
    try { u = new URL(urls[0]); } catch { return resolve({ ok: false, msg: '无效的下载地址' }); }
    fs.mkdirSync(targetDir, { recursive: true });
    const fileName = u.pathname.split('/').pop() || 'setup.exe';
    const filePath = path.join(targetDir, fileName);
    const tmpPath = filePath + '.part';

    probeDownload(urls).then((probe) => {
      if (!probe) return resolve({ ok: false, msg: '所有源连接失败' });
      const { fileUrl, size, acceptRanges } = probe;
      if (!acceptRanges || !size || size <= 0) {
        // 不支持断点续传：退化为单流下载（仍多源回退）
        return singleStreamDownload(urls, filePath, resolve);
      }
      // 分片下载
      const fd = fs.openSync(tmpPath, 'w');
      const chunks = [];
      for (let s = 0; s < size; s += DOWNLOAD_CHUNK_SIZE) {
        chunks.push({ start: s, end: Math.min(s + DOWNLOAD_CHUNK_SIZE, size) });
      }
      const total = chunks.length;
      let done = 0, failed = false, fallback = false;
      const runChunk = (chunk, attempt) => {
        if (failed) return;
        downloadRange(fileUrl, chunk.start, chunk.end, filePath, fd).then((r) => {
          if (!r.ok) {
            if (attempt < DOWNLOAD_CHUNK_RETRY) return runChunk(chunk, attempt + 1);
            failed = true;
            try { fs.closeSync(fd); } catch {}
            return resolve({ ok: false, msg: '分片下载失败：' + r.msg });
          }
          done++;
          if (done === total) {
            try { fs.closeSync(fd); } catch {}
            fs.renameSync(tmpPath, filePath);
            resolve({ ok: true, filePath, size });
          }
        });
      };
      // 并发分片（控制并发 4）
      let next = 0;
      const worker = () => {
        if (failed) return;
        if (next >= chunks.length) return;
        const idx = next++;
        runChunk(chunks[idx], 1);
        worker();
      };
      for (let i = 0; i < Math.min(4, chunks.length); i++) worker();
    });
  });
}

function singleStreamDownload(urls, filePath, resolve) {
  const attempt = (i) => {
    if (i >= urls.length) return resolve({ ok: false, msg: '所有源下载失败' });
    httpGetStream(urls[i], { 'user-agent': 'dsh-desktop' }).then((res) => {
      if (res.statusCode !== 200) { res.resume(); return attempt(i + 1); }
      const out = fs.createWriteStream(filePath);
      res.pipe(out);
      out.on('finish', () => resolve({ ok: true, filePath }));
      out.on('error', (e) => { out.destroy(); attempt(i + 1); });
    }).catch(() => attempt(i + 1));
  };
  attempt(0);
}
function parseReleaseFromSource(name, body) {
  // GitHub: {tag_name, assets:[{name,browser_download_url}], html_url}
  // Gitee:  {tag_name, assets:[{name,browser_download_url}], html_url}（单对象）或数组
  try {
    let rel = JSON.parse(body);
    if (Array.isArray(rel)) rel = rel[0] || {};
    const tag = rel.tag_name || '';
    const latest = tag.replace(/^v/i, '') || '未知';
    const asset = (rel.assets || []).find((a) => /.exe$/i.test(a.name || '')) || (rel.assets || [])[0];
    const downloadUrl = asset ? (asset.browser_download_url || asset.download_url || null) : null;
    return { tag, latest, downloadUrl, releaseUrl: rel.html_url || null };
  } catch { return null; }
}

function checkUpdate(force = false) {
  const now = Date.now();
  if (!force && updateCache && now - updateCache.at < 5 * 60 * 1000) return Promise.resolve(updateCache.value);
  const current = localAppVersion();
  const kernel = bundledVersion();
  return new Promise((resolve) => {
    // 依次尝试各源，收集每个源的结果；至少一个源成功即可
    let settled = false;
    const sources = [];
    let best = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      const value = {
        current, kernel,
        sources,
        latest: best ? best.latest : (sources[0] && sources[0].latest) || null,
        newer: !!(best && best.latest !== '未知' && compareSemver(best.latest, current) > 0),
        downloadUrl: best ? best.downloadUrl : (sources[0] && sources[0].downloadUrl) || null,
        tagName: best ? best.tag : null,
        releaseUrl: best ? best.releaseUrl : null
      };
      updateCache = { at: Date.now(), value };
      resolve(value);
    };
    let pending = UPDATE_SOURCES.length;
    if (pending === 0) return finish();
    for (const src of UPDATE_SOURCES) {
      const headers = { 'user-agent': 'dsh-desktop' };
      let url = src.api;
      if (src.token) url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(src.token);
      fetchText(url, 3, headers).then((body) => {
        const parsed = parseReleaseFromSource(src.name, body);
        if (parsed) {
          const item = { name: src.name, label: src.label, ...parsed };
          sources.push(item);
          if (!best || (item.latest !== '未知' && compareSemver(item.latest, best.latest) > 0)) best = item;
        }
      }).catch(() => {}).finally(() => { if (--pending === 0) finish(); });
    }
  });
}

// ---------- 桌面扩展：插件市场（awesome-dsh-plugin） ----------
function fetchText(url, redirects = 3, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    if (u.protocol !== 'https:') return reject(new Error('only https'));
    const req = https.get(u, { headers: Object.assign({ 'user-agent': 'dsh-desktop' }, extraHeaders), timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        let next;
        try {
          next = new URL(res.headers.location, u).toString();
        } catch (e) {
          return reject(new Error(`invalid redirect location: ${e && e.message || e}`));
        }
        return resolve(fetchText(next, redirects - 1, extraHeaders));
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
let marketRefreshTimer = null;
const MARKET_CACHE_MS = 5 * 60 * 1000;
const MARKET_SNAPSHOT_REFRESH_MS = 6 * 60 * 60 * 1000;
function pluginMarketSnapshotPath() {
  return path.join(dshHome(), 'plugin-market-snapshot.md');
}
function savePluginMarketSnapshot(md) {
  try {
    fs.mkdirSync(dshHome(), { recursive: true });
    const tmp = pluginMarketSnapshotPath() + '.tmp';
    fs.writeFileSync(tmp, md, 'utf8');
    fs.renameSync(tmp, pluginMarketSnapshotPath());
  } catch {}
}
function loadPluginMarketSnapshot() {
  try {
    const p = pluginMarketSnapshotPath();
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  } catch { return ''; }
}
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
        // 远程拉取成功后保存为本地快照，后续离线时也能使用最新一次的数据
        savePluginMarketSnapshot(md);
        const groups = parseMarketMd(md);
        marketFetchedAt = Date.now();
        return { total: groups.reduce((n, g) => n + g.items.length, 0), groups, source: 'remote', fetchedAt: new Date().toISOString() };
      })
      .catch(() => {
        // 失败不缓存成功时间，并清空 promise：下次调用（刷新按钮）会重新尝试远程
        marketPromise = null;
        marketFetchedAt = 0;
        // 优先使用上次自动保存的本地快照，其次使用安装包内置快照
        const local = loadPluginMarketSnapshot();
        if (local) {
          const groups = parseMarketMd(local);
          return { total: groups.reduce((n, g) => n + g.items.length, 0), groups, source: 'local-snapshot', fetchedAt: new Date().toISOString() };
        }
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

// ---------- 桌面扩展：视觉 API 快速配置 ----------
function credentialsYamlPath() {
  return path.join(dshHome(), '.credentials.yaml');
}
function readCredentialsYaml() {
  try {
    if (!fs.existsSync(credentialsYamlPath())) return {};
    return yaml.load(fs.readFileSync(credentialsYamlPath(), 'utf8')) || {};
  } catch { return {}; }
}
function writeCredentialValue(ref, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error('凭据名称只能包含字母、数字、下划线，且不能以数字开头');
  if (typeof value !== 'string' || !value.trim()) throw new Error('API Key 不能为空');
  const file = credentialsYamlPath();
  const data = readCredentialsYaml();
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('凭据文件格式不正确，请手动检查 ~/.dsh/.credentials.yaml');
  data[ref] = value.trim();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, yaml.dump(data), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}
function httpGetJsonLocal(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = http.get(url, { timeout: timeoutMs }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c.toString(); if (body.length > 2e6) req.destroy(); });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
    } catch (e) { reject(e); }
  });
}
function httpPostJsonLocal(url, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const payload = JSON.stringify(body);
    const req = http.request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Origin': u.origin,
        'Sec-Fetch-Site': 'same-origin'
      },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c.toString(); if (data.length > 2e6) req.destroy(); });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}
async function visionToolkitSnapshot() {
  if (!serverUrl) throw new Error('Harness 服务未就绪');
  const res = await httpGetJsonLocal(`${serverUrl}/_dsh/vision-toolkit/settings`);
  if (!res || !res.ok || !res.value) throw new Error('无法读取视觉工具设置：' + JSON.stringify(res).slice(0, 200));
  return res.value;
}
async function testVisionToolkitConnection() {
  if (!serverUrl) throw new Error('Harness 服务未就绪');
  const res = await httpPostJsonLocal(`${serverUrl}/_dsh/vision-toolkit/settings`, { action: 'health', testConnection: true });
  if (!res || !res.ok) throw new Error('连接测试失败：' + JSON.stringify(res).slice(0, 300));
  return res.value;
}
async function saveVisionToolkitConfig({ apiKey, baseUrl, model, credential, protocol }) {
  if (!serverUrl) throw new Error('Harness 服务未就绪');
  // 先写凭据文件，dsh 的 credentials-local 会热加载
  writeCredentialValue(credential, apiKey);
  // 读取当前设置拿到 revision，再覆盖 provider 配置
  const snap = await visionToolkitSnapshot();
  const current = snap.settings?.value || {};
  const value = {
    ...current,
    provider: {
      ...(current.provider || {}),
      baseUrl,
      model,
      credential,
      protocol
    }
  };
  const res = await httpPostJsonLocal(`${serverUrl}/_dsh/vision-toolkit/settings`, {
    action: 'save',
    expectedRevision: snap.settings?.revision ?? 0,
    value
  });
  if (!res || !res.ok) throw new Error('保存视觉工具设置失败：' + JSON.stringify(res).slice(0, 300));
  let test = null;
  try { test = await testVisionToolkitConnection(); } catch (e) { test = { ok: false, msg: String(e && e.message || e) }; }
  return { ok: true, credential, baseUrl, model, protocol, test };
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
function zstdDecompressAsync(buf) {
  const zlib = require('zlib');
  return new Promise((resolve, reject) => {
    zlib.zstdDecompress(buf, (err, out) => (err ? reject(err) : resolve(out)));
  });
}
function zstdCompressAsync(buf, options) {
  const zlib = require('zlib');
  return new Promise((resolve, reject) => {
    zlib.zstdCompress(buf, options, (err, out) => (err ? reject(err) : resolve(out)));
  });
}
// 异步全量解压：主线程不被 zstd 同步解压卡住，回滚大会话时界面仍可响应
async function sessionPlaintextAsync(buf) {
  const frames = scanZstdFrames(buf);
  const parts = [];
  for (const f of frames) parts.push(await zstdDecompressAsync(buf.subarray(f.start, f.end)));
  return Buffer.concat(parts);
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
function repairSessionFile(file, bufOverride) {
  try {
    const zlib = require('zlib');
    const buf = bufOverride || fs.readFileSync(file);
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
  // 异步读盘 + 每处理一个文件让出主线程：修复期间窗口渲染、设置切换保持响应
  for (const file of files) {
    let buf = null;
    try { buf = await fs.promises.readFile(file); } catch {}
    results.push(repairSessionFile(file, buf || undefined));
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
// ---------- 会话摘要缓存 ----------
// 会话文件是 append-only 的 zstd JSONL。每次启动/刷新都全量解压所有会话非常慢
// （实测 42 个会话 / 35MB 约 6.6 秒）。这里把每个会话的摘要按 mtime+size 持久化，
// 未变化的文件直接读缓存，只有新增/修改过的会话才解压尾部帧重新摘要。
const SESSION_SUMMARY_CACHE_VERSION = 1;
function sessionSummaryCachePath() {
  return path.join(dshHome(), 'desktop-session-cache.json');
}
async function loadSessionSummaryCache() {
  try {
    const raw = await fs.promises.readFile(sessionSummaryCachePath(), 'utf8');
    const j = JSON.parse(raw);
    if (j && j.version === SESSION_SUMMARY_CACHE_VERSION && j.files && typeof j.files === 'object') return j.files;
  } catch {}
  return {};
}
async function saveSessionSummaryCache(files) {
  try {
    const obj = { version: SESSION_SUMMARY_CACHE_VERSION, files };
    await fs.promises.writeFile(sessionSummaryCachePath(), JSON.stringify(obj), 'utf8');
  } catch {}
}
// 从 zstd 帧缓冲中提取“列表摘要”：只解压头部 + 从文件尾向前解压，直到找到最后一条
// user/message 和最后一条 agent/inbox/spliced。相比全量解压，大文件通常只解压尾部少量帧。
async function sessionSummaryFromBuf(buf) {
  const frames = scanZstdFrames(buf);
  if (!frames.length) return null;
  let header = null;
  try {
    const first = (await zstdDecompressAsync(buf.subarray(frames[0].start, frames[0].end))).toString('utf8');
    header = JSON.parse(first.split('\n')[0]);
  } catch { return null; }
  let lastUserMessageId = '';
  let lastUserText = '';
  let lastUserTime = '';
  let hasRollback = false;
  let lastSpliceUserId = '';
  for (let i = frames.length - 1; i >= 0; i--) {
    let chunk;
    try {
      chunk = (await zstdDecompressAsync(buf.subarray(frames[i].start, frames[i].end))).toString('utf8');
    } catch { continue; }
    const lines = chunk.split('\n');
    for (let j = lines.length - 1; j >= 0; j--) {
      const line = lines[j].trim();
      if (!line) continue;
      let p;
      try { p = JSON.parse(line); } catch { continue; }
      if (p?.type === 'user/message' && p.data?.id) {
        if (!lastUserMessageId) {
          lastUserMessageId = p.data.id;
          lastUserText = userMessageText(p);
          try { lastUserTime = new Date(p.time).toLocaleString(); } catch {}
        }
      }
      if (p?.type === 'agent/inbox/spliced' && Array.isArray(p.data?.inserted) && p.data.inserted.length > 0) {
        if (!hasRollback) {
          hasRollback = true;
          const inserted = p.data.inserted;
          const user = inserted.find((m) => m?.role === 'user' || m?.source?.kind === 'user') || inserted[0];
          if (user?.id) lastSpliceUserId = user.id;
        }
      }
      if (lastUserMessageId && hasRollback) break;
    }
    if (lastUserMessageId && hasRollback) break;
  }
  if (!lastUserMessageId) lastUserMessageId = lastSpliceUserId;
  return {
    id: header.id || null,
    cwd: header.cwd || '',
    lastUserMessageId,
    lastUserText,
    time: lastUserTime,
    hasRollback
  };
}
// 会话列表改为后台异步扫描 + 缓存：旧实现每次在 IPC 里同步读取/解压全部
// session.jsonl.zstd，文件多时会把 Electron 主进程整段卡死（设置页“加载数据…”）。
// 现在：启动时后台预热缓存；设置页首次打开等待在途扫描；每处理 3 个文件让出主线程；
// 后续打开直接读缓存，点“刷新”才强制重扫。
let sessionListsCache = null;
let sessionScanPromise = null;
let sessionListsMutation = 0;
function invalidateSessionListsCache() {
  sessionListsCache = null;
  sessionListsMutation++;
}
function startSessionScan() {
  const mutationAtStart = sessionListsMutation;
  const run = (async () => {
    const scanStartedAt = Date.now();
    const rollback = [];
    const del = [];
    const byId = new Map();
    const files = [];
    const diskCache = await loadSessionSummaryCache();
    const nextDiskCache = {};
    walkSessionFiles((file) => files.push(file));
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const st = await fs.promises.stat(file);
        const cached = diskCache[file];
        let summary = null;
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          summary = cached;
        } else {
          const buf = await fs.promises.readFile(file); // 只对变化文件做尾部解压
          summary = await sessionSummaryFromBuf(buf);
          if (!summary) continue;
          summary.mtimeMs = st.mtimeMs;
          summary.size = st.size;
        }
        nextDiskCache[file] = summary;
        const item = {
          file,
          id: summary.id || path.basename(path.dirname(file)),
          cwd: summary.cwd || '',
          lastUserMessageId: summary.lastUserMessageId || '',
          lastUserText: summary.hasRollback ? summary.lastUserText : '',
          time: summary.time || ''
        };
        if (summary.id) byId.set(summary.id, file);
        if (summary.hasRollback) rollback.push(item);
        del.push(item);
      } catch {}
      // 每个文件后都让出主线程：刷新期间窗口渲染、设置切换、按钮点击全程可响应
      await new Promise((resolve) => setImmediate(resolve));
    }
    // 扫描期间发生过删除/回滚：结果作废，不写缓存，下一次请求会重扫
    if (mutationAtStart === sessionListsMutation) {
      sessionListsCache = { rollback, del, byId, at: Date.now() };
      saveSessionSummaryCache(nextDiskCache).catch(() => {});
    }
    appendLog(`[desktop] 会话列表扫描完成：${files.length} 个，耗时 ${Date.now() - scanStartedAt}ms\n`);
    return sessionListsCache;
  })();
  let wrapped;
  wrapped = run.finally(() => { if (sessionScanPromise === wrapped) sessionScanPromise = null; });
  sessionScanPromise = wrapped;
  return wrapped;
}
function scanSessionListsAsync(force = false) {
  if (!force) {
    if (sessionScanPromise) return sessionScanPromise;
    if (sessionListsCache) return Promise.resolve(sessionListsCache);
  }
  // 强制刷新必须等在途扫描结束后重新扫一遍，否则会拿到删除/回滚前的旧数据
  if (force && sessionScanPromise) {
    const prev = sessionScanPromise.catch(() => {});
    const chained = prev.then(() => startSessionScan()); // 直接启动新一轮，避免经公共入口递归命中在途 promise
    let wrapped;
    wrapped = chained.finally(() => { if (sessionScanPromise === wrapped) sessionScanPromise = null; });
    sessionScanPromise = wrapped;
    return wrapped;
  }
  return startSessionScan();
}
// 请求宿主插件卸载内存中的 live Session（无感删除的第一步）
function requestDisposeSession(sessionId) {
  if (!serverUrl) return Promise.resolve(null);
  const target = `${serverUrl}/enh/dispose-session?sessionId=${encodeURIComponent(sessionId)}`;
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
// 删除整个会话：把 session 目录移入 ~/.dsh/sessions-trash（可找回），不从磁盘抹除。
// 优先“无感删除”：宿主插件卸载内存会话后直接 rename，不重启服务、不整页刷新；
// 只有 rename 失败（文件被占用）才挂起服务重试，并让 UI 软恢复。
async function deleteSessionFile(file) {
  let serviceStopped = false;
  try {
    const root = path.join(dshHome(), 'sessions');
    if (!file.startsWith(root + path.sep)) return { ok: false, msg: '文件不在会话目录内' };
    const dir = path.dirname(file);
    // 会话目录可能是 session-<uuid>、<uuid> 或 od-<uuid> 等形态；只要文件名是
    // session.jsonl.zstd 且父目录是标准会话 ID 目录就允许删除。
    const sessionDirRe = /^(?:[a-z0-9]+-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (path.basename(file) !== 'session.jsonl.zstd' || !sessionDirRe.test(path.basename(dir))) {
      return { ok: false, msg: '无法识别的会话目录' };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rel = path.relative(root, dir);
    const trashDir = path.join(trashRoot(), stamp);
    const dest = path.join(trashDir, rel);
    // 会话目录是 <项目>/<session-id> 两层结构：必须把中间的项目目录也建出来
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });

    // 1) 无感路径：卸载内存会话（若在线），直接移动文件
    let headerId = null;
    try {
      const buf = await fs.promises.readFile(file);
      const frames = scanZstdFrames(buf);
      if (frames.length) {
        const zlib = require('zlib');
        const first = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8');
        headerId = JSON.parse(first.split('\n')[0]).id;
      }
    } catch {}
    if (headerId) {
      await requestDisposeSession(headerId);
      // 给宿主 detach 一点时间关闭文件句柄，提高“无感删除”成功率
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    try {
      await fs.promises.rename(dir, dest);
      invalidateSessionListsCache(); // 会话已删除，缓存失效
      return { ok: true, seamless: true, msg: `已删除会话（已移入回收目录：${path.join('sessions-trash', stamp, rel)}）` };
    } catch {}

    // 2) 只停桌面自己启动的 harness（快，无 PowerShell），再试一次
    stopHarness();
    serviceStopped = true;
    try {
      await fs.promises.rename(dir, dest);
      invalidateSessionListsCache();
      connect(); // 已停止服务，成功删除后必须重启
      return { ok: true, seamless: false, msg: `已删除会话（已移入回收目录：${path.join('sessions-trash', stamp, rel)}），服务已自动恢复` };
    } catch {}

    // 3) 最后手段：异步清扫所有 dsh web 写入进程，主线程不再被 PowerShell 卡住
    await killDshWebWritersAsync();
    serviceStopped = true;
    await fs.promises.rename(dir, dest);
    invalidateSessionListsCache();
    connect(); // 已停止服务，成功删除后必须重启
    return { ok: true, seamless: false, msg: `已删除会话（已移入回收目录：${path.join('sessions-trash', stamp, rel)}），服务已自动恢复` };
  } catch (e) {
    if (serviceStopped) connect();
    return { ok: false, msg: String(e && e.message || e) };
  }
}
// ---------- 回收站（sessions-trash）管理 ----------
function walkTrashSessionFiles(cb) {
  const root = trashRoot();
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name === 'session.jsonl.zstd') cb(p);
    }
  };
  if (fs.existsSync(root)) walk(root);
}
async function scanTrashListAsync() {
  const root = trashRoot();
  const files = [];
  walkTrashSessionFiles((file) => files.push(file));
  const items = [];
  for (const file of files) {
    try {
      const buf = await fs.promises.readFile(file);
      const summary = await sessionSummaryFromBuf(buf);
      if (!summary) continue;
      const rel = path.relative(root, file);
      const parts = rel.split(path.sep);
      const item = {
        file,
        dir: path.dirname(file),
        id: summary.id || path.basename(path.dirname(file)),
        cwd: summary.cwd || '',
        lastUserText: summary.hasRollback ? summary.lastUserText : '',
        time: summary.time || '',
        trashedAt: parts[0] || ''
      };
      items.push(item);
    } catch {}
    await new Promise((resolve) => setImmediate(resolve));
  }
  return items;
}
async function deleteTrashSession(dir) {
  try {
    const root = trashRoot();
    if (!dir.startsWith(root + path.sep)) return { ok: false, msg: '文件不在回收目录内' };
    if (!fs.existsSync(path.join(dir, 'session.jsonl.zstd'))) return { ok: false, msg: '无法识别的回收会话目录' };
    await fs.promises.rm(dir, { recursive: true, force: true });
    invalidateSessionListsCache(); // 删除归档会话后，回滚/删除/回收站列表缓存全部失效，避免前端显示陈旧数据
    return { ok: true, msg: '已彻底删除归档会话' };
  } catch (e) {
    return { ok: false, msg: String(e && e.message || e) };
  }
}
async function restoreTrashSession(dir) {
  try {
    const root = trashRoot();
    if (!dir.startsWith(root + path.sep)) return { ok: false, msg: '文件不在回收目录内' };
    if (!fs.existsSync(path.join(dir, 'session.jsonl.zstd'))) return { ok: false, msg: '无法识别的回收会话目录' };
    const rel = path.relative(root, dir);
    const parts = rel.split(path.sep);
    if (parts.length < 2) return { ok: false, msg: '无法识别的归档路径' };
    // 去掉最前面的归档时间戳目录，恢复到正常会话目录：sessions/<项目>/<session-id>
    const destRel = parts.slice(1).join(path.sep);
    const dest = path.join(dshHome(), 'sessions', destRel);
    // 目标已存在（同名会话被重新创建）：返回明确错误，避免 rename 静默失败
    if (fs.existsSync(dest)) {
      return { ok: false, msg: `无法恢复：目标会话目录已存在（${destRel}）。同名会话可能已重新创建，请先处理再恢复。` };
    }
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.rename(dir, dest);
    invalidateSessionListsCache();
    return { ok: true, msg: '已恢复归档会话' };
  } catch (e) {
    return { ok: false, msg: String(e && e.message || e) };
  }
}
function openTrashFolder() {
  const root = trashRoot();
  try { fs.mkdirSync(root, { recursive: true }); } catch {}
  shell.openPath(root);
  return { ok: true, path: root };
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
      createdRemoved.push(c.file);
    } catch {}
  }
  return { restored: [...new Set(restored)], createdRemoved };
}
async function performRollback(file, idx, options = {}) {
  // 截断会话文件前必须挂起写入方：回滚期间继续追加会在截断处产生 seq 断层/丢消息。
  // 热回滚路径已在宿主插件内先收缩了内存日志，之后没有活跃写入者，可跳过挂起（suspend:false）。
  if (options.suspend !== false) await suspendHarness();
  const buf = await fs.promises.readFile(file);
  const lines = (await sessionPlaintextAsync(buf)).toString('utf8').split('\n');
  const header = JSON.parse(lines[0]);
  const ops = reverseEditsFrom(lines, idx, header.cwd || '');
  // keepTargetSplice：联动回滚“到消息 M”时保留 M 这条用户消息本身，只删掉 M 之后的内容
  const fixedText = (options.keepTargetSplice ? lines.slice(0, idx + 1) : lines.slice(0, idx)).join('\n') + '\n';
  const headerEnd = fixedText.indexOf('\n');
  const zlib = require('zlib');
  const opts = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
  const out = Buffer.concat([
    await zstdCompressAsync(Buffer.from(fixedText.slice(0, headerEnd + 1), 'utf8'), opts),
    await zstdCompressAsync(Buffer.from(fixedText.slice(headerEnd + 1), 'utf8'), opts)
  ]);
  const backup = `${file}.bak-${Date.now()}`;
  await fs.promises.copyFile(file, backup);
  await fs.promises.writeFile(file, out);
  invalidateSessionListsCache(); // 会话内容已变，下一次打开设置页用新数据
  const undo = applyReverseEdits(ops, header.cwd || '');
  const parts = [];
  if (undo.restored.length) parts.push(`撤销了 ${undo.restored.length} 个文件修改：${undo.restored.join('、')}`);
  if (undo.createdRemoved.length) parts.push(`移除了 ${undo.createdRemoved.length} 个本轮新建文件：${undo.createdRemoved.join('、')}`);
  const filesMsg = parts.length ? `，${parts.join('；')}` : '';
  return { ok: true, msg: `已回滚到该轮之前${filesMsg}，备份：${backup}` };
}
async function rollbackSession(file) {
  try {
    const root = path.join(dshHome(), 'sessions');
    if (!file.startsWith(root + path.sep)) return { ok: false, msg: '文件不在会话目录内' };
    const buf = await fs.promises.readFile(file);
    // 优先走无感热回滚：不杀进程、不整页重启
    const summary = await sessionSummaryFromBuf(buf);
    if (summary && summary.id && summary.lastUserMessageId) {
      const hot = await hotRollbackSessionByUserMessage(summary.id, summary.lastUserMessageId);
      if (hot && hot.ok) return hot;
      if (hot && hot.code === 'ACTIVE_TURN') {
        return { ok: false, code: 'ACTIVE_TURN', msg: '该消息对应的回复仍在生成中，请先停止本轮回复，再执行回滚。' };
      }
      if (hot && (hot.code === 'OFFLINE' || hot.code === 'NO_MESSAGE' || hot.code === 'NO_SPLICE' || hot.code === 'NO_FILE')) {
        const disk = await rollbackSessionByUserMessage(summary.id, summary.lastUserMessageId, false, { suspend: false });
        if (disk && disk.ok && win && !win.isDestroyed()) {
          try { win.webContents.reload(); } catch { win.loadURL(serverUrl); }
        }
        return disk;
      }
      // UNREACHABLE/HOT_FAILED/HOT_ERROR：继续走旧的全量路径
    }
    await suspendHarness(); // 读取到写入之间保持稳定快照
    const lines = (await sessionPlaintextAsync(buf)).toString('utf8').split('\n');
    const idx = lastSplicedIndex(lines);
    if (idx === -1) {
      connect();
      return { ok: false, msg: '未找到可回滚的用户消息' };
    }
    return await performRollback(file, idx, { suspend: false });
  } catch (e) {
    connect();
    return { ok: false, msg: String(e && e.message || e) };
  }
}
// 只解压第一个 zstd 帧读会话头：findSessionFile 之前会对每个文件全量解压，
// 会话一多/文件一大时主线程直接卡死。现在查文件只用头部，不再解压整份日志。
async function readSessionHeaderAsync(file) {
  const buf = await fs.promises.readFile(file);
  const frames = scanZstdFrames(buf);
  if (!frames.length) return null;
  const first = await zstdDecompressAsync(buf.subarray(frames[0].start, frames[0].end));
  const line = first.toString('utf8').split('\n')[0];
  if (!line) return null;
  return JSON.parse(line);
}
async function findSessionFile(sessionId) {
  if (sessionListsCache?.byId) return sessionListsCache.byId.get(sessionId) || null;
  const files = [];
  walkSessionFiles((file) => files.push(file));
  for (const file of files) {
    try {
      const header = await readSessionHeaderAsync(file);
      if (header && header.id === sessionId) return file;
    } catch {}
    await new Promise((resolve) => setImmediate(resolve));
  }
  return null;
}
async function rollbackSessionByMessage(sessionId, messageId) {
  try {
    const file = await findSessionFile(sessionId);
    if (!file) return { ok: false, msg: `未找到会话 ${sessionId}` };
    const buf = await fs.promises.readFile(file);
    const lines = (await sessionPlaintextAsync(buf)).toString('utf8').split('\n');
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
      return await performRollback(file, idx);
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
async function rollbackSessionByUserMessage(sessionId, userMessageId, keepTarget = false, options = {}) {
  try {
    const file = await findSessionFile(sessionId);
    if (!file) return { ok: false, msg: `未找到会话 ${sessionId}` };
    const buf = await fs.promises.readFile(file);
    const lines = (await sessionPlaintextAsync(buf)).toString('utf8').split('\n');
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
      const result = await performRollback(file, idx, { keepTargetSplice: keepTarget, suspend: options.suspend });
      if (userText) result.userMessage = userText; // 回滚成功的消息文本，UI 用于回填输入框
      return result;
    } catch (e) {
      if (options.suspend !== false) connect(); // performRollback 已挂起服务，失败时必须恢复
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
  if (!hot) return { ok: false, code: 'UNREACHABLE', msg: '原地回滚服务不可用' };
  if (hot.ok !== true) return { ok: false, code: hot.code || 'HOT_FAILED', msg: hot.error || '无法原地回滚' };
  try {
    const file = await findSessionFile(sessionId);
    if (!file) return { ok: false, code: 'NO_FILE', msg: `未找到会话 ${sessionId}` };
    const lines = sessionPlaintext(fs.readFileSync(file)).toString('utf8').split('\n');
    let userLine = -1;
    let userText = '';
    for (let i = lines.length - 1; i >= 1; i--) {
      let p;
      try { p = JSON.parse(lines[i]); } catch { continue; }
      if (p?.type === 'user/message' && p.data?.id === userMessageId) { userLine = i; userText = userMessageText(p); break; }
    }
    if (userLine === -1) return { ok: false, code: 'NO_MESSAGE', msg: '未找到该用户消息' };
    let idx = -1;
    for (let i = userLine - 1; i >= 1; i--) {
      let p;
      try { p = JSON.parse(lines[i]); } catch { continue; }
      if (p?.type === 'agent/inbox/spliced' && Array.isArray(p.data?.inserted) && p.data.inserted.some((m) => m?.id === userMessageId)) { idx = i; break; }
    }
    if (idx === -1) return { ok: false, code: 'NO_SPLICE', msg: '未找到该消息的 inbox 记录' };
    // 内存日志已收缩，磁盘截断不再挂起服务；反向撤销该轮文件修改照旧执行
    const result = await performRollback(file, idx, { keepTargetSplice: false, suspend: false });
    if (userText) result.userMessage = userText;
    appendLog(`[desktop] 热回滚(${sessionId}/${userMessageId}): ${result.msg}\n`);
    stashRollbackMessage(userText);
    if (win && !win.isDestroyed()) {
      try { win.webContents.reload(); } catch { win.loadURL(serverUrl); }
    }
    return result;
  } catch (e) {
    appendLog(`[desktop] 热回滚失败：${e?.message || e}\n`);
    return { ok: false, code: 'HOT_ERROR', msg: String(e?.message || e) };
  }
}

// ---------- 插件定期更新检查（多来源）----------
// 支持三种来源：
//   1) npm 包：查 registry 的 latest，对比已装版本
//   2) git+https GitHub 仓库：查 GitHub API 最新 tag / 默认分支 commit
//   3) GitHub 归档直链（/archive/refs/heads/...）：从 URL 推断 owner/repo，查 GitHub
// link:（本地链接，如 dsh-desktop-settings）跳过。
let pluginUpdateCache = null;
function semanticCompare(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}
function fetchJson(url, timeoutMs = 15000) {
  return fetchText(url, 2).then((text) => JSON.parse(text));
}
async function npmLatestVersion(name) {
  const pkgName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name;
  const data = await fetchJson('https://registry.npmmirror.com/' + encodeURIComponent(pkgName) + '/latest');
  return data.version || null;
}
async function githubLatestRef(owner, repo) {
  if (!owner || !repo) return null;
  const repoClean = repo.replace(/\.git$/, '');
  try {
    const tagData = await fetchJson('https://api.github.com/repos/' + owner + '/' + repoClean + '/releases/latest');
    if (tagData && tagData.tag_name) return { kind: 'tag', value: tagData.tag_name };
  } catch {}
  try {
    const commits = await fetchJson('https://api.github.com/repos/' + owner + '/' + repoClean + '/commits?per_page=1');
    if (Array.isArray(commits) && commits[0] && commits[0].sha) return { kind: 'commit', value: commits[0].sha.slice(0, 7) };
  } catch {}
  return null;
}
// 更新已安装插件：按 dependencies 里记录的源重新安装（git commit 源会拉到最新），跳过本地链接插件
async function pluginUpdate(name) {
  const manifest = readJsonSafe(path.join(profileDir(), 'package.json')) || {};
  const spec = (manifest.dependencies || {})[name];
  if (!spec) return { ok: false, log: `未找到已安装依赖：${name}` };
  if (spec.startsWith('link:')) return { ok: false, log: `${name} 是本地链接插件，无法自动更新` };
  return installPlugin(spec);
}
async function checkPluginUpdates() {
  const manifest = readJsonSafe(path.join(profileDir(), 'package.json')) || {};
  const deps = manifest.dependencies || {};
  const results = [];
  const updates = [];
  for (const name of Object.keys(deps)) {
    const spec = deps[name];
    const entry = { name, source: 'unknown', installedVersion: null, latestVersion: null, updateAvailable: false, msg: '' };
    try {
      const installed = readJsonSafe(path.join(profileDir(), 'node_modules', name, 'package.json'));
      entry.installedVersion = installed && installed.version ? installed.version : null;
      if (spec.startsWith('link:')) {
        entry.source = 'link'; entry.msg = '本地链接，跳过'; entry.updateAvailable = false;
      } else if (spec.startsWith('git+https://github.com/')) {
        entry.source = 'git';
        const m = spec.match(/git\+https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
        const ref = await githubLatestRef(m ? m[1] : null, m ? m[2] : null);
        if (ref) {
          entry.latestVersion = ref.value;
          const cur = entry.installedVersion || '';
          entry.updateAvailable = ref.kind === 'commit' ? !cur.includes(ref.value) : semanticCompare(ref.value.replace(/^v/, ''), cur.replace(/^v/, '')) > 0;
          entry.msg = ref.kind === 'tag' ? 'GitHub 最新 tag' : 'GitHub 最新 commit';
        } else entry.msg = 'GitHub 查询失败';
      } else if (spec.startsWith('https://github.com/') && spec.includes('/archive/')) {
        entry.source = 'github-archive';
        const m = spec.match(/github\.com\/([^/]+)\/([^/]+)\/archive/);
        const ref = await githubLatestRef(m ? m[1] : null, m ? m[2] : null);
        if (ref) {
          entry.latestVersion = ref.value;
          entry.updateAvailable = ref.kind === 'tag' ? semanticCompare(ref.value.replace(/^v/, ''), (entry.installedVersion || '').replace(/^v/, '')) > 0 : true;
          entry.msg = 'GitHub 归档来源';
        } else entry.msg = 'GitHub 查询失败';
      } else {
        entry.source = 'npm';
        const latest = await npmLatestVersion(name);
        if (latest) {
          entry.latestVersion = latest;
          entry.updateAvailable = semanticCompare(latest, entry.installedVersion) > 0;
          entry.msg = 'npm';
        } else entry.msg = 'npm 查询失败';
      }
    } catch (e) {
      entry.msg = String(e && e.message || e);
    }
    if (entry.updateAvailable) updates.push(entry);
    results.push(entry);
  }
  return { checkedAt: new Date().toISOString(), total: results.length, updates, results };
}
function pluginUpdateStatus() {
  if (!pluginUpdateCache) return null;
  const stale = Date.now() - pluginUpdateCache.at > 24 * 60 * 60 * 1000;
  const value = pluginUpdateCache.value;
  return { checkedAt: value.checkedAt, total: value.total, updates: value.updates, results: value.results, stale };
}

// ---------- IPC ----------
ipcMain.on('dsh:restart', () => {
  // “重启应用”：整进程重启最可靠（避免端口/文件句柄残留导致重启失败）
  // app.exit() 不会触发 before-quit，必须手动清除“正在运行”标记，
  // 否则下次启动会被误判为异常退出并全量校验会话日志，导致启动变慢。
  try {
    stopHarness();
    clearRunningMarker();
    app.relaunch();
    app.exit(0);
  } catch {
    connect();
  }
});
ipcMain.on('dsh:quit', () => app.quit());
// ---------- 自绘标题栏窗口控制 ----------
ipcMain.on('dsh:win-minimize', () => { if (win && !win.isDestroyed()) win.minimize(); });
ipcMain.on('dsh:win-maximize', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.on('dsh:win-close', () => { if (win && !win.isDestroyed()) win.close(); });
ipcMain.handle('dsh:win-is-maximized', () => (win && !win.isDestroyed()) ? win.isMaximized() : false);
ipcMain.handle('dsh:reload-harness', () => reloadHarness());
ipcMain.handle('dsh:reload-harness-soft', (_e, msg) => reloadHarness({ soft: true, msg: typeof msg === 'string' && msg ? msg : '正在应用更改…' }));
ipcMain.handle('dsh:get-log-path', () => logFile());
ipcMain.handle('dsh:detect-mcp', () => detectMcp());
ipcMain.handle('dsh:list-plugins', () => listPlugins());
ipcMain.handle('dsh:plugin-job-status', () => pluginJobStatusList());
ipcMain.handle('dsh:install-plugin', (_e, pkg) => installPlugin(pkg));
ipcMain.handle('dsh:uninstall-plugin', (_e, pkg, force) => uninstallPlugin(pkg, force === true));
ipcMain.handle('dsh:disabled-defaults-list', () => readDisabledDefaults());
ipcMain.handle('dsh:default-plugins-list', () => Object.keys(DEFAULT_PROFILE_PLUGINS));
ipcMain.handle('dsh:disabled-defaults-add', (_e, pkg) => {
  if (typeof pkg === 'string' && pkg) markDefaultPluginDisabled(pkg);
  return { ok: true };
});
ipcMain.handle('dsh:disabled-defaults-restore', (_e, pkg) => {
  if (typeof pkg === 'string' && pkg) {
    const map = readDisabledDefaults();
    if (Object.prototype.hasOwnProperty.call(map, pkg)) {
      delete map[pkg];
      saveDisabledDefaults(map);
    }
  }
  return { ok: true };
});
// 通用市场禁用名单：用户禁用的插件不再出现在插件市场安装流程（独立于默认插件禁用）
const MARKET_DISABLED_MARKER = path.join(profileDir(), '.market-disabled.json');
function readMarketDisabled() {
  try { return readJsonSafe(MARKET_DISABLED_MARKER) || {}; } catch { return {}; }
}
function saveMarketDisabled(map) {
  try { fs.writeFileSync(MARKET_DISABLED_MARKER, JSON.stringify(map, null, 2), 'utf8'); } catch {}
}
ipcMain.handle('dsh:market-disabled-list', () => readMarketDisabled());
ipcMain.handle('dsh:market-disabled-add', (_e, repo) => {
  if (typeof repo === 'string' && repo) {
    const map = readMarketDisabled();
    if (!map[repo]) { map[repo] = Date.now(); saveMarketDisabled(map); }
  }
  return { ok: true };
});
ipcMain.handle('dsh:market-disabled-remove', (_e, repo) => {
  if (typeof repo === 'string' && repo) {
    const map = readMarketDisabled();
    if (Object.prototype.hasOwnProperty.call(map, repo)) {
      delete map[repo];
      saveMarketDisabled(map);
    }
  }
  return { ok: true };
});
ipcMain.handle('dsh:ai-install-plugin', (_e, pkg) => aiInstallPlugin(pkg));
ipcMain.handle('dsh:check-update', () => checkUpdate());
// 下载并启动安装更新：下载 release 安装包到临时目录，然后启动安装器（覆盖安装，弹 UAC）
ipcMain.handle('dsh:update-download', async (_e, downloadUrl) => {
  try {
    const urls = Array.isArray(downloadUrl) ? downloadUrl.filter((x) => typeof x === 'string' && /^https?:\/\//.test(x)) : (typeof downloadUrl === 'string' && /^https?:\/\//.test(downloadUrl) ? [downloadUrl] : []);
    if (urls.length === 0) return { ok: false, msg: '无效的下载地址' };
    const targetDir = path.join(dshHome(), 'update');
    const result = await downloadUpdateAsset(urls, targetDir);
    if (!result.ok) return { ok: false, msg: result.msg || '下载失败' };
    appendLog('[desktop] 更新安装包已下载：' + result.filePath + '\n');
    // 启动安装器（覆盖安装）。用 spawn 启动，不阻塞主进程；安装器本身是 admin 权限，会弹 UAC
    try {
      const child = spawn(result.filePath, [], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return { ok: true, msg: '安装包已下载，正在启动安装程序…' };
    } catch (e) {
      return { ok: true, msg: '安装包已下载：' + result.filePath + '（请手动运行安装）' };
    }
  } catch (e) {
    return { ok: false, msg: String(e && e.message || e) };
  }
});
ipcMain.handle('dsh:plugin-update-check', async () => {
  try { return { ok: true, ...(pluginUpdateStatus() || (await checkPluginUpdates())) }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.handle('dsh:plugin-update', async (_e, name) => {
  if (typeof name !== 'string' || !name.trim()) return { ok: false, log: '缺少插件名' };
  try { return await pluginUpdate(name.trim()); }
  catch (e) { return { ok: false, log: String(e && e.message || e) }; }
});
ipcMain.handle('dsh:market-list', (_e, force) => getMarketList(force === true));
ipcMain.handle('dsh:resolve-plugin', (_e, repo) => resolveRepoPkg(repo));
ipcMain.handle('dsh:repair-sessions', () => repairAllSessions());
ipcMain.handle('dsh:session-rollback-list', async (_e, force) => (await scanSessionListsAsync(force === true)).rollback);
ipcMain.handle('dsh:session-delete-list', async (_e, force) => (await scanSessionListsAsync(force === true)).del);
ipcMain.handle('dsh:session-delete', (_e, file) => deleteSessionFile(file));
ipcMain.handle('dsh:session-trash-list', () => scanTrashListAsync());
ipcMain.handle('dsh:session-trash-delete', (_e, dir) => deleteTrashSession(dir));
ipcMain.handle('dsh:session-trash-restore', (_e, dir) => restoreTrashSession(dir));
ipcMain.handle('dsh:get-trash-path', () => trashRoot());
ipcMain.handle('dsh:open-trash-folder', () => openTrashFolder());
ipcMain.handle('dsh:read-image-file', async (_e, rawPath) => {
  try {
    if (typeof rawPath !== 'string') return null;
    let filePath = rawPath.trim();
    // 去掉首尾引号：部分来源（如从地址栏/属性框复制）会带 " 或 '
    filePath = filePath.replace(/^["']|["']$/g, '');
    // 兼容 file:///C:/... 形式的剪贴板路径
    if (/^file:\/\/\//i.test(filePath)) {
      try {
        const u = new URL(filePath);
        filePath = decodeURIComponent(u.pathname);
        // Windows 的 file:///C:/... pathname 形如 /C:/...，去掉开头的 /
        if (/^\/[A-Za-z]:[\\/]/.test(filePath)) filePath = filePath.slice(1);
      } catch {}
    }
    if (!filePath.trim()) return null;
    // Snipaste 等截图工具可能只给纯文件名（如 Snipaste_xxx.png），没有完整路径：
    // 在常见截图/临时目录里查找真实文件。
    if (!path.isAbsolute(filePath) && !filePath.includes('/') && !filePath.includes('\\')) {
      const candidates = [
        path.join(os.homedir(), 'AppData', 'Roaming', 'Snipaste'),
        path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
        path.join(os.homedir(), 'Pictures', 'Snipaste'),
        process.env.TEMP,
        os.tmpdir()
      ];
      for (const dir of candidates) {
        if (!dir) continue;
        const p = path.join(dir, filePath);
        if (fs.existsSync(p)) { filePath = p; break; }
      }
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : null;
    if (!mime) return null;
    const buf = await fs.promises.readFile(filePath);
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
});
// Snipaste 等截图工具把图片放在系统剪贴板位图里，renderer 拿不到 File，
// 这里用 Electron clipboard.readImage() 在主进程读取位图并转成 PNG dataURL。
ipcMain.handle('dsh:read-clipboard-image', () => {
  try {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    const png = img.toPNG();
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: img.getSize().width, height: img.getSize().height };
  } catch { return null; }
});
ipcMain.handle('dsh:vision-config-save', async (_e, payload) => {
  try {
    if (!payload || typeof payload !== 'object') return { ok: false, msg: '参数错误' };
    const { apiKey, baseUrl, model, credential = 'VISION_API_KEY', protocol = 'openai' } = payload;
    if (typeof apiKey !== 'string' || !apiKey.trim()) return { ok: false, msg: '请填写 API Key' };
    if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl.trim())) return { ok: false, msg: 'Base URL 必须是 http(s) 地址' };
    if (typeof model !== 'string' || !model.trim()) return { ok: false, msg: '请填写模型名称' };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credential)) return { ok: false, msg: '凭据名称只能包含字母、数字、下划线，且不能以数字开头' };
    if (!['openai', 'anthropic'].includes(protocol)) return { ok: false, msg: '协议必须是 openai 或 anthropic' };
    const r = await saveVisionToolkitConfig({ apiKey: apiKey.trim(), baseUrl: baseUrl.trim(), model: model.trim(), credential, protocol });
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, msg: String(e && e.message || e) };
  }
});
ipcMain.handle('dsh:vision-config-status', async () => {
  try {
    const snap = await visionToolkitSnapshot();
    return { ok: true, credential: snap.credential, settings: snap.settings?.value };
  } catch (e) {
    return { ok: false, msg: String(e && e.message || e) };
  }
});
ipcMain.handle('dsh:vision-key-save', async (_e, payload) => {
  try {
    if (!payload || typeof payload !== 'object') return { ok: false, msg: '参数错误' };
    const { credential = 'VISION_API_KEY', apiKey } = payload;
    if (typeof apiKey !== 'string' || !apiKey.trim()) return { ok: false, msg: '请填写 API Key' };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credential)) return { ok: false, msg: '凭据名称只能包含字母、数字、下划线，且不能以数字开头' };
    writeCredentialValue(credential, apiKey.trim());
    return { ok: true, credential };
  } catch (e) {
    return { ok: false, msg: String(e && e.message || e) };
  }
});
ipcMain.handle('dsh:session-rollback', async (_e, file) => rollbackSession(file));
ipcMain.handle('dsh:session-rollback-by-message', async (_e, sessionId, messageId) => rollbackSessionByMessage(sessionId, messageId));
ipcMain.handle('dsh:session-rollback-by-user-message', async (_e, sessionId, userMessageId) => rollbackSessionByUserMessage(sessionId, userMessageId));
// 消息旁“回滚到此消息”专用：优先无感热回滚（不重启程序）；不可用时退回“截断+页内提示层刷新”
ipcMain.handle('dsh:session-rollback-by-user-message-soft', async (_e, sessionId, userMessageId) => {
  const result = await rollbackSessionByUserMessage(sessionId, userMessageId);
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
  if (hot && hot.ok) return hot;
  const code = hot && hot.code;
  // 活跃轮次：绝不杀进程/重启，直接告诉用户原因，运行中的会话继续跑
  if (code === 'ACTIVE_TURN') return { ok: false, code, msg: '该消息对应的回复仍在生成中，请先停止本轮回复，再执行回滚。' };
  // 会话不在内存（OFFLINE）或消息定位失败：只改磁盘文件，不重启服务、不影响其他会话
  if (code === 'OFFLINE' || code === 'NO_MESSAGE' || code === 'NO_SPLICE' || code === 'NO_FILE') {
    const result = await rollbackSessionByUserMessage(sessionId, userMessageId, false, { suspend: false });
    appendLog(`[desktop] 消息回滚磁盘路径(${sessionId}/${userMessageId}): ok=${!!(result && result.ok)} msg=${result && result.msg}\n`);
    if (result && result.ok) {
      stashRollbackMessage(result.userMessage || '');
      if (win && !win.isDestroyed()) {
        try { win.webContents.reload(); } catch { win.loadURL(serverUrl); }
      }
    }
    return result;
  }
  // 只有原地服务不可用（旧版 harness / 路由未注册）才走整机兜底
  const result = await rollbackSessionByUserMessage(sessionId, userMessageId);
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
    await suspendHarness(); // 恢复文件期间不允许任何写入方存活
    const result = rewindEngine.execute(id, signature);
    let conversation = null;
    const cp = result.checkpoint;
    if (cp && cp.sessionId && cp.messageId) {
      // suspendHarness 已经在上面清过场，这里不需要再次挂起
      conversation = await rollbackSessionByUserMessage(cp.sessionId, cp.messageId, true, { suspend: false });
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
    // 内核版本变化时强制冷启动：清除驻留缓存，避免复用旧内核进程导致功能错乱
    ensureFreshKernelOnUpgrade();
    // 先显示启动页：确保 profile 初始化（仅首次启动较慢）期间用户能看到界面。
    // 是否真·首次：桌面设置插件还没放进 profile 时才算首次。
    const firstRun = !fs.existsSync(path.join(profileDir(), 'node_modules', 'dsh-desktop-settings', 'package.json'));
    createWindow({ firstRun });
    createTray();
    dshStartupTime = Date.now(); // 记录启动时间，供空会话清理判断
    // 插件定期更新检查：启动 15 秒后后台检查一次，之后每 24 小时自动检查（仅提示，不自动安装）
    setTimeout(() => { checkPluginUpdates().then((d) => { pluginUpdateCache = { at: Date.now(), value: d }; appendLog('[desktop] 插件更新检查完成：' + d.updates.length + ' 个可更新，共 ' + d.total + ' 个\n'); }).catch((e) => appendLog('[desktop] 插件更新检查失败：' + (e && e.message || e) + '\n')); }, 15000);
    setInterval(() => { checkPluginUpdates().then((d) => { pluginUpdateCache = { at: Date.now(), value: d }; appendLog('[desktop] 插件更新检查完成：' + d.updates.length + ' 个可更新，共 ' + d.total + ' 个\n'); }).catch(() => {}); }, 24 * 60 * 60 * 1000);
    // 并行准备：探测外部 dsh web 服务 + 确保桌面设置插件就位，避免串行等待拖慢启动。
    // 后台预热会话列表缓存：设置页“对话回滚/删除对话”打开时直接可用，避免同步扫描卡住主进程
    const existingWebPromise = findExistingDshWeb();
    try { await ensureDesktopPlugin(); } catch (err) { appendLog(`[desktop] ensure plugin: ${err}\n`); }
    // 默认插件安装延迟到 harness 就绪后（20s）再执行：避免与 harness 冷启动并行跑
    // pnpm 安装抢 CPU，导致加载环境时窗口长时间无响应/未响应
    setTimeout(() => { ensureDefaultPlugins().catch((err) => appendLog(`[desktop] ensure default plugins: ${err && err.message || err}\n`)); }, 20000);
    // 后台执行：类似 Claude Code 从 ~/.claude.json 检测 MCP 并同步（等待 harness 就绪后再改 patch + 热重载）
    setTimeout(() => { ensureMcpAutoSync().catch((err) => appendLog(`[desktop] MCP 检测: ${err && err.message || err}\n`)); }, 8000);
    // 优先复用本机已有的 dsh web 服务（避免两个服务并发写同一份会话日志）；
    // 没有外部服务时再启动内置服务。会话日志全量校验只在首次启动/上次异常退出时执行，
    // 日常启动直接跳过，避免每次扫描全部 session.jsonl.zstd 拖慢加载。
    const repairDecision = shouldAutoRepairOnStartup();
    // 记录“正在运行”标记：如果本次没能走到 before-quit（崩溃/强杀），下次启动会触发一次会话日志校验。
    // 放在 shouldAutoRepairOnStartup 判断之后：避免本次启动刚写入的标记干扰本次判断
    markRunning();
    existingWebPromise.then((ext) => {
      if (ext) {
        markRepairedOnce();
        externalServer = ext;
        serverUrl = ext.url;
        if (win && !win.isDestroyed()) { win.loadURL(ext.url); warmSessionListsSoon(); warmCachesSoon(); }
      } else {
        // 方案A热启动：优先复用驻留 harness（持续运行、会话一致），跳过自动修复直接接入
        tryReuseHarness().then((reusedUrl) => {
          if (reusedUrl) {
            markRepairedOnce();
            serverUrl = reusedUrl;
            if (win && !win.isDestroyed()) { win.loadURL(reusedUrl); warmSessionListsSoon(); warmCachesSoon(true); }
            return;
          }
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
        });
      }
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) { createWindow(); connect(); }
    });
  });
}
app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  // 插件安装/卸载仍在主进程运行：先不退出，任务完成后自动退出
  if (pluginJobCount > 0) {
    quitDeferredForPluginJobs = true;
    appendLog('[desktop] 插件任务进行中：延迟退出，任务完成后自动退出\n');
    return;
  }
  app.quit();
});
app.on('before-quit', () => {
  quitting = true;
  clearRunningMarker();
  // 方案A：驻留 harness —— 记录 URL 与退出时间，延迟杀进程，供热启动复用
  try { fs.writeFileSync(path.join(dshHome(), 'cache', 'harness-last-exit.txt'), String(Date.now()), 'utf8'); } catch {}
  if (serverProc && serverUrl) {
    try {
      fs.mkdirSync(path.join(dshHome(), 'cache'), { recursive: true });
      fs.writeFileSync(path.join(dshHome(), 'cache', 'harness-url.txt'), serverUrl, 'utf8');
    } catch {}
    const child = serverProc;
    serverProc = null;
    residentProc = child;
    if (harnessResidentTimer) clearTimeout(harnessResidentTimer);
    harnessResidentTimer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
        }
        appendLog('[desktop] 驻留 harness 已超时终止\n');
      } catch {}
    }, HARNESS_RESIDENT_MS);
    if (harnessResidentTimer.unref) harnessResidentTimer.unref();
    appendLog(`[desktop] harness 已驻留 ${HARNESS_RESIDENT_MS / 1000}s（快速重启将复用）\n`);
  } else {
    stopHarness();
  }
});
