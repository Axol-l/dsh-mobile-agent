# phone-agent Windows 启动脚本：从同级 deepseek-harness 仓库根 .env 加载凭据后启动服务。
# 用法：.\start.ps1  [--config config.json]
param(
  [string]$Config
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$HarnessRoot = Join-Path (Split-Path -Parent $ProjectRoot) 'deepseek-harness'

# 从 deepseek-harness 仓库根 .env 加载凭据（简单解析，不覆盖已设置的环境变量）
$envFile = Join-Path $HarnessRoot '.env'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
      $key, $value = $line.Split('=', 2)
      if (-not [Environment]::GetEnvironmentVariable($key)) {
        [Environment]::SetEnvironmentVariable($key, $value)
      }
    }
  }
}

if (-not $env:DEEPSEEK_API_KEY) {
  Write-Host '[phone-agent] 警告：未检测到 DEEPSEEK_API_KEY（可写入 deepseek-harness 根 .env 或设置环境变量）' -ForegroundColor Yellow
}

Push-Location $ProjectRoot
try {
  if ($Config) {
    node server.mjs --config $Config
  } else {
    node server.mjs
  }
} finally {
  Pop-Location
}
