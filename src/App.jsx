import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from './components/Sidebar.jsx'
import ChatPanel from './components/ChatPanel.jsx'
import EditorPane from './components/EditorPane.jsx'
import { useI18n } from './lib/i18n.jsx'

const LS_FOLDER = 'ccgui.lastFolder'
const LS_MODEL = 'ccgui.model'
const LS_MODE = 'ccgui.permissionMode'

let keySeq = 0
const nextKey = () => `k${++keySeq}`

export default function App() {
  const { t, lang } = useI18n()

  const [root, setRoot] = useState('')
  const [tree, setTree] = useState([])
  const [view, setView] = useState('files')

  const [tabs, setTabs] = useState([])
  const [activeTab, setActiveTab] = useState(null)

  const [items, setItems] = useState([])
  const [toolResults, setToolResults] = useState({})
  const [changedPaths, setChangedPaths] = useState(() => new Set())

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
  }, [t])

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
  }, [permissionMode])

  // ------------------------------------------------------------------- streams

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
          setToolResults((prev) => ({
            ...prev,
            [ev.toolUseId]: { content: ev.content, isError: ev.isError },
          }))
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

  // ------------------------------------------------------------------ actions

  const openFolder = async () => {
    const dir = await window.api.pickFolder()
    if (!dir) return
    setRoot(dir)
    localStorage.setItem(LS_FOLDER, dir)
    setItems([])
    setToolResults({})
    setChangedPaths(new Set())
    setSession(null)
    setTabs([])
    setActiveTab(null)
    await loadTree(dir)
    await loadHistory(dir)
    await window.api.startAgent({ cwd: dir, model, permissionMode })
  }

  const openFile = useCallback((rel) => {
    setTabs((prev) => (prev.includes(rel) ? prev : [...prev, rel]))
    setActiveTab(rel)
  }, [])

  const closeTab = (rel) => {
    setTabs((prev) => {
      const next = prev.filter((p) => p !== rel)
      setActiveTab((cur) => (cur === rel ? next[next.length - 1] || null : cur))
      return next
    })
  }

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
    setToolResults({})
    setChangedPaths(new Set())
    setSession(null)
    setBusy(false)
    setStatus('idle')
    await startAgent({})
  }

  const openHistory = async (h) => {
    await window.api.stopAgent()
    setItems([
      {
        kind: 'notice',
        text: tRef.current('notice.resumed', { id: h.id.slice(0, 8), turns: h.turns }),
      },
    ])
    setToolResults({})
    setBusy(false)
    await startAgent({ resumeId: h.id })
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

  return (
    <div className="app">
      <header className="titlebar">
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
          onOpenFolder={openFolder}
          onOpenFile={openFile}
          onOpenHistory={openHistory}
          onRefresh={() => {
            loadTree(root)
            loadHistory(root)
          }}
          onSelectTab={setActiveTab}
          onCloseTab={closeTab}
        />

        <main className="center">
          <EditorPane
            tab={activeTab}
            tabs={tabs}
            activeTab={activeTab}
            root={root}
            changedPaths={changedPaths}
            onSelectTab={setActiveTab}
            onCloseTab={closeTab}
          />
        </main>

        <ChatPanel
          items={items}
          toolResults={toolResults}
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
