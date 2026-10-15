import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/editor.all.js'
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution'
// Bundling the worker inline keeps Monaco functional under the file:// protocol
// the packaged app loads from, where a separate worker chunk would not resolve.
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker&inline'

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

let themeReady = false
function ensureTheme() {
  if (themeReady) return
  themeReady = true
  monaco.editor.defineTheme('ccgui', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6a6a72', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c586c0' },
      { token: 'string', foreground: 'ce9178' },
      { token: 'number', foreground: 'b5cea8' },
      { token: 'type', foreground: '4ec9b0' },
      { token: 'function', foreground: 'dcdcaa' },
      { token: 'variable', foreground: '9cdcfe' },
    ],
    colors: {
      'editor.background': '#1b1b1f',
      'editor.foreground': '#d8d8dc',
      'editorLineNumber.foreground': '#4a4a52',
      'editorLineNumber.activeForeground': '#8d8d95',
      'editor.selectionBackground': '#2f4f6f88',
      'editor.lineHighlightBackground': '#ffffff08',
      'editorCursor.foreground': '#d97757',
      'editorIndentGuide.background1': '#2b2b30',
      'editorGutter.background': '#1b1b1f',
      'editorWidget.background': '#202024',
      'editorWidget.border': '#2b2b30',
      'scrollbarSlider.background': '#3a3a4180',
    },
  })
}

/**
 * Monaco wrapper. One text model is kept per file path so undo history and
 * cursor position survive tab switches; the editor just swaps models.
 */
export default function CodeEditor({ path, content, language, onChange, onSaveRequest }) {
  const hostRef = useRef(null)
  const editorRef = useRef(null)
  const modelsRef = useRef(new Map())
  const applyingRef = useRef(false)

  // The editor and its key bindings are created once, so anything registered
  // inside that effect would keep calling the callbacks from the first render.
  // For save that is not merely stale — the first render's save callback still
  // closes over the buffer as it was loaded from disk, so Cmd+S would write the
  // original text back over the user's edits. Route both through refs that are
  // refreshed every render.
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSaveRequest)
  onChangeRef.current = onChange
  onSaveRef.current = onSaveRequest

  // Monaco paints view lines inside an animation frame. Chromium freezes rAF
  // while the document is hidden, so an editor mounted in a background or
  // occluded window keeps an empty view layer until something else forces a
  // repaint. layout() runs synchronously and renders immediately, so it is
  // called after every mount and model swap, and again when the window
  // becomes visible.
  const relayout = () => {
    const editor = editorRef.current
    if (!editor || !hostRef.current) return
    const rect = hostRef.current.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) editor.layout()
  }

  // create the editor once
  useEffect(() => {
    ensureTheme()
    const editor = monaco.editor.create(hostRef.current, {
      theme: 'ccgui',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12.5,
      lineHeight: 19,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, monospace",
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      smoothScrolling: true,
      tabSize: 2,
      wordWrap: 'off',
      padding: { top: 10, bottom: 40 },
      scrollbar: { verticalScrollbarSize: 11, horizontalScrollbarSize: 11 },
    })
    editorRef.current = editor
    relayout()

    const sub = editor.onDidChangeModelContent(() => {
      if (applyingRef.current) return
      const model = editor.getModel()
      if (!model) return
      onChangeRef.current(model.uri.path.slice(1), model.getValue())
    })

    // Cmd/Ctrl+S is routed to the app rather than Monaco's default
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const model = editor.getModel()
      if (model) onSaveRef.current(model.uri.path.slice(1))
    })

    return () => {
      sub.dispose()
      editor.dispose()
      for (const m of modelsRef.current.values()) m.dispose()
      modelsRef.current.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Swap the model only when the file changes. Switching on content too would
  // call setModel on every keystroke, and setModel resets the cursor and
  // selection — which makes the editor effectively untypeable.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !path) return
    let model = modelsRef.current.get(path)
    if (!model) {
      model = monaco.editor.createModel(content ?? '', language || 'plaintext', monaco.Uri.file(path))
      modelsRef.current.set(path, model)
    }
    applyingRef.current = true
    editor.setModel(model)
    applyingRef.current = false
    editor.focus()
    relayout()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // pull in external changes (disk reload, conflict resolution) without
  // clobbering the cursor when the text already matches
  useEffect(() => {
    if (!path) return
    const model = modelsRef.current.get(path)
    if (!model) return
    if (model.getValue() === (content ?? '')) return
    applyingRef.current = true
    const pos = editorRef.current?.getPosition()
    model.setValue(content ?? '')
    if (pos) editorRef.current.setPosition(pos)
    applyingRef.current = false
    relayout()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, content])

  // A window that starts hidden (or gets occluded) has no animation frames, so
  // a model swapped in during that time is never painted. Re-run the layout
  // once it is visible again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      relayout()
      // the first layout can land before the view regains its height
      requestAnimationFrame(() => relayout())
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    onVisible()
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="mono-host" ref={hostRef} />
}
