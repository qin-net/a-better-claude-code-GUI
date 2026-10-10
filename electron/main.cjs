const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const os = require('node:os')
const { ClaudeAgent } = require('./claude-agent.cjs')

const isDev = !!process.env.VITE_DEV_SERVER_URL

// One live agent (one `claude` subprocess) per window.
const agents = new Map()

function send(win, channel, payload) {
  if (!win.isDestroyed()) win.webContents.send(channel, payload)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#1b1b1f',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}

// ---------------------------------------------------------------- workspace fs

const IGNORED = new Set([
  '.git', 'node_modules', '.DS_Store', 'dist', 'build', '.next', '.cache',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'target', '.turbo',
  'coverage', '.pytest_cache', '.mypy_cache', 'vendor',
])

async function readTree(root, rel = '', depth = 0, acc = { count: 0 }) {
  if (depth > 6 || acc.count > 4000) return []
  const dir = path.join(root, rel)
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const out = []
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env.example') continue
    if (IGNORED.has(e.name)) continue
    const childRel = rel ? `${rel}/${e.name}` : e.name
    acc.count++
    if (e.isDirectory()) {
      out.push({
        name: e.name,
        path: childRel,
        type: 'dir',
        children: await readTree(root, childRel, depth + 1, acc),
      })
    } else {
      out.push({ name: e.name, path: childRel, type: 'file', ext: path.extname(e.name).slice(1) })
    }
  }
  return out
}

async function readFileSafe(root, rel) {
  const abs = path.join(root, rel)
  const resolved = path.resolve(abs)
  if (!resolved.startsWith(path.resolve(root))) throw new Error('path escapes workspace')
  const stat = await fs.stat(resolved)
  if (stat.size > 2 * 1024 * 1024) {
    return { content: '', tooLarge: true, truncated: true }
  }
  const content = await fs.readFile(resolved, 'utf8')
  return { content, truncated: false, tooLarge: false }
}

// ------------------------------------------------------------------ ipc setup

function registerIpc(getWin) {
  ipcMain.handle('dialog:pickFolder', async () => {
    const win = getWin()
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || !res.filePaths.length) return null
    return res.filePaths[0]
  })

  ipcMain.handle('fs:tree', async (_e, root) => {
    if (!root) return []
    return readTree(root)
  })

  ipcMain.handle('fs:read', async (_e, { root, rel }) => {
    try {
      return { ok: true, ...(await readFileSafe(root, rel)) }
    } catch (err) {
      return { ok: false, error: String(err.message || err) }
    }
  })

  ipcMain.handle('fs:home', async () => os.homedir())

  ipcMain.handle('shell:reveal', async (_e, abs) => {
    shell.showItemInFolder(abs)
  })

  ipcMain.handle('agent:start', async (e, opts) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { ok: false, errorKey: 'err.noWindow' }

    let agent = agents.get(win.id)
    if (agent) agent.stop()
    agent = new ClaudeAgent(opts || {}, {
      onEvent: (ev) => send(win, 'agent:event', ev),
      onExit: (info) => send(win, 'agent:exit', info),
    })
    agents.set(win.id, agent)
    const res = agent.start()
    return res.ok ? { ok: true } : res
  })

  ipcMain.handle('agent:send', async (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const agent = win && agents.get(win.id)
    if (!agent) return { ok: false, errorKey: 'err.agentNotStarted' }
    return agent.send(payload)
  })

  ipcMain.handle('agent:stop', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const agent = win && agents.get(win.id)
    if (agent) agent.stop()
    return { ok: true }
  })

  ipcMain.handle('agent:interrupt', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const agent = win && agents.get(win.id)
    if (!agent) return { ok: false }
    agent.interrupt()
    return { ok: true }
  })

  // Session history lives as JSONL under ~/.claude/projects/<slugified-cwd>/.
  ipcMain.handle('history:list', async (_e, cwd) => {
    const slug = String(cwd || '').replace(/[/.]/g, '-')
    const dir = path.join(os.homedir(), '.claude', 'projects', slug)
    let files
    try {
      files = await fs.readdir(dir)
    } catch {
      return []
    }
    const out = []
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const abs = path.join(dir, f)
      try {
        const stat = await fs.stat(abs)
        const summary = await summarizeSession(abs)
        out.push({
          id: f.replace(/\.jsonl$/, ''),
          mtime: stat.mtimeMs,
          size: stat.size,
          title: summary.title,
          turns: summary.turns,
        })
      } catch {
        /* skip unreadable */
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, 40)
  })
}

async function summarizeSession(abs) {
  const raw = await fs.readFile(abs, 'utf8')
  const lines = raw.split('\n').filter(Boolean)
  let title = ''
  let turns = 0
  for (const line of lines) {
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec.type !== 'user') continue
    const content = rec.message?.content
    if (typeof content === 'string') {
      if (title === '') title = content.slice(0, 90)
      turns++
      continue
    }
    if (!Array.isArray(content)) continue
    const textBlock = content.find((c) => c.type === 'text')
    if (!textBlock) continue
    turns++
    if (title === '') title = String(textBlock.text || '').replace(/\s+/g, ' ').slice(0, 90)
  }
  return { title, turns }
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark'
  let win = createWindow()
  registerIpc(() => win)

  win.on('closed', () => {
    const agent = agents.get(win.id)
    if (agent) agent.stop()
    agents.delete(win.id)
    win = null
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = createWindow()
      registerIpc(() => win)
    }
  })
})

app.on('window-all-closed', () => {
  for (const agent of agents.values()) agent.stop()
  if (process.platform !== 'darwin') app.quit()
})
