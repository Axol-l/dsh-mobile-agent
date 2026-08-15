/**
 * phone-agent 主服务：认证网关 + 反向代理到本机 dsh web。
 *
 * 手机浏览器访问 http://<本机IP>:8080：
 * - 未认证 → 登录页（密码 + 记住我；刷新/重启浏览器不重输密码）
 * - 已认证 → 反向代理到 http://127.0.0.1:3080（dsh web 完整原版 GUI，
 *   UI 与功能与桌面端完全一致）
 *
 * 路由（phone-agent 自身端点，其余全部转发）：
 * - GET  /            → 未认证：登录页；已认证：转发 dsh web
 * - POST /api/login   → 密码登录（限速），签发 HttpOnly cookie
 * - POST /api/logout  → 吊销会话
 * - GET  /api/pa/status → 网关与目标状态（认证）
 * - GET  /healthz     → 进程存活探针（公开）
 * - 其余 / 与 /api/*、WebSocket upgrade → 认证后转发
 *
 * 安全：cookie HttpOnly + SameSite=Lax；HTTPS 下 Secure；登录限速；
 * 代理改写 Host/Origin 为 loopback 以满足 dsh web 的 browser-trust fence。
 *
 * @module phone-agent/server
 */

import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, resolve, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './lib/config.mjs'
import { createAuth, parseSessionCookie, clientIp } from './lib/auth.mjs'
import { createProxy } from './lib/proxy.mjs'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)))
const LOGIN_HTML = resolve(PROJECT_ROOT, 'web', 'index.html')

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

function readJsonBody(req, limitBytes = 8 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        rejectPromise(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolvePromise(raw === '' ? {} : JSON.parse(raw))
      } catch (error) {
        rejectPromise(new Error(`JSON 解析失败: ${error.message}`))
      }
    })
    req.on('error', rejectPromise)
  })
}

/** 截图清单：归档目录下 screen-*.png/jpg，按修改时间新→旧。 */
function listScreenshots(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (!/^screen-.+\.(png|jpe?g)$/i.test(name)) continue
    const file = join(dir, name)
    if (!statSync(file).isFile()) continue
    out.push({ name, size: statSync(file).size, mtime: statSync(file).mtimeMs })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/** 画廊页：手机优先，自动轮询刷新，点击看原图。 */
function serveGallery(res, dir) {
  const files = listScreenshots(dir)
  const rows = files.map((f) => `
    <a class="cell" href="/shots/${encodeURIComponent(f.name)}" target="_blank" title="${f.name}">
      <img src="/shots/${encodeURIComponent(f.name)}?t=${Math.round(f.mtime)}" alt="${f.name}" loading="lazy">
      <span class="meta">${f.name}<br>${(f.size / 1024).toFixed(0)} KB</span>
    </a>`).join('\n')
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>工作机屏幕截图</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3; font: 14px/1.5 system-ui, sans-serif; }
  header { position: sticky; top: 0; background: #161b22; padding: 10px 14px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid #30363d; }
  header h1 { font-size: 15px; margin: 0; flex: 1; }
  #status { color: #8b949e; font-size: 12px; }
  #grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; padding: 12px; }
  .cell { display: block; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; text-decoration: none; color: inherit; }
  .cell img { width: 100%; height: 130px; object-fit: cover; display: block; background: #000; }
  .cell .meta { display: block; padding: 6px 8px; font-size: 11px; color: #8b949e; word-break: break-all; }
  .empty { padding: 40px 16px; text-align: center; color: #8b949e; }
</style>
</head>
<body>
<header>
  <h1>🖥 工作机屏幕截图</h1>
  <span id="status"></span>
</header>
<div id="grid">${rows || '<div class="empty">暂无截图。让 agent 调用 screenshot 工具，或稍后自动刷新。</div>'}</div>
<script>
  // 每 8 秒轮询清单，增量刷新（实时监视模式）
  let known = ${JSON.stringify(files.map((f) => f.name))};
  async function poll() {
    try {
      const r = await fetch('/shots/list.json?t=' + Date.now());
      const data = await r.json();
      const names = (data.files || []).map(f => f.name);
      const status = document.getElementById('status');
      if (status) status.textContent = names.length + ' 张 · ' + new Date().toLocaleTimeString();
      if (names.length !== known.length || names.some((n, i) => n !== known[i])) {
        location.reload(); // 顺序/数量变化 → 整页刷新最稳
        return;
      }
    } catch (e) { /* 网络抖动忽略 */ }
  }
  poll();
  setInterval(poll, 8000);
</script>
</body>
</html>`
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(html)
}

async function main() {
  const config = loadConfig()
  const startedAt = Date.now()
  mkdirSync(config.dataDir, { recursive: true })

  const auth = createAuth(config.password, {
    sessionDays: config.sessionDays,
    loginWindowMs: config.loginWindowMs,
    secure: Boolean(config.httpsCert),
  })
  const proxy = createProxy(config, {
    onLog: (level, message) => console.log(`[web] ${message}`),
  })

  /** 认证中间件：失败 401。 */
  function requireAuth(req, res) {
    const token = parseSessionCookie(req.headers.cookie)
    if (!token || !auth.checkSession(token)) {
      json(res, 401, { error: '未登录或会话已过期' })
      return false
    }
    return true
  }

  /** 返回登录页。 */
  function serveLogin(res, error = undefined) {
    if (!existsSync(LOGIN_HTML)) {
      json(res, 500, { error: 'web/index.html 缺失' })
      return
    }
    const html = readFileSync(LOGIN_HTML, 'utf8').replace('__LOGIN_ERROR__', error ?? '')
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(html)
  }

  /** 路由分发：认证端点 → 其余转发。 */
  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    // 公开端点
    if (req.method === 'GET' && path === '/healthz') {
      json(res, 200, { ok: true, uptimeMs: Date.now() - startedAt })
      return
    }

    // 登录页（未认证时 GET / 返回登录页；已认证时走转发）
    if (req.method === 'GET' && path === '/') {
      const token = parseSessionCookie(req.headers.cookie)
      if (!token || !auth.checkSession(token)) {
        serveLogin(res)
        return
      }
      proxy.forward(req, res, clientIp(req))
      return
    }

    if (req.method === 'POST' && path === '/api/login') {
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        json(res, 400, { error: error.message })
        return
      }
      const ip = clientIp(req)
      try {
        auth.checkRateLimit(ip)
      } catch (error) {
        json(res, 429, { error: error.message })
        return
      }
      if (!auth.verifyPassword(body.password)) {
        json(res, 401, { error: '密码错误' })
        return
      }
      const remember = body.remember !== false // 默认记住我
      const { token, ttl } = auth.issueSession(remember)
      res.writeHead(200, {
        'Set-Cookie': auth.cookieHeader(token, ttl),
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify({ ok: true, remember }))
      return
    }

    // 以下需要认证
    if (!requireAuth(req, res)) return

    if (req.method === 'POST' && path === '/api/logout') {
      const token = parseSessionCookie(req.headers.cookie)
      if (token) auth.revokeSession(token)
      res.writeHead(200, {
        'Set-Cookie': 'pa_session=; Path=/; HttpOnly; Max-Age=0',
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method === 'GET' && path === '/api/pa/status') {
      json(res, 200, {
        ok: true,
        target: config.target,
        https: Boolean(config.httpsCert),
        proxy: proxy.snapshot(),
      })
      return
    }

    // ── 屏幕截图画廊（screen-tool 插件归档目录）─────────────────────────
    // GET /shots            → 画廊页（自动刷新）
    // GET /shots/list.json  → 文件清单（新→旧）
    // GET /shots/<file>     → 图片字节
    if (req.method === 'GET' && path === '/shots') {
      serveGallery(res, config.screenshotsDir)
      return
    }
    if (req.method === 'GET' && path === '/shots/list.json') {
      json(res, 200, { ok: true, files: listScreenshots(config.screenshotsDir) })
      return
    }
    if (req.method === 'GET' && path.startsWith('/shots/')) {
      const name = basename(decodeURIComponent(path.slice('/shots/'.length)))
      // 只放行本插件命名的归档文件，杜绝路径穿越/任意文件读取
      if (!/^screen-.+\.(png|jpe?g)$/i.test(name)) {
        json(res, 404, { error: 'not found' })
        return
      }
      const file = join(config.screenshotsDir, name)
      if (file.startsWith(config.screenshotsDir + sep) && existsSync(file) && statSync(file).isFile()) {
        const data = readFileSync(file)
        const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
        res.writeHead(200, {
          'Content-Type': ext === 'png' ? 'image/png' : 'image/jpeg',
          'Content-Length': data.length,
          'Cache-Control': 'public, max-age=3600',
        })
        res.end(data)
        return
      }
      json(res, 404, { error: 'not found' })
      return
    }

    // 其余全部转发给 dsh web（含 /、静态资源、/api RPC）
    proxy.forward(req, res, clientIp(req))
  }

  const handler = async (req, res) => {
    try {
      await route(req, res)
    } catch (error) {
      if (!res.headersSent) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      } else {
        res.destroy()
      }
    }
  }

  const server = config.httpsCert
    ? createHttpsServer(
      {
        cert: readFileSync(resolve(PROJECT_ROOT, config.httpsCert)),
        key: readFileSync(resolve(PROJECT_ROOT, config.httpsKey)),
      },
      handler,
    )
    : createServer(handler)

  // WebSocket 转发（dsh web 的 /api/events.mux 与 /api/events.host 下行流）
  server.on('upgrade', (req, socket, head) => {
    const token = parseSessionCookie(req.headers.cookie)
    if (!token || !auth.checkSession(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    proxy.forwardUpgrade(req, socket, head, clientIp(req))
  })

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(config.port, config.host, () => resolvePromise())
  })

  // 目标可达性：不可达且托管开启时自动启动 dsh web
  const reachable = await proxy.probeTarget()
  if (reachable) {
    console.log(`[phone-agent] 目标 dsh web 可达：${config.target}`)
  } else if (config.manageWeb) {
    console.log(`[phone-agent] 目标 ${config.target} 不可达，尝试托管启动 dsh web…`)
    void proxy.ensureWeb()
  } else {
    console.log(`[phone-agent] ⚠️ 目标 ${config.target} 不可达（已关闭托管），请先启动 dsh web`)
  }

  const scheme = config.httpsCert ? 'https' : 'http'
  console.log(`[phone-agent] 服务已启动 ${scheme}://${config.host}:${config.port}`)
  console.log(`[phone-agent] 手机访问：${scheme}://<本机局域网IP>:${config.port}（同一 WiFi 或热点）`)
  console.log('[phone-agent] 登录后即为完整 DeepSeek Harness 界面（与桌面端一致），刷新不重输密码')

  // 优雅退出
  const shutdown = async (signal) => {
    console.log(`\n[phone-agent] 收到 ${signal}，正在关闭…`)
    try {
      await proxy.shutdown()
      server.close()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

main().catch((error) => {
  console.error(`[phone-agent] 启动失败: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
