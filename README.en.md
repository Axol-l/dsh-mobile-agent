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
