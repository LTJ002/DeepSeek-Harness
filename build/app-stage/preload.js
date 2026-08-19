// preload：给本地页面与应用页面暴露最小桌面桥
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
    restart: () => ipcRenderer.send('dsh:restart'),
    reloadHarness: () => ipcRenderer.invoke('dsh:reload-harness'),
    logPath: () => ipcRenderer.invoke('dsh:get-log-path'),
    openMcp: () => ipcRenderer.send('dsh:open-mcp'),
    openPlugins: () => ipcRenderer.send('dsh:open-plugins'),
    openSettings: (tab) => ipcRenderer.send('dsh:open-settings', tab),
    onSettingsTab: (cb) => ipcRenderer.on('dsh:settings-tab', (_e, tab) => cb(tab)),
    detectMcp: () => ipcRenderer.invoke('dsh:detect-mcp'),
    listPlugins: () => ipcRenderer.invoke('dsh:list-plugins'),
    installPlugin: (pkg) => ipcRenderer.invoke('dsh:install-plugin', pkg),
    uninstallPlugin: (pkg) => ipcRenderer.invoke('dsh:uninstall-plugin', pkg),
    marketList: () => ipcRenderer.invoke('dsh:market-list'),
    resolvePlugin: (repo) => ipcRenderer.invoke('dsh:resolve-plugin', repo),
    repairSessions: () => ipcRenderer.invoke('dsh:repair-sessions'),
    sessionRollbackList: () => ipcRenderer.invoke('dsh:session-rollback-list'),
    sessionDeleteList: () => ipcRenderer.invoke('dsh:session-delete-list'),
    deleteSession: (file) => ipcRenderer.invoke('dsh:session-delete', file),
    sessionRollback: (file) => ipcRenderer.invoke('dsh:session-rollback', file),
    sessionRollbackByMessage: (sessionId, messageId) => ipcRenderer.invoke('dsh:session-rollback-by-message', sessionId, messageId),
    sessionRollbackByUserMessage: (sessionId, userMessageId) => ipcRenderer.invoke('dsh:session-rollback-by-user-message', sessionId, userMessageId),
    checkUpdate: () => ipcRenderer.invoke('dsh:check-update')
  });
