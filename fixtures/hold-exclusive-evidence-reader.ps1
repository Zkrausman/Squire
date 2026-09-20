param([string]$Target)
$ErrorActionPreference = 'Stop'
# Test-only unreadability, not ownership: open existing bytes without writing.
$stream = [IO.FileStream]::new($Target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
try {
  [Console]::WriteLine('ready')
  [Console]::Out.Flush()
  if ([Console]::ReadLine() -ne 'release') { throw 'Expected release' }
} finally { $stream.Dispose() }
