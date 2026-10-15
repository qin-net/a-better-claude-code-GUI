import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from './components/Sidebar.jsx'
import ChatPanel from './components/ChatPanel.jsx'
import EditorPane from './components/EditorPane.jsx'
import HomeView from './components/HomeView.jsx'
import { useI18n } from './lib/i18n.jsx'

const LS_FOLDER = 'ccgui.lastFolder'
const LS_MODEL = 'ccgui.model'
const LS_MODE = 'ccgui.permissionMode'

let keySeq = 0
const nextKey = () => `k${++keySeq}`
const withKeys = (list) => list.map((it) => ({ key: nextKey(), ...it }))

/**
 * Fold a transcript's toolUseId -> result map into the items that own the
 * matching tool_use blocks. Results living on the item (instead of one global
 * map passed to every row) is what lets rows be memoized: a result arriving
 * changes exactly one item's identity.
 */
function attachResults(list, results) {
  if (!results) return list
  return list.map((it) => {
    if (it.kind !== 'assistant' || !it.blocks) return it
    let own = null
    for (const b of it.blocks) {
      if (b.type === 'tool_use' && results[b.id]) {
        own = own || {}
        own[b.id] = results[b.id]
      }
    }
    return own ? { ...it, results: own } : it
  })
}

export default function App() {
  const { t, lang } = useI18n()

  // 'home' is the project/session manager; 'ide' is the workspace.
  const [screen, setScreen] = useState('home')

  const [root, setRoot] = useState('')
  const [tree, setTree] = useState([])
  const [view, setView] = useState('files')

  const [tabs, setTabs] = useState([])
  const [activeTab, setActiveTab] = useState(null)

  // Open file buffers: rel path -> { content, saved, mtime, tooLarge, error }.
  // `saved` is what is on disk, so content !== saved means dirty.
  const [buffers, setBuffers] = useState({})
  // rel path -> { diskContent } when disk moved under an edited buffer.
  const [conflicts, setConflicts] = useState({})

  const [items, setItems] = useState([])
  const [changedPaths, setChangedPaths] = useState(() => new Set())

  // Tools the user chose "always allow" for during this session.
  const autoAllowRef = useRef(new Set())

  const [session, setSession] = useState(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('idle')
  const [history, setHistory] = useState([])

  const [model, setModel] = useState(() => localStorage.getItem(LS_MODEL) || '')
  const [permissionMode, setPermissionMode] = useState(
    () => localStorage.getItem(LS_MODE) || 'acceptEdits'
  )

  // Collected during a turn, folded into the finished assistant message.
  const usageRef = useRef(null)
  const sessionIdRef = useRef('')

  // The CLI stream handlers are subscribed once; reading t through a ref keeps
  // already-queued notices translating correctly after a language switch.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [])

  // The disk watcher runs for the life of the workspace, so it reads buffers
  // through a ref instead of re-subscribing on every keystroke.
  const buffersRef = useRef({})
  useEffect(() => {
    buffersRef.current = buffers
  }, [buffers])

  // ------------------------------------------------------------------ helpers

  const appendItem = useCallback((item) => {
    setItems((prev) => [...prev, { key: nextKey(), ...item }])
  }, [])

  const loadTree = useCallback(async (dir) => {
    if (!dir) return
    const res = await window.api.readTree(dir)
    setTree(res)
  }, [])

  const loadHistory = useCallback(async (dir) => {
    if (!dir) return setHistory([])
    const res = await window.api.listHistory(dir)
    setHistory(res)
  }, [])

  /** Main-process calls report an errorKey; render it in the active language. */
  const describeError = useCallback((res) => {
    if (!res) return ''
    if (res.errorKey) return tRef.current(res.errorKey, { message: res.detail || '' })
    return res.error || ''
  }, [])

  const startAgent = useCallback(
    async (opts = {}) => {
      if (!root) return
      const res = await window.api.startAgent({
        cwd: root,
        model,
        permissionMode,
        resumeId: opts.resumeId || '',
      })
      if (!res.ok) {
        appendItem({
          kind: 'notice',
          level: 'error',
          text: describeError(res) || tRef.current('notice.failedStart'),
        })
      }
    },
    [root, model, permissionMode, appendItem, describeError]
  )

  // ------------------------------------------------------------------- startup

  useEffect(() => {
    const saved = localStorage.getItem(LS_FOLDER)
    if (saved) {
      setRoot(saved)
      loadTree(saved)
      loadHistory(saved)
    }
  }, [loadTree, loadHistory])

  useEffect(() => {
    localStorage.setItem(LS_MODEL, model)
  }, [model])
  useEffect(() => {
    localStorage.setItem(LS_MODE, permissionMode)
  }, [permissionMode])  // ------------------------------------------------------------------- streams

  useEffect(() => {
    const offEvent = window.api.onEvent((ev) => {
      const tr = tRef.current
      switch (ev.kind) {
        case 'init': {
          sessionIdRef.current = ev.sessionId
          setSession({
            sessionId: ev.sessionId,
            model: ev.model,
            cwd: ev.cwd,
            tools: ev.tools || [],
            slashCommands: ev.slashCommands || [],
            version: ev.version,
          })
          setStatus('idle')
          break
        }
        case 'message_start': {
          appendItem({ kind: 'assistant', blocks: [], streaming: true, finalized: 0 })
          break
        }
        case 'partial': {
          setItems((prev) => {
            const idx = lastAssistantIndex(prev)
            if (idx < 0) return prev
            const turn = prev[idx]
            const stillStreaming = ev.blocks.slice(turn.finalized)
            const next = prev.slice()
            next[idx] = { ...turn, blocks: [...turn.blocks.slice(0, turn.finalized), ...stillStreaming] }
            return next
          })
          break
        }
        case 'block': {
          const b = ev.block
          if (b.type === 'tool_use' && (b.name === 'Edit' || b.name === 'Write')) {
            const p = b.input?.file_path
            if (p && root && p.startsWith(root)) {
              const rel = p.slice(root.length).replace(/^\//, '')
              setChangedPaths((prev) => new Set(prev).add(rel))
            }
          }
          setItems((prev) => {
            const idx = lastAssistantIndex(prev)
            if (idx < 0) return prev
            const turn = prev[idx]
            const next = prev.slice()
            next[idx] = {
              ...turn,
              blocks: [...turn.blocks.slice(0, turn.finalized), b],
              finalized: turn.finalized + 1,
            }
            return next
          })
          break
        }
        case 'tool_result': {
          // Attach the result to the item that owns the tool_use block, so only
          // that row's identity changes and every other row stays memoized.
          setItems((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              const it = prev[i]
              if (
                it.kind === 'assistant' &&
                it.blocks?.some((b) => b.type === 'tool_use' && b.id === ev.toolUseId)
              ) {
                const next = prev.slice()
                next[i] = {
                  ...it,
                  results: {
                    ...(it.results || {}),
                    [ev.toolUseId]: { content: ev.content, isError: ev.isError },
                  },
                }
                return next
              }
            }
            return prev
          })
          break
        }
        case 'permission_request': {
          if (autoAllowRef.current.has(ev.tool)) {
            window.api.respondPermission({ requestId: ev.requestId, behavior: 'allow' })
            appendItem({
              kind: 'permission',
              requestId: ev.requestId,
              tool: ev.tool,
              input: ev.input,
              status: 'auto',
            })
          } else {
            appendItem({
              kind: 'permission',
              requestId: ev.requestId,
              tool: ev.tool,
              input: ev.input,
              status: 'pending',
            })
          }
          break
        }
        case 'permission_cancelled': {
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'permission' && it.requestId === ev.requestId && it.status === 'pending'
                ? { ...it, status: 'cancelled' }
                : it
            )
          )
          break
        }
        case 'usage': {
          usageRef.current = ev.usage
          break
        }
        case 'result': {
          setItems((prev) => {
            const idx = lastAssistantIndex(prev)
            if (idx < 0) return prev
            const next = prev.slice()
            next[idx] = { ...next[idx], streaming: false, blocks: next[idx].blocks.slice(0, next[idx].finalized) }
            return next
          })
          appendItem({
            kind: 'result',
            isError: ev.isError,
            result: ev.result,
            subtype: ev.subtype,
            costUsd: ev.costUsd,
            durationMs: ev.durationMs,
            numTurns: ev.numTurns,
            usage: ev.usage || usageRef.current || {},
          })
          for (const d of ev.denials || []) {
            appendItem({
              kind: 'notice',
              level: 'error',
              text: tr('notice.permissionDenied', { tool: d.tool_name || tr('notice.aTool') }),
            })
          }
          // The relay's "model not allowed / has no valid services" 400 is a
          // transient upstream outage, not a key permission problem — say so
          // instead of leaking the raw gateway error.
          if (ev.isError && /该key不允许访问该模型|has no valid services/i.test(ev.result || '')) {
            appendItem({ kind: 'notice', level: 'error', text: tr('notice.relayFlaky') })
          }
          setBusy(false)
          setStatus('idle')
          loadTree(root)
          loadHistory(root)
          break
        }
        case 'status': {
          setStatus(ev.state)
          if (ev.state === 'running') setBusy(true)
          if (ev.state === 'interrupted') {
            setBusy(false)
            appendItem({ kind: 'notice', text: tr('notice.interrupted') })
          }
          break
        }
        case 'error': {
          appendItem({
            kind: 'notice',
            level: 'error',
            text: ev.errorKey ? tr(ev.errorKey, { message: ev.detail || '' }) : ev.message,
          })
          break
        }
        case 'stderr': {
          const text = String(ev.text || '').trim()
          if (text && !text.startsWith('[DEBUG]')) {
            appendItem({ kind: 'notice', level: 'error', text: text.slice(0, 400) })
          }
          break
        }
        default:
          break
      }
    })

    const offExit = window.api.onExit((info) => {
      setBusy(false)
      setStatus('idle')
      if (info.intentional) return
      if (info.code !== 0 && info.code !== null) {
        appendItem({
          kind: 'notice',
          level: 'error',
          text: tRef.current('notice.exited', { code: info.code }),
        })
      }
    })

    return () => {
      offEvent()
      offExit()
    }
  }, [appendItem, loadTree, loadHistory, root])

  // ------------------------------------------------------- external changes
  //
  // Claude edits files through the CLI, which would otherwise overwrite an open
  // buffer without warning. A changed file that has unsaved edits raises a
  // conflict; one with a clean buffer reloads silently.

  useEffect(() => {
    const off = window.api.onFsChanged(async ({ paths }) => {
      if (!root || !paths?.length) return

      for (const rel of paths) {
        const buf = buffersRef.current[rel]
        if (!buf || buf.tooLarge) continue

        const res = await window.api.readFile(root, rel)
        if (!res.ok) continue
        const diskContent = res.content
        if (diskContent === buf.saved) continue

        if (buf.content === buf.saved) {
          // Nothing of mine to lose — take the disk version.
          setBuffers((prev) =>
            prev[rel]
              ? { ...prev, [rel]: { ...prev[rel], content: diskContent, saved: diskContent, mtime: res.mtime } }
              : prev
          )
        } else {
          setConflicts((prev) => ({ ...prev, [rel]: { diskContent } }))
        }
      }
      loadTree(root)
    })
    return off
  }, [root, loadTree])

  useEffect(() => {
    if (root && screen === 'ide') window.api.watchWorkspace(root)
  }, [root, screen])

  // ------------------------------------------------------------------ actions

  const openFolder = async () => {
    const dir = await window.api.pickFolder()
    if (!dir) return
    setRoot(dir)
    localStorage.setItem(LS_FOLDER, dir)
    setItems([])
    setChangedPaths(new Set())
    setSession(null)
    setTabs([])
    setActiveTab(null)
    await loadTree(dir)
    await loadHistory(dir)
    await window.api.startAgent({ cwd: dir, model, permissionMode })
  }

  const openFile = useCallback(
    async (rel) => {
      setTabs((prev) => (prev.includes(rel) ? prev : [...prev, rel]))
      setActiveTab(rel)
      // Load into a buffer on first open; reopening keeps unsaved work.
      setBuffers((prev) => {
        if (prev[rel]) return prev
        return prev
      })
      const res = await window.api.readFile(root, rel)
      setBuffers((prev) => {
        if (prev[rel]) return prev
        if (!res.ok) return { ...prev, [rel]: { content: '', saved: '', error: res.error } }
        return {
          ...prev,
          [rel]: {
            content: res.content,
            saved: res.content,
            mtime: res.mtime,
            tooLarge: !!res.tooLarge,
          },
        }
      })
    },
    [root]
  )

  const onDirty = useCallback((rel, value) => {
    setBuffers((prev) => (prev[rel] ? { ...prev, [rel]: { ...prev[rel], content: value } } : prev))
  }, [])

  /**
   * The user's verdict on a permission card.
   * action: 'allow' | 'always' (allow + remember the tool for this session) | 'deny'.
   */
  const decidePermission = useCallback(async (item, action) => {
    if (action === 'always') autoAllowRef.current.add(item.tool)
    const behavior = action === 'deny' ? 'deny' : 'allow'
    const res = await window.api.respondPermission({ requestId: item.requestId, behavior })
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'permission' && it.requestId === item.requestId
          ? { ...it, status: res?.ok ? (behavior === 'allow' ? 'allowed' : 'denied') : 'cancelled' }
          : it
      )
    )
  }, [])

  const saveBuffer = useCallback(
    async (rel) => {
      const buf = buffers[rel]
      if (!buf) return { ok: false }
      const res = await window.api.writeFile(root, rel, buf.content)
      if (res.ok) {
        setBuffers((prev) =>
          prev[rel]
            ? { ...prev, [rel]: { ...prev[rel], saved: prev[rel].content, mtime: res.mtime } }
            : prev
        )
        // Saving my version resolves any pending conflict for this file.
        setConflicts((prev) => {
          if (!prev[rel]) return prev
          const next = { ...prev }
          delete next[rel]
          return next
        })
        loadTree(root)
      } else if (rel) {
        appendItem({
          kind: 'notice',
          level: 'error',
          text: describeError(res) || tRef.current('notice.sendFailed'),
        })
      }
      return res
    },
    [buffers, root, loadTree, appendItem, describeError]
  )

  const closeTab = async (rel) => {
    const buf = buffers[rel]
    if (buf && buf.content !== buf.saved) {
      const ok = window.confirm(tRef.current('edit.discardConfirm', { name: rel }))
      if (!ok) return
    }
    setTabs((prev) => {
      const next = prev.filter((p) => p !== rel)
      setActiveTab((cur) => (cur === rel ? next[next.length - 1] || null : cur))
      return next
    })
    setBuffers((prev) => {
      const next = { ...prev }
      delete next[rel]
      return next
    })
    setConflicts((prev) => {
      const next = { ...prev }
      delete next[rel]
      return next
    })
  }

  /** Keep my buffer or take the version now on disk. */
  const resolveConflict = useCallback((rel, choice) => {
    setConflicts((prev) => {
      const entry = prev[rel]
      if (!entry) return prev
      if (choice === 'disk') {
        setBuffers((b) =>
          b[rel] ? { ...b, [rel]: { ...b[rel], content: entry.diskContent, saved: entry.diskContent } } : b
        )
      } else {
        // Keep mine: adopt disk as the new baseline so the tab stays dirty and
        // the next save overwrites deliberately.
        setBuffers((b) => (b[rel] ? { ...b, [rel]: { ...b[rel], saved: entry.diskContent } } : b))
      }
      const next = { ...prev }
      delete next[rel]
      return next
    })
  }, [])

  // ------------------------------------------------- file operations (tree)

  const createEntry = useCallback(
    async (parentRel, name, type) => {
      const rel = parentRel ? `${parentRel}/${name}` : name
      const res = await window.api.createEntry(root, rel, type)
      if (!res.ok) {
        appendItem({ kind: 'notice', level: 'error', text: describeError(res) })
        return { ok: false }
      }
      await loadTree(root)
      if (type === 'file') await openFile(rel)
      return { ok: true, path: rel }
    },
    [root, loadTree, openFile, appendItem, describeError]
  )

  const renameEntry = useCallback(
    async (from, name) => {
      const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
      const to = parent ? `${parent}/${name}` : name
      const res = await window.api.renameEntry(root, from, to)
      if (!res.ok) {
        appendItem({ kind: 'notice', level: 'error', text: describeError(res) })
        return { ok: false }
      }
      // Carry the buffer and tab over to the new path.
      setBuffers((prev) => {
        if (!prev[from]) return prev
        const next = { ...prev, [to]: prev[from] }
        delete next[from]
        return next
      })
      setTabs((prev) => prev.map((p) => (p === from ? to : p)))
      setActiveTab((cur) => (cur === from ? to : cur))
      await loadTree(root)
      return { ok: true, path: to }
    },
    [root, loadTree, appendItem, describeError]
  )

  const deleteEntry = useCallback(
    async (rel) => {
      const ok = window.confirm(tRef.current('file.deleteConfirm', { name: rel }))
      if (!ok) return { ok: false }
      const res = await window.api.deleteEntry(root, rel)
      if (!res.ok) {
        appendItem({ kind: 'notice', level: 'error', text: describeError(res) })
        return { ok: false }
      }
      appendItem({ kind: 'notice', text: tRef.current('file.deleted', { name: rel }) })
      // Close any tab that lived under the deleted path.
      setTabs((prev) => {
        const next = prev.filter((p) => p !== rel && !p.startsWith(rel + '/'))
        setActiveTab((cur) => (cur && (cur === rel || cur.startsWith(rel + '/')) ? next[next.length - 1] || null : cur))
        return next
      })
      setBuffers((prev) => {
        const next = { ...prev }
        for (const p of Object.keys(next)) {
          if (p === rel || p.startsWith(rel + '/')) delete next[p]
        }
        return next
      })
      await loadTree(root)
      return { ok: true }
    },
    [root, loadTree, appendItem, describeError]
  )

  const send = async (text) => {
    appendItem({ kind: 'user', text })
    setBusy(true)
    setStatus('running')
    const res = await window.api.sendMessage({ text })
    if (!res.ok) {
      appendItem({
        kind: 'notice',
        level: 'error',
        text: describeError(res) || tRef.current('notice.sendFailed'),
      })
      setBusy(false)
      setStatus('idle')
    }
  }

  const newSession = async () => {
    await window.api.stopAgent()
    setItems([])
    setChangedPaths(new Set())
    setSession(null)
    setBusy(false)
    setStatus('idle')
    await startAgent({})
  }

  /**
   * Resume a session from the workspace sidebar. Renders its transcript so the
   * conversation is visible rather than an empty pane, matching the manage
   * screen's behaviour.
   */
  const openHistory = async (h) => {
    await window.api.stopAgent()

    const notice = {
      kind: 'notice',
      text: tRef.current('notice.resumed', { id: h.id.slice(0, 8), turns: h.turns }),
    }

    let rendered = []
    let results = {}
    if (h.path) {
      const parsed = await window.api.readSession(h.path)
      if (parsed.ok) {
        rendered = parsed.items
        results = parsed.toolResults || {}
      }
    }

    setItems(withKeys([notice, ...attachResults(rendered, results)]))
    setBusy(false)
    setStatus('idle')
    setSession({
      sessionId: h.id,
      model: h.model || '',
      cwd: root,
      tools: [],
      slashCommands: [],
      version: '',
      resumed: true,
    })
    sessionIdRef.current = h.id
    await startAgent({ resumeId: h.id })
  }

  /**
   * Entry point from the manager screen. Opens a folder as the workspace and
   * resumes the given session, rendering its transcript so the conversation is
   * not blank on arrival.
   */
  const openSessionInIde = async (cwd, sessionId) => {
    await window.api.stopAgent()

    setRoot(cwd)
    localStorage.setItem(LS_FOLDER, cwd)

    const recent = (() => {
      try {
        return JSON.parse(localStorage.getItem('ccgui.recentFolders') || '[]')
      } catch {
        return []
      }
    })()
    localStorage.setItem('ccgui.recentFolders', JSON.stringify([...new Set([...recent, cwd])]))

    setTabs([])
    setActiveTab(null)
    setChangedPaths(new Set())
    setSession(null)
    setBusy(false)
    setStatus('idle')

    if (sessionId) {
      const res = await window.api.listSessions(cwd)
      const record = res.ok ? res.sessions.find((s) => s.id === sessionId) : null

      // In --resume mode the CLI emits no init event until the first message of
      // the turn, so the session header would sit empty. Seed it from what we
      // already know; a real init overwrites this once the user speaks.
      setSession({
        sessionId,
        model: record?.model || '',
        cwd,
        tools: [],
        slashCommands: [],
        version: record?.version || '',
        resumed: true,
      })

      if (record) {
        const parsed = await window.api.readSession(record.path)
        if (parsed.ok) {
          setItems(
            withKeys([
              {
                kind: 'notice',
                text: tRef.current('notice.resumed', {
                  id: sessionId.slice(0, 8),
                  turns: record.turns,
                }),
              },
              ...attachResults(parsed.items, parsed.toolResults),
            ])
          )
        } else {
          setItems(withKeys([{ kind: 'notice', text: tRef.current('notice.resumed', { id: sessionId.slice(0, 8), turns: 0 }) }]))
        }
      }
      sessionIdRef.current = sessionId
    } else {
      setItems([])
    }

    setScreen('ide')
    loadTree(cwd)
    loadHistory(cwd)

    await window.api.startAgent({
      cwd,
      model,
      permissionMode,
      resumeId: sessionId || '',
    })
  }

  // Model / permission changes need a fresh process; resume keeps the history.
  const onModelChange = async (m) => {
    setModel(m)
    const sid = session?.sessionId
    await window.api.stopAgent()
    await window.api.startAgent({ cwd: root, model: m, permissionMode, resumeId: sid || '' })
  }

  const onPermissionChange = async (mode) => {
    setPermissionMode(mode)
    const sid = session?.sessionId
    await window.api.stopAgent()
    await window.api.startAgent({ cwd: root, model, permissionMode: mode, resumeId: sid || '' })
  }

  const interrupt = async () => {
    await window.api.interruptAgent()
    setBusy(false)
  }

  // ------------------------------------------------------------------ shortcuts

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'o') {
        e.preventDefault()
        openFolder()
      }
      if (e.key === 'k') {
        e.preventDefault()
        document.querySelector('.composer-input')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (screen === 'home') {
    return (
      <div className="app" data-lang={lang}>
        <HomeView
          currentCwd={root}
          onOpenSession={openSessionInIde}
          onBackToIde={() => setScreen('ide')}
        />
      </div>
    )
  }

  return (
    <div className="app" data-lang={lang}>
      <header className="titlebar">
        <button className="ghost-btn titlebar-manage" onClick={() => setScreen('home')} title={t('home.manage')}>
          ☰
        </button>
        <span className="titlebar-name">Claude Code</span>
        <span className="titlebar-path">{root || t('titlebar.noFolder')}</span>
        <span className="spacer" />
        <span className={`status-pill status-pill--${busy ? 'busy' : 'idle'}`}>
          {busy
            ? t('status.running')
            : status === 'stopped'
              ? t('status.stopped')
              : t('status.idle')}
        </span>
      </header>

      <div className="workspace" data-lang={lang}>
        <Sidebar
          root={root}
          tree={tree}
          view={view}
          setView={setView}
          activeTab={activeTab}
          activePath={activeTab}
          changedPaths={changedPaths}
          history={history}
          tabs={tabs}
          buffers={buffers}
          onOpenFolder={openFolder}
          onOpenFile={openFile}
          onOpenHistory={openHistory}
          onRefresh={() => {
            loadTree(root)
            loadHistory(root)
          }}
          onSelectTab={setActiveTab}
          onCloseTab={closeTab}
          onCreateEntry={createEntry}
          onRenameEntry={renameEntry}
          onDeleteEntry={deleteEntry}
        />

        <main className="center">
          <EditorPane
            tab={activeTab}
            tabs={tabs}
            activeTab={activeTab}
            root={root}
            buffers={buffers}
            conflicts={conflicts}
            changedPaths={changedPaths}
            onDirty={onDirty}
            onSave={saveBuffer}
            onResolveConflict={resolveConflict}
            onSelectTab={setActiveTab}
            onCloseTab={closeTab}
            onOpenFile={openFile}
          />
        </main>

        <ChatPanel
          items={items}
          root={root}
          busy={busy}
          status={status}
          session={session}
          model={model}
          setModel={onModelChange}
          permissionMode={permissionMode}
          setPermissionMode={onPermissionChange}
          onSend={send}
          onInterrupt={interrupt}
          onOpenFile={openFile}
          onNewSession={newSession}
          onPermissionDecision={decidePermission}
        />
      </div>
    </div>
  )
}

function lastAssistantIndex(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'assistant') return i
  }
  return -1
}
