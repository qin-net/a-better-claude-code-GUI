const fs = require('node:fs/promises')
const fss = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * Reads Claude Code's own on-disk state so the GUI can present it.
 *
 * Everything here is read-only against ~/.claude, with one exception: deleting
 * a session moves the file into a .trash folder inside the project directory
 * rather than unlinking it, so a misclick stays recoverable.
 *
 * Two things about the format are worth knowing up front:
 *
 *  - The project directory name is a slug (cwd with / and . replaced by -),
 *    which is LOSSY and cannot be reversed reliably. Every session record does
 *    carry a real `cwd` field, so paths are read from the file instead of
 *    guessed from the folder name.
 *  - TodoWrite tasks are not stored anywhere separately. They only exist inline
 *    in the session transcript, so the task list is reconstructed by parsing.
 */

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects')
const CONFIG_PATH = path.join(os.homedir(), '.claude.json')

// ---------------------------------------------------------------- small utils

function slugFor(cwd) {
  return String(cwd).replace(/[/.]/g, '-')
}

/** Resolve symlinks so /tmp and /private/tmp collapse to one project. */
function canonical(p) {
  try {
    return fss.realpathSync(p)
  } catch {
    return p
  }
}

async function readHead(file, bytes = 65536) {
  let fh
  try {
    fh = await fs.open(file, 'r')
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}

function findCwd(text) {
  const m = text.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (!m) return null
  try {
    return JSON.parse('"' + m[1] + '"')
  } catch {
    return m[1]
  }
}

const truncate = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** User records whose text is scaffolding rather than something a person typed. */
function isNoiseText(text) {
  const s = String(text || '').trim()
  if (!s) return true
  if (s.startsWith('<system-reminder')) return true
  if (s.startsWith('<local-command')) return true
  if (s.startsWith('<command-name>')) return true
  if (s.startsWith('Caveat:')) return true
  return false
}

// ------------------------------------------------------------------ projects

async function readRegistry() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8')
    const json = JSON.parse(raw)
    return new Set(Object.keys(json.projects || {}))
  } catch {
    return new Set()
  }
}

/**
 * All known projects, merged from three sources so nothing is missed:
 * the session directories, the CLI's own project registry, and folders the
 * user opened through the GUI (which -p mode never registers).
 */
async function listProjects(extraPaths = []) {
  const registry = await readRegistry()
  const byPath = new Map()

  const add = (rawPath, patch) => {
    if (!rawPath) return
    const key = canonical(rawPath)
    const prev = byPath.get(key)
    if (prev) Object.assign(prev, patch, { path: key })
    else
      byPath.set(key, {
        path: key,
        name: path.basename(key) || key,
        sessionCount: 0,
        lastActivity: 0,
        slugs: [],
        inRegistry: false,
        ...patch,
      })
  }

  let dirs = []
  try {
    dirs = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true })
  } catch {
    /* no ~/.claude yet */
  }

  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dirAbs = path.join(PROJECTS_ROOT, d.name)
    let files = []
    try {
      files = (await fs.readdir(dirAbs)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    if (!files.length) continue

    const stats = []
    for (const f of files) {
      const abs = path.join(dirAbs, f)
      try {
        const st = await fs.stat(abs)
        stats.push({ abs, mtime: st.mtimeMs, size: st.size })
      } catch {
        /* vanished mid-scan */
      }
    }
    if (!stats.length) continue
    stats.sort((a, b) => b.mtime - a.mtime)

    // The folder name is only a hint; a real cwd from any session wins.
    let cwd = null
    for (const s of stats) {
      cwd = findCwd(await readHead(s.abs))
      if (cwd) break
    }
    const resolved = canonical(cwd || d.name.replace(/^-/, '/'))

    add(resolved, {
      sessionCount: stats.length,
      lastActivity: stats[0].mtime,
      slugs: [d.name],
    })
  }

  // Registry entries may point at folders with no sessions yet.
  for (const p of registry) add(p, { inRegistry: true, existedInRegistry: true })
  for (const p of extraPaths) add(p, { openedViaGui: true })

  const out = []
  for (const proj of byPath.values()) {
    let exists = false
    try {
      exists = (await fs.stat(proj.path)).isDirectory()
    } catch {
      exists = false
    }
    out.push({ ...proj, exists })
  }

  return out.sort((a, b) => b.lastActivity - a.lastActivity)
}

// ------------------------------------------------------------------ sessions

// Session files are re-read often (every list refresh), so parsed summaries are
// cached against mtime+size.
const summaryCache = new Map()

async function summarizeSessionFile(abs) {
  let st
  try {
    st = await fs.stat(abs)
  } catch {
    return null
  }
  const cached = summaryCache.get(abs)
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.data

  let raw = ''
  try {
    raw = await fs.readFile(abs, 'utf8')
  } catch {
    return null
  }

  let title = ''
  let lastPrompt = ''
  let firstUserText = ''
  let turns = 0
  let gitBranch = ''
  let model = ''
  let costUsd = 0
  let hasCost = false
  let version = ''
  let startedAt = null
  let todos = []

  for (const line of raw.split('\n')) {
    if (!line) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }

    if (!startedAt && r.timestamp) startedAt = r.timestamp
    if (r.gitBranch && !gitBranch) gitBranch = r.gitBranch
    if (r.version && !version) version = r.version

    if (r.type === 'ai-title' && r.aiTitle) {
      title = r.aiTitle
      continue
    }
    if (r.type === 'last-prompt' && r.lastPrompt) {
      lastPrompt = r.lastPrompt
      continue
    }
    if (r.type === 'result') {
      if (typeof r.total_cost_usd === 'number') {
        costUsd += r.total_cost_usd
        hasCost = true
      }
      continue
    }
    // A session may embed raw CLI output (a Bash tool that ran `claude -p`), in
    // which case the result record only exists as escaped JSON inside stdout.
    if (r.toolUseResult && typeof r.toolUseResult === 'object' && typeof r.toolUseResult.stdout === 'string') {
      const m = r.toolUseResult.stdout.match(/"total_cost_usd"\s*:\s*([0-9.]+)/)
      if (m) {
        const v = Number(m[1])
        if (Number.isFinite(v)) {
          costUsd += v
          hasCost = true
        }
      }
      continue
    }
    if (r.type === 'assistant') {
      if (!model && r.message?.model) model = r.message.model
      for (const b of r.message?.content || []) {
        if (b.type === 'tool_use' && b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
          todos = b.input.todos
        }
      }
      continue
    }
    if (r.type !== 'user' || r.isMeta) continue

    const content = r.message?.content
    const texts = []
    if (typeof content === 'string') texts.push(content)
    else if (Array.isArray(content)) {
      for (const b of content) if (b.type === 'text') texts.push(b.text)
    }
    const prompt = texts.find((x) => !isNoiseText(x))
    if (prompt) {
      turns++
      if (!firstUserText) firstUserText = prompt
    }
  }

  const data = {
    id: path.basename(abs, '.jsonl'),
    path: abs,
    title: title || truncate(firstUserText || lastPrompt, 60),
    lastPrompt: truncate(lastPrompt, 120),
    turns,
    mtime: st.mtimeMs,
    size: st.size,
    gitBranch,
    model,
    version,
    startedAt,
    costUsd: hasCost ? costUsd : null,
    todoTotal: todos.length,
    todoDone: todos.filter((t) => t.status === 'completed').length,
  }

  summaryCache.set(abs, { mtime: st.mtimeMs, size: st.size, data })
  return data
}

/** Session files for one project directory, newest first. */
async function listSessions(cwd) {
  const slugs = new Set([slugFor(cwd)])
  // A project may have accumulated more than one slug over time (/tmp vs
  // /private/tmp, or a `.` in the path), so match by resolved cwd as well.
  try {
    for (const d of await fs.readdir(PROJECTS_ROOT, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const dirAbs = path.join(PROJECTS_ROOT, d.name)
      let files = []
      try {
        files = (await fs.readdir(dirAbs)).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const f of files) {
        const head = await readHead(path.join(dirAbs, f))
        if (findCwd(head) && canonical(findCwd(head)) === canonical(cwd)) {
          slugs.add(d.name)
          break
        }
      }
    }
  } catch {
    /* ignore */
  }

  const names = new Set()
  const out = []
  for (const slug of slugs) {
    const dirAbs = path.join(PROJECTS_ROOT, slug)
    let files = []
    try {
      files = (await fs.readdir(dirAbs)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      if (names.has(f)) continue
      names.add(f)
      const data = await summarizeSessionFile(path.join(dirAbs, f))
      if (data) out.push(data)
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

// ---------------------------------------------------------------- transcript

/**
 * Rebuilds renderer-shaped transcript items from a session file, so resuming a
 * conversation can show what was said instead of an empty pane.
 *
 * Assistant records are appended per content block, several sharing one
 * message id, so consecutive records with the same id are merged into a single
 * turn.
 */
async function readTranscript(sessionPath, { limit = 600 } = {}) {
  const abs = resolveSessionPath(sessionPath)
  if (!abs) return { ok: false, errorKey: 'err.sessionNotFound' }

  let raw
  try {
    raw = await fs.readFile(abs, 'utf8')
  } catch {
    return { ok: false, errorKey: 'err.sessionNotFound' }
  }

  const items = []
  const toolResults = {}
  let tasks = []
  let meta = { gitBranch: '', version: '', startedAt: null }

  const pushAssistant = (messageId, model) => {
    const item = {
      kind: 'assistant',
      messageId,
      model,
      blocks: [],
      streaming: false,
      finalized: 0,
    }
    items.push(item)
    return item
  }

  let current = null
  let currentId = null

  for (const line of raw.split('\n')) {
    if (!line) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }

    if (r.gitBranch && !meta.gitBranch) meta.gitBranch = r.gitBranch
    if (r.version && !meta.version) meta.version = r.version
    if (!meta.startedAt && r.timestamp) meta.startedAt = r.timestamp

    if (r.type === 'assistant') {
      if (r.isSidechain) continue
      const id = r.message?.id || r.uuid
      if (id !== currentId) {
        current = pushAssistant(id, r.message?.model)
        currentId = id
      }
      for (const b of r.message?.content || []) {
        if (b.type === 'text') {
          if (b.text) current.blocks.push({ type: 'text', text: b.text })
        } else if (b.type === 'thinking') {
          if (b.thinking) current.blocks.push({ type: 'thinking', thinking: b.thinking })
        } else if (b.type === 'tool_use') {
          current.blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input })
          if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) tasks = b.input.todos
        }
      }
      continue
    }

    if (r.type === 'user') {
      const content = r.message?.content
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_result') {
            toolResults[b.tool_use_id] = {
              content: flattenToolResult(b.content),
              isError: !!b.is_error,
            }
          }
        }
        if (!r.isMeta) {
          const texts = content.filter((b) => b.type === 'text').map((b) => b.text)
          const prompt = texts.find((x) => !isNoiseText(x))
          if (prompt) {
            items.push({ kind: 'user', text: prompt })
            current = null
            currentId = null
          }
        }
      } else if (typeof content === 'string' && !r.isMeta && !isNoiseText(content)) {
        items.push({ kind: 'user', text: content })
        current = null
        currentId = null
      }
      continue
    }

    if (r.type === 'result') {
      items.push({
        kind: 'result',
        isError: !!r.is_error,
        result: typeof r.result === 'string' ? r.result : '',
        subtype: r.subtype,
        costUsd: r.total_cost_usd,
        durationMs: r.duration_ms,
        numTurns: r.num_turns,
        usage: r.usage || {},
      })
      current = null
      currentId = null
    }
  }

  const trimmed = items.length > limit ? items.slice(items.length - limit) : items
  return {
    ok: true,
    items: trimmed.map((it, i) => ({ ...it, finalized: it.blocks ? it.blocks.length : 0, key: `r${i}` })),
    toolResults,
    tasks,
    hiddenCount: items.length - trimmed.length,
    meta,
  }
}

function flattenToolResult(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      if (typeof c === 'string') return c
      if (c.type === 'text') return c.text
      if (c.type === 'image') return '[image]'
      return JSON.stringify(c)
    })
    .join('\n')
}

/** Only allow paths inside ~/.claude/projects, however they were supplied. */
function resolveSessionPath(input) {
  if (!input) return null
  const candidate = path.isAbsolute(input) ? input : path.join(PROJECTS_ROOT, input)
  const resolved = path.resolve(candidate)
  const root = path.resolve(PROJECTS_ROOT)
  if (!resolved.startsWith(root + path.sep)) return null
  if (!resolved.endsWith('.jsonl')) return null
  if (!fss.existsSync(resolved)) return null
  return resolved
}

// -------------------------------------------------------------------- mutate

/**
 * Deleting moves the transcript into the project's .trash folder. Claude Code
 * never writes there, so its own session list stays consistent, and the file
 * can be restored by hand.
 */
async function deleteSession(sessionPath) {
  const abs = resolveSessionPath(sessionPath)
  if (!abs) return { ok: false, errorKey: 'err.sessionNotFound' }
  const trashDir = path.join(path.dirname(abs), '.trash')
  try {
    await fs.mkdir(trashDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.rename(abs, path.join(trashDir, `${path.basename(abs, '.jsonl')}.${stamp}.jsonl`))
    summaryCache.delete(abs)
    return { ok: true }
  } catch (err) {
    return { ok: false, errorKey: 'err.deleteFailed', detail: err.message }
  }
}

module.exports = {
  PROJECTS_ROOT,
  slugFor,
  canonical,
  listProjects,
  listSessions,
  readTranscript,
  deleteSession,
  resolveSessionPath,
}
