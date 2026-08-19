// DeepSeek Harness 桌面版主进程
// 职责：启动内置的 dsh web 服务，在原生窗口里打开 Web 界面，
// 并提供桌面端扩展：MCP 检测、插件安装（内置 pnpm）、更新检查。
const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const https = require('https');
const yaml = require('js-yaml');

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
    try {
      const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh' -and $_.CommandLine -match '\\sweb(\\s|$)' } | ForEach-Object { $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $_.ProcessId -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -ExpandProperty LocalPort -Unique); [PSCustomObject]@{ pid = $_.ProcessId; ports = $ports; cmd = $_.CommandLine } } | ConvertTo-Json -Compress"
      ], { windowsHide: true, timeout: 30000, encoding: 'utf8' });
      if (ps.status !== 0) return null;
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
function connect() {
  showLoading();
  startHarness()
    .then((url) => { if (win && !win.isDestroyed()) win.loadURL(url); })
    .catch((err) => showError(err && err.message ? err.message : String(err)));
}
// 只重启内置 Harness 并刷新页面，不重启桌面应用本身（用于回滚/插件变更后的生效）
function reloadHarness() {
  if (reloadPromise) return reloadPromise;
  reloadPromise = (async () => {
    if (!win || win.isDestroyed()) return { ok: false, msg: '窗口不可用' };
    reloadingHarness = true;
    showLoading();
    try {
      // 当前连的是外部 dsh web 时：关掉它并改由桌面内置服务接管，保证回滚/删除后内存状态与磁盘一致
      if (externalServer) {
        try { spawnSync('taskkill', ['/pid', String(externalServer.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
        externalServer = null;
        serverUrl = null;
      }
      const url = await startHarness();
      win.loadURL(url);
      return { ok: true, msg: '已刷新会话' };
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
function injectWebSettings() {
  if (!win || win.isDestroyed()) return;
  const script = path.join(__dirname, 'app', 'inject-settings.js');
  if (!fs.existsSync(script)) return;
  win.webContents.executeJavaScript(fs.readFileSync(script, 'utf8'), true).catch(() => {});
}
async function ensureDesktopPlugin() {
  // 把“插件与 MCP”设置段插件直接放入 web profile（本地 link 依赖，不访问 npm 注册表）
  const marker = path.join(profileDir(), 'node_modules', 'dsh-desktop-settings', 'package.json');
  if (fs.existsSync(marker)) return true;
  const src = path.join(resourcesRoot(), 'plugins', 'dsh-desktop-settings');
  if (!fs.existsSync(path.join(src, 'package.json'))) return false;

  // profile 尚未初始化时先触发一次初始化（--help 只写 profile，不启动服务）
  const manifest = path.join(profileDir(), 'package.json');
  if (!fs.existsSync(manifest)) {
    try {
      spawnSync(nodeExe(), [harnessBin(), '--profile', 'web', '--help'], {
        cwd: workspaceDir(), env: process.env, windowsHide: true, stdio: 'ignore', timeout: 120000
      });
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

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1080, minHeight: 700,
    backgroundColor: '#f9fafb', title: APP_NAME, icon: iconPath(),
    autoHideMenuBar: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, 'app', 'loading.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  const wc = win.webContents;
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
async function detectMcp() {
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
  return servers;
}

// ---------- 桌面扩展：插件安装（内置 pnpm） ----------
function listPlugins() {
  const manifest = readJsonSafe(path.join(profileDir(), 'package.json')) ?? {};
  return {
    dependencies: Object.keys(manifest.dependencies ?? {}),
    bundles: manifest.dsh?.profile?.bundles ?? []
  };
}
// 包名/安装源安全校验：npm 包名、github: 源、GitHub https 归档直链
function isValidPkgSpec(pkg) {
  if (typeof pkg !== 'string') return false;
  if (/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(pkg)) return true;
  if (/^github:[A-Za-z0-9._-]+\/[A-Za-z0-9._~#-]+$/i.test(pkg)) return true;
  return /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/archive\/refs\/heads\/[A-Za-z0-9._-]+\.tar\.gz$/i.test(pkg);
}
function installPlugin(pkg) {
  if (!isValidPkgSpec(pkg)) {
    return Promise.resolve({ ok: false, log: '包名格式不正确（只支持 npm 包名）' });
  }
  // 优先使用系统 pnpm（与 profile 现有 node_modules 的 store 版本一致），
  // 没有 pnpm 时回退到内置 pnpm 11（新机器首次安装走这条路径）。
  const hasSystemPnpm = (() => {
    try { return spawnSync('where.exe', ['pnpm'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }).status === 0; }
    catch { return false; }
  })();
  const env = hasSystemPnpm
    ? { ...process.env }
    : { ...process.env, PATH: runtimeDir() + path.delimiter + (process.env.PATH || '') };
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(nodeExe(), [harnessBin(), 'plugin', '--profile', 'web', 'add', pkg], {
        cwd: workspaceDir(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      return resolve({ ok: false, log: String(e) });
    }
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', (e) => resolve({ ok: false, log: String(e) }));
    child.on('close', (code) => resolve({ ok: code === 0, log: `${out}\n${err}`.trim() }));
  });
}
function uninstallPlugin(pkg) {
  if (!isValidPkgSpec(pkg)) {
    return Promise.resolve({ ok: false, log: '包名格式不正确（只支持 npm 包名）' });
  }
  const hasSystemPnpm = (() => {
    try { return spawnSync('where.exe', ['pnpm'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }).status === 0; }
    catch { return false; }
  })();
  const env = hasSystemPnpm
    ? { ...process.env }
    : { ...process.env, PATH: runtimeDir() + path.delimiter + (process.env.PATH || '') };
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(nodeExe(), [harnessBin(), 'plugin', '--profile', 'web', 'remove', pkg], {
        cwd: workspaceDir(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      return resolve({ ok: false, log: String(e) });
    }
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', (e) => resolve({ ok: false, log: String(e) }));
    child.on('close', (code) => resolve({ ok: code === 0, log: `${out}\n${err}`.trim() }));
  });
}

// ---------- 桌面扩展：更新检查 ----------
function bundledVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(harnessDir(), 'package.json'), 'utf8')).version || '未知'; }
  catch { return '未知'; }
}
function checkUpdate() {
  return new Promise((resolve) => {
    const req = https.get('https://registry.npmmirror.com/@deepseek-ai/dsh/latest', { timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ current: bundledVersion(), latest: JSON.parse(body).version || '未知' }); }
        catch { resolve({ current: bundledVersion(), latest: '未知' }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ current: bundledVersion(), latest: null, error: String(e) }));
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
        return resolve(fetchText(new URL(res.headers.location, u).toString(), redirects - 1));
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
function getMarketList() {
  if (!marketPromise) {
    marketPromise = fetchText('https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/README.zh.md')
      .then((md) => ({ total: parseMarketMd(md).reduce((n, g) => n + g.items.length, 0), groups: parseMarketMd(md), source: 'remote', fetchedAt: new Date().toISOString() }))
      .catch(() => {
        // 网络不可用时回退到随应用打包的离线快照，市场始终可用
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
    if (buf.length - offset < 4) throw new Error('torn frame');
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at ${offset}`);
    offset += 4;
    const descriptor = buf.readUInt8(offset++);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      const blockHeader = buf.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('reserved block type');
      offset += blockType === 1 ? 1 : blockSize;
      if (lastBlock) break;
    }
    if (checksum) offset += 4;
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
  for (const r of raw) {
    if (!Number.isSafeInteger(r) || r < 0) { dropped.push(`非法 ${r}`); continue; }
    if (own !== null && r >= own) { dropped.push(`越界 ${r}>=${own}`); continue; }
    if (clean.includes(r)) { dropped.push(`重复 ${r}`); continue; }
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
    const plain = sessionPlaintext(buf);
    const lines = plain.toString('utf8').split('\n');
    const problem = verifySessionLines(lines);
    if (!problem) return { ok: true, repaired: false, msg: '会话日志完整，无需修复' };

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
    return { ok: true, repaired: true, msg: `已修复（${problem}；剔除非法引用 ${dropped.length} 个），备份：${backup}` };
  } catch (e) {
    return { ok: false, msg: String(e && e.message || e) };
  }
}
async function repairAllSessions() {
  const root = path.join(dshHome(), 'sessions');
  const results = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name === 'session.jsonl.zstd') results.push(repairSessionFile(p));
    }
  };
  if (fs.existsSync(root)) walk(root);
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
function sessionRollbackList() {
  const out = [];
  walkSessionFiles((file) => {
    try {
      const buf = fs.readFileSync(file);
      const lines = sessionPlaintext(buf).toString('utf8').split('\n');
      const header = JSON.parse(lines[0]);
      const idx = lastSplicedIndex(lines);
      if (idx === -1) return;
      let time = '';
      try { time = new Date(JSON.parse(lines[idx]).time).toLocaleString(); } catch {}
      out.push({
        file,
        id: header.id ?? path.basename(path.dirname(file)),
        cwd: header.cwd ?? '',
        lastUserText: userTextFromLine(lines[idx]),
        time
      });
    } catch {}
  });
  return out;
}
// 删除对话用的全量列表（含没有任何消息的空白会话）
function sessionDeleteList() {
  const out = [];
  walkSessionFiles((file) => {
    try {
      const lines = sessionPlaintext(fs.readFileSync(file)).toString('utf8').split('\n');
      const header = JSON.parse(lines[0]);
      const idx = lastSplicedIndex(lines);
      out.push({
        file,
        id: header.id ?? path.basename(path.dirname(file)),
        cwd: header.cwd ?? '',
        lastUserText: idx === -1 ? '' : userTextFromLine(lines[idx]),
        time: idx === -1 ? '' : (() => { try { return new Date(JSON.parse(lines[idx]).time).toLocaleString(); } catch { return ''; } })()
      });
    } catch {}
  });
  return out;
}
// 删除整个会话：把 session 目录移入 ~/.dsh/sessions-trash（可找回），不从磁盘抹除
function deleteSessionFile(file) {
  try {
    const root = path.join(dshHome(), 'sessions');
    if (!file.startsWith(root + path.sep)) return { ok: false, msg: '文件不在会话目录内' };
    const dir = path.dirname(file);
    if (!path.basename(dir).startsWith('session-')) return { ok: false, msg: '无法识别的会话目录' };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rel = path.relative(root, dir);
    const trashDir = path.join(dshHome(), 'sessions-trash', stamp);
    fs.mkdirSync(trashDir, { recursive: true });
    fs.renameSync(dir, path.join(trashDir, rel));
    return { ok: true, msg: `已删除会话（已移入回收目录：${path.join('sessions-trash', stamp, rel)}）` };
  } catch (e) {
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
      const reverted = content.split(e.newStr).join(e.oldStr);
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
function performRollback(file, idx) {
  const buf = fs.readFileSync(file);
  const lines = sessionPlaintext(buf).toString('utf8').split('\n');
  const header = JSON.parse(lines[0]);
  const ops = reverseEditsFrom(lines, idx, header.cwd || '');
  const fixedText = lines.slice(0, idx).join('\n') + '\n';
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
    if (!file.startsWith(root)) return { ok: false, msg: '文件不在会话目录内' };
    const buf = fs.readFileSync(file);
    const lines = sessionPlaintext(buf).toString('utf8').split('\n');
    const idx = lastSplicedIndex(lines);
    if (idx === -1) return { ok: false, msg: '未找到可回滚的用户消息' };
    return performRollback(file, idx);
  } catch (e) {
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
    return performRollback(file, idx);
  } catch (e) {
    return { ok: false, msg: String(e && e.message || e) };
  }
}
// 长按用户消息 → 撤销回滚：先定位 user/message（data.id === 用户消息 id），
// 再回溯到把它插入 inbox 的那条 agent/inbox/spliced，从该处截断并还原文件修改。
function rollbackSessionByUserMessage(sessionId, userMessageId) {
  try {
    const file = findSessionFile(sessionId);
    if (!file) return { ok: false, msg: `未找到会话 ${sessionId}` };
    const lines = sessionPlaintext(fs.readFileSync(file)).toString('utf8').split('\n');
    let userLine = -1;
    for (let i = lines.length - 1; i >= 1; i--) {
      let p;
      try { p = JSON.parse(lines[i]); } catch { continue; }
      if (p?.type === 'user/message' && p.data?.id === userMessageId) { userLine = i; break; }
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
    return performRollback(file, idx);
  } catch (e) {
    return { ok: false, msg: String(e && e.message || e) };
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
ipcMain.handle('dsh:reload-harness', () => reloadHarness());
ipcMain.handle('dsh:get-log-path', () => logFile());
ipcMain.handle('dsh:detect-mcp', () => detectMcp());
ipcMain.handle('dsh:list-plugins', () => listPlugins());
ipcMain.handle('dsh:install-plugin', (_e, pkg) => installPlugin(pkg));
ipcMain.handle('dsh:uninstall-plugin', (_e, pkg) => uninstallPlugin(pkg));
ipcMain.handle('dsh:check-update', () => checkUpdate());
ipcMain.handle('dsh:market-list', () => getMarketList());
ipcMain.handle('dsh:resolve-plugin', (_e, repo) => resolveRepoPkg(repo));
ipcMain.handle('dsh:repair-sessions', () => repairAllSessions());
ipcMain.handle('dsh:session-rollback-list', () => sessionRollbackList());
ipcMain.handle('dsh:session-delete-list', () => sessionDeleteList());
ipcMain.handle('dsh:session-delete', (_e, file) => deleteSessionFile(file));
ipcMain.handle('dsh:session-rollback', (_e, file) => rollbackSession(file));
ipcMain.handle('dsh:session-rollback-by-message', (_e, sessionId, messageId) => rollbackSessionByMessage(sessionId, messageId));
ipcMain.handle('dsh:session-rollback-by-user-message', (_e, sessionId, userMessageId) => rollbackSessionByUserMessage(sessionId, userMessageId));
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

async function showUpdateDialog() {
  const info = await checkUpdate();
  const newer = info.latest && info.latest !== '未知' && info.latest !== info.current;
  dialog.showMessageBox(win ?? undefined, {
    type: 'info',
    title: '检查更新',
    message: newer ? `发现新版本：${info.latest}` : '当前已是最新',
    detail: `内置 Harness 版本：${info.current}\n最新发布版本：${info.latest ?? '查询失败'}\n\n` +
      (newer ? '重新打包桌面安装包并覆盖安装即可更新（配置和会话保留在 ~/.dsh）。' : '桌面端与内置 Harness 均为最新可交付版本。')
  });
}

// ---------- 菜单 ----------
function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '设置…', click: () => openSettingsWindow('market') },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '工具',
      submenu: [
        { label: '插件市场', click: () => openSettingsWindow('market') },
        { label: '检测可用 MCP 服务器', click: () => openSettingsWindow('mcp') },
        { label: '已安装插件', click: () => openSettingsWindow('plugins') },
        { type: 'separator' },
        { label: '打开日志文件位置', click: () => { try { shell.showItemInFolder(logFile()); } catch {} } }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '检查更新', click: () => showUpdateDialog() },
        { label: '关于 DeepSeek Harness', click: () => dialog.showMessageBox(win ?? undefined, { type: 'info', title: '关于', message: APP_NAME, detail: `桌面端 0.1.0\n内置 Harness ${bundledVersion()}\n数据目录：${dshHome()}` }) }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
    try { await ensureDesktopPlugin(); } catch (err) { appendLog(`[desktop] ensure plugin: ${err}\n`); }
    createWindow();
    // 优先复用本机已有的 dsh web 服务（避免两个服务并发写同一份会话日志）；
    // 没有外部服务时，先自动修复会话日志（此时无任何写入方），再启动内置服务。
    findExistingDshWeb().then((ext) => {
      if (ext) {
        externalServer = ext;
        serverUrl = ext.url;
        if (win && !win.isDestroyed()) win.loadURL(ext.url);
      } else {
        autoRepairSessions()
          .then((r) => {
            appendLog(`[desktop] 启动自动修复完成：修复 ${r.repaired} 个会话，共扫描 ${r.results.length} 个\n`);
            connect();
          })
          .catch((err) => {
            appendLog(`[desktop] 启动自动修复失败：${err}\n`);
            connect();
          });
      }
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) { createWindow(); connect(); }
    });
  });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { quitting = true; stopHarness(); });
