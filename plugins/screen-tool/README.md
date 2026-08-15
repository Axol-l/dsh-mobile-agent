# screen-tool — DeepSeek Harness 屏幕监视插件

让 agent（以及手机端的你）实时查看这台电脑的屏幕：桌面全屏或指定窗口，
截图以图片形式进入会话（GUI 显示 + 模型可见），并归档到
`<DSH_HOME>/screenshots/`。

```
plugins/screen-tool/
├── capture.ps1            # 截图引擎（PowerShell 5.1 + System.Drawing/Win32）
├── src/index.ts           # DSH 插件：screenshot + list_windows 两个工具
├── cordis.patch.yml       # Loader 补丁（--patch 加载本插件）
├── skill/screen-monitor/  # 可选技能（安装到 $DSH_HOME/skills）
└── README.md
```

## 工具

| 工具 | 作用 |
|---|---|
| `screenshot` | 截桌面（全部显示器）或指定窗口。参数：`reason`（必填，显示给用户审批）、`window`（标题子串）、`hwnd`（list_windows 的句柄）、`format`（png/jpeg）、`scale`（最大边长）、`include_image`（默认 true） |
| `list_windows` | 枚举可见顶层窗口（标题/hwnd/矩形/可见性），供模型挑选目标窗口 |

## 原理

- 插件零运行时依赖：服务通过 `inject: ['tools', 'attachments', 'llm']`
  注入，不 import 任何 `@deepseek-ai/*` 运行时包，因此可以放在仓库外，
  由 `--patch` 直接加载（host 以 tsx 运行，.ts 源码即改即用）。
- 图片走 DSH 官方附件通道：`ctx.attachments.saveImage()` 内容寻址持久化 →
  工具结果返回 `ImageBlock`（与内置 `read_image` 完全相同的机制）→ 会话
  历史与轨迹面板显示图片，模型后续请求可见画面。
- 模型路由未声明 image 输入时**自动降级**：截图仍成功并归档，结果带
  `note` 说明图片未嵌入（图片一旦进入会话历史就会被喂给无法承载它的
  路由，因此不能携带）；模型应引导用户去 `/shots` 画廊查看。
  显式传 `include_image: false` 可强制只记录元数据。
- 尺寸受附件限制约束（默认单图 5MB / 40M 像素）：超限自动降级
  JPEG+半尺寸重试一次。

## 安装

### 方式 A：web profile 用户层（推荐，本机已配置）

把 `cordis.patch.yml` 的 insert 内容写入 `$DSH_HOME/profiles/web/cordis.patch.yml`。
dsh web 会**热加载**（配置 HMR，无需重启），且无论托管启动还是手动启动
都生效。本机已配置好（`C:\Users\31242\.dsh\profiles\web\cordis.patch.yml`）。
其他机器重复本步骤即可。

### 方式 B：手动启动 dsh web 时用 --patch

```sh
cd <deepseek-harness 检出目录>
node --import tsx/esm apps/cli/src/bin.ts web \
  --patch <phone-agent>/web-remote.patch.yml \
  --patch <phone-agent>/plugins/screen-tool/cordis.patch.yml
```

> Windows 下 patch 内插件 name 必须写 `file:///D:/...` 形式的 URL（原生盘符
> 路径会被 ESM loader 拒绝）。若 phone-agent 仓库移动了位置，请同步修改。

## 可选：安装 screen-monitor 技能

```sh
# 复制技能到用户级技能目录（对所有会话生效）
Copy-Item -Recurse <phone-agent>\plugins\screen-tool\skill\screen-monitor `
  $env:USERPROFILE\.dsh\skills\
```

技能教模型「何时主动截图、如何描述画面、隐私边界」。不装也能用
（工具描述已含使用时机），装了对模型行为更稳。

## 手机端画廊（文本模型也能看）

DeepSeek 官方适配器是文本-only。工具会自动检测并**自动降级**：模型不支持
图片输入时，截图仍成功并归档，结果带 `note` 说明图片未嵌入（无需手动传
`include_image: false`）。此时**手机浏览器打开网关画廊即可实时查看**：

```
http://<电脑IP>:8080/shots
```

- 登录后自动列出最新截图（新→旧），每 8 秒自动刷新（实时监视）；
- 点任意缩略图看原图；
- 归档目录可用 `DSH_PHONE_AGENT_SCREENSHOTS_DIR` 环境变量改（默认
  `<DSH_HOME>/screenshots`，与插件写入路径一致）；
- 换用支持图片输入的模型后，截图会直接以图片块进入会话（GUI 轨迹面板
  显示 + 模型可见画面），画廊仍可作历史回看。

## 验证

1. 启动后日志出现 `[screen-tool] plugin loaded`。
2. 在会话里说「截个图看看屏幕」→ 出现审批 → 同意后：
   - 图片模型：图片直接进入对话（轨迹面板可见）；
   - 文本模型：agent 告知文件已保存，打开 `/shots` 画廊查看。
3. `list_windows` 可先用来自查窗口标题。
4. 自动化回归：`node --import tsx/esm <repo>/tests/tool-test.mjs`
   （需在 deepseek-harness 检出目录运行；fake ctx 走真实 capture.ps1，
   覆盖桌面/窗口/JPEG 缩放/元数据/自动降级/窗口列表）。

## 常见问题

- **为什么对话里看不到截图图片？** 当前模型（DeepSeek 官方适配器）为
  文本-only，图片无法进入会话。看画面用 `/shots` 画廊；换图片模型后
  自动以图片块进入对话。
- **为什么第一次截图会看到一条报错？** 运行中的 dsh web 若加载的是
  旧版插件（严格门禁），文本模型下会先报"模型不支持图片输入"，模型
  随即自动改用 `include_image: false` 重试成功。新版已自动降级，重启
  dsh web 后不再出现。
- **怎么定时/持续监视？** 对 agent 说「每 N 秒截一张图」，它会循环调用
  `screenshot`，画廊每 8 秒自动刷新，即可看到动态画面。
- **截图存在哪里？** `<DSH_HOME>/screenshots/`（可用
  `DSH_PHONE_AGENT_SCREENSHOTS_DIR` 改画廊目录，需与插件写入路径一致）。

## 安全说明

- 截图是敏感操作：默认审批策略下每次调用都要用户（手机端）确认。
- 归档目录 `<DSH_HOME>/screenshots/` 请勿共享给他人；如需关闭归档，
  可自行改 `src/index.ts` 中的归档逻辑。
- 画廊页面在网关认证之后（未登录访问 `/shots` 返回 401）。
- 仅支持 Windows（capture.ps1 依赖 System.Drawing + user32）。

## 已知限制

- 窗口截图 = 该窗口当前屏幕区域（被遮挡部分不可见）；最小化窗口无法截图。
- 硬件加速/独占全屏（如部分游戏、视频播放器全屏）可能截到黑屏或空白，
  此时请改用桌面全屏截图。
- 多显示器：桌面模式为所有显示器拼接图；窗口模式按窗口所在显示器位置截取。
