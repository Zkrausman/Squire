import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { windowsLaunch } from "../../src/personal/windows-launch.js";

/** Windows TEMP may grant sandbox identities Modify. Never weaken the policy
 * for fixtures: create a fresh protected child under a validated home chain. */
export async function launchTestRoot(prefix: string): Promise<string> {
  if (process.platform !== "win32") return mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(os.homedir(), `${prefix}${randomUUID()}`);
  const seed = path.join(root, "fixture-seed");
  windowsLaunch().persist(seed, "", "fixture");
  await rm(seed);
  return root;
}
export function powershell(script: string, ...args: string[]): string {
  // Arguments are passed as environment data, never interpolated shell code.
  const systemRoot = process.env["SystemRoot"];
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("ACL probes require an absolute Windows SystemRoot");
  const home = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0");
  // GitHub's pwsh shell exports its PSModulePath to Node. Passing that path to
  // Windows PowerShell 5 can select incompatible PowerShell 7 system modules.
  // Neither executable nor module resolution may use inherited search paths.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["PSMODULEPATH", "PSHOME"].includes(key.toUpperCase())));
  env["PSModulePath"] = path.join(home, "Modules");
  env["SQUIRE_ACL_ARGS"] = JSON.stringify(args);
  const source = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules'); Import-Module ([IO.Path]::Combine($env:PSModulePath,'Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop; Import-Module ([IO.Path]::Combine($env:PSModulePath,'Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1')) -ErrorAction Stop; $p=ConvertFrom-Json $env:SQUIRE_ACL_ARGS; ${script}`;
  return execFileSync(path.join(home, "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], { env, encoding: "utf8", timeout: 15_000 }).trim();
}
export function acl(file: string): { owner: string; protected: boolean; rules: { sid: string; rights: number; inherited: boolean }[] } {
  return JSON.parse(powershell(`$a=Get-Acl -LiteralPath $p[0]; [pscustomobject]@{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; protected=$a.AreAccessRulesProtected; rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;inherited=$_.IsInherited} })} | ConvertTo-Json -Depth 4 -Compress`, file));
}
export function grant(file: string, sid: string, rights: string, inherit = false): void {
  powershell(`$a=Get-Acl -LiteralPath $p[0]; $s=[System.Security.Principal.SecurityIdentifier]::new($p[1]); $r=[System.Security.AccessControl.FileSystemRights]$p[2]; $i=if($p[3] -eq 'true'){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None}; $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($s,$r,$i,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)); Set-Acl -LiteralPath $p[0] -AclObject $a`, file, sid, rights, String(inherit));
}
export function assertProtectedAcl(file: string): void {
  const a = acl(file);
  const current = powershell(`[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value`);
  const expected = [current, "S-1-5-18", "S-1-5-32-544"].sort();
  const actual = [...new Set(a.rules.map(r => r.sid))].sort();
  if (!a.protected || a.owner !== current || JSON.stringify(actual) !== JSON.stringify(expected) || a.rules.some(r => r.inherited || r.rights !== 2032127)) {
    throw new Error(`unexpected protected DACL for ${file}: ${JSON.stringify(a)}`);
  }
}
