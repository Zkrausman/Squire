/* Shared trusted-host primitives for the Windows and POSIX acceptance tools.
 * Host paths are never parsed as guest paths.  Windows mode uses reparse-point
 * and ACL checks rather than POSIX mode/inode claims; POSIX mode retains the
 * descriptor/no-follow proof used by the controller. */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, closeSync } from "node:fs";
import { lstat, mkdir, open, realpath, readdir, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function fail(message) { throw new Error(message); }
export function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
export function isWindows(platform = process.platform) { return platform === "win32"; }
export function pathKind(value, platform = process.platform) { return platform === "win32" || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\") ? "win32" : "posix"; }
export function pathApi(value, platform = process.platform) { return pathKind(value, platform) === "win32" ? path.win32 : path.posix; }
export function pathEqual(left, right) { return pathKind(left) === "win32" && pathKind(right) === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }
export function canonicalHostPath(value, label, { platform = process.platform, allowRoot = false } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f\r\n]/u.test(value)) fail(`${label} is not a canonical absolute host path`);
  const kind = pathKind(value, platform); const api = kind === "win32" ? path.win32 : path.posix; const root = api.parse(value).root;
  if (!api.isAbsolute(value) || api.normalize(value) !== value || !allowRoot && value === root || allowRoot && value !== root && value.endsWith(kind === "win32" ? "\\" : "/") || !allowRoot && value.endsWith(kind === "win32" ? "\\" : "/")) fail(`${label} is not a canonical absolute host path`);
  if (kind === "win32") {
    if (!/^[A-Z]:\\/u.test(value) || value.includes("/") || value.startsWith("\\\\") || value.startsWith("\\\\?\\") || value.startsWith("\\.\\") || value.split("\\").some(part => part === "." || part === ".." || part.length === 0)) fail(`${label} is not a local Windows path`);
  } else if (value.includes("\\") || value.includes("//") || value.split("/").some(part => part === "." || part === "..")) fail(`${label} is not a canonical POSIX path`);
  return value;
}
export function hostJoin(root, ...parts) { return pathApi(root).join(root, ...parts); }
export function hostDirname(value) { return pathApi(value).dirname(value); }
export function hostBasename(value) { return pathApi(value).basename(value); }
export function hostRoot(value) { return pathApi(value).parse(value).root; }
export function hostRelative(root, target) { return pathApi(root).relative(root, target); }
export function hostWithin(root, target) { const api = pathApi(root); const relative = api.relative(root, target); return pathKind(root) === pathKind(target) && (relative === "" || relative !== ".." && !relative.startsWith(`..${pathKind(root) === "win32" ? "\\" : "/"}`) && !api.isAbsolute(relative)); }

function windowsSystemRoot() {
  const value = process.env.SystemRoot ?? process.env.WINDIR;
  return canonicalHostPath(value, "Windows SystemRoot", { platform: "win32" });
}
export function windowsSystemTool(name) {
  if (!/^[A-Za-z0-9._-]+\.exe$/u.test(name)) fail("Windows system executable name is not fixed");
  return canonicalHostPath(path.win32.join(windowsSystemRoot(), "System32", name), "Windows system executable", { platform: "win32" });
}
function windowsEnvironment() {
  const root = windowsSystemRoot(); const temp = process.env.TEMP ?? process.env.TMP;
  canonicalHostPath(temp, "Windows temporary directory", { platform: "win32" });
  return { SystemRoot: root, WINDIR: root, TEMP: temp, TMP: temp, PATH: path.win32.join(root, "System32"), LANG: "C", LC_ALL: "C", MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" };
}
function boundArgv(argv, label = "trusted command") { if (!Array.isArray(argv) || argv.length === 0 || argv.length > 128 || argv.some(value => typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f\r\n]/u.test(value))) fail(`${label} argv is not bounded and argv-only`); }
function readUtf8(bytes, label) { if (bytes.length > MAX_OUTPUT_BYTES) fail(`${label} output exceeds its bound`); try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (error) { fail(`${label} output is not UTF-8: ${error instanceof Error ? error.message : String(error)}`); } }

function noReparsePathSync(target, label, allowMissing = false) {
  canonicalHostPath(target, label); const root = hostRoot(target); let current = root;
  for (const part of target.slice(root.length).split(pathKind(target) === "win32" ? "\\" : "/").filter(Boolean)) { current = hostJoin(current, part); let info; try { info = lstatSync(current); } catch (error) { if (error?.code === "ENOENT" && allowMissing) return; throw error; } if (info.isSymbolicLink()) fail(`${label} contains a symbolic link/reparse point`); if (!pathEqual(realpathSync(current), current)) fail(`${label} contains a redirected path component`); if (current !== target && !info.isDirectory()) fail(`${label} has a non-directory ancestor`); }
}
async function noReparsePath(target, label, allowMissing = false) {
  canonicalHostPath(target, label);
  const root = hostRoot(target); let current = root;
  for (const part of target.slice(root.length).split(pathKind(target) === "win32" ? "\\" : "/").filter(Boolean)) {
    current = hostJoin(current, part);
    const info = await lstat(current).catch(error => { if (error?.code === "ENOENT" && allowMissing) return undefined; throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) fail(`${label} contains a symbolic link/reparse point`);
    if (!pathEqual(await realpath(current), current)) fail(`${label} contains a redirected path component`);
    if (current !== target && !info.isDirectory()) fail(`${label} has a non-directory ancestor`);
  }
}
export async function assertNoReparsePath(target, label, allowMissing = false) { return noReparsePath(target, label, allowMissing); }

function statIdentity(info, platform) {
  if (platform === "win32") return { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  return { dev: info.dev, ino: info.ino, nlink: info.nlink, size: info.size, mode: info.mode, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}
function sameStatIdentity(left, right, platform) { return JSON.stringify(statIdentity(left, platform)) === JSON.stringify(statIdentity(right, platform)); }
async function verifyRegular(target, label, maxBytes, privateOnly, platform = process.platform) {
  await noReparsePath(target, label); const info = await lstat(target);
  if (!info.isFile() || info.size > maxBytes || info.isSymbolicLink()) fail(`${label} is not a bounded regular file`);
  if (platform !== "win32" && (info.nlink !== 1 || (info.mode & 0o022) !== 0 || privateOnly && (info.mode & 0o077) !== 0)) fail(`${label} is not a private single-link file`);
  return info;
}
export async function privateRegular(target, label, maxBytes = MAX_FILE_BYTES, privateOnly = true) { return verifyRegular(target, label, maxBytes, privateOnly); }

export async function readStableFile(target, label, maxBytes = MAX_FILE_BYTES, privateOnly = true) {
  const platform = process.platform; await verifyRegular(target, label, maxBytes, privateOnly, platform);
  const flags = constants.O_RDONLY | (platform !== "win32" ? constants.O_NOFOLLOW ?? 0 : 0);
  if (platform !== "win32" && constants.O_NOFOLLOW === undefined) fail(`${label} requires descriptor no-follow support`);
  const handle = await open(target, flags); try {
    const before = await handle.stat(); if (!before.isFile() || before.size > maxBytes) fail(`${label} is not bounded after open`);
    const resolvedBefore = await realpath(target); if (!pathEqual(resolvedBefore, target)) fail(`${label} path was redirected before read`);
    const bytes = Buffer.allocUnsafe(before.size); let offset = 0;
    while (offset < before.size) { const result = await handle.read(bytes, offset, before.size - offset, offset); if (result.bytesRead <= 0) fail(`${label} ended during a bounded read`); offset += result.bytesRead; }
    const after = await handle.stat(); const resolvedAfter = await realpath(target);
    if (!sameStatIdentity(before, after, platform) || !pathEqual(resolvedAfter, target)) fail(`${label} changed during a bounded read`);
    return bytes;
  } finally { await handle.close(); }
}
export function readStableFileSync(target, label, maxBytes = MAX_FILE_BYTES, privateOnly = true) {
  const platform = process.platform; noReparsePathSync(target, label); const info = lstatSync(target); if (!info.isFile() || info.size > maxBytes || info.isSymbolicLink()) fail(`${label} is not a bounded regular file`); if (platform !== "win32" && (info.nlink !== 1 || (info.mode & 0o022) !== 0 || privateOnly && (info.mode & 0o077) !== 0)) fail(`${label} is not private`); if (platform !== "win32" && constants.O_NOFOLLOW === undefined) fail(`${label} requires descriptor no-follow support`); const fd = openSync(target, constants.O_RDONLY | (platform !== "win32" ? constants.O_NOFOLLOW ?? 0 : 0)); try { const before = fstatSync(fd); const bytes = Buffer.allocUnsafe(before.size); let offset = 0; while (offset < before.size) { const count = readSync(fd, bytes, 0, before.size - offset, offset); if (count <= 0) fail(`${label} ended during a bounded read`); offset += count; } const after = fstatSync(fd); if (!sameStatIdentity(before, after, platform) || !pathEqual(realpathSync(target), target)) fail(`${label} changed during a bounded read`); return bytes; } finally { closeSync(fd); }
}
export async function readCanonicalJson(target, label, privateOnly = true) { const bytes = await readStableFile(target, label, 16 * 1024 * 1024, privateOnly); let value; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (error) { fail(`${label} is not strict JSON: ${error instanceof Error ? error.message : String(error)}`); } return { bytes, value }; }

async function controllerSid() {
  if (process.platform !== "win32") return undefined;
  const output = runTrustedSync(windowsSystemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], "Windows principal query").stdout;
  const sid = /S-1-[0-9-]+/u.exec(output)?.[0]; if (!sid) fail("Windows controller SID is unavailable"); return sid;
}
async function verifyWindowsAcl(target, label) {
  const sid = await controllerSid(); const output = await runPowerShell(`$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $args[0]; $items=@($acl.Access | ForEach-Object { [ordered]@{ identity=$_.IdentityReference.Value; type=$_.AccessControlType.ToString() } }); [ordered]@{ owner=$acl.Owner; access=$items } | ConvertTo-Json -Compress -Depth 5`, [target], "Windows ACL query"); let value; try { value = JSON.parse(output.trim()); } catch { fail(`${label} ACL query was not JSON`); } const access = Array.isArray(value?.access) ? value.access : []; const allowed = access.filter(item => item?.type === "Allow").map(item => item.identity); if (allowed.some(identity => identity !== sid && identity !== "S-1-5-18" && identity !== "NT AUTHORITY\\SYSTEM")) fail(`${label} has an untrusted allow ACL entry`); }
export async function ensurePrivateDirectory(target, label) {
  canonicalHostPath(target, label); await noReparsePath(hostDirname(target), `${label} parent`, true); await mkdir(target, { recursive: true, mode: 0o700 }); await noReparsePath(target, label);
  if (process.platform === "win32") { const sid = await controllerSid(); await runTrusted(windowsSystemTool("icacls.exe"), [target, "/inheritance:r", "/grant:r", `${sid}:(OI)(CI)F`, "S-1-5-18:(OI)(CI)F"], "Windows private ACL setup"); await verifyWindowsAcl(target, label); }
  else { const info = await lstat(target); if (!info.isDirectory() || info.nlink < 2 || (info.mode & 0o7777) !== 0o700) fail(`${label} is not a private directory`); }
}
export async function writeExclusiveFile(target, bytes, label, { privateOnly = true } = {}) {
  canonicalHostPath(target, label, { allowRoot: false }); await noReparsePath(hostDirname(target), `${label} parent`, true); const platform = process.platform; const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (platform !== "win32" ? constants.O_NOFOLLOW ?? 0 : 0); const handle = await open(target, flags, 0o600); try { let offset = 0; while (offset < bytes.length) { const result = await handle.write(bytes, offset, bytes.length - offset, offset); if (result.bytesWritten <= 0) fail(`${label} write ended early`); offset += result.bytesWritten; } if (platform !== "win32") await handle.chmod(0o600); await handle.sync(); } catch (error) { await handle.close().catch(() => undefined); await unlink(target).catch(() => undefined); throw error; } await handle.close(); await verifyRegular(target, label, Math.max(bytes.length, 16 * 1024 * 1024), privateOnly, platform); }

export async function ensureEmptyPrivateDirectory(target, label) { await ensurePrivateDirectory(target, label); if ((await readdir(target)).length !== 0) fail(`${label} must be empty before use`); }
export async function removeTreeNoFollow(target, root, { maxEntries = 100_000, maxDepth = 64 } = {}) {
  canonicalHostPath(target, "removal target"); canonicalHostPath(root, "removal root"); if (!hostWithin(root, target)) fail("removal target escapes its root"); let remaining = maxEntries;
  async function remove(current, depth) {
    if (depth > maxDepth || --remaining < 0) fail("bounded tree removal exceeded its limit"); const info = await lstat(current).catch(error => { if (error?.code === "ENOENT") return undefined; throw error; }); if (!info) return;
    if (info.isSymbolicLink()) { await unlink(current); return; }
    if (!info.isDirectory()) { if (!info.isFile()) fail("tree removal encountered an unsupported resource"); await unlink(current); return; }
    const before = await realpath(current); if (!pathEqual(before, current)) fail("tree removal encountered a redirected directory");
    const entries = await readdir(current, { withFileTypes: true }); for (const entry of entries) await remove(hostJoin(current, entry.name), depth + 1);
    const after = await readdir(current); if (after.length !== 0) fail("tree removal directory changed before removal"); await rmdir(current);
  }
  await remove(target, 0);
}

function posixProcessIdentity(pid) { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); const end = stat.lastIndexOf(")"); if (end < 0) fail("POSIX process stat is malformed"); const fields = stat.slice(end + 2).trim().split(/\s+/u); const startTime = fields[19]; if (!/^\d+$/u.test(startTime ?? "")) fail("POSIX process start identity is unavailable"); const executable = readlinkSync(`/proc/${pid}/exe`); return { pid, startTime, executable }; }
const WINDOWS_QUERY_SCRIPT = `$ErrorActionPreference='Stop'; $id=[int]$args[0]; $p=Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = '+$id); if($null -eq $p){'{"status":"exited"}'}else{$created=([Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate)).ToUniversalTime().ToString('o'); [ordered]@{status='alive';pid=[int]$p.ProcessId;startTime=$created;executable=[string]$p.ExecutablePath;commandLine=[string]$p.CommandLine}|ConvertTo-Json -Compress}`;
function encodePowerShell(script) { return Buffer.from(script, "utf16le").toString("base64"); }
export function runPowerShell(script, argv = [], label = "PowerShell") { return runTrustedSync(windowsSystemTool("WindowsPowerShell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script), ...argv], label).stdout; }
function windowsQuerySync(pid) { const output = runPowerShell(WINDOWS_QUERY_SCRIPT, [String(pid)], "Windows process identity query"); let value; try { value = JSON.parse(output.trim()); } catch { fail("Windows process query was not JSON"); } if (value?.status === "exited") return value; if (value?.status !== "alive" || value.pid !== pid || typeof value.startTime !== "string" || typeof value.executable !== "string" || typeof value.commandLine !== "string") fail("Windows process identity query is incomplete"); return value; }
function parseWindowsCommandLine(line) { const result = []; let i = 0; while (i < line.length) { while (i < line.length && /\s/u.test(line[i])) i++; if (i >= line.length) break; let item = ""; let quoted = false; while (i < line.length) { let slashes = 0; while (line[i] === "\\") { slashes++; i++; } if (line[i] === '"') { item += "\\".repeat(Math.floor(slashes / 2)); if (slashes % 2) { item += '"'; i++; } else { quoted = !quoted; i++; } continue; } item += "\\".repeat(slashes); if (i >= line.length || !quoted && /\s/u.test(line[i])) break; item += line[i++]; } result.push(item); } return result; }
function assertProcessIdentity(pid, executable, argv, expectedStart) { const value = process.platform === "win32" ? windowsQuerySync(pid) : posixProcessIdentity(pid); if (value.status === "exited") fail("trusted process exited before identity capture"); const start = process.platform === "win32" ? String(Date.parse(value.startTime)) : value.startTime; if (expectedStart !== undefined && start !== expectedStart) fail("trusted process start identity changed"); if (!pathEqual(value.executable, executable)) fail("trusted process executable identity changed"); if (process.platform === "win32") { const actual = parseWindowsCommandLine(value.commandLine); if (actual.length !== argv.length + 1 || !pathEqual(actual[0], executable) || actual.slice(1).some((item, index) => item !== argv[index])) fail("trusted process argv identity changed"); } else { const actual = readFileSync(`/proc/${pid}/cmdline`); const expected = Buffer.concat([Buffer.from(executable), Buffer.from([0]), ...argv.map(item => Buffer.concat([Buffer.from(item), Buffer.from([0])]))]); if (!actual.equals(expected)) fail("trusted process argv identity changed"); } return { pid, startTime: start, executable }; }
export function runTrustedSync(executable, argv, label = "trusted executable", options = {}) {
  boundArgv(argv, label); canonicalHostPath(executable, label); const executableDigest = digest(readStableFileSync(executable, `${label} bytes`, MAX_FILE_BYTES, false));
  const result = spawnSync(executable, [...argv], { cwd: options.cwd ?? hostDirname(executable), env: options.environment ?? (process.platform === "win32" ? windowsEnvironment() : { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }), shell: false, windowsHide: true, encoding: "buffer", timeout: options.timeoutMs ?? 120_000, maxBuffer: MAX_OUTPUT_BYTES });
  if (result.error) throw result.error;
  let identity;
  try { if (result.pid) identity = assertProcessIdentity(result.pid, executable, argv); }
  catch (error) { if (result.status === null && !result.signal) throw error; identity = result.pid ? { pid: result.pid, startTime: `${Date.now()}${String(result.pid).padStart(6, "0")}`, executable } : undefined; }
  if (result.status !== 0 || result.signal) fail(`${label} failed with ${result.status ?? result.signal ?? "unknown"}`);
  return { stdout: readUtf8(Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""), label), stderr: readUtf8(Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? ""), label), identity, executableDigest };
}
export function runTrusted(executable, argv, label = "trusted executable", options = {}) {
  boundArgv(argv, label); canonicalHostPath(executable, label); const environment = options.environment ?? (process.platform === "win32" ? windowsEnvironment() : { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...argv], { cwd: options.cwd ?? hostDirname(executable), env: environment, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); const stdout = []; const stderr = []; let output = 0; let settled = false; let timer;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const collect = (target, chunk) => { output += chunk.length; if (output > MAX_OUTPUT_BYTES) { child.kill(); finish(new Error(`${label} output exceeds its bound`)); return; } target.push(Buffer.from(chunk)); };
    child.stdout?.on("data", chunk => collect(stdout, chunk)); child.stderr?.on("data", chunk => collect(stderr, chunk)); child.once("error", error => finish(error)); timer = setTimeout(() => { child.kill(); finish(new Error(`${label} timed out`)); }, options.timeoutMs ?? 120_000);
    child.once("spawn", () => {
      let identity; try { identity = assertProcessIdentity(child.pid, executable, argv); } catch (error) { if (process.platform !== "win32" || child.exitCode === null) { child.kill(); finish(error); return; } identity = { pid: child.pid, startTime: `${Date.now()}${String(child.pid).padStart(6, "0")}`, executable }; }
      child.once("exit", (code, signal) => { if (code !== 0 || signal) { finish(new Error(`${label} failed with ${code ?? signal ?? "unknown"}`)); return; } try { finish(undefined, { stdout: readUtf8(Buffer.concat(stdout), label), stderr: readUtf8(Buffer.concat(stderr), label), identity, executableDigest: digest(readStableFileSync(executable, `${label} bytes after`, MAX_FILE_BYTES, false)) }); } catch (error) { finish(error); } });
    });
  });
}

export function explicitHostEnvironment(stateRoot) { if (process.platform === "win32") { const root = windowsSystemRoot(); const temp = process.env.TEMP ?? process.env.TMP; return { SystemRoot: root, WINDIR: root, TEMP: temp, TMP: temp, PATH: path.win32.join(root, "System32"), LANG: "C", LC_ALL: "C", MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" }; } return { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", HOME: hostJoin(stateRoot, "home"), XDG_CONFIG_HOME: hostJoin(stateRoot, "config"), XDG_RUNTIME_DIR: hostJoin(stateRoot, "runtime") }; }
