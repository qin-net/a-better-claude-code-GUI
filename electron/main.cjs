const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const fss = require('node:fs')
const os = require('node:os')
const { ClaudeAgent } = require('./claude-agent.cjs')
const store = require('./session-store.cjs')

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
  return { content, truncated: false, tooLarge: false, mtime: stat.mtimeMs }
}

// ------------------------------------------------------------ write support

/**
 * Deletions land here rather than in the workspace. A project folder is
 * usually a git repository, so a .trash directory beside the code would show
 * up in `git status` and in the file tree; the os temp-style location below a
 * hidden home directory keeps the workspace pristine while staying recoverable.
 */
const TRASH_ROOT = path.join(os.homedir(), '.claude-code-gui', 'trash')

/** Resolve a workspace path, refusing anything that escapes the root. */
function resolveIn(root, rel) {
  if (!root) throw new Error('no workspace open')
  if (typeof rel !== 'string' || !rel.trim()) throw new Error('empty path')
  const abs = path.isAbsolute(rel) ? rel : path.join(root, rel)
  const resolved = path.resolve(abs)
  const rootResolved = path.resolve(root)
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error('path escapes workspace')
  }
  return resolved
}

async function writeFileSafe(root, rel, content) {
  const abs = resolveIn(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf8')
  const stat = await fs.stat(abs)
  return { ok: true, mtime: stat.mtimeMs, size: stat.size }
}

async function createEntry(root, rel, type) {
  const abs = resolveIn(root, rel)
  if (fss.existsSync(abs)) return { ok: false, errorKey: 'err.exists' }
  if (type === 'dir') {
    await fs.mkdir(abs, { recursive: true })
  } else {
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, '', 'utf8')
  }
  return { ok: true, path: rel }
}

async function renameEntry(root, from, to) {
  const absFrom = resolveIn(root, from)
  const absTo = resolveIn(root, to)
  if (absFrom === absTo) return { ok: true, path: to }
  if (!fss.existsSync(absFrom)) return { ok: false, errorKey: 'err.notFound' }
  if (fss.existsSync(absTo)) return { ok: false, errorKey: 'err.exists' }
  await fs.mkdir(path.dirname(absTo), { recursive: true })
  await fs.rename(absFrom, absTo)
  return { ok: true, path: to }
}

async function deleteEntry(root, rel) {
  const abs = resolveIn(root, rel)
  if (!fss.existsSync(abs)) return { ok: false, errorKey: 'err.notFound' }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(TRASH_ROOT, `${stamp}__${path.basename(abs)}`)
  await fs.mkdir(TRASH_ROOT, { recursive: true })
  await fs.rename(abs, dest)
  return { ok: true, trashPath: dest }
}

// ---------------------------------------------------------------- watching
//
// Claude edits files through the CLI, which the renderer cannot see. Watching
// the workspace is what makes conflict detection possible: a changed file that
// has unsaved edits prompts the user instead of being silently overwritten.

const WATCH_IGNORE = /(^|\/)(node_modules|\.git|dist|build|release|\.trash|\.next|__pycache__)(\/|$)/
const watchers = new Map()

function stopWatch(win) {
  const entry = watchers.get(win.id)
  if (entry) {
    entry.close()
    watchers.delete(win.id)
  }
}

function startWatch(win, root) {
  stopWatch(win)
  let timer = null
  const pending = new Set()

  let watcher
  try {
    watcher = fss.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const rel = String(filename).split(path.sep).join('/')
      if (WATCH_IGNORE.test(rel)) return
      pending.add(rel)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const paths = [...pending]
        pending.clear()
        timer = null
        send(win, 'fs:changed', { paths })
      }, 250)
    })
  } catch (err) {
    return { ok: false, errorKey: 'err.watch', detail: err.message }
  }

  watcher.on('error', () => {})
  watchers.set(win.id, {
    close: () => {
      if (timer) clearTimeout(timer)
      try {
        watcher.close()
      } catch {
        /* already closed */
      }
    },
  })
  return { ok: true }
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

  // ---------------------------------------------------------- file mutations
  //
  // Every one of these resolves the path against the workspace root first, so
  // an edit can never reach outside the folder the user opened.

  ipcMain.handle('fs:write', async (_e, { root, rel, content }) => {
    try {
      return await writeFileSafe(root, rel, content)
    } catch (err) {
      return { ok: false, errorKey: 'err.writeFailed', detail: err.message }
    }
  })

  ipcMain.handle('fs:create', async (_e, { root, rel, type }) => {
    try {
      return await createEntry(root, rel, type)
    } catch (err) {
      return { ok: false, errorKey: 'err.createFailed', detail: err.message }
    }
  })

  ipcMain.handle('fs:rename', async (_e, { root, from, to }) => {
    try {
      return await renameEntry(root, from, to)
    } catch (err) {
      return { ok: false, errorKey: 'err.renameFailed', detail: err.message }
    }
  })

  ipcMain.handle('fs:delete', async (_e, { root, rel }) => {
    try {
      return await deleteEntry(root, rel)
    } catch (err) {
      return { ok: false, errorKey: 'err.deleteFailed', detail: err.message }
    }
  })

  /** Re-stat a file so an edit can tell whether disk changed underneath it. */
  ipcMain.handle('fs:stat', async (_e, { root, rel }) => {
    try {
      const abs = resolveIn(root, rel)
      const stat = await fs.stat(abs)
      return { ok: true, mtime: stat.mtimeMs, size: stat.size }
    } catch (err) {
      return { ok: false, errorKey: 'err.notFound', detail: err.message }
    }
  })

  ipcMain.handle('fs:watch', async (e, root) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || !root) return { ok: false }
    return startWatch(win, root)
  })

  ipcMain.handle('fs:home', async () => os.homedir())

  ipcMain.handle('shell:reveal', async (_e, abs) => {
    shell.showItemInFolder(abs)
  })

  // ------------------------------------------------- project + session browsing
  //
  // These read Claude Code's own state on disk. There is no import step: the
  // CLI writes ~/.claude/projects, and this is a view onto it.

  ipcMain.handle('projects:list', async (_e, extraPaths) => {
    try {
      return { ok: true, projects: await store.listProjects(extraPaths || []) }
    } catch (err) {
      return { ok: false, errorKey: 'err.storeRead', detail: err.message }
    }
  })

  ipcMain.handle('sessions:list', async (_e, cwd) => {
    if (!cwd) return { ok: true, sessions: [] }
    try {
      return { ok: true, sessions: await store.listSessions(cwd) }
    } catch (err) {
      return { ok: false, errorKey: 'err.storeRead', detail: err.message }
    }
  })

  ipcMain.handle('sessions:read', async (_e, sessionPath) => {
    try {
      return await store.readTranscript(sessionPath)
    } catch (err) {
      return { ok: false, errorKey: 'err.storeRead', detail: err.message }
    }
  })

  ipcMain.handle('sessions:delete', async (_e, sessionPath) => {
    try {
      return await store.deleteSession(sessionPath)
    } catch (err) {
      return { ok: false, errorKey: 'err.deleteFailed', detail: err.message }
    }
  })

  ipcMain.handle('sessions:reveal', async (_e, sessionPath) => {
    const abs = store.resolveSessionPath(sessionPath)
    if (!abs) return { ok: false, errorKey: 'err.sessionNotFound' }
    shell.showItemInFolder(abs)
    return { ok: true }
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
  // Kept for the workspace sidebar: returns the same sessions the manage screen
  // shows, including the file path so a resumed conversation can be rendered
  // from its transcript rather than starting blank.
  ipcMain.handle('history:list', async (_e, cwd) => {
    try {
      const sessions = await store.listSessions(cwd)
      return sessions.slice(0, 60).map((s) => ({
        id: s.id,
        title: s.title,
        turns: s.turns,
        mtime: s.mtime,
        size: s.size,
        path: s.path,
      }))
    } catch {
      return []
    }
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
