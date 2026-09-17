param([string]$Target)
$ErrorActionPreference = 'Stop'
# Test-only incompatible reader: deliberately deny delete sharing.
$stream = [IO.FileStream]::new($Target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  [Console]::WriteLine('ready')
  [Console]::Out.Flush()
  if ([Console]::ReadLine() -ne 'release') { throw 'Expected release' }
} finally { $stream.Dispose() }
