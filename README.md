# phone-agent — DeepSeek Harness 手机访问网关

手机浏览器登录后获得与桌面端**完全一致**的 DeepSeek Harness 原版界面与全部功能
（会话、工具调用、审批、设置等），并支持**持久登录**：勾选「记住我」后 30 天
免登录，刷新页面、重启浏览器都不再重输密码。

## 架构

```
┌──────────┐  HTTP + WebSocket  ┌───────────────────────┐   反向代理    ┌────────────────────┐
│  手机浏览器 │ ─────────────────▶ │  phone-agent 认证网关   │ ────────────▶ │  dsh web (原版 GUI)  │
│ (登录页+GUI)│  密码登录/记住我    │ (server.mjs, 零依赖)    │  改写 Host/Origin │  127.0.0.1:3080     │
└──────────┘  cookie 持久会话    └───────────────────────┘                └────────────────────┘
```

- **为什么需要网关**：dsh web 官方不提供认证层，且 `/api` 的 browser-trust fence
  只接受 loopback 访问（`--host 0.0.0.0` 被有意不支持）。因此 dsh web 始终监听
  127.0.0.1，由 phone-agent 在外部承担认证，并把请求转发进去（改写 Host/Origin
  为 loopback authority 以满足 fence）。
- **前端**：就是 dsh web 原版单页（`window.__DSH_BOOT__` 注入），UI 与功能 100%
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
| 公网访问 | cloudflared / ngrok 隧道 | 见「公网访问模式」，务必 HTTPS + 强密码 |

> **校园网提示**：校园网普遍启用 AP 隔离，手机与电脑互访常不可行。
> 可靠替代：手机开热点让电脑连接，或使用 Tailscale 组网。

### 4. 登出

在界面中登出，或清空浏览器 cookie，会话即失效。

## 手机端适配（两项自动修复）

1. **`crypto.randomUUID` 缺失**：手机浏览器经 HTTP 局域网访问属于非安全上下文，
   `crypto.randomUUID` 不被暴露，dsh web 前端（附件草稿等）会报
   `crypto.randomUUID is not a function`。网关在转发 HTML 主文档时自动注入
   等价 polyfill（与 dsh web 自带实现相同的 RFC 4122 v4 算法），无需改前端。
2. **工作区选择器**：dsh web 的 `directory-picker-auto` 在 loopback 监听下
   解析为 native 后端，依赖浏览器 File System Access API（`showDirectoryPicker`），
   手机浏览器不支持 → 手机端无法选择本机工作区。网关托管 dsh web 时自动叠加
   `web-remote.patch.yml`（禁用 auto、挂 browse 后端：RPC 目录树浏览，
   任何浏览器可用）。

> 手动启动 dsh web 时请带上同一补丁：
> `node --import tsx/esm apps/cli/src/bin.ts web --patch <phone-agent 项目目录>\web-remote.patch.yml`

## 托管模式（可选）

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

## 公网访问模式（可选）

1. 准备证书与私钥（自签或反向代理终结 TLS）。
2. 配置 `httpsCert` / `httpsKey`（或 `DSH_PHONE_AGENT_HTTPS_CERT/KEY`），
   服务即以 HTTPS 监听。
3. 用内网穿透（frp / cloudflared / ngrok 等）映射到公网域名。

```sh
cloudflared tunnel --url https://127.0.0.1:8080
```

公网暴露时请务必：**强密码、HTTPS、仅对可信域名开放**。

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
├── server.mjs            # 入口：认证路由 + 反向代理 + WebSocket 升级
├── lib/auth.mjs          # 密码认证 + 持久 cookie + 限速
├── lib/proxy.mjs         # HTTP/WebSocket 转发 + dsh web 托管自愈
├── lib/config.mjs        # 配置加载（文件+环境变量）
├── web/index.html        # 手机友好登录页
├── config.example.json   # 配置示例
├── web-remote.patch.yml  # dsh web 手机端补丁（目录选择器）
└── data/                 # auth.json（密码）、运行时数据（不入库）
```
