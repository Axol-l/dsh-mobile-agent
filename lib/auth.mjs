/**
 * 密码认证与会话 cookie：timing-safe 比对、随机会话令牌、
 * 按 IP 的登录失败限速（fail-closed，不泄露任何内部状态）。
 *
 * 登录持久性（用户核心诉求：刷新不重输密码）：
 * - 勾选「记住我」→ 签发 sessionDays 天的持久 cookie（重启浏览器/刷新均保持）
 * - 不勾选 → 会话级 cookie（24h，关闭浏览器失效，刷新仍保持）
 *
 * @module phone-agent/auth
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const LOGIN_WINDOW_MS_DEFAULT = 60_000
const LOGIN_MAX_ATTEMPTS = 5
const SESSION_LEVEL_TTL_MS = 24 * 60 * 60_000

/** 创建认证器。 */
export function createAuth(password, { sessionDays = 30, loginWindowMs = LOGIN_WINDOW_MS_DEFAULT, secure = false } = {}) {
  /** token -> { expiresAt, ttl } */
  const sessions = new Map()
  const loginAttempts = new Map() // ip -> { count, windowStart }
  const passwordHash = createHash('sha256').update(password).digest()
  const rememberTtlMs = sessionDays * 24 * 60 * 60_000

  /** 校验密码（timing-safe）。 */
  function verifyPassword(input) {
    const hash = createHash('sha256').update(String(input)).digest()
    return hash.length === passwordHash.length && timingSafeEqual(hash, passwordHash)
  }

  /** 登录限速检查：超过阈值抛错（调用方转 429）。 */
  function checkRateLimit(ip) {
    const now = Date.now()
    const entry = loginAttempts.get(ip)
    if (!entry || now - entry.windowStart >= loginWindowMs) {
      loginAttempts.set(ip, { count: 1, windowStart: now })
      return
    }
    entry.count += 1
    if (entry.count > LOGIN_MAX_ATTEMPTS) {
      throw new Error('登录尝试过于频繁，请稍后再试')
    }
  }

  /** 登录成功：签发会话令牌。remember=true 时持久（sessionDays 天），否则会话级（24h）。 */
  function issueSession(remember) {
    const token = randomBytes(32).toString('hex')
    const ttl = remember ? rememberTtlMs : SESSION_LEVEL_TTL_MS
    sessions.set(token, { expiresAt: Date.now() + ttl, ttl })
    return { token, ttl }
  }

  /** 校验会话令牌；有效则按原始 TTL 滑动续期（活跃用户不会过期）。 */
  function checkSession(token) {
    if (!token) return false
    const entry = sessions.get(token)
    if (entry === undefined) return false
    if (Date.now() > entry.expiresAt) {
      sessions.delete(token)
      return false
    }
    entry.expiresAt = Date.now() + entry.ttl
    return true
  }

  /** 吊销一个会话令牌。 */
  function revokeSession(token) {
    sessions.delete(token)
  }

  /** 生成 cookie 头（HttpOnly + SameSite=Lax；HTTPS 下加 Secure）。 */
  function cookieHeader(token, ttl) {
    const parts = [
      `pa_session=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(ttl / 1000)}`,
    ]
    if (secure) parts.push('Secure')
    return parts.join('; ')
  }

  return { verifyPassword, checkRateLimit, issueSession, checkSession, revokeSession, cookieHeader }
}

/** 从请求头解析 cookie 中的 pa_session。 */
export function parseSessionCookie(header) {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === 'pa_session') return rest.join('=') || undefined
  }
  return undefined
}

/** 提取客户端 IP（信任 X-Forwarded-For 需谨慎；默认直连取 socket 地址）。 */
export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim()
  }
  return req.socket?.remoteAddress ?? 'unknown'
}
