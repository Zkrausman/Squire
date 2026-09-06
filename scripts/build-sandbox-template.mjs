#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, lstat, open, readdir, unlink } from "node:fs/promises";
import { constants, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const templateRoot = path.join(root, "sandbox/template/v1");
const files = [
  "Dockerfile",
  "config/principals-and-mounts.sh",
  "config/rootless-docker.sh",
  "supervisor/squire-principals.service",
  "supervisor/squire-supervisor.service",
  "supervisor/squire-docker.service",
  "supervisor/squire-guest-supervisor.ts",
  "runtime/squire-supervisor.mjs",
  "runtime/squirectl.mjs",
];
const SHA = /^sha256:[0-9a-f]{64}$/u;
const HEX = /^[0-9a-f]{64}$/u;
const usage = "usage: build-sandbox-template.mjs --base-image IMAGE --base-digest sha256:DIGEST --output MANIFEST [--context DIR] [--docker DOCKER] [--local-tag TAG] [--build-log FILE]";

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("non-finite number"); return JSON.stringify(value); }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new Error("unsupported JSON value");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
async function readStableFile(target, maxBytes, label) {
  if (constants.O_NOFOLLOW === undefined) throw new Error(`${label} requires descriptor no-follow support`);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error(`${label} is not a bounded regular file`);
    const bytes = Buffer.allocUnsafe(before.size); let offset = 0;
    while (offset < before.size) { const result = await handle.read(bytes, offset, before.size - offset, offset); if (result.bytesRead <= 0) throw new Error(`${label} ended during a bounded read`); offset += result.bytesRead; }
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== before.nlink || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error(`${label} changed during a bounded read`);
    return bytes;
  } finally { await handle.close(); }
}
function canonicalPath(value, label, allowMissing = false) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || value === path.parse(value).root || value.endsWith(path.sep) || value.includes("\\") || value.includes("//") || /[\u0000-\u001f\u007f\r\n]/u.test(value)) throw new Error(`${label} must be a canonical absolute path`);
  if (!allowMissing) return value;
  return value;
}
function parse(argv) {
  const result = {};
  const supported = ["--base-image", "--base-digest", "--output", "--context", "--docker", "--local-tag", "--build-log"];
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!supported.includes(key) || typeof argv[i + 1] !== "string" || argv[i + 1].startsWith("--") || Object.hasOwn(result, key.slice(2))) throw new Error(usage);
    result[key.slice(2)] = argv[++i];
  }
  if (!result["base-image"] || !/^([a-z0-9.-]+\/)?[a-z0-9._-]+\/[a-z0-9._-]+$/u.test(result["base-image"]) || !SHA.test(result["base-digest"]) || !result.output || !path.isAbsolute(result.output)) throw new Error("an exact qualified base image and digest plus absolute output are required");
  if (result.context) canonicalPath(result.context, "template context", true);
  if (result.docker) canonicalPath(result.docker, "Docker executable");
  if (result["build-log"]) canonicalPath(result["build-log"], "build log", true);
  if (result["local-tag"] && (!/^[a-z0-9][a-z0-9._/-]{0,255}$/u.test(result["local-tag"]) || /latest/iu.test(result["local-tag"]) || result["local-tag"].includes("@sha256:"))) throw new Error("local build tag is unsafe or mutable latest");
  if (result["local-tag"] && (!result.context || !result.docker)) throw new Error("--local-tag requires --context and --docker");
  return result;
}
function replaceFrom(dockerfile, image, digestValue) {
  const replaced = dockerfile.replace("FROM ${SQUIRE_BASE_IMAGE}@${SQUIRE_BASE_DIGEST}", `FROM ${image}@${digestValue}`);
  if (replaced === dockerfile || !/^FROM [^\s@]+@sha256:[0-9a-f]{64}$/mu.test(replaced)) throw new Error("template does not resolve to one immutable base image");
  return replaced;
}
async function assertNoSymlinkPath(target, label, allowMissing = false) {
  canonicalPath(target, label, allowMissing);
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(error => { if (error?.code === "ENOENT") return undefined; throw error; });
    if (!info) { if (allowMissing) return; throw new Error(`${label} has a missing path component`); }
    if (info.isSymbolicLink()) throw new Error(`${label} contains a symlink path component`);
  }
}
async function readSource(relative) {
  const target = path.join(templateRoot, relative);
  await assertNoSymlinkPath(target, `template source ${relative}`);
  const info = await lstat(target);
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o022) !== 0 || info.size > 16 * 1024 * 1024) throw new Error(`template source ${relative} is not an exact bounded regular file`);
  return readStableFile(target, 16 * 1024 * 1024, `template source ${relative}`);
}
async function assertEmptyDirectory(target, label) {
  await assertNoSymlinkPath(target, label, true);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || info.nlink < 2 || (info.mode & 0o077) !== 0) throw new Error(`${label} is not a private directory`);
  if ((await readdir(target)).length !== 0) throw new Error(`${label} must be empty and create-once`);
}
async function writeContext(context, entries) {
  await assertEmptyDirectory(context, "template context");
  for (const entry of entries) {
    const target = path.join(context, entry.path);
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await assertNoSymlinkPath(parent, `template context parent ${entry.path}`);
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.nlink < 2 || (parentInfo.mode & 0o777) !== 0o700) throw new Error(`template context parent ${entry.path} is not private`);
    const mode = entry.path.endsWith(".sh") || entry.path.endsWith(".mjs") ? 0o555 : 0o444;
    await writeCompleteExclusive(target, entry.bytes, mode, `template context entry ${entry.path}`);
    const fileInfo = await lstat(target);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink !== 1 || (fileInfo.mode & 0o777) !== mode || fileInfo.size !== entry.bytes.length) throw new Error(`template context entry ${entry.path} identity is not exact`);
  }
}
async function writeCompleteExclusive(target, bytes, mode, label) {
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (result.bytesWritten <= 0) throw new Error(`${label} write ended early`);
      offset += result.bytesWritten;
    }
    await handle.chmod(mode);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(target).catch(() => undefined);
    throw error;
  }
  await handle.close();
}
async function runDocker(executable, context, tag, cwd) {
  await assertNoSymlinkPath(executable, "Docker executable"); const info = await lstat(executable); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o022) !== 0) throw new Error("Docker executable is not an exact non-writable regular file"); const executableDigest = digest(await readStableFile(executable, 256 * 1024 * 1024, "Docker executable"));
  return await new Promise((resolve, reject) => {
    const argv = ["build", "--file", path.join(context, "Dockerfile"), "--tag", tag, context];
    const child = spawn(executable, argv, { cwd, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    child.once("error", () => undefined);
    const stdout = []; const stderr = []; let bytes = 0; let settled = false; let timer; let killTimer; const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); fn(value); }; const collect = target => chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) { child.kill("SIGTERM"); finish(reject, new Error("template build output exceeded its bound")); return; } (target === "stdout" ? stdout : stderr).push(Buffer.from(chunk)); };
    if (!child.pid) { child.kill("SIGKILL"); finish(reject, new Error("Docker build did not expose a PID")); return; }
    try { const actual = readlinkSync(`/proc/${child.pid}/exe`); if (actual !== executable || digest(readFileSync(actual)) !== executableDigest) throw new Error("Docker build executable identity changed"); }
    catch (error) { child.kill("SIGKILL"); finish(reject, error); return; }
    child.stdout.on("data", collect("stdout")); child.stderr.on("data", collect("stderr")); child.once("error", error => finish(reject, error)); timer = setTimeout(() => { child.kill("SIGTERM"); killTimer = setTimeout(() => { child.kill("SIGKILL"); finish(reject, new Error("template build timed out")); }, 5_000); }, 120_000); child.once("exit", (code, signal) => finish(resolve, { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), executableDigest }));
  });
}
async function main() {
  const options = parse(process.argv.slice(2));
  const source = await Promise.all(files.map(async relative => ({ path: relative, bytes: await readSource(relative) })));
  const dockerfile = replaceFrom(source.find(item => item.path === "Dockerfile").bytes.toString("utf8"), options["base-image"], options["base-digest"]);
  const entries = source.map(item => ({ path: item.path, sha256: digest(item.path === "Dockerfile" ? Buffer.from(dockerfile) : item.bytes) }));
  const configEntries = entries.filter(item => !item.path.startsWith("runtime/") && item.path !== "supervisor/squire-guest-supervisor.ts");
  const helperEntries = entries.filter(item => item.path === "supervisor/squire-guest-supervisor.ts" || item.path.startsWith("runtime/"));
  const manifest = { schemaVersion: 1, kind: "squire-sandbox-template-build-input", version: "v1", releaseState: "buildable-awaiting-external-conformance", baseImage: options["base-image"], baseDigest: options["base-digest"], configDigest: digest(Buffer.from(canonicalJson(configEntries), "utf8")), helperDigests: helperEntries.map(item => item.sha256), runtimeBundle: { path: "runtime/squirectl.mjs", sha256: entries.find(item => item.path === "runtime/squirectl.mjs").sha256 }, files: entries };
  if (options.context) {
    const contextEntries = entries.map(entry => ({ path: entry.path, bytes: entry.path === "Dockerfile" ? Buffer.from(dockerfile) : source.find(item => item.path === entry.path).bytes }));
    await writeContext(options.context, contextEntries);
  }
  if (options["local-tag"]) {
    const built = await runDocker(options.docker, options.context, options["local-tag"], path.dirname(options.context));
    const log = Buffer.concat([built.stdout, built.stderr]);
    if (options["build-log"]) { await assertNoSymlinkPath(options["build-log"], "build log", true); await writeCompleteExclusive(options["build-log"], log, 0o600, "build log"); }
    if (built.code !== 0 || built.signal) throw new Error(`template image build failed with ${built.code ?? built.signal ?? "unknown"}`);
    manifest.build = { localTag: options["local-tag"], dockerExecutable: options.docker, dockerExecutableSha256: built.executableDigest, buildLogSha256: digest(log) };
  }
  await assertNoSymlinkPath(options.output, "template build manifest", true); const outputParent = path.dirname(options.output); await assertNoSymlinkPath(outputParent, "template build manifest parent", true); await mkdir(outputParent, { recursive: true, mode: 0o700 }); await assertNoSymlinkPath(outputParent, "template build manifest parent");
  const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
  await writeCompleteExclusive(options.output, manifestBytes, 0o600, "template build manifest");
  const outputInfo = await lstat(options.output); if (!outputInfo.isFile() || outputInfo.isSymbolicLink() || outputInfo.nlink !== 1 || (outputInfo.mode & 0o077) !== 0 || outputInfo.size !== manifestBytes.length) throw new Error("template build manifest identity is not exact");
  process.stdout.write(`${canonicalJson(manifest)}\n`);
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
