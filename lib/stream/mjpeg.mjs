/**
 * mjpeg.mjs — multipart/x-mixed-replace 输出器 + 订阅者管理。
 *
 * 职责：
 *   - 一个 MjpegStream 对应一路视频源（屏幕/摄像头各一个实例）；
 *   - 多个手机订阅者共享同一份抓帧（只跑一次 ffmpeg）；
 *   - 背压处理：写不进 socket 的订阅者暂停分发，只保留最新一帧，
 *     drain 后补发最新帧（合并，不堆积）。
 */

/** multipart 分隔符（每路流固定，浏览器只按 boundary 切块） */
export class MjpegStream {
  constructor(boundary = 'dsh-live-frame') {
    this.boundary = boundary
    /** @type {Set<{res, paused: boolean, pending: Buffer|null, drain: Function|null}>} */
    this.subs = new Set()
  }

  get subscriberCount() {
    return this.subs.size
  }

  /**
   * 注册一个 HTTP 响应为订阅者（写入 multipart 响应头）。
   * @param {import('node:http').ServerResponse} res
   */
  add(res) {
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${this.boundary}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    })
    // 立即 flush：源可能尚未出帧（如摄像头无设备），客户端不能一直等响应头
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    const sub = { res, paused: false, pending: null, drain: null }
    this.subs.add(sub)
    const cleanup = () => {
      this.subs.delete(sub)
      if (sub.drain) sub.res.off('drain', sub.drain)
    }
    res.on('close', cleanup)
    res.on('error', cleanup)
    return sub
  }

  /** 广播一帧 JPEG 给所有订阅者。 */
  frame(buf) {
    if (!this.subs.size || !buf || !buf.length) return
    const head = Buffer.from(
      `--${this.boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`,
    )
    const part = Buffer.concat([head, buf, Buffer.from('\r\n')])
    for (const sub of this.subs) this._write(sub, part)
  }

  _write(sub, chunk) {
    if (sub.paused) {
      sub.pending = chunk // 合并：只保留最新一帧
      return
    }
    let ok = true
    try {
      ok = sub.res.write(chunk)
    } catch {
      this.subs.delete(sub)
      return
    }
    if (!ok) {
      sub.paused = true
      sub.pending = null
      sub.drain = () => {
        sub.paused = false
        sub.drain = null
        if (sub.pending) {
          const p = sub.pending
          sub.pending = null
          this._write(sub, p)
        }
      }
      sub.res.once('drain', sub.drain)
    }
  }

  /** 强制结束所有订阅者（服务关闭时）。 */
  endAll() {
    for (const sub of [...this.subs]) {
      try {
        sub.res.end()
      } catch {
        /* 连接已断 */
      }
    }
    this.subs.clear()
  }
}
