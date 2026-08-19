# DeepSeek Harness - add/remove Windows Defender exclusion paths
# Invoked by the NSIS installer with elevated privileges.
# Never fails hard: if Defender is unavailable (3rd-party AV, policy), we exit 0 silently.
param(
    [string]$Paths,
    [switch]$Remove
)

$ErrorActionPreference = 'SilentlyContinue'
$paths = @($Paths -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })

if ($paths.Count -eq 0) { exit 0 }

try {
    $pref = Get-MpPreference -ErrorAction Stop
    $current = @($pref.ExclusionPath)
    foreach ($p in $paths) {
        if ($Remove) {
            if ($current -contains $p) { Remove-MpPreference -ExclusionPath $p -ErrorAction SilentlyContinue }
        }
        else {
            if ($current -notcontains $p) { Add-MpPreference -ExclusionPath $p -ErrorAction SilentlyContinue }
        }
    }
}
catch { }

exit 0
