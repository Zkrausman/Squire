import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, lutimes, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
const PREPARATION_LOCK_DIRECTORY = ".pi-agent-lock";
const PREPARATION_LOCK_OWNER_FILE = "owner.json";
const PREPARATION_LOCK_HEARTBEAT_FILE = "heartbeat";
const PREPARATION_LOCK_RECLAIM_DIRECTORY = ".reclaim";
const PREPARATION_LOCK_RECLAIM_OWNER_FILE = "owner.json";
const PREPARATION_LOCK_KIND = "squire-pi-agent-preparation-lock";
const PREPARATION_RECLAIM_KIND = "squire-pi-agent-preparation-reclaim";
const PREPARATION_LOCK_SCHEMA_VERSION = 1;
const PREPARATION_LOCK_TIMEOUT_MS = 10_000;
const PREPARATION_LOCK_STALE_MS = 5_000;
const PREPARATION_LOCK_POLL_MS = 25;
const PREPARATION_LOCK_RACE_RETRIES = 20;
const PREPARATION_LOCK_RACE_DELAY_MS = 5;
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const PREPARATION_LOCK_OWNER_TEMP = /^owner\.json\.tmp-[0-9a-f-]{36}$/u;
const PREPARATION_LOCK_HEARTBEAT_TEMP = /^heartbeat\.tmp-[0-9a-f-]{36}$/u;
const PREPARATION_RECLAIM_OWNER_TEMP = /^owner\.json\.tmp-[0-9a-f-]{36}$/u;

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
  /** Bounds waiting for another controller's preparation lock. */
  preparationLockTimeoutMs?: number;
  /** Age after which a dead controller's preparation lock may be reclaimed. */
  preparationLockStaleMs?: number;
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
  profile: PiModelProfile;
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

interface PreparationLockOwner {
  schemaVersion: 1;
  kind: typeof PREPARATION_LOCK_KIND;
  runId: string;
  token: string;
  pid: number;
  createdAt: number;
  requestFingerprint: string;
}

interface PreparationReclaimOwner {
  schemaVersion: 1;
  kind: typeof PREPARATION_RECLAIM_KIND;
  token: string;
  pid: number;
  createdAt: number;
}

interface DirectoryIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

interface PreparationLockObservation {
  state: "missing" | "active" | "stale" | "conflict";
  owner?: PreparationLockOwner;
  directoryIdentity?: DirectoryIdentity;
}

class PreparationLockRace extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PreparationLockRace";
  }
}

class PreparationLock {
  readonly #heartbeatTimer: ReturnType<typeof setInterval>;
  #heartbeatError: Error | undefined;
  #released = false;

  constructor(
    readonly directory: string,
    readonly owner: PreparationLockOwner,
    readonly heartbeatPath: string,
    readonly directoryIdentity: DirectoryIdentity,
    staleMs: number,
  ) {
    const interval = Math.max(25, Math.min(1_000, Math.floor(staleMs / 3)));
    this.#heartbeatTimer = setInterval(() => {
      void this.#heartbeat().catch(error => {
        // A release/replacement can legitimately remove the path between
        // heartbeat observations. The next fenced assertion will re-open the
        // lock and either recover or fail closed; do not turn one transient
        // ENOENT into a permanent heartbeat failure.
        if (!isTransientLockRace(error) && !this.#heartbeatError) {
          this.#heartbeatError = error instanceof Error ? error : new Error(String(error));
        }
      });
    }, interval);
    this.#heartbeatTimer.unref?.();
  }

  async assertHealthy(): Promise<void> {
    if (this.#heartbeatError) throw new Error(`Pi agent-directory preparation lock heartbeat failed: ${this.#heartbeatError.message}`);
    await verifyPreparationLock(this.directory, this.owner, true, this.directoryIdentity);
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    clearInterval(this.#heartbeatTimer);
    let lastRace: unknown;
    for (let attempt = 0; attempt < PREPARATION_LOCK_RACE_RETRIES; attempt += 1) {
      try {
        const kind = await pathKind(this.directory);
        if (kind === "missing") return;
        if (kind !== "directory") throw new Error("Pi agent-directory preparation lock was replaced");
        await verifyPreparationLock(this.directory, this.owner, false, this.directoryIdentity);
        await assertStableDirectoryIdentity(this.directory, this.directoryIdentity, "Pi agent-directory preparation lock");
        await rm(this.directory, { recursive: true, force: false });
        return;
      } catch (error) {
        if (!isTransientLockRace(error)) throw error;
        lastRace = error;
        if (await pathKind(this.directory) === "missing") return;
        if (attempt + 1 < PREPARATION_LOCK_RACE_RETRIES) await waitForDelay(PREPARATION_LOCK_RACE_DELAY_MS);
      }
    }
    throw lastRace instanceof Error ? lastRace : new Error("Pi agent-directory preparation lock release raced with replacement");
  }

  async #heartbeat(): Promise<void> {
    if (this.#released) return;
    await assertStableDirectoryIdentity(this.directory, this.directoryIdentity, "Pi agent-directory preparation lock");
    const owner = await readPreparationLockOwner(path.join(this.directory, PREPARATION_LOCK_OWNER_FILE));
    if (!samePreparationLockOwner(owner, this.owner)) throw new Error("Pi agent-directory preparation lock ownership changed");
    const info = await lstatRequired(this.heartbeatPath, "Pi agent-directory preparation lock heartbeat");
    assertPrivateFile(info, "Pi agent-directory preparation lock heartbeat");
    await lutimes(this.heartbeatPath, new Date(), new Date());
    await assertStableDirectoryIdentity(this.directory, this.directoryIdentity, "Pi agent-directory preparation lock");
    const finalOwner = await readPreparationLockOwner(path.join(this.directory, PREPARATION_LOCK_OWNER_FILE));
    if (!samePreparationLockOwner(finalOwner, this.owner)) throw new Error("Pi agent-directory preparation lock ownership changed");
  }
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
    const requestFingerprint = materializationFingerprint(prepared);
    const lock = await acquirePreparationLock(
      prepared.layout,
      requestFingerprint,
      this.#options,
      request.signal,
    );
    if (!lock) {
      await verifyCompletedMaterializationLock(prepared.layout, request.runId, requestFingerprint, this.#options, request.signal);
      await verifyRunLayout(prepared.layout, true, "optional");
      await verifyAgentDirectory(prepared.layout.agentDir, prepared.expected, prepared.entries.map(entry => entry.path));
      return materializedResult(request.runId, prepared);
    }
    try {
      await lock.assertHealthy();
      await ensureRunLayout(prepared.layout, request.signal);
      await lock.assertHealthy();
      await this.#createOrVerify(prepared, lock, request.signal);
      await lock.assertHealthy();
      await verifyRunLayout(prepared.layout, true, true);
      return materializedResult(request.runId, prepared);
    } finally {
      await lock.release();
    }
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
    const requestFingerprint = materializationFingerprint(prepared);
    const lock = await acquirePreparationLock(
      prepared.layout,
      requestFingerprint,
      this.#options,
      request.signal,
    );
    const expected = materializedResult(request.runId, prepared);
    if (!lock) {
      await verifyCompletedMaterializationLock(prepared.layout, request.runId, requestFingerprint, this.#options, request.signal);
      await ensureProjectWikiOverrideIsNotConflicting(prepared.layout.workspace, profile, request.signal);
      if (!sameMaterializedResult(materialized, expected)) throw new Error("materialized Pi agent-directory result changed during verification");
      await verifyRunLayout(prepared.layout, true, "optional");
      await verifyAgentDirectory(prepared.layout.agentDir, prepared.expected, prepared.entries.map(entry => entry.path));
      return;
    }
    try {
      await lock.assertHealthy();
      await ensureProjectWikiOverrideIsNotConflicting(prepared.layout.workspace, profile, request.signal);
      if (!sameMaterializedResult(materialized, expected)) throw new Error("materialized Pi agent-directory result changed during verification");
      await verifyRunLayout(prepared.layout, true, true);
      await verifyAgentDirectory(prepared.layout.agentDir, prepared.expected, prepared.entries.map(entry => entry.path));
    } finally {
      await lock.release();
    }
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
      profile,
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

  async #createOrVerify(prepared: PreparedMaterialization, lock: PreparationLock, signal?: AbortSignal): Promise<void> {
    const { layout, entries, expected, profile } = prepared;
    throwIfAborted(signal);
    await ensureProjectWikiOverrideIsNotConflicting(layout.workspace, profile, signal);
    const existing = await pathKind(layout.agentDir);
    if (existing !== "missing") {
      if (existing !== "directory") throw new Error("Pi agent directory is not a regular directory");
      await verifyAgentDirectory(layout.agentDir, expected, entries.map(entry => entry.path));
      await verifyRunLayout(layout, true, true);
      return;
    }
    const staging = path.join(lock.directory, "staging");
    const stagingKind = await pathKind(staging);
    if (stagingKind !== "missing") throw new Error("Pi agent preparation staging directory contains partial content");
    await mkdir(staging, { recursive: false, mode: 0o700 });
    await chmod(staging, 0o700);
    try {
      for (const entry of entries) {
        throwIfAborted(signal);
        await lock.assertHealthy();
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
      await verifyRunLayout(layout, true, true);
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

async function verifyCompletedMaterializationLock(
  layout: MaterializationLayout,
  runId: string,
  requestFingerprint: string,
  options: PiAgentDirectoryMaterializerOptions,
  signal?: AbortSignal,
): Promise<void> {
  const timeoutMs = positiveInteger(options.preparationLockTimeoutMs ?? PREPARATION_LOCK_TIMEOUT_MS, "preparation lock timeout");
  const staleMs = positiveInteger(options.preparationLockStaleMs ?? PREPARATION_LOCK_STALE_MS, "preparation lock stale timeout");
  const startedAt = monotonicMilliseconds();
  for (;;) {
    throwIfAborted(signal);
    const observation = await inspectPreparationLock(layout, runId, requestFingerprint, staleMs);
    if (observation.state === "conflict") throw new Error("conflicting Pi agent-directory preparation request");
    if (observation.state === "stale") {
      if (await reclaimStalePreparationLock(layout, runId, requestFingerprint, observation, staleMs, signal)) continue;
    } else {
      return;
    }
    const remaining = timeoutMs - (monotonicMilliseconds() - startedAt);
    if (remaining <= 0) throw new Error("completed Pi agent-directory materialization has a stale preparation lock");
    await waitForDelay(Math.min(PREPARATION_LOCK_POLL_MS, remaining), signal);
  }
}

async function acquirePreparationLock(
  layout: MaterializationLayout,
  requestFingerprint: string,
  options: PiAgentDirectoryMaterializerOptions,
  signal?: AbortSignal,
): Promise<PreparationLock | undefined> {
  const timeoutMs = positiveInteger(options.preparationLockTimeoutMs ?? PREPARATION_LOCK_TIMEOUT_MS, "preparation lock timeout");
  const staleMs = positiveInteger(options.preparationLockStaleMs ?? PREPARATION_LOCK_STALE_MS, "preparation lock stale timeout");
  await ensureBaseRunLayout(layout);
  const startedAt = monotonicMilliseconds();
  for (;;) {
    throwIfAborted(signal);
    if (monotonicMilliseconds() - startedAt >= timeoutMs) throw new Error("Pi agent-directory preparation lock acquisition timed out");
    const observation = await inspectPreparationLock(layout, path.basename(layout.runRoot), requestFingerprint, staleMs);
    if (observation.state === "conflict") throw new Error("conflicting Pi agent-directory preparation request");
    if (observation.state === "stale") {
      if (await reclaimStalePreparationLock(layout, path.basename(layout.runRoot), requestFingerprint, observation, staleMs, signal)) continue;
      const remaining = timeoutMs - (monotonicMilliseconds() - startedAt);
      if (remaining <= 0) throw new Error("Pi agent-directory preparation lock acquisition timed out");
      await waitForDelay(Math.min(PREPARATION_LOCK_POLL_MS, remaining), signal);
      continue;
    }
    if (await hasCompletedMaterialization(layout)) return undefined;
    let created: PreparationLock | undefined;
    try { created = await tryCreatePreparationLock(layout, requestFingerprint, staleMs, signal); }
    catch (error) {
      if (!isTransientLockRace(error)) throw error;
    }
    if (created) return created;
    const remaining = timeoutMs - (monotonicMilliseconds() - startedAt);
    if (remaining <= 0) throw new Error("Pi agent-directory preparation lock acquisition timed out");
    await waitForDelay(Math.min(PREPARATION_LOCK_POLL_MS, remaining), signal);
  }
}

async function ensureBaseRunLayout(layout: MaterializationLayout): Promise<void> {
  await mkdir(layout.runtimeRoot, { recursive: true, mode: 0o755 });
  await ensureSecureDirectory(layout.runtimeRoot, "runtime root", false);
  try {
    await mkdir(layout.runRoot, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  await ensureSecureDirectory(layout.runRoot, "run runtime directory", true);
}

async function tryCreatePreparationLock(
  layout: MaterializationLayout,
  requestFingerprint: string,
  staleMs: number,
  signal?: AbortSignal,
): Promise<PreparationLock | undefined> {
  throwIfAborted(signal);
  const directory = path.join(layout.runRoot, PREPARATION_LOCK_DIRECTORY);
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (isAlreadyExists(error)) return undefined;
    throw error;
  }
  let directoryIdentity: DirectoryIdentity | undefined;
  try {
    const directoryInfo = await lstatRequired(directory, "Pi agent-directory preparation lock");
    assertPrivateDirectory(directoryInfo, "Pi agent-directory preparation lock");
    directoryIdentity = directoryIdentityOf(directoryInfo);
    await chmod(directory, 0o700);
  } catch (error) {
    await removeNewPreparationLock(directory, directoryIdentity).catch(() => undefined);
    if (isTransientLockRace(error)) return undefined;
    throw error;
  }
  const owner: PreparationLockOwner = {
    schemaVersion: PREPARATION_LOCK_SCHEMA_VERSION,
    kind: PREPARATION_LOCK_KIND,
    runId: path.basename(layout.runRoot),
    token: randomUUID(),
    pid: process.pid,
    createdAt: Date.now(),
    requestFingerprint,
  };
  let lock: PreparationLock | undefined;
  try {
    await writePrivateFileAtomically(path.join(directory, PREPARATION_LOCK_OWNER_FILE), serializePreparationOwner(owner), 0o600);
    await writePrivateFileAtomically(path.join(directory, PREPARATION_LOCK_HEARTBEAT_FILE), Buffer.from("heartbeat\n", "utf8"), 0o600);
    lock = new PreparationLock(directory, owner, path.join(directory, PREPARATION_LOCK_HEARTBEAT_FILE), directoryIdentity!, staleMs);
    await lock.assertHealthy();
    return lock;
  } catch (error) {
    if (lock) await lock.release().catch(() => undefined);
    else await removeNewPreparationLock(directory, directoryIdentity).catch(() => undefined);
    if (isTransientLockRace(error)) return undefined;
    throw error;
  }
}

async function inspectPreparationLock(
  layout: MaterializationLayout,
  runId: string,
  requestFingerprint: string,
  staleMs: number,
): Promise<PreparationLockObservation> {
  try { return await inspectPreparationLockOnce(layout, runId, requestFingerprint, staleMs); }
  catch (error) {
    // The lock is deliberately disposable. A controller may remove or
    // replace it after any one of these path checks; restart observation from
    // the directory rather than converting that normal race into a failure.
    if (isTransientLockRace(error)) return { state: "missing" };
    throw error;
  }
}

async function inspectPreparationLockOnce(
  layout: MaterializationLayout,
  runId: string,
  requestFingerprint: string,
  staleMs: number,
): Promise<PreparationLockObservation> {
  const directory = path.join(layout.runRoot, PREPARATION_LOCK_DIRECTORY);
  const kind = await pathKind(directory);
  if (kind === "missing") return { state: "missing" };
  if (kind !== "directory") throw new Error("Pi agent-directory preparation lock is not a private directory");
  const directoryInfo = await lstatRequired(directory, "Pi agent-directory preparation lock");
  assertPrivateDirectory(directoryInfo, "Pi agent-directory preparation lock");
  const directoryIdentity = directoryIdentityOf(directoryInfo);
  const ownerPath = path.join(directory, PREPARATION_LOCK_OWNER_FILE);
  const ownerKind = await pathKind(ownerPath);
  if (ownerKind === "missing") {
    await verifyPreparationLockEntries(directory, false, directoryIdentity);
    const finalOwnerKind = await pathKind(ownerPath);
    if (finalOwnerKind !== "missing") throw new PreparationLockRace("Pi agent-directory preparation lock owner appeared during observation");
    await assertStableDirectoryIdentity(directory, directoryIdentity, "Pi agent-directory preparation lock");
    const state = isStale(mtimeMilliseconds(directoryInfo), staleMs) ? "stale" : "active";
    return { state, directoryIdentity };
  }
  if (ownerKind !== "file") throw new Error("Pi agent-directory preparation lock owner is not a regular file");
  const ownerInfo = await lstatRequired(ownerPath, "Pi agent-directory preparation lock owner");
  assertPrivateFile(ownerInfo, "Pi agent-directory preparation lock owner");
  const owner = await readPreparationLockOwner(ownerPath);
  if (owner.runId !== runId) throw new Error("Pi agent-directory preparation lock belongs to a different run");
  await verifyPreparationLockEntries(directory, true, directoryIdentity);
  const finalOwner = await readPreparationLockOwner(ownerPath);
  if (!samePreparationLockOwner(finalOwner, owner)) {
    throw new PreparationLockRace("Pi agent-directory preparation lock owner changed during observation");
  }
  await assertStableDirectoryIdentity(directory, directoryIdentity, "Pi agent-directory preparation lock");
  const heartbeatPath = path.join(directory, PREPARATION_LOCK_HEARTBEAT_FILE);
  const heartbeatKind = await pathKind(heartbeatPath);
  let heartbeatMtime = mtimeMilliseconds(ownerInfo);
  if (heartbeatKind !== "missing") {
    if (heartbeatKind !== "file") throw new Error("Pi agent-directory preparation lock heartbeat is not a regular file");
    const heartbeatInfo = await lstatRequired(heartbeatPath, "Pi agent-directory preparation lock heartbeat");
    assertPrivateFile(heartbeatInfo, "Pi agent-directory preparation lock heartbeat");
    heartbeatMtime = mtimeMilliseconds(heartbeatInfo);
  }
  await assertStableDirectoryIdentity(directory, directoryIdentity, "Pi agent-directory preparation lock");
  if (owner.requestFingerprint !== requestFingerprint) return { state: "conflict", owner, directoryIdentity };
  if (!isStale(heartbeatMtime, staleMs) || isProcessAlive(owner.pid)) return { state: "active", owner, directoryIdentity };
  return { state: "stale", owner, directoryIdentity };
}

async function reclaimStalePreparationLock(
  layout: MaterializationLayout,
  runId: string,
  requestFingerprint: string,
  candidate: PreparationLockObservation,
  staleMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const lockDirectory = path.join(layout.runRoot, PREPARATION_LOCK_DIRECTORY);
  const reclaimDirectory = path.join(lockDirectory, PREPARATION_LOCK_RECLAIM_DIRECTORY);
  let reclaimOwner: PreparationReclaimOwner | undefined;
  let reclaimIdentity: DirectoryIdentity | undefined;
  let claimed = false;
  try {
    await mkdir(reclaimDirectory, { recursive: false, mode: 0o700 });
    claimed = true;
    const reclaimInfo = await lstatRequired(reclaimDirectory, "Pi agent-directory lock reclaim marker");
    assertPrivateDirectory(reclaimInfo, "Pi agent-directory lock reclaim marker");
    reclaimIdentity = directoryIdentityOf(reclaimInfo);
    await chmod(reclaimDirectory, 0o700);
    reclaimOwner = {
      schemaVersion: PREPARATION_LOCK_SCHEMA_VERSION,
      kind: PREPARATION_RECLAIM_KIND,
      token: randomUUID(),
      pid: process.pid,
      createdAt: Date.now(),
    };
    await writePrivateFileAtomically(path.join(reclaimDirectory, PREPARATION_LOCK_RECLAIM_OWNER_FILE), serializeReclaimOwner(reclaimOwner), 0o600);
  } catch (error) {
    if (claimed && reclaimIdentity) await removeDirectoryIfIdentity(reclaimDirectory, reclaimIdentity).catch(() => undefined);
    if (isTransientLockRace(error)) return false;
    if (claimed || !isAlreadyExists(error)) throw error;
    try { await reclaimStaleReclaimMarker(reclaimDirectory, staleMs); }
    catch (race) { if (!isTransientLockRace(race)) throw race; }
    return false;
  }
  try {
    throwIfAborted(signal);
    const latest = await inspectPreparationLock(layout, runId, requestFingerprint, staleMs);
    if (latest.state === "missing" || !latest.directoryIdentity) return false;
    // With no owner metadata the reclaimer itself changes the lock directory
    // mtime by creating .reclaim. Once the candidate was observed stale, an
    // owner-less lock is still the same crash window; a newly-created winner
    // would have authenticated owner metadata and fail this comparison.
    if (latest.state !== "stale" && (candidate.owner || latest.owner)) return false;
    const candidateToken = candidate.owner?.token;
    if (candidateToken !== latest.owner?.token) return false;
    if (candidate.directoryIdentity && !sameDirectoryIdentity(candidate.directoryIdentity, latest.directoryIdentity)) return false;
    await assertReclaimMarkerOwnership(reclaimDirectory, reclaimOwner!, reclaimIdentity!);
    await verifyPreparationLockEntries(lockDirectory, latest.owner !== undefined, latest.directoryIdentity);
    if (latest.owner) {
      const currentOwner = await readPreparationLockOwner(path.join(lockDirectory, PREPARATION_LOCK_OWNER_FILE));
      if (!samePreparationLockOwner(currentOwner, latest.owner)) {
        throw new PreparationLockRace("Pi agent-directory preparation lock owner changed before reclaim");
      }
    } else if (await pathKind(path.join(lockDirectory, PREPARATION_LOCK_OWNER_FILE)) !== "missing") {
      throw new PreparationLockRace("Pi agent-directory preparation lock owner appeared before reclaim");
    }
    await assertStableDirectoryIdentity(lockDirectory, latest.directoryIdentity, "Pi agent-directory preparation lock");
    await rm(lockDirectory, { recursive: true, force: false });
    return true;
  } catch (error) {
    if (isTransientLockRace(error)) return false;
    throw error;
  } finally {
    try {
      if (await pathKind(lockDirectory) === "directory") {
        await releaseReclaimMarker(reclaimDirectory, reclaimOwner, reclaimIdentity);
      }
    } catch (error) {
      if (!isTransientLockRace(error)) throw error;
    }
  }
}

async function reclaimStaleReclaimMarker(directory: string, staleMs: number): Promise<void> {
  const kind = await pathKind(directory);
  if (kind === "missing") return;
  if (kind !== "directory") throw new Error("Pi agent-directory lock reclaim marker is not a private directory");
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstatRequired(directory, "Pi agent-directory lock reclaim marker"); }
  catch (error) {
    if (isTransientLockRace(error)) return;
    throw error;
  }
  assertPrivateDirectory(info, "Pi agent-directory lock reclaim marker");
  const identity = directoryIdentityOf(info);
  const ownerPath = path.join(directory, PREPARATION_LOCK_RECLAIM_OWNER_FILE);
  const ownerKind = await pathKind(ownerPath);
  try { await verifyReclaimMarkerEntries(directory, ownerKind === "file", identity); }
  catch (error) {
    if (isTransientLockRace(error)) return;
    throw error;
  }
  if (ownerKind === "missing") {
    if (!isStale(mtimeMilliseconds(info), staleMs)) return;
    await removeDirectoryIfIdentity(directory, identity);
    return;
  }
  if (ownerKind !== "file") throw new Error("Pi agent-directory lock reclaim owner is not a regular file");
  const ownerInfo = await lstatRequired(ownerPath, "Pi agent-directory lock reclaim owner");
  assertPrivateFile(ownerInfo, "Pi agent-directory lock reclaim owner");
  const owner = await readReclaimOwner(ownerPath);
  await assertReclaimMarkerOwnership(directory, owner, identity);
  if (!isStale(mtimeMilliseconds(ownerInfo), staleMs) || isProcessAlive(owner.pid)) return;
  await removeDirectoryIfIdentity(directory, identity);
}

async function assertReclaimMarkerOwnership(
  directory: string,
  owner: PreparationReclaimOwner,
  expectedIdentity: DirectoryIdentity,
): Promise<void> {
  const info = await lstatRequired(directory, "Pi agent-directory lock reclaim marker");
  assertPrivateDirectory(info, "Pi agent-directory lock reclaim marker");
  if (!sameDirectoryIdentity(directoryIdentityOf(info), expectedIdentity)) {
    throw new PreparationLockRace("Pi agent-directory lock reclaim marker was replaced");
  }
  await verifyReclaimMarkerEntries(directory, true, expectedIdentity);
  const actual = await readReclaimOwner(path.join(directory, PREPARATION_LOCK_RECLAIM_OWNER_FILE));
  if (!sameReclaimOwner(actual, owner)) throw new Error("Pi agent-directory lock reclaim ownership changed");
  await assertStableDirectoryIdentity(directory, expectedIdentity, "Pi agent-directory lock reclaim marker");
}

async function releaseReclaimMarker(
  directory: string,
  owner: PreparationReclaimOwner | undefined,
  expectedIdentity?: DirectoryIdentity,
): Promise<void> {
  if (!owner) return;
  let lastRace: unknown;
  for (let attempt = 0; attempt < PREPARATION_LOCK_RACE_RETRIES; attempt += 1) {
    try {
      const kind = await pathKind(directory);
      if (kind === "missing") return;
      if (kind !== "directory") throw new Error("Pi agent-directory lock reclaim marker was replaced");
      const info = await lstatRequired(directory, "Pi agent-directory lock reclaim marker");
      assertPrivateDirectory(info, "Pi agent-directory lock reclaim marker");
      const identity = directoryIdentityOf(info);
      if (expectedIdentity && !sameDirectoryIdentity(identity, expectedIdentity)) {
        throw new Error("Pi agent-directory lock reclaim marker was replaced");
      }
      await assertReclaimMarkerOwnership(directory, owner, identity);
      await assertStableDirectoryIdentity(directory, identity, "Pi agent-directory lock reclaim marker");
      await rm(directory, { recursive: true, force: false });
      return;
    } catch (error) {
      if (!isTransientLockRace(error)) throw error;
      lastRace = error;
      if (await pathKind(directory) === "missing") return;
      if (attempt + 1 < PREPARATION_LOCK_RACE_RETRIES) await waitForDelay(PREPARATION_LOCK_RACE_DELAY_MS);
    }
  }
  throw lastRace instanceof Error ? lastRace : new Error("Pi agent-directory lock reclaim release raced with replacement");
}

type PreparationLockRequirement = "required" | "optional" | "forbidden";

async function hasCompletedMaterialization(layout: MaterializationLayout): Promise<boolean> {
  const [agent, home, wikiHome] = await Promise.all([
    pathKind(layout.agentDir),
    pathKind(layout.homeDir),
    pathKind(layout.wikiHomeDir),
  ]);
  return agent === "directory" && home === "directory" && wikiHome === "directory";
}

async function ensureRunLayout(layout: MaterializationLayout, signal?: AbortSignal): Promise<void> {
  await ensurePrivateDirectory(layout.homeDir, "run-scoped HOME");
  await ensurePrivateDirectory(layout.wikiHomeDir, "run-scoped WIKI_HOME");
  await verifyNoSymlinksBelow(layout.homeDir, "run-scoped HOME");
  await verifyNoSymlinksBelow(layout.wikiHomeDir, "run-scoped WIKI_HOME");
  throwIfAborted(signal);
  const agentKind = await pathKind(layout.agentDir);
  if (agentKind === "symlink") throw new Error("Pi agent directory may not be symlinked");
  if (agentKind !== "missing" && agentKind !== "directory") throw new Error("Pi agent directory is not a regular directory");
  await verifyRunRootChildren(layout, agentKind === "directory", "required");
}

async function verifyRunLayout(
  layout: MaterializationLayout,
  agentMustExist = true,
  allowPreparationLock: boolean | "optional" = false,
): Promise<void> {
  await ensureSecureDirectory(layout.runtimeRoot, "runtime root", false);
  await ensureSecureDirectory(layout.runRoot, "run runtime directory", true);
  await ensureSecureDirectory(layout.homeDir, "run-scoped HOME", true);
  await ensureSecureDirectory(layout.wikiHomeDir, "run-scoped WIKI_HOME", true);
  await verifyNoSymlinksBelow(layout.homeDir, "run-scoped HOME");
  await verifyNoSymlinksBelow(layout.wikiHomeDir, "run-scoped WIKI_HOME");
  const lockRequirement: PreparationLockRequirement = allowPreparationLock === "optional"
    ? "optional"
    : allowPreparationLock ? "required" : "forbidden";
  await verifyRunRootChildren(layout, agentMustExist, lockRequirement);
  if (agentMustExist) await ensureSecureDirectory(layout.agentDir, "Pi agent directory", true);
}

async function verifyRunRootChildren(
  layout: MaterializationLayout,
  agentMustExist: boolean,
  lockRequirement: PreparationLockRequirement,
): Promise<void> {
  const required = new Set(["home", "wiki-home", ...(agentMustExist ? ["pi-agent"] : [])]);
  const allowed = new Set(required);
  if (lockRequirement !== "forbidden") allowed.add(PREPARATION_LOCK_DIRECTORY);
  const entries = await readdir(layout.runRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory() || !allowed.has(entry.name)) {
      throw new Error("Pi run directory contains unexpected or partial content");
    }
    if (entry.name === PREPARATION_LOCK_DIRECTORY) {
      try {
        const info = await lstatRequired(path.join(layout.runRoot, entry.name), "Pi agent-directory preparation lock");
        assertPrivateDirectory(info, "Pi agent-directory preparation lock");
      } catch (error) {
        if (lockRequirement !== "optional" || !isTransientLockRace(error)) throw error;
      }
    }
  }
  for (const name of required) {
    if (!entries.some(entry => entry.name === name)) throw new Error("Pi run directory contains unexpected or partial content");
  }
  if (lockRequirement === "required" && !entries.some(entry => entry.name === PREPARATION_LOCK_DIRECTORY)) {
    throw new Error("Pi run directory contains unexpected or partial content");
  }
}

async function writePrivateFileAtomically(target: string, bytes: Buffer, mode: number): Promise<void> {
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode });
    await chmod(temporary, mode);
    await rename(temporary, target);
  } finally {
    if (await pathKind(temporary) !== "missing") await rm(temporary, { force: true });
  }
}

function serializePreparationOwner(owner: PreparationLockOwner): Buffer {
  return Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
}

function serializeReclaimOwner(owner: PreparationReclaimOwner): Buffer {
  return Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
}

async function readPreparationLockOwner(file: string): Promise<PreparationLockOwner> {
  let bytes: Buffer;
  try { bytes = await readStableFile(file, "Pi agent-directory preparation lock owner"); }
  catch (error) { throw withFilesystemContext(`Pi agent-directory preparation lock owner is unreadable: ${error instanceof Error ? error.message : String(error)}`, error); }
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Pi agent-directory preparation lock owner is not valid JSON"); }
  if (!isPreparationLockOwner(value)) throw new Error("Pi agent-directory preparation lock owner is invalid");
  return value;
}

async function readReclaimOwner(file: string): Promise<PreparationReclaimOwner> {
  let bytes: Buffer;
  try { bytes = await readStableFile(file, "Pi agent-directory lock reclaim owner"); }
  catch (error) { throw withFilesystemContext(`Pi agent-directory lock reclaim owner is unreadable: ${error instanceof Error ? error.message : String(error)}`, error); }
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Pi agent-directory lock reclaim owner is not valid JSON"); }
  if (!isPreparationReclaimOwner(value)) throw new Error("Pi agent-directory lock reclaim owner is invalid");
  return value;
}

function isPreparationLockOwner(value: unknown): value is PreparationLockOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join("\\0") !== ["createdAt", "kind", "pid", "requestFingerprint", "runId", "schemaVersion", "token"].join("\\0")) return false;
  return candidate["schemaVersion"] === PREPARATION_LOCK_SCHEMA_VERSION
    && candidate["kind"] === PREPARATION_LOCK_KIND
    && typeof candidate["runId"] === "string" && RUN_ID.test(candidate["runId"])
    && typeof candidate["token"] === "string" && UUID.test(candidate["token"])
    && typeof candidate["pid"] === "number" && Number.isInteger(candidate["pid"]) && candidate["pid"] > 0
    && typeof candidate["createdAt"] === "number" && Number.isSafeInteger(candidate["createdAt"]) && candidate["createdAt"] > 0
    && typeof candidate["requestFingerprint"] === "string" && SHA256.test(candidate["requestFingerprint"]);
}

function isPreparationReclaimOwner(value: unknown): value is PreparationReclaimOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join("\\0") !== ["createdAt", "kind", "pid", "schemaVersion", "token"].join("\\0")) return false;
  return candidate["schemaVersion"] === PREPARATION_LOCK_SCHEMA_VERSION
    && candidate["kind"] === PREPARATION_RECLAIM_KIND
    && typeof candidate["token"] === "string" && UUID.test(candidate["token"])
    && typeof candidate["pid"] === "number" && Number.isInteger(candidate["pid"]) && candidate["pid"] > 0
    && typeof candidate["createdAt"] === "number" && Number.isSafeInteger(candidate["createdAt"]) && candidate["createdAt"] > 0;
}

async function verifyPreparationLock(
  directory: string,
  expected: PreparationLockOwner,
  requireHeartbeat: boolean,
  expectedIdentity?: DirectoryIdentity,
): Promise<void> {
  const info = await lstatRequired(directory, "Pi agent-directory preparation lock");
  assertPrivateDirectory(info, "Pi agent-directory preparation lock");
  const identity = directoryIdentityOf(info);
  if (expectedIdentity && !sameDirectoryIdentity(identity, expectedIdentity)) {
    throw new PreparationLockRace("Pi agent-directory preparation lock was replaced");
  }
  const actual = await readPreparationLockOwner(path.join(directory, PREPARATION_LOCK_OWNER_FILE));
  if (!samePreparationLockOwner(actual, expected)) throw new Error("Pi agent-directory preparation lock ownership changed");
  await verifyPreparationLockEntries(directory, true, identity);
  const heartbeatPath = path.join(directory, PREPARATION_LOCK_HEARTBEAT_FILE);
  const heartbeatKind = await pathKind(heartbeatPath);
  if (heartbeatKind === "missing") {
    if (requireHeartbeat) throw new Error("Pi agent-directory preparation lock heartbeat is missing");
  } else {
    if (heartbeatKind !== "file") throw new Error("Pi agent-directory preparation lock heartbeat is not a regular file");
    const heartbeatInfo = await lstatRequired(heartbeatPath, "Pi agent-directory preparation lock heartbeat");
    assertPrivateFile(heartbeatInfo, "Pi agent-directory preparation lock heartbeat");
  }
  const reclaimKind = await pathKind(path.join(directory, PREPARATION_LOCK_RECLAIM_DIRECTORY));
  if (reclaimKind !== "missing") throw new Error("Pi agent-directory preparation lock is being reclaimed");
  const finalInfo = await lstatRequired(directory, "Pi agent-directory preparation lock");
  assertPrivateDirectory(finalInfo, "Pi agent-directory preparation lock");
  if (!sameDirectoryIdentity(directoryIdentityOf(finalInfo), identity)) {
    throw new PreparationLockRace("Pi agent-directory preparation lock changed during verification");
  }
  const finalOwner = await readPreparationLockOwner(path.join(directory, PREPARATION_LOCK_OWNER_FILE));
  if (!samePreparationLockOwner(finalOwner, expected)) throw new Error("Pi agent-directory preparation lock ownership changed");
  await assertStableDirectoryIdentity(directory, identity, "Pi agent-directory preparation lock");
}

async function verifyPreparationLockEntries(
  directory: string,
  ownerPresent: boolean,
  expectedIdentity?: DirectoryIdentity,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("Pi agent-directory preparation lock contains a symlink");
    if (entry.name === PREPARATION_LOCK_OWNER_FILE || entry.name === PREPARATION_LOCK_HEARTBEAT_FILE) {
      if (!entry.isFile()) throw new Error("Pi agent-directory preparation lock contains an invalid metadata entry");
      try {
        const info = await lstat(path.join(directory, entry.name));
        assertPrivateFile(info, "Pi agent-directory preparation lock metadata");
      } catch (error) {
        if (!isTransientLockRace(error)) throw error;
      }
      continue;
    }
    if (entry.name === "staging") {
      if (!entry.isDirectory()) throw new Error("Pi agent-directory preparation staging is not a private directory");
      try {
        const info = await lstat(path.join(directory, entry.name));
        assertPrivateDirectory(info, "Pi agent-directory preparation staging");
      } catch (error) {
        if (!isTransientLockRace(error)) throw error;
      }
      continue;
    }
    if (entry.name === PREPARATION_LOCK_RECLAIM_DIRECTORY) {
      if (!entry.isDirectory()) throw new Error("Pi agent-directory lock reclaim marker is not a private directory");
      const marker = path.join(directory, entry.name);
      let info: Awaited<ReturnType<typeof lstat>>;
      try { info = await lstat(marker); }
      catch (error) {
        if (isTransientLockRace(error)) throw new PreparationLockRace("Pi agent-directory lock reclaim marker disappeared during enumeration", error);
        throw error;
      }
      assertPrivateDirectory(info, "Pi agent-directory lock reclaim marker");
      const ownerKind = await pathKind(path.join(marker, PREPARATION_LOCK_RECLAIM_OWNER_FILE));
      await verifyReclaimMarkerEntries(marker, ownerKind === "file", directoryIdentityOf(info));
      continue;
    }
    if ((!ownerPresent && PREPARATION_LOCK_OWNER_TEMP.test(entry.name)) || PREPARATION_LOCK_HEARTBEAT_TEMP.test(entry.name)) {
      if (!entry.isFile()) throw new Error("Pi agent-directory preparation lock contains an invalid metadata temporary entry");
      try {
        const info = await lstat(path.join(directory, entry.name));
        assertPrivateFile(info, "Pi agent-directory preparation lock metadata temporary entry");
      } catch (error) {
        if (!isTransientLockRace(error)) throw error;
      }
      continue;
    }
    throw new Error("Pi agent-directory preparation lock contains unexpected content");
  }
  if (expectedIdentity) await assertStableDirectoryIdentity(directory, expectedIdentity, "Pi agent-directory preparation lock");
}

async function verifyReclaimMarkerEntries(
  directory: string,
  ownerPresent: boolean,
  expectedIdentity?: DirectoryIdentity,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Pi agent-directory lock reclaim marker contains invalid content");
    if (entry.name === PREPARATION_LOCK_RECLAIM_OWNER_FILE) continue;
    if (!ownerPresent && PREPARATION_RECLAIM_OWNER_TEMP.test(entry.name)) continue;
    throw new Error("Pi agent-directory lock reclaim marker contains unexpected content");
  }
  if (expectedIdentity) await assertStableDirectoryIdentity(directory, expectedIdentity, "Pi agent-directory lock reclaim marker");
}

function samePreparationLockOwner(left: PreparationLockOwner, right: PreparationLockOwner): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.kind === right.kind
    && left.runId === right.runId
    && left.token === right.token
    && left.pid === right.pid
    && left.createdAt === right.createdAt
    && left.requestFingerprint === right.requestFingerprint;
}

function sameReclaimOwner(left: PreparationReclaimOwner, right: PreparationReclaimOwner): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.kind === right.kind
    && left.token === right.token
    && left.pid === right.pid
    && left.createdAt === right.createdAt;
}

async function removeNewPreparationLock(directory: string, expectedIdentity?: DirectoryIdentity): Promise<void> {
  if (!expectedIdentity) return;
  await removeDirectoryIfIdentity(directory, expectedIdentity);
}

function directoryIdentityOf(info: Awaited<ReturnType<typeof lstat>>): DirectoryIdentity {
  return { dev: info.dev, ino: info.ino };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertStableDirectoryIdentity(directory: string, expected: DirectoryIdentity, name: string): Promise<void> {
  const info = await lstatRequired(directory, name);
  assertPrivateDirectory(info, name);
  if (!sameDirectoryIdentity(directoryIdentityOf(info), expected)) {
    throw new PreparationLockRace(`${name} was replaced during an operation`);
  }
}

async function removeDirectoryIfIdentity(directory: string, expected: DirectoryIdentity): Promise<void> {
  const kind = await pathKind(directory);
  if (kind === "missing") return;
  if (kind !== "directory") throw new Error("Pi agent-directory lock directory was replaced");
  const info = await lstatRequired(directory, "Pi agent-directory lock directory");
  assertPrivateDirectory(info, "Pi agent-directory lock directory");
  if (!sameDirectoryIdentity(directoryIdentityOf(info), expected)) {
    throw new PreparationLockRace("Pi agent-directory lock directory was replaced");
  }
  await rm(directory, { recursive: true, force: false });
}

function monotonicMilliseconds(): number { return Number(process.hrtime.bigint()) / 1_000_000; }
function mtimeMilliseconds(info: Awaited<ReturnType<typeof lstat>>): number {
  return typeof info.mtimeMs === "bigint" ? Number(info.mtimeMs) : info.mtimeMs;
}
function isStale(mtimeMs: number, staleMs: number): boolean { return Number.isFinite(mtimeMs) && Date.now() - mtimeMs > staleMs; }
function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !error || (typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EPERM"); }
}

async function waitForDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Pi agent-directory preparation lock wait aborted"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
  let created = false;
  try {
    await mkdir(value, { recursive: false, mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  if (created) await chmod(value, 0o700);
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

function materializationFingerprint(prepared: PreparedMaterialization): string {
  return sha256(Buffer.from(`${sha256(serializeManifest(prepared.expected))}\\0${prepared.layout.workspace}`, "utf8"));
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
    if (isNotFound(error)) throw withFilesystemContext(`${name} is missing`, error);
    throw error;
  }
}

function withFilesystemContext(message: string, error: unknown): Error {
  const wrapped = new Error(message, { cause: error });
  if (error && typeof error === "object") {
    for (const property of ["code", "errno", "syscall", "path"] as const) {
      if (property in error) Object.defineProperty(wrapped, property, { value: (error as Record<string, unknown>)[property] });
    }
  }
  return wrapped;
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
function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
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
function isAlreadyExists(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST"); }
function isTransientLockRace(error: unknown): boolean {
  return error instanceof PreparationLockRace
    || isNotFound(error)
    || Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOTDIR");
}
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Pi agent-directory materialization aborted"); }
