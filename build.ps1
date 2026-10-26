<#
  打包脚本：产出 dist\ 目录（方案 B：壳 exe + 外部代码）

  用法：
    .\build.ps1                 跑测试 + 组装 dist + 需要时构建 exe
    .\build.ps1 -SkipTests      跳过测试（不建议）
    .\build.ps1 -RebuildExe     强制重新构建 WeiBoListener.exe
    .\build.ps1 -IncludeEnv     把当前 .env 一起复制进 dist（仅本地验证用）

  设计要点：
    - exe 里只有 shell\launcher.cjs 这个启动器，业务代码在 dist\app\。
    - 日常更新只需要替换 dist\app\ 里的文件，exe 不用重新打包、不用重新下载 80MB。
    - exe 只在「换 Node 版本 / 改启动器逻辑 / 首次打包」时重建。
#>
param(
  [switch]$SkipTests,
  [switch]$RebuildExe,
  [switch]$IncludeEnv
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$dist = Join-Path $root 'dist'
$appDir = Join-Path $dist 'app'
$exe = Join-Path $dist 'WeiBoListener.exe'

function Write-Step($text) { Write-Host ""; Write-Host "== $text ==" -ForegroundColor Cyan }

# ---------------------------------------------------------------- 1. 测试门禁
if (-not $SkipTests) {
  Write-Step '运行测试'
  npm test 2>&1 | Select-Object -Last 8
  if ($LASTEXITCODE -ne 0) {
    throw "测试未通过（exit $LASTEXITCODE），已中止打包"
  }
  Write-Host '测试通过' -ForegroundColor Green
}

# ---------------------------------------------------------------- 2. 组装 app/
Write-Step '组装 dist\app'
New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $appDir) { Remove-Item $appDir -Recurse -Force }
New-Item -ItemType Directory -Force $appDir | Out-Null

Copy-Item (Join-Path $root 'src\*.js') $appDir
Copy-Item (Join-Path $root 'src\admin.html') $appDir
Copy-Item (Join-Path $root '.env.example') $dist -Force
Copy-Item (Join-Path $root 'config.example.json') $dist -Force
Copy-Item (Join-Path $root 'packaging\first-run.txt') (Join-Path $dist '首次使用.txt') -Force
if ($IncludeEnv -and (Test-Path (Join-Path $root '.env'))) {
  Copy-Item (Join-Path $root '.env') $dist -Force
  Write-Host '已复制 .env（仅本地验证）' -ForegroundColor Yellow
}

$appFiles = Get-ChildItem $appDir -File
Write-Host ("app/ 共 {0} 个文件，{1:N0} KB" -f $appFiles.Count, (($appFiles | Measure-Object Length -Sum).Sum / 1KB))

# ---------------------------------------------------------------- 3. 构建 exe
if ($RebuildExe -or -not (Test-Path $exe)) {
  Write-Step '构建 WeiBoListener.exe（SEA）'

  $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $nodeExe) { throw '找不到 node.exe，请确认 Node 已安装并在 PATH 里' }

  $tools = Join-Path $env:LOCALAPPDATA 'WeiBoListener-build'
  New-Item -ItemType Directory -Force $tools | Out-Null

  $postjectCli = Join-Path $tools 'node_modules\postject\dist\cli.js'
  if (-not (Test-Path $postjectCli)) {
    Write-Host '安装构建工具 postject（只需一次）…'
    Push-Location $tools
    try {
      npm init -y 2>&1 | Out-Null
      npm i --silent postject 2>&1 | Select-Object -Last 3
    } finally { Pop-Location }
    if (-not (Test-Path $postjectCli)) { throw 'postject 安装失败' }
  }

  $blob = Join-Path $tools 'launcher.blob'
  $seaConfig = Join-Path $tools 'sea-config.json'
  $config = [ordered]@{
    main                          = (Join-Path $root 'shell\launcher.cjs')
    output                        = $blob
    disableExperimentalSEAWarning = $true
  }
  $config | ConvertTo-Json | Set-Content -Path $seaConfig -Encoding utf8

  node --experimental-sea-config $seaConfig
  if ($LASTEXITCODE -ne 0) { throw '生成 SEA blob 失败' }

  Copy-Item $nodeExe $exe -Force
  node $postjectCli $exe NODE_SEA_BLOB $blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 2>&1 | Select-Object -Last 3
  if ($LASTEXITCODE -ne 0) { throw '注入 SEA blob 失败' }
} else {
  Write-Host '已存在 WeiBoListener.exe，跳过构建（需要重建请加 -RebuildExe）' -ForegroundColor Yellow
}

# ---------------------------------------------------------------- 4. 汇总
Write-Step '完成'
$exeSize = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host ("输出目录：{0}" -f $dist)
Write-Host ("  WeiBoListener.exe  {0} MB   （壳，极少变动）" -f $exeSize)
Write-Host ("  app\               {0} 个文件   （业务代码，日常更新只换这里）" -f $appFiles.Count)
Write-Host  "  .env.example      配置模板"
Write-Host  "  首次使用.txt       给用户的说明"
if (-not (Test-Path (Join-Path $dist 'config.json'))) {
  Write-Host "  （没有 config.json：首次运行会自动打开配置面板）" -ForegroundColor DarkGray
}
