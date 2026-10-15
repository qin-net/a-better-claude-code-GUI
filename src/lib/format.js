// Display formatting helpers for the transcript UI: markdown-to-HTML rendering, path shortening, duration/cost/token formatting, language labels, tool summaries and diff lines.
/**
 * Minimal markdown renderer. Deliberately small: Claude's replies are mostly
 * prose, fenced code, inline code and lists, and a hand-rolled pass keeps the
 * bundle free of a parser dependency and the output free of raw HTML.
 */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    // Images must be rewritten before links, or ![a](url) loses its "!" to the link rule.
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img class="md-img" src="$2" alt="$1" loading="lazy" referrerpolicy="no-referrer"/>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
}

function renderCode(code, lang, labels) {
  const label = lang ? `<span class="md-lang">${escapeHtml(lang)}</span>` : ''
  return `<div class="md-prewrap"><div class="md-prelabel">${label}<button class="md-copy" data-copy>${escapeHtml(labels.copy)}</button></div><pre class="md-pre"><code>${escapeHtml(code)}</code></pre></div>`
}

/** Split a table row into cells, tolerating optional leading/trailing pipes. */
function splitRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/** A GFM delimiter row looks like |---|:--:|---| */
function isTableDelimiter(line) {
  if (!line || !line.includes('-')) return false
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c))
}

function renderTable(header, rows) {
  const head = header
    .map((c) => `<th>${inline(c)}</th>`)
    .join('')
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
    .join('')
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}

export function renderMarkdown(src, labels, opts = {}) {
  const L = labels || { copy: 'copy' }
  if (!src) return ''
  const text = String(src).replace(/\r\n/g, '\n')
  const out = []
  const lines = text.split('\n')
  let i = 0

  const pushParagraph = (buf) => {
    if (!buf.length) return
    out.push(`<p>${buf.map(inline).join('<br/>')}</p>`)
    buf.length = 0
  }

  const para = []
  let list = null

  const closeList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((t) => `<li>${inline(t)}</li>`).join('')}</${list.tag}>`)
      list = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    const fence = line.match(/^\s*```(\S*)\s*$/)
    if (fence) {
      pushParagraph(para)
      closeList()
      const lang = fence[1] || ''
      const body = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // consume closing fence
      out.push(renderCode(body.join('\n'), lang, L))
      continue
    }

    // A table is a header row followed by a |---| delimiter row.
    if (line.includes('|') && isTableDelimiter(lines[i + 1] || '')) {
      pushParagraph(para)
      closeList()
      const header = splitRow(line)
      const rows = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]))
        i++
      }
      out.push(renderTable(header, rows))
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      pushParagraph(para)
      closeList()
      // Keep the transcript outline sensible: a lone # should not outrank the
      // surrounding UI, so shift down one level and cap at h6. Document views
      // (README preview) pass shiftHeadings: false to keep the real levels.
      const level = opts.shiftHeadings === false
        ? heading[1].length
        : Math.min(heading[1].length + 1, 6)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      i++
      continue
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (bullet || numbered) {
      pushParagraph(para)
      const tag = bullet ? 'ul' : 'ol'
      if (!list || list.tag !== tag) {
        closeList()
        list = { tag, items: [] }
      }
      list.items.push((bullet || numbered)[1])
      i++
      continue
    }

    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      pushParagraph(para)
      closeList()
      out.push('<hr/>')
      i++
      continue
    }

    const quote = line.match(/^\s*>\s?(.*)$/)
    if (quote) {
      pushParagraph(para)
      closeList()
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`)
      i++
      continue
    }

    if (!line.trim()) {
      pushParagraph(para)
      closeList()
      i++
      continue
    }

    para.push(line)
    i++
  }

  pushParagraph(para)
  closeList()
  return out.join('\n')
}

export function shortenPath(p, root) {
  if (!p) return ''
  if (root && p.startsWith(root)) {
    const rel = p.slice(root.length).replace(/^\//, '')
    return rel || '.'
  }
  return p.replace(/^\/Users\/[^/]+/, '~')
}

export function basename(p) {
  if (!p) return ''
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

export function formatDuration(ms) {
  if (!ms && ms !== 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

export function formatCost(usd) {
  if (typeof usd !== 'number') return ''
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export function formatTokens(n) {
  if (typeof n !== 'number') return ''
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

const EXT_LANG = {
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'tsx', py: 'python', rb: 'ruby', go: 'go',
  rs: 'rust', java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin', sh: 'bash',
  bash: 'bash', zsh: 'bash', json: 'json', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', md: 'markdown', css: 'css', scss: 'scss', html: 'html',
  xml: 'xml', sql: 'sql', vue: 'vue', svelte: 'svelte', lua: 'lua',
}

export function langForExt(ext) {
  return EXT_LANG[String(ext || '').toLowerCase().replace(/^\./, '')] || ''
}

/** Expand a tool_use input into a compact one-line summary for the card header. */
export function toolSummary(name, input, t) {
  const inp = input || {}
  const tr = t || ((k, v) => {
    const fallbacks = { 'tool.items': '{n} items', 'tool.inPath': '{pattern} in {path}' }
    let s = fallbacks[k] || k
    if (v) for (const [key, val] of Object.entries(v)) s = s.replaceAll(`{${key}}`, String(val))
    return s
  })
  switch (name) {
    case 'Bash':
      return inp.command || ''
    case 'Read':
      return shortenPath(inp.file_path || '')
    case 'Write':
      return shortenPath(inp.file_path || '')
    case 'Edit':
    case 'NotebookEdit':
      return shortenPath(inp.file_path || inp.notebook_path || '')
    case 'Glob':
      return inp.path ? tr('tool.inPath', { pattern: inp.pattern || '', path: shortenPath(inp.path) }) : inp.pattern || ''
    case 'Grep':
      return inp.path ? tr('tool.inPath', { pattern: inp.pattern || '', path: shortenPath(inp.path) }) : inp.pattern || ''
    case 'WebFetch':
      return inp.url || ''
    case 'WebSearch':
      return inp.query || ''
    case 'Task':
      return inp.description || ''
    case 'TodoWrite':
      return tr('tool.items', { n: (inp.todos || []).length })
    default: {
      const first = Object.values(inp).find((v) => typeof v === 'string')
      return first ? first.slice(0, 90) : ''
    }
  }
}

/** Split a string into unified-diff-ish lines for the read-only diff view. */
export function diffLines(oldStr, newStr) {
  const a = String(oldStr ?? '').split('\n')
  const b = String(newStr ?? '').split('\n')
  // Trim the common prefix/suffix, then mark the remainder as changed.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const rows = []
  for (let i = Math.max(0, start - 2); i < start; i++) rows.push({ type: 'ctx', text: a[i], num: i + 1 })
  for (let i = start; i < endA; i++) rows.push({ type: 'del', text: a[i], num: i + 1 })
  for (let i = start; i < endB; i++) rows.push({ type: 'add', text: b[i], num: i + 1 })
  for (let i = endA; i < Math.min(a.length, endA + 2); i++) rows.push({ type: 'ctx', text: a[i], num: i + 1 })
  return { rows, added: endB - start, removed: endA - start }
}
