import { createHash } from "node:crypto";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
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
  /** Canonical resolved root for mutable run data and logs. */
  readonly dataDirectory: string;
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

export interface LoadedPersonalMvpConfig {
  readonly config: PersonalMvpConfig;
  readonly digest: string;
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

/**
 * Resolve the per-user runtime-data directory. Configuration deliberately uses
 * the config-specific XDG directory, while mutable run state and logs use the
 * platform's state/data directory. SQUIRE_DATA_DIR is an explicit environment
 * escape hatch for machines that keep state on a separate volume.
 */
export function defaultSquireDataDirectory(options: ConfigPathOptions = {}): string {
  const resolved = pathOptions(options);
  const environment = resolved.env;
  const platform = resolved.platform;
  if (platform === "win32") {
    const localAppData = nonempty(environment["LOCALAPPDATA"])
      ?? nonempty(environment["USERPROFILE"])
      ?? resolved.homeDirectory
      ?? os.homedir();
    return path.win32.normalize(path.win32.join(localAppData, "Squire"));
  }
  const home = nonempty(environment["HOME"]) ?? resolved.homeDirectory ?? os.homedir();
  const stateHome = nonempty(environment["XDG_STATE_HOME"])
    ?? path.posix.join(home, ".local", "state");
  return path.posix.normalize(path.posix.join(resolvePosixHome(stateHome, resolved.cwd), "squire"));
}

/** Resolve SQUIRE_DATA_DIR or the platform-default mutable-data directory. */
export function resolveSquireDataDirectory(options: ConfigPathOptions = {}): string {
  const environment = options.env ?? process.env;
  const selected = nonempty(environment["SQUIRE_DATA_DIR"]);
  if (selected) return resolveHostPath(options.cwd ?? process.cwd(), selected, options.platform ?? process.platform);
  return defaultSquireDataDirectory(options);
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

export async function loadPersonalMvpConfig(file?: string, options: ConfigPathOptions = {}): Promise<PersonalMvpConfig> {
  return (await loadBoundPersonalMvpConfig(file, options)).config;
}

/** Read the selected file once; parsing and launch binding use these exact bytes. */
export async function loadBoundPersonalMvpConfig(file?: string, options: ConfigPathOptions = {}): Promise<LoadedPersonalMvpConfig> {
  const absolute = resolveConfigPath(file, options);
  const bytes = await readConfigBytes(absolute, options.env ?? process.env);
  return {
    config: await parsePersonalMvpConfig(bytes, absolute, options),
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function parsePersonalMvpConfig(bytes: Buffer, absolute: string, options: ConfigPathOptions): Promise<PersonalMvpConfig> {
  const platform = options.platform ?? process.platform;
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("configuration must be an object");
  const value = raw as Record<string, unknown>;
  const repository = object(value["repository"], "repository");
  const paths = value["paths"] === undefined ? {} : object(value["paths"], "paths");
  const linear = object(value["linear"], "linear");
  const github = object(value["github"], "github");
  const sandbox = object(value["sandbox"], "sandbox");
  const base = platform === "win32" ? path.win32.dirname(absolute) : path.dirname(absolute);
  for (const alias of ["runtimeDataDirectory", "runtime"] as const) {
    if (Object.prototype.hasOwnProperty.call(value, alias)) throw new Error(`${alias} is not supported; use dataDirectory`);
  }
  for (const alias of ["dataDirectory", "runtime", "data", "logs"] as const) {
    if (Object.prototype.hasOwnProperty.call(paths, alias)) throw new Error(`paths.${alias} is not supported; use dataDirectory`);
  }
  const configuredDataDirectory = value["dataDirectory"];
  if (configuredDataDirectory !== undefined && typeof configuredDataDirectory !== "string") throw new Error("dataDirectory must be a string");
  const dataDirectory = configuredDataDirectory === undefined
    ? resolveSquireDataDirectory(options)
    : resolveHostPath(base, text(configuredDataDirectory, "dataDirectory"), platform);

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

  const repositoryPath = resolveHostPath(base, text(repository["path"], "repository.path"), platform);
  // A few old preview fixtures put `state`, `bridges`, and `staging` beside a
  // non-checkout config with `repository.path: "."`. Keep those fixtures
  // loadable, but migrate their omitted runtime boundary to the safe per-user
  // defaults rather than allowing artifacts inside the checkout.
  const legacyPreviewPaths = repository["path"] === "."
    && configuredDataDirectory === undefined
    && paths["state"] === "state"
    && paths["bridges"] === "bridges"
    && paths["staging"] === "staging"
    && nonempty((options.env ?? process.env)["SQUIRE_DATA_DIR"]) === undefined
    && !(platform === process.platform && await isGitCheckout(repositoryPath));
  const statePath = resolveConfiguredRuntimePath(legacyPreviewPaths ? undefined : paths["state"], "paths.state", base, dataDirectory, "state", platform);
  const bridgesPath = resolveConfiguredRuntimePath(legacyPreviewPaths ? undefined : paths["bridges"], "paths.bridges", base, dataDirectory, "bridges", platform);
  const stagingPath = resolveConfiguredRuntimePath(legacyPreviewPaths ? undefined : paths["staging"], "paths.staging", base, dataDirectory, "staging", platform);
  const logsPath = platform === "win32" ? path.win32.join(dataDirectory, "logs") : path.resolve(dataDirectory, "logs");
  // Resolve symlinks (including symlinked destination parents) before
  // comparing paths. Non-native platform fixtures are parsed for display but
  // are not inspected with the host filesystem.
  await assertRuntimePathsOutsideRepository(repositoryPath, [dataDirectory, statePath, bridgesPath, stagingPath, logsPath], platform);

  return {
    dataDirectory,
    repository: {
      slug: text(repository["slug"], "repository.slug"),
      path: repositoryPath,
      sourceRef: text(repository["sourceRef"], "repository.sourceRef"),
      baseBranch: text(repository["baseBranch"], "repository.baseBranch"),
    },
    paths: {
      state: statePath,
      bridges: bridgesPath,
      staging: stagingPath,
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
  if (path.posix.isAbsolute(value) || path.posix.isAbsolute(base)) return path.posix.resolve(base, value);
  // Non-native platform fixtures can still point at real host temporary files.
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

function resolveConfiguredRuntimePath(value: unknown, label: string, base: string, dataDirectory: string, fallbackName: string, platform: NodeJS.Platform): string {
  if (value === undefined) {
    return platform === "win32"
      ? path.win32.normalize(path.win32.join(dataDirectory, fallbackName))
      : path.resolve(dataDirectory, fallbackName);
  }
  return resolveHostPath(base, text(value, label), platform);
}

/**
 * Resolve a path even when its final components do not exist yet. This keeps
 * symlinked parents from becoming a way to put state or logs in the checkout.
 */
async function realPathForSafety(value: string): Promise<string> {
  const absolute = path.resolve(value);
  const missing: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      const existing = await realpath(cursor);
      return path.resolve(existing, ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return absolute;
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function isGitCheckout(repositoryPath: string): Promise<boolean> {
  try {
    await realpath(path.join(repositoryPath, ".git"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
    throw error;
  }
}

async function assertRuntimePathsOutsideRepository(repositoryPath: string, destinations: readonly string[], platform: NodeJS.Platform): Promise<void> {
  // Tests and callers may ask the loader to parse Windows paths on a POSIX
  // host. Those strings are not host filesystem paths and must not be fed to
  // POSIX realpath; native Windows invocations are checked below.
  if (platform !== process.platform) return;
  const repositoryReal = await realPathForSafety(repositoryPath);
  for (const destination of destinations) {
    const destinationReal = await realPathForSafety(destination);
    if (isWithin(repositoryReal, destinationReal)) throw new Error(`runtime path must be outside the repository: ${destination}`);
  }
}

async function readConfigBytes(file: string, environment: NodeJS.ProcessEnv): Promise<Buffer> {
  const bytes = await readFile(file);
  // Test-only file barriers make atomic replacement and symlink retargeting
  // deterministic after the selected bytes have been captured.
  if (environment["NODE_ENV"] === "test") {
    const ready = nonempty(environment["SQUIRE_TEST_ONLY_CONFIG_READ_READY_PATH"]);
    const release = nonempty(environment["SQUIRE_TEST_ONLY_CONFIG_READ_RELEASE_PATH"]);
    if ((ready === undefined) !== (release === undefined)) throw new Error("config test-only read barrier is incomplete");
    if (ready && release) {
      await writeFile(ready, "ready\n", "utf8");
      for (;;) {
        try { await access(release); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
    }
  }
  return bytes;
}

function nonempty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
