import { useEffect, useMemo, useRef, useState } from 'react'
import CodeEditor from './CodeEditor.jsx'
import { basename, langForExt } from '../lib/format.js'
import { useI18n } from '../lib/i18n.jsx'

/** Map a file extension onto a Monaco language id where they differ. */
const LANG_OVERRIDE = {
  bash: 'shell',
  zsh: 'shell',
  sh: 'shell',
  jsx: 'javascript',
  tsx: 'typescript',
  vue: 'html',
  svelte: 'html',
}

function monacoLang(ext) {
  const e = String(ext || '').toLowerCase()
  return LANG_OVERRIDE[e] || langForExt(e) || 'plaintext'
}

export default function EditorPane({
  tab,
  tabs,
  activeTab,
  onSelectTab,
  onCloseTab,
  buffers,
  conflicts,
  onDirty,
  onSave,
  onResolveConflict,
  onOpenFile,
}) {
  const { t } = useI18n()
  const [saving, setSaving] = useState(false)
  const [flash, setFlash] = useState('')

  const buffer = tab ? buffers[tab] : null
  const conflict = tab ? conflicts[tab] : null
  const dirty = !!buffer && buffer.content !== buffer.saved
  const ext = useMemo(() => tab?.split('.').pop(), [tab])

  useEffect(() => {
    if (!flash) return
    const id = setTimeout(() => setFlash(''), 1800)
    return () => clearTimeout(id)
  }, [flash])

  const requestSave = async () => {
    if (!tab || !buffer || saving) return
    setSaving(true)
    const res = await onSave(tab)
    setSaving(false)
    if (res?.ok) setFlash(t('edit.saved', { name: basename(tab) }))
  }

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
          {tabs.map((path) => {
            const b = buffers[path]
            const isDirty = b && b.content !== b.saved
            return (
              <div key={path} className={`tab ${activeTab === path ? 'is-active' : ''}`}>
                <button className="tab-name" onClick={() => onSelectTab(path)} title={path}>
                  {basename(path)}
                  {isDirty && <span className="tab-modified" title={t('edit.dirtyTip')} />}
                </button>
                <button className="tab-close" onClick={() => onCloseTab(path)}>
                  ×
                </button>
              </div>
            )
          })}
        </div>
        <div className="tabbar-actions">
          <button
            className="ghost-btn"
            data-active={dirty}
            onClick={requestSave}
            disabled={!dirty || saving}
            title={t('edit.saveTitle')}
          >
            {dirty ? t('edit.save') : '✓'}
          </button>
        </div>
      </div>

      <div className="editor-pathbar">
        <span className="editor-path">{tab}</span>
        <span className="editor-lang">{monacoLang(ext)}</span>
        <span className="spacer" />
        {dirty && <span className="editor-dirty-flag">{t('edit.unsaved')}</span>}
        {flash && <span className="editor-flash">{flash}</span>}
      </div>

      {conflict && (
        <div className="conflict-bar">
          <span className="conflict-text">⚠ {t('edit.conflict', { name: basename(tab) })}</span>
          <span className="spacer" />
          <button className="ghost-btn" onClick={() => onResolveConflict(tab, 'mine')}>
            {t('edit.keepMine')}
          </button>
          <button className="ghost-btn" onClick={() => onResolveConflict(tab, 'disk')}>
            {t('edit.useDisk')}
          </button>
        </div>
      )}

      <div className="editor-body editor-body--mono">
        {buffer?.tooLarge ? (
          <div className="editor-status">{t('edit.readOnlyBig')}</div>
        ) : buffer?.error ? (
          <div className="editor-status editor-status--error">{buffer.error}</div>
        ) : buffer ? (
          <CodeEditor
            path={tab}
            content={buffer.content}
            language={monacoLang(ext)}
            onChange={(path, value) => onDirty(path, value)}
            onSaveRequest={() => requestSave()}
          />
        ) : (
          <div className="editor-status">{t('editor.loading')}</div>
        )}
      </div>
    </section>
  )
}
