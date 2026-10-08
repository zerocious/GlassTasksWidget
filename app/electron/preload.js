'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetApi', {
  bootstrap: () => ipcRenderer.invoke('widget:bootstrap'),
  getData: (opts) => ipcRenderer.invoke('widget:get-data', opts || {}),
  login: () => ipcRenderer.invoke('widget:login'),
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
  minimize: () => ipcRenderer.send('widget:minimize'),
  close: () => ipcRenderer.send('widget:close'),
  openExternal: (url) => ipcRenderer.send('widget:open-external', url),
});
