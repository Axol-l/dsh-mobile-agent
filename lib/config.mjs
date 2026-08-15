/**
 * phone-agent 配置加载。
 *
 * 优先级：默认值 < 配置文件(JSON, --config 或 DSH_PHONE_AGENT_CONFIG) < 环境变量。
 * 所有路径相对于项目根解析。
 *
 * @module phone-agent/config
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 解析配置为最终对象。
 * @param argv - 进程参数（识别 --config <path>）。
 * @returns 合并后的配置对象。
 */
export function loadConfig(argv = process.argv.slice(2)) {
  const env = process.env
  const configFile = env.DSH_PHONE_AGENT_CONFIG ?? readArg(argv, '--config')
  const fileConfig = configFile ? parseJsonFile(resolve(PROJECT_ROOT, configFile)) : {}

  const dataDir = firstDefined(
    env.DSH_PHONE_AGENT_DATA_DIR, fileConfig.dataDir,
    resolve(PROJECT_ROOT, 'data'),
  )
  const config = {
    port: intField(env.DSH_PHONE_AGENT_PORT, fileConfig.port, 8080),
    host: firstDefined(env.DSH_PHONE_AGENT_HOST, fileConfig.host, '0.0.0.0'),
    // 反向代理目标：本机 dsh web（必须监听 loopback，fence 要求）
    target: firstDefined(
      env.DSH_PHONE_AGENT_TARGET, fileConfig.target,
      'http://127.0.0.1:3080',
    ),
    // 托管模式：目标不可达时自动从 deepseek-harness 检出启动 dsh web
    manageWeb: boolField(env.DSH_PHONE_AGENT_MANAGE_WEB, fileConfig.manageWeb, true),
    password: resolvePassword(firstDefined(env.DSH_PHONE_AGENT_PASSWORD, fileConfig.password), dataDir),
    httpsCert: firstDefined(env.DSH_PHONE_AGENT_HTTPS_CERT, fileConfig.httpsCert),
    httpsKey: firstDefined(env.DSH_PHONE_AGENT_HTTPS_KEY, fileConfig.httpsKey),
    dataDir,
    // 登录会话时长（天）；"记住我"勾选时生效，不勾选为会话级
    sessionDays: intField(env.DSH_PHONE_AGENT_SESSION_DAYS, fileConfig.sessionDays, 30),
    loginWindowMs: intField(env.DSH_PHONE_AGENT_LOGIN_WINDOW_MS, fileConfig.loginWindowMs, 60_000),
  }

  if (config.port <= 0 || config.port > 65535) {
    throw new Error(`非法端口配置: ${config.port}`)
  }
  const cert = config.httpsCert && resolve(PROJECT_ROOT, config.httpsCert)
  const key = config.httpsKey && resolve(PROJECT_ROOT, config.httpsKey)
  if (Boolean(cert) !== Boolean(key)) {
    throw new Error('HTTPS 需要同时提供 httpsCert 和 httpsKey')
  }
  config.httpsCert = cert
  config.httpsKey = key
  return config
}

/** 从 arg 列表读取 `--name <value>`。 */
function readArg(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined
}

/** 解析 JSON 配置文件；解析失败直接抛错（启动期 fail-loud）。 */
function parseJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`配置文件解析失败 ${path}: ${error.message}`)
  }
}

/** 密码解析：显式密码直接用；否则从 data/auth.json 读取或首次生成并持久化。 */
function resolvePassword(explicit, dataDir) {
  if (explicit !== undefined && explicit !== '') return explicit
  mkdirSync(dataDir, { recursive: true })
  const file = resolve(dataDir, 'auth.json')
  if (existsSync(file)) {
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8'))
      // 最短 6 位：接受用户自定义的短密码；低于 6 位视为无效，重新生成
      if (typeof stored.password === 'string' && stored.password.length >= 6) return stored.password
    } catch {
      // 损坏的存储文件：重新生成（不 fail-loud，密码可再生成）
    }
  }
  const password = randomBytes(12).toString('base64url')
  writeFileSync(file, JSON.stringify({ password, createdAt: Date.now() }, null, 2), { mode: 0o600 })
  console.log(`[auth] 已生成访问密码（保存于 ${file}）：${password}`)
  return password
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

function intField(envValue, fileValue, fallback) {
  const raw = firstDefined(envValue, fileValue)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) throw new Error(`非法整数配置: ${raw}`)
  return parsed
}

function boolField(envValue, fileValue, fallback) {
  const raw = firstDefined(envValue, fileValue)
  if (raw === undefined) return fallback
  if (typeof raw === 'boolean') return raw
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new Error(`非法布尔配置: ${raw}`)
}
