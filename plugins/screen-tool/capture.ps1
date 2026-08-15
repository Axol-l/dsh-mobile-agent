# capture.ps1 — DSH screen-tool 插件的截图引擎（Windows）
#
# 模式：
#   1) 默认：捕获整个虚拟桌面（所有显示器拼接）；
#   2) -Window <子串>：按标题子串匹配最上层可见窗口，捕获其屏幕区域；
#   3) -Hwnd <十进制句柄>：按窗口句柄捕获（可用 -ListWindows 枚举）；
#   4) -ListWindows：枚举可见顶层窗口并输出 JSON（不截图）。
#
# 输出：仅 stdout 一行 JSON（ConvertTo-Json -Compress），例如：
#   {"ok":true,"file":"...","source":"desktop","width":1920,"height":1080,"bytes":123456}
#   {"ok":false,"error":"...","matches":[{"hwnd":"12345","title":"..."}]}
# 任何失败都以 ok:false 返回，绝不向 stdout 混入其他文本（日志走 stderr）。
#
# 用法示例：
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture.ps1 -OutFile C:\x\s.png
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture.ps1 -OutFile C:\x\s.jpg -Jpeg
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture.ps1 -Window "Chrome" -OutFile C:\x\w.png
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture.ps1 -ListWindows

param(
  [string]$OutFile = '',
  [string]$Window = '',
  [string]$Hwnd = '',
  [switch]$ListWindows,
  [int]$MaxDimension = 0,
  [switch]$Jpeg,
  [int]$JpegQuality = 85
)

$ErrorActionPreference = 'Stop'

# stdout 强制 UTF-8：Node 侧按 UTF-8 解析 JSON（否则中文标题在 GBK 代码页下会乱码）
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# Win32 辅助：窗口枚举 / 矩形 / DPI 感知 / 虚拟屏幕 / 抓屏 / 缩放 / 编码
# 注意：-ReferencedAssemblies 必须显式给出，否则部分环境下 C# 编译器
# 找不到 System.Drawing.Imaging 命名空间。
Add-Type -ReferencedAssemblies @('System.Drawing.dll', 'System.Windows.Forms.dll') -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;

public static class ScreenCapNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public struct WinInfo {
    public long Hwnd;
    public string Title;
    public string ClassName;
    public int Left;
    public int Top;
    public int Width;
    public int Height;
    public bool Visible;
    public bool Minimized;
  }

  private const int SM_XVIRTUALSCREEN = 76;
  private const int SM_YVIRTUALSCREEN = 77;
  private const int SM_CXVIRTUALSCREEN = 78;
  private const int SM_CYVIRTUALSCREEN = 79;

  public static RECT VirtualScreenRect() {
    RECT r;
    r.Left = GetSystemMetrics(SM_XVIRTUALSCREEN);
    r.Top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    r.Right = r.Left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
    r.Bottom = r.Top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
    return r;
  }

  public static string TitleOf(IntPtr h) {
    StringBuilder sb = new StringBuilder(1024);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }

  public static string ClassOf(IntPtr h) {
    StringBuilder sb = new StringBuilder(256);
    GetClassName(h, sb, sb.Capacity);
    return sb.ToString();
  }

  public static System.Collections.Generic.List<WinInfo> ListWindows() {
    var list = new System.Collections.Generic.List<WinInfo>();
    EnumWindowsProc cb = (h, l) => {
      string t = TitleOf(h);
      if (t.Length == 0) return true; // 只列有标题的窗口
      RECT r;
      GetWindowRect(h, out r);
      var w = new WinInfo();
      w.Hwnd = h.ToInt64();
      w.Title = t;
      w.ClassName = ClassOf(h);
      w.Left = r.Left; w.Top = r.Top;
      w.Width = r.Right - r.Left; w.Height = r.Bottom - r.Top;
      w.Visible = IsWindowVisible(h);
      w.Minimized = IsIconic(h);
      list.Add(w);
      return true;
    };
    EnumWindows(cb, IntPtr.Zero);
    return list;
  }

  public static Bitmap CaptureRect(int x, int y, int w, int h) {
    var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) {
      g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
    }
    return bmp;
  }

  // PrintWindow：抓取窗口自身内容（即使被其他窗口遮挡）。
  // 对硬件加速/独占全屏窗口可能返回全黑 → 调用方应回退 CaptureRect。
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

  public static Bitmap CaptureWindow(IntPtr hWnd, out bool ok) {
    RECT r;
    if (!GetWindowRect(hWnd, out r)) { ok = false; return null; }
    int w = r.Right - r.Left, h = r.Bottom - r.Top;
    if (w <= 0 || h <= 0) { ok = false; return null; }
    var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) {
      IntPtr hdc = g.GetHdc();
      bool printed = PrintWindow(hWnd, hdc, 3); // PW_RENDERFULLCONTENT
      g.ReleaseHdc(hdc);
      if (!printed) { bmp.Dispose(); ok = false; return null; }
    }
    // 内容校验：几乎全黑且无高亮 = PrintWindow 未实际渲染（如硬件加速窗口）
    int dark = 0;
    const int n = 200;
    long maxV = 0;
    var rnd = new Random(7);
    for (int i = 0; i < n; i++) {
      var c = bmp.GetPixel(rnd.Next(0, w), rnd.Next(0, h));
      int v = (c.R + c.G + c.B) / 3;
      if (v < 15) dark++;
      if (v > maxV) maxV = v;
    }
    if (dark > n * 0.99 && maxV < 20) { bmp.Dispose(); ok = false; return null; }
    ok = true;
    return bmp;
  }

  private static ImageCodecInfo GetEncoder(ImageFormat fmt) {
    foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders()) {
      if (codec.FormatID == fmt.Guid) return codec;
    }
    return null;
  }

  public static int[] Save(Bitmap bmp, string path, bool jpeg, int quality, int maxDim) {
    int finalW = bmp.Width, finalH = bmp.Height;
    if (maxDim > 0) {
      int w = bmp.Width, h = bmp.Height;
      int m = Math.Max(w, h);
      if (m > maxDim) {
        double s = (double)maxDim / m;
        int nw = Math.Max(1, (int)Math.Round(w * s));
        int nh = Math.Max(1, (int)Math.Round(h * s));
        var scaled = new Bitmap(nw, nh, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(scaled)) {
          g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
          g.DrawImage(bmp, 0, 0, nw, nh);
        }
        bmp.Dispose();
        bmp = scaled;
        finalW = nw; finalH = nh;
      }
    }
    if (jpeg) {
      var enc = GetEncoder(ImageFormat.Jpeg);
      var ep = new EncoderParameters(1);
      ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
      bmp.Save(path, enc, ep);
    } else {
      bmp.Save(path, ImageFormat.Png);
    }
    bmp.Dispose();
    return new int[] { finalW, finalH };
  }
}
'@

# DPI 感知：让 GetWindowRect/CopyFromScreen 使用物理像素
[void][ScreenCapNative]::SetProcessDPIAware()

function EmitJson($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
}

try {
  if ($ListWindows) {
    $list = [ScreenCapNative]::ListWindows()
    $rows = foreach ($w in $list) {
      [ordered]@{
        hwnd       = [string]$w.Hwnd
        title      = $w.Title
        className  = $w.ClassName
        left       = $w.Left
        top        = $w.Top
        width      = $w.Width
        height     = $w.Height
        visible    = $w.Visible
        minimized  = $w.Minimized
      }
    }
    EmitJson ([ordered]@{ ok = $true; mode = 'list'; windows = @($rows) })
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($OutFile)) {
    EmitJson ([ordered]@{ ok = $false; error = 'OutFile is required' })
    exit 2
  }
  $outDir = Split-Path -Parent $OutFile
  if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

  $source = 'desktop'
  $title = ''
  $hwndVal = [long]0

  if ($Hwnd) {
    if (-not [long]::TryParse($Hwnd, [ref]$hwndVal)) {
      EmitJson ([ordered]@{ ok = $false; error = "invalid hwnd: $Hwnd" })
      exit 2
    }
    $source = 'window'
  } elseif ($Window) {
    $all = [ScreenCapNative]::ListWindows()
    # 大小写不敏感的子串匹配（不能用 -like：标题里的通配符会破坏匹配）
    $matches = @($all | Where-Object {
      $_.Visible -and -not $_.Minimized -and
      $_.Title.IndexOf($Window, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if ($matches.Count -eq 0) {
      $any = @($all | Where-Object { $_.Title.IndexOf($Window, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
      if ($any.Count -eq 0) {
        EmitJson ([ordered]@{ ok = $false; error = "no top-level window whose title contains '$Window'" })
      } elseif ($any.Count -eq 1 -and $any[0].Minimized) {
        EmitJson ([ordered]@{ ok = $false; error = "window '$($any[0].Title)' is minimized; restore it or capture the desktop" })
      } else {
        $rows = foreach ($w in $any) {
          [ordered]@{ hwnd = [string]$w.Hwnd; title = $w.Title; minimized = $w.Minimized; visible = $w.Visible }
        }
        EmitJson ([ordered]@{ ok = $false; error = "matching window(s) are not capturable (hidden/minimized)"; matches = @($rows) })
      }
      exit 3
    }
    if ($matches.Count -gt 1) {
      $rows = foreach ($w in $matches) {
        [ordered]@{ hwnd = [string]$w.Hwnd; title = $w.Title }
      }
      EmitJson ([ordered]@{ ok = $false; error = "multiple windows match '$Window'; retry with hwnd"; matches = @($rows) })
      exit 3
    }
    $hwndVal = [long]$matches[0].Hwnd
    $title = $matches[0].Title
    $source = 'window'
  }

  if ($source -eq 'window') {
    $hPtr = [IntPtr]$hwndVal
    if ($title -eq '') { $title = [ScreenCapNative]::TitleOf($hPtr) }
    $rect = New-Object ScreenCapNative+RECT
    if (-not [ScreenCapNative]::GetWindowRect($hPtr, [ref]$rect)) {
      EmitJson ([ordered]@{ ok = $false; error = "GetWindowRect failed for hwnd $hwndVal (window may have closed)" })
      exit 3
    }
    if ([ScreenCapNative]::IsIconic($hPtr)) {
      EmitJson ([ordered]@{ ok = $false; error = "window '$title' is minimized; restore it or capture the desktop" })
      exit 3
    }
    $x = $rect.Left; $y = $rect.Top
    $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
  } else {
    $vs = [ScreenCapNative]::VirtualScreenRect()
    $x = $vs.Left; $y = $vs.Top
    $w = $vs.Right - $vs.Left; $h = $vs.Bottom - $vs.Top
  }

  if ($w -le 0 -or $h -le 0) {
    EmitJson ([ordered]@{ ok = $false; error = "capture region is empty (${w}x${h})" })
    exit 4
  }

  $bmp = $null
  $capMethod = 'screen-region'
  if ($source -eq 'window') {
    # PrintWindow 抓窗口自身内容（被遮挡也正确）；失败（硬件加速/全屏等）回退屏幕区域
    $okFlag = $false
    $bmp = [ScreenCapNative]::CaptureWindow($hPtr, [ref]$okFlag)
    if ($okFlag) {
      $capMethod = 'print-window'
    } else {
      $rect2 = New-Object ScreenCapNative+RECT
      [void][ScreenCapNative]::GetWindowRect($hPtr, [ref]$rect2)
      $bmp = [ScreenCapNative]::CaptureRect($rect2.Left, $rect2.Top, $rect2.Right - $rect2.Left, $rect2.Bottom - $rect2.Top)
    }
  } else {
    $bmp = [ScreenCapNative]::CaptureRect($x, $y, $w, $h)
  }
  $dims = [ScreenCapNative]::Save($bmp, $OutFile, [bool]$Jpeg, $JpegQuality, $MaxDimension)

  $fi = Get-Item $OutFile
  EmitJson ([ordered]@{
    ok      = $true
    file    = $OutFile
    source  = $source
    title   = $title
    hwnd    = if ($source -eq 'window') { [string]$hwndVal } else { '' }
    width   = $dims[0]
    height  = $dims[1]
    bytes   = $fi.Length
    method  = $capMethod
  })
  exit 0
} catch {
  EmitJson ([ordered]@{ ok = $false; error = $_.Exception.Message })
  exit 5
}
