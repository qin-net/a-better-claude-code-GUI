const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  home: () => ipcRenderer.invoke('fs:home'),
  readTree: (root) => ipcRenderer.invoke('fs:tree', root),
  readFile: (root, rel) => ipcRenderer.invoke('fs:read', { root, rel }),
  reveal: (abs) => ipcRenderer.invoke('shell:reveal', abs),

  // file mutations — all workspace-scoped in the main process
  writeFile: (root, rel, content) => ipcRenderer.invoke('fs:write', { root, rel, content }),
  createEntry: (root, rel, type) => ipcRenderer.invoke('fs:create', { root, rel, type }),
  renameEntry: (root, from, to) => ipcRenderer.invoke('fs:rename', { root, from, to }),
  deleteEntry: (root, rel) => ipcRenderer.invoke('fs:delete', { root, rel }),
  statFile: (root, rel) => ipcRenderer.invoke('fs:stat', { root, rel }),
  watchWorkspace: (root) => ipcRenderer.invoke('fs:watch', root),

  startAgent: (opts) => ipcRenderer.invoke('agent:start', opts),
  sendMessage: (payload) => ipcRenderer.invoke('agent:send', payload),
  stopAgent: () => ipcRenderer.invoke('agent:stop'),
  interruptAgent: () => ipcRenderer.invoke('agent:interrupt'),

  listHistory: (cwd) => ipcRenderer.invoke('history:list', cwd),

  listProjects: (extraPaths) => ipcRenderer.invoke('projects:list', extraPaths),
  listSessions: (cwd) => ipcRenderer.invoke('sessions:list', cwd),
  readSession: (sessionPath) => ipcRenderer.invoke('sessions:read', sessionPath),
  deleteSession: (sessionPath) => ipcRenderer.invoke('sessions:delete', sessionPath),
  revealSession: (sessionPath) => ipcRenderer.invoke('sessions:reveal', sessionPath),

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
  onFsChanged: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('fs:changed', h)
    return () => ipcRenderer.removeListener('fs:changed', h)
  },
})
