const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getStats: () => ipcRenderer.invoke('get-stats'),
  get7Day: () => ipcRenderer.invoke('get-7day'),
  getHistory: () => ipcRenderer.invoke('get-history'),
  setDeepWork: (val) => ipcRenderer.invoke('set-deep-work', val),
  getCareerXp: () => ipcRenderer.invoke('get-career-xp'),
  onActiveWindow: (cb) => ipcRenderer.on('active-window', (_, data) => cb(data)),
  onSessionSaved: (cb) => ipcRenderer.on('session-saved', (_, data) => cb(data)),
  onBlocked: (cb) => ipcRenderer.on('blocked', (_, title) => cb(title)),
});