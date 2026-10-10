import { useMemo, useState } from 'react'
import { CodeBlock } from './Markdown.jsx'
import {
  diffLines,
  formatTokens,
  langForExt,
  shortenPath,
  toolSummary,
} from '../lib/format.js'
import { useI18n } from '../lib/i18n.jsx'

const TOOL_ICON = {
  Bash: '$',
  Read: 'R',
  Write: 'W',
  Edit: 'E',
  Glob: '*',
  Grep: '?',
  WebFetch: '@',
  WebSearch: '%',
  Task: 'T',
  TodoWrite: 'o',
}

function StatusDot({ state }) {
  return <span className={`tool-dot tool-dot--${state}`} />
}

export default function ToolCard({ block, result, root, onOpenFile }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const name = block.name || 'Tool'
  const input = block.input || {}
  const summary = toolSummary(name, input, t)
  const state = result ? (result.isError ? 'error' : 'done') : 'running'
  const icon = TOOL_ICON[name] || '>'

  const headPath =
    input.file_path || input.notebook_path
      ? shortenPath(input.file_path || input.notebook_path, root)
      : ''

  const clickable = !!headPath && !!onOpenFile
  const openFile = () => {
    if (clickable) onOpenFile(input.file_path || input.notebook_path)
  }

  return (
    <div className={`tool tool--${state}`}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className={`tool-chevron ${open ? 'is-open' : ''}`}>&#9656;</span>
        <span className="tool-icon">{icon}</span>
        <span className="tool-name">{name}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        <span className="tool-spacer" />
        {state === 'running' && <span className="tool-spinner" />}
        <StatusDot state={state} />
      </button>

      {open && (
        <div className="tool-body">
          {name === 'Edit' && (input.old_string !== undefined || input.new_string !== undefined) && (
            <DiffView oldStr={input.old_string} newStr={input.new_string} path={headPath} onOpen={clickable ? openFile : null} />
          )}

          {name === 'Write' && input.content !== undefined && (
            <>
              {clickable && (
                <button className="tool-path" onClick={openFile}>
                  {headPath}
                </button>
              )}
              <CodeBlock code={input.content} lang={langForExt(input.file_path?.split('.').pop())} />
            </>
          )}

          {name !== 'Edit' && name !== 'Write' && (
            <ToolInput name={name} input={input} />
          )}

          {name === 'Edit' && (
            <details className="tool-inline-io">
              <summary>{t('tool.rawInput')}</summary>
              <CodeBlock code={JSON.stringify(input, null, 2)} lang="json" maxLines={80} />
            </details>
          )}

          {result && (
            <div className="tool-output">
              <div className="tool-output-head">
                <span>{result.isError ? t('tool.error') : t('tool.output')}</span>
              </div>
              <CodeBlock code={result.content || t('tool.noOutput')} lang={name === 'Bash' ? 'bash' : 'text'} maxLines={200} />
            </div>
          )}
        </div>
      )}

      {!open && result?.isError && <div className="tool-inline-error">{firstLine(result.content)}</div>}
    </div>
  )
}

function firstLine(s) {
  const line = String(s || '').split('\n').find((l) => l.trim())
  return line ? line.slice(0, 200) : ''
}

function ToolInput({ name, input }) {
  const { t } = useI18n()

  if (name === 'Bash' && input.command) {
    return (
      <div className="tool-command">
        <span className="tool-command-prompt">$</span>
        <code>{input.command}</code>
      </div>
    )
  }
  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    return (
      <ul className="todo-list">
        {input.todos.map((t, i) => (
          <li key={i} className={`todo todo--${t.status || 'pending'}`}>
            <span className="todo-mark">
              {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'}
            </span>
            <span>{t.content}</span>
          </li>
        ))}
      </ul>
    )
  }
  if (name === 'Grep' || name === 'Glob') {
    return (
      <div className="tool-kv">
        <Row k={t('tool.pattern')} v={input.pattern} />
        {input.path && <Row k={t('tool.path')} v={shortenPath(input.path)} />}
        {input.glob && <Row k={t('tool.glob')} v={input.glob} />}
      </div>
    )
  }
  if (name === 'Task') {
    return (
      <div className="tool-kv">
        <Row k={t('tool.agent')} v={input.subagent_type} />
        <Row k={t('tool.description')} v={input.description} />
        {input.prompt && <CodeBlock code={input.prompt} lang="text" maxLines={40} />}
      </div>
    )
  }
  if (name === 'WebSearch' || name === 'WebFetch') {
    return (
      <div className="tool-kv">
        {input.query && <Row k={t('tool.query')} v={input.query} />}
        {input.url && <Row k={t('tool.url')} v={input.url} />}
      </div>
    )
  }
  return <CodeBlock code={JSON.stringify(input, null, 2)} lang="json" maxLines={120} />
}

function Row({ k, v }) {
  if (v === undefined || v === null || v === '') return null
  return (
    <div className="kv-row">
      <span className="kv-key">{k}</span>
      <span className="kv-val">{String(v)}</span>
    </div>
  )
}

function DiffView({ oldStr, newStr, path, onOpen }) {
  const { t } = useI18n()
  const diff = useMemo(() => diffLines(oldStr, newStr), [oldStr, newStr])
  const lines = String(newStr ?? '').split('\n').length

  return (
    <div className="diff">
      <div className="diff-head">
        {onOpen ? (
          <button className="tool-path" onClick={onOpen}>
            {path}
          </button>
        ) : (
          <span className="tool-path tool-path--static">{path}</span>
        )}
        <span className="diff-stat">
          <span className="diff-add">+{diff.added}</span>
          <span className="diff-del">-{diff.removed}</span>
        </span>
      </div>
      <div className="diff-body">
        {diff.rows.map((r, i) => (
          <div key={i} className={`diff-row diff-row--${r.type}`}>
            <span className="diff-num">{r.num}</span>
            <span className="diff-sign">{r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}</span>
            <span className="diff-text">{r.text || ' '}</span>
          </div>
        ))}
      </div>
      <div className="diff-foot">{t('tool.linesInResult', { n: lines })}</div>
    </div>
  )
}

export function ToolResultBadge({ result }) {
  const { t } = useI18n()
  if (!result) return null
  const tokens = result.content ? Math.ceil(result.content.length / 4) : 0
  return (
    <span className="tool-result-badge">
      {result.isError ? t('tool.error') : t('tool.tokens', { n: formatTokens(tokens) })}
    </span>
  )
}
