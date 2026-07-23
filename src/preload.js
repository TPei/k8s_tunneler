'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  list: () => ipcRenderer.invoke('connections:list'),
  add: (payload) => ipcRenderer.invoke('connections:add', payload),
  update: (id, payload) => ipcRenderer.invoke('connections:update', id, payload),
  remove: (id) => ipcRenderer.invoke('connections:remove', id),
  start: (id) => ipcRenderer.invoke('connections:start', id),
  stop: (id) => ipcRenderer.invoke('connections:stop', id),
  openInBrowser: (id) => ipcRenderer.invoke('connections:openBrowser', id),
  onStatus: (callback) => {
    const listener = (_e, snapshot) => callback(snapshot);
    ipcRenderer.on('connections:status', listener);
    return () => ipcRenderer.removeListener('connections:status', listener);
  },
});
