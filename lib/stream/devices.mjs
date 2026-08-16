/**
 * devices.mjs — 摄像头/音频设备枚举（ffmpeg dshow -list_devices）。
 *
 * 输出格式（ffmpeg 输出到 stderr）：
 *   [dshow @ ...] DirectShow video devices (some may be both video and audio devices)
 *   [dshow @ ...]  "Integrated Camera"
 *   [dshow @ ...]     Alternative name "@device_pnp_..."
 *   [dshow @ ...] DirectShow audio devices
 *   [dshow @ ...]  "Microphone"
 *
 * 解析策略：定位 "DirectShow video devices" 与 "DirectShow audio devices"
 * 两个节头，节内的 "Name" 行分别归入 video / audio。
 * 结果缓存 30s（枚举本身要起一次 ffmpeg 子进程，约 1~2s）。
 */

import { spawn } from 'node:child_process'

const CACHE_MS = 30_000
const PROBE_TIMEOUT_MS = 8000

let cache = null
let cacheAt = 0

/**
 * 枚举 dshow 视频设备。
 * @param {string} ffmpeg ffmpeg 可执行文件绝对路径
 * @returns {Promise<{ok: boolean, devices: {name:string,type:string}[], error?: string}>}
 */
export async function listVideoDevices(ffmpeg, { force = false } = {}) {
  const now = Date.now()
  if (!force && cache && now - cacheAt < CACHE_MS) return cache
  const result = await probe(ffmpeg)
  cache = result
  cacheAt = now
  return result
}

/** 清空缓存（摄像头插拔后由调用方决定是否强制刷新）。 */
export function clearDeviceCache() {
  cache = null
  cacheAt = 0
}

function probe(ffmpeg) {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, error: error.message, devices: [] })
      return
    }
    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d.toString('utf8')).slice(-256 * 1024)
    })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* 已退出 */
      }
    }, PROBE_TIMEOUT_MS)
    proc.on('close', () => {
      clearTimeout(timer)
      resolve(parseDevices(stderr))
    })
    proc.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: error.message, devices: [] })
    })
  })
}

export function parseDevices(stderr) {
  const devices = []
  let section = null // 'video' | 'audio'
  for (const raw of stderr.split(/\r?\n/)) {
    // 去掉日志前缀（新版 "[in#0 @ ...] " / 旧版 "[dshow @ ...] "）再判断
    const line = raw.replace(/^\[[^\]]+\]\s*/, '')
    if (line.includes('DirectShow video devices')) {
      section = 'video'
      continue
    }
    if (line.includes('DirectShow audio devices')) {
      section = 'audio'
      continue
    }
    // 新版格式（ffmpeg 8.x）："Name" (video|audio|none)
    //   none = 无法判定的设备，按视频处理（摄像头常见）
    const typed = line.match(/^\s*"([^"]+)"\s*\((video|audio|none)\)\s*$/)
    if (typed) {
      devices.push({ name: typed[1], type: typed[2] === 'audio' ? 'audio' : 'video' })
      continue
    }
    // 旧版格式（ffmpeg 7.x 及以前）：节头 + 引号名称行
    //   Alternative name 行以非引号开头，不会被误匹配
    const named = line.match(/^\s*"([^"]+)"\s*$/)
    if (named && section) {
      devices.push({ name: named[1], type: section })
    }
  }
  if (!devices.length && !stderr.includes('DirectShow')) {
    return { ok: false, error: '未能从 ffmpeg 输出解析设备（设备列表仅 Windows/dshow 支持）', devices: [] }
  }
  return { ok: true, devices }
}
