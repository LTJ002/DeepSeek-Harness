param([switch]$Portable)
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

Write-Output "== [2/8] copy electron runtime =="
Get-ChildItem -LiteralPath $electronDist -Force | Where-Object { $_.Name -ne 'd3dcompiler_47.dll' } | Copy-Item -Destination $appDir -Recurse -Force
Rename-Item (Join-Path $appDir 'electron.exe') 'DeepSeek Harness.exe'

Write-Output "== [3/8] build app.asar from source =="
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null
# 妯℃澘 asar 涓㈠け鍚庢敼涓轰粠婧愮爜鐩存帴鏋勫缓锛歛sar 鍐呴渶瑕佸叆鍙ｉ鏋讹紝
# harness/node_modules 绛夊畬鏁翠緷璧栫敱 [4/8] 鏁翠綋澶嶅埗鍒?resources\harness銆?
Copy-Item (Join-Path $root 'app') (Join-Path $staging 'app') -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $staging 'build') -Force | Out-Null
Copy-Item (Join-Path $root 'build\icon.ico') (Join-Path $staging 'build\icon.ico') -Force
Copy-Item (Join-Path $root 'build\tray.png') (Join-Path $staging 'build\tray.png') -Force
Copy-Item (Join-Path $root 'build\tray@2x.png') (Join-Path $staging 'build\tray@2x.png') -Force
Copy-Item (Join-Path $root 'loading.html') (Join-Path $staging 'loading.html') -Force
Copy-Item (Join-Path $root 'app\error.html') (Join-Path $staging 'error.html') -Force
Copy-Item (Join-Path $root 'main.js') (Join-Path $staging 'main.js') -Force
Copy-Item (Join-Path $root 'preload.js') (Join-Path $staging 'preload.js') -Force
Copy-Item (Join-Path $root 'package.json') (Join-Path $staging 'package.json') -Force
New-Item -ItemType Directory -Path (Join-Path $staging 'harness') -Force | Out-Null
Copy-Item (Join-Path $root 'harness\package.json') (Join-Path $staging 'harness\package.json') -Force
Copy-Item (Join-Path $root 'harness\lib') (Join-Path $staging 'harness\lib') -Recurse -Force
Copy-Item (Join-Path $root 'harness\LICENSE') (Join-Path $staging 'harness\LICENSE') -Force
Copy-Item (Join-Path $root 'harness\README.md') (Join-Path $staging 'harness\README.md') -Force
Copy-Item (Join-Path $root 'harness\README.i18n.yaml') (Join-Path $staging 'harness\README.i18n.yaml') -Force
Copy-Item (Join-Path $root 'harness\README.zh.md') (Join-Path $staging 'harness\README.zh.md') -Force
New-Item -ItemType Directory -Path (Join-Path $staging 'node_modules\js-yaml') -Force | Out-Null
Copy-Item (Join-Path $root 'harness\node_modules\js-yaml\*') (Join-Path $staging 'node_modules\js-yaml') -Recurse -Force
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

# 离线预装默认插件：把本机 profile 已装的插件（含依赖，junction 解引用为平铺副本）
# 打进 resources/preloaded-plugins，新装用户免联网安装（ensureDefaultPlugins 检测到即离线复制）
# 用户卸载后写入禁用名单，启动不再强制装回（自由卸载）
Write-Output "== [4.5/8] preload profile plugins =="
$profileNm = Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules'
$preloadDir = Join-Path $resDir 'preloaded-plugins'
if (Test-Path $profileNm) {
  New-Item -ItemType Directory -Path $preloadDir -Force | Out-Null
  Get-ChildItem -LiteralPath $profileNm -Force | Where-Object {
    $_.Name -notin @('.pnpm', '.bin', '.cache', '.ignored_dsh-desktop-settings', 'dsh-desktop-settings', 'node-addon-api', 'node-pty') -and
    $_.Name -notlike 'mermaid_tmp_*'
  } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $preloadDir -Recurse -Force
  }
  $pc = (Get-ChildItem $preloadDir -Force | Measure-Object).Count
  Write-Output ("PRELOADED_DIRS=" + $pc)
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
  'main.js',
  'preload.js',
  'plugins\dsh-desktop-settings\lib\client.js',
  'plugins\dsh-desktop-settings\lib\index.js',
  'plugins\dsh-desktop-settings\lib\checkpoints.cjs'
)
# 鐧藉睆闃叉姢锛歛sar 蹇呴』鍖呭惈 /app锛堝惎鍔ㄩ〉/璁剧疆椤电瓑锛夛紝缂哄け浼氬鑷村惎鍔ㄧ櫧灞?
& $node -e "const fs=require('fs');const b=fs.readFileSync(process.argv[1]);const h=b.readUInt32LE(12);const j=JSON.parse(b.slice(16,16+h).toString('latin1'));const has=!!j.files.app;console.log('APP_DIR_PRESENT='+has);if(!has)process.exit(3);" $appAsar
if ($LASTEXITCODE -ne 0) { throw "asar 缂哄皯 /app 鐩綍锛屾墦鍖呬腑姝紙浼氱櫧灞忥級" }
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


