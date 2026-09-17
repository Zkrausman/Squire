import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { LoadedPersonalMvpConfig, PersonalMvpConfig } from "./config.js";
import { validateCapturedRawConfig, validatePhaseTimeoutMs } from "./config.js";
import { validateEscalationPolicy, escalationDigest, validateModelPolicy } from "./model-policy.js";
import { validateSourceRef } from "./identity.js";
import { buildCorePrompt, buildPlanChildCore } from "./prompt-core.js";
import { builtinPrompts, capturePromptSet, decode, deepFreeze, DEFAULT_PROMPT_SELECTION, PLAN_SUBPHASES, record, validatePromptSelection, type CapturedPrompts, type PlanSubphase } from "./prompt-policy.js";
import { PERSONAL_PHASES, type PersonalPhase, type PersonalRunState } from "./types.js";
import { windowsLaunch } from "./windows-launch.js";

export interface LaunchMaterial {
  readonly version: 1;
  readonly rawConfig: string;
  readonly config: PersonalMvpConfig;
  readonly prompts: CapturedPrompts;
  readonly coreDigest: string;
  readonly digest: string;
}
export interface LaunchEvidence { readonly version: 1; readonly digest: string; readonly coreDigest: string; readonly promptSet: string; readonly planSubphases: readonly PlanSubphase[]; }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash("sha256").update("squire-launch-material-v1\0").update(canonical(value)).digest("hex"); }
export function coreDigest(): string { return hash([...PERSONAL_PHASES.map(buildCorePrompt), ...PLAN_SUBPHASES.map(buildPlanChildCore)]); }
export async function captureLaunchMaterial(loaded: LoadedPersonalMvpConfig): Promise<LaunchMaterial> {
  const { rawConfig, digest } = loaded;
  base64(rawConfig);
  if (createHash("sha256").update(Buffer.from(rawConfig, "base64")).digest("hex") !== digest) throw new Error("captured configuration digest mismatch");
  const clone = structuredClone(loaded.config);
  const config = deepFreeze({ ...clone, promptPolicy: validatePromptSelection(clone.promptPolicy ?? DEFAULT_PROMPT_SELECTION) });
  const prompts = await capturePromptSet(config.promptPolicy, config.repository.path);
  const body = { version: 1 as const, rawConfig, config, prompts, coreDigest: coreDigest() };
  return validateLaunchMaterial({ ...body, digest: hash(body) });
}
export function validateLaunchMaterial(value: unknown): LaunchMaterial {
  const v = record(value, ["version", "rawConfig", "config", "prompts", "coreDigest", "digest"], "launch material");
  if (v["version"] !== 1 || v["coreDigest"] !== coreDigest()) throw new Error("launch material core/version mismatch");
  base64(v["rawConfig"]);
  const raw = JSON.parse(decode(v["rawConfig"] as string));
  validateCapturedRawConfig(raw);
  const config = validateCapturedConfig(v["config"]);
  if (canonical(raw.escalationPolicy === undefined ? undefined : validateEscalationPolicy(raw.escalationPolicy)) !== canonical(config.escalationPolicy)) throw new Error("captured escalation policy mismatch");
  const prompts = record(v["prompts"], ["manifest", "phases", "subphases"], "captured prompts");
  base64(prompts["manifest"]);
  const manifest = record(JSON.parse(decode(prompts["manifest"] as string)), ["version", "id", "phases", "subphases"], "captured manifest");
  if (manifest["version"] !== 1 || manifest["id"] !== config.promptPolicy!.id) throw new Error("captured manifest identity mismatch");
  const manifestPhases = record(manifest["phases"], PERSONAL_PHASES, "captured manifest phases");
  const manifestSubphases = record(manifest["subphases"], PLAN_SUBPHASES, "captured manifest subphases");
  for (const key of PERSONAL_PHASES) if (typeof manifestPhases[key] !== "string") throw new Error("missing captured manifest phase");
  for (const key of config.promptPolicy!.plan) if (typeof manifestSubphases[key] !== "string") throw new Error("missing captured manifest subphase");
  if (config.promptPolicy!.root) {
    for (const file of [...Object.values(manifestPhases), ...Object.values(manifestSubphases)]) if (typeof file !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(file)) throw new Error("unsafe captured manifest path");
  } else if (canonical(prompts) !== canonical(builtinPrompts(config.promptPolicy!))) throw new Error("builtin prompt material mismatch");
  const phases = record(prompts["phases"], PERSONAL_PHASES, "captured phases");
  for (const phase of PERSONAL_PHASES) base64(phases[phase]);
  const ids = config.promptPolicy!.plan;
  const subphases = record(prompts["subphases"], ids, "captured subphases");
  for (const id of ids) base64(subphases[id]);
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
  return deepFreeze({ version: 1, digest: material.digest, coreDigest: material.coreDigest, promptSet: material.config.promptPolicy!.id, planSubphases: [...material.config.promptPolicy!.plan] });
}
export function validateLaunchEvidence(value: unknown): void {
  const v = record(value, ["version", "digest", "coreDigest", "promptSet", "planSubphases"], "launch evidence");
  if (v["version"] !== 1 || ![v["digest"], v["coreDigest"]].every(d => typeof d === "string" && /^[a-f0-9]{64}$/u.test(d))) throw new Error("invalid launch evidence digest");
  validatePromptSelection({ version: 1, id: v["promptSet"], root: "/captured", plan: v["planSubphases"] });
}
export function composeSystemPrompt(material: LaunchMaterial | undefined, phase: PersonalPhase, subphase?: PlanSubphase): string {
  if (subphase && (phase !== "plan" || !material?.config.promptPolicy?.plan.includes(subphase))) throw new Error("unselected subphase");
  const layers = [subphase ? buildPlanChildCore(subphase) : buildCorePrompt(phase)];
  if (material) {
    layers.push(decode(material.prompts.phases[phase]));
    if (subphase) layers.push(decode(material.prompts.subphases[subphase]!));
  }
  return layers.join("\n\n");
}
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
    windowsLaunch().persist(path.resolve(file), await repositoryPath(state), JSON.stringify({ version: 1, binding: binding(state, directory), material }));
    return;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await assertMaterialDirectory(file, state);
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(JSON.stringify({ version: 1, binding: binding(state, directory), material })); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
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
  if (envelope["version"] !== 1 || canonical(envelope["binding"]) !== canonical(binding(state, directory))) throw new Error("launch material binding mismatch");
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
  if (canonical(c.escalationPolicy) !== canonical(state.escalationPolicy) || (c.escalationPolicy ? escalationDigest(c.escalationPolicy) : undefined) !== state.escalationDigest) throw new Error("launch escalation policy mismatch");
  if (canonical(launchEvidence(material)) !== canonical(state.launchEvidence) || createHash("sha256").update(Buffer.from(material.rawConfig, "base64")).digest("hex") !== state.launchConfigDigest || c.repository.slug !== state.repository || c.repository.path !== state.repositoryPath || c.repository.sourceRef !== state.sourceRef || c.repository.baseBranch !== state.baseBranch) throw new Error("launch material state identity mismatch");
}
/** Validate normalized data without filesystem reads or environment resolution. */
function validateCapturedConfig(value: unknown): PersonalMvpConfig {
  const c = record(value, ["repository", "dataDirectory", "paths", "linear", "github", "sandbox", "modelPolicy", "escalationPolicy", "promptPolicy", "testCommands", "phaseTimeoutMs"], "captured configuration");
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
  if (c["escalationPolicy"] !== undefined) validateEscalationPolicy(c["escalationPolicy"]);
  validateModelPolicy(c["modelPolicy"]); validatePromptSelection(c["promptPolicy"]);
  if (c["phaseTimeoutMs"] !== undefined) validatePhaseTimeoutMs(c["phaseTimeoutMs"]);
  return c as unknown as PersonalMvpConfig;
}
