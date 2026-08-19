// 注入到 DeepSeek Harness Web 界面内的“设置”抽屉：
// 插件市场 / MCP 服务器 / 已安装插件 / 更新（数据全部来自桌面桥 window.dshDesktop）
(function () {
  if (window.__dshSettingsInjected) return;
  const api = window.dshDesktop;
  if (!api) return;
  window.__dshSettingsInjected = true;

  const css = document.createElement('style');
  css.textContent = `
    #dsh-settings-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;border:1px solid #0f1115;background:#ffffff;color:#0f1115;padding:8px 14px;border-radius:999px;font-size:12px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.12);font-family:inherit}
    #dsh-settings-fab:hover{background:#0f1115;color:#fff}
    .dshx-drawer{position:fixed;top:0;right:0;bottom:0;width:460px;max-width:92vw;z-index:2147483001;background:#fff;color:#0f1115;box-shadow:-8px 0 30px rgba(0,0,0,.18);display:none;flex-direction:column;font-family:"Segoe UI","PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:13px}
    .dshx-drawer.open{display:flex}
    .dshx-head{padding:16px 18px;border-bottom:1px solid #ececf0;display:flex;align-items:center;gap:10px}
    .dshx-head h2{font-size:16px;font-weight:600;margin:0;flex:1}
    .dshx-x{border:1px solid #d5d8df;background:#fff;color:#4b5563;width:26px;height:26px;border-radius:8px;cursor:pointer;font-size:14px;line-height:1}
    .dshx-nav{display:flex;gap:4px;padding:8px 14px;border-bottom:1px solid #ececf0;flex-wrap:wrap}
    .dshx-nav button{border:none;background:transparent;color:#4b5563;padding:7px 11px;border-radius:8px;font-size:12px;cursor:pointer}
    .dshx-nav button.active{background:#f1f3f6;color:#0f1115;font-weight:600}
    .dshx-body{flex:1;overflow:auto;padding:14px 18px 22px}
    .dshx-sec{display:none}.dshx-sec.active{display:block}
    .dshx-sub{color:#81858c;font-size:12px;margin-bottom:10px;line-height:1.6}
    .dshx-actions{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}
    .dshx-btn{border:1px solid #0f1115;background:#fff;color:#0f1115;padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer}
    .dshx-btn:hover{background:#0f1115;color:#fff}
    .dshx-btn:disabled{opacity:.5;cursor:default}
    .dshx-btn:disabled:hover{background:#fff;color:#0f1115}
    .dshx-btn.small{padding:3px 9px;border-radius:6px}
    .dshx-input{flex:1;min-width:150px;border:1px solid #d5d8df;border-radius:8px;padding:7px 11px;font-size:12px;outline:none}
    .dshx-card{border:1px solid #ececf0;border-radius:10px;padding:10px 12px;margin-bottom:8px}
    .dshx-card .t1{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .dshx-card .name{font-weight:600;font-family:Consolas,monospace;font-size:12px}
    .dshx-badge{border-radius:6px;padding:2px 7px;background:#eef1f4;font-size:11px;white-space:nowrap}
    .dshx-badge.bad{color:#dc2626;background:#fdecec}
    .dshx-badge.warn{color:#b45309;background:#fdf3e7}
    .dshx-mono{font-family:Consolas,monospace;font-size:11px;color:#4b5563;word-break:break-all;white-space:pre-wrap;margin-top:4px;line-height:1.5}
    .dshx-desc{color:#4b5563;font-size:12px;margin-top:4px;line-height:1.6}
    .dshx-status{color:#81858c;font-size:11px;margin-top:5px}
    .dshx-cat{font-size:12px;font-weight:600;color:#81858c;margin:14px 0 6px}
    .dshx-empty{color:#81858c;text-align:center;padding:32px 0;font-size:12px}
    .dshx-li{display:flex;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid #ececf0;font-size:12px}
    .dshx-li b{font-family:Consolas,monospace;font-weight:600}
    .dshx-tag{color:#81858c;font-size:11px}
    .dshx-pre{background:#f6f7f9;border:1px solid #ececf0;border-radius:10px;padding:10px;font-size:11px;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow:auto;margin-top:8px}
    .dshx-a{color:#0f1115;text-decoration:underline;margin-left:4px}
  `;
  document.head.appendChild(css);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fab = document.createElement('button');
  fab.id = 'dsh-settings-fab';
  fab.textContent = '⚙ 设置';
  document.body.appendChild(fab);

  const drawer = document.createElement('div');
  drawer.className = 'dshx-drawer';
  drawer.innerHTML = `
    <div class="dshx-head"><h2>设置</h2><button class="dshx-x" title="关闭">×</button></div>
    <div class="dshx-nav">
      <button data-tab="market" class="active">插件市场</button>
      <button data-tab="mcp">MCP 服务器</button>
      <button data-tab="plugins">已安装插件</button>
      <button data-tab="update">更新</button>
    </div>
    <div class="dshx-body">
      <section class="dshx-sec active" data-sec="market">
        <div class="dshx-sub" id="dshx-market-sub">数据源：awesome-dsh-plugin</div>
        <div class="dshx-actions"><button class="dshx-btn" id="dshx-market-refresh">刷新市场</button></div>
        <div id="dshx-market"></div>
      </section>
      <section class="dshx-sec" data-sec="mcp">
        <div class="dshx-sub">当前 web 端配置的 MCP 服务器（~/.dsh/profiles/web）</div>
        <div class="dshx-actions"><button class="dshx-btn" id="dshx-mcp-refresh">重新检测</button></div>
        <div id="dshx-mcp"></div>
      </section>
      <section class="dshx-sec" data-sec="plugins">
        <div class="dshx-sub">使用内置 pnpm，无需安装环境；安装后重启应用生效</div>
        <div class="dshx-actions">
          <input class="dshx-input" id="dshx-pkg" placeholder="npm 包名，例如 @deepseek-ai/dsh-xxx">
          <button class="dshx-btn" id="dshx-install">安装</button>
          <button class="dshx-btn" id="dshx-plugins-refresh">刷新</button>
        </div>
        <div class="dshx-cat">已安装依赖</div><div id="dshx-deps"></div>
        <div class="dshx-cat">已启用的 Bundle 层</div><div id="dshx-bundles"></div>
        <pre class="dshx-pre" id="dshx-install-log" style="display:none"></pre>
      </section>
      <section class="dshx-sec" data-sec="update">
        <div class="dshx-sub">比对内置 Harness 与 npm 最新发布版本</div>
        <div class="dshx-actions"><button class="dshx-btn" id="dshx-check-update">检查更新</button></div>
        <pre class="dshx-pre" id="dshx-update-result" style="display:none"></pre>
      </section>
    </div>`;
  document.body.appendChild(drawer);

  const open = () => { drawer.classList.add('open'); };
  const close = () => { drawer.classList.remove('open'); };
  fab.addEventListener('click', open);
  drawer.querySelector('.dshx-x').addEventListener('click', close);

  function activate(tab) {
    drawer.querySelectorAll('.dshx-nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    drawer.querySelectorAll('.dshx-sec').forEach((s) => s.classList.toggle('active', s.dataset.sec === tab));
  }
  drawer.querySelectorAll('.dshx-nav button').forEach((b) => b.addEventListener('click', () => activate(b.dataset.tab)));

  // ---------- 插件市场 ----------
  async function loadMarket() {
    const box = drawer.querySelector('#dshx-market');
    box.innerHTML = '<div class="dshx-empty">正在加载插件市场…</div>';
    try {
      const data = await api.marketList();
      drawer.querySelector('#dshx-market-sub').textContent =
        `数据源：awesome-dsh-plugin · 共 ${data.total} 个插件 · ${data.source === 'remote' ? '在线' : '内置快照'}`;
      if (!data.groups.length) { box.innerHTML = '<div class="dshx-empty">市场列表为空</div>'; return; }
      let html = '';
      for (const g of data.groups) {
        html += `<div class="dshx-cat">${esc(g.category)}</div>`;
        for (const it of g.items) {
          const id = 'mi-' + it.repo.replace(/[^A-Za-z0-9_.-]/g, '_');
          html += `<div class="dshx-card" id="${id}">
            <div class="t1"><span class="name">${esc(it.repo)}</span><a class="dshx-a" href="${esc(it.url)}" target="_blank" rel="noopener">仓库↗</a><span style="flex:1"></span><button class="dshx-btn small" data-repo="${esc(it.repo)}">安装</button></div>
            <div class="dshx-desc">${esc(it.desc)}</div><div class="dshx-status"></div></div>`;
        }
      }
      box.innerHTML = html;
      box.querySelectorAll('button[data-repo]').forEach((btn) => btn.addEventListener('click', () => installRepo(btn)));
    } catch (e) {
      box.innerHTML = `<div class="dshx-empty">加载失败：${esc(e.message || String(e))}</div>`;
    }
  }
  async function installRepo(btn) {
    const repo = btn.dataset.repo;
    const status = btn.closest('.dshx-card').querySelector('.dshx-status');
    btn.disabled = true; status.textContent = '正在解析 npm 包名…';
    try {
      const pkg = await api.resolvePlugin(repo);
      status.textContent = `包名 ${pkg}，正在安装…`;
      const r = await api.installPlugin(pkg);
      status.textContent = r.ok ? `✔ ${pkg} 安装完成（重启应用后生效）` : `✖ 安装失败：${(r.log || '').slice(0, 200)}`;
    } catch (e) {
      status.textContent = '✖ ' + esc(e.message || String(e));
    } finally { btn.disabled = false; }
  }
  drawer.querySelector('#dshx-market-refresh').addEventListener('click', loadMarket);

  // ---------- MCP ----------
  async function loadMcp() {
    const box = drawer.querySelector('#dshx-mcp');
    box.innerHTML = '<div class="dshx-empty">正在检测…</div>';
    try {
      const list = await api.detectMcp();
      if (!list.length) { box.innerHTML = '<div class="dshx-empty">当前 web 端未配置 MCP 服务器</div>'; return; }
      let html = '';
      for (const s of list) {
        const cls = (s.status === '可用' || s.status === '可连接') ? '' : (s.status === '无法连接' || s.status === '命令未找到' ? 'bad' : 'warn');
        const target = s.transport === 'stdio'
          ? `${esc(s.command)} ${esc((s.args || []).join(' '))}`
          : esc(s.url);
        html += `<div class="dshx-card">
          <div class="t1"><span class="name">${esc(s.name)}</span><span class="dshx-badge ${cls}">${esc(s.status)}</span><span class="dshx-tag">${esc(s.source)} · ${esc(s.transport)}</span></div>
          <div class="dshx-mono">${target}</div></div>`;
      }
      box.innerHTML = html;
    } catch (e) {
      box.innerHTML = `<div class="dshx-empty">检测失败：${esc(e.message || String(e))}</div>`;
    }
  }
  drawer.querySelector('#dshx-mcp-refresh').addEventListener('click', loadMcp);

  // ---------- 插件 ----------
  async function loadPlugins() {
    const info = await api.listPlugins();
    drawer.querySelector('#dshx-deps').innerHTML = info.dependencies.length
      ? info.dependencies.map((d) => `<div class="dshx-li"><b>${esc(d)}</b><span class="dshx-tag">依赖</span></div>`).join('')
      : '<div class="dshx-li"><span>无</span></div>';
    drawer.querySelector('#dshx-bundles').innerHTML = info.bundles.length
      ? info.bundles.map((b) => `<div class="dshx-li"><b>${esc(b)}</b><span class="dshx-tag">bundle</span></div>`).join('')
      : '<div class="dshx-li"><span>无</span></div>';
  }
  drawer.querySelector('#dshx-install').addEventListener('click', async () => {
    const pkg = drawer.querySelector('#dshx-pkg').value.trim();
    if (!pkg) return;
    const btn = drawer.querySelector('#dshx-install');
    const log = drawer.querySelector('#dshx-install-log');
    btn.disabled = true; btn.textContent = '安装中…';
    log.style.display = 'block'; log.textContent = `$ pnpm add ${pkg}\n`;
    const r = await api.installPlugin(pkg);
    log.textContent += (r.log || '(无输出)') + (r.ok ? '\n\n✔ 安装完成' : '\n\n✖ 安装失败');
    btn.disabled = false; btn.textContent = '安装';
    loadPlugins();
  });
  drawer.querySelector('#dshx-plugins-refresh').addEventListener('click', loadPlugins);

  // ---------- 更新 ----------
  drawer.querySelector('#dshx-check-update').addEventListener('click', async () => {
    const pre = drawer.querySelector('#dshx-update-result');
    pre.style.display = 'block'; pre.textContent = '正在查询…';
    const info = await api.checkUpdate();
    const newer = info.latest && info.latest !== '未知' && info.latest !== info.current;
    pre.textContent = `内置 Harness 版本：${info.current}\n最新发布版本：${info.latest ?? '查询失败'}\n\n` +
      (newer ? `发现新版本 ${info.latest}。重新打包安装包并覆盖安装即可更新（配置与会话保留在 ~/.dsh）。` : '当前已是最新。');
  });

  loadMarket();
  loadMcp();
  loadPlugins();
})();
