#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { assertReleaseSemantics } from "../../dist/src/sandbox/contracts.js";
import { assertSandboxName, assertSandboxRunId, assertReleaseId, canonicalBytes, deriveSandboxName } from "../../dist/src/sandbox/identity.js";
import { HOST_PROBE_NAMES, validateHostProbeRequest, validateHostProbeResult } from "../../dist/src/sandbox/host-acceptance.js";

const MAX_OUTPUT = 4 * 1024 * 1024;
const TIMEOUT_MS = 5_000;
const usage = "usage: sandbox-v039.mjs --release FILE --output FILE --request FILE --run-id RUN_ID --sandbox-name NAME";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--release", "--output", "--request", "--run-id", "--sandbox-name"].includes(key) || typeof argv[index + 1] !== "string" || argv[index + 1].startsWith("--") || Object.hasOwn(result, key.slice(2))) throw new Error(usage);
    result[key.slice(2)] = argv[++index];
  }
  if (Object.keys(result).length !== 5 || Object.values(result).some(value => !value)) throw new Error(usage);
  return result;
}

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(message) { const error = new Error(message); error.code = "HOST_CONFORMANCE_FAILED"; throw error; }
async function canonicalFilePath(value, label, mustExist = true) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || value === path.parse(value).root || value.endsWith(path.sep) || value.includes("\\") || value.includes("//") || /[\u0000-\u001f\u007f\r\n]/u.test(value)) fail(`${label} is not a canonical absolute path`);
  const resolved = await realpath(value).catch(error => { if (error?.code === "ENOENT") return undefined; throw error; });
  if (mustExist && !resolved) fail(`${label} does not exist`);
  if (resolved && resolved !== value) fail(`${label} is a symlink or has a symlink ancestor`);
  let current = path.parse(value).root;
  const parts = value.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const info = await lstat(current).catch(error => { if (error?.code === "ENOENT") return undefined; throw error; });
    if (info?.isSymbolicLink()) fail(`${label} has a symlink path component`);
    if (!info && index < parts.length - 1) fail(`${label} has a missing parent directory`);
  }
  return value;
}
async function validateRelease(release, releaseBytes) {
  if (!release || typeof release !== "object" || Array.isArray(release)) fail("release is not an object");
  if (!releaseBytes.equals(canonicalBytes(release))) fail("release is not deterministically serialized");
  try { assertReleaseSemantics(release); } catch (error) { fail(error instanceof Error ? error.message : "release semantic validation failed"); }
  if (release.promotion.state !== "validated") fail("release is blocked: no external conformance may be inferred from this harness");
  await canonicalFilePath(release.sbxBinary.path, "release sbx binary");
  if (!/^sha256:[0-9a-f]{64}$/u.test(release.template.digest) || release.template.reference !== `${release.template.reference.split("@")[0]}@${release.template.digest}`) fail("release lacks an immutable template identity");
}
function makeRequest(options, release) {
  assertSandboxRunId(options["run-id"]); assertSandboxName(options["sandbox-name"]); assertReleaseId(release.releaseId);
  if (options["sandbox-name"] !== deriveSandboxName(options["run-id"])) fail("sandbox name is not derived from the complete run ID");
  const request = { schemaVersion: 1, kind: "squire-sandbox-host-probe-request", requestId: randomUUID(), runId: options["run-id"], sandboxName: options["sandbox-name"], releaseId: release.releaseId, platform: release.platform, architecture: release.architecture, probes: [...HOST_PROBE_NAMES], requestedAt: new Date().toISOString() };
  try { return validateHostProbeRequest(request); } catch (error) { fail(error instanceof Error ? error.message : "host probe request is invalid"); }
}
async function writeExclusive(file, value) {
  await canonicalFilePath(file, "acceptance artifact", false);
  await writeFile(file, canonicalBytes(value), { flag: "wx", mode: 0o600 });
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0) fail("acceptance artifact was not a private regular file");
}
async function run(executable, argv) {
  if (!path.isAbsolute(executable) || argv.some(value => typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f\r\n]/u.test(value))) fail("host harness command is not a clean argv-only invocation");
  await canonicalFilePath(executable, "host harness executable");
  const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd: path.dirname(executable), env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks = []; const stderrChunks = []; let outputBytes = 0; let settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(hardTimer); callback(value); };
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, TIMEOUT_MS);
    const hardTimer = setTimeout(() => { child.kill("SIGKILL"); finish(reject, new Error("host harness command did not exit after timeout")); }, TIMEOUT_MS + 1_000);
    const collect = target => chunk => {
      const bytes = Buffer.from(chunk); outputBytes += bytes.length;
      if (outputBytes > MAX_OUTPUT) { child.kill("SIGTERM"); finish(reject, new Error("host harness output exceeded its bound")); return; }
      (target === "stdout" ? stdoutChunks : stderrChunks).push(bytes);
    };
    child.stdout.on("data", collect("stdout")); child.stderr.on("data", collect("stderr"));
    child.once("error", error => finish(reject, error));
    child.once("exit", (code, signal) => {
      try {
        const stdout = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdoutChunks));
        const stderr = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stderrChunks));
        finish(resolve, { code, signal, stdout, stderr });
      } catch (error) { finish(reject, new Error(`host harness output was not UTF-8: ${error instanceof Error ? error.message : String(error)}`)); }
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const releaseFile = path.resolve(options.release);
  await canonicalFilePath(releaseFile, "release manifest");
  const releaseBytes = await readFile(releaseFile);
  let release; try { release = JSON.parse(releaseBytes.toString("utf8")); } catch { fail("release is not JSON"); }
  await validateRelease(release, releaseBytes);
  const request = makeRequest(options, release);
  await writeExclusive(options.request, request);
  const result = { schemaVersion: 1, kind: "squire-sandbox-host-probe-result", requestId: request.requestId, runId: request.runId, sandboxName: request.sandboxName, releaseId: request.releaseId, platform: request.platform, architecture: request.architecture, status: "fail", hostOnly: true, evidence: [], completedAt: new Date().toISOString() };
  try {
    const executableBytes = await readFile(release.sbxBinary.path);
    if (digest(executableBytes) !== release.sbxBinary.sha256) fail("installed sbx binary differs from the promoted digest");
    const version = await run(release.sbxBinary.path, ["--version"]);
    const versionOutput = version.stdout.trim();
    if (version.code !== 0 || !/^sbx(?: version)? 0\.39\.0$/u.test(versionOutput) && versionOutput !== "0.39.0") fail("installed sbx version is not exact v0.39.0");
    const help = await run(release.sbxBinary.path, ["--help"]);
    if (help.code !== 0 || digest(Buffer.from(help.stdout, "utf8")) !== release.sbxBinary.helpDigest) fail("installed sbx help surface differs from the promoted identity");
  } catch (error) {
    await writeExclusive(options.output, result);
    throw error;
  }
  // This command deliberately does not execute destructive VM, quota, network,
  // process-topology, Herdr, or removal probes. A trusted external worker must
  // consume the request and publish a separately authenticated result.
  try { validateHostProbeResult(result, request); } catch (error) { fail(error instanceof Error ? error.message : "host probe result is invalid"); }
  await writeExclusive(options.output, result);
  fail("host conformance destructive probes require the external orchestrator; no acceptance claim was emitted");
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
