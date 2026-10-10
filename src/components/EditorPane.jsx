import { useEffect, useMemo, useRef, useState } from 'react'
import { basename, langForExt } from '../lib/format.js'
import { useI18n } from '../lib/i18n.jsx'

export default function EditorPane({ tab, tabs, activeTab, onSelectTab, onCloseTab, root, changedPaths }) {
  const { t } = useI18n()
  const [state, setState] = useState({ loading: false, content: '', error: '', truncated: false, tooLarge: false })
  const [wrap, setWrap] = useState(false)
  const [query, setQuery] = useState('')
  const [showFind, setShowFind] = useState(false)
  const bodyRef = useRef(null)

  useEffect(() => {
    if (!tab || !root) return
    let cancelled = false
    setState({ loading: true, content: '', error: '', truncated: false, tooLarge: false })
    window.api.readFile(root, tab).then((res) => {
      if (cancelled) return
      if (res.ok) {
        setState({
          loading: false,
          content: res.content,
          error: '',
          truncated: res.truncated,
          tooLarge: !!res.tooLarge,
        })
      } else {
        setState({ loading: false, content: '', error: res.error, truncated: false, tooLarge: false })
      }
    })
    return () => {
      cancelled = true
    }
  }, [tab, root, changedPaths])

  const lines = useMemo(() => state.content.split('\n'), [state.content])

  const matchIndex = useMemo(() => {
    if (!query.trim()) return -1
    return lines.findIndex((l) => l.includes(query))
  }, [lines, query])

  useEffect(() => {
    if (matchIndex < 0 || !bodyRef.current) return
    const row = bodyRef.current.querySelector(`[data-line="${matchIndex + 1}"]`)
    row?.scrollIntoView({ block: 'center' })
  }, [matchIndex])

  const lang = langForExt(tab?.split('.').pop())

  if (!tab) {
    return (
      <section className="editor editor--empty">
        <div className="editor-empty-inner">
          <div className="editor-empty-title">{t('editor.noFile')}</div>
          <p className="editor-empty-sub">{t('editor.noFileSub')}</p>
        </div>
      </section>
    )
  }

  return (
    <section className="editor">
      <div className="tabbar">
        <div className="tabs">
          {tabs.map((path) => (
            <div key={path} className={`tab ${activeTab === path ? 'is-active' : ''}`}>
              <button className="tab-name" onClick={() => onSelectTab(path)} title={path}>
                {basename(path)}
                {changedPaths.has(path) && <span className="tab-modified" />}
              </button>
              <button className="tab-close" onClick={() => onCloseTab(path)}>
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="tabbar-actions">
          <button className="ghost-btn" onClick={() => setShowFind((v) => !v)} title={t('editor.findTitle')}>
            {t('editor.find')}
          </button>
          <button className="ghost-btn" data-active={wrap} onClick={() => setWrap((v) => !v)} title={t('editor.wrapTitle')}>
            {t('editor.wrap')}
          </button>
        </div>
      </div>

      <div className="editor-pathbar">
        <span className="editor-path">{tab}</span>
        {lang && <span className="editor-lang">{lang}</span>}
        <span className="spacer" />
        <span className="editor-meta">{t('editor.lines', { n: lines.length })}</span>
      </div>

      {showFind && (
        <div className="findbar">
          <input
            autoFocus
            className="find-input"
            placeholder={t('editor.findPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setShowFind(false)
            }}
          />
          <span className="find-result">
            {query && matchIndex >= 0
              ? t('editor.lineN', { n: matchIndex + 1 })
              : query
                ? t('editor.noMatch')
                : ''}
          </span>
        </div>
      )}

      <div className={`editor-body ${wrap ? 'is-wrap' : ''}`} ref={bodyRef}>
        {state.loading && <div className="editor-status">{t('editor.loading')}</div>}
        {state.error && <div className="editor-status editor-status--error">{state.error}</div>}
        {!state.loading && !state.error && !state.tooLarge && (
          <div className="code-view">
            {lines.map((line, i) => {
              const isHit = matchIndex === i
              return (
                <div key={i} className={`code-line ${isHit ? 'is-hit' : ''}`} data-line={i + 1}>
                  <span className="code-gutter">{i + 1}</span>
                  <span className="code-text">{line || ' '}</span>
                </div>
              )
            })}
          </div>
        )}
        {state.tooLarge && <div className="editor-status">{t('err.tooLarge')}</div>}
        {state.truncated && !state.tooLarge && <div className="editor-status">{t('editor.truncated')}</div>}
      </div>
    </section>
  )
}
