#!/usr/bin/env node
/**
 * Packages the built .app into a distributable DMG.
 *
 * Builds the image by hand — create a blank image, attach it, copy in, detach,
 * then convert to compressed read-only — rather than with
 * `hdiutil create -srcfolder`. That shortcut fails on this machine with
 * "资源忙" (resource busy) whenever the payload is the real app bundle, while
 * the same steps run individually succeed. Driving each step also lets the
 * volume be detached even when something in the middle throws, which matters
 * because a left-mounted volume is itself what makes the next run report
 * "resource busy".
 *
 * The image ships with a README instead of an installer script on purpose.
 * This app is only ad-hoc signed, and macOS 15 removed the old escape hatch:
 * a quarantined copy can no longer be opened with right-click → Open, so a
 * recipient genuinely needs one `xattr` command. A .command script inside the
 * image cannot do it for them — the script is quarantined too and will not run
 * at all (verified on Darwin 24.6).
 *
 * Worth telling recipients who would rather skip that step: files fetched with
 * curl or git never get the quarantine flag in the first place, so anyone who
 * installs from a source checkout never sees a Gatekeeper prompt.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const arch = process.arch

const app = path.join(root, 'release', `Claude Code-darwin-${arch}`, 'Claude Code.app')
const out = path.join(root, 'release', `Claude Code-${version}-${arch}.dmg`)
const work = path.join(root, 'build', 'dmg-work.dmg')

if (!fs.existsSync(app)) {
  console.error(`no build found at ${app}\nrun: npm run build`)
  process.exit(1)
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}
function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })
}
function capture(cmd, args) {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8' })
}
/** Total bytes under a path. statSync on a directory reports its inode, not
 *  the tree, which is far too small to size a disk image from. */
function dirSize(p) {
  const st = fs.statSync(p)
  if (!st.isDirectory()) return st.size
  let total = 0
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const child = path.join(p, entry.name)
    if (entry.isSymbolicLink()) continue
    total += dirSize(child)
  }
  return total
}

const readme = `Claude Code — 首次打开说明
================================

这个应用没有 Apple 开发者证书签名（那需要每年 99 美元），
所以 macOS 会拦下从浏览器或邮件下载的副本。

解决办法只有一行命令。打开「终端」，粘贴下面这行，回车：

    xattr -dr com.apple.quarantine "/Applications/Claude Code.app"

然后就能正常双击打开了。只需要做一次。

--------------------------------
安装步骤
--------------------------------
1. 把左边的「Claude Code」拖进右边的「Applications」文件夹
2. 打开「终端」（聚焦搜索里输 Terminal 就行）
3. 粘贴上面那条命令，回车
4. 在「应用程序」里双击 Claude Code

注意：从 macOS 15 开始，「右键 → 打开」这个老办法已经失效了，
只能用上面这条命令。如果提示找不到文件，说明你没拖进应用程序
文件夹，把命令里的路径换成你实际放置的位置即可。

--------------------------------
前提条件
--------------------------------
这个应用只是界面外壳，真正干活的是 Claude Code 命令行工具。
使用前你需要先安装并登录：

    npm install -g @anthropic-ai/claude-code
    claude        # 首次运行按提示完成登录

没装 Node.js 的话，先去 https://nodejs.org 装一个 LTS 版本。

--------------------------------
更省事的办法
--------------------------------
如果你会用 git 或 curl，可以完全跳过上面那步。
通过这两个渠道拿到的文件不会被打上隔离标记，
也就不会触发 Gatekeeper：

    git clone <仓库地址>
    cd <仓库目录>
    npm install
    npm run release      # 打包 + 验收 + 自动装进应用程序

================================
English
================================

This app is signed ad-hoc rather than with an Apple Developer
certificate (that costs $99/year), so macOS refuses copies
downloaded through a browser or email. Note that macOS 15 no
longer allows right-click → Open as a workaround.

One command fixes it. Paste this into Terminal:

    xattr -dr com.apple.quarantine "/Applications/Claude Code.app"

You only need to do this once.

To install:
  1. Drag "Claude Code" onto the Applications folder
  2. Open Terminal
  3. Paste the command above and press Return
  4. Launch Claude Code from Applications

Requires the Claude Code CLI, installed and logged in:

    npm install -g @anthropic-ai/claude-code
    claude

Or skip the command entirely — files fetched with git or curl
are not quarantined, so build from source instead:

    git clone <repo> && cd <repo> && npm install && npm run release
`

// --------------------------------------------------------------------- image

rmrf(out)
rmrf(work)

// Room for the bundle plus the readme, with slack for HFS+ overhead. The size
// must come from walking the tree: statSync on a directory reports its inode,
// which would size the image at a few dozen bytes.
const appMB = dirSize(app) / 1024 / 1024
const sizeMB = Math.ceil(appMB * 1.15) + 40

console.log(`\ncreating a ${sizeMB} MB image (app is ${appMB.toFixed(1)} MB)`)
run('hdiutil', ['create', '-size', `${sizeMB}m`, '-volname', 'Claude Code', '-fs', 'HFS+', '-ov', work], {
  stdio: 'ignore',
})

let mountPoint = null
try {
  const attachOut = capture('hdiutil', ['attach', work, '-nobrowse', '-readwrite'])
  // Match to end of line rather than end of string: the output ends with a
  // newline, and without the m flag `$` only matches at the very end.
  mountPoint = (attachOut.match(/\/Volumes\/[^\n]+/) || [])[0]?.trim()
  if (!mountPoint) throw new Error('could not determine the mount point from:\n' + attachOut)
  console.log(`mounted at ${mountPoint}`)

  // ditto preserves the signed bundle's metadata and symlinks; cp -R can break
  // the seal and would flatten the framework links.
  run('ditto', [app, path.join(mountPoint, 'Claude Code.app')])
  fs.writeFileSync(path.join(mountPoint, '首次打开说明 README.txt'), readme)
  fs.symlinkSync('/Applications', path.join(mountPoint, 'Applications'))
} finally {
  // Always detach: a volume left mounted makes the next build report
  // "resource busy" for no visible reason.
  if (mountPoint) {
    try {
      execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'inherit' })
    } catch {
      console.error(`warning: could not detach ${mountPoint} — detach it before rebuilding`)
    }
  }
}

// Compressing a plain image rather than writing UDZO directly keeps the same
// byte layout as the images macOS itself hands out.
console.log('\ncompressing')
run('hdiutil', ['convert', work, '-format', 'UDZO', '-o', out], { stdio: 'ignore' })
rmrf(work)

// ---------------------------------------------------------------- verify

const mounted = capture('hdiutil', ['attach', out, '-nobrowse', '-readonly'])
const dmgMount = (mounted.match(/\/Volumes\/[^\n]+/) || [])[0]?.trim()
if (!dmgMount) throw new Error('could not determine the mount point from:\n' + mounted)
try {
  const contents = fs.readdirSync(dmgMount)
  const expected = ['Claude Code.app', 'Applications', '首次打开说明 README.txt']
  const missing = expected.filter((n) => !contents.includes(n))
  if (missing.length) throw new Error(`image is missing: ${missing.join(', ')}`)

  // The seal has to survive the copy, or recipients get a "damaged" error that
  // looks identical to the Gatekeeper block but cannot be fixed by the same
  // command.
  execFileSync('codesign', ['--verify', path.join(dmgMount, 'Claude Code.app')], { stdio: 'ignore' })

  console.log('\ncontents:')
  for (const n of contents) console.log('  ' + n)
  console.log('signature verified inside the image')
} finally {
  execFileSync('hdiutil', ['detach', dmgMount], { stdio: 'ignore' })
}

const size = (fs.statSync(out).size / 1024 / 1024).toFixed(1)
console.log(`\ndmg: ${out}  (${size} MB, from a ${appMB.toFixed(1)} MB app)`)
console.log('\nrecipients need one command after installing:')
console.log('  xattr -dr com.apple.quarantine "/Applications/Claude Code.app"')
