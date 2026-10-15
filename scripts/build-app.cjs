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

// The icon is a build input, not a source asset: render it from the script so
// the .icns never drifts from what make-icon.swift draws. Cache the compiled
// generator in build/ so repeat builds skip the ~4s swiftc step.
const iconSrc = path.join(root, 'scripts', 'make-icon.swift')
const iconGen = path.join(root, 'build', 'make-icon')
const iconPng = path.join(root, 'build', 'icon.png')
// Must end in .icns: electron-packager treats any other extension as a raster
// it has to convert, and silently falls back to the default Electron icon.
const iconIcns = path.join(root, 'build', 'icon.icns')

function buildIcon() {
  fs.mkdirSync(path.join(root, 'build'), { recursive: true })
  if (fs.existsSync(iconIcns) && fs.statSync(iconIcns).mtimeMs >= fs.statSync(iconSrc).mtimeMs) {
    return iconIcns
  }

  if (!fs.existsSync(iconGen) || fs.statSync(iconGen).mtimeMs < fs.statSync(iconSrc).mtimeMs) {
    run('swiftc', ['-O', iconSrc, '-o', iconGen])
  }
  run(iconGen, [iconPng])

  const iconset = path.join(root, 'build', 'AppIcon.iconset')
  rmrf(iconset)
  fs.mkdirSync(iconset, { recursive: true })
  const entries = [
    ['icon_16x16', 16], ['icon_16x16@2x', 32],
    ['icon_32x32', 32], ['icon_32x32@2x', 64],
    ['icon_128x128', 128], ['icon_128x128@2x', 256],
    ['icon_256x256', 256], ['icon_256x256@2x', 512],
    ['icon_512x512', 512], ['icon_512x512@2x', 1024],
  ]
  for (const [name, px] of entries) {
    run('sips', ['-z', String(px), String(px), iconPng, '--out', path.join(iconset, name + '.png')], { stdio: 'ignore' })
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', iconIcns])
  rmrf(iconset)
  return iconIcns
}

const iconPath = buildIcon()

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
  `--icon=${iconPath}`,
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

// ---------------------------------------------------------------- 4. signing
//
// The packager leaves a linker-signed binary while rewriting the bundle, which
// invalidates the seal: Gatekeeper reports "code has no resources but signature
// indicates they must be present" and macOS treats the app as damaged. An
// ad-hoc signature over the finished bundle restores a valid seal so it launches
// from Finder without a developer certificate.
console.log('\nsigning (ad-hoc)')
run('codesign', ['--force', '--deep', '--sign', '-', appPath])
run('codesign', ['--verify', '--verbose=2', appPath])

console.log('\nbuilt: ' + appPath)
console.log('\nnext:  npm run verify  (launches it and checks the claude CLI is found)')
