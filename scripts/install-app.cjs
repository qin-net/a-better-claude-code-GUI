#!/usr/bin/env node
/**
 * Installs the built .app into /Applications.
 *
 * Finder is the intended entry point for this app, so the copy has to land as a
 * normal bundle in /Applications rather than being run out of release/. The
 * copy uses `ditto` instead of `cp -R`: it preserves the code signature's
 * resource forks and extended attributes exactly, whereas cp -R can leave the
 * bundle with a broken seal on macOS.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const built = path.join(
  root,
  'release',
  `Claude Code-darwin-${process.arch}`,
  'Claude Code.app'
)
const target = '/Applications/Claude Code.app'

if (!fs.existsSync(built)) {
  console.error(`no build found at ${built}\nrun: npm run build`)
  process.exit(1)
}

// A running instance holds its bundle open, and replacing the directory under
// it makes the next launch load a half-copied app. Ask it to quit first.
try {
  execFileSync('pkill', ['-f', 'Claude Code.app/Contents/MacOS'], { stdio: 'ignore' })
  console.log('quit the running instance (if any)')
  // give the process a moment to release its files
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200)
} catch {
  /* nothing was running */
}

if (fs.existsSync(target)) {
  fs.rmSync(target, { recursive: true, force: true })
}

console.log(`\n$ ditto "${built}" "${target}"`)
execFileSync('ditto', [built, target], { stdio: 'inherit' })

// Verify the copy is intact and launchable rather than trusting the exit code.
const plist = path.join(target, 'Contents', 'Info.plist')
const binary = path.join(target, 'Contents', 'MacOS', 'Claude Code')
if (!fs.existsSync(plist) || !fs.existsSync(binary)) {
  console.error('\nthe installed bundle is missing its Info.plist or executable')
  process.exit(1)
}
fs.chmodSync(binary, 0o755)

try {
  execFileSync('codesign', ['--verify', target], { stdio: 'ignore' })
  console.log('signature verified after install')
} catch {
  console.error('warning: the installed copy does not verify — Gatekeeper may complain')
}

console.log(`\ninstalled: ${target}`)
console.log('open it from Finder, or:  open "/Applications/Claude Code.app"')
