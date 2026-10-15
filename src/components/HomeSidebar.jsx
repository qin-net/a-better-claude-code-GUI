import { useEffect, useMemo, useState } from 'react'
import { formatDuration } from '../lib/format.js'
import { useI18n } from '../lib/i18n.jsx'

/**
 * Project rail for the home screen: every project Claude Code knows about,
 * merged from its on-disk session folders, its own registry, and folders opened
 * through this app.
 */
export default function HomeSidebar({
  projects,
  loading,
  selectedPath,
  onSelect,
  onOpenFolder,
  onRefresh,
}) {
  const { t } = useI18n()
  const [filter, setFilter] = useState('')

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return projects
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
    )
  }, [projects, filter])

  const total = projects.reduce((n, p) => n + p.sessionCount, 0)

  return (
    <aside className="home-side">
      <div className="home-side-head">
        <span className="home-side-title">{t('home.projects')}</span>
        <span className="panel-count">{projects.length}</span>
        <button className="ghost-btn" onClick={onRefresh} title={t('home.refresh')}>
          &#8635;
        </button>
      </div>

      <input
        className="tree-filter"
        placeholder={t('home.filterProjects')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <button className="folder-btn" onClick={onOpenFolder} title={t('home.addFolderHint')}>
        <span className="folder-glyph">+</span>
        <span className="folder-name">{t('home.addFolder')}</span>
      </button>

      <div className="home-proj-list">
        {loading && <div className="empty-hint">{t('home.loading')}</div>}
        {!loading && visible.length === 0 && (
          <div className="empty-hint">{filter ? t('side.noMatches') : t('home.noProjects')}</div>
        )}
        {visible.map((p) => (
          <button
            key={p.path}
            className={`proj-row ${selectedPath === p.path ? 'is-active' : ''} ${p.exists ? '' : 'is-missing'}`}
            onClick={() => onSelect(p)}
            title={p.path}
          >
            <span className="proj-name">{p.name}</span>
            <span className="proj-meta">
              {p.sessionCount > 0 ? t('home.sessionCount', { n: p.sessionCount }) : t('home.noSessions')}
              {p.lastActivity ? ` · ${formatDuration(Date.now() - p.lastActivity)}` : ''}
            </span>
            <span className="proj-badges">
              {!p.exists && <span className="proj-badge proj-badge--missing">{t('home.missing')}</span>}
              {p.exists && !p.inRegistry && (
                <span className="proj-badge" title={t('home.unregisteredHint')}>
                  {t('home.unregistered')}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>

      <div className="home-side-foot">
        <span className="home-foot-stat">{t('home.totalSessions', { n: total })}</span>
      </div>
    </aside>
  )
}
