# dsh-phone-agent — DeepSeek Harness 手机访问网关


手机浏览器登录后获得与桌面端**完全一致**的 DeepSeek Harness 原版界面与全部功能
（会话、工具调用、审批、设置等），并支持**持久登录**：勾选「记住我」后 30 天
免登录，刷新页面、重启浏览器都不再重输密码。
⚠ 整个项目由DeepSeek-V4-Flash 自行编写，注意鉴别潜在安全隐患。

## 架构

```
┌──────────┐  HTTP + WebSocket  ┌───────────────────────┐   反向代理      ┌────────────────────┐
│手机浏览器 │ ─────────────────▶│  phone-agent 认证网关  │────────────▶  │  dsh web (原版 GUI) │
│登录页+GUI│  密码登录/记住我     │ (server.mjs, 零依赖)   │改写 Host/Origin│  127.0.0.1:3080    │
└──────────┘  cookie 持久会话    └───────────────────────┘                └────────────────────┘
```

- **为什么需要网关**：dsh web 官方不提供认证层，且 `/api` 的 browser-trust fence
  只接受 loopback 访问（`--host 0.0.0.0` 被有意不支持）。因此 dsh web 始终监听
  127.0.0.1，由 phone-agent 在外部承担认证，并把请求转发进去（改写 Host/Origin
  为 loopback authority 以满足 fence）。
- **前端**：就是 dsh web 原版单页，UI 与功能 100%
  一致，无任何自研替代界面。
- **通道**：HTTP（含任意大小请求体，流式转发）+ WebSocket 升级
  （dsh web 的 `/api/events.mux` 与 `/api/events.host` 下行流）。

## 使用流程

### 1. 启动网关

前置条件：Node.js ^22.19 || >=24；本机 dsh web 正在运行
（`cd deepseek-harness && node --import tsx/esm apps/cli/src/bin.ts web`），
或开启托管模式（`manageWeb: true`，默认）让网关自动拉起。

```sh
cd <phone-agent 项目目录>
node server.mjs
```

启动后控制台打印访问地址与访问密码（首次自动生成并持久化到 `data/auth.json`，
重启不变；也可用 `DSH_PHONE_AGENT_PASSWORD` 或配置文件自定义）。

### 2. 手机登录

手机浏览器打开 `http://<电脑IP>:8080`：

1. 输入访问密码（默认勾选「记住我」→ 30 天免登录）
2. 进入的就是 DeepSeek Harness 原版界面，功能与桌面端完全一致
3. 之后刷新、重开浏览器都不再要密码

### 3. 不同场景的访问地址

| 场景 | 访问地址 | 说明 |
|---|---|---|
| 同一 WiFi / 手机热点 | `http://<电脑局域网IP>:8080` | 最简单，仅限局域网 |
| 异地远程（推荐） | `http://<Tailscale IP>:8080` | Tailscale 组网，免费、加密、无需公网 IP |

### 4. 登出

在界面中登出，或清空浏览器 cookie，会话即失效。

## 手机端适配

1. **`crypto.randomUUID` 缺失**：手机浏览器经 HTTP 局域网访问属于非安全上下文，
   `crypto.randomUUID` 不被暴露，dsh web 前端（附件草稿等）会报
   `crypto.randomUUID is not a function`。网关在转发 HTML 主文档时自动注入
   等价 polyfill（与 dsh web 自带实现相同的 RFC 4122 v4 算法），无需改前端。
2. **工作区选择器**：dsh web 的 `directory-picker-auto` 在 loopback 监听下
   解析为 native 后端，依赖浏览器 File System Access API（`showDirectoryPicker`），
   手机浏览器不支持 → 手机端无法选择本机工作区。网关托管 dsh web 时自动叠加
   `web-remote.patch.yml`（禁用 auto、挂 browse 后端：RPC 目录树浏览，
   任何浏览器可用）。

## 屏幕监视（远程查看工作机）

`plugins/screen-tool` 是一个零依赖的 dsh 插件，给 agent 提供
`screenshot`（桌面/指定窗口截图）与 `list_windows`（窗口枚举）两个工具：

- **图片模型**（声明 image 输入）：截图以图片块进入会话（与内置
  `read_image` 同一附件机制），GUI 轨迹面板显示、模型可见画面、可描述；
- **文本模型**（如 DeepSeek 官方适配器，默认）：自动降级为元数据模式，
  手机浏览器打开 `http://<电脑IP>:8080/shots` 画廊实时查看（每 8 秒自动
  刷新，登录后访问，文件归档于 `<DSH_HOME>/screenshots/`）；
- 安装方式：写入 `$DSH_HOME/profiles/web/cordis.patch.yml`（配置 HMR
  热加载，本机已配好）；详见 `plugins/screen-tool/README.md`。
- 每次截图调用受 dsh 审批策略控制（默认 ask，手机端确认后执行）。

### 使用方法

| 你想做什么 | 怎么说 |
|---|---|
| 看整个屏幕 | 「截个图看看屏幕」 |
| 看某个窗口 | 「看看 Chrome 窗口 / 列出窗口」 |
| 持续监视 | 「每 30 秒截一张图」（agent 循环调用，画廊自动刷新） |
| 直接看画面 | 手机浏览器打开 `http://<电脑IP>:8080/shots`（无需经过对话） |

文本模型下对话中不会出现图片块（模型无法承载），画面一律走 `/shots`
画廊；图片模型下对话直接可见。

## 托管模式

`manageWeb: true`（默认）时，若目标 dsh web 不可达，网关会自动从同级
deepseek-harness 检出启动一个 dsh web 实例（崩溃自动重启、转发失败自愈）。
已有手动实例时不会重复启动。改端口用 `target` 配置。

## 安全模型

| 层 | 措施 |
|---|---|
| 访问认证 | 密码登录（timing-safe 比对）+ HttpOnly/SameSite=Lax Cookie；登录失败按 IP 限速（5 次/分钟） |
| 会话持久 | 「记住我」→ 30 天持久 cookie（默认勾选）；不勾选 → 24h 会话级；活跃用户滑动续期 |
| 网络 | 默认监听 `0.0.0.0`（局域网）；公网使用必须启用 HTTPS（见下） |
| 转发 | 仅认证后的请求转发到本机 dsh web；WebSocket 升级同样要求认证 |
| 密钥 | 密码持久化于 `data/auth.json`（0600），日志不打印密码 |

## 配置

优先级：默认值 < 配置文件（`--config path.json` 或 `DSH_PHONE_AGENT_CONFIG`）< 环境变量。
字段见 [`config.example.json`](config.example.json)。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DSH_PHONE_AGENT_PORT` | 8080 | 网关监听端口 |
| `DSH_PHONE_AGENT_HOST` | 0.0.0.0 | 网关监听地址 |
| `DSH_PHONE_AGENT_TARGET` | http://127.0.0.1:3080 | 本机 dsh web 地址 |
| `DSH_PHONE_AGENT_MANAGE_WEB` | true | 目标不可达时自动启动/自愈 dsh web |
| `DSH_PHONE_AGENT_PASSWORD` | 自动生成 | 访问密码（持久化到 data/auth.json） |
| `DSH_PHONE_AGENT_SESSION_DAYS` | 30 | 「记住我」有效期（天） |
| `DSH_PHONE_AGENT_HTTPS_CERT/KEY` | — | HTTPS 证书与私钥路径 |
| `DSH_PHONE_AGENT_SCREENSHOTS_DIR` | `<DSH_HOME>/screenshots` | 截图归档目录（/shots 画廊读取处） |
| `DSH_HARNESS_ROOT` | ../deepseek-harness | 托管模式定位 deepseek-harness 检出 |

## 可靠性设计

- **转发自愈**：目标不可达 → 502 明确提示；托管模式自动拉起 dsh web
  （探测就绪 + 崩溃重启 + 转发失败触发自愈）。
- **WebSocket 透传**：upgrade 请求双向管道，无应用层缓冲，下行流不断流。
- **优雅退出**：SIGINT/SIGTERM → 停止托管子进程 → 关闭监听。
- **登录限速**：防暴力破解；所有失败 fail-closed。

## 已知限制

- 认证网关只控制"谁能访问"；agent 的权限（沙箱、审批）由 dsh web 自身的
  permission presets 管理（默认 workspace-write + ask，手机端浏览器可正常审批）。
- 局域网 HTTP 明文传输密码 cookie；校园网/公网场景务必走 HTTPS（见上文）。
- 托管启动的 dsh web 会话数据在 deepseek-harness 检出的默认位置
  （`DSH_HOME` 会话目录），与手动实例共享。

## 项目结构

```
phone-agent/
├── server.mjs            # 入口：认证路由 + 反向代理 + WebSocket 升级 + /shots 画廊
├── lib/auth.mjs          # 密码认证 + 持久 cookie + 限速
├── lib/proxy.mjs         # HTTP/WebSocket 转发 + dsh web 托管自愈
├── lib/config.mjs        # 配置加载（文件+环境变量）
├── web/index.html        # 手机友好登录页
├── plugins/screen-tool/  # 屏幕监视插件（screenshot/list_windows + 技能）
├── tests/tool-test.mjs   # screen-tool 单元级测试（fake ctx）
├── config.example.json   # 配置示例
├── web-remote.patch.yml  # dsh web 手机端补丁（目录选择器）
└── data/                 # auth.json（密码）、运行时数据（不入库）
```

---

# dsh-phone-agent — Mobile Access Gateway for DeepSeek Harness


Log in from your phone's browser to get the **exact same** DeepSeek Harness UI and all its
features as on desktop (sessions, tool calls, approvals, settings, etc.), with **persistent
login**: check "Remember me" and you stay logged in for 30 days — refreshing the page or
restarting the browser won't ask for the password again.

> **中文版:** [README.md](README.md)

## Architecture

```
┌──────────┐  HTTP + WebSocket  ┌───────────────────────┐   Reverse proxy   ┌────────────────────┐
│  Mobile   │ ─────────────────▶ │  phone-agent auth GW  │ ────────────────▶ │  dsh web (original) │
│  browser  │  password login    │ (server.mjs, zero-dep)│  rewrite Host/    │  127.0.0.1:3080     │
│(login+GUI)│  / remember me     │                       │  Origin to loopback│                    │
└──────────┘  persistent cookie  └───────────────────────┘                   └────────────────────┘
```

- **Why a gateway?** dsh web ships with no authentication layer, and its `/api`
  browser-trust fence only accepts loopback access (`--host 0.0.0.0` is intentionally
  unsupported). So dsh web always listens on 127.0.0.1; phone-agent handles authentication
  on the outside and forwards requests in (rewriting Host/Origin to the loopback authority
  to satisfy the fence).
- **Frontend:** it IS the original dsh web single page (`window.__DSH_BOOT__` injected),
  100% identical UI and features — no custom replacement UI.
- **Channels:** HTTP (streams request bodies of any size) + WebSocket upgrade (dsh web's
  `/api/events.mux` and `/api/events.host` downstream streams).

## Usage

### 1. Start the gateway

Prerequisites: Node.js ^22.19 || >=24; dsh web running locally
(`cd deepseek-harness && node --import tsx/esm apps/cli/src/bin.ts web`), or enable managed
mode (`manageWeb: true`, default) and let the gateway spawn it.

```sh
cd <phone-agent project dir>
node server.mjs
```

On startup the console prints the access address and the access password (auto-generated on
first run and persisted to `data/auth.json`; stable across restarts. You can also customize
it via `DSH_PHONE_AGENT_PASSWORD` or the config file).

### 2. Log in from your phone

Open `http://<computer-ip>:8080` in the phone browser:

1. Enter the access password ("Remember me" is checked by default → 30 days without login)
2. You are in the original DeepSeek Harness UI, identical to desktop
3. Refreshing or reopening the browser won't ask for the password again

### 3. Access addresses by scenario

| Scenario | Address | Notes |
|---|---|---|
| Same Wi-Fi / phone hotspot | `http://<LAN-IP>:8080` | Simplest, LAN only |
| Remote access (recommended) | `http://<Tailscale IP>:8080` | Tailscale mesh: free, encrypted, no public IP needed |
| Public internet | cloudflared / ngrok tunnel | See "Public access", use HTTPS + strong password |

> **Campus network note:** campus networks often enable AP isolation, so phone↔PC access may
> not work. Reliable alternatives: tether via the phone's hotspot, or use Tailscale.

### 4. Logout

Log out from the UI, or clear the browser cookies; the session ends.

## Mobile adaptations (two automatic fixes)

1. **Missing `crypto.randomUUID`:** when the phone browser accesses over HTTP on a LAN
   (a non-secure context), `crypto.randomUUID` is not exposed and dsh web's frontend
   (e.g. attachment drafts) throws `crypto.randomUUID is not a function`. The gateway
   automatically injects an equivalent polyfill (same RFC 4122 v4 algorithm as dsh web's
   own) when forwarding the HTML entry document — no frontend changes needed.
2. **Workspace picker:** dsh web's `directory-picker-auto` resolves to the native backend on
   loopback listening, which relies on the browser File System Access API
   (`showDirectoryPicker`) — unsupported on mobile, so the phone couldn't pick a local
   workspace. When the gateway hosts dsh web it automatically applies `web-remote.patch.yml`
   (disables auto, mounts the browse backend: RPC directory-tree browsing, works in any
   browser).

> When starting dsh web manually, pass the same patch:
> `node --import tsx/esm apps/cli/src/bin.ts web --patch <phone-agent project dir>\web-remote.patch.yml`

## Managed mode (optional)

With `manageWeb: true` (default), if the target dsh web is unreachable the gateway
automatically spawns one from the sibling deepseek-harness checkout (crash-restart,
self-healing on forwarding failures). It won't double-start if a manual instance exists.
Change the port with the `target` option.

## Security model

| Layer | Measure |
|---|---|
| Access auth | Password login (timing-safe compare) + HttpOnly/SameSite=Lax cookie; per-IP login rate limit (5/min) |
| Session persistence | "Remember me" → 30-day persistent cookie (default on); otherwise 24h session-level; sliding renewal for active users |
| Network | Listens on `0.0.0.0` by default (LAN); HTTPS required for public exposure (below) |
| Forwarding | Only authenticated requests are forwarded to local dsh web; WebSocket upgrades require auth too |
| Secrets | Password persisted in `data/auth.json` (0600); never printed in logs |

## Public access (optional)

1. Prepare a certificate and private key (self-signed or terminate TLS via reverse proxy).
2. Configure `httpsCert` / `httpsKey` (or `DSH_PHONE_AGENT_HTTPS_CERT/KEY`); the service then
   listens over HTTPS.
3. Map it to a public domain with a tunnel (frp / cloudflared / ngrok etc.).

```sh
cloudflared tunnel --url https://127.0.0.1:8080
```

When exposing publicly, always use: **a strong password, HTTPS, and only trusted domains**.

## Configuration

Precedence: defaults < config file (`--config path.json` or `DSH_PHONE_AGENT_CONFIG`) <
environment variables. See [`config.example.json`](config.example.json).

| Env var | Default | Description |
|---|---|---|
| `DSH_PHONE_AGENT_PORT` | 8080 | Gateway listen port |
| `DSH_PHONE_AGENT_HOST` | 0.0.0.0 | Gateway listen address |
| `DSH_PHONE_AGENT_TARGET` | http://127.0.0.1:3080 | Local dsh web address |
| `DSH_PHONE_AGENT_MANAGE_WEB` | true | Auto start/self-heal dsh web when target unreachable |
| `DSH_PHONE_AGENT_PASSWORD` | auto-generated | Access password (persisted in data/auth.json) |
| `DSH_PHONE_AGENT_SESSION_DAYS` | 30 | "Remember me" validity (days) |
| `DSH_PHONE_AGENT_HTTPS_CERT/KEY` | — | HTTPS certificate and private key paths |
| `DSH_HARNESS_ROOT` | ../deepseek-harness | Locate the deepseek-harness checkout for managed mode |

## Reliability design

- **Forwarding self-healing:** target unreachable → explicit 502; managed mode auto-spawns
  dsh web (readiness probe + crash restart + self-heal on forwarding failure).
- **WebSocket pass-through:** bidirectional pipe on upgrade, no application-layer buffering,
  downstream streams never stall.
- **Graceful shutdown:** SIGINT/SIGTERM → stop managed child → close listener.
- **Login rate limit:** anti-brute-force; all failures fail closed.

## Known limitations

- The auth gateway only controls "who can access"; agent permissions (sandbox, approvals) are
  managed by dsh web's own permission presets (default workspace-write + ask; the mobile
  browser can approve normally).
- LAN HTTP transmits the password cookie in plaintext; always use HTTPS for campus/public
  networks (above).
- Session data of the managed dsh web lives in the default location of the
  deepseek-harness checkout (`DSH_HOME` session dir), shared with manual instances.

## Project structure

```
phone-agent/
├── server.mjs            # Entry: auth routes + reverse proxy + WebSocket upgrade
├── lib/auth.mjs          # Password auth + persistent cookie + rate limit
├── lib/proxy.mjs         # HTTP/WebSocket forwarding + dsh web managed self-healing
├── lib/config.mjs        # Config loading (file + env vars)
├── web/index.html        # Mobile-friendly login page
├── config.example.json   # Example config
├── web-remote.patch.yml  # dsh web mobile patch (directory picker)
└── data/                 # auth.json (password), runtime data (not committed)
```
