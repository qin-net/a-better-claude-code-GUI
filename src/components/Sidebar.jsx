import { useEffect, useMemo, useState } from 'react'
import { basename, formatDuration } from '../lib/format.js'
import { useI18n } from '../lib/i18n.jsx'

const EXT_COLOR = {
  js: '#e2c08d', jsx: '#e2c08d', mjs: '#e2c08d', cjs: '#e2c08d',
  ts: '#4b9fd5', tsx: '#4b9fd5',
  py: '#5aa469', rb: '#d05a5a', go: '#6fd3e0', rs: '#d9a066',
  json: '#c9a227', css: '#7f9fd1', scss: '#d1799f', html: '#e08a5a',
  md: '#8a8f98', yml: '#c9a227', yaml: '#c9a227', sh: '#8fd17f',
}

function FileIcon({ ext }) {
  const color = EXT_COLOR[ext] || '#7d8290'
  const label = ext ? ext.slice(0, 2).toUpperCase() : '·'
  return (
    <span className="file-icon" style={{ color }}>
      {label}
    </span>
  )
}

function TreeNode({
  node,
  depth,
  expanded,
  onToggle,
  onOpen,
  activePath,
  changedPaths,
  dirtyPaths,
  onContextMenu,
  renamingPath,
  onSubmitRename,
  onCancelRename,
  creatingIn,
  onSubmitCreate,
  onCancelCreate,
}) {
  const { t } = useI18n()
  const isOpen = expanded.has(node.path)
  const changed = changedPaths.has(node.path)
  const renaming = renamingPath === node.path
  const creating = creatingIn === node.path

  if (node.type === 'dir') {
    return (
      <div>
        {renaming ? (
          <div className="tree-row tree-row--editing" style={{ paddingLeft: 8 + depth * 12 }}>
            <input
              autoFocus
              className="tree-edit-input"
              defaultValue={node.name}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSubmitRename(node.path, e.currentTarget.value)
                if (e.key === 'Escape') onCancelRename()
              }}
              onBlur={onCancelRename}
            />
          </div>
        ) : (
          <button
            className="tree-row"
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => onToggle(node.path)}
            onContextMenu={(e) => onContextMenu(e, node)}
          >
            <span className={`tree-chevron ${isOpen ? 'is-open' : ''}`}>&#9656;</span>
            <span className="tree-dir">{node.name}</span>
          </button>
        )}

        {creating && (
          <div className="tree-row tree-row--editing" style={{ paddingLeft: 8 + (depth + 1) * 12 }}>
            <input
              autoFocus
              className="tree-edit-input"
              placeholder={t('file.namePlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSubmitCreate(node.path, e.currentTarget.value)
                if (e.key === 'Escape') onCancelCreate()
              }}
              onBlur={onCancelCreate}
            />
          </div>
        )}

        {(isOpen || creating) &&
          node.children.map((c) => (
            <TreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onOpen={onOpen}
              activePath={activePath}
              changedPaths={changedPaths}
              dirtyPaths={dirtyPaths}
              onContextMenu={onContextMenu}
              renamingPath={renamingPath}
              onSubmitRename={onSubmitRename}
              onCancelRename={onCancelRename}
              creatingIn={creatingIn}
              onSubmitCreate={onSubmitCreate}
              onCancelCreate={onCancelCreate}
            />
          ))}
      </div>
    )
  }

  const isActive = activePath === node.path
  const isDirty = dirtyPaths.has(node.path)

  if (renaming) {
    return (
      <div className="tree-row tree-row--editing" style={{ paddingLeft: 8 + depth * 12 }}>
        <input
          autoFocus
          className="tree-edit-input"
          defaultValue={node.name}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmitRename(node.path, e.currentTarget.value)
            if (e.key === 'Escape') onCancelRename()
          }}
          onBlur={onCancelRename}
        />
      </div>
    )
  }

  return (
    <button
      className={`tree-row tree-row--file ${isActive ? 'is-active' : ''}`}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={() => onOpen(node.path)}
      onContextMenu={(e) => onContextMenu(e, node)}
      title={node.path}
    >
      <span className="tree-chevron-spacer" />
      <FileIcon ext={node.ext} />
      <span className="tree-file">{node.name}</span>
      {isDirty ? (
        <span className="tree-dirty" title={t('edit.dirtyTip')} />
      ) : (
        changed && <span className="tree-changed" />
      )}
    </button>
  )
}

export default function Sidebar({
  root,
  tree,
  activeTab,
  activePath,
  changedPaths,
  history,
  onOpenFolder,
  onOpenFile,
  onOpenHistory,
  onRefresh,
  view,
  setView,
  tabs,
  buffers,
  onCloseTab,
  onSelectTab,
  onCreateEntry,
  onRenameEntry,
  onDeleteEntry,
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(() => new Set())
  const [filter, setFilter] = useState('')

  // Right-click menu, plus the inline input for a new/renamed entry.
  const [menu, setMenu] = useState(null)          // { x, y, node, type }
  const [renamingPath, setRenamingPath] = useState(null)
  const [creatingIn, setCreatingIn] = useState(null)   // dir path receiving a new entry
  const [creatingType, setCreatingType] = useState('file')

  const dirtyPaths = useMemo(() => {
    const s = new Set()
    for (const [path, buf] of Object.entries(buffers || {})) {
      if (buf && buf.content !== buf.saved) s.add(path)
    }
    return s
  }, [buffers])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const openMenu = (e, node) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, node, isDir: node.type === 'dir' })
  }

  const startCreate = (parentDir, type) => {
    setMenu(null)
    setCreatingType(type)
    setCreatingIn(parentDir)
    if (parentDir) {
      setExpanded((prev) => new Set(prev).add(parentDir))
    }
  }

  const submitCreate = async (parentDir, name) => {
    const trimmed = String(name || '').trim()
    setCreatingIn(null)
    if (!trimmed) return
    await onCreateEntry(parentDir || '', trimmed, creatingType)
  }

  const submitRename = async (from, name) => {
    const trimmed = String(name || '').trim()
    setRenamingPath(null)
    if (!trimmed || trimmed === basename(from)) return
    await onRenameEntry(from, trimmed)
  }

  const menuFor = (node, isDir) => {
    const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : ''
    const target = isDir ? node.path : parent
    return [
      { key: 'newFile', label: t('file.newFile'), run: () => startCreate(target, 'file') },
      { key: 'newFolder', label: t('file.newFolder'), run: () => startCreate(target, 'dir') },
      { key: 'sep1' },
      { key: 'rename', label: t('file.rename'), run: () => { setMenu(null); setRenamingPath(node.path) } },
      { key: 'delete', label: t('file.delete'), danger: true, run: () => { setMenu(null); onDeleteEntry(node.path) } },
      { key: 'sep2' },
      { key: 'reveal', label: t('file.reveal'), run: () => { setMenu(null); window.api.reveal(`${root}/${node.path}`) } },
    ]
  }

  useEffect(() => {
    // Auto-expand top-level directories once a workspace loads.
    if (!root) return
    setExpanded((prev) => {
      if (prev.size) return prev
      const next = new Set()
      for (const n of tree) if (n.type === 'dir') next.add(n.path)
      return next
    })
  }, [root, tree])

  const toggle = (path) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const matches = (node) => {
    if (!filter.trim()) return true
    const q = filter.toLowerCase()
    if (node.type === 'file') return node.name.toLowerCase().includes(q)
    return node.children.some(matches)
  }

  const visible = tree.filter(matches)

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className="activity" data-active={view === 'files'} onClick={() => setView('files')} title={t('side.explorer')}>
          <span className="activity-icon">▤</span>
        </button>
        <button className="activity" data-active={view === 'history'} onClick={() => setView('history')} title={t('side.sessions')}>
          <span className="activity-icon">◷</span>
        </button>
        <button className="activity" data-active={view === 'open'} onClick={() => setView('open')} title={t('side.openEditors')}>
          <span className="activity-icon">◧</span>
        </button>
      </div>

      <div className="sidebar-panel">
        {view === 'files' && (
          <>
            <div className="panel-head">
              <span className="panel-title">{t('side.explorer')}</span>
              <button className="ghost-btn" onClick={onRefresh} title={t('side.rescan')}>
                &#8635;
              </button>
            </div>
            <button className="folder-btn" onClick={onOpenFolder} title={root || t('side.chooseFolder')}>
              <span className="folder-glyph">⌂</span>
              <span className="folder-name">{root ? basename(root) : t('side.openFolder')}</span>
            </button>
            {root && (
              <>
                <input
                  className="tree-filter"
                  placeholder={t('side.filter')}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <div className="tree" onContextMenu={(e) => openMenu(e, { path: '', name: '', type: 'dir' })}>
                  {visible.length === 0 && <div className="empty-hint">{t('side.noMatches')}</div>}
                  {/* new entry created at the workspace root */}
                  {creatingIn === '' && (
                    <div className="tree-row tree-row--editing" style={{ paddingLeft: 8 }}>
                      <input
                        autoFocus
                        className="tree-edit-input"
                        placeholder={t('file.namePlaceholder')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') submitCreate('', e.currentTarget.value)
                          if (e.key === 'Escape') setCreatingIn(null)
                        }}
                        onBlur={() => setCreatingIn(null)}
                      />
                    </div>
                  )}
                  {visible.map((n) => (
                    <TreeNode
                      key={n.path}
                      node={n}
                      depth={0}
                      expanded={expanded}
                      onToggle={toggle}
                      onOpen={onOpenFile}
                      activePath={activePath}
                      changedPaths={changedPaths}
                      dirtyPaths={dirtyPaths}
                      onContextMenu={openMenu}
                      renamingPath={renamingPath}
                      onSubmitRename={submitRename}
                      onCancelRename={() => setRenamingPath(null)}
                      creatingIn={creatingIn}
                      onSubmitCreate={submitCreate}
                      onCancelCreate={() => setCreatingIn(null)}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {view === 'history' && (
          <>
            <div className="panel-head">
              <span className="panel-title">{t('side.sessions')}</span>
              <span className="panel-count">{history.length}</span>
            </div>
            <div className="history">
              {history.length === 0 && <div className="empty-hint">{t('side.noSessions')}</div>}
              {history.map((h) => (
                <button key={h.id} className="history-row" onClick={() => onOpenHistory(h)}>
                  <span className="history-title">{h.title || t('session.empty')}</span>
                  <span className="history-meta">
                    {t('side.turnsAgo', {
                      turns: h.turns,
                      ago: formatDuration(Date.now() - h.mtime),
                    })}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {view === 'open' && (
          <>
            <div className="panel-head">
              <span className="panel-title">{t('side.openEditors')}</span>
              <span className="panel-count">{tabs.length}</span>
            </div>
            <div className="history">
              {tabs.length === 0 && <div className="empty-hint">{t('side.nothingOpen')}</div>}
              {tabs.map((path) => (
                <div key={path} className={`open-row ${activeTab === path ? 'is-active' : ''}`}>
                  <button className="open-name" onClick={() => onSelectTab(path)}>
                    {basename(path)}
                  </button>
                  <button className="ghost-btn" onClick={() => onCloseTab(path)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {menu && (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menuFor(menu.node, menu.isDir).map((item, i) =>
            item.key.startsWith('sep') ? (
              <div key={item.key} className="ctx-sep" />
            ) : (
              <button
                key={item.key}
                className={`ctx-item ${item.danger ? 'ctx-item--danger' : ''}`}
                onClick={item.run}
              >
                {item.label}
              </button>
            )
          )}
        </div>
      )}
    </aside>
  )
}