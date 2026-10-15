import { memo, useState } from 'react'
import Markdown from './Markdown.jsx'
import ToolCard from './ToolCard.jsx'
import { formatCost, formatDuration, formatTokens, toolSummary } from '../lib/format.js'
import { useI18n } from '../lib/i18n.jsx'

function ThinkingBlock({ text, running }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  // CJK text has no spaces to split on, so count characters instead of words.
  const count = String(text || '').replace(/\s+/g, '').length
  return (
    <div className={`thinking ${open ? 'is-open' : ''}`}>
      <button className="thinking-head" onClick={() => setOpen((v) => !v)}>
        <span className={`tool-chevron ${open ? 'is-open' : ''}`}>&#9656;</span>
        <span className="thinking-label">{running ? t('msg.thinking') : t('msg.thought')}</span>
        <span className="thinking-meta">{t('msg.words', { n: count })}</span>
      </button>
      {open && (
        <div className="thinking-body">
          <Markdown text={text} />
        </div>
      )}
    </div>
  )
}

function UserMessage({ item }) {
  const { t } = useI18n()
  return (
    <div className="turn turn--user">
      <div className="user-bubble">
        {item.text && <div className="user-text">{item.text}</div>}
        {item.attachments?.length > 0 && (
          <div className="user-attachments">
            {item.attachments.map((a, i) => (
              <span key={i} className="attachment-chip">
                {a.name || t('msg.file')}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ResultCard({ item }) {
  const { t } = useI18n()
  const usage = item.usage || {}
  const cacheRead = usage.cache_read_input_tokens || 0
  const cacheWrite = usage.cache_creation_input_tokens || 0
  const out = usage.output_tokens || 0

  if (item.isError) {
    return (
      <div className="result result--error">
        <span className="result-error-label">{t('msg.turnFailed')}</span>
        <span className="result-detail">{item.result || item.subtype}</span>
      </div>
    )
  }

  return (
    <div className="result">
      <span className="result-detail">
        {item.numTurns ? t('msg.steps', { n: item.numTurns }) : ''}
        {item.durationMs ? ` · ${formatDuration(item.durationMs)}` : ''}
      </span>
      <span className="result-spacer" />
      {out > 0 && <span className="result-chip">{t('msg.out', { n: formatTokens(out) })}</span>}
      {cacheWrite > 0 && <span className="result-chip">{t('msg.cacheWrite', { n: formatTokens(cacheWrite) })}</span>}
      {cacheRead > 0 && <span className="result-chip">{t('msg.cacheRead', { n: formatTokens(cacheRead) })}</span>}
      {typeof item.costUsd === 'number' && <span className="result-chip result-chip--cost">{formatCost(item.costUsd)}</span>}
    </div>
  )
}

/**
 * A permission ask from the CLI. Pending shows 允许/总是允许/拒绝; once decided
 * (or auto-allowed by a session rule, or orphaned by a process restart) the
 * card keeps a record of what happened.
 */
function PermissionCard({ item, onDecide }) {
  const { t } = useI18n()
  const summary = toolSummary(item.tool, item.input || {}, t)
  const detailRaw =
    item.input?.command ||
    item.input?.file_path ||
    item.input?.url ||
    ''
  // toolSummary for Bash already is the command — don't print it twice.
  const detail = String(detailRaw) === String(summary) ? '' : detailRaw

  const badge = {
    allowed: t('perm.allowed'),
    denied: t('perm.denied'),
    auto: t('perm.auto'),
    cancelled: t('perm.cancelled'),
  }[item.status]

  return (
    <div className={`perm-card perm-card--${item.status}`}>
      <div className="perm-head">
        <span className="perm-icon">⚿</span>
        <span className="perm-title">{t('perm.title')}</span>
        <span className="perm-tool">{item.tool}</span>
        {badge && <span className={`perm-badge perm-badge--${item.status}`}>{badge}</span>}
      </div>
      <div className="perm-summary">{summary}</div>
      {detail && <pre className="perm-detail">{String(detail).slice(0, 600)}</pre>}
      {item.status === 'pending' && (
        <div className="perm-actions">
          <button className="perm-btn perm-btn--allow" onClick={() => onDecide(item, 'allow')}>
            {t('perm.allow')}
          </button>
          <button className="perm-btn" onClick={() => onDecide(item, 'always')}>
            {t('perm.allowAlways')}
          </button>
          <button className="perm-btn perm-btn--deny" onClick={() => onDecide(item, 'deny')}>
            {t('perm.deny')}
          </button>
        </div>
      )}
    </div>
  )
}

function Blocks({ blocks, results, root, onOpenFile, streaming, liveFrom }) {
  return (
    <>
      {blocks.map((b, i) => {
        // Blocks still streaming render as plain text: re-parsing the whole
        // accumulated markdown and swapping the block's innerHTML every flush
        // is what made long answers progressively slower. The finished block
        // arrives via a 'block' event and gets the full renderer.
        const live = streaming && i >= liveFrom
        if (b.type === 'text') {
          if (!b.text) return null
          if (live) return <div key={`t${i}`} className="md-live">{b.text}</div>
          return <Markdown key={`t${i}`} text={b.text} />
        }
        if (b.type === 'thinking') {
          if (!b.thinking) return null
          return <ThinkingBlock key={`k${i}`} text={b.thinking} running={live && i === blocks.length - 1} />
        }
        if (b.type === 'tool_use') {
          return (
            <ToolCard
              key={b.id || `u${i}`}
              block={b}
              result={results ? results[b.id] : undefined}
              root={root}
              onOpenFile={onOpenFile}
            />
          )
        }
        return null
      })}
    </>
  )
}

function Turn({ item, root, onOpenFile, onPermissionDecision }) {
  const { t } = useI18n()

  if (item.kind === 'user') return <UserMessage item={item} />

  if (item.kind === 'result') return <ResultCard item={item} />

  if (item.kind === 'permission') {
    return <PermissionCard item={item} onDecide={onPermissionDecision} />
  }

  if (item.kind === 'notice') {
    return (
      <div className={`notice notice--${item.level || 'info'}`}>
        <span className="notice-label">{item.level === 'error' ? t('msg.error') : t('msg.note')}</span>
        <span>{item.text}</span>
      </div>
    )
  }

  // assistant turn
  return (
    <div className="turn turn--assistant">
      <Blocks
        blocks={item.blocks}
        results={item.results}
        root={root}
        onOpenFile={onOpenFile}
        streaming={item.streaming}
        liveFrom={item.finalized || 0}
      />
      {item.streaming && <span className="caret" />}
      {item.collapsedCount > 0 && (
        <div className="collapsed-note">{t('msg.collapsed', { n: item.collapsedCount })}</div>
      )}
    </div>
  )
}

// During streaming and typing, every row except the one being written to keeps
// identical props — memo turns the per-update render cost from O(conversation)
// into O(1). Item objects are replaced (never mutated) by App, so the default
// shallow compare is exactly right.
export default memo(Turn)
