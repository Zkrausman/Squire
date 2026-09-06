#!/usr/bin/env node
/*
 * Fixed guest role broker. This is the only image component allowed to retain
 * the privilege required to create squireagent children. It exposes one
 * private, filesystem-protected Unix socket to squirectl and never accepts a
 * shell, a host path, a Docker endpoint, or an ambient environment.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, chown, lstat, mkdir, readFile, readlink, realpath, unlink } from "node:fs/promises";
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const SOCKET = "/ticket/control/supervisor.sock";
const CONTROL_UID = 1000;
const CONTROL_GID = 1000;
const AGENT_UID = 1001;
const AGENT_GID = 1001;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const ROLES = new Set(["orchestrator", "plan", "implement", "review", "test"]);
const ENV_KEYS = new Set(["HOME", "WIKI_HOME", "PI_CODING_AGENT_DIR", "PI_SKIP_VERSION_CHECK", "DOCKER_HOST", "LANG", "LC_ALL", "TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]);
const children = new Map();

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("non-finite number"); return JSON.stringify(value); }
  if (!value || typeof value !== "object" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new Error("unsupported JSON value");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function record(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`); return value; }
function exactKeys(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(`${label} fields are not closed`); }
function safeText(value, label, max = 4096) { if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f\r\n]/u.test(value)) throw new Error(`${label} is invalid`); return value; }
function uuid(value, label) { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) throw new Error(`${label} is invalid`); return value; }
function canonicalPath(value, label) { safeText(value, label); if (!path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value.endsWith("/") || value.includes("//") || value.includes("\\") || value.split("/").some(part => part === "." || part === "..")) throw new Error(`${label} is not canonical`); return value; }
function runScopedPath(value) { return typeof value === "string" && value.startsWith("/ticket/runtime/") && !value.endsWith("/") && !value.includes("//") && !value.includes("\\") && path.posix.normalize(value) === value && !value.split("/").some(part => part === "." || part === "..") && /^\/ticket\/runtime\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(value); }
function argvDigest(command, args, cwd, environment) { return digest(Buffer.from(canonicalJson({ command, args, cwd, environment }), "utf8")); }
function validateEnvironment(value) {
  const env = record(value, "role environment");
  for (const key of Object.keys(env)) if (!ENV_KEYS.has(key) || typeof env[key] !== "string" || /[\u0000-\u001f\u007f\r\n]/u.test(env[key])) throw new Error("role environment is not allowlisted");
  const required = ["DOCKER_HOST", "HOME", "PI_CODING_AGENT_DIR", "PI_SKIP_VERSION_CHECK", "TMPDIR", "WIKI_HOME"];
  if (required.some(key => !Object.hasOwn(env, key))) throw new Error("role environment is missing a fixed key");
  if (env.DOCKER_HOST !== "unix:///ticket/docker/run/docker.sock" || env.TMPDIR !== "/ticket/tmp" || env.PI_SKIP_VERSION_CHECK !== "1") throw new Error("role environment is not fixed");
  if (!runScopedPath(env.HOME) || !runScopedPath(env.WIKI_HOME) || !runScopedPath(env.PI_CODING_AGENT_DIR)) throw new Error("role environment is not run scoped");
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY"]) if (env[key] !== undefined && !/^squire-proxy:\/\/[a-z0-9._-]{1,128}$/u.test(env[key])) throw new Error("role proxy identity is not ticket scoped");
  if (env.NO_PROXY !== undefined && !/^squire-no-proxy:\/\/[a-z0-9._-]{1,128}$/u.test(env.NO_PROXY)) throw new Error("role no-proxy identity is not ticket scoped");
  return Object.freeze({ ...env });
}
function validateSpawn(value) {
  const request = record(value, "spawn request");
  exactKeys(request, ["args", "argvDigest", "command", "cwd", "environment", "requestId", "role", "type"], "spawn request");
  if (request.type !== "spawn" || !uuid(request.requestId, "spawn request ID") || !ROLES.has(request.role)) throw new Error("spawn request identity is invalid");
  const command = canonicalPath(request.command, "role executable");
  if (!/^\/ticket\/runtime\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(command) || command === "/ticket/runtime/squirectl") throw new Error("role executable is outside the fixed runtime");
  if (!Array.isArray(request.args) || request.args.length === 0 || request.args.length > 128 || request.args.some((arg, index) => typeof arg !== "string" || arg.length === 0 || arg.length > 4096 || (index === 9 ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(arg) : /[\u0000-\u001f\u007f]/u.test(arg))) || request.args[0] !== "--mode" || request.args[1] !== "rpc" || request.args[8] !== "--append-system-prompt" || request.args[10] !== "--name") throw new Error("role argv is not the fixed RPC form");
  const cwd = canonicalPath(request.cwd, "role cwd"); if (cwd !== "/ticket/workspace") throw new Error("role cwd is not the fixed workspace");
  const environment = validateEnvironment(request.environment);
  if (typeof request.argvDigest !== "string" || request.argvDigest !== argvDigest(command, request.args, cwd, environment)) throw new Error("role argv digest differs from the trusted launch identity");
  return { requestId: request.requestId, role: request.role, command, args: [...request.args], cwd, environment, argvDigest: request.argvDigest };
}
function validateAttach(value) {
  const request = record(value, "attach request");
  exactKeys(request, ["argvDigest", "executable", "executableDigest", "pid", "requestId", "startTime", "type"], "attach request");
  if (request.type !== "attach" || !uuid(request.requestId, "attach request ID") || !Number.isSafeInteger(request.pid) || request.pid <= 0 || request.pid > 4_194_304 || typeof request.startTime !== "string" || !/^\d{1,32}$/u.test(request.startTime) || !/^[0-9a-f]{64}$/u.test(request.executableDigest) || !/^[0-9a-f]{64}$/u.test(request.argvDigest)) throw new Error("attach request identity is invalid");
  const executable = canonicalPath(request.executable, "attached role executable"); if (!/^\/ticket\/runtime\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(executable) || executable === "/ticket/runtime/squirectl") throw new Error("attached role executable is outside the fixed runtime");
  return { requestId: request.requestId, pid: request.pid, startTime: request.startTime, executable, executableDigest: request.executableDigest, argvDigest: request.argvDigest };
}
async function assertRoleExecutable(command) {
  await assertNoSymlinkAncestors(command, "role executable");
  const info = await lstat(command);
  const mode = info.mode & 0o7777;
  const roleReadable = info.gid === AGENT_GID && (mode & 0o050) === 0o050 || (mode & 0o005) === 0o005;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.nlink !== 1 || info.size <= 0 || info.size > 256 * 1024 * 1024 || (mode & 0o6222) !== 0 || !roleReadable) throw new Error("role executable is not an immutable root-owned runtime file");
}
function validateSignal(value) {
  const request = record(value, "signal request"); exactKeys(request, ["requestId", "signal", "type"], "signal request");
  if (request.type !== "signal" || !uuid(request.requestId, "signal request ID") || !["SIGTERM", "SIGKILL"].includes(request.signal)) throw new Error("signal request is invalid");
  return request;
}
function validateInput(value) {
  const request = record(value, "stdin request"); exactKeys(request, ["data", "requestId", "type"], "stdin request");
  if (request.type !== "stdin" || !uuid(request.requestId, "stdin request ID") || typeof request.data !== "string" || request.data.length > MAX_LINE_BYTES * 2 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(request.data)) throw new Error("stdin request is invalid");
  const bytes = Buffer.from(request.data, "base64"); if (bytes.length > MAX_LINE_BYTES) throw new Error("stdin request exceeds its bound");
  return { requestId: request.requestId, bytes };
}
async function assertNoSymlinkAncestors(target, label) { const root = path.posix.parse(target).root; const parts = target.slice(root.length).split("/").filter(Boolean); let current = root; for (let index = 0; index < parts.length; index += 1) { current = path.posix.join(current, parts[index]); const info = await lstat(current); if (info.isSymbolicLink() || index < parts.length - 1 && !info.isDirectory()) throw new Error(`${label} has a symlink or non-directory ancestor`); } }
async function processStartTime(pid) { return parseProcessStartTime(await readFile(`/proc/${pid}/stat`, "utf8")); }
function processStartTimeSync(pid) { return parseProcessStartTime(readFileSync(`/proc/${pid}/stat`, "utf8")); }
function parseProcessStartTime(text) { const close = text.lastIndexOf(")"); if (close < 0) throw new Error("process stat is malformed"); const fields = text.slice(close + 2).trim().split(/\s+/u); const value = fields[19]; if (!/^\d+$/u.test(value ?? "")) throw new Error("process start identity is unavailable"); return value; }
async function processExecutable(pid) { return validateExecutablePath(await readlink(`/proc/${pid}/exe`)); }
function processExecutableSync(pid) { return validateExecutablePath(readlinkSync(`/proc/${pid}/exe`)); }
function validateExecutablePath(executable) { if (!path.posix.isAbsolute(executable) || executable.includes("//") || executable.includes("..")) throw new Error("process executable identity is invalid"); return executable; }
async function processIdentity(pid, startTime, expectedExecutable, expectedDigest) { const currentStart = await processStartTime(pid); const executable = await processExecutable(pid); const actualDigest = digest(await readFile(executable)); if (currentStart !== startTime || executable !== expectedExecutable || actualDigest !== expectedDigest) throw new Error("role process identity changed"); return { pid, startTime, executable, executableDigest: actualDigest }; }
async function assertSpawnIdentity(pid, request, commandDigest) {
  const executable = await processExecutable(pid); if (executable !== request.command && !["/usr/bin/node", "/usr/local/bin/node"].includes(executable)) throw new Error("role interpreter identity is not allowlisted"); const currentCommand = await realpath(request.command); const commandBytes = await readFile(request.command); if (currentCommand !== request.command || digest(commandBytes) !== commandDigest) throw new Error("role command identity changed during spawn");
  const argumentBytes = request.args.map(item => Buffer.concat([Buffer.from(item, "utf8"), Buffer.from([0])])); const candidates = [Buffer.concat([Buffer.from(executable, "utf8"), Buffer.from([0]), ...argumentBytes])]; const firstLine = commandBytes.subarray(0, Math.min(commandBytes.length, 4096)).toString("utf8").split("\n", 1)[0]; if (firstLine.startsWith("#!")) candidates.push(Buffer.concat([Buffer.from(executable, "utf8"), Buffer.from([0]), Buffer.from(request.command, "utf8"), Buffer.from([0]), ...argumentBytes])); const actualArgs = await readFile(`/proc/${pid}/cmdline`); if (!candidates.some(candidate => actualArgs.equals(candidate))) throw new Error("role argv identity changed during spawn");
  const cwd = await readlink(`/proc/${pid}/cwd`); if (cwd !== request.cwd) throw new Error("role cwd identity changed during spawn");
  const status = await readFile(`/proc/${pid}/status`, "utf8"); const uid = /^Uid:\\s+(\\d+)/mu.exec(status)?.[1]; const gid = /^Gid:\\s+(\\d+)/mu.exec(status)?.[1]; const groups = /^Groups:\\s*(.*)$/mu.exec(status)?.[1]?.trim() ?? ""; if (uid !== String(AGENT_UID) || gid !== String(AGENT_GID) || groups !== "") throw new Error("role process principal is not the exact unprivileged identity");
  return { executable, executableDigest: digest(await readFile(executable)) };
}
function assertSpawnIdentitySync(pid, request, commandDigest) {
  const executable = processExecutableSync(pid); if (executable !== request.command && !["/usr/bin/node", "/usr/local/bin/node"].includes(executable)) throw new Error("role interpreter identity is not allowlisted"); const currentCommand = realpathSync(request.command); const commandBytes = readFileSync(request.command); if (currentCommand !== request.command || digest(commandBytes) !== commandDigest) throw new Error("role command identity changed during spawn");
  const argumentBytes = request.args.map(item => Buffer.concat([Buffer.from(item, "utf8"), Buffer.from([0])])); const candidates = [Buffer.concat([Buffer.from(executable, "utf8"), Buffer.from([0]), ...argumentBytes])]; const firstLine = commandBytes.subarray(0, Math.min(commandBytes.length, 4096)).toString("utf8").split("\n", 1)[0]; if (firstLine.startsWith("#!")) candidates.push(Buffer.concat([Buffer.from(executable, "utf8"), Buffer.from([0]), Buffer.from(request.command, "utf8"), Buffer.from([0]), ...argumentBytes])); const actualArgs = readFileSync(`/proc/${pid}/cmdline`); if (!candidates.some(candidate => actualArgs.equals(candidate))) throw new Error("role argv identity changed during spawn");
  const cwd = readlinkSync(`/proc/${pid}/cwd`); if (cwd !== request.cwd) throw new Error("role cwd identity changed during spawn");
  const status = readFileSync(`/proc/${pid}/status`, "utf8"); const uid = /^Uid:\s+(\d+)/mu.exec(status)?.[1]; const gid = /^Gid:\s+(\d+)/mu.exec(status)?.[1]; const groups = /^Groups:\s*(.*)$/mu.exec(status)?.[1]?.trim() ?? ""; if (uid !== String(AGENT_UID) || gid !== String(AGENT_GID) || groups !== "") throw new Error("role process principal is not the exact unprivileged identity");
  return { executable, executableDigest: digest(readFileSync(executable)) };
}
function send(socket, value) { const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8"); if (bytes.length > MAX_LINE_BYTES) throw new Error("supervisor frame exceeds its bound"); socket.write(bytes); }
function safeSend(socket, value) { try { if (!socket.destroyed) send(socket, value); } catch { socket.destroy(); } }
async function spawnRole(request) {
  await assertRoleExecutable(request.command);
  const commandBytes = await readFile(request.command);
  const commandDigest = digest(commandBytes);
  request.commandBytesDigest = commandDigest;
  const child = spawn(request.command, request.args, { cwd: request.cwd, env: { ...request.environment }, uid: AGENT_UID, gid: AGENT_GID, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  child.once("error", () => undefined);
  if (!child.pid || !child.stdin || !child.stdout || !child.stderr) { child.kill("SIGKILL"); throw new Error("role process did not expose bounded stdio"); }
  let startTime; let procExecutable; let procExecutableDigest;
  try {
    // Capture identity before an immediate role exit can be reaped. The
    // subsequent ledger and attach checks still re-prove the same identity.
    startTime = processStartTimeSync(child.pid);
    procExecutable = processExecutableSync(child.pid);
    procExecutableDigest = digest(readFileSync(procExecutable));
    if (!procExecutable || procExecutableDigest.length !== 64) throw new Error("role process executable identity is invalid");
    assertSpawnIdentitySync(child.pid, request, commandDigest);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  const proc = { pid: child.pid, startTime, executable: procExecutable, executableDigest: procExecutableDigest };
  const entry = { child, request, proc, clients: new Set(), bytes: 0, exited: false, exitCode: null, signal: null };
  children.set(child.pid, entry);
  child.stdout.on("data", chunk => { entry.bytes += chunk.length; if (entry.bytes > MAX_STREAM_BYTES) { child.kill("SIGKILL"); return; } for (const client of entry.clients) safeSend(client, { type: "stdout", requestId: request.requestId, data: Buffer.from(chunk).toString("base64") }); });
  child.stderr.on("data", chunk => { entry.bytes += chunk.length; if (entry.bytes > MAX_STREAM_BYTES) { child.kill("SIGKILL"); return; } for (const client of entry.clients) safeSend(client, { type: "stderr", requestId: request.requestId, data: Buffer.from(chunk).toString("base64") }); });
  child.once("exit", (code, signal) => { entry.exited = true; entry.exitCode = code ?? (signal === "SIGTERM" ? 143 : 1); entry.signal = signal; for (const client of entry.clients) safeSend(client, { type: "exit", requestId: request.requestId, code: entry.exitCode, signal }); children.delete(child.pid); });
  return { entry, identity: { pid: child.pid, startTime, executable: request.command, executableDigest: commandDigest } };
}
async function attachRole(request) {
  const entry = children.get(request.pid); if (!entry || entry.exited) throw new Error("role process is not owned by the guest supervisor");
  const current = await processIdentity(request.pid, request.startTime, entry.proc.executable, entry.proc.executableDigest);
  if (current.executableDigest !== entry.proc.executableDigest || entry.request.commandBytesDigest !== request.executableDigest || entry.request.argvDigest !== request.argvDigest || entry.request.command !== request.executable || entry.proc.pid !== request.pid || entry.proc.startTime !== request.startTime) throw new Error("role process identity differs from the durable allocation");
  await assertSpawnIdentity(request.pid, entry.request, entry.request.commandBytesDigest);
  return entry;
}
function handleConnection(socket) {
  socket.setNoDelay(true); socket.setEncoding("utf8"); let buffer = ""; const owned = new Set();
  const attachClient = (entry, requestId) => { entry.clients.add(socket); owned.add(entry); safeSend(socket, { type: "attached", requestId, streamRequestId: entry.request.requestId, pid: entry.proc.pid, startTime: entry.proc.startTime, executable: entry.request.command, executableDigest: entry.request.commandBytesDigest }); if (entry.exited) safeSend(socket, { type: "exit", requestId: entry.request.requestId, code: entry.exitCode, signal: entry.signal }); };
  const handle = async value => {
    try {
      if (!value || typeof value.type !== "string") throw new Error("supervisor message kind is invalid");
      if (value.type === "spawn") {
        const request = validateSpawn(value); const made = await spawnRole(request); made.entry.clients.add(socket); owned.add(made.entry); safeSend(socket, { type: "spawned", requestId: request.requestId, streamRequestId: request.requestId, pid: made.identity.pid, startTime: made.identity.startTime, executable: request.command, executableDigest: request.commandBytesDigest }); return;
      }
      if (value.type === "attach") { const request = validateAttach(value); const entry = await attachRole(request); attachClient(entry, request.requestId); return; }
      if (value.type === "stdin") { const input = validateInput(value); const entry = [...owned].find(item => item.request.requestId === input.requestId); if (!entry || entry.exited || !entry.child.stdin.write(input.bytes)) throw new Error("role stdin is not writable"); return; }
      if (value.type === "signal") { const request = validateSignal(value); const entry = [...owned].find(item => item.request.requestId === request.requestId); if (!entry || entry.exited || !entry.child.kill(request.signal)) throw new Error("role signal was not delivered"); safeSend(socket, { type: "signal-result", requestId: request.requestId, accepted: true }); return; }
      throw new Error("supervisor message is not allowlisted");
    } catch (error) { const requestId = typeof value?.requestId === "string" ? value.requestId : randomUUID(); safeSend(socket, { type: "error", requestId, error: String(error instanceof Error ? error.message : error).slice(0, 1000) }); }
  };
  socket.on("data", chunk => { buffer += chunk; if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES * 4) { socket.destroy(); return; } while (buffer.includes("\n")) { const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue; if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) { socket.destroy(); return; } let value; try { value = JSON.parse(line); if (canonicalJson(value) !== line) throw new Error("supervisor frame is not canonical"); } catch { socket.destroy(); return; } void handle(value); } });
  socket.on("close", () => { for (const entry of owned) entry.clients.delete(socket); });
}
async function prepareSocket() {
  const parent = path.dirname(SOCKET);
  await assertNoSymlinkAncestors(parent, "supervisor socket parent");
  await mkdir(parent, { recursive: true, mode: 0o770 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== CONTROL_UID || parentInfo.gid !== 0 || (parentInfo.mode & 0o7777) !== 0o770) throw new Error("supervisor socket parent is not the exact controller directory");
  const info = await lstat(SOCKET).catch(error => { if (error?.code === "ENOENT") return undefined; throw error; });
  if (info) {
    if (info.isSymbolicLink() || !info.isSocket?.() || info.nlink !== 1 || info.uid !== CONTROL_UID || info.gid !== CONTROL_GID || (info.mode & 0o7777) !== 0o660) throw new Error("supervisor socket path was replaced");
    await unlink(SOCKET);
  }
}
async function main() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0 || typeof process.setgroups !== "function") throw new Error("guest supervisor must start as root");
  process.setgroups([]); process.umask(0o077); await prepareSocket(); const server = net.createServer(handleConnection); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(SOCKET, () => resolve()); }); const bound = await lstat(SOCKET); if (!bound.isSocket() || bound.nlink !== 1) throw new Error("supervisor socket identity is unavailable after bind"); await chmod(SOCKET, 0o660); await chown(SOCKET, CONTROL_UID, CONTROL_GID); const owned = await lstat(SOCKET); if (!owned.isSocket() || owned.dev !== bound.dev || owned.ino !== bound.ino || owned.uid !== CONTROL_UID || owned.gid !== CONTROL_GID || (owned.mode & 0o7777) !== 0o660) throw new Error("supervisor socket identity changed during setup"); process.on("SIGTERM", () => { server.close(() => process.exit(0)); for (const entry of children.values()) if (!entry.exited) entry.child.kill("SIGKILL"); }); process.on("SIGINT", () => process.emit("SIGTERM")); }
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
