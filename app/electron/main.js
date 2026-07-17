'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { loadConfig, hasGoogleCredentials } = require('../lib/config');
const { getWidgetData, loginGoogle, setTaskCompleted } = require('../lib/google-tasks');
const { clearTokens } = require('../lib/google-auth');

/** @type {BrowserWindow | null} */
let mainWindow = null;

function createWindow() {
  const config = loadConfig();
  const winCfg = config.window || {};

  mainWindow = new BrowserWindow({
    width: winCfg.width || 380,
    height: winCfg.height || 460,
    minWidth: 320,
    minHeight: 380,
    frame: false,
    transparent: true,
    alwaysOnTop: winCfg.alwaysOnTop !== false,
    skipTaskbar: winCfg.skipTaskbar !== false,
    resizable: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function registerIpc() {
  ipcMain.handle('widget:get-data', async () => getWidgetData());

  ipcMain.handle('widget:login', async () => loginGoogle());

  ipcMain.handle('widget:logout', async () => {
    clearTokens();
    return getWidgetData();
  });

  ipcMain.handle('widget:set-completed', async (_evt, payload) => {
    const { listKind, taskId, completed } = payload || {};
    return setTaskCompleted(listKind, taskId, Boolean(completed));
  });

  ipcMain.handle('widget:has-credentials', async () => hasGoogleCredentials());

  ipcMain.handle('widget:get-config', async () => loadConfig());

  ipcMain.on('widget:minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('widget:close', () => {
    if (mainWindow) mainWindow.close();
  });

  ipcMain.on('widget:open-external', (_evt, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
