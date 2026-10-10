const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

/**
 * Locating the `claude` binary is the one thing that behaves differently in a
 * packaged app. Launched from Finder, macOS gives the process a bare PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin) that does not include the usual npm global
 * bin directories, so a plain spawn('claude') fails even though the CLI is
 * installed and works in a terminal.
 *
 * Resolution order: each known install location, then the user's login shell,
 * then the bare name as a last resort. The result is cached so the shell
 * lookup happens at most once per launch.
 */
let cached = null

function candidatePaths() {
  const home = os.homedir()
  return [
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.bun', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
  ]
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function fromLoginShell() {
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    // -l -i so the shell reads the profile files that set up PATH.
    const out = execFileSync(shell, ['-lic', 'command -v claude'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const found = out.trim().split('\n').pop() || ''
    if (found && isExecutable(found)) return found
  } catch {
    /* shell missing, login files broken, or claude not on PATH */
  }
  return null
}

/** Absolute path to the claude binary, or 'claude' to let spawn search PATH. */
function resolveClaudeBinary({ refresh = false } = {}) {
  if (cached && !refresh) return cached

  for (const p of candidatePaths()) {
    if (isExecutable(p)) {
      cached = p
      return cached
    }
  }

  const viaShell = fromLoginShell()
  if (viaShell) {
    cached = viaShell
    return cached
  }

  cached = 'claude'
  return cached
}

/**
 * PATH for the child process. The CLI shells out to tools like git and node,
 * so the inherited bare PATH is supplemented with the directories that hold
 * them when running from a packaged app.
 */
function childEnv() {
  const home = os.homedir()
  const extra = [
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  const current = (process.env.PATH || '').split(':').filter(Boolean)
  const merged = [...new Set([...current, ...extra])]
  return { ...process.env, PATH: merged.join(':') }
}

module.exports = { resolveClaudeBinary, childEnv }
