import { useMemo, useState } from 'react'
import { renderMarkdown } from '../lib/format.js'
import { useI18n } from '../lib/i18n.jsx'

export default function Markdown({ text, doc = false }) {
  const { t } = useI18n()
  const html = useMemo(
    () => renderMarkdown(text, { copy: t('md.copy') }, { shiftHeadings: !doc }),
    [text, t, doc]
  )

  const onClick = (e) => {
    const btn = e.target.closest('[data-copy]')
    if (!btn) return
    const pre = btn.closest('.md-prewrap')?.querySelector('code')
    if (!pre) return
    navigator.clipboard.writeText(pre.textContent || '')
    btn.textContent = t('md.copied')
    setTimeout(() => {
      btn.textContent = t('md.copy')
    }, 1200)
  }

  return (
    <div
      className={doc ? 'markdown markdown--doc' : 'markdown'}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function CodeBlock({ code, lang, maxLines = 400 }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const lines = String(code ?? '').split('\n')
  const clipped = !expanded && lines.length > maxLines
  const shown = clipped ? lines.slice(0, maxLines).join('\n') : lines.join('\n')

  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="codeblock-lang">{lang || t('md.text')}</span>
        <span className="codeblock-meta">{t('md.lines', { n: lines.length })}</span>
        <button
          className="ghost-btn"
          onClick={() => navigator.clipboard.writeText(String(code ?? ''))}
        >
          {t('md.copy')}
        </button>
      </div>
      <pre className="codeblock-body">
        <code>{shown}</code>
      </pre>
      {clipped && (
        <button className="codeblock-more" onClick={() => setExpanded(true)}>
          {t('md.showMore', { n: lines.length - maxLines })}
        </button>
      )}
    </div>
  )
}
