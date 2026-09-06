#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { assertNoReparsePath, canonicalHostPath, digest, ensureEmptyPrivateDirectory, explicitHostEnvironment, privateRegular, readStableFile, runTrusted, writeExclusiveFile } from "./acceptance/trusted-host-runtime.mjs";

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

function fail(message) { throw new Error(message); }
function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") { if (!Number.isFinite(value)) fail("non-finite number"); return JSON.stringify(value); }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") fail("unsupported JSON value");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function parse(argv) {
  const result = {};
  const supported = ["--base-image", "--base-digest", "--output", "--context", "--docker", "--local-tag", "--build-log"];
  for (let i = 0; i < argv.length; i += 1) { const key = argv[i]; if (!supported.includes(key) || typeof argv[i + 1] !== "string" || argv[i + 1].startsWith("--") || Object.hasOwn(result, key.slice(2))) throw new Error(usage); result[key.slice(2)] = argv[++i]; }
  if (!result["base-image"] || !/^([a-z0-9.-]+\/)?[a-z0-9._-]+\/[a-z0-9._-]+$/u.test(result["base-image"]) || !SHA.test(result["base-digest"]) || !result.output) throw new Error("an exact qualified base image and digest plus absolute output are required");
  canonicalHostPath(result.output, "template build manifest", { allowRoot: false });
  if (result.context) canonicalHostPath(result.context, "template context", { allowRoot: false });
  if (result.docker) canonicalHostPath(result.docker, "Docker executable", { allowRoot: false });
  if (result["build-log"]) canonicalHostPath(result["build-log"], "build log", { allowRoot: false });
  if (result["local-tag"] && (!/^[a-z0-9][a-z0-9._/-]{0,255}$/u.test(result["local-tag"]) || /latest/iu.test(result["local-tag"]) || result["local-tag"].includes("@sha256:"))) throw new Error("local build tag is unsafe or mutable latest");
  if (result["local-tag"] && (!result.context || !result.docker)) throw new Error("--local-tag requires --context and --docker");
  return result;
}
function replaceFrom(dockerfile, image, digestValue) {
  const replaced = dockerfile.replace("FROM ${SQUIRE_BASE_IMAGE}@${SQUIRE_BASE_DIGEST}", `FROM ${image}@${digestValue}`);
  if (replaced === dockerfile || !/^FROM [^\s@]+@sha256:[0-9a-f]{64}$/mu.test(replaced)) fail("template does not resolve to one immutable base image");
  return replaced;
}
async function writeCompleteExclusive(target, bytes, mode, label) {
  if (process.platform === "win32") { await writeExclusiveFile(target, bytes, label); return; }
  await assertNoReparsePath(path.dirname(target), `${label} parent`, true);
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { let offset = 0; while (offset < bytes.length) { const result = await handle.write(bytes, offset, bytes.length - offset, offset); if (result.bytesWritten <= 0) fail(`${label} write ended early`); offset += result.bytesWritten; } await handle.chmod(mode); await handle.sync(); }
  catch (error) { await handle.close().catch(() => undefined); await unlink(target).catch(() => undefined); throw error; }
  await handle.close();
}
async function readSource(relative) {
  const target = path.join(templateRoot, relative); await assertNoReparsePath(target, `template source ${relative}`); await privateRegular(target, `template source ${relative}`, 16 * 1024 * 1024, false); return readStableFile(target, `template source ${relative}`, 16 * 1024 * 1024, false);
}
async function writeContext(context, entries) {
  await ensureEmptyPrivateDirectory(context, "template context");
  for (const entry of entries) {
    const target = path.join(context, entry.path); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await assertNoReparsePath(path.dirname(target), `template context parent ${entry.path}`);
    if (process.platform !== "win32") { const parentInfo = await lstat(path.dirname(target)); if ((parentInfo.mode & 0o777) !== 0o700) fail(`template context parent ${entry.path} is not private`); }
    const mode = entry.path.endsWith(".sh") || entry.path.endsWith(".mjs") ? 0o555 : 0o444;
    await writeCompleteExclusive(target, entry.bytes, mode, `template context entry ${entry.path}`);
    const fileInfo = await lstat(target); if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || process.platform !== "win32" && (fileInfo.nlink !== 1 || (fileInfo.mode & 0o777) !== mode) || fileInfo.size !== entry.bytes.length) fail(`template context entry ${entry.path} identity is not exact`);
  }
}
async function runDocker(executable, context, tag, cwd) {
  await privateRegular(executable, "Docker executable", 256 * 1024 * 1024, false);
  const argv = ["build", "--file", path.join(context, "Dockerfile"), "--tag", tag, context];
  return runTrusted(executable, argv, "Docker build", { cwd, environment: explicitHostEnvironment(cwd) });
}
async function main() {
  const options = parse(process.argv.slice(2));
  const source = await Promise.all(files.map(async relative => ({ path: relative, bytes: await readSource(relative) })));
  const dockerfile = replaceFrom(source.find(item => item.path === "Dockerfile").bytes.toString("utf8"), options["base-image"], options["base-digest"]);
  const entries = source.map(item => ({ path: item.path, sha256: digest(item.path === "Dockerfile" ? Buffer.from(dockerfile) : item.bytes) }));
  const configEntries = entries.filter(item => !item.path.startsWith("runtime/") && item.path !== "supervisor/squire-guest-supervisor.ts");
  const helperEntries = entries.filter(item => item.path === "supervisor/squire-guest-supervisor.ts" || item.path.startsWith("runtime/"));
  const manifest = { schemaVersion: 1, kind: "squire-sandbox-template-build-input", version: "v1", releaseState: "buildable-awaiting-external-conformance", baseImage: options["base-image"], baseDigest: options["base-digest"], configDigest: digest(Buffer.from(canonicalJson(configEntries), "utf8")), helperDigests: helperEntries.map(item => item.sha256), runtimeBundle: { path: "runtime/squirectl.mjs", sha256: entries.find(item => item.path === "runtime/squirectl.mjs").sha256 }, files: entries };
  if (options.context) await writeContext(options.context, entries.map(entry => ({ path: entry.path, bytes: entry.path === "Dockerfile" ? Buffer.from(dockerfile) : source.find(item => item.path === entry.path).bytes })));
  if (options["local-tag"]) {
    const built = await runDocker(options.docker, options.context, options["local-tag"], path.dirname(options.context));
    const log = Buffer.from(`${built.stdout}${built.stderr}`, "utf8");
    if (options["build-log"]) await writeCompleteExclusive(options["build-log"], log, 0o600, "build log");
    if (built.code !== undefined && built.code !== 0 || built.signal) fail(`template image build failed with ${built.code ?? built.signal ?? "unknown"}`);
    manifest.build = { localTag: options["local-tag"], dockerExecutable: options.docker, dockerExecutableSha256: built.executableDigest, buildLogSha256: digest(log) };
  }
  await assertNoReparsePath(options.output, "template build manifest", true); await mkdir(path.dirname(options.output), { recursive: true, mode: 0o700 });
  const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8"); await writeCompleteExclusive(options.output, manifestBytes, 0o600, "template build manifest");
  const outputInfo = await lstat(options.output); if (!outputInfo.isFile() || outputInfo.isSymbolicLink() || process.platform !== "win32" && (outputInfo.nlink !== 1 || (outputInfo.mode & 0o077) !== 0) || outputInfo.size !== manifestBytes.length) fail("template build manifest identity is not exact");
  process.stdout.write(`${canonicalJson(manifest)}\n`);
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
