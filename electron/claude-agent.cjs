const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { resolveClaudeBinary, childEnv } = require('./find-claude.cjs')

/**
 * Wraps one `claude` subprocess in --print + stream-json mode.
 *
 * The CLI speaks newline-delimited JSON both ways:
 *   stdin  <- {"type":"user","message":{...}}
 *   stdout -> system/assistant/user/stream_event/result records
 *
 * Partial-message deltas are coalesced here and flushed on a timer so the
 * renderer gets a readable render rate instead of one IPC hop per token.
 */
class ClaudeAgent {
  constructor(opts, hooks) {
    this.cwd = opts.cwd || process.cwd()
    this.model = opts.model || ''
    this.permissionMode = opts.permissionMode || 'acceptEdits'
    this.resumeId = opts.resumeId || ''
    this.extraArgs = Array.isArray(opts.extraArgs) ? opts.extraArgs : []
    this.onEvent = hooks.onEvent || (() => {})
    this.onExit = hooks.onExit || (() => {})

    this.proc = null
    this.buf = ''
    this.sessionId = this.resumeId || ''
    this.busy = false

    // streaming accumulation
    this.blocks = new Map()   // index -> block
    this.dirty = false
    this.flushTimer = null
  }

  start() {
    if (this.proc) return { ok: true, sessionId: this.sessionId }

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ]
    if (this.model) args.push('--model', this.model)
    if (this.permissionMode) args.push('--permission-mode', this.permissionMode)
    if (this.resumeId) args.push('--resume', this.resumeId)
    args.push(...this.extraArgs)

    try {
      this.proc = spawn(resolveClaudeBinary(), args, {
        cwd: this.cwd,
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      return { ok: false, errorKey: 'err.spawn', detail: err.message }
    }
    // Intent lives on the process object: an exit event can arrive after a
    // later start() has already reset the shared field.
    const proc = this.proc
    proc._intentional = false

    proc.on('error', (err) => {
      this.onEvent({ kind: 'error', errorKey: 'err.process', detail: err.message })
    })

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => this.onStdout(chunk))

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim()
      if (text) this.onEvent({ kind: 'stderr', text })
    })

    proc.on('exit', (code, signal) => {
      if (this.proc === proc) this.proc = null
      this.flush()
      this.busy = false
      this.onEvent({ kind: 'status', state: 'stopped' })
      this.onExit({ code, signal, sessionId: this.sessionId, intentional: proc._intentional })
    })

    return { ok: true, sessionId: this.sessionId }
  }

  send({ text, images }) {
    if (!this.proc) return { ok: false, errorKey: 'err.notRunning' }
    const content = []
    if (text) content.push({ type: 'text', text })
    for (const img of images || []) content.push(img)
    if (!content.length) return { ok: false, errorKey: 'err.emptyMessage' }

    const envelope = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.sessionId || undefined,
    }
    try {
      this.proc.stdin.write(JSON.stringify(envelope) + '\n')
    } catch (err) {
      return { ok: false, errorKey: 'err.writeFailed', detail: err.message }
    }
    this.busy = true
    this.blocks.clear()
    this.onEvent({ kind: 'status', state: 'running' })
    return { ok: true }
  }

  interrupt() {
    if (!this.proc) return
    // --print mode has no interactive interrupt channel; recycle the process
    // and let the caller resume by session id on the next turn.
    this.onEvent({ kind: 'status', state: 'interrupted' })
    this.restart()
  }

  restart() {
    const sessionId = this.sessionId
    this.stopSilently()
    this.resumeId = sessionId
    this.start()
  }

  stopSilently() {
    const proc = this.proc
    if (!proc) return
    proc._intentional = true
    try {
      proc.stdin.end()
      proc.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    this.proc = null
  }

  stop() {
    this.stopSilently()
  }

  // ------------------------------------------------------------- stream parse

  onStdout(chunk) {
    this.buf += chunk
    let idx
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        this.onEvent({ kind: 'stderr', text: line.slice(0, 400) })
        continue
      }
      this.handleRecord(rec)
    }
  }

  handleRecord(rec) {
    switch (rec.type) {
      case 'system':
        return this.handleSystem(rec)
      case 'assistant':
        return this.handleAssistant(rec)
      case 'user':
        return this.handleUser(rec)
      case 'result':
        return this.handleResult(rec)
      case 'stream_event':
        return this.handleStreamEvent(rec.event)
      case 'control_request':
        // Nothing is expected here in --print mode, but never let the CLI
        // block waiting on a reply.
        this.replyControl(rec)
        return
      default:
        return
    }
  }

  handleSystem(rec) {
    if (rec.subtype === 'init') {
      this.sessionId = rec.session_id || this.sessionId
      this.onEvent({
        kind: 'init',
        sessionId: this.sessionId,
        cwd: rec.cwd,
        model: rec.model,
        tools: rec.tools || [],
        permissionMode: rec.permissionMode,
        slashCommands: rec.slash_commands || [],
        version: rec.claude_code_version,
      })
      return
    }
    if (rec.subtype === 'status') {
      this.onEvent({ kind: 'status', state: 'running', label: rec.status })
    }
  }

  handleAssistant(rec) {
    this.flush()
    const content = rec.message?.content || []
    for (const block of content) {
      if (block.type === 'thinking' && !block.thinking) continue
      this.onEvent({ kind: 'block', block: this.normalizeBlock(block), messageId: rec.message?.id })
    }
    if (rec.message?.usage) {
      this.onEvent({ kind: 'usage', usage: rec.message.usage })
    }
  }

  handleUser(rec) {
    this.flush()
    const content = rec.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type === 'tool_result') {
        this.onEvent({
          kind: 'tool_result',
          toolUseId: block.tool_use_id,
          content: this.flattenToolResult(block.content),
          isError: !!block.is_error,
        })
      }
    }
  }

  handleResult(rec) {
    this.flush()
    this.busy = false
    this.onEvent({
      kind: 'result',
      subtype: rec.subtype,
      isError: !!rec.is_error,
      result: typeof rec.result === 'string' ? rec.result : '',
      costUsd: rec.total_cost_usd,
      durationMs: rec.duration_ms,
      durationApiMs: rec.duration_api_ms,
      numTurns: rec.num_turns,
      usage: rec.usage,
      modelUsage: rec.modelUsage,
      sessionId: rec.session_id,
      denials: rec.permission_denials || [],
    })
  }

  handleStreamEvent(ev) {
    if (!ev) return
    switch (ev.type) {
      case 'message_start':
        this.flush()
        this.blocks.clear()
        this.onEvent({ kind: 'message_start', messageId: ev.message?.id })
        if (ev.message?.usage) this.onEvent({ kind: 'usage', usage: ev.message.usage })
        return
      case 'content_block_start': {
        const block = { ...ev.content_block }
        if (block.type === 'tool_use') block._partialJson = ''
        if (block.type === 'text') block.text = ''
        if (block.type === 'thinking') block.thinking = ''
        this.blocks.set(ev.index, block)
        this.markDirty()
        return
      }
      case 'content_block_delta': {
        const block = this.blocks.get(ev.index)
        if (!block) return
        const d = ev.delta || {}
        if (d.type === 'text_delta') block.text = (block.text || '') + d.text
        else if (d.type === 'thinking_delta') block.thinking = (block.thinking || '') + d.thinking
        else if (d.type === 'input_json_delta') block._partialJson += d.partial_json || ''
        else if (d.type === 'signature_delta') return
        this.markDirty()
        return
      }
      case 'content_block_stop': {
        const block = this.blocks.get(ev.index)
        if (block && block.type === 'tool_use' && block._partialJson) {
          try {
            block.input = JSON.parse(block._partialJson)
          } catch {
            /* leave partial input unparsed */
          }
          delete block._partialJson
        }
        this.markDirty()
        return
      }
      case 'message_stop':
        this.flush()
        return
      default:
        return
    }
  }

  normalizeBlock(block) {
    if (block.type === 'tool_use') {
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
    }
    if (block.type === 'text') return { type: 'text', text: block.text }
    if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking }
    if (block.type === 'redacted_thinking') return { type: 'thinking', thinking: '[redacted]' }
    return block
  }

  flattenToolResult(content) {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c.type === 'text') return c.text
        if (c.type === 'image') return '[image]'
        return JSON.stringify(c)
      })
      .join('\n')
  }

  replyControl(rec) {
    if (!this.proc || !rec.request_id) return
    const reply = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: rec.request_id,
        response: rec.request?.subtype === 'can_use_tool'
          ? { behavior: 'allow', updatedInput: rec.request.input }
          : {},
      },
    }
    try {
      this.proc.stdin.write(JSON.stringify(reply) + '\n')
    } catch {
      /* process gone */
    }
  }

  // ------------------------------------------------------------ delta flushing

  markDirty() {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, 60)
  }

  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.dirty) return
    this.dirty = false
    const blocks = []
    for (const [index, block] of [...this.blocks.entries()].sort((a, b) => a[0] - b[0])) {
      const normalized = { ...this.normalizeBlock(block), index }
      // A block that has started but produced nothing yet is noise in the UI.
      if (normalized.type === 'text' && !normalized.text) continue
      if (normalized.type === 'thinking' && !normalized.thinking) continue
      blocks.push(normalized)
    }
    if (blocks.length) this.onEvent({ kind: 'partial', blocks })
  }
}

module.exports = { ClaudeAgent, randomUUID }
