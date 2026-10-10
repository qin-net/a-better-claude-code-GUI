import { useState } from 'react'
import Markdown, { CodeBlock } from './Markdown.jsx'
import ToolCard from './ToolCard.jsx'
import { formatCost, formatDuration, formatTokens } from '../lib/format.js'
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

function Blocks({ blocks, toolResults, root, onOpenFile, streaming }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === 'text') {
          if (!b.text) return null
          return <Markdown key={`t${i}`} text={b.text} />
        }
        if (b.type === 'thinking') {
          if (!b.thinking) return null
          return <ThinkingBlock key={`k${i}`} text={b.thinking} running={streaming && i === blocks.length - 1} />
        }
        if (b.type === 'tool_use') {
          return (
            <ToolCard
              key={b.id || `u${i}`}
              block={b}
              result={toolResults[b.id]}
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

export default function Turn({ item, toolResults, root, onOpenFile }) {
  const { t } = useI18n()

  if (item.kind === 'user') return <UserMessage item={item} />

  if (item.kind === 'result') return <ResultCard item={item} />

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
        toolResults={toolResults}
        root={root}
        onOpenFile={onOpenFile}
        streaming={item.streaming}
      />
      {item.streaming && <span className="caret" />}
      {item.collapsedCount > 0 && (
        <div className="collapsed-note">{t('msg.collapsed', { n: item.collapsedCount })}</div>
      )}
    </div>
  )
}
