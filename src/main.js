'use strict';

const path = require('path');
const {
  app,
  ipcMain,
  shell,
  nativeImage,
  nativeTheme,
  Menu,
  Tray,
  BrowserWindow,
} = require('electron');
const { ConnectionManager } = require('./connectionManager');
const { trayState } = require('./trayState');

const isMac = process.platform === 'darwin';

// Pure menu bar / tray app: no dock icon on macOS.
if (app.dock) app.dock.hide();

const manager = new ConnectionManager();

const assetPath = (name) => path.join(__dirname, '..', 'assets', name);
const indexHtml = path.join(__dirname, 'renderer', 'index.html');
const webPreferences = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
};

// --- Tray icons -------------------------------------------------------------
// macOS: monochrome template (idle) + non-template colour variants with a
// green (active) or amber (connecting) dot, per light/dark menu bar.
const macTemplate = nativeImage.createFromPath(assetPath('trayTemplate.png'));
macTemplate.setTemplateImage(true);
const macActiveLight = nativeImage.createFromPath(assetPath('trayActiveLight.png'));
const macActiveDark = nativeImage.createFromPath(assetPath('trayActiveDark.png'));
const macConnectingLight = nativeImage.createFromPath(assetPath('trayConnectingLight.png'));
const macConnectingDark = nativeImage.createFromPath(assetPath('trayConnectingDark.png'));
// Linux: colour icons (no template auto-inversion on Linux panels).
const linuxIdle = nativeImage.createFromPath(assetPath('trayLinux.png'));
const linuxActive = nativeImage.createFromPath(assetPath('trayLinuxActive.png'));
const linuxConnecting = nativeImage.createFromPath(assetPath('trayLinuxConnecting.png'));

// Platform-specific handles, assigned during setup.
let mb = null; // menubar instance (macOS)
let tray = null; // Tray instance (non-macOS)
let uiWindow = null; // standalone window (non-macOS)

function getTray() {
  return isMac ? mb && mb.tray : tray;
}

function getWindow() {
  return isMac ? mb && mb.window : uiWindow;
}

function updateTrayIcon() {
  const t = getTray();
  if (!t) return;
  const state = trayState(manager.list().map((c) => c.status));
  if (isMac) {
    const dark = nativeTheme.shouldUseDarkColors;
    if (state === 'connecting') t.setImage(dark ? macConnectingDark : macConnectingLight);
    else if (state === 'active') t.setImage(dark ? macActiveDark : macActiveLight);
    else t.setImage(macTemplate);
  } else if (state === 'connecting') {
    t.setImage(linuxConnecting);
  } else {
    t.setImage(state === 'active' ? linuxActive : linuxIdle);
  }
}

// --- macOS setup (menu bar popover) ----------------------------------------
function setupMac() {
  // eslint-disable-next-line global-require
  const { menubar } = require('menubar');
  mb = menubar({
    index: `file://${indexHtml}`,
    icon: macTemplate,
    preloadWindow: true,
    showDockIcon: false,
    browserWindow: {
      width: 380,
      height: 520,
      resizable: false,
      webPreferences,
    },
  });

  mb.on('ready', () => {
    if (!mb.tray) return;
    mb.tray.setToolTip('k8s tunneler');
    const contextMenu = Menu.buildFromTemplate([
      { label: 'k8s tunneler', enabled: false },
      { type: 'separator' },
      { label: 'Quit k8s tunneler', accelerator: 'Command+Q', click: () => app.quit() },
    ]);
    mb.tray.on('right-click', () => mb.tray.popUpContextMenu(contextMenu));
    updateTrayIcon();
  });
}

// --- Non-macOS setup (tray + standalone window) ----------------------------
function showWindow() {
  if (!uiWindow || uiWindow.isDestroyed()) createWindow();
  uiWindow.show();
  uiWindow.focus();
}

function createWindow() {
  uiWindow = new BrowserWindow({
    width: 400,
    height: 560,
    show: false,
    title: 'k8s tunneler',
    icon: nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png')),
    autoHideMenuBar: true,
    webPreferences,
  });
  uiWindow.loadFile(indexHtml);
  // Closing hides to tray instead of quitting (tray keeps the app alive).
  uiWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      uiWindow.hide();
    }
  });
}

function setupTrayApp() {
  createWindow();
  tray = new Tray(linuxIdle);
  tray.setToolTip('k8s tunneler');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open k8s tunneler', click: showWindow },
    { type: 'separator' },
    {
      label: 'Quit k8s tunneler',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
  // Left-click opens the window where the desktop environment supports it.
  tray.on('click', showWindow);
  updateTrayIcon();
}

// --- Shared wiring ----------------------------------------------------------
app.whenReady().then(() => {
  if (isMac) setupMac();
  else setupTrayApp();
});

// Re-render the active icon when the system appearance changes (macOS).
nativeTheme.on('updated', updateTrayIcon);

// Push runtime status changes to the renderer and refresh the tray indicator.
manager.on('status', (snapshot) => {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('connections:status', snapshot);
  }
  updateTrayIcon();
});

// ---- IPC surface ----
ipcMain.handle('connections:list', () => manager.list());
ipcMain.handle('connections:add', (_e, payload) => manager.add(payload || {}));
ipcMain.handle('connections:update', (_e, id, payload) =>
  manager.update(id, payload || {})
);
ipcMain.handle('connections:remove', (_e, id) => manager.remove(id));
ipcMain.handle('connections:start', (_e, id) => manager.start(id));
ipcMain.handle('connections:stop', (_e, id) => manager.stop(id));
ipcMain.handle('connections:openBrowser', (_e, id) => {
  const url = manager.urlFor(id);
  if (url) shell.openExternal(url);
  return url;
});

// Keep the app alive without visible windows (menu bar / tray app).
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  manager.stopAll();
});
