import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath } from "node:fs/promises";
import { createReadStream, readdirSync, readFileSync, lstatSync } from "node:fs";
import type { Writable } from "node:stream";
import path from "node:path";
import os from "node:os";
import type { PersonalModelPolicy } from "./model-policy.js";

const PACKAGE = "@earendil-works/pi-coding-agent";
const SHA = /^[a-f0-9]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u;
const MAX_BYTES = 64 * 1024;

/** Evidence produced in the running Pi process, never by a model or CLI flag. */
export interface OwnerPiIdentity {
  readonly schema: 1;
  readonly pid: number;
  readonly cliPath: string;
  readonly version: string;
  readonly manifestSha256: string;
  readonly cliSha256: string;
  readonly codeTreeSha256: string;
  readonly modelConfigPath: string;
  readonly modelConfigSha256: string | null;
  readonly phaseModelsSha256: string;
  readonly modelStorePath: string;
  readonly modelStoreSha256: string;
  readonly models: readonly string[];
  readonly extensions: readonly []; // Ticket phases execute with --no-extensions.
}

const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Cross-platform Pi executable JS/JSON plus shared dependencies. npm's optional
 * @esbuild binaries differ by OS; only the Linux-x64 variant can be compared.
 * The exact function body is reused in the sandbox so the digest cannot drift. */
export function executableCodeDigest(root: string): string {
  const digest = createHash("sha256");
  let count = 0, bytesTotal = 0;
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const full = `${directory}/${name}`;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { walk(full, relative); continue; }
      if (!/\.(?:js|cjs|mjs|json)$/u.test(name) || (relative.startsWith("node_modules/@esbuild/") && !relative.startsWith("node_modules/@esbuild/linux-x64/"))) continue;
      const bytes = readFileSync(full);
      count++; bytesTotal += bytes.length;
      if (count > 20_000 || bytesTotal > 128 * 1024 * 1024) throw new Error("Pi executable tree exceeds parity bound");
      digest.update(relative).update("\0").update(bytes).update("\0");
    }
  };
  walk(root, "");
  if (count < 1) throw new Error("Pi executable tree missing");
  return digest.digest("hex");
}

export function phaseModelsDigest(models: readonly { provider: string; id: string }[], policy: PersonalModelPolicy): string {
  const selected = [policy.implement, policy.verify].map(profile => {
    const matches = models.filter(model => model.provider === profile.provider && model.id === profile.model);
    if (matches.length !== 1) throw new Error(`owner Pi lacks unique ${profile.provider}/${profile.model}`);
    return matches[0];
  });
  return hash(Buffer.from(JSON.stringify(selected), "utf8"));
}

export function validateOwnerPiIdentity(value: unknown): asserts value is OwnerPiIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("missing owner Pi identity");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== "cliPath,cliSha256,codeTreeSha256,extensions,manifestSha256,modelConfigPath,modelConfigSha256,modelStorePath,modelStoreSha256,models,phaseModelsSha256,pid,schema,version" || v["schema"] !== 1 || typeof v["cliPath"] !== "string" || !path.isAbsolute(v["cliPath"]) || v["cliPath"].includes("\0") || !Number.isSafeInteger(v["pid"])  || (v["pid"] as number) <= 0 || typeof v["version"] !== "string" || !VERSION.test(v["version"]) || typeof v["manifestSha256"] !== "string" || !SHA.test(v["manifestSha256"]) || typeof v["cliSha256"] !== "string" || !SHA.test(v["cliSha256"]) || typeof v["codeTreeSha256"] !== "string" || !SHA.test(v["codeTreeSha256"]) || typeof v["phaseModelsSha256"] !== "string" || !SHA.test(v["phaseModelsSha256"]) || typeof v["modelConfigPath"] !== "string" || !path.isAbsolute(v["modelConfigPath"]) || path.basename(v["modelConfigPath"]) !== "models.json" || (v["modelConfigSha256"] !== null && (typeof v["modelConfigSha256"] !== "string" || !SHA.test(v["modelConfigSha256"]))) || typeof v["modelStorePath"] !== "string" || !path.isAbsolute(v["modelStorePath"]) || path.basename(v["modelStorePath"]) !== "models-store.json" || typeof v["modelStoreSha256"] !== "string" || !SHA.test(v["modelStoreSha256"]) || !Array.isArray(v["extensions"]) || v["extensions"].length !== 0 || !Array.isArray(v["models"]) || v["models"].length < 2 || v["models"].length > 10000 || v["models"].some(model => typeof model !== "string" || model.length > 300 || !/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(model))) throw new Error("invalid owner Pi identity");
  if (new Set(v["models"]).size !== v["models"].length) throw new Error("duplicate owner Pi model");
}

export function requireOwnerModels(identity: OwnerPiIdentity, policy: PersonalModelPolicy): void {
  validateOwnerPiIdentity(identity);
  for (const profile of [policy.implement, policy.verify]) {
    if (!identity.models.includes(`${profile.provider}/${profile.model}`)) throw new Error(`owner Pi lacks ${profile.provider}/${profile.model}`);
  }
}

/** Called only by the installed Pi extension in its own process. */
export async function captureOwnerPiIdentity(cliArgument: string | undefined, registry: { getAvailable(): readonly { provider: string; id: string }[] }, policy: PersonalModelPolicy): Promise<OwnerPiIdentity> {
  if (!cliArgument || !path.isAbsolute(cliArgument)) throw new Error("running Pi CLI path unavailable");
  const cli = await realpath(cliArgument);
  let directory = path.dirname(cli);
  for (;;) {
    const manifestPath = path.join(directory, "package.json");
    try {
      const bytes = await readFile(manifestPath);
      const manifest = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (manifest["name"] === PACKAGE) {
        const bin = manifest["bin"];
        const relative = typeof bin === "string" ? bin : bin && typeof bin === "object" ? (bin as Record<string, unknown>)["pi"] : undefined;
        if (typeof relative !== "string" || path.isAbsolute(relative) || relative.includes("..") || await realpath(path.join(directory, relative)) !== cli) throw new Error("running Pi executable does not match its package manifest");
        const available = registry.getAvailable();
        const models = available.map(model => `${model.provider}/${model.id}`).sort();
        const agentDir = process.env["PI_CODING_AGENT_DIR"] ?? path.join(process.platform === "win32" ? process.env["USERPROFILE"] ?? os.homedir() : os.homedir(), ".pi", "agent");
        const modelStorePath = path.join(agentDir, "models-store.json");
        const modelConfigPath = path.join(agentDir, "models.json");
        const modelConfigSha256 = await modelConfigDigest(modelConfigPath);
        const modelStoreSha256 = hash(await readFile(modelStorePath));
        const identity: OwnerPiIdentity = { schema: 1, pid: process.pid, cliPath: cli, version: manifest["version"] as string, manifestSha256: hash(bytes), cliSha256: hash(await readFile(cli)), codeTreeSha256: executableCodeDigest(directory), modelConfigPath, modelConfigSha256, phaseModelsSha256: phaseModelsDigest(available, policy), modelStorePath, modelStoreSha256, models, extensions: [] };
        validateOwnerPiIdentity(identity);
        return identity;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("running Pi package cannot be established");
    directory = parent;
  }
}

/** Private inherited fd 3, not a command-line catalog or ambient environment variable. */
export async function launchFromPi(executable: string, args: readonly string[], cwd: string, identity: OwnerPiIdentity): Promise<number> {
  validateOwnerPiIdentity(identity);
  if (!path.isAbsolute(executable) || !path.isAbsolute(cwd) || identity.pid !== process.pid) throw new Error("Pi bridge process mismatch");
  const child = spawn(executable, [...args], { cwd, shell: false, env: { ...process.env, SQUIRE_OWNER_PI_CHANNEL: "fd3-v1" }, stdio: ["inherit", "inherit", "inherit", "pipe"] });
  const payload = Buffer.from(JSON.stringify(identity), "utf8");
  if (payload.byteLength > MAX_BYTES) { child.kill(); throw new Error("Pi identity exceeds bound"); }
  const pipe = child.stdio[3];
  if (!pipe) { child.kill(); throw new Error("Pi identity pipe unavailable"); }
  (pipe as Writable).end(payload);
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 1)));
  });
}

export async function receiveOwnerPiIdentity(fd = 3, parentPid = process.ppid): Promise<OwnerPiIdentity> {
  if (process.env["SQUIRE_OWNER_PI_CHANNEL"] !== "fd3-v1") throw new Error("trusted owner-facing Pi bridge required for a new run");
  const stream = createReadStream("", { fd, autoClose: false });
  const timeout = setTimeout(() => stream.destroy(new Error("Pi identity channel timed out")), 5_000);
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error("Pi identity exceeds bound");
      parts.push(chunk);
    }
  } finally { clearTimeout(timeout); stream.destroy(); }
  const identity: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
  validateOwnerPiIdentity(identity);
  if (identity.pid !== parentPid) throw new Error("Pi identity parent process mismatch");
  await verifyRunningParentPi(identity);
  return identity;
}

export async function verifyRunningParentPi(identity: OwnerPiIdentity): Promise<void> {
  validateOwnerPiIdentity(identity);
  const actualCli = await realpath(identity.cliPath);
  if (actualCli !== identity.cliPath || hash(await readFile(actualCli)) !== identity.cliSha256) throw new Error("parent Pi executable changed");
  const manifest = await readFile(path.resolve(path.dirname(actualCli), "../../package.json"));
  const packageData = JSON.parse(manifest.toString("utf8")) as Record<string, unknown>;
  if (packageData["name"] !== PACKAGE || packageData["version"] !== identity.version || hash(manifest) !== identity.manifestSha256) throw new Error("parent Pi package mismatch");
  if (hash(await readFile(identity.modelStorePath)) !== identity.modelStoreSha256) throw new Error("parent Pi model store changed");
  if (await modelConfigDigest(identity.modelConfigPath) !== identity.modelConfigSha256) throw new Error("parent Pi model config changed");
  if (executableCodeDigest(path.dirname(path.dirname(path.dirname(actualCli)))) !== identity.codeTreeSha256) throw new Error("parent Pi executable code changed");
  let firstScript: string | undefined;
  if (process.platform === "win32") {
    const command = `Get-CimInstance Win32_Process -Filter 'ProcessId=${identity.pid}' | Select-Object -ExpandProperty CommandLine`;
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 10_000, maxBuffer: 16 * 1024 });
    const match = /^\s*(?:"[^"]+"|\S+)\s+(?:"([^"]+)"|(\S+))(?:\s|$)/u.exec(stdout.trim());
    firstScript = match?.[1] ?? match?.[2];
  } else {
    const arguments_ = (await readFile(`/proc/${identity.pid}/cmdline`)).toString("utf8").split("\0");
    firstScript = arguments_[1];
  }
  if (!firstScript || await realpath(firstScript) !== actualCli) throw new Error("parent process is not running the asserted Pi CLI");
}

export async function modelConfigDigest(file: string): Promise<string | null> {
  let bytes: Buffer;
  try { bytes = await readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("owner Pi model config invalid");
  const providers = (value as Record<string, unknown>)["providers"];
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) throw new Error("owner Pi model providers invalid");
  if (Object.hasOwn(providers, "openai-codex")) throw new Error("owner Pi phase model overrides cannot be reproduced safely");
  return hash(bytes);
}

export async function assertSandboxPiIdentity(identity: OwnerPiIdentity, packageManifest: Buffer, cliBytes: Buffer, availableModels: readonly string[], policy: PersonalModelPolicy): Promise<void> {
  validateOwnerPiIdentity(identity);
  const manifest = JSON.parse(packageManifest.toString("utf8")) as Record<string, unknown>;
  if (manifest["name"] !== PACKAGE || manifest["version"] !== identity.version || hash(packageManifest) !== identity.manifestSha256 || hash(cliBytes) !== identity.cliSha256) throw new Error("sandbox Pi does not match owner-facing Pi package");
  for (const profile of [policy.implement, policy.verify]) if (!availableModels.includes(`${profile.provider}/${profile.model}`)) throw new Error(`sandbox Pi lacks ${profile.provider}/${profile.model}`);
}
