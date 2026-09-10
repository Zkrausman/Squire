import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  APPROVED_PERSONAL_MODEL_POLICY,
  validateModelPolicy,
  validatePhaseProfile,
  type PersonalModelPolicy,
  type PhaseProfile,
} from "./model-policy.js";

export interface PersonalMvpConfig {
  readonly repository: {
    readonly slug: string;
    readonly path: string;
    readonly sourceRef: string;
    readonly baseBranch: string;
  };
  readonly paths: {
    readonly state: string;
    readonly bridges: string;
    readonly staging: string;
  };
  readonly linear: {
    readonly apiKeyEnv: string;
    readonly endpoint?: string;
  };
  readonly github: {
    readonly tokenCommand: readonly string[];
  };
  readonly sandbox: {
    readonly template?: string;
    readonly roleUser: string;
    readonly piExecutable: string;
    readonly piAgentDirectory: string;
    readonly piAuthFile?: string;
  };
  /** Normalized policy; Plan is always exactly two equal buckets. */
  readonly profiles: PersonalModelPolicy;
  /** Descriptive alias for callers that want to distinguish policy from paths. */
  readonly modelPolicy: PersonalModelPolicy;
  readonly testCommands: readonly string[];
}

export interface ConfigPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly homeDirectory?: string;
}

/** Resolve the per-user Squire directory without looking in the repository. */
export function defaultSquireDirectory(options?: ConfigPathOptions): string;
export function defaultSquireDirectory(platform: NodeJS.Platform, env?: NodeJS.ProcessEnv): string;
export function defaultSquireDirectory(first?: ConfigPathOptions | NodeJS.Platform, suppliedEnv?: NodeJS.ProcessEnv): string {
  const options = pathOptions(first, suppliedEnv);
  const environment = options.env;
  if (options.platform === "win32") {
    const userProfile = nonempty(environment["USERPROFILE"])
      ?? (nonempty(environment["HOMEDRIVE"]) && nonempty(environment["HOMEPATH"]) ? `${environment["HOMEDRIVE"]}${environment["HOMEPATH"]}` : undefined)
      ?? options.homeDirectory
      ?? os.homedir();
    return path.win32.normalize(path.win32.join(userProfile, ".squire"));
  }
  const home = nonempty(environment["HOME"]) ?? options.homeDirectory ?? os.homedir();
  const xdg = nonempty(environment["XDG_CONFIG_HOME"]);
  const configHome = xdg ? resolvePosixHome(xdg, options.cwd) : path.posix.join(home, ".config");
  return path.posix.normalize(path.posix.join(configHome, "squire"));
}

/** Return the only implicit config location supported by the personal CLI. */
export function defaultConfigPath(options?: ConfigPathOptions): string;
export function defaultConfigPath(platform: NodeJS.Platform, env?: NodeJS.ProcessEnv): string;
export function defaultConfigPath(first?: ConfigPathOptions | NodeJS.Platform, suppliedEnv?: NodeJS.ProcessEnv): string {
  const options = pathOptions(first, suppliedEnv);
  const directory = defaultSquireDirectory(options);
  return options.platform === "win32"
    ? path.win32.join(directory, "config.json")
    : path.posix.join(directory, "config.json");
}

/**
 * Apply the explicit CLI path, SQUIRE_CONFIG, then the per-user default.
 * Relative explicit/environment paths are relative to the invoking directory;
 * paths inside the selected JSON file are resolved by loadPersonalMvpConfig.
 */
export function resolveConfigPath(explicit?: string, options: ConfigPathOptions = {}): string {
  const selected = nonempty(explicit) ?? nonempty((options.env ?? process.env)["SQUIRE_CONFIG"]);
  if (selected) return resolveHostPath(options.cwd ?? process.cwd(), selected, options.platform ?? process.platform);
  return defaultConfigPath(options);
}

// Names used by integrations and tests; all delegate to the same precedence.
export const resolvePersonalConfigPath = resolveConfigPath;
export const resolveDefaultConfigPath = defaultConfigPath;
export const getDefaultConfigPath = defaultConfigPath;
export const getPersonalSquireDirectory = defaultSquireDirectory;

export async function loadPersonalMvpConfig(file?: string, options: ConfigPathOptions = {}): Promise<PersonalMvpConfig> {
  const platform = options.platform ?? process.platform;
  const absolute = resolveConfigPath(file, options);
  const raw: unknown = JSON.parse(await readFile(absolute, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("configuration must be an object");
  const value = raw as Record<string, unknown>;
  const repository = object(value["repository"], "repository");
  const paths = object(value["paths"], "paths");
  const linear = object(value["linear"], "linear");
  const github = object(value["github"], "github");
  const sandbox = object(value["sandbox"], "sandbox");
  const base = platform === "win32" ? path.win32.dirname(absolute) : path.dirname(absolute);

  const hasModelPolicy = Object.prototype.hasOwnProperty.call(value, "modelPolicy");
  const hasProfiles = Object.prototype.hasOwnProperty.call(value, "profiles");
  if (hasModelPolicy && hasProfiles) throw new Error("configuration must define either modelPolicy or profiles, not both");
  const policyValue = hasModelPolicy
    ? value["modelPolicy"]
    : hasProfiles
      ? value["profiles"]
      : undefined;
  const modelPolicy = policyValue === undefined
    ? clonePolicy(APPROVED_PERSONAL_MODEL_POLICY)
    : parseModelPolicy(policyValue);

  const testCommands = value["testCommands"];
  if (!Array.isArray(testCommands) || testCommands.length === 0 || testCommands.length > 100 || testCommands.some(command => typeof command !== "string" || command.length === 0 || command.length > 2_000)) throw new Error("testCommands must be a non-empty string array");
  const tokenCommand = github["tokenCommand"];
  if (!Array.isArray(tokenCommand) || tokenCommand.length === 0 || tokenCommand.length > 32 || tokenCommand.some(argument => typeof argument !== "string" || argument.length === 0 || argument.length > 2_000)) throw new Error("github.tokenCommand must be a non-empty string array");
  const endpoint = linear["endpoint"];
  if (endpoint !== undefined && typeof endpoint !== "string") throw new Error("linear.endpoint must be a string");
  const template = sandbox["template"];
  if (template !== undefined && typeof template !== "string") throw new Error("sandbox.template must be a string");
  const piAuthFile = sandbox["piAuthFile"];
  if (piAuthFile !== undefined && typeof piAuthFile !== "string") throw new Error("sandbox.piAuthFile must be a string");

  return {
    repository: {
      slug: text(repository["slug"], "repository.slug"),
      path: resolveHostPath(base, text(repository["path"], "repository.path"), platform),
      sourceRef: text(repository["sourceRef"], "repository.sourceRef"),
      baseBranch: text(repository["baseBranch"], "repository.baseBranch"),
    },
    paths: {
      state: resolveHostPath(base, text(paths["state"], "paths.state"), platform),
      bridges: resolveHostPath(base, text(paths["bridges"], "paths.bridges"), platform),
      staging: resolveHostPath(base, text(paths["staging"], "paths.staging"), platform),
    },
    linear: {
      apiKeyEnv: text(linear["apiKeyEnv"], "linear.apiKeyEnv"),
      ...(endpoint !== undefined ? { endpoint } : {}),
    },
    github: { tokenCommand: resolveTokenCommand(base, tokenCommand as string[], platform) },
    sandbox: {
      roleUser: text(sandbox["roleUser"], "sandbox.roleUser"),
      piExecutable: text(sandbox["piExecutable"], "sandbox.piExecutable"),
      // This is intentionally not host-resolved: it is a path in the sandbox.
      piAgentDirectory: text(sandbox["piAgentDirectory"], "sandbox.piAgentDirectory"),
      ...(template !== undefined ? { template: text(template, "sandbox.template") } : {}),
      ...(piAuthFile !== undefined ? { piAuthFile: resolveHostPath(base, text(piAuthFile, "sandbox.piAuthFile"), platform) } : {}),
    },
    profiles: modelPolicy,
    modelPolicy,
    testCommands: [...testCommands] as string[],
  };
}

function parseModelPolicy(value: unknown): PersonalModelPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("profiles must be an object");
  const object = value as Record<string, unknown>;
  const policyKeys = ["plan", "implement", "review", "test", "retro"];
  if (Object.keys(object).length !== policyKeys.length || Object.keys(object).some(key => !policyKeys.includes(key))) throw new Error("profiles fields are invalid");
  const plan = parsePlanBuckets(object["plan"]);
  const result = {
    plan,
    implement: parseProfile(object["implement"], "profiles.implement"),
    review: parseProfile(object["review"], "profiles.review"),
    test: parseProfile(object["test"], "profiles.test"),
    retro: parseProfile(object["retro"], "profiles.retro"),
  };
  return validateModelPolicy(result, "profiles");
}

function parsePlanBuckets(value: unknown): readonly [PhaseProfile, PhaseProfile] {
  let buckets: unknown;
  if (Array.isArray(value)) {
    buckets = value;
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(object, "buckets")) {
      if (Object.keys(object).length !== 1) throw new Error("profiles.plan fields are invalid");
      buckets = object["buckets"];
    } else if (Object.prototype.hasOwnProperty.call(object, "a") || Object.prototype.hasOwnProperty.call(object, "b")) {
      if (Object.keys(object).length !== 2 || !Object.prototype.hasOwnProperty.call(object, "a") || !Object.prototype.hasOwnProperty.call(object, "b")) throw new Error("profiles.plan buckets must be named a and b");
      buckets = [object["a"], object["b"]];
    } else if (Object.prototype.hasOwnProperty.call(object, "bucketA") || Object.prototype.hasOwnProperty.call(object, "bucketB")) {
      if (Object.keys(object).length !== 2 || !Object.prototype.hasOwnProperty.call(object, "bucketA") || !Object.prototype.hasOwnProperty.call(object, "bucketB")) throw new Error("profiles.plan buckets must include bucketA and bucketB");
      buckets = [object["bucketA"], object["bucketB"]];
    }
    // Accept the pre-policy flat form only as an explicit legacy migration. It
    // does not silently choose a model: both equal buckets are that profile.
    else if (Object.prototype.hasOwnProperty.call(object, "provider") || Object.prototype.hasOwnProperty.call(object, "model") || Object.prototype.hasOwnProperty.call(object, "thinking")) buckets = [value, value];
  }
  if (!Array.isArray(buckets) || buckets.length !== 2) throw new Error("profiles.plan must contain exactly two buckets");
  return [parseProfile(buckets[0], "profiles.plan.a"), parseProfile(buckets[1], "profiles.plan.b")];
}

function parseProfile(value: unknown, label: string): PhaseProfile {
  return validatePhaseProfile(value, label);
}

function clonePolicy(policy: PersonalModelPolicy): PersonalModelPolicy {
  return {
    plan: [{ ...policy.plan[0] }, { ...policy.plan[1] }],
    implement: { ...policy.implement },
    review: { ...policy.review },
    test: { ...policy.test },
    retro: { ...policy.retro },
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function pathOptions(first?: ConfigPathOptions | NodeJS.Platform, suppliedEnv?: NodeJS.ProcessEnv): Required<Pick<ConfigPathOptions, "platform" | "env" | "cwd">> & Pick<ConfigPathOptions, "homeDirectory"> {
  if (typeof first === "string") return { platform: first, env: suppliedEnv ?? process.env, cwd: process.cwd() };
  return { platform: first?.platform ?? process.platform, env: first?.env ?? process.env, cwd: first?.cwd ?? process.cwd(), ...(first?.homeDirectory !== undefined ? { homeDirectory: first.homeDirectory } : {}) };
}

function resolveHostPath(base: string, value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return path.win32.isAbsolute(value) ? path.win32.normalize(value) : path.win32.resolve(base, value);
  return path.resolve(base, value);
}

function resolvePosixHome(value: string, cwd?: string): string {
  return path.posix.isAbsolute(value) ? path.posix.normalize(value) : path.posix.resolve(cwd ?? process.cwd(), value);
}

function resolveTokenCommand(base: string, command: string[], platform: NodeJS.Platform): string[] {
  const executable = command[0];
  if (!executable) throw new Error("github.tokenCommand must be a non-empty string array");
  const isPath = platform === "win32"
    ? path.win32.isAbsolute(executable) || executable.includes("\\") || executable.includes("/") || executable.startsWith(".")
    : path.posix.isAbsolute(executable) || executable.includes("/") || executable.startsWith(".");
  return [isPath ? resolveHostPath(base, executable, platform) : executable, ...command.slice(1)];
}

function nonempty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
