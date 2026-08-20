; DeepSeek Harness — 便携版：解压到临时目录运行，退出后自动清理
Unicode true
!ifndef ROOT
!define ROOT "${__FILEDIR__}\.."
!endif
; 打包源目录：默认 dist\DeepSeekHarness；编译时可用 /DSRCDIR 覆盖为短路径（避免 pnpm 深层路径超长导致 makensis 读取失败）
!ifndef SRCDIR
!define SRCDIR "${ROOT}\dist\DeepSeekHarness"
!endif
; .pnpm 深层目录：默认随 SRCDIR；编译时可用 /DPNMDIR 覆盖为更短的独立根（路径超长时）
!ifndef PNMDIR
!define PNMDIR "${SRCDIR}\resources\harness\node_modules\.pnpm"
!endif
Name "DeepSeek Harness"
!ifndef VERSION
!define VERSION "0.1.3"
!endif
OutFile "${ROOT}\dist\DeepSeek Harness ${VERSION} Portable.exe"
RequestExecutionLevel user
Icon "${ROOT}\build\icon.ico"
SetCompressor /SOLID lzma
SetCompressorDictSize 64

; 首次运行显示"初始化"进度窗口（解压完成后自动运行）
Page instfiles

; 进度窗口：改标题提示"正在初始化"，禁用取消按钮避免中断
Function .onGUIInit
  System::Call "user32::SetWindowText(i $HWNDPARENT, t 'DeepSeek Harness - 正在初始化，请稍候（首次运行约需 3-5 分钟）')"
  System::Call "user32::GetDlgItem(i $HWNDPARENT, i 2) i .r0"
  System::Call "user32::EnableWindow(i r0, i 0)"
FunctionEnd

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "DeepSeek Harness"
VIAddVersionKey "FileDescription" "DeepSeek Harness (Portable)"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "DeepSeek"
VIAddVersionKey "LegalCopyright" "DeepSeek"

; 便携版：版本匹配则复用已解压的 app，否则重新解压（支持更新换代）；
; 运行采用 Exec（不等待），NSIS 立即退出，进度窗口随 app 启动自动消失
Function .onInit
  IfFileExists "$EXEDIR\app\DeepSeek Harness.exe" 0 do_extract
  IfFileExists "$EXEDIR\app\.version" 0 do_extract
  FileOpen $0 "$EXEDIR\app\.version" r
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "*${VERSION}*" run_app do_extract
run_app:
  Exec '"$EXEDIR\app\DeepSeek Harness.exe"'
  Abort
do_extract:
  RMDir /r "$EXEDIR\app"
FunctionEnd

Section
  ; 解压到 exe 同目录旁的 app 文件夹（不占用系统 TEMP，避免 Electron 从临时目录启动闪退）
  SetOutPath "$EXEDIR\app"
  ; 打包沙箱不允许 d3dcompiler_47.dll 以原名落盘：以别名暂存，运行时用 /oname 恢复原名
  File "/oname=d3dcompiler_47.dll" "${ROOT}\dist\extra\d3dcompiler_47_new.dll"
  File /r /x ".pnpm" /x "*.d.ts.map" /x "*.d.ts" /x "*.map" /x "*.tsbuildinfo" "${SRCDIR}\*"
  ; .pnpm 深层目录单独打包（路径超长规避：运行时仍还原到 resources\harness\node_modules\.pnpm）；npm 平铺结构（无 .pnpm）时编译需加 /DNO_PNPM=1
  !ifndef NO_PNPM
  SetOutPath "$EXEDIR\app\resources\harness\node_modules"
  File /r /x "*.d.ts.map" /x "*.d.ts" /x "*.map" /x "*.tsbuildinfo" "${PNMDIR}\*"
  SetOutPath "$EXEDIR\app"
  !endif
  ; 写入版本标记（更新换代时据此判断是否需要重新解压）
  FileOpen $0 "$EXEDIR\app\.version" w
  FileWrite $0 "${VERSION}"
  FileClose $0
  Exec '"$EXEDIR\app\DeepSeek Harness.exe"'
SectionEnd
