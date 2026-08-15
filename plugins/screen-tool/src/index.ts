/**
 * screen-tool — DeepSeek Harness 屏幕监视工具插件（Windows）。
 *
 * 给 agent 提供两个工具：
 *   - `screenshot`：抓取本机桌面（所有显示器）或指定窗口，把图片作为
 *     ImageBlock 返回（与 read_image 相同的持久化附件机制），图片会进入
 *     会话历史并在 GUI 中显示，模型也能在后续请求中"看到"屏幕内容。
 *   - `list_windows`：枚举可见顶层窗口（标题 + hwnd），供模型选择目标窗口。
 *
 * 实现要点：
 *   - 零运行时依赖：不 import 任何 @deepseek-ai/* 包（类型导入在编译时
 *     擦除），服务通过 `inject: ['tools', 'attachments', 'llm']` 按名注入，
 *     因此插件文件可以放在仓库外的任何位置，由 --patch 加载。
 *   - 截图引擎是 capture.ps1（PowerShell 5.1 + System.Drawing，Win32
 *     API），插件用 child_process 调用，stdout 单行 JSON 通信。
 *   - 图片先经 ctx.attachments.saveImage() 持久化（内容寻址、校验），再
 *     作为 ImageBlock 进入工具结果；同时归档一份到 <DSH_HOME>/screenshots/。
 *   - 与 read_image 一致：include_image 开启时校验当前模型路由声明了
 *     image 输入能力（否则图片进入会话会破坏该路由的延续）。
 *   - 尺寸/字节限制：按 attachments.imageLimits 计算缩放上限；PNG 超限时
 *     自动降级为 JPEG 重试一次。
 *   - schema 均为标准化 JSON Schema（对象级 required 数组；register()
 *     不走 defineTool 的 DSL→JSON Schema 转换，原样透传给模型 API）。
 *
 * 安全：截图属于敏感操作。默认审批策略（ask）下，每次调用都会在 GUI
 * 弹出审批，由用户（手机端）确认后才执行。
 */

import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, mkdir, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'

export const name = 'screen-tool'
export const inject = ['tools', 'attachments', 'llm']

// 类型化访问注入服务（声明在 inject 中的服务保证 apply 前就绪）。
// @ts-expect-error -- cordis 模块增强在 @deepseek-ai/cordis 包内，本插件不安装该包
type AnyContext = Context & {
  tools: { register(definition: unknown): () => void }
  attachments: {
    imageLimits: {
      maxImageBytes: number
      maxImagesPerMessage: number
      maxMessageImageBytes: number
      maxImagePixels: number
      mediaTypes: readonly string[]
    }
    saveImage(input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<ImageAttachmentRef>
  }
  llm: {
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: readonly string[] }>
  }
}

interface CaptureOutcome {
  ok: boolean
  error?: string
  file?: string
  source?: 'desktop' | 'window'
  title?: string
  hwnd?: string
  width?: number
  height?: number
  bytes?: number
  matches?: { hwnd: string; title: string }[]
  windows?: { hwnd: string; title: string; className?: string; left?: number; top?: number; width?: number; height?: number; visible: boolean; minimized: boolean }[]
}

const CAPTURE_SCRIPT = fileURLToPath(new URL('../capture.ps1', import.meta.url))

const IMAGE_MEDIA: Record<string, ImageMediaType> = { png: 'image/png', jpeg: 'image/jpeg' }

/** 生成归档文件名：screen-<ts>-<rand>.<ext> */
function archiveName(format: 'png' | 'jpeg'): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '')
  return `screen-${ts}-${randomBytes(2).toString('hex')}.${format}`
}

/** 调用 capture.ps1，解析 stdout JSON。 */
function runCapture(args: string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<CaptureOutcome> {
  return new Promise((resolve, reject) => {
    const psArgs = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE_SCRIPT,
      ...args,
    ]
    execFile('powershell.exe', psArgs, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      signal,
    }, (error, stdout) => {
      if (error !== null && error !== undefined) {
        const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true
        const detail = (error as { stderr?: string }).stderr ?? ''
        reject(new Error(killed
          ? 'screenshot was cancelled'
          : `capture failed: ${error.message}${detail ? ` — ${detail.trim().split('\n').slice(-2).join(' | ')}` : ''}`))
        return
      }
      const text = stdout?.trim() ?? ''
      if (text === '') {
        reject(new Error('capture produced no output'))
        return
      }
      try {
        resolve(JSON.parse(text) as CaptureOutcome)
      } catch {
        reject(new Error(`capture produced invalid JSON: ${text.slice(0, 200)}`))
      }
    })
  })
}

/**
 * 检测当前模型路由是否支持 image 输入。
 * @returns true=支持；false=不支持（调用方决定降级策略）；异常=路由无法解析。
 */
async function imageCapableRoute(ctx: AnyContext, exec: unknown): Promise<boolean> {
  const agent = (exec as { agent?: { session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } }; options?: { provider?: string; model?: string } } }).agent
  const routed = agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? agent?.options?.provider
  const model = routed?.model ?? agent?.options?.model
  if (provider === undefined || model === undefined || ctx.llm === undefined) {
    throw new Error('the current model route could not be resolved')
  }
  const active = await ctx.llm.resolveModelInfo(provider, model, (exec as { signal?: AbortSignal }).signal)
  return active.inputModalities?.includes('image') === true
}

/** 计算缩放宽高上限：用户显式 scale 优先，否则按附件像素上限推导。 */
function maxDimension(limits: AnyContext['attachments']['imageLimits'], userScale: number | undefined): number {
  const pixelCap = Math.floor(Math.sqrt(limits.maxImagePixels))
  if (userScale !== undefined && Number.isFinite(userScale) && userScale > 0) {
    return Math.min(Math.floor(userScale), pixelCap)
  }
  return pixelCap
}

export function apply(ctx: Context): void {
  const anyCtx = ctx as unknown as AnyContext

  anyCtx.tools.register({
    name: 'screenshot',
    description:
      'Capture this computer\'s desktop screen (all monitors) or a specific window, and show the image in the conversation. '
      + 'Use when the user asks to see the screen, wants to monitor what is happening on this machine, needs visual confirmation '
      + 'of an application or document state, or when describing the display would help the user. The image is also saved under '
      + '<DSH_HOME>/screenshots/ and viewable from the phone gateway gallery at /shots. When the current model cannot accept '
      + 'images, the tool automatically records metadata only and sets a note telling the user where to view the screenshot.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why this screenshot is taken; shown to the user for approval.' },
        window: { type: 'string', description: 'Substring of the target window title (e.g. "Chrome"). Omit to capture the whole desktop. Use list_windows first to find exact titles.' },
        hwnd: { type: 'string', description: 'Exact decimal window handle from list_windows; overrides window.' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'png keeps quality (larger); jpeg is much smaller. Default png (auto-falls back to jpeg if the image exceeds attachment limits).' },
        scale: { type: 'number', description: 'Maximum output width/height in pixels; large screens are downscaled to fit. Default: derived from attachment pixel limits.' },
        include_image: { type: 'boolean', description: 'Return the image itself in the conversation. Default true. Set false to only record metadata (requires no image-capable model).' },
      },
      required: ['reason'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', enum: ['desktop', 'window'] },
          window: {
            type: 'object',
            additionalProperties: false,
            properties: {
              hwnd: { type: 'string' },
              title: { type: 'string' },
            },
            required: ['hwnd', 'title'],
          },
          file: { type: 'string' },
          format: { type: 'string', enum: ['png', 'jpeg'] },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          note: { type: 'string' },
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string', enum: ['image/png', 'image/jpeg'] },
              bytes: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              name: { type: 'string' },
            },
            required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
          },
        },
        required: ['source', 'file', 'format', 'width', 'height', 'bytes'],
      },
      render: (_args: unknown, value: Record<string, unknown>) => {
        const note = typeof value.note === 'string' && value.note !== '' ? `\n<note>${value.note}</note>` : ''
        const blocks: unknown[] = [{
          type: 'text',
          text: `<source>${String(value.source)}</source>
<format>${String(value.format)} ${Number(value.width)}x${Number(value.height)} px, ${Number(value.bytes)} bytes</format>
<file>${String(value.file)}</file>${note}`,
        }]
        const image = value.image as (Record<string, unknown> & { attachmentId: string; mediaType: ImageMediaType; bytes: number; width: number; height: number; name?: string }) | undefined
        if (image !== undefined) {
          blocks.push({
            type: 'image',
            attachment: {
              attachmentId: image.attachmentId,
              mediaType: image.mediaType,
              bytes: image.bytes,
              width: image.width,
              height: image.height,
              ...(image.name === undefined ? {} : { name: image.name }),
            },
          })
        }
        return blocks
      },
    },
    timeoutMs: 30_000,
    async execute(args: Record<string, unknown>, exec: unknown) {
      const e = exec as {
        signal: AbortSignal
        agent?: unknown
        parent?: unknown
        deferContext(message: unknown): void
      }
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (reason === '') throw new Error('reason must be a non-empty string')
      const windowArg = typeof args.window === 'string' ? args.window.trim() : ''
      const hwndArg = typeof args.hwnd === 'string' ? args.hwnd.trim() : ''
      if (windowArg !== '' && hwndArg !== '') {
        throw new Error('pass either window or hwnd, not both')
      }
      const format = args.format === 'jpeg' ? 'jpeg' as const : 'png' as const
      const scale = typeof args.scale === 'number' ? args.scale : undefined
      if (scale !== undefined && (!Number.isFinite(scale) || scale <= 0)) {
        throw new Error('scale must be a positive number')
      }
      const includeImage = args.include_image !== false
      const mediaType = IMAGE_MEDIA[format]!
      const attachments = anyCtx.attachments
      if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error(`screenshot: ${mediaType} images are not accepted by this deployment`)
      }
      // 自动降级：模型路由不支持图片输入时，仍截图归档，但不在会话中携带
      // 图片（图片一旦进入会话历史，下一次请求就会把它喂给模型，而该路由
      // 无法承载图片）。结果中附 note 说明，模型应引导用户去网关画廊查看。
      let note: string | undefined
      if (includeImage && !(await imageCapableRoute(anyCtx, e))) {
        note = 'image not embedded: the current model does not accept image input; the screenshot is archived on this computer — tell the user to open the gateway gallery at /shots (http://<computer-ip>:8080/shots)'
      }

      // 归档目录：<DSH_HOME>/screenshots（DSH_HOME 缺失时退回系统临时目录）
      const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
      let archiveDir = join(dshHome, 'screenshots')
      try { await mkdir(archiveDir, { recursive: true }) } catch { archiveDir = tmpdir() }

      // 捕获并尝试一次；PNG 超限时以 JPEG + 半尺寸重试一次
      let captured: CaptureOutcome | undefined
      let attemptFormat = format
      let attemptScale = maxDimension(attachments.imageLimits, scale)
      for (let attempt = 0; attempt < 2; attempt++) {
        const outPath = join(archiveDir, archiveName(attemptFormat))
        const capArgs = ['-OutFile', outPath]
        if (hwndArg !== '') capArgs.push('-Hwnd', hwndArg)
        else if (windowArg !== '') capArgs.push('-Window', windowArg)
        if (attemptScale > 0) capArgs.push('-MaxDimension', String(attemptScale))
        if (attemptFormat === 'jpeg') capArgs.push('-Jpeg')
        const result = await runCapture(capArgs, e.signal, 25_000)
        if (!result.ok) {
          const matches = result.matches?.map(m => `${m.hwnd} (${m.title})`).join(', ') ?? ''
          throw new Error(`screenshot failed: ${result.error ?? 'unknown error'}${matches ? ` — matching windows: ${matches}` : ''}`)
        }
        captured = result

        // 仅记录元数据（不携带图片）：直接返回
        if (!includeImage || note !== undefined) {
          const size = captured.bytes ?? (await stat(outPath)).size
          return {
            source: captured.source === 'window' ? 'window' as const : 'desktop' as const,
            ...(captured.source === 'window'
              ? { window: { hwnd: captured.hwnd ?? '', title: captured.title ?? '' } }
              : {}),
            file: outPath,
            format: attemptFormat,
            width: captured.width ?? 0,
            height: captured.height ?? 0,
            bytes: size,
            ...(note === undefined ? {} : { note }),
          }
        }

        const data = await readFile(outPath)
        if (data.byteLength > attachments.imageLimits.maxImageBytes) {
          if (attemptFormat === 'png') {
            attemptFormat = 'jpeg'
            attemptScale = Math.max(1, Math.floor(attemptScale / 2))
            continue
          }
          throw new Error(`screenshot too large (${data.byteLength} bytes > ${attachments.imageLimits.maxImageBytes}); reduce scale or use jpeg`)
        }
        const ref = await attachments.saveImage({
          data: new Uint8Array(data),
          mediaType: IMAGE_MEDIA[attemptFormat]!,
          name: basename(outPath),
        }).catch((error: unknown) => {
          const code = (error as { code?: string })?.code
          if (code === 'IMAGE_TOO_LARGE' && attemptFormat === 'png') return undefined
          throw error
        })
        if (ref === undefined) {
          attemptFormat = 'jpeg'
          attemptScale = Math.max(1, Math.floor(attemptScale / 2))
          continue
        }
        const value = {
          source: captured.source === 'window' ? 'window' as const : 'desktop' as const,
          ...(captured.source === 'window'
            ? { window: { hwnd: captured.hwnd ?? '', title: captured.title ?? '' } }
            : {}),
          file: outPath,
          format: attemptFormat,
          width: captured.width ?? 0,
          height: captured.height ?? 0,
          bytes: ref.bytes,
          image: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name === undefined ? {} : { name: ref.name }),
          },
        }
        if (e.parent !== undefined) {
          e.deferContext({
            id: randomUUID(),
            role: 'user',
            content: [
              { type: 'text', text: `Screenshot of ${value.source === 'window' ? `window "${value.window?.title}"` : 'the desktop'} (${value.width}x${value.height}, ${value.format})` },
              {
                type: 'image',
                attachment: {
                  attachmentId: ref.attachmentId,
                  mediaType: ref.mediaType,
                  bytes: ref.bytes,
                  width: ref.width,
                  height: ref.height,
                },
              },
            ],
            source: { kind: 'plugin', plugin: 'screen-tool' },
          })
        }
        return value
      }
      throw new Error('screenshot failed: could not produce an image within attachment limits')
    },
    presentCall(args: Record<string, unknown>): unknown {
      const windowArg = typeof args.window === 'string' && args.window !== '' ? args.window : undefined
      return {
        card: 'generic',
        title: windowArg !== undefined ? `Screenshot window "${windowArg}"` : 'Screenshot desktop',
        kind: 'read',
      }
    },
  })

  anyCtx.tools.register({
    name: 'list_windows',
    description:
      'List the visible top-level windows on this computer with their titles and handles. '
      + 'Use before screenshot(window=...) to find the exact window title or hwnd to capture.',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          windows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                hwnd: { type: 'string' },
                title: { type: 'string' },
                className: { type: 'string' },
                left: { type: 'integer' },
                top: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                visible: { type: 'boolean' },
                minimized: { type: 'boolean' },
              },
              required: ['hwnd', 'title', 'visible', 'minimized'],
            },
          },
        },
        required: ['windows'],
      },
      render: (_args: unknown, value: { windows?: { hwnd: string; title: string }[] }) => {
        const list = value.windows ?? []
        const lines = list.length === 0
          ? ['<windows>none</windows>']
          : list.map(w => `<window><hwnd>${w.hwnd}</hwnd><title>${w.title}</title></window>`)
        return [{ type: 'text', text: `<count>${list.length}</count>\n${lines.join('\n')}` }]
      },
    },
    timeoutMs: 30_000,
    async execute(_args: unknown, exec: { signal: AbortSignal }) {
      const outcome = await runCapture(['-ListWindows'], exec.signal, 25_000)
      if (!outcome.ok) throw new Error(`list_windows failed: ${outcome.error ?? 'unknown error'}`)
      const all = outcome.windows ?? []
      // 保留全部有标题的顶层窗口；可见且未最小化的排前面（模型优先选它们）
      const sorted = [...all].sort((a, b) => {
        const rank = (w: { visible: boolean; minimized: boolean }): number => (w.visible && !w.minimized ? 0 : 1)
        return rank(a) - rank(b) || a.title.localeCompare(b.title)
      })
      return { windows: sorted }
    },
    presentCall(): unknown {
      return { card: 'generic', title: 'List windows', kind: 'search' }
    },
  })

  console.log('[screen-tool] plugin loaded: screenshot + list_windows registered')
}
