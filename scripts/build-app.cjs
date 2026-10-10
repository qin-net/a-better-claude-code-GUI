#!/usr/bin/env node
/**
 * Builds a production .app bundle.
 *
 * The released app must not contain sources, dev config, or node_modules — the
 * renderer is already bundled into dist/ and the main process is plain CJS that
 * only uses Node built-ins. So this stages exactly the runtime files into
 * build/app and hands that to electron-packager, which means the bundle is
 * reproducible and nothing accidentally ships.
 *
 * Requires ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ on this
 * machine: the packager resolves the Electron zip by a hash of its download
 * URL, so a GitHub URL misses the cache that the npmmirror install populated
 * and the build hangs trying to reach GitHub Releases.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const stage = path.join(root, 'build', 'app')
const out = path.join(root, 'release')

// @electron/get keys its cache on the download URL, so a mirror-populated cache
// is invisible to the packager unless it asks for the same URL. Default to the
// mirror that npm install used; override with ELECTRON_MIRROR to build from
// GitHub instead.
if (!process.env.ELECTRON_MIRROR) {
  process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  console.log('using ELECTRON_MIRROR=' + process.env.ELECTRON_MIRROR)
}

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dest)
    else fs.copyFileSync(src, dest)
  }
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}

// ---------------------------------------------------------------- 1. renderer

run('npx', ['vite', 'build'])

const distDir = path.join(root, 'dist')
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error('\ndist/index.html missing — vite build did not produce a bundle.')
  process.exit(1)
}

// ----------------------------------------------------------------- 2. staging

rmrf(stage)
fs.mkdirSync(stage, { recursive: true })

copyDir(path.join(root, 'electron'), path.join(stage, 'electron'))
copyDir(distDir, path.join(stage, 'dist'))

const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const appPkg = {
  name: rootPkg.name,
  productName: 'Claude Code',
  version: rootPkg.version,
  description: rootPkg.description,
  main: 'electron/main.cjs',
  type: 'commonjs',
  author: rootPkg.author,
}
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(appPkg, null, 2) + '\n')

console.log('\nstaged runtime files:')
for (const f of fs.readdirSync(stage, { recursive: true })) {
  console.log('  ' + f)
}

// ---------------------------------------------------------------- 3. packaging

const pkg = require(path.join(root, 'node_modules', '@electron', 'packager', 'package.json'))
console.log(`\nusing @electron/packager ${pkg.version}`)

rmrf(out)
run('npx', [
  'electron-packager',
  stage,
  'Claude Code',
  '--platform=darwin',
  `--arch=${process.arch}`,
  `--out=${path.relative(root, out)}`,
  `--electron-version=${require(path.join(root, 'node_modules', 'electron', 'package.json')).version}`,
  '--app-bundle-id=com.local.claudecode.gui',
  '--app-version=' + rootPkg.version,
  '--overwrite',
  '--prune=true',
  // Bundle the app into app.asar instead of leaving the sources as loose files
  // under Contents/Resources/app.
  '--asar',
  '--quiet',
])

const appPath = path.join(out, 'Claude Code-darwin-' + process.arch, 'Claude Code.app')
if (!fs.existsSync(appPath)) {
  console.error('\npackaging finished but the .app was not found at ' + appPath)
  process.exit(1)
}

console.log('\nbuilt: ' + appPath)
console.log('\nnext:  npm run verify  (launches it and checks the claude CLI is found)')
