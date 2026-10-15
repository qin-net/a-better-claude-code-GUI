import { useEffect, useMemo, useState } from 'react'
import HomeSidebar from './HomeSidebar.jsx'
import Markdown from './Markdown.jsx'
import { LangSwitch } from './ChatPanel.jsx'
import { basename, formatCost, formatDuration, formatTokens } from '../lib/format.js'
import { useI18n } from '../lib/i18n.jsx'

function fmtDate(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtSize(bytes) {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Progress ring-less bar used for the TodoWrite completion summary. */
function TaskProgress({ done, total }) {
  const { t } = useI18n()
  if (!total) return null
  const pct = Math.round((done / total) * 100)
  return (
    <div className="task-progress">
      <div className="task-progress-bar">
        <div className="task-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="task-progress-text">{t('home.todoDone', { done, total })}</span>
    </div>
  )
}

function TaskList({ tasks }) {
  const { t } = useI18n()
  if (!tasks.length) {
    return (
      <div className="home-empty">
        <p>{t('home.noTasks')}</p>
        <p className="home-empty-sub">{t('home.tasksHint')}</p>
      </div>
    )
  }
  return (
    <>
      <ul className="todo-list home-todo-list">
        {tasks.map((task, i) => (
          <li key={i} className={`todo todo--${task.status || 'pending'}`}>
            <span className="todo-mark">
              {task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '●' : '○'}
            </span>
            <span>{task.content || task.activeForm}</span>
          </li>
        ))}
      </ul>
      <p className="home-empty-sub">{t('home.tasksHint')}</p>
    </>
  )
}

function SessionRow({ session, selected, onOpen, onResume, onDelete, onReveal }) {
  const { t } = useI18n()
  return (
    <div className={`sess-row ${selected ? 'is-active' : ''}`}>
      <button className="sess-main" onClick={() => onOpen(session)}>
        <span className="sess-title">{session.title || session.id.slice(0, 8)}</span>
        <span className="sess-meta">
          <span>{t('home.turnCount', { n: session.turns })}</span>
          {session.model && <span className="sess-chip">{session.model.replace(/^claude-/, '')}</span>}
          {session.gitBranch && <span className="sess-chip">{session.gitBranch}</span>}
          {session.costUsd !== null && <span className="sess-chip">{formatCost(session.costUsd)}</span>}
          {session.todoTotal > 0 && (
            <span className="sess-chip sess-chip--todo">
              {session.todoDone}/{session.todoTotal}
            </span>
          )}
          <span className="sess-ago">{formatDuration(Date.now() - session.mtime)} ago</span>
        </span>
        {session.lastPrompt && <span className="sess-prompt">{session.lastPrompt}</span>}
      </button>
      <div className="sess-actions">
        <button className="ghost-btn" onClick={() => onResume(session)} title={t('home.resume')}>
          {t('home.resume')}
        </button>
        <button className="ghost-btn" onClick={() => onReveal(session)} title={t('home.reveal')}>
          ⌕
        </button>
        <button className="ghost-btn ghost-btn--danger" onClick={() => onDelete(session)} title={t('home.delete')}>
          ×
        </button>
      </div>
    </div>
  )
}

export default function HomeView({ onOpenSession, onBackToIde, currentCwd }) {
  const { t } = useI18n()

  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [sessions, setSessions] = useState([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [openSession, setOpenSession] = useState(null)
  const [transcript, setTranscript] = useState(null)
  const [transcriptLoading, setTranscriptLoading] = useState(false)

  const extraPaths = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('ccgui.recentFolders') || '[]')
    } catch {
      return []
    }
  }, [])

  const loadProjects = async () => {
    setLoading(true)
    const res = await window.api.listProjects(extraPaths)
    setLoading(false)
    if (!res.ok) return
    setProjects(res.projects)
    setSelected((prev) => {
      if (prev) {
        const still = res.projects.find((p) => p.path === prev.path)
        if (still) return still
      }
      return res.projects.find((p) => p.path === currentCwd) || res.projects[0] || null
    })
  }

  useEffect(() => {
    loadProjects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selected) {
      setSessions([])
      return
    }
    let cancelled = false
    setSessionsLoading(true)
    setOpenSession(null)
    setTranscript(null)
    window.api.listSessions(selected.path).then((res) => {
      if (cancelled) return
      setSessionsLoading(false)
      setSessions(res.ok ? res.sessions : [])
    })
    return () => {
      cancelled = true
    }
  }, [selected])

  const openTranscript = async (session) => {
    setOpenSession(session)
    setTranscriptLoading(true)
    const res = await window.api.readSession(session.path)
    setTranscriptLoading(false)
    setTranscript(res.ok ? res : { ok: false, errorKey: res.errorKey })
  }

  const removeSession = async (session) => {
    if (!window.confirm(t('home.deleteConfirm'))) return
    const res = await window.api.deleteSession(session.path)
    if (res.ok) {
      setSessions((prev) => prev.filter((s) => s.path !== session.path))
      if (openSession?.path === session.path) {
        setOpenSession(null)
        setTranscript(null)
      }
    }
  }

  const addFolder = async () => {
    const dir = await window.api.pickFolder()
    if (!dir) return
    const next = [...new Set([...extraPaths, dir])]
    localStorage.setItem('ccgui.recentFolders', JSON.stringify(next))
    const res = await window.api.listProjects(next)
    if (res.ok) {
      setProjects(res.projects)
      const found = res.projects.find((p) => p.path === dir)
      if (found) setSelected(found)
    }
  }

  const filteredSessions = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter(
      (s) =>
        (s.title || '').toLowerCase().includes(q) ||
        (s.lastPrompt || '').toLowerCase().includes(q) ||
        s.id.includes(q)
    )
  }, [sessions, search])

  // The task panel reflects the newest TodoWrite across the project's sessions.
  const projectTasks = useMemo(() => {
    if (transcript?.tasks?.length) return transcript.tasks
    return []
  }, [transcript])

  const taskSummary = useMemo(() => {
    if (!sessions.length) return { done: 0, total: 0 }
    const latest = sessions.find((s) => s.todoTotal > 0)
    return latest ? { done: latest.todoDone, total: latest.todoTotal } : { done: 0, total: 0 }
  }, [sessions])

  const recentItems = transcript?.items?.slice(-12) || []

  return (
    <div className="home">
      <header className="titlebar">
        <span className="titlebar-name">Claude Code</span>
        <span className="titlebar-path">{t('home.title')}</span>
        <span className="spacer" />
        <span className="home-dims">{t('home.dimensions')}</span>
        <LangSwitch />
        <button className="ghost-btn" onClick={onBackToIde}>
          {t('home.backToIde')}
        </button>
      </header>

      <div className="home-body">
        <HomeSidebar
          projects={projects}
          loading={loading}
          selectedPath={selected?.path}
          onSelect={setSelected}
          onOpenFolder={addFolder}
          onRefresh={loadProjects}
        />

        {!selected ? (
          <main className="home-main home-main--empty">
            <p>{t('home.selectProject')}</p>
          </main>
        ) : (
          <main className="home-main">
            <div className="home-proj-head">
              <div className="home-proj-title">
                <h2>{selected.name}</h2>
                <span className="home-proj-path">{selected.path}</span>
              </div>
              <div className="home-proj-actions">
                <button className="send-btn" onClick={() => onOpenSession(selected.path, null)}>
                  {t('home.openIde')}
                </button>
              </div>
            </div>

            <div className="home-facts">
              <div className="fact">
                <span className="fact-k">{t('home.sessions')}</span>
                <span className="fact-v">{selected.sessionCount}</span>
              </div>
              <div className="fact">
                <span className="fact-k">{t('home.inRegistry')}</span>
                <span className="fact-v">{selected.inRegistry ? '✓' : '—'}</span>
              </div>
              <div className="fact">
                <span className="fact-k">{t('home.started')}</span>
                <span className="fact-v">{selected.lastActivity ? fmtDate(selected.lastActivity) : '—'}</span>
              </div>
              {taskSummary.total > 0 && (
                <div className="fact">
                  <span className="fact-k">{t('home.tasks')}</span>
                  <span className="fact-v">
                    {taskSummary.done}/{taskSummary.total}
                  </span>
                </div>
              )}
            </div>

            <div className="home-cols">
              <section className="home-col">
                <div className="home-col-head">
                  <span className="panel-title">{t('home.sessions')}</span>
                  <span className="panel-count">{sessions.length}</span>
                </div>
                <input
                  className="tree-filter"
                  placeholder={t('home.search')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="sess-list">
                  {sessionsLoading && <div className="empty-hint">{t('home.loading')}</div>}
                  {!sessionsLoading && filteredSessions.length === 0 && (
                    <div className="empty-hint">
                      {search ? t('side.noMatches') : t('home.noSessionsInProject')}
                    </div>
                  )}
                  {filteredSessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      selected={openSession?.id === s.id}
                      onOpen={openTranscript}
                      onResume={() => onOpenSession(selected.path, s.id)}
                      onDelete={removeSession}
                      onReveal={() => window.api.revealSession(s.path)}
                    />
                  ))}
                </div>
              </section>

              <section className="home-col">
                <div className="home-col-head">
                  <span className="panel-title">{t('home.tasks')}</span>
                  {taskSummary.total > 0 && (
                    <span className="panel-count">
                      {taskSummary.done}/{taskSummary.total}
                    </span>
                  )}
                </div>
                <div className="home-tasks">
                  <TaskList tasks={projectTasks} />
                </div>

                <div className="home-col-head home-col-head--sub">
                  <span className="panel-title">{t('home.transcriptPreview')}</span>
                </div>
                <div className="home-transcript">
                  {transcriptLoading && <div className="empty-hint">{t('home.loadTranscript')}</div>}
                  {!transcriptLoading && !openSession && (
                    <div className="empty-hint">{t('home.selectProject')}</div>
                  )}
                  {!transcriptLoading && transcript && !transcript.ok && (
                    <div className="empty-hint">{t(transcript.errorKey || 'err.storeRead', { message: '' })}</div>
                  )}
                  {!transcriptLoading && transcript?.ok && (
                    <>
                      {transcript.hiddenCount > 0 && (
                        <div className="collapsed-note">
                          {t('msg.collapsed', { n: transcript.hiddenCount })}
                        </div>
                      )}
                      {recentItems.map((it, i) => {
                        if (it.kind === 'user') {
                          return (
                            <div key={i} className="mini-turn mini-turn--user">
                              {String(it.text).slice(0, 300)}
                            </div>
                          )
                        }
                        if (it.kind === 'assistant') {
                          const text = it.blocks.find((b) => b.type === 'text')
                          const tools = it.blocks.filter((b) => b.type === 'tool_use')
                          return (
                            <div key={i} className="mini-turn mini-turn--assistant">
                              {tools.length > 0 && (
                                <div className="mini-tools">
                                  {tools.map((tl) => (
                                    <span key={tl.id} className="mini-tool">
                                      {tl.name}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {text && (
                                <div className="mini-text">
                                  <Markdown text={text.text.slice(0, 400)} />
                                </div>
                              )}
                            </div>
                          )
                        }
                        return null
                      })}
                    </>
                  )}
                </div>
              </section>
            </div>
          </main>
        )}
      </div>
    </div>
  )
}
