'use strict';

const path = require('path');
const { app, ipcMain, shell, nativeImage, nativeTheme, Menu } = require('electron');
const { menubar } = require('menubar');
const { ConnectionManager } = require('./connectionManager');

// Pure menu bar app: no dock icon.
if (app.dock) app.dock.hide();

const manager = new ConnectionManager();

const assetPath = (name) => path.join(__dirname, '..', 'assets', name);

// Idle icon: monochrome template so it adapts to the menu bar automatically.
const trayIcon = nativeImage.createFromPath(assetPath('trayTemplate.png'));
trayIcon.setTemplateImage(true);

// Active icons: non-template (so the green dot keeps its colour). We pick the
// arrow colour to match the current menu-bar appearance.
const activeLight = nativeImage.createFromPath(assetPath('trayActiveLight.png'));
const activeDark = nativeImage.createFromPath(assetPath('trayActiveDark.png'));

function updateTrayIcon() {
  if (!mb.tray) return;
  const active = manager
    .list()
    .some((c) => c.status === 'running' || c.status === 'starting');
  if (!active) {
    mb.tray.setImage(trayIcon);
    return;
  }
  mb.tray.setImage(nativeTheme.shouldUseDarkColors ? activeDark : activeLight);
}

const mb = menubar({
  index: `file://${path.join(__dirname, 'renderer', 'index.html')}`,
  icon: trayIcon,
  preloadWindow: true,
  showDockIcon: false,
  browserWindow: {
    width: 380,
    height: 520,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  },
});

mb.on('ready', () => {
  if (!mb.tray) return;
  mb.tray.setToolTip('k8s tunneler');

  // Right-click shows a context menu with a Quit option (dock is hidden, so
  // this is the primary way to quit the app).
  const contextMenu = Menu.buildFromTemplate([
    { label: 'k8s tunneler', enabled: false },
    { type: 'separator' },
    { label: 'Quit k8s tunneler', accelerator: 'Command+Q', click: () => app.quit() },
  ]);
  mb.tray.on('right-click', () => {
    mb.tray.popUpContextMenu(contextMenu);
  });

  updateTrayIcon();
});

// Re-render the active icon when the system appearance changes.
nativeTheme.on('updated', updateTrayIcon);

// Push runtime status changes to the renderer and refresh the tray indicator.
manager.on('status', (snapshot) => {
  if (mb.window && !mb.window.isDestroyed()) {
    mb.window.webContents.send('connections:status', snapshot);
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

// Keep the app alive without windows (menu bar app).
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('before-quit', () => {
  manager.stopAll();
});
