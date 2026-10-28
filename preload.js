'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel, callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('ai', {
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  ready: () => ipcRenderer.send('ui:ready'),
  setHitbox: (rect) => ipcRenderer.send('ui:hitbox', rect),
  onToggle: (callback) => on('ui:toggle', callback),

  onMedia: (callback) => on('media:state', callback),
  onArt: (callback) => on('media:art', callback),
  mediaControl: (action) => ipcRenderer.send('media:control', action),

  onShelf: (callback) => on('shelf:update', callback),
  shelfList: () => ipcRenderer.invoke('shelf:list'),
  shelfAdd: (paths) => ipcRenderer.invoke('shelf:add', paths),
  shelfPick: () => ipcRenderer.invoke('shelf:pick'),
  shelfRemove: (id) => ipcRenderer.invoke('shelf:remove', id),
  shelfClear: () => ipcRenderer.invoke('shelf:clear'),
  shelfOpen: (id) => ipcRenderer.send('shelf:open', id),
  shelfReveal: (id) => ipcRenderer.send('shelf:reveal', id),
  shelfDrag: (id) => ipcRenderer.send('shelf:drag', id),

  onTasks: (callback) => on('tasks:update', callback),
  tasksList: () => ipcRenderer.invoke('tasks:list'),
  tasksAdd: (text) => ipcRenderer.invoke('tasks:add', text),
  tasksToggle: (id) => ipcRenderer.invoke('tasks:toggle', id),
  tasksRemove: (id) => ipcRenderer.invoke('tasks:remove', id),
  tasksClearDone: () => ipcRenderer.invoke('tasks:clearDone'),

  onStats: (callback) => on('system:stats', callback),

  meetingGet: () => ipcRenderer.invoke('meeting:get'),
  meetingSave: (meeting) => ipcRenderer.invoke('meeting:save', meeting),

  timerGet: () => ipcRenderer.invoke('timer:get'),
  timerSave: (timer) => ipcRenderer.invoke('timer:save', timer),
  timerClear: () => ipcRenderer.invoke('timer:clear'),
  timerDone: (label) => ipcRenderer.send('timer:done', label),

  onUpdate: (callback) => on('update:state', callback),
  onUpdateShow: (callback) => on('update:show', callback),
  updateGet: () => ipcRenderer.invoke('update:get'),
  updateCheck: () => ipcRenderer.send('update:check'),
  updateDownload: () => ipcRenderer.send('update:download'),
  updateInstall: () => ipcRenderer.send('update:install'),

  quit: () => ipcRenderer.send('app:quit')
});
