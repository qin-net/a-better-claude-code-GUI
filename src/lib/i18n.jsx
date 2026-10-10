import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

const STORAGE_KEY = 'ccgui.lang'

const en = {
  // titlebar / status
  'titlebar.noFolder': 'no folder open',
  'status.running': 'running',
  'status.stopped': 'stopped',
  'status.idle': 'idle',

  // notices
  'notice.failedStart': 'failed to start Claude',
  'notice.permissionDenied': 'Permission denied: {tool}',
  'notice.aTool': 'a tool',
  'notice.interrupted': 'Turn interrupted.',
  'notice.exited': 'Claude exited with code {code}. Send another message to resume this session.',
  'notice.resumed': 'Resumed session {id} ({turns} prior turns). Earlier messages are not re-rendered.',
  'notice.sendFailed': 'send failed',

  // chat panel
  'suggestion.1': 'Explain what this project does and how it is structured',
  'suggestion.2': 'Find and fix any bugs you can spot in the current changes',
  'suggestion.3': 'Add tests for the most important module here',
  'suggestion.4': 'Summarize the files I have open right now',
  'chat.noSession': 'no session',
  'chat.defaultModel': 'default model',
  'chat.model': 'Model',
  'chat.permissionMode': 'Permission mode',
  'chat.newSession': 'Start a new session',
  'chat.new': '+ new',
  'chat.workingIn': 'Working in {root}',
  'chat.openFolder': 'Open a folder to get started',
  'chat.placeholderBusy': 'Claude is working…',
  'chat.placeholder': 'Ask Claude to build, edit, or explain…',
  'chat.processing': 'working',
  'chat.enterHint': 'Enter to send · Shift+Enter for newline',
  'chat.stop': 'stop',
  'chat.stopTitle': 'Stop the current turn',
  'chat.send': 'send',

  // permission modes
  'mode.acceptEdits': 'accept edits',
  'mode.auto': 'auto',
  'mode.plan': 'plan (read-only)',
  'mode.manual': 'manual',
  'mode.dontAsk': "don't ask",
  'mode.bypassPermissions': 'bypass all',

  // sidebar
  'side.explorer': 'Explorer',
  'side.sessions': 'Sessions',
  'side.openEditors': 'Open editors',
  'side.rescan': 'Rescan folder',
  'side.openFolder': 'Open folder…',
  'side.chooseFolder': 'Choose a folder',
  'side.filter': 'filter files',
  'side.noMatches': 'no matches',
  'side.noSessions': 'no sessions for this folder yet',
  'side.turnsAgo': '{turns} turns · {ago} ago',
  'side.nothingOpen': 'nothing open',

  // editor
  'editor.noFile': 'No file open',
  'editor.noFileSub': 'Pick a file from the explorer, or open one from a tool card.',
  'editor.find': 'find',
  'editor.findTitle': 'Find in file',
  'editor.wrap': 'wrap',
  'editor.wrapTitle': 'Toggle word wrap',
  'editor.lines': '{n} lines',
  'editor.findPlaceholder': 'find in file',
  'editor.lineN': 'line {n}',
  'editor.noMatch': 'no match',
  'editor.loading': 'loading…',
  'editor.truncated': 'preview truncated',

  // messages
  'msg.thinking': 'Thinking…',
  'msg.thought': 'Thought',
  'msg.words': '{n} words',
  'msg.file': 'file',
  'msg.turnFailed': 'Turn failed',
  'msg.steps': '{n} steps',
  'msg.out': 'out {n}',
  'msg.cacheWrite': 'cache+{n}',
  'msg.cacheRead': 'cache {n}',
  'msg.error': 'Error',
  'msg.note': 'Note',
  'msg.collapsed': '{n} earlier turns hidden',

  // tool cards
  'tool.rawInput': 'raw input',
  'tool.error': 'error',
  'tool.output': 'output',
  'tool.noOutput': '(no output)',
  'tool.pattern': 'pattern',
  'tool.path': 'path',
  'tool.glob': 'glob',
  'tool.agent': 'agent',
  'tool.description': 'description',
  'tool.query': 'query',
  'tool.url': 'url',
  'tool.linesInResult': '{n} lines in result',
  'tool.tokens': '{n} tokens',
  'tool.items': '{n} items',
  'tool.inPath': '{pattern} in {path}',

  // markdown / code blocks
  'md.copy': 'copy',
  'md.copied': 'copied',
  'md.text': 'text',
  'md.lines': '{n} lines',
  'md.showMore': 'show {n} more lines',

  // misc
  'session.empty': '(empty session)',

  // errors surfaced from the main process
  'err.noWindow': 'no window',
  'err.agentNotStarted': 'session not started yet',
  'err.spawn': 'could not start claude: {message}',
  'err.process': 'claude process error: {message}',
  'err.notRunning': 'process is not running',
  'err.emptyMessage': 'nothing to send',
  'err.writeFailed': 'write failed: {message}',
  'err.tooLarge': 'file too large to preview (over 2 MB)',

  // language switcher
  'lang.title': 'Language',
}

const zh = {
  'titlebar.noFolder': '未打开文件夹',
  'status.running': '运行中',
  'status.stopped': '已停止',
  'status.idle': '空闲',

  'notice.failedStart': '无法启动 Claude',
  'notice.permissionDenied': '权限被拒绝：{tool}',
  'notice.aTool': '某工具',
  'notice.interrupted': '当前回合已中断。',
  'notice.exited': 'Claude 已退出，退出码 {code}。再发一条消息即可继续本会话。',
  'notice.resumed': '已恢复会话 {id}（此前 {turns} 轮对话）。更早的消息不会重新渲染。',
  'notice.sendFailed': '发送失败',

  'suggestion.1': '讲讲这个项目是做什么的，代码结构是怎样的',
  'suggestion.2': '在当前改动里找出并修复你能发现的 bug',
  'suggestion.3': '给这里最重要的模块补上测试',
  'suggestion.4': '总结一下我现在打开的这些文件',
  'chat.noSession': '未建立会话',
  'chat.defaultModel': '默认模型',
  'chat.model': '模型',
  'chat.permissionMode': '权限模式',
  'chat.newSession': '开始新会话',
  'chat.new': '+ 新建',
  'chat.workingIn': '工作目录：{root}',
  'chat.openFolder': '先打开一个文件夹开始',
  'chat.placeholderBusy': 'Claude 正在干活…',
  'chat.placeholder': '让 Claude 写代码、改文件或解释代码…',
  'chat.processing': '处理中',
  'chat.enterHint': 'Enter 发送 · Shift+Enter 换行',
  'chat.stop': '停止',
  'chat.stopTitle': '中断当前回合',
  'chat.send': '发送',

  'mode.acceptEdits': '接受编辑',
  'mode.auto': '自动',
  'mode.plan': '计划（只读）',
  'mode.manual': '手动确认',
  'mode.dontAsk': '不再询问',
  'mode.bypassPermissions': '跳过所有检查',

  'side.explorer': '资源管理器',
  'side.sessions': '历史会话',
  'side.openEditors': '已打开',
  'side.rescan': '重新扫描目录',
  'side.openFolder': '打开文件夹…',
  'side.chooseFolder': '选择一个文件夹',
  'side.filter': '筛选文件',
  'side.noMatches': '无匹配项',
  'side.noSessions': '这个目录还没有历史会话',
  'side.turnsAgo': '{turns} 轮对话 · {ago}前',
  'side.nothingOpen': '暂无打开的文件',

  'editor.noFile': '未打开文件',
  'editor.noFileSub': '从左侧资源管理器选一个文件，或点开工具卡片里的路径。',
  'editor.find': '查找',
  'editor.findTitle': '在文件中查找',
  'editor.wrap': '换行',
  'editor.wrapTitle': '切换自动换行',
  'editor.lines': '{n} 行',
  'editor.findPlaceholder': '在此文件中查找',
  'editor.lineN': '第 {n} 行',
  'editor.noMatch': '无匹配',
  'editor.loading': '加载中…',
  'editor.truncated': '预览已截断',

  'msg.thinking': '思考中…',
  'msg.thought': '已思考',
  'msg.words': '{n} 字',
  'msg.file': '文件',
  'msg.turnFailed': '回合失败',
  'msg.steps': '{n} 步',
  'msg.out': '输出 {n}',
  'msg.cacheWrite': '缓存写入 {n}',
  'msg.cacheRead': '缓存读取 {n}',
  'msg.error': '错误',
  'msg.note': '提示',
  'msg.collapsed': '已隐藏 {n} 个早前回合',

  'tool.rawInput': '原始输入',
  'tool.error': '错误',
  'tool.output': '输出',
  'tool.noOutput': '（无输出）',
  'tool.pattern': '匹配模式',
  'tool.path': '路径',
  'tool.glob': '文件范围',
  'tool.agent': '子代理',
  'tool.description': '描述',
  'tool.query': '关键词',
  'tool.url': '网址',
  'tool.linesInResult': '结果共 {n} 行',
  'tool.tokens': '{n} tokens',
  'tool.items': '{n} 项任务',
  'tool.inPath': '{pattern} 于 {path}',

  'md.copy': '复制',
  'md.copied': '已复制',
  'md.text': '文本',
  'md.lines': '{n} 行',
  'md.showMore': '展开剩余 {n} 行',

  'session.empty': '（空会话）',

  'err.noWindow': '未找到窗口',
  'err.agentNotStarted': '会话尚未启动',
  'err.spawn': '无法启动 claude：{message}',
  'err.process': 'claude 进程出错：{message}',
  'err.notRunning': '进程未运行',
  'err.emptyMessage': '消息为空',
  'err.writeFailed': '写入失败：{message}',
  'err.tooLarge': '文件过大，无法预览（超过 2 MB）',

  'lang.title': '语言',
}

export const LOCALES = { en, zh }

export const LANG_LABEL = { en: 'English', zh: '中文' }

function detectLang() {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved && LOCALES[saved]) return saved
  return String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function interpolate(template, vars) {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])))
}

const I18nContext = createContext(null)

export function I18nProvider({ children }) {
  const [lang, setLang] = useState(detectLang)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, lang)
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const t = useCallback(
    (key, vars) => {
      const dict = LOCALES[lang] || LOCALES.en
      const template = dict[key] ?? LOCALES.en[key] ?? key
      return interpolate(template, vars)
    },
    [lang]
  )

  const value = useMemo(() => ({ lang, setLang, t }), [lang, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider')
  return ctx
}
