'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetApi', {
  bootstrap: () => ipcRenderer.invoke('widget:bootstrap'),
  getData: (opts) => ipcRenderer.invoke('widget:get-data', opts || {}),
  login: () => ipcRenderer.invoke('widget:login'),
  loginReopen: () => ipcRenderer.invoke('widget:login-reopen'),
  loginCopyLink: () => ipcRenderer.invoke('widget:login-copy'),
  loginCancel: () => ipcRenderer.invoke('widget:login-cancel'),
  onLoginPhase: (handler) => {
    const listener = (_event, phase) => handler(phase);
    ipcRenderer.on('widget:login-phase', listener);
    return () => ipcRenderer.removeListener('widget:login-phase', listener);
  },
  importClientJson: (text) =>
    ipcRenderer.invoke('widget:import-client-json', typeof text === 'string' ? { text } : {}),
  logout: () => ipcRenderer.invoke('widget:logout'),
  setCompleted: (listKind, taskId, completed) =>
    ipcRenderer.invoke('widget:set-completed', { listKind, taskId, completed }),
  createItem: (listKind, title, opts) =>
    ipcRenderer.invoke('widget:create-item', {
      listKind,
      title,
      parentId: opts && opts.parentId ? opts.parentId : undefined,
      parse: Boolean(opts && opts.parse),
    }),
  updateItem: (listKind, taskId, patch) =>
    ipcRenderer.invoke('widget:update-item', { listKind, taskId, patch }),
  deleteItem: (listKind, taskId) =>
    ipcRenderer.invoke('widget:delete-item', { listKind, taskId }),
  moveItem: (listKind, taskId, previousId, orderedIds) =>
    ipcRenderer.invoke('widget:move-item', {
      listKind,
      taskId,
      previousId: previousId || null,
      orderedIds: orderedIds || [],
    }),
  getSettings: () => ipcRenderer.invoke('widget:get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('widget:set-settings', patch),
  getCredentialsStatus: () => ipcRenderer.invoke('widget:credentials-status'),
  saveCredentials: (payload) => ipcRenderer.invoke('widget:save-credentials', payload || {}),
  skipCredentials: () => ipcRenderer.invoke('widget:skip-credentials'),
  sampleWallpaperPalette: () => ipcRenderer.invoke('widget:sample-wallpaper-palette'),
  checkReminders: () => ipcRenderer.invoke('widget:check-reminders'),
  checkUpdates: () => ipcRenderer.invoke('widget:check-updates'),
  onSwitchView: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('widget:switch-view', listener);
    return () => ipcRenderer.removeListener('widget:switch-view', listener);
  },
  onFocusAdd: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('widget:focus-add', listener);
    return () => ipcRenderer.removeListener('widget:focus-add', listener);
  },
  onHabitsReset: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('widget:habits-reset', listener);
    return () => ipcRenderer.removeListener('widget:habits-reset', listener);
  },
  onInAppReminder: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('widget:in-app-reminder', listener);
    return () => ipcRenderer.removeListener('widget:in-app-reminder', listener);
  },
  /** Before quitting: run `handler` (may return a promise), then tell the main process. */
  onFlushPending: (handler) => {
    const listener = async () => {
      try {
        await handler();
      } finally {
        ipcRenderer.send('widget:flush-done');
      }
    };
    ipcRenderer.on('widget:flush-pending', listener);
    return () => ipcRenderer.removeListener('widget:flush-pending', listener);
  },
  minimize: () => ipcRenderer.send('widget:minimize'),
  close: () => ipcRenderer.send('widget:close'),
  openExternal: (url) => ipcRenderer.send('widget:open-external', url),
  copyDiagnostics: () => ipcRenderer.invoke('widget:diagnostics-copy'),
  openLogs: () => ipcRenderer.invoke('widget:open-logs'),
  reportError: (payload) => ipcRenderer.send('widget:log', payload),
  // Data & storage (electron/data-ipc.js)
  getStorageStatus: () => ipcRenderer.invoke('data:storage-status'),
  exportData: (opts) =>
    ipcRenderer.invoke('data:export-json', { includeLogs: Boolean(opts && opts.includeLogs) }),
  exportTasksCsv: () => ipcRenderer.invoke('data:export-tasks-csv'),
  importData: () => ipcRenderer.invoke('data:import-json'),
  backupNow: () => ipcRenderer.invoke('data:backup-now'),
  listBackups: () => ipcRenderer.invoke('data:list-backups'),
  openDataFolder: () => ipcRenderer.invoke('data:open-folder'),
  wipeAllData: () => ipcRenderer.invoke('data:wipe-all'),
  onStorageIssue: (handler) => {
    const listener = (_event, issue) => handler(issue);
    ipcRenderer.on('data:storage-issue', listener);
    return () => ipcRenderer.removeListener('data:storage-issue', listener);
  },
});
