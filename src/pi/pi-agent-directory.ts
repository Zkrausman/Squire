import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeWikiProfile, type PiModelProfile, type PiWikiProfileInput } from "./pi-configuration.js";
import type { RuntimeModelCapability, RuntimeResolution } from "../control/domain.js";
import { buildTrustedWikiFooterExtensionSource } from "./wiki-footer.js";

const AGENT_DIRECTORY_KIND = "squire-pi-agent-directory";
const AGENT_DIRECTORY_SCHEMA_VERSION = 1;
const WIKI_PACKAGE_NAME = "@zosmaai/pi-llm-wiki";
const FOOTER_FILE = "extensions/squire-trusted-wiki-footer.mjs";
const SETTINGS_FILE = "settings.json";
const MANIFEST_FILE = "squire-agent-manifest.json";
// These two files are created by Pi itself inside PI_CODING_AGENT_DIR. They
// are not trusted configuration: auth is accepted only in its empty default
// form unless explicitly provisioned, while the model store is a private,
// parseable Pi cache. Keeping them on the allow-list lets a real Pi restart
// without allowing arbitrary files into the trusted directory.
const PI_AUTH_FILE = "auth.json";
const PI_MODELS_STORE_FILE = "models-store.json";
const EMPTY_AUTH_BYTES = Buffer.from("{}", "utf8");
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
  /** Run-scoped HOME and WIKI_HOME; neither can resolve host state. */
  homeDir: string;
  wikiHomeDir: string;
  /** Ordered paths: wiki first, controller footer second. */
  trustedExtensionPaths: readonly [string, string];
  /** Digests of the exact loaded wiki entrypoint and generated footer. */
  wikiExtensionDigest: string;
  extensionDigest: string;
  /** Digest of every regular file in the resolved wiki package. */
  packageDigest: string;
}

/** Injectable preparation port used by PiRunner; implementations may be fakes in tests. */
export interface PiAgentDirectoryMaterializerPort {
  materialize(request: PiAgentDirectoryRequest): Promise<MaterializedPiAgentDirectory>;
  /** Verify an already materialized directory without creating or repairing it. */
  verify?(request: PiAgentDirectoryRequest, materialized: MaterializedPiAgentDirectory): Promise<void>;
}

/** Exact capability evidence returned by the trusted runtime/model registry. */
export type WikiModelCapability = RuntimeModelCapability;

export type WikiModelCapabilityResolver = (
  profile: PiModelProfile,
  runtime: RuntimeResolution,
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
  /** Resolve exact provider/model capability evidence from the trusted registry. */
  resolveModelCapability?: WikiModelCapabilityResolver;
  /** Host HOME is injectable only for safety assertions; it is never used as launch HOME. */
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
  isolation: {
    home: "home";
    wikiHome: "wiki-home";
  };
  files: {
    settings: { path: typeof SETTINGS_FILE; sha256: string };
    footerExtension: { path: typeof FOOTER_FILE; sha256: string };
    auth?: { path: string; sha256: string };
  };
  piRuntimeFiles: {
    auth: { path: typeof PI_AUTH_FILE; emptySha256: string };
    modelsStore: { path: typeof PI_MODELS_STORE_FILE };
  };
  trustedPackage: {
    root: string;
    packageJson: { path: string; sha256: string };
    entrypoint: { path: string; sha256: string };
    treeSha256: string;
  };
  trustedExtensions: readonly [string, string];
  trustedExtensionDigests: readonly [string, string];
}

interface MaterializationLayout {
  runtimeRoot: string;
  workspace: string;
  runRoot: string;
  agentDir: string;
  homeDir: string;
  wikiHomeDir: string;
}

interface PreparedMaterialization {
  layout: MaterializationLayout;
  wikiExtension: string;
  wikiExtensionDigest: string;
  packageDigest: string;
  footerDigest: string;
  expected: AgentManifest;
  entries: FileSystemEntry[];
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
    const prepared = await this.#prepare(request, profile);
    await ensureRunLayout(prepared.layout);
    await this.#createOrVerify(prepared, request.signal);
    return materializedResult(request.runId, prepared);
  }

  /**
   * Re-check an existing result without creating or repairing anything. The
   * runner invokes this as the last fenced pre-spawn integrity step, so a
   * changed package, project override, mode, or generated byte aborts the
   * launch instead of silently refreshing trust.
   */
  async verify(request: PiAgentDirectoryRequest, materialized: MaterializedPiAgentDirectory): Promise<void> {
    assertRunId(request.runId);
    const profile = normalizeWikiProfile(request.wikiProfile);
    const prepared = await this.#prepare(request, profile);
    const expected = materializedResult(request.runId, prepared);
    if (!sameMaterializedResult(materialized, expected)) throw new Error("materialized Pi agent-directory result changed during verification");
    await verifyRunLayout(prepared.layout);
    await verifyAgentDirectory(prepared.layout.agentDir, prepared.expected, prepared.entries.map(entry => entry.path));
  }

  async #prepare(request: PiAgentDirectoryRequest, profile: PiModelProfile): Promise<PreparedMaterialization> {
    throwIfAborted(request.signal);
    if (request.runtime.runId !== request.runId) throw new Error("runtime resolution belongs to a different run");
    const layout = await resolveMaterializationLayout(request, this.#options);
    await ensureProjectWikiOverrideIsNotConflicting(layout.workspace, profile, request.signal);

    const installation = await this.#resolveInstallation(request.runtime, request.signal);
    validateInstallationInput(installation, request.runtime);
    const wikiRoot = await canonicalRegularDirectory(installation.root, "resolved pi-llm-wiki installation");
    await rejectSymlinkedAncestors(wikiRoot, "resolved pi-llm-wiki installation");
    if (isWithin(layout.workspace, wikiRoot) || isWithin(wikiRoot, layout.workspace)) throw new Error("resolved pi-llm-wiki installation may not be in the target workspace");
    const home = this.#options.homeDirectory ?? process.env["HOME"];
    if (home && (isWithin(home, wikiRoot) || isWithin(wikiRoot, home))) throw new Error("resolved pi-llm-wiki installation may not be in the host home directory");
    const wikiExtension = await resolveWikiExtension(wikiRoot, installation.extensionPath);
    await rejectSymlinkComponents(wikiRoot, wikiExtension, "resolved pi-llm-wiki extension");
    const packageSnapshot = await snapshotTrustedPackage(wikiRoot, wikiExtension);
    if (packageSnapshot.name !== WIKI_PACKAGE_NAME) throw new Error(`resolved wiki installation is not ${WIKI_PACKAGE_NAME}`);
    if (packageSnapshot.version !== request.runtime.llmWiki.version) throw new Error("resolved pi-llm-wiki version does not match persisted runtime resolution");
    if (installation.version !== undefined && installation.version !== request.runtime.llmWiki.version) {
      throw new Error("wiki installation seam version does not match persisted runtime resolution");
    }
    if (installation.installationId !== undefined && installation.installationId !== request.runtime.llmWiki.installationId) {
      throw new Error("wiki installation seam identity does not match persisted runtime resolution");
    }
    await assertReasoningCapable(profile, request.runtime, installation, this.#options.resolveModelCapability, request.signal);
    throwIfAborted(request.signal);

    const footerSource = Buffer.from(buildTrustedWikiFooterExtensionSource(profile), "utf8");
    const footerDigest = sha256(footerSource);
    const settings = buildSettings(wikiRoot, profile);
    const settingsBytes = Buffer.from(`${JSON.stringify(settings, null, 2)}\n`, "utf8");
    const authEntry = await this.#readTrustedAuth(layout.agentDir, layout.workspace, request.signal);
    const manifest: AgentManifest = {
      schemaVersion: AGENT_DIRECTORY_SCHEMA_VERSION,
      kind: AGENT_DIRECTORY_KIND,
      runId: request.runId,
      runtime: {
        pi: { ...request.runtime.pi },
        llmWiki: { ...request.runtime.llmWiki, root: wikiRoot },
      },
      isolation: { home: "home", wikiHome: "wiki-home" },
      wikiProfile: { ...profile },
      files: {
        settings: { path: SETTINGS_FILE, sha256: sha256(settingsBytes) },
        footerExtension: { path: FOOTER_FILE, sha256: footerDigest },
        ...(authEntry ? { auth: { path: authEntry.relativePath, sha256: authEntry.digest } } : {}),
      },
      piRuntimeFiles: {
        auth: { path: PI_AUTH_FILE, emptySha256: sha256(EMPTY_AUTH_BYTES) },
        modelsStore: { path: PI_MODELS_STORE_FILE },
      },
      trustedPackage: {
        root: wikiRoot,
        packageJson: { path: packageSnapshot.packageJsonPath, sha256: packageSnapshot.packageJsonDigest },
        entrypoint: { path: wikiExtension, sha256: packageSnapshot.entrypointDigest },
        treeSha256: packageSnapshot.treeDigest,
      },
      trustedExtensions: [wikiExtension, footerPath(layout.agentDir)],
      trustedExtensionDigests: [packageSnapshot.entrypointDigest, footerDigest],
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const authFile = authEntry ? { path: path.resolve(layout.agentDir, authEntry.relativePath), bytes: authEntry.bytes, mode: 0o600 } : undefined;
    const entries: FileSystemEntry[] = [
      { path: SETTINGS_FILE, bytes: settingsBytes, mode: 0o600 },
      { path: FOOTER_FILE, bytes: footerSource, mode: 0o600 },
      { path: MANIFEST_FILE, bytes: manifestBytes, mode: 0o600 },
      ...(authFile ? [{ path: authEntry!.relativePath, bytes: authFile.bytes, mode: authFile.mode }] : []),
    ];
    return {
      layout,
      wikiExtension,
      wikiExtensionDigest: packageSnapshot.entrypointDigest,
      packageDigest: packageSnapshot.treeDigest,
      footerDigest,
      expected: manifest,
      entries,
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

  async #readTrustedAuth(agentDir: string, workspace: string, signal?: AbortSignal): Promise<{ relativePath: string; bytes: Buffer; digest: string } | undefined> {
    const input = this.#options.trustedAuth;
    if (!input) return undefined;
    throwIfAborted(signal);
    const relativePath = input.destination ?? "auth.json";
    if (!SAFE_RELATIVE_FILE.test(relativePath) || relativePath.split("/").some(part => part === "." || part === "..")) {
      throw new Error("trusted auth destination must be a safe relative file");
    }
    if ([SETTINGS_FILE, FOOTER_FILE, MANIFEST_FILE, PI_MODELS_STORE_FILE].includes(relativePath)) {
      throw new Error("trusted auth destination conflicts with a generated Pi file");
    }
    const source = path.resolve(input.sourcePath);
    const hostHome = this.#options.homeDirectory ?? process.env["HOME"];
    if (isWithin(workspace, source) || isWithin(source, workspace)) throw new Error("trusted auth source may not be in the target workspace");
    if (hostHome && (isWithin(hostHome, source) || isWithin(source, hostHome))) throw new Error("trusted auth source may not be in the host home directory");
    await rejectSymlinkedAncestors(source, "trusted auth source");
    const sourceStat = await lstatRequired(source, "trusted auth source");
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("trusted auth source must be a regular non-symlink file");
    assertPrivateFile(sourceStat, "trusted auth source");
    const bytes = await readStableFile(source, "trusted auth source");
    const digest = sha256(bytes);
    if (input.sha256 !== undefined && input.sha256 !== digest) throw new Error("trusted auth digest mismatch");
    const destination = path.resolve(agentDir, relativePath);
    if (!isWithin(agentDir, destination)) throw new Error("trusted auth destination escapes agent directory");
    return { relativePath, bytes, digest };
  }

  async #createOrVerify(prepared: PreparedMaterialization, signal?: AbortSignal): Promise<void> {
    const { layout, entries, expected } = prepared;
    throwIfAborted(signal);
    const existing = await pathKind(layout.agentDir);
    if (existing !== "missing") {
      if (existing !== "directory") throw new Error("Pi agent directory is not a regular directory");
      await verifyAgentDirectory(layout.agentDir, expected, entries.map(entry => entry.path));
      await verifyRunLayout(layout);
      return;
    }
    const staging = await mkdtemp(path.join(layout.runRoot, ".pi-agent-staging-"));
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
        await rename(staging, layout.agentDir);
      } catch (error) {
        if (await pathKind(layout.agentDir) === "directory") {
          await verifyAgentDirectory(layout.agentDir, expected, entries.map(entry => entry.path));
          return;
        }
        throw error;
      }
      await verifyAgentDirectory(layout.agentDir, expected, entries.map(entry => entry.path));
      await verifyRunLayout(layout);
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

async function verifyAgentDirectory(
  agentDir: string,
  expected: AgentManifest,
  expectedFiles: readonly string[],
): Promise<void> {
  const agentInfo = await lstatRequired(agentDir, "Pi agent directory");
  assertPrivateDirectory(agentInfo, "Pi agent directory");
  const manifestPath = path.join(agentDir, MANIFEST_FILE);
  const manifestStat = await lstatRequired(manifestPath, "Pi agent manifest");
  assertPrivateFile(manifestStat, "Pi agent manifest");
  const manifestBytes = await readStableFile(manifestPath, "Pi agent manifest");
  let actual: unknown;
  try { actual = JSON.parse(manifestBytes.toString("utf8")); } catch { throw new Error("Pi agent manifest is not valid JSON"); }
  if (!deepEqual(actual, expected)) throw new Error("Pi agent manifest conflicts with the requested run configuration");
  if (sha256(manifestBytes) !== sha256(serializeManifest(expected))) throw new Error("Pi agent manifest digest mismatch");
  const requiredSet = new Set([...expectedFiles, MANIFEST_FILE]);
  const optionalPiFiles = new Set([PI_AUTH_FILE, PI_MODELS_STORE_FILE].filter(file => !requiredSet.has(file)));
  const allowedFiles = new Set([...requiredSet, ...optionalPiFiles]);
  const expectedDirectories = new Set<string>();
  for (const file of requiredSet) {
    let parent = path.posix.dirname(file);
    while (parent !== ".") {
      expectedDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const entries = await listRelativeEntries(agentDir);
  if (entries.files.some(name => !allowedFiles.has(name))
    || entries.files.length < requiredSet.size
    || [...requiredSet].some(name => !entries.files.includes(name))
    || entries.directories.some(name => !expectedDirectories.has(name))) {
    throw new Error("Pi agent directory contains unexpected or partial content");
  }
  for (const directory of entries.directories) {
    const directoryStat = await lstatRequired(path.join(agentDir, directory), `Pi agent directory entry: ${directory}`);
    assertPrivateDirectory(directoryStat, `Pi agent directory entry: ${directory}`);
  }
  for (const file of [MANIFEST_FILE, ...expectedFiles]) {
    const target = path.join(agentDir, file);
    const fileStat = await lstatRequired(target, `Pi agent file: ${file}`);
    assertPrivateFile(fileStat, `Pi agent file: ${file}`);
  }
  const settingsBytes = await readStableFile(path.join(agentDir, SETTINGS_FILE), "Pi settings");
  const footerBytes = await readStableFile(path.join(agentDir, FOOTER_FILE), "trusted footer");
  if (sha256(settingsBytes) !== expected.files.settings.sha256) throw new Error("Pi settings digest mismatch");
  if (sha256(footerBytes) !== expected.files.footerExtension.sha256) throw new Error("trusted footer digest mismatch");
  if (expected.files.auth) {
    const authBytes = await readStableFile(path.join(agentDir, expected.files.auth.path), "trusted auth");
    if (sha256(authBytes) !== expected.files.auth.sha256) throw new Error("trusted auth digest mismatch");
  }
  for (const file of optionalPiFiles) {
    const target = path.join(agentDir, file);
    const fileKind = await pathKind(target);
    if (fileKind === "missing") continue;
    if (fileKind !== "file") throw new Error(`Pi runtime file is not a regular file: ${file}`);
    const fileStat = await lstatRequired(target, `Pi runtime file: ${file}`);
    assertPrivateFile(fileStat, `Pi runtime file: ${file}`);
    const bytes = await readStableFile(target, `Pi runtime file: ${file}`);
    if (file === PI_AUTH_FILE && !bytes.equals(EMPTY_AUTH_BYTES)) {
      throw new Error("Pi auth.json is not the empty unprovisioned credential store");
    }
    if (file === PI_MODELS_STORE_FILE) assertJsonObject(bytes, "Pi models-store.json");
  }
  await verifyTrustedPackage(expected.trustedPackage);
}

async function verifyTrustedPackage(expected: AgentManifest["trustedPackage"]): Promise<void> {
  const snapshot = await snapshotTrustedPackage(expected.root, expected.entrypoint.path);
  if (snapshot.packageJsonPath !== expected.packageJson.path || snapshot.packageJsonDigest !== expected.packageJson.sha256) {
    throw new Error("resolved pi-llm-wiki package metadata digest mismatch");
  }
  if (snapshot.entrypointPath !== expected.entrypoint.path || snapshot.entrypointDigest !== expected.entrypoint.sha256) {
    throw new Error("resolved pi-llm-wiki entrypoint digest mismatch");
  }
  if (snapshot.treeDigest !== expected.treeSha256) throw new Error("resolved pi-llm-wiki package digest mismatch");
}

async function resolveMaterializationLayout(
  request: PiAgentDirectoryRequest,
  options: PiAgentDirectoryMaterializerOptions,
): Promise<MaterializationLayout> {
  const runtimeRoot = absoluteDirectory(options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, "runtime root");
  const workspace = absoluteDirectory(request.workspace ?? options.workspace ?? DEFAULT_WORKSPACE, "workspace");
  const runRoot = path.resolve(runtimeRoot, request.runId);
  const agentDir = path.resolve(runRoot, "pi-agent");
  const homeDir = path.resolve(runRoot, "home");
  const wikiHomeDir = path.resolve(runRoot, "wiki-home");
  const hostHome = options.homeDirectory ?? process.env["HOME"];
  assertSafeOutput(agentDir, runtimeRoot, workspace, hostHome);
  assertSafeRunChild(homeDir, runRoot, runtimeRoot, workspace, hostHome, "run-scoped HOME");
  assertSafeRunChild(wikiHomeDir, runRoot, runtimeRoot, workspace, hostHome, "run-scoped WIKI_HOME");
  await rejectSymlinkedAncestors(runtimeRoot, "runtime root");
  await rejectSymlinkedAncestors(workspace, "workspace");
  const runRootKind = await pathKind(runRoot);
  if (runRootKind === "symlink") throw new Error("run runtime directory may not be symlinked");
  if (runRootKind !== "missing" && runRootKind !== "directory") throw new Error("run runtime path is not a directory");
  return { runtimeRoot, workspace, runRoot, agentDir, homeDir, wikiHomeDir };
}

async function ensureRunLayout(layout: MaterializationLayout): Promise<void> {
  await mkdir(layout.runtimeRoot, { recursive: true, mode: 0o755 });
  await ensureSecureDirectory(layout.runtimeRoot, "runtime root", false);
  await mkdir(layout.runRoot, { recursive: true, mode: 0o700 });
  await ensureSecureDirectory(layout.runRoot, "run runtime directory", true);
  await ensurePrivateDirectory(layout.homeDir, "run-scoped HOME");
  await ensurePrivateDirectory(layout.wikiHomeDir, "run-scoped WIKI_HOME");
  await verifyNoSymlinksBelow(layout.homeDir, "run-scoped HOME");
  await verifyNoSymlinksBelow(layout.wikiHomeDir, "run-scoped WIKI_HOME");
  const agentKind = await pathKind(layout.agentDir);
  if (agentKind === "symlink") throw new Error("Pi agent directory may not be symlinked");
  if (agentKind !== "missing" && agentKind !== "directory") throw new Error("Pi agent directory is not a regular directory");
  await verifyRunRootChildren(layout, agentKind === "directory");
}

async function verifyRunLayout(layout: MaterializationLayout, agentMustExist = true): Promise<void> {
  await ensureSecureDirectory(layout.runtimeRoot, "runtime root", false);
  await ensureSecureDirectory(layout.runRoot, "run runtime directory", true);
  await ensureSecureDirectory(layout.homeDir, "run-scoped HOME", true);
  await ensureSecureDirectory(layout.wikiHomeDir, "run-scoped WIKI_HOME", true);
  await verifyNoSymlinksBelow(layout.homeDir, "run-scoped HOME");
  await verifyNoSymlinksBelow(layout.wikiHomeDir, "run-scoped WIKI_HOME");
  await verifyRunRootChildren(layout, agentMustExist);
  if (agentMustExist) await ensureSecureDirectory(layout.agentDir, "Pi agent directory", true);
}

async function verifyRunRootChildren(layout: MaterializationLayout, agentMustExist: boolean): Promise<void> {
  const expected = new Set(["home", "wiki-home", ...(agentMustExist ? ["pi-agent"] : [])]);
  const entries = await readdir(layout.runRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory() || !expected.has(entry.name)) {
      throw new Error("Pi run directory contains unexpected or partial content");
    }
  }
  for (const required of expected) {
    if (!entries.some(entry => entry.name === required)) throw new Error("Pi run directory contains unexpected or partial content");
  }
}

async function verifyNoSymlinksBelow(root: string, name: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${name} contains a symlink: ${entry.name}`);
    const info = await lstatRequired(target, `${name} entry: ${entry.name}`);
    if (entry.isDirectory()) {
      assertOwned(info, `${name} entry: ${entry.name}`);
      await verifyNoSymlinksBelow(target, `${name} entry: ${entry.name}`);
    } else if (entry.isFile()) {
      assertOwned(info, `${name} entry: ${entry.name}`);
    } else {
      throw new Error(`${name} contains a non-regular entry: ${entry.name}`);
    }
  }
}

async function ensurePrivateDirectory(value: string, name: string): Promise<void> {
  const kind = await pathKind(value);
  if (kind === "symlink") throw new Error(`${name} may not be symlinked`);
  if (kind === "missing") {
    await mkdir(value, { recursive: false, mode: 0o700 });
    await chmod(value, 0o700);
  }
  await ensureSecureDirectory(value, name, true);
}

async function ensureSecureDirectory(value: string, name: string, privateMode: boolean): Promise<void> {
  const info = await lstatRequired(value, name);
  if (privateMode) assertPrivateDirectory(info, name);
  else assertSecureInstallationMode(info, name);
}

function assertSafeRunChild(value: string, runRoot: string, runtimeRoot: string, workspace: string, hostHome: string | undefined, name: string): void {
  const relative = path.relative(runRoot, value).split(path.sep).filter(Boolean);
  if (relative.length !== 1 || (relative[0] !== "home" && relative[0] !== "wiki-home")) throw new Error(`${name} must be directly beneath the run runtime directory`);
  if (isWithin(workspace, value) || isWithin(value, workspace)) throw new Error(`${name} may not be inside the target workspace`);
  if (isWithin(runtimeRoot, value) === false) throw new Error(`${name} must be beneath the runtime root`);
  if (hostHome && (isWithin(hostHome, value) || isWithin(value, hostHome))) throw new Error(`${name} may not be inside the host home directory`);
}

function materializedResult(runId: string, prepared: PreparedMaterialization): MaterializedPiAgentDirectory {
  const { layout } = prepared;
  return {
    runId,
    agentDir: layout.agentDir,
    settingsPath: path.join(layout.agentDir, SETTINGS_FILE),
    manifestPath: path.join(layout.agentDir, MANIFEST_FILE),
    footerExtensionPath: footerPath(layout.agentDir),
    homeDir: layout.homeDir,
    wikiHomeDir: layout.wikiHomeDir,
    trustedExtensionPaths: [prepared.wikiExtension, footerPath(layout.agentDir)],
    wikiExtensionDigest: prepared.wikiExtensionDigest,
    extensionDigest: prepared.footerDigest,
    packageDigest: prepared.packageDigest,
  };
}

function sameMaterializedResult(left: MaterializedPiAgentDirectory, right: MaterializedPiAgentDirectory): boolean {
  return deepEqual(left, right);
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

interface PackageMetadataSnapshot {
  name: string;
  version: string;
  packageJsonPath: string;
  packageJsonDigest: string;
}

interface TrustedPackageSnapshot extends PackageMetadataSnapshot {
  entrypointPath: string;
  entrypointDigest: string;
  treeDigest: string;
}

async function readPackageMetadata(root: string): Promise<PackageMetadataSnapshot> {
  const packagePath = path.join(root, "package.json");
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstat(packagePath); }
  catch { throw new Error("resolved pi-llm-wiki package metadata is unreadable"); }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("resolved pi-llm-wiki package metadata must be a regular file");
  assertSecureInstallationFile(info, "resolved pi-llm-wiki package metadata");
  let bytes: Buffer;
  try { bytes = await readStableFile(packagePath, "resolved pi-llm-wiki package metadata"); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("resolved pi-llm-wiki")) throw error;
    throw new Error("resolved pi-llm-wiki package metadata is unreadable");
  }
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; }
  catch { throw new Error("resolved pi-llm-wiki package metadata is unreadable"); }
  if (typeof parsed["name"] !== "string" || typeof parsed["version"] !== "string") throw new Error("resolved pi-llm-wiki package metadata is incomplete");
  return { name: parsed["name"], version: parsed["version"], packageJsonPath: packagePath, packageJsonDigest: sha256(bytes) };
}

async function snapshotTrustedPackage(root: string, entrypoint: string): Promise<TrustedPackageSnapshot> {
  const metadata = await readPackageMetadata(root);
  const entrypointInfo = await lstatRequired(entrypoint, "resolved pi-llm-wiki extension");
  if (!entrypointInfo.isFile() || entrypointInfo.isSymbolicLink()) throw new Error("resolved pi-llm-wiki extension must be a regular file");
  assertSecureInstallationFile(entrypointInfo, "resolved pi-llm-wiki extension");
  const entrypointBytes = await readStableFile(entrypoint, "resolved pi-llm-wiki extension");
  const treeDigest = await digestTrustedPackage(root);
  return {
    ...metadata,
    entrypointPath: path.resolve(entrypoint),
    entrypointDigest: sha256(entrypointBytes),
    treeDigest,
  };
}

async function digestTrustedPackage(root: string): Promise<string> {
  const digest = createHash("sha256");
  async function visit(current: string, relativeRoot: string): Promise<void> {
    const info = await lstatRequired(current, "resolved pi-llm-wiki package entry");
    if (info.isSymbolicLink()) throw new Error("resolved pi-llm-wiki package contains a symlink");
    if (info.isDirectory()) {
      assertSecureInstallationDirectory(info, `resolved pi-llm-wiki package directory: ${relativeRoot || "."}`);
      digest.update(`directory\\0${relativeRoot}\\0`, "utf8");
      const children = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        const childRelative = relativeRoot ? `${relativeRoot}/${child.name}` : child.name;
        await visit(path.join(current, child.name), childRelative);
      }
      return;
    }
    if (!info.isFile()) throw new Error(`resolved pi-llm-wiki package contains a non-regular entry: ${relativeRoot}`);
    assertSecureInstallationFile(info, `resolved pi-llm-wiki package file: ${relativeRoot}`);
    const bytes = await readStableFile(current, `resolved pi-llm-wiki package file: ${relativeRoot}`);
    digest.update(`file\\0${relativeRoot}\\0${bytes.byteLength}\\0`, "utf8").update(bytes);
  }
  await visit(root, "");
  return digest.digest("hex");
}

async function assertReasoningCapable(
  profile: PiModelProfile,
  runtime: RuntimeResolution,
  installation: WikiInstallationInput,
  resolver: WikiModelCapabilityResolver | undefined,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const ref = `${profile.provider}/${profile.model}`;
  const capability = resolver
    ? await resolver(profile, runtime, installation, signal)
    : findRuntimeCapability(runtime, profile);
  assertExactCapability(capability, profile, runtime, ref);
  if (!capability.reasoningCapable) throw new Error(`wiki model ${ref} is not reasoning-capable`);
}

function findRuntimeCapability(runtime: RuntimeResolution, profile: PiModelProfile): WikiModelCapability {
  const matches = (runtime.modelCapabilities ?? []).filter(capability => isExactCapabilityShape(capability)
    && capability.provider === profile.provider
    && capability.model === profile.model
    && capability.piInstallationId === runtime.pi.installationId
    && capability.wikiInstallationId === runtime.llmWiki.installationId);
  if (matches.length !== 1) throw new Error(`reasoning capability is not proven for wiki model ${profile.provider}/${profile.model}`);
  return matches[0]!;
}

function assertExactCapability(
  capability: WikiModelCapability,
  profile: PiModelProfile,
  runtime: RuntimeResolution,
  ref: string,
): void {
  if (!isExactCapabilityShape(capability)
    || capability.provider !== profile.provider
    || capability.model !== profile.model
    || capability.piInstallationId !== runtime.pi.installationId
    || capability.wikiInstallationId !== runtime.llmWiki.installationId) {
    throw new Error(`reasoning capability is not proven for wiki model ${ref}`);
  }
}

function isExactCapabilityShape(value: unknown): value is WikiModelCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 5 || keys.join("\\0") !== ["model", "piInstallationId", "provider", "reasoningCapable", "wikiInstallationId"].join("\\0")) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["provider"] === "string"
    && typeof candidate["model"] === "string"
    && typeof candidate["reasoningCapable"] === "boolean"
    && typeof candidate["piInstallationId"] === "string"
    && typeof candidate["wikiInstallationId"] === "string";
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
function serializeManifest(manifest: AgentManifest): Buffer { return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"); }
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

async function lstatRequired(value: string, name: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try { return await lstat(value); }
  catch (error) {
    if (isNotFound(error)) throw new Error(`${name} is missing`);
    throw error;
  }
}

function assertOwned(info: Awaited<ReturnType<typeof lstat>>, name: string): void {
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new Error(`${name} has unexpected ownership`);
}

function assertPrivateDirectory(info: Awaited<ReturnType<typeof lstat>>, name: string): void {
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name} is not a regular directory`);
  assertOwned(info, name);
  if ((modeBits(info) & 0o777) !== 0o700) throw new Error(`${name} has unsafe permissions; expected 0700`);
}

function assertPrivateFile(info: Awaited<ReturnType<typeof lstat>>, name: string): void {
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} is not a regular file`);
  assertOwned(info, name);
  if ((modeBits(info) & 0o777) !== 0o600) throw new Error(`${name} has unsafe permissions; expected 0600`);
}

function assertSecureInstallationDirectory(info: Awaited<ReturnType<typeof lstat>>, name: string): void {
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name} is not a regular directory`);
  assertOwned(info, name);
  if ((modeBits(info) & 0o022) !== 0) throw new Error(`${name} has unsafe permissions`);
}

function assertSecureInstallationFile(info: Awaited<ReturnType<typeof lstat>>, name: string): void {
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} is not a regular file`);
  assertOwned(info, name);
  if ((modeBits(info) & 0o022) !== 0) throw new Error(`${name} has unsafe permissions`);
}

function assertSecureInstallationMode(info: Awaited<ReturnType<typeof lstat>>, name: string): void {
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name} is not a regular directory`);
  assertOwned(info, name);
  if ((modeBits(info) & 0o022) !== 0) throw new Error(`${name} has unsafe permissions`);
}

async function readStableFile(value: string, name: string): Promise<Buffer> {
  const before = await lstatRequired(value, name);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${name} is not a regular file`);
  const bytes = await readFile(value);
  const after = await lstatRequired(value, name);
  if (!sameFileStat(before, after)) throw new Error(`${name} changed while it was being read`);
  return bytes;
}

function assertJsonObject(bytes: Buffer, name: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`${name} is not valid JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name} must contain a JSON object`);
}

function modeBits(info: Awaited<ReturnType<typeof lstat>>): number {
  return typeof info.mode === "bigint" ? Number(info.mode) : info.mode;
}

function sameFileStat(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && modeBits(left) === modeBits(right)
    && left.uid === right.uid
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}
async function canonicalRegularDirectory(value: string, name: string): Promise<string> {
  const info = await lstatRequired(value, name);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name} must be a regular non-symlink directory`);
  assertSecureInstallationDirectory(info, name);
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
