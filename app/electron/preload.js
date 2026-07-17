'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetApi', {
  getData: () => ipcRenderer.invoke('widget:get-data'),
  login: () => ipcRenderer.invoke('widget:login'),
  logout: () => ipcRenderer.invoke('widget:logout'),
  setCompleted: (listKind, taskId, completed) =>
    ipcRenderer.invoke('widget:set-completed', { listKind, taskId, completed }),
  hasCredentials: () => ipcRenderer.invoke('widget:has-credentials'),
  getConfig: () => ipcRenderer.invoke('widget:get-config'),
  minimize: () => ipcRenderer.send('widget:minimize'),
  close: () => ipcRenderer.send('widget:close'),
  openExternal: (url) => ipcRenderer.send('widget:open-external', url),
});
