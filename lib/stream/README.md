# lib/stream — 直播模块（自建帧流：屏幕 + 摄像头）

手机端实时监控工作机的模块化实现：**ffmpeg 抓帧 → MJPEG 帧流 → 手机浏览器**。
零 npm 依赖；`config.live.enabled=false` 时整体 no-op，不影响网关其他功能。

```
lib/stream/
├── index.mjs     # 模块入口：装配 Source → MjpegStream → HTTP 路由；按需启停
├── capture.mjs   # 帧捕获源抽象（Source 接口）+ ffmpeg 子进程管理 + JPEG 切帧
├── mjpeg.mjs     # multipart/x-mixed-replace 输出器 + 订阅者管理（背压合并）
├── devices.mjs   # 摄像头/音频设备枚举（ffmpeg dshow -list_devices，30s 缓存）
└── README.md
```

## 路由（全部在网关认证之后，未登录 401）

| 路由 | 说明 |
|---|---|
| `GET /live` | 直播页（`web/live.html`） |
| `GET /live/screen.mjpg` | 屏幕 MJPEG 流（multipart/x-mixed-replace） |
| `GET /live/cam.mjpg` | 摄像头 MJPEG 流（页面点"开启摄像头"才请求） |
| `GET /api/live/devices` | dshow 视频/音频设备清单（30s 缓存） |
| `GET /api/live/status` | 运行状态（进程/订阅数/设备/错误） |

## 架构

```
手机浏览器 ──> phone-agent:8080（认证网关）
                 ├── /live               直播页（fetch + canvas，兼容 iOS Safari）
                 ├── /live/screen.mjpg   MJPEG 流
                 └── /live/cam.mjpg      MJPEG 流

工作机：
  ffmpeg(gdigrab 抓屏)  ──stdout──> FfmpegSource ──'frame'──> MjpegStream ──> 所有订阅者
  ffmpeg(dshow 抓摄像头) ──stdout──> FfmpegSource ──'frame'──> MjpegStream ──> 所有订阅者
```

关键设计：
- **按需启停**：有订阅者才启动对应 ffmpeg，全部断开 3s 后自动停止（`STOP_DEBOUNCE_MS`）。
- **单实例共享**：多手机同时观看只跑一份 ffmpeg，帧缓冲广播。
- **摄像头隐私**：直播页默认全关（屏幕/摄像头都不自动起流），点图标按钮
  才起流；摄像头同样手动开启。
- **摄像头健壮性**：`device: "auto"` 时枚举取第一个视频设备；两档重试——
  先按 `camera.width` 请求分辨率（不强制帧率），失败或无帧自动降为
  「原生档」（不指定分辨率/帧率，由设备协商，输出端 `fps,scale` 滤镜控
  带宽）。实测对"仅支持 1920x1080@30"的摄像头也能正常工作。
- **模块化**：捕获后端实现 `FfmpegSource` 同一接口即可替换（如 PowerShell
  后端、MediaFoundation、OBS 虚拟摄像头），上层分发/路由不用改。

## 配置（config.json 的 live 段）

```json
"live": {
  "enabled": true,
  "ffmpegPath": "tools/ffmpeg/bin/ffmpeg.exe",
  "screen": { "fps": 5, "width": 1280, "quality": 5 },
  "camera": { "device": "auto", "fps": 10, "width": 640, "quality": 5 }
}
```

- `ffmpegPath`：portable ffmpeg 绝对/相对路径（相对项目根）。
- `camera.device`：`"auto"` 或写死 dshow 设备名（用 `/api/live/devices` 查）。
- 环境变量 `DSH_PHONE_AGENT_LIVE=0` 可整体禁用。

## ffmpeg 获取（portable，免安装）

```powershell
# 方法一：本项目脚本（Node fetch，走 OpenSSL TLS，沙箱内可用）
node scripts/download-ffmpeg.mjs
# 方法二：手动下载静态构建解压，确保 ffmpeg.exe 位于 tools/ffmpeg/bin/
#   https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
#   https://github.com/BtbN/FFmpeg-Builds/releases/latest
```

`tools/` 已加入 `.gitignore`（二进制不入库）。

## 验证

1. 启动网关：`npm start`（或 `node server.mjs`）。
2. 本机/手机浏览器登录后访问 `http://<电脑IP>:8080/live`：
   - 屏幕流应立即出画面（服务端自动拉起 ffmpeg）；
   - 点"开启摄像头"验证摄像头流；
   - 关闭页面后等 3s，`/api/live/status` 显示进程停止。
3. 未登录访问 `/live/*` 应返回 401。

## 已知限制

- 仅 Windows（gdigrab 抓屏 + dshow 摄像头）。
- RDP/锁屏会话下 gdigrab 可能黑屏（屏幕未渲染）——与截图插件行为一致。
- MJPEG 无音频；帧率建议 5~10fps（同 WiFi 带宽友好）。
- 摄像头分辨率由 `camera.width` 与设备协商；不兼容时自动降为原生档
  （设备默认分辨率/帧率），输出端仍按配置缩放、限帧。
- 浏览器端用 fetch + createImageBitmap 解码（iOS Safari 也支持）；
  `<img src="…/screen.mjpg">` 直连方式在桌面 Chrome 亦可工作。
