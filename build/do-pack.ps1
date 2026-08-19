$ErrorActionPreference = 'Stop'
$root = 'D:\npm-global\node_modules\@deepseek-ai\dsh-desktop'
$dist = Join-Path $root 'dist'
$appDir = Join-Path $dist 'DeepSeekHarness'
$extraDir = Join-Path $dist 'extra'
$electronDist = Join-Path $root 'node_modules\electron\dist'
$node = Join-Path $root 'runtime\node.exe'
$asarCli = Join-Path $root 'node_modules\@electron\asar\bin\asar.mjs'
$staging = Join-Path $env:TEMP ('dsh-asar-staging-' + [guid]::NewGuid().ToString('N'))

Write-Output "== [1/8] clean dist app dir =="
if (Test-Path $appDir) { Remove-Item $appDir -Recurse -Force }
if (Test-Path $extraDir) { Remove-Item $extraDir -Recurse -Force }
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
New-Item -ItemType Directory -Path $extraDir -Force | Out-Null

Write-Output "== [2/8] copy electron runtime =="
Get-ChildItem -LiteralPath $electronDist -Force | Where-Object { $_.Name -ne 'd3dcompiler_47.dll' } | Copy-Item -Destination $appDir -Recurse -Force
Rename-Item (Join-Path $appDir 'electron.exe') 'DeepSeek Harness.exe'

Write-Output "== [3/8] build app.asar from source =="
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null
# 模板 asar 丢失后改为从源码直接构建：asar 内需要入口骨架，
# harness/node_modules 等完整依赖由 [4/8] 整体复制到 resources\harness。
Copy-Item (Join-Path $root 'app') (Join-Path $staging 'app') -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $staging 'build') -Force | Out-Null
Copy-Item (Join-Path $root 'build\icon.ico') (Join-Path $staging 'build\icon.ico') -Force
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

Copy-Item (Join-Path $root 'plugins\dsh-desktop-settings\lib\client.js') (Join-Path $staging 'plugins\dsh-desktop-settings\lib\client.js') -Force
Copy-Item (Join-Path $root 'plugins\dsh-desktop-settings\lib\index.js') (Join-Path $staging 'plugins\dsh-desktop-settings\lib\index.js') -Force
Copy-Item (Join-Path $root 'plugins\dsh-desktop-settings\lib\checkpoints.cjs') (Join-Path $staging 'plugins\dsh-desktop-settings\lib\checkpoints.cjs') -Force

$appAsar = Join-Path $appDir 'resources\app.asar'
& $node $asarCli pack $staging $appAsar
if ($LASTEXITCODE -ne 0) { throw "asar pack failed: $LASTEXITCODE" }
Remove-Item $staging -Recurse -Force

Write-Output "== [4/8] copy harness/runtime/plugins to resources =="
$resDir = Join-Path $appDir 'resources'
Copy-Item (Join-Path $root 'harness') (Join-Path $resDir 'harness') -Recurse -Force
Copy-Item (Join-Path $root 'runtime') (Join-Path $resDir 'runtime') -Recurse -Force
Copy-Item (Join-Path $root 'plugins') (Join-Path $resDir 'plugins') -Recurse -Force

Write-Output "== [5/8] stage d3dcompiler alias =="
Copy-Item (Join-Path $electronDist 'd3dcompiler_47.dll') (Join-Path $extraDir 'd3dcompiler_47_new.dll') -Force

Write-Output "== [6/8] rcedit exe metadata =="
$exe = Join-Path $appDir 'DeepSeek Harness.exe'
& (Join-Path $root 'build\rcedit-x64.exe') $exe --set-icon (Join-Path $root 'build\icon.ico') --set-version-string 'ProductName' 'DeepSeek Harness' --set-version-string 'FileDescription' 'DeepSeek Harness Setup' --set-file-version '0.1.2.0' --set-product-version '0.1.2.0'
if ($LASTEXITCODE -ne 0) { throw "rcedit failed: $LASTEXITCODE" }

Write-Output "== [7/8] makensis =="
Push-Location $root
try {
  & (Join-Path $root 'build\tools\nsis\Bin\makensis.exe') /DROOT=$root /V2 (Join-Path $root 'build\installer.nsi')
  if ($LASTEXITCODE -ne 0) { throw "makensis failed: $LASTEXITCODE" }
} finally {
  Pop-Location
}

Write-Output "== [8/8] verify output =="
$setup = Join-Path $dist 'DeepSeek Harness Setup 0.1.0.exe'
if (-not (Test-Path $setup)) { throw 'setup exe not found' }
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

Write-Output "PACK_DONE"
