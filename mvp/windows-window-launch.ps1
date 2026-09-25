param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$SnapshotPath
)

# Start a separate console-owning process, then let the window hide only its own
# console. Direct DETACHED_PROCESS makes Windows PowerShell exit before the GUI starts.
$windowScript = Join-Path $PSScriptRoot 'windows-window.ps1'
$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', "`"$windowScript`"", '-Root', "`"$Root`"",
    '-NodePath', "`"$NodePath`"", '-SnapshotPath', "`"$SnapshotPath`""
)
Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WindowStyle Normal | Out-Null
