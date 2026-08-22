param([switch]$Portable, [string]$PreloadDir)
$ErrorActionPreference = 'Stop'
$root = 'D:\npm-global\node_modules\@deepseek-ai\dsh-desktop'
$dist = Join-Path $root 'dist'
$appDir = Join-Path $dist 'DeepSeekHarness'
$extraDir = Join-Path $dist 'extra'
$electronDist = Join-Path $root 'node_modules\electron\dist'
$node = Join-Path $root 'runtime\node.exe'
$asarCli = Join-Path $root 'node_modules\@electron\asar\bin\asar.mjs'
$staging = Join-Path $env:TEMP ('dsh-asar-staging-' + [guid]::NewGuid().ToString('N'))

# 版本号自动取自 package.json（避免每次发版改 rcedit/文件名/NSIS 多处硬编码）
$ver = ([System.IO.File]::ReadAllText((Join-Path $root 'package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json).version
$verParts = $ver.Split('.')
$ver4 = if ($verParts.Count -ge 4) { $ver } else { ($verParts + '0') -join '.' }
$setupName = "DeepSeek Harness Setup $ver.exe"

Write-Output "== [1/8] clean dist app dir =="
if (Test-Path $appDir) { Remove-Item $appDir -Recurse -Force }
if (Test-Path $extraDir) { Remove-Item $extraDir -Recurse -Force }
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
New-Item -ItemType Directory -Path $extraDir -Force | Out-Null
# 清理旧版安装包/便携版残留（避免与新版本号产物混淆）
Get-ChildItem $dist -Filter 'DeepSeek Harness*.exe' -ErrorAction SilentlyContinue | Remove-Item -Force

# [1.5/8] electron 运行时缺失时自动安装
if (-not (Test-Path -LiteralPath (Join-Path $electronDist 'electron.exe'))) {
  Write-Output "== [1.5/8] electron dist 缺失，自动执行 npm install =="
  Push-Location $root
  try {
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }
  } finally { Pop-Location }
  if (-not (Test-Path -LiteralPath (Join-Path $electronDist 'electron.exe'))) {
    throw "electron dist 仍未找到: $electronDist（请手动执行 npm install 后重试）"
  }
  Write-Output "  electron dist 就绪"
}

Write-Output "== [2/8] copy electron runtime =="
Get-ChildItem -LiteralPath $electronDist -Force | Where-Object { $_.Name -ne 'd3dcompiler_47.dll' } | Copy-Item -Destination $appDir -Recurse -Force
Rename-Item (Join-Path $appDir 'electron.exe') 'DeepSeek Harness.exe'
# 只保留中英文语言包，删除其余 locale（省约 40MB）
Get-ChildItem (Join-Path $appDir 'locales') -Filter '*.pak' -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -notin @('en-US', 'zh-CN') } | Remove-Item -Force

Write-Output "== [3/8] build app.asar from source =="
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null
Copy-Item (Join-Path $root 'app') (Join-Path $staging 'app') -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $staging 'build') -Force | Out-Null
Copy-Item (Join-Path $root 'build\icon.ico') (Join-Path $staging 'build\icon.ico') -Force
Copy-Item (Join-Path $root 'build\tray.png') (Join-Path $staging 'build\tray.png') -Force
Copy-Item (Join-Path $root 'build\tray@2x.png') (Join-Path $staging 'build\tray@2x.png') -Force
Copy-Item (Join-Path $root 'loading.html') (Join-Path $staging 'loading.html') -Force
Copy-Item (Join-Path $root 'app\error.html') (Join-Path $staging 'error.html') -Force
Copy-Item (Join-Path $root 'main.js') (Join-Path $staging 'main.js') -Force
# no-console-patch：main.js 应用与部署版一致的补丁（模板缓存由 sync-source-to-deploy 维护）
$patchCli = Join-Path $root 'build\apply-no-console-patch.mjs'
$templateCache = Join-Path $root 'build\no-console-patch-main.txt'
if (-not (Test-Path -LiteralPath $templateCache)) {
  # 模板缺失时从已补丁的 main.js 自动提取（与部署版补丁一致；未补丁的开发版会报错）
  Write-Output "  补丁模板缺失，尝试从 main.js 自动提取..."
  & $node $patchCli extract (Join-Path $root 'main.js') $templateCache
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $templateCache)) {
    throw '补丁模板生成失败：main.js 需为含 no-console 补丁的版本（或手工放置 build\no-console-patch-main.txt）'
  }
  Write-Output "  模板已生成 -> build\no-console-patch-main.txt"
}
& $node $patchCli main (Join-Path $staging 'main.js') (Join-Path $root 'harness\lib\no-console-patch.cjs') $templateCache (Join-Path $staging 'main.js')
if ($LASTEXITCODE -ne 0) { throw "apply-no-console-patch main failed: $LASTEXITCODE" }
Copy-Item (Join-Path $root 'preload.js') (Join-Path $staging 'preload.js') -Force
Copy-Item (Join-Path $root 'package.json') (Join-Path $staging 'package.json') -Force
New-Item -ItemType Directory -Path (Join-Path $staging 'harness') -Force | Out-Null
Copy-Item (Join-Path $root 'harness\package.json') (Join-Path $staging 'harness\package.json') -Force
New-Item -ItemType Directory -Path (Join-Path $staging 'harness\lib') -Force | Out-Null
# 仅复制干净 lib（排除 no-console-patch.cjs/koffi-shim.mjs/嵌套残留，与部署版 asar 一致）
foreach ($f in @('bin.js','dump-config-D-jtgwY3.js','plugin-9h8shc4d.js','profile-boot-BnJoK_kl.js','profile-boot-DG5t9aNs.js')) {
  Copy-Item (Join-Path $root "harness\lib\$f") (Join-Path $staging "harness\lib\$f") -Force
}
Copy-Item (Join-Path $root 'harness\LICENSE') (Join-Path $staging 'harness\LICENSE') -Force
Copy-Item (Join-Path $root 'harness\README.md') (Join-Path $staging 'harness\README.md') -Force
Copy-Item (Join-Path $root 'harness\README.i18n.yaml') (Join-Path $staging 'harness\README.i18n.yaml') -Force
Copy-Item (Join-Path $root 'harness\README.zh.md') (Join-Path $staging 'harness\README.zh.md') -Force
New-Item -ItemType Directory -Path (Join-Path $staging 'node_modules\js-yaml') -Force | Out-Null
Copy-Item (Join-Path $root 'harness\node_modules\js-yaml\*') (Join-Path $staging 'node_modules\js-yaml') -Recurse -Force
# 排除 .bin 包装脚本（部署版 asar 无）
Get-ChildItem (Join-Path $staging 'node_modules\js-yaml\.bin') -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $staging 'plugins') -Force | Out-Null
Copy-Item (Join-Path $root 'plugins\dsh-desktop-settings') (Join-Path $staging 'plugins\dsh-desktop-settings') -Recurse -Force

$appAsar = Join-Path $appDir 'resources\app.asar'
& $node $asarCli pack $staging $appAsar
if ($LASTEXITCODE -ne 0) { throw "asar pack failed: $LASTEXITCODE" }
Remove-Item $staging -Recurse -Force

Write-Output "== [4/8] copy harness/runtime/plugins to resources =="
$resDir = Join-Path $appDir 'resources'
Copy-Item (Join-Path $root 'harness') (Join-Path $resDir 'harness') -Recurse -Force
Copy-Item (Join-Path $root 'runtime') (Join-Path $resDir 'runtime') -Recurse -Force
Copy-Item (Join-Path $root 'plugins') (Join-Path $resDir 'plugins') -Recurse -Force
# 移除无关残留：旧版（0.1.0-rc.6）备份目录/清单，避免带进安装包
Remove-Item (Join-Path $resDir 'harness\lib.rc6') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $resDir 'harness\package.json.rc6') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $resDir 'harness\lib\lib') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $resDir 'harness\lib\.write-test.txt') -Force -ErrorAction SilentlyContinue

# 离线预装默认插件：按内置预装名单（DEFAULT_PROFILE_PLUGINS）从本机 profile 抓取插件及其依赖树，
# 平铺打进 resources/preloaded-plugins，新装用户免联网安装（ensureDefaultPlugins 检测到即离线复制）。
# 只抓名单内的插件，不包含其他已装插件/无关依赖，与源代码预装名单保持一致。
Write-Output "== [4.5/8] preload profile plugins =="
# 预装插件来源目录可用 -PreloadDir 指定（默认本机 profile；可用部署版 resources\preloaded-plugins 保证可复现）
$profileNm = if ($PreloadDir) { $PreloadDir } else { Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules' }
$preloadDir = Join-Path $resDir 'preloaded-plugins'
$preloadNames = @('@anionex/dsh-vision-toolkit', 'dsh-anchored-standard', 'dsh-at-file', 'dsh-better-sidebar')
$preloadManifest = @{}
if (Test-Path $profileNm) {
  New-Item -ItemType Directory -Path $preloadDir -Force | Out-Null
  # 递归收集名单内插件及其依赖（在 profile node_modules 中存在的包）
  $all = @{}
  $queue = @($preloadNames)
  while ($queue.Count -gt 0) {
    $n = $queue[0]
    if ($queue.Count -ge 2) { $queue = $queue[1..($queue.Count - 1)] } else { $queue = @() }
    if ($all.ContainsKey($n)) { continue }
    $all[$n] = $true
    $pj = Join-Path (Join-Path $profileNm ($n -replace '/', '\')) 'package.json'
    if (Test-Path $pj) {
      $j = Get-Content $pj -Raw | ConvertFrom-Json
      $deps = @{}
      if ($j.dependencies) { $deps = $j.dependencies }
      if ($j.optionalDependencies) { foreach ($k in $j.optionalDependencies.PSObject.Properties) { if (-not $deps.ContainsKey($k.Name)) { $deps[$k.Name] = $k.Value } } }
      foreach ($k in $deps.Keys) {
        if ($all.ContainsKey($k)) { continue }
        if (Test-Path (Join-Path $profileNm ($k -replace '/', '\'))) { $queue += $k }
      }
    }
  }
  foreach ($n in $all.Keys) {
    $src = Join-Path $profileNm ($n -replace '/', '\')
    $dest = Join-Path $preloadDir ($n -replace '/', '\')
    if (Test-Path $src) {
      New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
      Copy-Item -LiteralPath $src -Destination $dest -Recurse -Force
      $pj = Join-Path $src 'package.json'
      if (Test-Path $pj) {
        try { $preloadManifest[$n] = (Get-Content $pj -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { $preloadManifest[$n] = '?' }
      } else { $preloadManifest[$n] = '?' }
    } else {
      Write-Output ("PRELOAD_MISSING " + $n)
    }
  }
  $pc = (Get-ChildItem $preloadDir -Force | Measure-Object).Count
  Write-Output ("PRELOADED_DIRS=" + $pc)
  # 输出预装插件版本清单（可复现/追溯）
  ($preloadManifest | ConvertTo-Json) | Set-Content -LiteralPath (Join-Path $dist 'preloaded-plugins-manifest.json') -Encoding UTF8
  Write-Output ("PRELOAD_MANIFEST -> dist\preloaded-plugins-manifest.json")
} else {
  Write-Output "PRELOAD_SKIP: no profile node_modules"
}

Write-Output "== [5/8] stage d3dcompiler alias =="
Copy-Item (Join-Path $electronDist 'd3dcompiler_47.dll') (Join-Path $extraDir 'd3dcompiler_47_new.dll') -Force

Write-Output "== [6/8] rcedit exe metadata =="
$exe = Join-Path $appDir 'DeepSeek Harness.exe'
& (Join-Path $root 'build\rcedit-x64.exe') $exe --set-icon (Join-Path $root 'build\icon.ico') --set-version-string 'ProductName' 'DeepSeek Harness' --set-version-string 'FileDescription' 'DeepSeek Harness' --set-file-version $ver4 --set-product-version $ver4
if ($LASTEXITCODE -ne 0) { throw "rcedit failed: $LASTEXITCODE" }

Write-Output "== [7/8] makensis =="
Push-Location $root
try {
  & (Join-Path $root 'build\tools\nsis\Bin\makensis.exe') /DROOT=$root /DNO_PNPM=1 /DVERSION=$ver /V2 (Join-Path $root 'build\installer.nsi')
  if ($LASTEXITCODE -ne 0) { throw "makensis failed: $LASTEXITCODE" }
} finally {
  Pop-Location
}

Write-Output "== [8/8] verify output =="
$setup = Join-Path $dist $setupName
if (-not (Test-Path $setup)) { throw "setup exe not found: $setupName" }
$fi = Get-Item $setup
Write-Output ("SETUP_PATH=" + $fi.FullName)
Write-Output ("SETUP_SIZE=" + $fi.Length)
Write-Output ("SETUP_MTIME=" + $fi.LastWriteTime.ToString('s'))

$srcFiles = @(
  'preload.js',
  'plugins\dsh-desktop-settings\lib\client.js',
  'plugins\dsh-desktop-settings\lib\index.js',
  'plugins\dsh-desktop-settings\lib\checkpoints.cjs'
)
# 白屏防护：asar 必须包含 /app（启动页/设置页等），缺失会导致启动白屏
& $node -e "const fs=require('fs');const b=fs.readFileSync(process.argv[1]);const h=b.readUInt32LE(12);const j=JSON.parse(b.slice(16,16+h).toString('latin1'));const has=!!j.files.app;console.log('APP_DIR_PRESENT='+has);if(!has)process.exit(3);" $appAsar
if ($LASTEXITCODE -ne 0) { throw "asar 缺少 /app 目录，打包中止（会白屏）" }
$verifyAsar = Join-Path $env:TEMP ('dsh-asar-verify-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $verifyAsar -Force | Out-Null
Push-Location $verifyAsar
try {
  foreach ($f in $srcFiles) {
    $leaf = Split-Path $f -Leaf
    & $node $asarCli extract-file $appAsar $f | Out-Null
    $srcHash = (Get-FileHash (Join-Path $root $f)).Hash
    $asarHash = (Get-FileHash (Join-Path $verifyAsar $leaf)).Hash
    Write-Output ("HASH " + $f + " match=" + ($srcHash -eq $asarHash))
    Remove-Item (Join-Path $verifyAsar $leaf) -Force
  }
} finally {
  Pop-Location
  Remove-Item $verifyAsar -Recurse -Force
}
# main.js 为补丁产物：源码+补丁 与 asar 内比对
$patchMain = Join-Path $env:TEMP 'dsh-pack-main.js'
& $node $patchCli main (Join-Path $root 'main.js') (Join-Path $root 'harness\lib\no-console-patch.cjs') $templateCache $patchMain
if ($LASTEXITCODE -ne 0) { throw "apply-no-console-patch main failed: $LASTEXITCODE" }
$srcMainHash = (Get-FileHash $patchMain).Hash
Remove-Item $patchMain -Force
Push-Location $verifyAsar
try {
  & $node $asarCli extract-file $appAsar main.js | Out-Null
} finally { Pop-Location }
$asarMainHash = (Get-FileHash (Join-Path $verifyAsar 'main.js')).Hash
Write-Output ("HASH main.js(patched) match=" + ($srcMainHash -eq $asarMainHash))

# 构建元数据（版本 / git 提交 / 构建时间 / 预装插件版本）
$commit = ''
try { $commit = (& git -C $root rev-parse --short HEAD 2>$null | Out-String).Trim() } catch { }
$buildInfo = @{
  name = 'dsh-desktop'
  version = $ver
  commit = $commit
  builtAt = (Get-Date).ToString('s')
  arch = 'x64'
  preloadedPlugins = $preloadManifest
} | ConvertTo-Json
$buildInfo | Set-Content -LiteralPath (Join-Path $dist 'build-info.json') -Encoding UTF8
Write-Output ("BUILD_INFO -> dist\build-info.json (commit=" + $commit + ")")


# 始终生成便携版（与安装版共用同一份装配目录，仅 NSIS 脚本不同）
$portableName = "DeepSeek Harness $ver Portable.exe"
Write-Output "== [8/8b] makensis portable =="
& (Join-Path $root 'build\tools\nsis\Bin\makensis.exe') /DROOT=$root /DNO_PNPM=1 /DVERSION=$ver /V2 (Join-Path $root 'build\portable.nsi')
if ($LASTEXITCODE -ne 0) { throw "makensis portable failed: $LASTEXITCODE" }
$portableOut = Join-Path $dist $portableName
if (-not (Test-Path $portableOut)) { throw "portable exe not found: $portableName" }
$pfi = Get-Item $portableOut
Write-Output ("PORTABLE_PATH=" + $pfi.FullName)
Write-Output ("PORTABLE_SIZE=" + $pfi.Length)

Write-Output "PACK_DONE"


