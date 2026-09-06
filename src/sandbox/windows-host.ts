import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants, fstatSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { isCanonicalHostPath, sameHostPath } from "./host-platform.js";
import { SbxCommandError } from "./sbx-command.js";

const MAX_TOOL_OUTPUT = 256 * 1024;
const PROCESS_QUERY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$id = [int]$args[0]",
  "$p = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $id)",
  "if ($null -eq $p) { '{\"status\":\"exited\"}' } else {",
  "  $created = $null",
  "  if ($null -ne $p.CreationDate) { $created = ([Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate)).ToUniversalTime().ToString('o') }",
  "  [ordered]@{ status = 'alive'; pid = [int]$p.ProcessId; startTime = $created; executable = [string]$p.ExecutablePath; commandLine = [string]$p.CommandLine } | ConvertTo-Json -Compress",
  "}",
].join("\n");
const ACL_QUERY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$acl = Get-Acl -LiteralPath $args[0]",
  "$items = @($acl.Access | ForEach-Object { [ordered]@{ identity = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = $_.FileSystemRights.ToString(); inheritance = $_.InheritanceFlags.ToString(); propagation = $_.PropagationFlags.ToString() } })",
  "[ordered]@{ owner = $acl.Owner; access = $items } | ConvertTo-Json -Compress -Depth 5",
].join("\n");

export interface WindowsProcessSnapshot {
  readonly status: "alive" | "exited";
  readonly pid?: number;
  readonly startTime?: string;
  readonly executable?: string;
  readonly commandLine?: string;
}

export interface WindowsFileSnapshot {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly realPath: string;
}

function fail(message: string, cause?: unknown): never { throw new SbxCommandError(`${message}${cause instanceof Error ? `: ${cause.message}` : ""}`); }
function systemRoot(): string {
  const value = process.env["SystemRoot"] ?? process.env["WINDIR"];
  if (typeof value !== "string" || !isCanonicalHostPath(value, false, "win32")) fail("Windows SystemRoot is not a canonical local path");
  return value;
}
function systemTool(name: string): string {
  if (!/^[A-Za-z0-9._-]+\.exe$/u.test(name)) fail("Windows system tool name is not fixed");
  const target = path.win32.join(systemRoot(), "System32", name);
  if (!isCanonicalHostPath(target, false, "win32")) fail("Windows system tool path is not canonical");
  return target;
}
function windowsEnvironment(): Record<string, string> {
  const root = systemRoot();
  const temp = process.env["TEMP"] ?? process.env["TMP"];
  if (typeof temp !== "string" || !isCanonicalHostPath(temp, false, "win32")) fail("Windows temporary directory is not a canonical local path");
  return { SystemRoot: root, WINDIR: root, TEMP: temp, TMP: temp, PATH: path.win32.join(root, "System32"), LANG: "C", LC_ALL: "C", MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" };
}
function encoded(script: string): string { return Buffer.from(script, "utf16le").toString("base64"); }
function boundedArgv(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 32 || argv.some(value => typeof value !== "string" || value.length === 0 || value.length > 32_768 || /[\u0000-\u001f\u007f\r\n]/u.test(value))) fail("Windows trusted tool argv is not bounded");
}
function decodeOutput(bytes: Buffer, label: string): string {
  if (bytes.length > MAX_TOOL_OUTPUT) fail(`${label} output exceeds its bound`);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { fail(`${label} output is not UTF-8`, error); }
}
function runToolSync(executable: string, argv: readonly string[], label: string): string {
  boundedArgv(argv);
  const result = spawnSync(executable, [...argv], { shell: false, windowsHide: true, env: windowsEnvironment(), encoding: "buffer", timeout: 10_000, maxBuffer: MAX_TOOL_OUTPUT });
  if (result.error) fail(`${label} could not run`, result.error);
  if (result.status !== 0 || result.signal) fail(`${label} failed with ${result.status ?? result.signal ?? "unknown"}`);
  return decodeOutput(Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""), label);
}
function runTool(executable: string, argv: readonly string[], label: string): Promise<string> {
  boundedArgv(argv);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...argv], { shell: false, windowsHide: true, env: windowsEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let settled = false;
    const finish = (error?: Error, value?: string): void => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value ?? ""); };
    const collect = (target: Buffer[]): ((chunk: Buffer) => void) => chunk => { bytes += chunk.length; if (bytes > MAX_TOOL_OUTPUT) { child.kill(); finish(new SbxCommandError(`${label} output exceeds its bound`)); return; } target.push(Buffer.from(chunk)); };
    child.stdout?.on("data", collect(stdout)); child.stderr?.on("data", collect(stderr)); child.once("error", error => finish(new SbxCommandError(`${label} could not run: ${error.message}`)));
    const timer = setTimeout(() => { child.kill(); finish(new SbxCommandError(`${label} timed out`)); }, 10_000);
    child.once("exit", (code, signal) => { if (code !== 0 || signal) { finish(new SbxCommandError(`${label} failed with ${code ?? signal ?? "unknown"}`)); return; } try { finish(undefined, decodeOutput(Buffer.concat(stdout), label)); } catch (error) { finish(error instanceof Error ? error : new SbxCommandError(String(error))); } });
  });
}
function parseSnapshot(text: string, pid: number): WindowsProcessSnapshot {
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch (error) { fail("Windows process query was not JSON", error); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Windows process query shape is invalid");
  const record = value as Record<string, unknown>;
  if (record["status"] === "exited") return { status: "exited" };
  if (record["status"] !== "alive" || record["pid"] !== pid || typeof record["startTime"] !== "string" || !Number.isFinite(Date.parse(record["startTime"])) || typeof record["executable"] !== "string" || typeof record["commandLine"] !== "string") fail("Windows process query identity is incomplete");
  if (!isCanonicalHostPath(record["executable"], false, "win32")) fail("Windows process executable path is not canonical");
  return { status: "alive", pid, startTime: record["startTime"], executable: record["executable"], commandLine: record["commandLine"] };
}
export function queryWindowsProcessSync(pid: number): WindowsProcessSnapshot {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 4_194_304) fail("Windows process ID is invalid");
  const output = runToolSync(systemTool("WindowsPowerShell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded(PROCESS_QUERY_SCRIPT), String(pid)], "Windows process identity query");
  return parseSnapshot(output, pid);
}
export async function queryWindowsProcess(pid: number): Promise<WindowsProcessSnapshot> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 4_194_304) fail("Windows process ID is invalid");
  const output = await runTool(systemTool("WindowsPowerShell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded(PROCESS_QUERY_SCRIPT), String(pid)], "Windows process identity query");
  return parseSnapshot(output, pid);
}

function splitWindowsCommandLine(commandLine: string): string[] {
  const result: string[] = []; let index = 0;
  while (index < commandLine.length) {
    while (index < commandLine.length && /\s/u.test(commandLine[index]!)) index += 1;
    if (index >= commandLine.length) break;
    let value = ""; let quoted = false;
    while (index < commandLine.length) {
      let slashes = 0; while (index < commandLine.length && commandLine[index] === "\\") { slashes += 1; index += 1; }
      if (index < commandLine.length && commandLine[index] === '"') {
        value += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) { value += '"'; index += 1; }
        else { quoted = !quoted; index += 1; }
        continue;
      }
      value += "\\".repeat(slashes);
      if (index >= commandLine.length || !quoted && /\s/u.test(commandLine[index]!)) break;
      value += commandLine[index]!; index += 1;
    }
    result.push(value);
  }
  return result;
}
export function assertWindowsProcessArgv(snapshot: WindowsProcessSnapshot, executable: string, argv: readonly string[]): void {
  if (snapshot.status !== "alive" || !snapshot.commandLine || !isCanonicalHostPath(executable, false, "win32")) fail("Windows process is not live for argv verification");
  boundedArgv(argv);
  const actual = splitWindowsCommandLine(snapshot.commandLine);
  if (actual.length !== argv.length + 1 || !sameHostPath(actual[0]!, executable) || actual.slice(1).some((value, index) => value !== argv[index])) fail("Windows process argv identity changed");
}
export function windowsProcessStartTime(pid: number): string {
  const snapshot = queryWindowsProcessSync(pid);
  if (snapshot.status !== "alive" || !snapshot.startTime) fail("Windows process start identity is unavailable");
  return String(Date.parse(snapshot.startTime));
}
export async function windowsProcessStartTimeAsync(pid: number): Promise<string> {
  const snapshot = await queryWindowsProcess(pid);
  if (snapshot.status !== "alive" || !snapshot.startTime) fail("Windows process start identity is unavailable");
  return String(Date.parse(snapshot.startTime));
}

export async function assertWindowsNoReparsePath(target: string, label: string, allowMissing = false): Promise<void> {
  if (!isCanonicalHostPath(target, true, "win32")) fail(`${label} is not a canonical Windows path`);
  const root = path.win32.parse(target).root; let current = root;
  for (const part of target.slice(root.length).split("\\").filter(Boolean)) {
    current = path.win32.join(current, part);
    const info = await lstat(current).catch(error => { if (error?.code === "ENOENT" && allowMissing) return undefined; throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) fail(`${label} contains a symbolic link or reparse point`);
    if (current !== target && !info.isDirectory()) fail(`${label} has a non-directory ancestor`);
    const resolved = await realpath(current);
    if (!sameHostPath(resolved, current)) fail(`${label} contains a redirected path component`);
  }
}

function sameWindowsFileSnapshot(left: WindowsFileSnapshot, right: WindowsFileSnapshot): boolean { return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && sameHostPath(left.realPath, right.realPath); }
async function snapshotWindowsFile(handle: import("node:fs/promises").FileHandle, target: string): Promise<WindowsFileSnapshot> {
  const info = await handle.stat();
  if (!info.isFile() || info.size < 0 || info.size > 256 * 1024 * 1024) fail("Windows file is not a bounded regular file");
  const resolved = await realpath(target);
  if (!sameHostPath(resolved, target)) fail("Windows file path was redirected");
  return { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, realPath: resolved };
}
export async function readWindowsStableFile(target: string, maxBytes: number, label: string): Promise<Buffer> {
  await assertWindowsNoReparsePath(target, label);
  const handle = await open(target, constants.O_RDONLY);
  try {
    const before = await snapshotWindowsFile(handle, target);
    if (before.size > maxBytes) fail(`${label} exceeds its bound`);
    const bytes = Buffer.allocUnsafe(before.size); let offset = 0;
    while (offset < before.size) { const read = await handle.read(bytes, offset, before.size - offset, offset); if (read.bytesRead <= 0) fail(`${label} ended during a bounded read`); offset += read.bytesRead; }
    const after = await snapshotWindowsFile(handle, target);
    if (!sameWindowsFileSnapshot(before, after)) fail(`${label} changed during a bounded read`);
    return bytes;
  } finally { await handle.close(); }
}
export async function hashWindowsFile(target: string, maxBytes: number, label: string): Promise<string> { return createHash("sha256").update(await readWindowsStableFile(target, maxBytes, label)).digest("hex"); }
export function hashWindowsFileSync(target: string, maxBytes: number, label: string): string {
  if (!isCanonicalHostPath(target, false, "win32")) fail(`${label} is not a canonical Windows path`);
  let fd: number | undefined;
  try {
    fd = openSync(target, constants.O_RDONLY);
    const before = requireWindowsFileStat(fd, target, label);
    if (before.size > maxBytes) fail(`${label} exceeds its bound`);
    const hash = createHash("sha256"); const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, before.size))); let offset = 0;
    while (offset < before.size) { const length = Math.min(chunk.length, before.size - offset); const count = readSync(fd, chunk, 0, length, offset); if (count <= 0) fail(`${label} ended during a bounded read`); hash.update(chunk.subarray(0, count)); offset += count; }
    const after = requireWindowsFileStat(fd, target, label); if (!sameWindowsFileSnapshot(before, after)) fail(`${label} changed during a bounded read`);
    return hash.digest("hex");
  } finally { if (fd !== undefined) closeSync(fd); }
}
function requireWindowsFileStat(fd: number, target: string, label: string): WindowsFileSnapshot {
  const info = fstatSync(fd);
  if (!info.isFile() || info.size < 0 || info.size > 256 * 1024 * 1024) fail(`${label} is not a bounded regular file`);
  let resolved: string; try { resolved = realpathSync(target); } catch (error) { fail(`${label} path cannot be resolved`, error); }
  if (!sameHostPath(resolved, target)) fail(`${label} path was redirected`);
  return { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, realPath: resolved };
}

export async function ensureWindowsPrivateDirectory(target: string, label: string): Promise<void> {
  if (!isCanonicalHostPath(target, false, "win32")) fail(`${label} is not a canonical Windows directory`);
  await assertWindowsNoReparsePath(path.win32.dirname(target), `${label} parent`, true);
  await mkdir(target, { recursive: true });
  await assertWindowsNoReparsePath(target, label);
  // ACL enforcement is intentionally explicit.  Windows mode bits are not a
  // privacy proof; an inherited broad DACL is not accepted as 0700.
  const sidText = runToolSync(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], "Windows principal query");
  const sid = /S-1-[0-9-]+/u.exec(sidText)?.[0];
  if (!sid) fail("Windows controller SID is unavailable");
  await runTool(systemTool("icacls.exe"), [target, "/inheritance:r", "/grant:r", `${sid}:(OI)(CI)F`, "S-1-5-18:(OI)(CI)F"], "Windows private ACL setup");
  const checked = await queryWindowsAcl(target);
  if (checked.allowed.some(identity => identity !== sid && identity !== "S-1-5-18" && identity !== "NT AUTHORITY\\SYSTEM")) fail(`${label} has an untrusted allow ACL entry`);
}
async function queryWindowsAcl(target: string): Promise<{ readonly allowed: readonly string[] }> {
  const output = await runTool(systemTool("WindowsPowerShell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded(ACL_QUERY_SCRIPT), target], "Windows ACL query");
  let value: unknown; try { value = JSON.parse(output.trim()); } catch (error) { fail("Windows ACL query was not JSON", error); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Windows ACL query shape is invalid");
  const access = (value as Record<string, unknown>)["access"];
  if (!Array.isArray(access)) fail("Windows ACL query lacks access entries");
  const allowed = access.filter(item => item && typeof item === "object" && (item as Record<string, unknown>)["type"] === "Allow").map(item => (item as Record<string, unknown>)["identity"]).filter((item): item is string => typeof item === "string");
  return { allowed };
}

export function windowsToolPath(name: "docker.exe" | "sbx.exe" | "icacls.exe" | "whoami.exe" | "WindowsPowerShell.exe"): string { return systemTool(name); }
export function windowsToolCommandLine(executable: string, argv: readonly string[]): string { return [executable, ...argv].map(quoteWindowsArg).join(" "); }
function quoteWindowsArg(value: string): string { if (value.length > 0 && !/[\s"]/u.test(value)) return value; let result = '"'; let slashes = 0; for (const char of value) { if (char === "\\") slashes += 1; else if (char === '"') { result += "\\".repeat(slashes * 2 + 1) + '"'; slashes = 0; } else { result += "\\".repeat(slashes) + char; slashes = 0; } } return result + "\\".repeat(slashes * 2) + '"'; }
void realpathSync;
void unlink;
