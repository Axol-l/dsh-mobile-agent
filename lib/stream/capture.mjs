/**
 * capture.mjs — 帧捕获源抽象 + ffmpeg 子进程管理。
 *
 * 模块化设计：所有捕获后端实现同一个 Source 接口，切换/新增后端
 * （PowerShell、MediaFoundation、OBS 虚拟摄像头…）不需要改上层逻辑。
 *
 * Source 接口（EventEmitter）：
 *   kind: string      'screen' | 'camera'（用于日志/状态）
 *   label: string     人类可读名称
 *   start()           启动捕获（幂等）
 *   stop()            停止捕获（幂等；向 ffmpeg 发 'q' 优雅退出，超时强杀）
 *   isRunning(): bool
 *   事件：
 *     'frame' (Buffer)  一帧完整 JPEG
 *     'exit'  (code, signal, stderrTail)  ffmpeg 进程退出
 *     'error' (Error)   spawn 失败（如 ffmpeg 不存在）
 *
 * ffmpeg 命令约定（两种源统一输出）：
 *   -f mjpeg pipe:1  → stdout 连续 JPEG 帧流，按 0xFFD8/0xFFD9 边界切帧
 *   -loglevel error  → stderr 只出现真正的错误
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

/** 帧缓冲上限：防单个未闭合帧无限增长导致内存失控 */
const MAX_PENDING = 16 * 1024 * 1024
/** stderr 保留上限（错误上报用） */
const MAX_STDERR = 32 * 1024
/** 发 'q' 后强杀宽限（ms） */
const STOP_GRACE_MS = 1500

/**
 * 从累积字节流中切出完整 JPEG 帧。
 * @param {Buffer} buf
 * @returns {{ frames: Buffer[], remainder: Buffer }}
 */
export function splitJpeg(buf) {
  const frames = []
  const len = buf.length
  let i = 0
  while (i < len - 1) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8) {
      // 找到 SOI，向后找 EOI
      let end = -1
      for (let j = i + 2; j < len - 1; j++) {
        if (buf[j] === 0xff && buf[j + 1] === 0xd9) {
          end = j + 2
          break
        }
      }
      if (end < 0) break // 帧未完整，等待更多数据（从 SOI 处保留）
      frames.push(buf.subarray(i, end))
      i = end
    } else {
      i++
    }
  }
  return { frames, remainder: buf.subarray(i) }
}

/** 构建 gdigrab 屏幕捕获的 ffmpeg 参数。 */
export function buildScreenArgs(live) {
  const s = live.screen ?? {}
  const fps = Number.isSafeInteger(s.fps) && s.fps > 0 ? s.fps : 5
  const width = Number.isSafeInteger(s.width) && s.width > 0 ? s.width : 1280
  const quality = Number.isSafeInteger(s.quality) && s.quality >= 2 && s.quality <= 31 ? s.quality : 5
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'gdigrab',
    '-framerate', String(fps),
    '-i', 'desktop',
    '-vf', `scale=${width}:-2`,
    '-q:v', String(quality),
    '-pix_fmt', 'yuvj420p',
    '-an',
    '-f', 'mjpeg',
    'pipe:1',
  ]
}

/**
 * 构建 dshow 摄像头捕获的 ffmpeg 参数（deviceName 作为数组元素传入，无 shell 注入面）。
 *
 * 兼容性策略（重要）：不少摄像头只支持固定分辨率/帧率（如仅 1920x1080@30），
 * 强制 -video_size/-framerate 会直接打不开（"Could not set video options"）。
 * 因此分两档：
 *   stage 0（配置档）：按 camera.width 请求分辨率，不设帧率；
 *   stage 1（原生档）：完全不指定分辨率/帧率，由 dshow 协商设备默认。
 * 输出统一用 fps,scale 滤镜控制帧率与宽度，保证带宽可控。
 */
export function buildCameraArgs(live, deviceName, stage = 0) {
  const c = live.camera ?? {}
  const fps = Number.isSafeInteger(c.fps) && c.fps > 0 ? c.fps : 10
  const width = Number.isSafeInteger(c.width) && c.width > 0 ? c.width : 640
  const quality = Number.isSafeInteger(c.quality) && c.quality >= 2 && c.quality <= 31 ? c.quality : 5
  const height = Math.max(240, Math.round(width * 3 / 4))
  const input = stage === 0
    ? ['-f', 'dshow', '-video_size', `${width}x${height}`, '-i', `video=${deviceName}`]
    : ['-f', 'dshow', '-i', `video=${deviceName}`]
  return [
    '-hide_banner', '-loglevel', 'error',
    ...input,
    '-vf', `fps=${fps},scale=${width}:-2`,
    '-q:v', String(quality),
    '-pix_fmt', 'yuvj420p',
    '-an',
    '-f', 'mjpeg',
    'pipe:1',
  ]
}

/**
 * ffmpeg 帧源：封装一个 ffmpeg 子进程，产出 'frame' 事件。
 */
export class FfmpegSource extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.ffmpeg  ffmpeg 可执行文件绝对路径
   * @param {string[]} opts.args  命令行参数（数组，不经 shell）
   * @param {string} opts.kind    'screen' | 'camera'
   * @param {string} opts.label   显示名
   */
  constructor({ ffmpeg, args, kind, label }) {
    super()
    this.ffmpeg = ffmpeg
    this.args = args
    this.kind = kind
    this.label = label
    this.proc = null
    this.buffer = Buffer.alloc(0)
    /** 是否处于优雅停止中（stop() 已调用）；exit 事件据此区分"主动停"与"异常退" */
    this.stopping = false
  }

  isRunning() {
    return this.proc !== null
  }

  start() {
    if (this.proc) return
    this.buffer = Buffer.alloc(0)
    let proc
    try {
      proc = spawn(this.ffmpeg, this.args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.emit('error', error)
      return
    }
    this.proc = proc

    proc.stdout.on('data', (chunk) => this._onData(chunk))

    let stderr = ''
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR)
    })

    proc.on('error', (error) => {
      if (this.proc === proc) this.proc = null
      this.emit('error', error)
    })

    proc.on('exit', (code, signal) => {
      if (this.proc === proc) this.proc = null
      this.emit('exit', code, signal, stderr.trim())
    })
  }

  /** 优雅停止：'q' 让 ffmpeg 自行收尾，超时强杀。 */
  stop() {
    const proc = this.proc
    if (!proc) return
    this.stopping = true
    this.proc = null
    this.buffer = Buffer.alloc(0)
    try {
      proc.stdin.write('q')
    } catch {
      /* stdin 已关闭则直接走强杀 */
    }
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* 进程已退出 */
      }
    }, STOP_GRACE_MS)
    proc.once('exit', () => clearTimeout(timer))
  }

  _onData(chunk) {
    if (!this.buffer.length) {
      this.buffer = chunk
    } else {
      this.buffer = this.buffer.length + chunk.length > MAX_PENDING
        ? Buffer.concat([this.buffer, chunk]).subarray(-MAX_PENDING)
        : Buffer.concat([this.buffer, chunk])
    }
    const { frames, remainder } = splitJpeg(this.buffer)
    this.buffer = remainder
    for (const frame of frames) this.emit('frame', frame)
  }
}
