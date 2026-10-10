const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  home: () => ipcRenderer.invoke('fs:home'),
  readTree: (root) => ipcRenderer.invoke('fs:tree', root),
  readFile: (root, rel) => ipcRenderer.invoke('fs:read', { root, rel }),
  reveal: (abs) => ipcRenderer.invoke('shell:reveal', abs),

  startAgent: (opts) => ipcRenderer.invoke('agent:start', opts),
  sendMessage: (payload) => ipcRenderer.invoke('agent:send', payload),
  stopAgent: () => ipcRenderer.invoke('agent:stop'),
  interruptAgent: () => ipcRenderer.invoke('agent:interrupt'),

  listHistory: (cwd) => ipcRenderer.invoke('history:list', cwd),

  onEvent: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('agent:event', h)
    return () => ipcRenderer.removeListener('agent:event', h)
  },
  onExit: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('agent:exit', h)
    return () => ipcRenderer.removeListener('agent:exit', h)
  },
})
