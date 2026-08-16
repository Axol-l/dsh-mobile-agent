// 下载 portable ffmpeg 静态构建（Node 原生 fetch，OpenSSL TLS，无需 winget/choco）。
// 用法：node scripts/download-ffmpeg.mjs
// 产物：tools/ffmpeg/bin/ffmpeg.exe（含 ffprobe.exe）
// 源：gyan.dev essentials（优先）→ BtbN GitHub releases（备选）。
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, 'tools', 'ffmpeg', 'ffmpeg-essentials.zip')
const BIN = join(ROOT, 'tools', 'ffmpeg', 'bin')
mkdirSync(BIN, { recursive: true })

const urls = [
  // gyan.dev essentials（约 80MB，Windows 静态构建）
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  // BtbN GitHub releases（约 90MB）
  'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
]

let saved = false
for (const u of urls) {
  console.log('trying', u)
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 300_000)
    const r = await fetch(u, { redirect: 'follow', signal: ctl.signal })
    if (!r.ok) {
      console.log('  status', r.status)
      clearTimeout(timer)
      continue
    }
    const buf = Buffer.from(await r.arrayBuffer())
    clearTimeout(timer)
    console.log('  got', buf.length, 'bytes')
    if (buf.length > 10 * 1024 * 1024) {
      writeFileSync(TMP, buf)
      saved = true
      break
    }
    console.log('  too small, skip')
  } catch (e) {
    console.log('  fail:', e.name, e.message.slice(0, 120))
  }
}
if (!saved) {
  console.error('ALL SOURCES FAILED —— 请手动下载静态构建并解压，确保 ffmpeg.exe 位于 tools/ffmpeg/bin/')
  process.exit(1)
}

// 解压并提取 bin/ffmpeg.exe + ffprobe.exe 到 tools/ffmpeg/bin/
console.log('extracting…')
execFileSync('powershell', [
  '-NoProfile', '-Command',
  `Expand-Archive -Path '${TMP}' -DestinationPath '${join(ROOT, 'tools', 'ffmpeg')}' -Force`,
], { stdio: 'inherit' })
const { readdirSync, copyFileSync, rmSync } = await import('node:fs')
const inner = readdirSync(join(ROOT, 'tools', 'ffmpeg')).find((n) => n.endsWith('_build') || n.includes('win64'))
if (!inner) {
  console.error('解压产物结构异常，请手动放置 ffmpeg.exe 到 tools/ffmpeg/bin/')
  process.exit(1)
}
const srcBin = join(ROOT, 'tools', 'ffmpeg', inner, 'bin')
for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
  copyFileSync(join(srcBin, exe), join(BIN, exe))
}
rmSync(TMP, { force: true })
rmSync(join(ROOT, 'tools', 'ffmpeg', inner), { recursive: true, force: true })
console.log('OK ->', join(BIN, 'ffmpeg.exe'))
