#!/usr/bin/env node
/**
 * Smoke-tests the packaged .app the way a user actually gets it.
 *
 * Two things matter here and neither is visible from a dev run:
 *   1. The bundle must launch with a bare PATH, the way Finder launches it.
 *      A dev-mode run inherits the terminal PATH and hides this failure.
 *   2. The bundled app must find the `claude` CLI on its own.
 *
 * Checks, in order: bundle layout, no sources leaked in, the binary exists,
 * then a real launch with PATH stripped to the macOS default, driving an
 * actual prompt through the app and reading the reply.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const arch = process.arch
const appPath = path.join(root, 'release', `Claude Code-darwin-${arch}`, 'Claude Code.app')
const exe = path.join(appPath, 'Contents', 'MacOS', 'Claude Code')
const resources = path.join(appPath, 'Contents', 'Resources')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

console.log('verifying ' + appPath + '\n')

// ------------------------------------------------------------------ 1. layout

console.log('bundle layout')
check('bundle exists', fs.existsSync(appPath))
check('executable present', fs.existsSync(exe))
check('app.asar present', fs.existsSync(path.join(resources, 'app.asar')))
check('Info.plist present', fs.existsSync(path.join(appPath, 'Contents', 'Info.plist')))

// ------------------------------------------------------- 2. nothing leaked in

console.log('\nbundle contents (sources must not ship)')
let asarList = ''
try {
  asarList = execFileSync(path.join(root, 'node_modules', '.bin', 'asar'), ['list', path.join(resources, 'app.asar')], {
    encoding: 'utf8',
  })
} catch {
  // asar CLI may be unavailable; fall back to the unpacked dir listing
  try {
    asarList = fs.readdirSync(path.join(resources, 'app.asar.unpacked'), { recursive: true }).join('\n')
  } catch {
    asarList = ''
  }
}

if (asarList) {
  const entries = asarList.split('\n').filter(Boolean)
  check('contains dist/index.html', entries.some((e) => e.includes('dist/index.html')))
  check('contains electron/main.cjs', entries.some((e) => e.endsWith('electron/main.cjs')))
  check('no src/ sources', !entries.some((e) => /(^|\/)src\//.test(e)))
  check('no node_modules', !entries.some((e) => e.includes('node_modules')))
  check('no vite config', !entries.some((e) => e.includes('vite.config')))
  check('no scripts/', !entries.some((e) => /(^|\/)scripts\//.test(e)))
  console.log(`  (${entries.length} entries in app.asar)`)
} else {
  console.log('  SKIP  asar listing unavailable')
}

// ------------------------------------------------------- 3. claude resolvable

console.log('\nclaude CLI discovery (bare PATH, as Finder launches it)')
const bareEnv = {
  HOME: process.env.HOME,
  SHELL: process.env.SHELL || '/bin/zsh',
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  USER: process.env.USER,
  TMPDIR: process.env.TMPDIR || '/tmp',
}

let resolved = null
try {
  resolved = execFileSync(process.execPath, ['-e', `
    const { resolveClaudeBinary } = require(${JSON.stringify(path.join(root, 'electron', 'find-claude.cjs'))});
    process.stdout.write(resolveClaudeBinary());
  `], { encoding: 'utf8', env: bareEnv })
} catch (err) {
  resolved = ''
}
check('resolves claude with bare PATH', !!resolved, resolved || 'not found')
check('resolved path is executable', !!resolved && fs.existsSync(resolved))

// ------------------------------------------------------------ 4. real launch

console.log('\nlaunching the packaged app (PATH stripped)')
const child = spawn(exe, ['--remote-debugging-port=9344'], { env: bareEnv, stdio: ['ignore', 'pipe', 'pipe'] })

let log = ''
child.stdout.on('data', (d) => (log += d))
child.stderr.on('data', (d) => (log += d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForDevtools(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:9344/json/list')
      const list = await res.json()
      if (list.length) return list
    } catch {
      /* not up yet */
    }
    await sleep(700)
  }
  return null
}

async function driveUi() {
  const list = await waitForDevtools()
  if (!list) return { ok: false, reason: 'devtools endpoint never came up' }

  const page = list.find((p) => p.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (m, p) => new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d)
      pending.delete(d.id)
    }
  }
  await new Promise((r) => (ws.onopen = r))
  await send('Runtime.enable')

  const ev = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise })
    return r.result?.result?.value
  }

  // The app opens on the manage screen; the workspace appears once a session
  // starts. Poll rather than sampling once: the devtools endpoint answers
  // before React's first paint, so a single check races the initial render.
  let uiUp = false
  for (let i = 0; i < 30; i++) {
    uiUp = await ev(
      `!!document.querySelector('.app') && (!!document.querySelector('.home') || !!document.querySelector('.composer-input'))`
    )
    if (uiUp) break
    await sleep(500)
  }

  // Navigate the way a user does: pick the project, then open it in the
  // workspace. Calling startAgent over IPC alone would leave the renderer on
  // the manage screen, so no transcript would ever render.
  const rootJson = JSON.stringify(root)
  const picked = await ev(`(() => {
    const row = [...document.querySelectorAll('.proj-row')]
      .find(r => r.getAttribute('title') === ${rootJson});
    if (row) row.click();
    return !!row;
  })()`)
  await sleep(2500)

  const opened = await ev(`(() => {
    const b = document.querySelector('.home-proj-actions .send-btn');
    if (b) b.click();
    return !!b;
  })()`)

  // Fall back to the IPC path if the project is not in the list (a folder with
  // no transcript yet would not have a row).
  if (!picked || !opened) {
    await ev(`window.api.startAgent({cwd:${rootJson}, permissionMode:'acceptEdits'})`, true)
  }

  // Wait for the composer, then send through the app's own IPC.
  for (let i = 0; i < 20; i++) {
    if (await ev(`!!document.querySelector('.composer-input')`)) break
    await sleep(500)
  }
  await sleep(1000)
  await ev(`window.api.sendMessage({text:'Reply with exactly the word PACKAGED and nothing else.'})`, true)

  let reply = ''
  for (let i = 0; i < 45; i++) {
    await sleep(2000)
    reply = (await ev(`[...document.querySelectorAll('.turn--assistant .markdown')].map(e=>e.textContent).join(' ')`)) || ''
    const busy = await ev(`!!document.querySelector('.stop-btn')`)
    if (reply && !busy) break
  }

  const notices = await ev(`JSON.stringify([...document.querySelectorAll('.notice')].map(n => n.textContent))`)
  // The manage screen must also be reachable in the shipped bundle. Presence is
  // not enough: the button lives in the window drag region, where Chromium
  // routes mousedown to the window manager instead of the page, so a control
  // that never opted out of the drag region renders fine and is still dead to
  // real clicks. Assert the property that decides whether it can be clicked.
  const manage = await ev(`(() => {
    const b = document.querySelector('.titlebar-manage')
    if (!b) return JSON.stringify({ present: false })
    const own = getComputedStyle(b).webkitAppRegion
    return JSON.stringify({ present: true, region: own })
  })()`)
  const manageState = JSON.parse(manage || '{"present":false}')
  const manageOk = !!manageState.present && manageState.region === 'no-drag'
  ws.close()
  return { ok: true, uiUp, reply, notices, manageOk, manageState }
}

const result = await driveUi()

check('window rendered', !!result.uiUp)
check('claude responded in packaged app', /PACKAGED/.test(result.reply || ''), (result.reply || '').trim().slice(0, 80))
check(
  'manage button is clickable (not swallowed by the window drag region)',
  !!result.manageOk,
  result.manageState ? `present=${result.manageState.present} app-region=${result.manageState.region}` : ''
)

if (result.notices && result.notices !== '[]') {
  console.log('  notices: ' + result.notices)
  if (/err\.spawn|could not start claude|ENOENT/.test(result.notices)) {
    check('no spawn failure', false, 'the app could not start the claude CLI')
  }
}

try {
  child.kill()
} catch {
  /* already gone */
}

if (log.trim()) {
  console.log('\napp stderr/stdout:')
  console.log(log.split('\n').slice(0, 12).map((l) => '  ' + l).join('\n'))
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
console.log('\ninstall with:  cp -R "' + appPath + '" /Applications/')
process.exit(failures === 0 ? 0 : 1)
