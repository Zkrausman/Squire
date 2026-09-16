import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Real kernel mapping, not MemoryMappedFile (which can retain a file handle).
 * The mapper proves CloseHandle succeeded, then remains writable after capture. */
export async function withWritableSourceMapping(file: string, directory: string, capture: () => Promise<void>): Promise<void> {
  const ready = path.join(directory, "mapping-ready"), signal = path.join(directory, "mapping-signal");
  const definitions = `using System; using System.Runtime.InteropServices; public static class MappingProof {
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFileW(string p,uint a,uint s,IntPtr sec,uint d,uint f,IntPtr t);
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFileMappingW(IntPtr h,IntPtr s,uint p,uint high,uint low,string name);
[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr MapViewOfFile(IntPtr h,uint a,uint high,uint low,UIntPtr n);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
[DllImport("kernel32.dll")] public static extern bool UnmapViewOfFile(IntPtr p);
}`;
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
Add-Type -TypeDefinition $env:SQUIRE_MAP_CODE; $p=ConvertFrom-Json $env:SQUIRE_MAP_ARGS;
$h=[MappingProof]::CreateFileW($p[0],3221225472,7,[IntPtr]::Zero,3,0,[IntPtr]::Zero);
if($h -eq [IntPtr](-1)) { throw 'open failed' };
$map=[MappingProof]::CreateFileMappingW($h,[IntPtr]::Zero,4,0,64,$null);
if($map -eq [IntPtr]::Zero) { throw 'map failed' };
$view=[MappingProof]::MapViewOfFile($map,2,0,0,[UIntPtr]::Zero);
if($view -eq [IntPtr]::Zero) { throw 'view failed' };
if(![MappingProof]::CloseHandle($h)) { throw 'close original handle failed' };
[IO.File]::WriteAllText($p[1],'original handle closed; writable view active');
$deadline=[DateTime]::UtcNow.AddSeconds(15);
while(![IO.File]::Exists($p[2])) { if([DateTime]::UtcNow -gt $deadline) { throw 'signal timeout' }; Start-Sleep -Milliseconds 10 };
for($i=0;$i -lt 64;$i++) { [Runtime.InteropServices.Marshal]::WriteByte($view,$i,66) };
if(![MappingProof]::UnmapViewOfFile($view)) { throw 'unmap failed' };
if(![MappingProof]::CloseHandle($map)) { throw 'close mapping failed' };`;
  const systemRoot = process.env["SystemRoot"];
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("mapping probe needs absolute SystemRoot");
  const home = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["PSMODULEPATH", "PSHOME"].includes(key.toUpperCase())));
  env["PSModulePath"] = path.join(home, "Modules");
  env["SQUIRE_MAP_CODE"] = definitions; env["SQUIRE_MAP_ARGS"] = JSON.stringify([file, ready, signal]);
  const child = spawn(path.join(home, "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env, stdio: ["ignore", "ignore", "pipe"], timeout: 25_000 });
  let stderr = "", spawnError: Error | undefined;
  child.stderr.on("data", data => { stderr += data; }); child.on("error", error => { spawnError = error; });
  const exit = new Promise<number | null>(resolve => child.on("close", resolve));
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { assert.equal(await readFile(ready, "utf8"), "original handle closed; writable view active"); break; }
      catch (error) {
        if (spawnError || Date.now() >= deadline || (error as NodeJS.ErrnoException).code !== "ENOENT") throw spawnError ?? new Error(`mapping readiness failed: ${stderr}`, { cause: error });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    await capture();
    await writeFile(signal, "mutate after rejected capture");
    assert.equal(await exit, 0, stderr);
    assert.equal(await readFile(file, "utf8"), "B".repeat(64), "mapping remained writable after original handle closed");
  } finally { child.kill(); await exit; }
}
