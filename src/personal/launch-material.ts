import { validateLaunchRetryPolicy } from "./launch-retry.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, link, unlink, rm } from "node:fs/promises";
import path from "node:path";
import type { LoadedPersonalMvpConfig, PersonalMvpConfig } from "./config.js";
import { validateCapturedRawConfig, validatePhaseTimeoutMs } from "./config.js";
import { APPROVED_PERSONAL_MODEL_POLICY, validateModelPolicy } from "./model-policy.js";
import { validateSourceRef } from "./identity.js";
import { buildCorePrompt } from "./prompt-core.js";
function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error(`invalid ${label}`);
  return value as Record<string, unknown>;
}
function decode(value: string): string { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64")); }
function deepFreeze<T>(v: T): T { if (v && typeof v === "object") { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); } return v; }
import { PERSONAL_PHASES, type PersonalPhase, type PersonalRunState } from "./types.js";
import { windowsLaunch } from "./windows-launch.js";

export interface LaunchMaterial {
  readonly version: 2;
  readonly rawConfig: string;
  readonly config: PersonalMvpConfig;
  readonly coreDigest: string;
  readonly digest: string;
}
export interface LaunchEvidence { readonly version: 2; readonly digest: string; readonly coreDigest: string; }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash("sha256").update("squire-launch-material-v2\0").update(canonical(value)).digest("hex"); }
export function coreDigest(): string { return hash(PERSONAL_PHASES.map(buildCorePrompt)); }
export async function captureLaunchMaterial(loaded: LoadedPersonalMvpConfig): Promise<LaunchMaterial> {
  const { rawConfig, digest } = loaded;
  base64(rawConfig);
  if (createHash("sha256").update(Buffer.from(rawConfig, "base64")).digest("hex") !== digest) throw new Error("captured configuration digest mismatch");
  const clone = structuredClone(loaded.config);
  const config = deepFreeze(clone);
  const body = { version: 2 as const, rawConfig, config, coreDigest: coreDigest() };
  return validateLaunchMaterial({ ...body, digest: hash(body) });
}
export function validateLaunchMaterial(value: unknown): LaunchMaterial {
  const v = record(value, ["version", "rawConfig", "config", "coreDigest", "digest"], "launch material");
  if (v["version"] !== 2 || v["coreDigest"] !== coreDigest()) throw new Error("launch material core/version mismatch");
  base64(v["rawConfig"]);
  const raw = JSON.parse(decode(v["rawConfig"] as string));
  validateCapturedRawConfig(raw);
  const config = validateCapturedConfig(v["config"]);
  if (canonical(validateModelPolicy(raw.modelPolicy ?? APPROVED_PERSONAL_MODEL_POLICY)) !== canonical(config.modelPolicy) || canonical(raw.testCommands) !== canonical(config.testCommands)) throw new Error("captured model/test configuration mismatch");
  if (canonical(validateLaunchRetryPolicy(raw.launchRetryPolicy)) !== canonical(validateLaunchRetryPolicy(config.launchRetryPolicy))) throw new Error("captured retry policy mismatch");
  const { digest, ...body } = v;
  if (typeof digest !== "string" || digest !== hash(body)) throw new Error("launch material digest mismatch");
  // JSON-copy means callers retain no mutable aliases. Strings, not Buffers,
  // store captured bytes; freezing a Buffer wrapper would not protect bytes.
  return deepFreeze(JSON.parse(JSON.stringify(v)) as LaunchMaterial);
}
function base64(value: unknown): void {
  if (typeof value !== "string" || !value.length || value.length > 2_000_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value) || Buffer.from(value, "base64").toString("base64") !== value) throw new Error("invalid canonical base64 capture");
  if (!decode(value).trim() || decode(value).includes("\0")) throw new Error("captured text contains NUL");
}
export function launchEvidence(material: LaunchMaterial): LaunchEvidence {
  return deepFreeze({ version: 2, digest: material.digest, coreDigest: material.coreDigest });
}
export function validateLaunchEvidence(value: unknown): void {
  const v = record(value, ["version", "digest", "coreDigest"], "launch evidence");
  if (v["version"] !== 2 || ![v["digest"], v["coreDigest"]].every(d => typeof d === "string" && /^[a-f0-9]{64}$/u.test(d))) throw new Error("invalid launch evidence digest");
}
export function composeSystemPrompt(_material: LaunchMaterial | undefined, phase: PersonalPhase): string { return buildCorePrompt(phase); }
function binding(state: PersonalRunState, stateDirectory: string): unknown {
  return { runId: state.runId, ticketId: state.ticketId, repository: state.repository, repositoryPath: state.repositoryPath, sourceRef: state.sourceRef, sourceSha: state.sourceSha ?? null, baseBranch: state.baseBranch, stateDirectory: path.resolve(stateDirectory), configPath: state.launchConfigPath, configDigest: state.launchConfigDigest, evidence: state.launchEvidence };
}
export function materialPath(directory: string, runId: string): string {
  if (!/^[a-z][a-z0-9]+-[a-z0-9][a-z0-9-]{7,127}$/u.test(runId)) throw new Error("invalid material run ID");
  return path.join(directory, "launch-material", `${runId}.json`);
}
export async function persistLaunchMaterial(material: LaunchMaterial, state: PersonalRunState, directory: string): Promise<void> {
  material = validateLaunchMaterial(material);
  assertMaterialState(material, state);
  const file = materialPath(directory, state.runId);
  if (process.platform === "win32") {
    windowsLaunch().persist(path.resolve(file), await repositoryPath(state), JSON.stringify({ version: 2, binding: binding(state, directory), material }));
    return;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await assertMaterialDirectory(file, state);
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(JSON.stringify({ version: 2, binding: binding(state, directory), material })); await handle.sync(); }
    finally { await handle.close(); }
    await link(temporary, file);
    await unlink(temporary);
  } finally { await rm(temporary, { force: true }); }
}
export async function readLaunchMaterial(state: PersonalRunState, directory: string): Promise<LaunchMaterial> {
  const file = materialPath(directory, state.runId);
  let bytes: string;
  if (process.platform === "win32") {
    bytes = windowsLaunch().read(path.resolve(file), await repositoryPath(state));
  } else {
    await assertMaterialDirectory(file, state);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 8_000_000 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error("unsafe launch material file");
      bytes = await handle.readFile("utf8");
    } finally { await handle.close(); }
  }
  const envelope = record(JSON.parse(bytes), ["version", "binding", "material"], "launch envelope");
  if (envelope["version"] !== 2 || canonical(envelope["binding"]) !== canonical(binding(state, directory))) throw new Error("launch material binding mismatch");
  const material = validateLaunchMaterial(envelope["material"]);
  assertMaterialState(material, state);
  return material;
}
async function repositoryPath(state: PersonalRunState): Promise<string> {
  if (!state.repositoryPath) return "";
  return realpath(state.repositoryPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.resolve(state.repositoryPath!);
  });
}
async function assertMaterialDirectory(file: string, state: PersonalRunState): Promise<void> {
  const directory = path.dirname(file);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) || (process.getuid && info.uid !== process.getuid())) throw new Error("unsafe launch material directory");
  if (state.repositoryPath) {
    const repository = await realpath(state.repositoryPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return path.resolve(state.repositoryPath!);
    });
    const relative = path.relative(repository, await realpath(directory));
    if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new Error("launch material must be outside repository");
  }
}
function assertMaterialState(material: LaunchMaterial, state: PersonalRunState): void {
  const c = material.config;
  if (canonical(c.modelPolicy) !== canonical(state.profiles)) throw new Error("captured profiles mismatch");
  if (canonical(validateLaunchRetryPolicy(c.launchRetryPolicy)) !== canonical(validateLaunchRetryPolicy(state.launchRetryPolicy))) throw new Error("launch retry policy mismatch");
  if (canonical(launchEvidence(material)) !== canonical(state.launchEvidence) || createHash("sha256").update(Buffer.from(material.rawConfig, "base64")).digest("hex") !== state.launchConfigDigest || c.repository.slug !== state.repository || c.repository.path !== state.repositoryPath || c.repository.sourceRef !== state.sourceRef || c.repository.baseBranch !== state.baseBranch) throw new Error("launch material state identity mismatch");
}
/** Validate normalized data without filesystem reads or environment resolution. */
function validateCapturedConfig(value: unknown): PersonalMvpConfig {
  const c = record(value, ["repository", "dataDirectory", "paths", "linear", "github", "sandbox", "modelPolicy", "launchRetryPolicy", "testCommands", "phaseTimeoutMs"], "captured configuration");
  const text = (v: unknown) => { if (typeof v !== "string" || !v.trim() || v.includes("\0")) throw new Error("invalid captured configuration string"); };
  const absolute = (v: unknown) => { text(v); if (!path.isAbsolute(v as string)) throw new Error("captured path is not absolute"); };
  const repo = record(c["repository"], ["slug", "path", "sourceRef", "baseBranch"], "captured repository");
  text(repo["slug"]); absolute(repo["path"]); validateSourceRef(repo["sourceRef"]); text(repo["baseBranch"]); absolute(c["dataDirectory"]);
  const paths = record(c["paths"], ["state", "bridges", "staging"], "captured paths"); for (const key of ["state", "bridges", "staging"]) absolute(paths[key]);
  const linear = record(c["linear"], ["apiKeyEnv", "endpoint"], "captured linear"); text(linear["apiKeyEnv"]); if (linear["endpoint"] !== undefined) text(linear["endpoint"]);
  const github = record(c["github"], ["tokenCommand"], "captured github");
  for (const list of [github["tokenCommand"], c["testCommands"]]) { if (!Array.isArray(list) || !list.length || list.length > 100) throw new Error("invalid captured command list"); for (const item of list) text(item); }
  const sandbox = record(c["sandbox"], ["roleUser", "piExecutable", "piAgentDirectory", "piAuthFile", "template"], "captured sandbox");
  for (const key of ["roleUser", "piExecutable", "piAgentDirectory"]) text(sandbox[key]);
  for (const key of ["template", "piAuthFile"]) if (sandbox[key] !== undefined) text(sandbox[key]);
  validateLaunchRetryPolicy(c["launchRetryPolicy"]);
  validateModelPolicy(c["modelPolicy"]);
  if (c["phaseTimeoutMs"] !== undefined) validatePhaseTimeoutMs(c["phaseTimeoutMs"]);
  return c as unknown as PersonalMvpConfig;
}
