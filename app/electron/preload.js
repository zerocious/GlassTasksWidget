'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetApi', {
  getData: () => ipcRenderer.invoke('widget:get-data'),
  login: () => ipcRenderer.invoke('widget:login'),
  logout: () => ipcRenderer.invoke('widget:logout'),
  setCompleted: (listKind, taskId, completed) =>
    ipcRenderer.invoke('widget:set-completed', { listKind, taskId, completed }),
  createItem: (listKind, title) =>
    ipcRenderer.invoke('widget:create-item', { listKind, title }),
  getSettings: () => ipcRenderer.invoke('widget:get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('widget:set-settings', patch),
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
  minimize: () => ipcRenderer.send('widget:minimize'),
  close: () => ipcRenderer.send('widget:close'),
  openExternal: (url) => ipcRenderer.send('widget:open-external', url),
});
