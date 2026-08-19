; DeepSeek Harness — Windows 安装包脚本（手工 NSIS，免 electron-builder）
Unicode true
!include "MUI2.nsh"

!define PRODUCT "DeepSeek Harness"
!define VERSION "0.1.2"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepSeekHarness"
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

Name "${PRODUCT}"
OutFile "${ROOT}\dist\DeepSeek Harness Setup 0.1.2.exe"
InstallDir "$LOCALAPPDATA\Programs\DeepSeekHarness"
; 需要管理员权限：安装完成后添加 Windows Defender 排除项，避免冷启动被实时扫描拖慢
RequestExecutionLevel admin
SetCompressor /SOLID lzma
SetCompressorDictSize 64
Icon "${ROOT}\build\icon.ico"
UninstallIcon "${ROOT}\build\icon.ico"
!define MUI_ICON "${ROOT}\build\icon.ico"
!define MUI_UNICON "${ROOT}\build\icon.ico"

VIProductVersion "0.1.2.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "FileDescription" "${PRODUCT} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "DeepSeek"
VIAddVersionKey "LegalCopyright" "DeepSeek"

!define MUI_FINISHPAGE_RUN "$INSTDIR\DeepSeek Harness.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动 ${PRODUCT}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "install"
  SetOutPath "$INSTDIR"
  ; 打包沙箱不允许 d3dcompiler_47.dll 以原名落盘：以别名暂存，安装时用 /oname 恢复原名
  File "/oname=d3dcompiler_47.dll" "${ROOT}\dist\extra\d3dcompiler_47_new.dll"
  File /r /x ".pnpm" /x "*.d.ts.map" /x "*.d.ts" /x "*.map" /x "*.tsbuildinfo" "${SRCDIR}\*"
  ; .pnpm 深层目录单独打包（路径超长规避：安装位置仍还原到 resources\harness\node_modules\.pnpm）；npm 平铺结构（无 .pnpm）时编译需加 /DNO_PNPM=1
  !ifndef NO_PNPM
  SetOutPath "$INSTDIR\resources\harness\node_modules"
  File /r /x "*.d.ts.map" /x "*.d.ts" /x "*.map" /x "*.tsbuildinfo" "${PNMDIR}\*"
  SetOutPath "$INSTDIR"
  !endif
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; 添加 Windows Defender 排除项（安装器已是管理员权限；失败静默，绝不阻塞安装）
  ; 排除安装目录（含 resources\harness\node_modules）与用户数据目录 ~/.dsh（含 profile 插件）
  ReadEnvStr $0 "DSH_HOME"
  StrCmp $0 "" "" +2
  StrCpy $0 "$USERPROFILE\.dsh"
  StrCpy $1 "$INSTDIR;$0"
  SetOutPath "$PLUGINSDIR"
  File "/oname=add-defender-exclusion.ps1" "${ROOT}\build\add-defender-exclusion.ps1"
  ExecWait '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\add-defender-exclusion.ps1" -Paths "$1"' $2
  SetOutPath "$INSTDIR"

  CreateDirectory "$SMPROGRAMS\${PRODUCT}"
  CreateShortcut "$SMPROGRAMS\${PRODUCT}\${PRODUCT}.lnk" "$INSTDIR\DeepSeek Harness.exe"
  CreateShortcut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\DeepSeek Harness.exe"

  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "DeepSeek"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section "uninstall"
  ; 移除安装时添加的 Windows Defender 排除项
  ReadEnvStr $0 "DSH_HOME"
  StrCmp $0 "" "" +2
  StrCpy $0 "$USERPROFILE\.dsh"
  StrCpy $1 "$INSTDIR;$0"
  SetOutPath "$PLUGINSDIR"
  File "/oname=add-defender-exclusion.ps1" "${ROOT}\build\add-defender-exclusion.ps1"
  ExecWait '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\add-defender-exclusion.ps1" -Paths "$1" -Remove' $2
  SetOutPath "$INSTDIR"

  Delete "$SMPROGRAMS\${PRODUCT}\${PRODUCT}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT}"
  Delete "$DESKTOP\${PRODUCT}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTKEY}"
SectionEnd
