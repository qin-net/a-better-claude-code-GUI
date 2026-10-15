import { useEffect, useMemo, useRef, useState } from 'react'
import Turn from './Message.jsx'
import { useI18n } from '../lib/i18n.jsx'

const SUGGESTION_KEYS = ['suggestion.1', 'suggestion.2', 'suggestion.3', 'suggestion.4']

export default function ChatPanel({
  items,
  toolResults,
  root,
  busy,
  status,
  session,
  model,
  setModel,
  permissionMode,
  setPermissionMode,
  onSend,
  onInterrupt,
  onOpenFile,
  onNewSession,
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const scrollRef = useRef(null)
  const taRef = useRef(null)
  const pinnedRef = useRef(true)
  // True while an IME composition is in flight; see onKeyDown.
  const composingRef = useRef(false)

  const slashCommands = session?.slashCommands || []

  const slashMatches = useMemo(() => {
    if (!draft.startsWith('/')) return []
    const q = draft.slice(1).toLowerCase()
    return slashCommands.filter((c) => c.toLowerCase().startsWith(q)).slice(0, 8)
  }, [draft, slashCommands])

  useEffect(() => {
    setSlashOpen(draft.startsWith('/') && slashMatches.length > 0 && !draft.includes(' '))
    setSlashIndex(0)
  }, [draft, slashMatches.length])

  // Follow the stream unless the user scrolled up to read history.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [items])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const submit = () => {
    const text = draft.trim()
    if (!text || busy) return
    onSend(text)
    setDraft('')
    setSlashOpen(false)
    pinnedRef.current = true
  }

  const onKeyDown = (e) => {
    // While an IME is composing (Chinese/Japanese/Korean input), Enter confirms
    // the candidate instead of submitting. Chrome reports it as isComposing,
    // but Safari fires compositionend before the keydown, leaving isComposing
    // false — there the keydown carries keyCode 229, so check both. Arrow keys
    // are also part of candidate selection, so bail out of all handling here.
    if (e.nativeEvent?.isComposing || e.nativeEvent?.keyCode === 229 || composingRef.current) {
      return
    }

    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % slashMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        setDraft(`/${slashMatches[slashIndex]} `)
        setSlashOpen(false)
        return
      }
      if (e.key === 'Escape') {
        setSlashOpen(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const onCompositionStart = () => {
    composingRef.current = true
  }

  const onCompositionEnd = () => {
    // Safari sequences compositionend before the confirming keydown, so clear
    // the flag on the next tick rather than synchronously.
    setTimeout(() => {
      composingRef.current = false
    }, 0)
  }

  const autoGrow = () => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }

  useEffect(autoGrow, [draft])

  const empty = items.length === 0

  return (
    <section className="chat">
      <div className="chat-toolbar">
        <div className="session-info">
          {session?.sessionId ? (
            <>
              <span className="session-dot" data-state={busy ? 'running' : 'idle'} />
              <span className="session-id" title={session.sessionId}>
                {session.sessionId.slice(0, 8)}
              </span>
              {session.model && <span className="session-model">{session.model}</span>}
            </>
          ) : (
            <span className="session-id">{t('chat.noSession')}</span>
          )}
        </div>

        <div className="spacer" />

        <select
          className="mini-select"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          title={t('chat.model')}
        >
          <option value="">{t('chat.defaultModel')}</option>
          <option value="fable">fable</option>
          <option value="opus">opus</option>
          <option value="sonnet">sonnet</option>
          <option value="haiku">haiku</option>
        </select>

        <select
          className="mini-select"
          value={permissionMode}
          onChange={(e) => setPermissionMode(e.target.value)}
          title={t('chat.permissionMode')}
        >
          <option value="acceptEdits">{t('mode.acceptEdits')}</option>
          <option value="auto">{t('mode.auto')}</option>
          <option value="plan">{t('mode.plan')}</option>
          <option value="manual">{t('mode.manual')}</option>
          <option value="dontAsk">{t('mode.dontAsk')}</option>
          <option value="bypassPermissions">{t('mode.bypassPermissions')}</option>
        </select>

        <LangSwitch />

        <button className="ghost-btn" onClick={onNewSession} title={t('chat.newSession')}>
          {t('chat.new')}
        </button>
      </div>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {empty && (
          <div className="chat-empty">
            <div className="empty-logo">Claude Code</div>
            <p className="empty-sub">
              {root ? t('chat.workingIn', { root }) : t('chat.openFolder')}
            </p>
            <div className="suggestions">
              {SUGGESTION_KEYS.map((k) => (
                <button key={k} className="suggestion" onClick={() => setDraft(t(k))}>
                  {t(k)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="chat-stream">
          {items.map((item, i) => (
            <Turn
              key={item.key || i}
              item={item}
              toolResults={toolResults}
              root={root}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      </div>

      <div className="composer">
        {slashOpen && (
          <div className="slash-menu">
            {slashMatches.map((c, i) => (
              <button
                key={c}
                className={`slash-item ${i === slashIndex ? 'is-active' : ''}`}
                onMouseEnter={() => setSlashIndex(i)}
                onClick={() => {
                  setDraft(`/${c} `)
                  setSlashOpen(false)
                  taRef.current?.focus()
                }}
              >
                /{c}
              </button>
            ))}
          </div>
        )}

        <div className="composer-box">
          <textarea
            ref={taRef}
            className="composer-input"
            rows={1}
            placeholder={busy ? t('chat.placeholderBusy') : t('chat.placeholder')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            spellCheck={false}
          />
          <div className="composer-actions">
            <span className="composer-hint">
              {status === 'running' ? t('chat.processing') : t('chat.enterHint')}
            </span>
            {busy ? (
              <button className="stop-btn" onClick={onInterrupt} title={t('chat.stopTitle')}>
                <span className="stop-square" />
                {t('chat.stop')}
              </button>
            ) : (
              <button className="send-btn" onClick={submit} disabled={!draft.trim()}>
                {t('chat.send')}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

/** Segmented EN/中文 toggle — both languages always reachable in one click. */
export function LangSwitch() {
  const { lang, setLang, t } = useI18n()
  return (
    <div className="lang-switch" title={t('lang.title')}>
      <button
        className="lang-btn"
        data-active={lang === 'zh'}
        onClick={() => setLang('zh')}
      >
        中文
      </button>
      <button
        className="lang-btn"
        data-active={lang === 'en'}
        onClick={() => setLang('en')}
      >
        EN
      </button>
    </div>
  )
}
