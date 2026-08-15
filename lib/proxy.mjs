/**
 * 反向代理到本机 dsh web（认证网关的转发层）。
 *
 * 为什么需要代理而不是让 dsh web 直接监听 0.0.0.0：
 * dsh web 官方不提供认证层，`/api` browser-trust fence 只接受 loopback
 * 或显式 trustedHost（`dsh web --host 0.0.0.0` 被有意不支持）。因此
 * dsh web 始终监听 127.0.0.1，由本模块把认证后的外部请求转发进去，
 * 并把 Host/Origin 改写为 loopback authority 以通过 fence。
 *
 * 支持：
 * - HTTP（含任意大小请求体，流式转发）
 * - WebSocket upgrade（dsh web 的 /api/events.mux 与 /api/events.host 下行流）
 * - 托管模式：目标不可达时自动从 deepseek-harness 检出启动 dsh web
 *
 * @module phone-agent/proxy
 */

import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS_ROOT = resolve(
  process.env.DSH_HARNESS_ROOT ?? resolve(PROJECT_ROOT, '..', 'deepseek-harness'),
)
const WEB_BIN = resolve(HARNESS_ROOT, 'apps', 'cli', 'src', 'bin.ts')
/** 远程访问补丁：目录选择器强制 browse（手机浏览器无 File System Access API）。 */
const REMOTE_PATCH = resolve(PROJECT_ROOT, 'web-remote.patch.yml')

/**
 * 非安全上下文（HTTP 局域网访问）下浏览器不暴露 crypto.randomUUID，
 * dsh web 前端有直接调用点。在 HTML 文档中注入等价 polyfill
 * （与 dsh web 自带 random-uuid.ts 相同的 RFC 4122 v4 实现）。
 */
const RANDOM_UUID_POLYFILL = `<script>
(function () {
  var g = globalThis;
  if (!g.crypto || typeof g.crypto.randomUUID === 'function') return;
  g.crypto.randomUUID = function () {
    var b = new Uint8Array(16);
    g.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = '';
    for (var i = 0; i < 16; i++) h += b[i].toString(16).padStart(2, '0');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  };
})();
</script>`

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
])

const MAX_HTML_INJECT_BYTES = 2 * 1024 * 1024

/**
 * 屏幕监视悬浮窗：注入到转发的 dsh web 主文档，页面右下角实时显示最新截图。
 * - 轮询 /shots/list.json（同源、带登录 cookie），新截图自动出现；
 * - 桌面直连 127.0.0.1:3080 时 /shots 不存在 → fetch 失败 → 自动隐藏，不影响页面；
 * - 点击缩略图打开 /shots 画廊，可关闭。
 */
const SCREEN_WIDGET_SCRIPT = `<style>
.dsh-shot-widget { position: fixed; right: 12px; bottom: 12px; z-index: 2147483000; width: 168px;
  background: rgba(22, 27, 34, .94); border: 1px solid #30363d; border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0,0,0,.45); font: 12px/1.4 system-ui, sans-serif; color: #e6edf3; overflow: hidden; }
.dsh-shot-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: #161b22; border-bottom: 1px solid #30363d; }
.dsh-shot-title { flex: 1; font-weight: 600; }
.dsh-shot-close { border: 0; background: none; color: #8b949e; font-size: 14px; cursor: pointer; padding: 0 4px; line-height: 1; }
.dsh-shot-close:hover { color: #f85149; }
.dsh-shot-body { display: block; padding: 6px; text-decoration: none; color: inherit; }
.dsh-shot-img { width: 100%; height: 96px; object-fit: cover; border-radius: 6px; display: block; background: #000; }
.dsh-shot-name { display: block; margin-top: 4px; color: #8b949e; word-break: break-all; }
</style>
<script>
(function () {
  var POLL_MS = 8000;
  var container = null, img = null, nameEl = null, lastName = '', closed = false;
  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  function build() {
    if (container || !document.body) return;
    container = el('div', 'dsh-shot-widget', document.body);
    var head = el('div', 'dsh-shot-head', container);
    el('span', 'dsh-shot-title', head).textContent = '\\ud83d\\udcf8 最新截图';
    var closeBtn = el('button', 'dsh-shot-close', head);
    closeBtn.textContent = '\\u00d7';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', function () {
      closed = true; // 用户已关闭：本轮会话内保持隐藏，轮询不再恢复
      container.style.display = 'none';
    });
    var body = el('a', 'dsh-shot-body', container);
    body.href = '/shots';
    body.target = '_blank';
    body.title = '打开截图画廊';
    img = el('img', 'dsh-shot-img', body);
    img.alt = '最新截图';
    img.addEventListener('error', function () { container.style.display = 'none'; });
    nameEl = el('span', 'dsh-shot-name', body);
  }
  function poll() {
    fetch('/shots/list.json?t=' + Date.now(), { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (data) {
        if (closed) return; // 已关闭：保持隐藏
        var files = (data && data.files) || [];
        if (files.length === 0) { container.style.display = 'none'; return; }
        var top = files[0];
        if (top.name !== lastName) {
          lastName = top.name;
          img.src = '/shots/' + encodeURIComponent(top.name) + '?t=' + Math.round(top.mtime);
          nameEl.textContent = top.name.replace(/^screen-/, '').replace(/\\.[a-z]+$/i, '');
        }
        container.style.display = '';
      })
      .catch(function () { if (container) container.style.display = 'none'; });
  }
  function start() {
    build();
    if (!container) { setTimeout(start, 500); return; }
    poll();
    setInterval(poll, POLL_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
</script>`

/** 解析 http(s)://host:port 目标。 */
export function parseTarget(raw) {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`不支持的目标协议: ${url.protocol}`)
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  return { protocol: url.protocol, host: url.hostname, port, origin: url.origin }
}

/** 待转发请求头：改写 Host/Origin 为 loopback authority，删除 hop-by-hop 与浏览器标记。 */
function rewriteHeaders(headers, target, clientIp) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'host' || lower === 'origin' || lower === 'sec-fetch-site'
      || lower === 'sec-fetch-mode' || lower === 'sec-fetch-dest' || lower === 'cookie') {
      continue // 下面统一重写
    }
    out[name] = value
  }
  out.Host = `${target.host}:${target.port}`
  out.Origin = target.origin
  if (clientIp) out['X-Forwarded-For'] = clientIp
  return out
}

/**
 * 是否应在该响应中注入 polyfill：HTML 主文档（GET / 返回 text/html）。
 * @param reqPath - 请求路径。
 * @param method - 请求方法。
 * @param contentType - 上游响应的 Content-Type。
 */
function shouldInjectHtml(reqPath, method, contentType) {
  if (method !== 'GET' && method !== 'HEAD') return false
  const path = reqPath.split('?')[0]
  if (path !== '/') return false
  return typeof contentType === 'string' && contentType.includes('text/html')
}

/** 把 polyfill + 屏幕监视悬浮窗注入 HTML 文本（插到 </head> 前；找不到锚点则不注入）。 */
function injectPolyfill(html) {
  const anchor = '</head>'
  const index = html.toLowerCase().indexOf(anchor)
  if (index < 0) return html
  return `${html.slice(0, index)}${RANDOM_UUID_POLYFILL}${SCREEN_WIDGET_SCRIPT}${html.slice(index)}`
}

/**
 * 创建反向代理处理器。
 * @param config - loadConfig() 的结果。
 * @param events - { onLog(level, msg), onStatus(snapshot) } 供服务端记录。
 */
export function createProxy(config, events = {}) {
  const target = parseTarget(config.target)
  let webChild = undefined // 托管模式的 dsh web 子进程

  /** 目标健康探测。 */
  function probeTarget(timeoutMs = 1500) {
    return new Promise((resolvePromise) => {
      const req = httpRequest({
        host: target.host, port: target.port, path: '/', method: 'GET',
        headers: { Host: `${target.host}:${target.port}` },
        timeout: timeoutMs,
      }, (res) => {
        res.resume()
        resolvePromise(true)
      })
      req.on('error', () => resolvePromise(false))
      req.on('timeout', () => { req.destroy(); resolvePromise(false) })
      req.end()
    })
  }

  /** 托管模式：目标不可达时启动 dsh web 子进程（崩溃自动重启，进程退出时杀掉）。 */
  async function ensureWeb() {
    if (!config.manageWeb) return
    if (webChild !== undefined && webChild.exitCode === null) return
    if (await probeTarget()) return // 已有实例（用户手动启动的），不接管
    events.onLog?.('info', `目标 ${config.target} 不可达，正在从 ${HARNESS_ROOT} 启动 dsh web…`)
    webChild = spawn(process.execPath, ['--import', 'tsx/esm', WEB_BIN, 'web', '--patch', REMOTE_PATCH, '--host', '127.0.0.1', '--port', String(target.port)], {
      cwd: HARNESS_ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env },
    })
    let stderrTail = ''
    webChild.stderr?.setEncoding('utf8')
    webChild.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000)
    })
    webChild.on('error', (error) => {
      events.onLog?.('warn', `dsh web 启动失败: ${error.message}`)
    })
    webChild.on('exit', (code, signal) => {
      const tail = stderrTail.trim().split('\n').slice(-3).join(' | ')
      events.onLog?.('warn', `dsh web 子进程退出 (code=${code} signal=${signal ?? ''})${tail ? ` — ${tail}` : ''}，30s 后自动重启`)
      setTimeout(() => { void ensureWeb() }, 30_000)
    })
    // 等待就绪
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (await probeTarget()) {
        events.onLog?.('info', 'dsh web 就绪')
        return
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    events.onLog?.('warn', 'dsh web 启动超时（仍在后台重试）')
  }

  /** 停止托管子进程（服务退出时调用）。 */
  async function shutdown() {
    if (webChild && webChild.exitCode === null) {
      webChild.kill()
      await new Promise((r) => { webChild.once('exit', r); setTimeout(r, 3000) })
    }
  }

  /** 返回当前快照（供 /api/pa/status）。 */
  function snapshot() {
    return {
      target: config.target,
      manageWeb: config.manageWeb,
      webChildAlive: webChild !== undefined && webChild.exitCode === null,
    }
  }

  /** HTTP 转发。 */
  function forward(req, res, clientIp) {
    const upstream = httpRequest({
      host: target.host, port: target.port,
      path: req.url ?? '/',
      method: req.method,
      headers: rewriteHeaders(req.headers, target, clientIp),
    }, (upstreamRes) => {
      const out = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        const lower = name.toLowerCase()
        if (HOP_BY_HOP.has(lower)) continue
        if (lower === 'set-cookie') { out[name] = value; continue }
        out[name] = value
      }
      // HTML 主文档（GET /，上游多为 chunked 无 Content-Length）：
      // 缓冲后注入 randomUUID polyfill（非安全上下文缺 crypto.randomUUID）。
      // 该路径只命中固定的小型主文档；异常超限直接断开。
      const inject = shouldInjectHtml(req.url ?? '/', req.method ?? 'GET', upstreamRes.headers['content-type'])
      if (inject) {
        let size = 0
        const chunks = []
        upstreamRes.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_HTML_INJECT_BYTES) {
            upstreamRes.destroy()
            res.destroy()
            return
          }
          chunks.push(chunk)
        })
        upstreamRes.on('end', () => {
          const html = Buffer.concat(chunks).toString('utf8')
          const injected = injectPolyfill(html)
          res.writeHead(upstreamRes.statusCode ?? 502, {
            ...out,
            'Content-Length': Buffer.byteLength(injected),
          })
          res.end(injected)
        })
        return
      }
      res.writeHead(upstreamRes.statusCode ?? 502, out)
      upstreamRes.pipe(res)
    })
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(`目标服务不可达 (${config.target})：${error.message}\n请确认 dsh web 正在运行。`)
      } else {
        res.destroy()
      }
      // 托管模式下转发失败视为目标掉线，触发自愈（已就绪则无操作）
      if (config.manageWeb) void ensureWeb()
    })
    req.pipe(upstream)
  }

  /** WebSocket 转发（dsh web 下行流）。 */
  function forwardUpgrade(req, socket, head, clientIp) {
    const upstream = netConnect(target.port, target.host, () => {
      const lines = [
        `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`,
        `Host: ${target.host}:${target.port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Origin: ${target.origin}`,
      ]
      for (const [name, value] of Object.entries(req.headers)) {
        const lower = name.toLowerCase()
        if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'origin'
          || lower === 'sec-fetch-site' || lower === 'sec-fetch-mode' || lower === 'sec-fetch-dest') {
          continue
        }
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      if (clientIp) lines.push(`X-Forwarded-For: ${clientIp}`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head && head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => {
      socket.destroy()
    })
    socket.on('error', () => {
      upstream.destroy()
    })
    socket.on('close', () => {
      upstream.destroy()
    })
  }

  return { ensureWeb, shutdown, snapshot, forward, forwardUpgrade, probeTarget }
}
