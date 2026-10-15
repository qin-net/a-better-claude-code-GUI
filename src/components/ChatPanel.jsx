import { useEffect, useMemo, useRef, useState } from 'react'
import Turn from './Message.jsx'
import { useI18n } from '../lib/i18n.jsx'

const SUGGESTION_KEYS = ['suggestion.1', 'suggestion.2', 'suggestion.3', 'suggestion.4']

// With field-sizing the browser autosizes the textarea natively and the JS
// measurement fallback (which forces a synchronous page layout per keystroke)
// is never installed.
const SUPPORTS_FIELD_SIZING =
  typeof CSS !== 'undefined' && CSS.supports && CSS.supports('field-sizing', 'content')

// How many transcript rows render by default, and how many more each click of
// "show earlier" reveals. Capping the live DOM is what keeps layout cost flat
// in long sessions.
const WINDOW_INITIAL = 120
const WINDOW_STEP = 200

/**
 * The composer owns the draft text. Keystrokes used to live in ChatPanel's
 * state, which re-rendered the entire transcript per key press — typing cost
 * grew with conversation length. Here a keystroke re-renders this component
 * and nothing else.
 */
function Composer({ busy, status, slashCommands, onSend, onInterrupt, apiRef }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const taRef = useRef(null)
  // True while an IME composition is in flight; see onKeyDown.
  const composingRef = useRef(false)

  // Lets the empty-state suggestion buttons (which live outside this
  // component) prefill the draft without owning any state.
  useEffect(() => {
    if (apiRef) {
      apiRef.current = {
        setDraft: (text) => {
          setDraft(text)
          taRef.current?.focus()
        },
      }
    }
    return () => {
      if (apiRef) apiRef.current = null
    }
  }, [apiRef])

  const slashMatches = useMemo(() => {
    if (!draft.startsWith('/')) return []
    const q = draft.slice(1).toLowerCase()
    return (slashCommands || []).filter((c) => c.toLowerCase().startsWith(q)).slice(0, 8)
  }, [draft, slashCommands])

  useEffect(() => {
    setSlashOpen(draft.startsWith('/') && slashMatches.length > 0 && !draft.includes(' '))
    setSlashIndex(0)
  }, [draft, slashMatches.length])

  const submit = () => {
    const text = draft.trim()
    if (!text || busy) return
    onSend(text)
    setDraft('')
    setSlashOpen(false)
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

  // Fallback for engines without field-sizing. Reading scrollHeight after a
  // style write forces a synchronous layout, so this only runs where the CSS
  // route is unavailable.
  useEffect(() => {
    if (SUPPORTS_FIELD_SIZING) return
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }, [draft])

  return (
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
  )
}

export default function ChatPanel({
  items,
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
  onPermissionDecision,
}) {
  const { t } = useI18n()
  const scrollRef = useRef(null)
  const pinnedRef = useRef(true)
  const composerRef = useRef(null)
  const [windowSize, setWindowSize] = useState(WINDOW_INITIAL)

  // Follow the stream unless the user scrolled up to read history. Writing
  // scrollTop inside rAF lines the (unavoidable) layout up with the frame the
  // browser was going to produce anyway.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !pinnedRef.current) return
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(id)
  }, [items])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const send = (text) => {
    onSend(text)
    pinnedRef.current = true
  }

  const hiddenCount = Math.max(0, items.length - windowSize)
  const visible = hiddenCount > 0 ? items.slice(hiddenCount) : items
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
                <button
                  key={k}
                  className="suggestion"
                  onClick={() => composerRef.current?.setDraft(t(k))}
                >
                  {t(k)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="chat-stream">
          {hiddenCount > 0 && (
            <button
              className="expand-earlier"
              onClick={() => setWindowSize((s) => s + WINDOW_STEP)}
            >
              {t('chat.expandEarlier', { n: hiddenCount })}
            </button>
          )}
          {visible.map((item, i) => (
            <Turn
              key={item.key || `f${hiddenCount + i}`}
              item={item}
              root={root}
              onOpenFile={onOpenFile}
              onPermissionDecision={onPermissionDecision}
            />
          ))}
        </div>
      </div>

      <Composer
        busy={busy}
        status={status}
        slashCommands={session?.slashCommands}
        onSend={send}
        onInterrupt={onInterrupt}
        apiRef={composerRef}
      />
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
