import { validateLaunchRetryPolicy, type LaunchRetryPolicy } from "./launch-retry.js";
import { createHash } from "node:crypto";
import { access, open, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateSourceRef } from "./identity.js";
import {
  APPROVED_PERSONAL_MODEL_POLICY,
  validateModelPolicy,
  validatePhaseProfile,
  type PersonalModelPolicy,
  type PhaseProfile,
} from "./model-policy.js";

export const PERSONAL_PHASE_TIMEOUT_MIN_MS = 60_000;
export const PERSONAL_PHASE_TIMEOUT_MAX_MS = 14_400_000;

/** Validate the bounded maximum runtime for each Pi phase. */
export function validatePhaseTimeoutMs(value: unknown, label = "phaseTimeoutMs"): number {
  if (!Number.isSafeInteger(value) || (value as number) < PERSONAL_PHASE_TIMEOUT_MIN_MS || (value as number) > PERSONAL_PHASE_TIMEOUT_MAX_MS) {
    throw new Error(`${label} must be a safe integer between ${PERSONAL_PHASE_TIMEOUT_MIN_MS} and ${PERSONAL_PHASE_TIMEOUT_MAX_MS} milliseconds`);
  }
  return value as number;
}

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
  /** Exactly two independently resolved model profiles. */
  readonly modelPolicy: PersonalModelPolicy;
  readonly launchRetryPolicy?: LaunchRetryPolicy;
  readonly testCommands: readonly string[];
  /** Maximum Pi phase runtime; omitted means the runner's one-hour default. */
  readonly phaseTimeoutMs?: number;
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
  readonly rawConfig: string;
}

/** Resolve the per-user Squire directory without looking in the repository. */
export function defaultSquireDirectory(options: ConfigPathOptions = {}): string {
  const resolved = pathOptions(options);
  const environment = resolved.env;
  if (resolved.platform === "win32") {
    const userProfile = nonempty(environment["USERPROFILE"])
      ?? (nonempty(environment["HOMEDRIVE"]) && nonempty(environment["HOMEPATH"]) ? `${environment["HOMEDRIVE"]}${environment["HOMEPATH"]}` : undefined)
      ?? resolved.homeDirectory
      ?? os.homedir();
    return path.win32.normalize(path.win32.join(userProfile, ".squire"));
  }
  const home = nonempty(environment["HOME"]) ?? resolved.homeDirectory ?? os.homedir();
  const xdg = nonempty(environment["XDG_CONFIG_HOME"]);
  const configHome = xdg ? resolvePosixHome(xdg, resolved.cwd) : path.posix.join(home, ".config");
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
export function defaultConfigPath(options: ConfigPathOptions = {}): string {
  const resolved = pathOptions(options);
  const directory = defaultSquireDirectory(resolved);
  return resolved.platform === "win32"
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
  // Resolve all environment-dependent paths from one launch-time snapshot as
  // well as parsing/hashing one byte buffer. This keeps a test or embedding
  // that mutates process.env during an asynchronous read from changing the
  // child bootstrap roots without changing its config digest.
  const environment = { ...(options.env ?? process.env) };
  const boundOptions: ConfigPathOptions = { ...options, env: environment };
  const absolute = resolveConfigPath(file, boundOptions);
  const bytes = await readConfigBytes(absolute, environment);
  return {
    config: await parsePersonalMvpConfig(bytes, absolute, boundOptions),
    digest: createHash("sha256").update(bytes).digest("hex"),
    rawConfig: bytes.toString("base64"),
  };
}

/** Pure schema validation for captured raw bytes; never resolves paths or reads the child environment. */
export function validateCapturedRawConfig(raw: unknown): void {
  const value = object(raw, "captured raw configuration");
  rejectRetiredConfig(value);
  rejectUnknownKeys(value, ["repository", "dataDirectory", "paths", "linear", "github", "sandbox", "modelPolicy", "launchRetryPolicy", "testCommands", "phaseTimeoutMs"], "captured raw configuration");
  const repository = object(value["repository"], "repository");
  rejectUnknownKeys(repository, ["slug", "path", "sourceRef", "baseBranch"], "repository");
  for (const key of ["slug", "path", "baseBranch"]) text(repository[key], `repository.${key}`);
  validateSourceRef(repository["sourceRef"]);
  const paths = value["paths"] === undefined ? {} : object(value["paths"], "paths");
  rejectUnknownKeys(paths, ["state", "bridges", "staging"], "paths");
  for (const [key, entry] of Object.entries(paths)) text(entry, `paths.${key}`);
  if (value["dataDirectory"] !== undefined) text(value["dataDirectory"], "dataDirectory");
  const linear = object(value["linear"], "linear");
  rejectUnknownKeys(linear, ["apiKeyEnv", "endpoint"], "linear");
  text(linear["apiKeyEnv"], "linear.apiKeyEnv");
  if (linear["endpoint"] !== undefined && typeof linear["endpoint"] !== "string") throw new Error("linear.endpoint must be a string");
  const github = object(value["github"], "github");
  rejectUnknownKeys(github, ["tokenCommand"], "github");
  for (const [label, commands, limit] of [["testCommands", value["testCommands"], 100], ["github.tokenCommand", github["tokenCommand"], 32]] as const) {
    if (!Array.isArray(commands) || commands.length === 0 || commands.length > limit || commands.some(command => typeof command !== "string" || command.length === 0 || command.length > 2_000)) throw new Error(`${label} must be a bounded non-empty string array`);
  }
  const sandbox = object(value["sandbox"], "sandbox");
  if (typeof sandbox["roleUser"] !== "string" || !/^[1-9][0-9]*:[1-9][0-9]*$/u.test(sandbox["roleUser"])) throw new Error("sandbox.roleUser must be non-root numeric uid:gid");
  rejectUnknownKeys(sandbox, ["template", "roleUser", "piExecutable", "piAgentDirectory", "piAuthFile"], "sandbox");
  for (const key of ["roleUser", "piExecutable", "piAgentDirectory"]) text(sandbox[key], `sandbox.${key}`);
  for (const key of ["template", "piAuthFile"]) if (sandbox[key] !== undefined) text(sandbox[key], `sandbox.${key}`);
  validateLaunchRetryPolicy(value["launchRetryPolicy"]);
  if (value["modelPolicy"] !== undefined) parseModelPolicy(value["modelPolicy"]);
  if (value["phaseTimeoutMs"] !== undefined) validatePhaseTimeoutMs(value["phaseTimeoutMs"]);
}

async function parsePersonalMvpConfig(bytes: Buffer, absolute: string, options: ConfigPathOptions): Promise<PersonalMvpConfig> {
  const platform = options.platform ?? process.platform;
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("configuration must be an object");
  const value = raw as Record<string, unknown>;
  rejectRetiredConfig(value);
  // Keep the configuration surface deliberately closed. In particular, an
  // unknown top-level field must not become a second spelling for a runtime
  // root or a silently ignored launch control. The explicit legacy aliases
  // below retain their more useful migration diagnostic.
  const legacyAliases = ["runtimeDataDirectory", "runtime", "data", "logs", "profiles"] as const;
  for (const alias of legacyAliases) {
    if (Object.prototype.hasOwnProperty.call(value, alias)) throw new Error(`${alias} is not supported; use ${alias === "profiles" ? "modelPolicy" : "dataDirectory"}`);
  }
  rejectUnknownKeys(value, ["repository", "dataDirectory", "paths", "linear", "github", "sandbox", "modelPolicy", "launchRetryPolicy", "testCommands", "phaseTimeoutMs"], "configuration");

  const repository = object(value["repository"], "repository");
  rejectUnknownKeys(repository, ["slug", "path", "sourceRef", "baseBranch"], "repository");
  const paths = value["paths"] === undefined ? {} : object(value["paths"], "paths");
  rejectUnknownKeys(paths, ["state", "bridges", "staging"], "paths", "dataDirectory");
  const linear = object(value["linear"], "linear");
  rejectUnknownKeys(linear, ["apiKeyEnv", "endpoint"], "linear");
  const github = object(value["github"], "github");
  rejectUnknownKeys(github, ["tokenCommand"], "github");
  const sandbox = object(value["sandbox"], "sandbox");
  if (typeof sandbox["roleUser"] !== "string" || !/^[1-9][0-9]*:[1-9][0-9]*$/u.test(sandbox["roleUser"])) throw new Error("sandbox.roleUser must be non-root numeric uid:gid");
  rejectUnknownKeys(sandbox, ["template", "roleUser", "piExecutable", "piAgentDirectory", "piAuthFile"], "sandbox");
  const base = platform === "win32" ? path.win32.dirname(absolute) : path.dirname(absolute);
  const configuredDataDirectory = value["dataDirectory"];
  if (configuredDataDirectory !== undefined && typeof configuredDataDirectory !== "string") throw new Error("dataDirectory must be a string");
  // SQUIRE_DATA_DIR is the documented environment override, including when
  // the selected JSON file also contains dataDirectory. Keep the precedence
  // decision on the captured environment snapshot used for this parse so a
  // child cannot bind one root while hashing/reading another configuration.
  const environmentDataDirectory = nonempty(options.env?.["SQUIRE_DATA_DIR"]);
  const dataDirectory = environmentDataDirectory !== undefined
    ? resolveSquireDataDirectory(options)
    : configuredDataDirectory === undefined
      ? defaultSquireDataDirectory(options)
      : resolveHostPath(base, text(configuredDataDirectory, "dataDirectory"), platform);

  const policyValue = value["modelPolicy"];
  const modelPolicy = policyValue === undefined
    ? clonePolicy(APPROVED_PERSONAL_MODEL_POLICY)
    : parseModelPolicy(policyValue);

  const phaseTimeoutMs = value["phaseTimeoutMs"] === undefined ? undefined : validatePhaseTimeoutMs(value["phaseTimeoutMs"]);
  const testCommands = value["testCommands"];
  if (!Array.isArray(testCommands) || new Set(testCommands).size !== testCommands.length || testCommands.length === 0 || testCommands.length > 100 || testCommands.some(command => typeof command !== "string" || command.length === 0 || command.length > 2_000)) throw new Error("testCommands must be a non-empty string array");
  const tokenCommand = github["tokenCommand"];
  if (!Array.isArray(tokenCommand) || tokenCommand.length === 0 || tokenCommand.length > 32 || tokenCommand.some(argument => typeof argument !== "string" || argument.length === 0 || argument.length > 2_000)) throw new Error("github.tokenCommand must be a non-empty string array");
  const endpoint = linear["endpoint"];
  if (endpoint !== undefined && typeof endpoint !== "string") throw new Error("linear.endpoint must be a string");
  const template = sandbox["template"];
  if (template !== undefined && typeof template !== "string") throw new Error("sandbox.template must be a string");
  const piAuthFile = sandbox["piAuthFile"];
  if (piAuthFile !== undefined && typeof piAuthFile !== "string") throw new Error("sandbox.piAuthFile must be a string");

  const sourceRef = validateSourceRef(repository["sourceRef"], "repository.sourceRef");
  const configuredRepositoryPath = resolveHostPath(base, text(repository["path"], "repository.path"), platform);
  const repositoryPath = await canonicalRepositoryPath(configuredRepositoryPath, platform);
  const statePath = resolveConfiguredRuntimePath(paths["state"], "paths.state", base, dataDirectory, "state", platform);
  const bridgesPath = resolveConfiguredRuntimePath(paths["bridges"], "paths.bridges", base, dataDirectory, "bridges", platform);
  const stagingPath = resolveConfiguredRuntimePath(paths["staging"], "paths.staging", base, dataDirectory, "staging", platform);
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
      sourceRef,
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
    modelPolicy,
    launchRetryPolicy: validateLaunchRetryPolicy(value["launchRetryPolicy"]),
    testCommands: [...testCommands] as string[],
    ...(phaseTimeoutMs === undefined ? {} : { phaseTimeoutMs }),
  };
}

function parseModelPolicy(value: unknown): PersonalModelPolicy { return validateModelPolicy(value); }
function clonePolicy(policy: PersonalModelPolicy): PersonalModelPolicy { return validateModelPolicy(policy); }
function rejectRetiredConfig(value: Record<string, unknown>): void {
  for (const key of ["escalationPolicy", "reportCorrectionPolicy", "promptPolicy", "remediation", "remediationPolicy"]) if (Object.hasOwn(value, key)) throw new Error(`${key} is retired; remove it and use only modelPolicy.implement and modelPolicy.verify`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(object: Record<string, unknown>, allowed: readonly string[], label: string, hint?: string): void {
  const unknown = Object.keys(object).find(key => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is not supported${hint ? `; use ${hint}` : ""}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function pathOptions(options: ConfigPathOptions): Required<Pick<ConfigPathOptions, "platform" | "env" | "cwd">> & Pick<ConfigPathOptions, "homeDirectory"> {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("config path options must be an object");
  return { platform: options.platform ?? process.platform, env: options.env ?? process.env, cwd: options.cwd ?? process.cwd(), ...(options.homeDirectory !== undefined ? { homeDirectory: options.homeDirectory } : {}) };
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
async function canonicalRepositoryPath(value: string, platform: NodeJS.Platform): Promise<string> {
  if (platform !== process.platform) return value;
  try {
    return path.resolve(await realpath(value));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return value;
    throw error;
  }
}

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
  // Windows paths are case-insensitive even when the spelling in a config
  // differs from the spelling returned by realpath. Compare using the native
  // platform's case rules before checking containment.
  const comparableParent = process.platform === "win32" ? parent.toLowerCase() : parent;
  const comparableChild = process.platform === "win32" ? child.toLowerCase() : child;
  const relative = path.relative(comparableParent, comparableChild);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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
  const handle = await open(file, "r");
  let bytes: Buffer;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > 1_000_000n) throw new Error("configuration must be a bounded regular file");
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.size !== BigInt(bytes.length) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("configuration changed during capture");
  } finally { await handle.close(); }
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
