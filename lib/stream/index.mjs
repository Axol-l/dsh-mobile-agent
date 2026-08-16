/**
 * index.mjs — 直播模块入口（模块化：独立目录 + config.live 开关）。
 *
 * 装配：ffmpeg 子进程（Source）→ MjpegStream（分发）→ HTTP 路由。
 * 生命周期：
 *   - 按需启停：有订阅者才启动对应 ffmpeg，全部断开 3s 后自动停止；
 *   - 多订阅者共享同一份抓帧（只跑一次 ffmpeg）；
 *   - config.live.enabled === false 或 ffmpeg 缺失 → 整体 no-op（挂载空路由）。
 *
 * 路由（全部在网关认证之后）：
 *   GET /live              直播页（web/live.html）
 *   GET /live/screen.mjpg  屏幕 MJPEG 流
 *   GET /live/cam.mjpg     摄像头 MJPEG 流
 *   GET /api/live/devices  摄像头/音频设备清单（30s 缓存）
 *   GET /api/live/status   运行状态（订阅数/进程状态/最近帧时间/错误）
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FfmpegSource, buildScreenArgs, buildCameraArgs } from './capture.mjs'
import { MjpegStream } from './mjpeg.mjs'
import { listVideoDevices } from './devices.mjs'

/** 全部订阅者断开后，延迟多久停 ffmpeg（防来回抖动） */
const STOP_DEBOUNCE_MS = 3000
/** 摄像头启动后 N ms 内无任何帧 → 判定失败（触发降档重试/错误上报） */
const CAMERA_FIRST_FRAME_TIMEOUT_MS = 6000

/**
 * @param {object} config 完整配置（含 live 段与 projectRoot）
 * @param {{ onLog?: (level: string, message: string) => void }} [opts]
 * @returns {{ handle(req, res, ctx): boolean, shutdown(): Promise<void> }}
 */
export function createLiveModule(config, { onLog = () => {} } = {}) {
  const live = config.live ?? {}
  if (live.enabled === false) {
    onLog('info', '[live] 已禁用（config.live.enabled=false）')
    return noopModule()
  }

  const ffmpeg = resolve(config.projectRoot, live.ffmpegPath ?? 'tools/ffmpeg/bin/ffmpeg.exe')
  if (!existsSync(ffmpeg)) {
    onLog('warn', `[live] ffmpeg 不存在（${ffmpeg}），直播模块禁用；请放置 portable ffmpeg 或改 config.live.ffmpegPath`)
    return noopModule()
  }

  const screenStream = new MjpegStream('dsh-screen-frame')
  const camStream = new MjpegStream('dsh-cam-frame')

  let screenSource = null
  let camSource = null
  let camDeviceName = null // 实际使用的设备名（config 指定或 auto 解析）
  let camStage = 0 // 0=配置档（按 camera.width 请求分辨率） 1=原生档（设备默认）
  let camError = ''
  let camFirstFrameAt = 0
  let screenStopTimer = null
  let camStopTimer = null

  // ── 屏幕源 ────────────────────────────────────────────────
  function ensureScreen() {
    clearTimeout(screenStopTimer)
    if (screenSource?.isRunning()) return
    if (screenSource) screenSource.removeAllListeners()
    const source = new FfmpegSource({
      ffmpeg,
      args: buildScreenArgs(live),
      kind: 'screen',
      label: '桌面',
    })
    screenSource = source
    source.on('frame', (buf) => screenStream.frame(buf))
    source.on('exit', (code, signal, stderrTail) => {
      if (source.stopping) return // 主动停止，非异常
      onLog('warn', `[live] 屏幕 ffmpeg 退出 code=${code} signal=${signal} ${stderrTail ? `→ ${stderrTail}` : ''}`)
    })
    source.start()
    onLog('info', '[live] 屏幕流已启动')
  }

  function releaseScreen() {
    clearTimeout(screenStopTimer)
    screenStopTimer = setTimeout(() => {
      if (screenStream.subscriberCount === 0) {
        if (screenSource) {
          screenSource.stop()
          screenSource = null
          onLog('info', '[live] 屏幕流已停止（无订阅者）')
        }
      }
    }, STOP_DEBOUNCE_MS)
  }

  // ── 摄像头源（auto 设备解析 + 低档回退） ──────────────────
  async function resolveCameraDevice() {
    const cfg = live.camera?.device
    if (cfg && cfg !== 'auto') return cfg
    const res = await listVideoDevices(ffmpeg)
    const video = res.ok ? res.devices.filter((d) => d.type === 'video') : []
    if (!video.length) {
      camError = res.error || '未找到可用摄像头设备'
      return null
    }
    return video[0].name
  }

  async function ensureCamera() {
    clearTimeout(camStopTimer)
    if (camSource?.isRunning()) return
    camError = ''
    if (!camDeviceName) {
      camDeviceName = await resolveCameraDevice()
    }
    if (!camDeviceName) return
    if (camSource) camSource.removeAllListeners()

    const source = new FfmpegSource({
      ffmpeg,
      args: buildCameraArgs(live, camDeviceName, camStage),
      kind: 'camera',
      label: camDeviceName,
    })
    camSource = source
    camFirstFrameAt = 0
    source.on('frame', (buf) => {
      if (!camFirstFrameAt) {
        camFirstFrameAt = Date.now()
        camError = ''
      }
      camStream.frame(buf)
    })
    source.on('exit', (code, signal, stderrTail) => {
      if (source.stopping) {
        // 主动停止：清引用但不报错
        if (camSource === source) camSource = null
        return
      }
      const msg = stderrTail || `退出码 ${code}`
      onLog('warn', `[live] 摄像头 ffmpeg 退出 code=${code} → ${msg}`)
      if (code !== 0 && camFirstFrameAt === 0 && camStage < 1) {
        // 首帧前失败：分辨率/帧率不兼容 → 降档为原生档重试
        camStage = 1
        if (camSource === source) camSource = null
        onLog('info', '[live] 摄像头降档重试（原生档：设备默认分辨率/帧率）')
        void ensureCamera()
        return
      }
      if (camSource === source) camSource = null
      camError = msg
    })
    source.start()
    onLog('info', `[live] 摄像头流已启动（设备：${camDeviceName}，${camStage === 0 ? '配置档' : '原生档'}）`)

    // 首帧超时判定（进程还活着但没出帧）
    const t = setTimeout(() => {
      if (camSource === source && source.isRunning() && camFirstFrameAt === 0 && !camError) {
        camError = '摄像头无画面（无帧输出）'
        if (camStage < 1) {
          camStage = 1
          source.stop()
          if (camSource === source) camSource = null
          onLog('info', '[live] 摄像头无帧，降档重试（原生档）')
          void ensureCamera()
        }
      }
    }, CAMERA_FIRST_FRAME_TIMEOUT_MS)
    t.unref?.()
  }

  function releaseCamera() {
    clearTimeout(camStopTimer)
    camStopTimer = setTimeout(() => {
      if (camStream.subscriberCount === 0) {
        if (camSource) {
          camSource.stop()
          camSource = null
          onLog('info', '[live] 摄像头流已停止（无订阅者）')
        }
      }
    }, STOP_DEBOUNCE_MS)
  }

  // ── HTTP 路由 ────────────────────────────────────────────
  const LIVE_PAGE = resolve(config.projectRoot, 'web', 'live.html')
  let pageCache = null
  function serveLivePage(res) {
    if (!pageCache) {
      pageCache = readFileSync(LIVE_PAGE, 'utf8')
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(pageCache)
  }

  function statusJson() {
    return {
      ok: true,
      enabled: true,
      ffmpeg,
      screen: {
        running: Boolean(screenSource?.isRunning()),
        subscribers: screenStream.subscriberCount,
      },
      camera: {
        running: Boolean(camSource?.isRunning()),
        subscribers: camStream.subscriberCount,
        device: camDeviceName,
        stage: camStage,
        fallback: camStage > 0,
        error: camError || undefined,
      },
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{ json: (res, status, body) => void }} ctx
   * @returns {boolean} 是否已处理
   */
  function handle(req, res, ctx) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (req.method === 'GET' && path === '/live') {
      serveLivePage(res)
      return true
    }
    if (req.method === 'GET' && path === '/live/screen.mjpg') {
      screenStream.add(res)
      ensureScreen()
      res.on('close', releaseScreen)
      return true
    }
    if (req.method === 'GET' && path === '/live/cam.mjpg') {
      camStream.add(res)
      void ensureCamera()
      res.on('close', releaseCamera)
      return true
    }
    if (req.method === 'GET' && path === '/api/live/devices') {
      void listVideoDevices(ffmpeg).then((r) => ctx.json(res, 200, { ok: r.ok, devices: r.devices, error: r.error }))
      return true
    }
    if (req.method === 'GET' && path === '/api/live/status') {
      ctx.json(res, 200, statusJson())
      return true
    }
    return false
  }

  async function shutdown() {
    if (screenSource) {
      screenSource.stop()
      screenSource = null
    }
    if (camSource) {
      camSource.stop()
      camSource = null
    }
    screenStream.endAll()
    camStream.endAll()
  }

  return { handle, shutdown }
}

function noopModule() {
  return {
    handle: () => false,
    shutdown: async () => {},
  }
}
