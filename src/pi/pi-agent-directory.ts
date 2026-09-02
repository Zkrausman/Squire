import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeWikiProfile, type PiModelProfile, type PiWikiProfileInput } from "./pi-configuration.js";
import type { RuntimeResolution } from "../control/domain.js";
import { buildTrustedWikiFooterExtensionSource } from "./wiki-footer.js";

const AGENT_DIRECTORY_KIND = "squire-pi-agent-directory";
const AGENT_DIRECTORY_SCHEMA_VERSION = 1;
const WIKI_PACKAGE_NAME = "@zosmaai/pi-llm-wiki";
const FOOTER_FILE = "extensions/squire-trusted-wiki-footer.mjs";
const SETTINGS_FILE = "settings.json";
const MANIFEST_FILE = "squire-agent-manifest.json";
const DEFAULT_RUNTIME_ROOT = "/ticket/runtime";
const DEFAULT_WORKSPACE = "/ticket/workspace";
const DEFAULT_MATERIALIZERS = new Map<string, PiAgentDirectoryMaterializer>();
const RUN_ID = /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_RELATIVE_FILE = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

export interface WikiInstallationInput {
  /** Absolute path to the already-resolved local pi-llm-wiki package. */
  root: string;
  /** Optional trusted identity; defaults to RuntimeResolution.llmWiki.installationId. */
  installationId?: string;
  /** Optional trusted version; defaults to RuntimeResolution.llmWiki.version. */
  version?: string;
  /** Explicit entrypoint is useful for installations with a nonstandard manifest. */
  extensionPath?: string;
  /** An authoritative local capability result for the selected task model. */
  reasoningCapableModels?: readonly string[];
  /** Optional explicit result from the trusted runtime resolver. */
  reasoningCapable?: boolean;
}

export interface TrustedAuthInput {
  /** Explicitly provisioned ticket-scoped auth file. Never inferred from HOME. */
  sourcePath: string;
  /** Destination filename relative to the generated agent directory. */
  destination?: string;
  /** Optional digest supplied by the trusted provisioner. */
  sha256?: string;
}

export interface PiAgentDirectoryRequest {
  runId: string;
  runtime: RuntimeResolution;
  wikiProfile: PiWikiProfileInput | PiModelProfile;
  workspace?: string;
  signal?: AbortSignal;
}

export interface MaterializedPiAgentDirectory {
  runId: string;
  agentDir: string;
  settingsPath: string;
  manifestPath: string;
  footerExtensionPath: string;
  /** Ordered paths: wiki first, controller footer second. */
  trustedExtensionPaths: readonly [string, string];
  extensionDigest: string;
}

/** Injectable preparation port used by PiRunner; implementations may be fakes in tests. */
export interface PiAgentDirectoryMaterializerPort {
  materialize(request: PiAgentDirectoryRequest): Promise<MaterializedPiAgentDirectory>;
}

export interface WikiModelCapability {
  reasoningCapable: boolean;
}

export type WikiModelCapabilityResolver = (
  profile: PiModelProfile,
  installation: WikiInstallationInput,
  signal?: AbortSignal,
) => WikiModelCapability | Promise<WikiModelCapability>;

export interface PiAgentDirectoryMaterializerOptions {
  /** Production default is /ticket/runtime; tests may use an isolated temp root. */
  runtimeRoot?: string;
  /** Used only to reject project-local output and inspect project overrides. */
  workspace?: string;
  /** Explicit identity-to-path seam supplied by the trusted runtime resolver. */
  wikiInstallation?: WikiInstallationInput;
  /** Alternative seam for controllers that keep installation paths outside the resolution record. */
  resolveWikiInstallation?: (
    runtime: RuntimeResolution,
    signal?: AbortSignal,
  ) => WikiInstallationInput | Promise<WikiInstallationInput>;
  /** Explicitly provisioned auth; absent means no auth is copied. */
  trustedAuth?: TrustedAuthInput;
  /** Defaults to a conservative local model capability check. */
  resolveModelCapability?: WikiModelCapabilityResolver;
  /** HOME is injectable for tests; it is never read for configuration or auth. */
  homeDirectory?: string;
}

interface AgentManifest {
  schemaVersion: 1;
  kind: typeof AGENT_DIRECTORY_KIND;
  runId: string;
  runtime: {
    pi: RuntimeResolution["pi"];
    llmWiki: RuntimeResolution["llmWiki"] & { root: string };
  };
  wikiProfile: PiModelProfile;
  files: {
    settings: { path: typeof SETTINGS_FILE; sha256: string };
    footerExtension: { path: typeof FOOTER_FILE; sha256: string };
    auth?: { path: string; sha256: string };
  };
  trustedExtensions: readonly [string, string];
}

interface FileSystemEntry {
  path: string;
  bytes: Buffer;
  mode: number;
}

/**
 * Creates the one global-like Pi directory that is allowed for a Squire run.
 * No package manager, network lookup, HOME setting, or repository write is
 * performed here. The selected wiki root must be supplied by trusted runtime
 * resolution (or an explicit identity-to-path seam).
 */
export class PiAgentDirectoryMaterializer {
  readonly #options: PiAgentDirectoryMaterializerOptions;
  readonly #inFlight = new Map<string, { fingerprint: string; promise: Promise<MaterializedPiAgentDirectory> }>();

  constructor(options: PiAgentDirectoryMaterializerOptions = {}) {
    this.#options = options;
  }

  materialize(request: PiAgentDirectoryRequest): Promise<MaterializedPiAgentDirectory> {
    assertRunId(request.runId);
    const profile = normalizeWikiProfile(request.wikiProfile);
    const fingerprint = requestFingerprint(request, profile, this.#options);
    const previous = this.#inFlight.get(request.runId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Promise.reject(new Error("conflicting Pi agent-directory materialization request"));
      return previous.promise;
    }
    const promise = this.#materialize(request, profile);
    this.#inFlight.set(request.runId, { fingerprint, promise });
    void promise.then(
      () => {
        const current = this.#inFlight.get(request.runId);
        if (current?.promise === promise) this.#inFlight.delete(request.runId);
      },
      () => {
        const current = this.#inFlight.get(request.runId);
        if (current?.promise === promise) this.#inFlight.delete(request.runId);
      },
    );
    return promise;
  }

  /** Alias for callers that name the port `prepare`. */
  prepare(request: PiAgentDirectoryRequest): Promise<MaterializedPiAgentDirectory> {
    return this.materialize(request);
  }

  async #materialize(request: PiAgentDirectoryRequest, profile: PiModelProfile): Promise<MaterializedPiAgentDirectory> {
    throwIfAborted(request.signal);
    if (request.runtime.runId !== request.runId) throw new Error("runtime resolution belongs to a different run");
    const runtimeRoot = absoluteDirectory(this.#options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, "runtime root");
    const workspace = absoluteDirectory(request.workspace ?? this.#options.workspace ?? DEFAULT_WORKSPACE, "workspace");
    const runRoot = path.resolve(runtimeRoot, request.runId);
    const agentDir = path.resolve(runRoot, "pi-agent");
    assertSafeOutput(agentDir, runtimeRoot, workspace, this.#options.homeDirectory ?? process.env["HOME"]);
    await rejectSymlinkedAncestors(runtimeRoot, "runtime root");
    await rejectSymlinkedAncestors(workspace, "workspace");
    const runRootKind = await pathKind(runRoot);
    if (runRootKind === "symlink") throw new Error("run runtime directory may not be symlinked");
    if (runRootKind !== "missing" && runRootKind !== "directory") throw new Error("run runtime path is not a directory");
    await ensureProjectWikiOverrideIsNotConflicting(workspace, profile, request.signal);

    const installation = await this.#resolveInstallation(request.runtime, request.signal);
    validateInstallationInput(installation, request.runtime);
    const wikiRoot = await canonicalRegularDirectory(installation.root, "resolved pi-llm-wiki installation");
    await rejectSymlinkedAncestors(wikiRoot, "resolved pi-llm-wiki installation");
    if (isWithin(workspace, wikiRoot) || isWithin(wikiRoot, workspace)) throw new Error("resolved pi-llm-wiki installation may not be in the target workspace");
    const home = this.#options.homeDirectory ?? process.env["HOME"];
    if (home && (isWithin(home, wikiRoot) || isWithin(wikiRoot, home))) throw new Error("resolved pi-llm-wiki installation may not be in the host home directory");
    const wikiExtension = await resolveWikiExtension(wikiRoot, installation.extensionPath);
    await rejectSymlinkComponents(wikiRoot, wikiExtension, "resolved pi-llm-wiki extension");
    const packageMetadata = await readPackageMetadata(wikiRoot);
    if (packageMetadata.name !== WIKI_PACKAGE_NAME) throw new Error(`resolved wiki installation is not ${WIKI_PACKAGE_NAME}`);
    if (packageMetadata.version !== request.runtime.llmWiki.version) throw new Error("resolved pi-llm-wiki version does not match persisted runtime resolution");
    if (installation.version !== undefined && installation.version !== request.runtime.llmWiki.version) {
      throw new Error("wiki installation seam version does not match persisted runtime resolution");
    }
    if (installation.installationId !== undefined && installation.installationId !== request.runtime.llmWiki.installationId) {
      throw new Error("wiki installation seam identity does not match persisted runtime resolution");
    }
    await assertReasoningCapable(profile, installation, this.#options.resolveModelCapability, request.signal);
    throwIfAborted(request.signal);

    const footerSource = Buffer.from(buildTrustedWikiFooterExtensionSource(profile), "utf8");
    const footerDigest = sha256(footerSource);
    const settings = buildSettings(wikiRoot, profile);
    const settingsBytes = Buffer.from(`${JSON.stringify(settings, null, 2)}\n`, "utf8");
    const authEntry = await this.#readTrustedAuth(agentDir, request.signal);
    const manifest: AgentManifest = {
      schemaVersion: AGENT_DIRECTORY_SCHEMA_VERSION,
      kind: AGENT_DIRECTORY_KIND,
      runId: request.runId,
      runtime: {
        pi: { ...request.runtime.pi },
        llmWiki: { ...request.runtime.llmWiki, root: wikiRoot },
      },
      wikiProfile: { ...profile },
      files: {
        settings: { path: SETTINGS_FILE, sha256: sha256(settingsBytes) },
        footerExtension: { path: FOOTER_FILE, sha256: footerDigest },
        ...(authEntry ? { auth: { path: authEntry.relativePath, sha256: authEntry.digest } } : {}),
      },
      trustedExtensions: [wikiExtension, footerPath(agentDir)],
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const authFile = authEntry ? { path: path.resolve(agentDir, authEntry.relativePath), bytes: authEntry.bytes, mode: 0o600 } : undefined;
    const entries: FileSystemEntry[] = [
      { path: SETTINGS_FILE, bytes: settingsBytes, mode: 0o600 },
      { path: FOOTER_FILE, bytes: footerSource, mode: 0o600 },
      { path: MANIFEST_FILE, bytes: manifestBytes, mode: 0o600 },
      ...(authFile ? [{ path: authEntry!.relativePath, bytes: authFile.bytes, mode: authFile.mode }] : []),
    ];
    await this.#createOrVerify(agentDir, runRoot, entries, manifest, request.signal);
    return {
      runId: request.runId,
      agentDir,
      settingsPath: path.join(agentDir, SETTINGS_FILE),
      manifestPath: path.join(agentDir, MANIFEST_FILE),
      footerExtensionPath: footerPath(agentDir),
      trustedExtensionPaths: [wikiExtension, footerPath(agentDir)],
      extensionDigest: footerDigest,
    };
  }

  async #resolveInstallation(runtime: RuntimeResolution, signal?: AbortSignal): Promise<WikiInstallationInput> {
    if (this.#options.resolveWikiInstallation) return await this.#options.resolveWikiInstallation(runtime, signal);
    if (this.#options.wikiInstallation) return this.#options.wikiInstallation;
    if (runtime.llmWiki.root) return { root: runtime.llmWiki.root };
    const candidate = runtime.llmWiki.installationId;
    if (path.isAbsolute(candidate)) return { root: candidate };
    throw new Error("no trusted local path for the persisted pi-llm-wiki installation");
  }

  async #readTrustedAuth(agentDir: string, signal?: AbortSignal): Promise<{ relativePath: string; bytes: Buffer; digest: string } | undefined> {
    const input = this.#options.trustedAuth;
    if (!input) return undefined;
    throwIfAborted(signal);
    const relativePath = input.destination ?? "auth.json";
    if (!SAFE_RELATIVE_FILE.test(relativePath) || relativePath.split("/").some(part => part === "." || part === "..")) {
      throw new Error("trusted auth destination must be a safe relative file");
    }
    const source = path.resolve(input.sourcePath);
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("trusted auth source must be a regular non-symlink file");
    const bytes = await readFile(source);
    const digest = sha256(bytes);
    if (input.sha256 !== undefined && input.sha256 !== digest) throw new Error("trusted auth digest mismatch");
    const destination = path.resolve(agentDir, relativePath);
    if (!isWithin(agentDir, destination)) throw new Error("trusted auth destination escapes agent directory");
    return { relativePath, bytes, digest };
  }

  async #createOrVerify(agentDir: string, runRoot: string, entries: readonly FileSystemEntry[], expected: AgentManifest, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const existing = await pathKind(agentDir);
    if (existing !== "missing") {
      if (existing !== "directory") throw new Error("Pi agent directory is not a regular directory");
      await verifyAgentDirectory(agentDir, expected, entries.map(entry => entry.path));
      return;
    }
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    await chmod(runRoot, 0o700);
    const staging = await mkdtemp(path.join(runRoot, ".pi-agent-staging-"));
    try {
      await chmod(staging, 0o700);
      for (const entry of entries) {
        throwIfAborted(signal);
        const target = path.resolve(staging, entry.path);
        if (!isWithin(staging, target)) throw new Error("generated Pi file escapes staging directory");
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, entry.bytes, { flag: "wx", mode: entry.mode });
        await chmod(target, entry.mode);
      }
      await verifyAgentDirectory(staging, expected, entries.map(entry => entry.path));
      try {
        await rename(staging, agentDir);
      } catch (error) {
        if (await pathKind(agentDir) === "directory") {
          await verifyAgentDirectory(agentDir, expected, entries.map(entry => entry.path));
          return;
        }
        throw error;
      }
      await verifyAgentDirectory(agentDir, expected, entries.map(entry => entry.path));
    } finally {
      if (await pathKind(staging) !== "missing") await rm(staging, { recursive: true, force: true });
    }
  }
}

/** Return the process-wide default materializer so concurrent role runners share one single-flight map. */
export function createDefaultPiAgentDirectoryMaterializer(workspace?: string): PiAgentDirectoryMaterializer {
  const key = path.resolve(workspace ?? DEFAULT_WORKSPACE);
  const existing = DEFAULT_MATERIALIZERS.get(key);
  if (existing) return existing;
  const created = new PiAgentDirectoryMaterializer({ ...(workspace ? { workspace } : {}) });
  DEFAULT_MATERIALIZERS.set(key, created);
  return created;
}

function requestFingerprint(request: PiAgentDirectoryRequest, profile: PiModelProfile, options: PiAgentDirectoryMaterializerOptions): string {
  const installation = options.wikiInstallation;
  return JSON.stringify({
    runId: request.runId,
    runtime: request.runtime,
    profile,
    workspace: request.workspace ?? options.workspace ?? DEFAULT_WORKSPACE,
    runtimeRoot: options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT,
    wikiRoot: installation?.root,
    wikiInstallationId: installation?.installationId,
    trustedAuth: options.trustedAuth ? { sourcePath: path.resolve(options.trustedAuth.sourcePath), destination: options.trustedAuth.destination, sha256: options.trustedAuth.sha256 } : undefined,
  });
}

function buildSettings(wikiRoot: string, profile: PiModelProfile): Record<string, unknown> {
  const modelRef = `${profile.provider}/${profile.model}`;
  return {
    // This is an exact local path, not an npm specifier. Pi must never install
    // or update a package while a Squire role is running.
    packages: [wikiRoot],
    // The controller registers the two extensions explicitly and in order on
    // the command line. Keeping the footer out of auto-discovery avoids a
    // lower-precedence settings entry ever moving it ahead of the wiki.
    "llm-wiki": {
      taskModel: { provider: profile.provider, id: profile.model },
      // A run must not inherit a host/personal vault as an ambient source.
      ambientPersonalVault: false,
    },
    defaultThinkingLevel: profile.thinking,
    modelThinkingLevels: { [modelRef]: profile.thinking },
  };
}

async function verifyAgentDirectory(agentDir: string, expected: AgentManifest, expectedFiles: readonly string[]): Promise<void> {
  if ((await pathKind(agentDir)) !== "directory") throw new Error("Pi agent directory is not a regular directory");
  const manifestPath = path.join(agentDir, MANIFEST_FILE);
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("Pi agent manifest is missing or symlinked");
  let actual: unknown;
  try { actual = JSON.parse(await readFile(manifestPath, "utf8")); } catch { throw new Error("Pi agent manifest is not valid JSON"); }
  if (!deepEqual(actual, expected)) throw new Error("Pi agent manifest conflicts with the requested run configuration");
  const expectedSet = new Set([...expectedFiles, MANIFEST_FILE]);
  const expectedDirectories = new Set<string>();
  for (const file of expectedSet) {
    let parent = path.posix.dirname(file);
    while (parent !== ".") {
      expectedDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const entries = await listRelativeEntries(agentDir);
  if (entries.files.some(name => !expectedSet.has(name)) || entries.files.length !== expectedSet.size || entries.directories.some(name => !expectedDirectories.has(name))) {
    throw new Error("Pi agent directory contains unexpected or partial content");
  }
  for (const file of [MANIFEST_FILE, ...expectedFiles]) {
    const target = path.join(agentDir, file);
    const fileStat = await lstat(target);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`Pi agent file is missing or symlinked: ${file}`);
    if ((fileStat.mode & 0o777) !== 0o600) throw new Error(`Pi agent file has unsafe permissions: ${file}`);
  }
  const settingsBytes = await readFile(path.join(agentDir, SETTINGS_FILE));
  const footerBytes = await readFile(path.join(agentDir, FOOTER_FILE));
  if (sha256(settingsBytes) !== expected.files.settings.sha256) throw new Error("Pi settings digest mismatch");
  if (sha256(footerBytes) !== expected.files.footerExtension.sha256) throw new Error("trusted footer digest mismatch");
  if (expected.files.auth) {
    const authBytes = await readFile(path.join(agentDir, expected.files.auth.path));
    if (sha256(authBytes) !== expected.files.auth.sha256) throw new Error("trusted auth digest mismatch");
  }
}

async function listRelativeEntries(root: string): Promise<{ files: string[]; directories: string[] }> {
  const files: string[] = [];
  const directories: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`Pi agent directory contains a symlink: ${relative}`);
      if (entry.isDirectory()) { directories.push(relative); await visit(absolute); }
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`Pi agent directory contains a non-regular entry: ${relative}`);
    }
  }
  await visit(root);
  return { files: files.sort(), directories: directories.sort() };
}

async function resolveWikiExtension(root: string, explicit?: string): Promise<string> {
  const candidates: string[] = [];
  if (explicit) candidates.push(path.isAbsolute(explicit) ? explicit : path.resolve(root, explicit));
  try {
    const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { pi?: { extensions?: unknown } };
    if (Array.isArray(metadata.pi?.extensions)) {
      for (const item of metadata.pi.extensions) if (typeof item === "string") candidates.push(path.resolve(root, item));
    }
  } catch { /* the conventional path below remains authoritative for minimal fixtures */ }
  candidates.push(
    path.join(root, "extensions", "llm-wiki", "index.ts"),
    path.join(root, "extensions", "llm-wiki", "index.js"),
    path.join(root, "dist", "extensions", "llm-wiki", "index.js"),
  );
  for (const candidate of candidates) {
    const found = await findExtensionFile(candidate);
    if (found) return found;
  }
  throw new Error("resolved pi-llm-wiki installation has no trusted extension entrypoint");
}

async function findExtensionFile(candidate: string): Promise<string | undefined> {
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error("resolved pi-llm-wiki extension is symlinked");
    if (info.isFile()) return path.resolve(candidate);
    if (!info.isDirectory()) return undefined;
    for (const name of ["index.ts", "index.js"]) {
      const nested = path.join(candidate, name);
      try {
        const nestedInfo = await lstat(nested);
        if (nestedInfo.isSymbolicLink()) throw new Error("resolved pi-llm-wiki extension is symlinked");
        if (nestedInfo.isFile()) return path.resolve(nested);
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
    }
    const nestedWiki = path.join(candidate, "llm-wiki", "index.ts");
    try { if ((await lstat(nestedWiki)).isFile()) return path.resolve(nestedWiki); } catch (error) { if (!isNotFound(error)) throw error; }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return undefined;
}

function validateInstallationInput(installation: WikiInstallationInput, runtime: RuntimeResolution): void {
  if (!path.isAbsolute(installation.root)) throw new Error("resolved pi-llm-wiki installation path must be absolute");
  if (installation.root.includes("\u0000")) throw new Error("resolved pi-llm-wiki installation path contains NUL");
  if (!runtime.pi.executable || !path.isAbsolute(runtime.pi.executable)) throw new Error("resolved Pi executable must be absolute");
  if (!runtime.pi.installationId || !runtime.llmWiki.installationId) throw new Error("runtime installation identities are required");
}

async function readPackageMetadata(root: string): Promise<{ name: string; version: string }> {
  const packagePath = path.join(root, "package.json");
  try {
    const info = await lstat(packagePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("resolved pi-llm-wiki package metadata must be a regular file");
    const parsed = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
    if (typeof parsed["name"] !== "string" || typeof parsed["version"] !== "string") throw new Error("resolved pi-llm-wiki package metadata is incomplete");
    return { name: parsed["name"], version: parsed["version"] };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("resolved pi-llm-wiki")) throw error;
    throw new Error("resolved pi-llm-wiki package metadata is unreadable");
  }
}

async function assertReasoningCapable(profile: PiModelProfile, installation: WikiInstallationInput, resolver: WikiModelCapabilityResolver | undefined, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  let capability: WikiModelCapability;
  if (resolver) capability = await resolver(profile, installation, signal);
  else {
    const ref = `${profile.provider}/${profile.model}`;
    const known = installation.reasoningCapableModels?.includes(ref) || installation.reasoningCapableModels?.includes(profile.model);
    const conservativeKnown = profile.provider === "openai-codex" && /^gpt-5(?:[.-]|$)/iu.test(profile.model) && !/(?:non[-_ ]?reason|no[-_ ]?reason)/iu.test(profile.model);
    if (installation.reasoningCapable === false) throw new Error(`wiki model ${ref} is not reasoning-capable`);
    if (!installation.reasoningCapable && !known && !conservativeKnown) throw new Error(`reasoning capability is not proven for wiki model ${ref}`);
    capability = { reasoningCapable: installation.reasoningCapable ?? true };
  }
  if (!capability.reasoningCapable) throw new Error(`wiki model ${profile.provider}/${profile.model} is not reasoning-capable`);
}

async function ensureProjectWikiOverrideIsNotConflicting(workspace: string, profile: PiModelProfile, signal?: AbortSignal): Promise<void> {
  for (const directory of [".pi", ".omp"]) {
    const root = path.join(workspace, directory);
    const kind = await pathKind(root);
    if (kind === "symlink") throw new Error(`project ${directory} directory is symlinked; refusing to trust its settings`);
    if (kind === "missing") continue;
    if (kind !== "directory") throw new Error(`project ${directory} path is not a directory`);
    for (const filename of ["settings.json", "config.yml", "config.yaml"]) {
      throwIfAborted(signal);
      const file = path.join(root, filename);
      const fileKind = await pathKind(file);
      if (fileKind === "missing") continue;
      if (fileKind !== "file") throw new Error(`project settings file is not a regular file: ${file}`);
      const text = await readFile(file, "utf8");
      const candidate = parseTaskModelOverride(text, filename);
      if (candidate === "unverifiable") throw new Error(`project settings contain an unverifiable llm-wiki.taskModel override: ${file}`);
      if (candidate && (candidate.provider !== profile.provider || candidate.id !== profile.model)) {
        throw new Error(`project settings conflict with the controller-selected wiki model: ${file}`);
      }
    }
  }
}

function parseTaskModelOverride(text: string, filename: string): { provider: string; id: string } | "unverifiable" | undefined {
  if (filename === "settings.json") {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("project settings JSON is invalid"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("project settings must be a JSON object");
    const wiki = (parsed as Record<string, unknown>)["llm-wiki"];
    if (wiki === undefined) return undefined;
    if (!wiki || typeof wiki !== "object" || Array.isArray(wiki)) return "unverifiable";
    const task = (wiki as Record<string, unknown>)["taskModel"];
    if (task === undefined) return undefined;
    if (!task || typeof task !== "object" || Array.isArray(task)) return "unverifiable";
    const provider = (task as Record<string, unknown>)["provider"];
    const id = (task as Record<string, unknown>)["id"];
    if (typeof provider !== "string" || typeof id !== "string") return "unverifiable";
    return { provider, id };
  }
  // YAML is intentionally handled fail-closed rather than by a second parser:
  // the controller must not need the project's dependencies to trust its model.
  if (/\bllm-wiki\b/iu.test(text) && /\btaskModel\b/iu.test(text)) return "unverifiable";
  return undefined;
}

function footerPath(agentDir: string): string { return path.join(agentDir, FOOTER_FILE); }
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function deepEqual(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function assertRunId(runId: string): void { if (!RUN_ID.test(runId)) throw new Error("invalid run ID for Pi agent directory"); }
function absoluteDirectory(value: string, name: string): string { if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute`); return path.resolve(value); }
function isWithin(parent: string, child: string): boolean { const relative = path.relative(path.resolve(parent), path.resolve(child)); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }
function assertSafeOutput(agentDir: string, runtimeRoot: string, workspace: string, home?: string): void {
  const relative = path.relative(runtimeRoot, agentDir).split(path.sep).filter(Boolean);
  if (relative.length !== 2 || relative[1] !== "pi-agent") throw new Error("Pi agent directory must be directly beneath the run runtime root");
  if (isWithin(workspace, agentDir) || isWithin(agentDir, workspace)) throw new Error("Pi agent directory may not be inside the target workspace");
  if (home && (isWithin(home, agentDir) || isWithin(agentDir, home))) throw new Error("Pi agent directory may not be inside the host home directory");
}
async function canonicalRegularDirectory(value: string, name: string): Promise<string> {
  const info = await lstat(value);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name} must be a regular non-symlink directory`);
  return path.resolve(value);
}
async function rejectSymlinkComponents(root: string, target: string, name: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${name} escapes its installation`);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`${name} contains a symlink`);
  }
}
async function rejectSymlinkedAncestors(value: string, name: string): Promise<void> {
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const kind = await pathKind(current);
    if (kind === "symlink") throw new Error(`${name} contains a symlink`);
    if (kind === "missing") return;
  }
}
async function pathKind(value: string): Promise<"missing" | "file" | "directory" | "symlink" | "other"> {
  try {
    const info = await lstat(value);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (isNotFound(error)) return "missing";
    throw error;
  }
}
function isNotFound(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"); }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Pi agent-directory materialization aborted"); }
