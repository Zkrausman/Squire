import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, lutimes, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
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
const PREPARATION_QUARANTINE_PREFIX = ".pi-agent-quarantine-";
const PREPARATION_RETAINED_DIRECTORY = ".pi-agent-quarantine-retained";
const PREPARATION_RETAINED_PREFIX = "capture-";
const PREPARATION_RETAINED_RECORD_SUFFIX = ".json";
const PREPARATION_RETAINED_AUTH_FILE = ".capture-auth-key";
const PREPARATION_RETAINED_ALLOCATION_LOCK = ".allocation-lock";
const PREPARATION_RETAINED_ALLOCATION_HELD = /^\.allocation-lock-held-[0-9a-f-]{36}$/u;
const PREPARATION_RETAINED_ALLOCATION_OWNER_FILE = "owner.json";
const PREPARATION_RETAINED_ALLOCATION_ROOT_MARKER = ".allocation-lock-root";
const PREPARATION_RETAINED_ALLOCATION_ROOT_MARKER_BYTES = Buffer.from("squire-pi-agent-retention-root-v1\n", "utf8");
const PREPARATION_RETAINED_ALLOCATION_KIND = "squire-pi-agent-retention-allocation-lock";
const PREPARATION_CAPTURE_METADATA_FILE = "capture.json";
const PREPARATION_RETAINED_RECORD_KIND = "squire-pi-agent-retained-capture";
const PREPARATION_RETAINED_SCHEMA_VERSION = 1;
const PREPARATION_RETAINED_PER_RUN_LIMIT = 32;
const PREPARATION_RETAINED_GLOBAL_LIMIT = 256;
const PREPARATION_CAPTURE_TYPES = ["preparation-lock", "reclaim-marker", "staging", "private-temporary-file", "quarantine-fence"] as const;
const PREPARATION_CAPTURE_TYPE = new Set<string>(PREPARATION_CAPTURE_TYPES);
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
const PREPARATION_QUARANTINE = /^\.pi-agent-quarantine-[0-9a-f-]{36}$/u;
const PREPARATION_RECLAIM_OWNER_TEMP = /^owner\.json\.tmp-[0-9a-f-]{36}$/u;
const PREPARATION_RETAINED_CAPTURE = /^capture-([0-9a-f-]{36})$/u;
const PREPARATION_RETAINED_RECORD = /^capture-([0-9a-f-]{36})\.json$/u;
const PREPARATION_RETAINED_RUN = RUN_ID;
const SHA256_HMAC = /^[0-9a-f]{64}$/u;

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
  /** Destructively remove retained captures only after trusted quiescence. */
  teardown?(runId: string, signal?: AbortSignal): Promise<PiAgentDirectoryTeardownResult>;
}

/** Exact capability evidence returned by the trusted runtime/model registry. */
export type WikiModelCapability = RuntimeModelCapability;

/** Internal synchronization seam used by deterministic filesystem-race tests. */
export type PreparationCaptureBarrier = (event: {
  source: string;
  quarantine: string;
  name: string;
}) => void | Promise<void>;

export type RetainedCaptureType = (typeof PREPARATION_CAPTURE_TYPES)[number];

/** A trusted controller callback. It must prove that every role process and
 * every controller that can touch this run has quiesced before teardown. */
export type PiAgentDirectoryTeardownGuard = (runId: string, signal?: AbortSignal) => void | Promise<void>;

export interface PiAgentDirectoryTeardownResult {
  runId: string;
  capturesRemoved: number;
  fencesRemoved: number;
}

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
  /** Internal deterministic synchronization seam; omitted in production. */
  preparationCaptureBarrier?: PreparationCaptureBarrier;
  /** Maximum retained capture records for one run. */
  maxRetainedCapturesPerRun?: number;
  /** Maximum retained capture records across this runtime root. */
  maxRetainedCapturesGlobal?: number;
  /** Required authority for destructive retained-state teardown. */
  assertTeardownQuiescent?: PiAgentDirectoryTeardownGuard;
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
  state: "missing" | "active" | "stale" | "conflict" | "capturing";
  owner?: PreparationLockOwner;
  directoryIdentity?: DirectoryIdentity;
}

interface RetentionLimits {
  perRun: number;
  global: number;
}

interface RetainedCaptureAllocation {
  captureId: string;
  retainedPath: string;
  recordPath: string;
}

interface RetentionAllocationOwner {
  schemaVersion: 1;
  kind: typeof PREPARATION_RETAINED_ALLOCATION_KIND;
  state: "free" | "held";
  runId: string;
  token: string;
  pid: number;
  createdAt: number;
}

interface RetentionAllocationLease {
  heldPath: string;
  directoryIdentity: DirectoryIdentity;
  owner: RetentionAllocationOwner;
}

interface RetainedCaptureRecordPayload {
  schemaVersion: 1;
  kind: typeof PREPARATION_RETAINED_RECORD_KIND;
  runId: string;
  captureId: string;
  source: string;
  type: RetainedCaptureType;
  objectKind: "directory" | "file";
  identity: { dev: string; ino: string };
  capturedIdentity: { dev: string; ino: string };
  quarantinePath: string;
  retainedPath: string;
  ownerPid: number;
  createdAt: number;
  state: "retained" | "fence";
}

interface RetainedCaptureRecord extends RetainedCaptureRecordPayload {
  auth: string;
}

interface RetainedFenceMetadata extends RetainedCaptureRecord {
  fenceIdentity: { dev: string; ino: string };
}

interface RetainedCaptureLocation {
  runtimeRoot: string;
  retainedRoot: string;
  retainedRun: string;
}

class PreparationLockRace extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PreparationLockRace";
  }
}

class PreparationCaptureInProgress extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparationCaptureInProgress";
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
    readonly captureBarrier: PreparationCaptureBarrier | undefined,
    readonly retentionLimits: RetentionLimits,
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
    if (await hasPreparationQuarantineRoot(path.dirname(this.directory))) {
      throw new PreparationCaptureInProgress("Pi agent-directory preparation capture is in progress");
    }
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
        await captureAndRetainDirectory(
          this.directory,
          path.dirname(this.directory),
          this.directoryIdentity,
          "Pi agent-directory preparation lock",
          captured => verifyCapturedPreparationLock(captured, this.directoryIdentity, this.owner),
          this.captureBarrier,
          this.retentionLimits,
          "preparation-lock",
        );
        return;
      } catch (error) {
        if (error instanceof PreparationLockRace) throw error;
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
  readonly #retentionLimits: RetentionLimits;
  readonly #inFlight = new Map<string, { fingerprint: string; promise: Promise<MaterializedPiAgentDirectory> }>();

  constructor(options: PiAgentDirectoryMaterializerOptions = {}) {
    this.#options = options;
    this.#retentionLimits = retentionLimits(options);
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

  /**
   * Remove only this run's retained capture ledger after the trusted
   * controller has proved that all role processes and preparation contenders
   * are quiescent. There is intentionally no unguarded cleanup method: the
   * retained namespace is the safety valve for pathname replacement races.
   */
  async teardown(runId: string, signal?: AbortSignal): Promise<PiAgentDirectoryTeardownResult> {
    assertRunId(runId);
    const guard = this.#options.assertTeardownQuiescent;
    if (!guard) throw new Error("trusted Pi agent-directory teardown requires a quiescence guard");
    throwIfAborted(signal);
    const runtimeRoot = absoluteDirectory(this.#options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, "runtime root");
    const runRoot = path.resolve(runtimeRoot, runId);
    await rejectSymlinkedAncestors(runtimeRoot, "runtime root");
    const runKind = await pathKind(runRoot);
    if (runKind === "missing") {
      await guard(runId, signal);
      const capturesRemoved = await removeRetainedCapturesAfterQuiescence(runtimeRoot, runId, this.#retentionLimits, signal, guard);
      return { runId, capturesRemoved, fencesRemoved: 0 };
    }
    if (runKind !== "directory") throw new Error("run runtime path is not a directory");
    await ensureSecureDirectory(runtimeRoot, "runtime root", false);
    await ensureSecureDirectory(runRoot, "run runtime directory", true);
    if (this.#inFlight.has(runId)) throw new Error("Pi agent-directory teardown cannot run during materialization");
    await guard(runId, signal);
    const staleMs = positiveInteger(this.#options.preparationLockStaleMs ?? PREPARATION_LOCK_STALE_MS, "preparation lock stale timeout");
    const fencesRemoved = await reconcilePreparationLifecycle(runRoot, this.#retentionLimits, staleMs, signal, true);
    await removeLivePreparationLockAfterQuiescence(runRoot, runId, signal, guard);
    await assertNoLivePreparationState(runRoot);
    const capturesRemoved = await removeRetainedCapturesAfterQuiescence(runtimeRoot, runId, this.#retentionLimits, signal, guard);
    await guard(runId, signal);
    await assertNoLivePreparationState(runRoot);
    return { runId, capturesRemoved, fencesRemoved };
  }

  async #materialize(request: PiAgentDirectoryRequest, profile: PiModelProfile): Promise<MaterializedPiAgentDirectory> {
    const prepared = await this.#prepare(request, profile);
    await reconcilePreparationLifecycle(
      prepared.layout.runRoot,
      this.#retentionLimits,
      positiveInteger(this.#options.preparationLockStaleMs ?? PREPARATION_LOCK_STALE_MS, "preparation lock stale timeout"),
      request.signal,
    );
    const requestFingerprint = materializationFingerprint(prepared);
    for (;;) {
      const lock = await acquirePreparationLock(
        prepared.layout,
        requestFingerprint,
        this.#options,
        this.#retentionLimits,
        request.signal,
      );
      if (!lock) {
        try {
          await verifyCompletedMaterializationLock(prepared.layout, request.runId, requestFingerprint, this.#options, this.#retentionLimits, request.signal);
          await verifyRunLayout(prepared.layout, true, "optional");
          await verifyAgentDirectory(prepared.layout.agentDir, prepared.expected, prepared.entries.map(entry => entry.path));
          return materializedResult(request.runId, prepared);
        } catch (error) {
          if (!(error instanceof PreparationCaptureInProgress)) throw error;
          await waitForDelay(PREPARATION_LOCK_RACE_DELAY_MS, request.signal);
          continue;
        }
      }
      let retry = false;
      try {
        await lock.assertHealthy();
        await ensureRunLayout(prepared.layout, request.signal);
        await lock.assertHealthy();
        await this.#createOrVerify(prepared, lock, request.signal);
        await lock.assertHealthy();
        await verifyRunLayout(prepared.layout, true, true);
        return materializedResult(request.runId, prepared);
      } catch (error) {
        if (!(error instanceof PreparationCaptureInProgress)) throw error;
        retry = true;
      } finally {
        await lock.release();
      }
      if (retry) {
        await waitForDelay(PREPARATION_LOCK_RACE_DELAY_MS, request.signal);
      }
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
    await reconcilePreparationLifecycle(
      prepared.layout.runRoot,
      this.#retentionLimits,
      positiveInteger(this.#options.preparationLockStaleMs ?? PREPARATION_LOCK_STALE_MS, "preparation lock stale timeout"),
      request.signal,
    );
    const requestFingerprint = materializationFingerprint(prepared);
    const lock = await acquirePreparationLock(
      prepared.layout,
      requestFingerprint,
      this.#options,
      this.#retentionLimits,
      request.signal,
    );
    const expected = materializedResult(request.runId, prepared);
    if (!lock) {
      await verifyCompletedMaterializationLock(prepared.layout, request.runId, requestFingerprint, this.#options, this.#retentionLimits, request.signal);
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
    let stagingIdentity: DirectoryIdentity | undefined;
    try {
      const stagingInfo = await lstatRequired(staging, "Pi agent preparation staging directory");
      assertPrivateDirectory(stagingInfo, "Pi agent preparation staging directory");
      stagingIdentity = directoryIdentityOf(stagingInfo);
      await chmod(staging, 0o700);
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
      if (stagingIdentity) {
        await captureAndRetainDirectory(
          staging,
          path.dirname(lock.directory),
          stagingIdentity,
          "Pi agent preparation staging directory",
          quarantine => verifyCapturedStagingDirectory(quarantine, stagingIdentity!, entries),
          lock.captureBarrier,
          lock.retentionLimits,
          "staging",
        );
      }
    }
  }
}

/** Return the process-wide default materializer so concurrent role runners share one single-flight map. */
export function createDefaultPiAgentDirectoryMaterializer(
  workspace?: string,
  assertTeardownQuiescent?: PiAgentDirectoryTeardownGuard,
): PiAgentDirectoryMaterializer {
  const key = path.resolve(workspace ?? DEFAULT_WORKSPACE);
  const existing = DEFAULT_MATERIALIZERS.get(key);
  if (existing) return existing;
  const created = new PiAgentDirectoryMaterializer({
    ...(workspace ? { workspace } : {}),
    ...(assertTeardownQuiescent ? { assertTeardownQuiescent } : {}),
  });
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
  limits: RetentionLimits,
  signal?: AbortSignal,
): Promise<void> {
  const timeoutMs = positiveInteger(options.preparationLockTimeoutMs ?? PREPARATION_LOCK_TIMEOUT_MS, "preparation lock timeout");
  const staleMs = positiveInteger(options.preparationLockStaleMs ?? PREPARATION_LOCK_STALE_MS, "preparation lock stale timeout");
  const startedAt = monotonicMilliseconds();
  for (;;) {
    throwIfAborted(signal);
    const observation = await inspectPreparationLock(layout, runId, requestFingerprint, staleMs);
    if (observation.state === "conflict") throw new Error("conflicting Pi agent-directory preparation request");
    if (observation.state === "capturing") {
      const remaining = timeoutMs - (monotonicMilliseconds() - startedAt);
      if (remaining <= 0) throw new Error("completed Pi agent-directory materialization has a stale preparation lock");
      await waitForDelay(Math.min(PREPARATION_LOCK_POLL_MS, remaining), signal);
      continue;
    }
    if (observation.state === "stale") {
      if (await reclaimStalePreparationLock(layout, runId, requestFingerprint, observation, staleMs, options.preparationCaptureBarrier, limits, signal)) continue;
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
  limits: RetentionLimits,
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
    if (observation.state === "capturing") {
      const remaining = timeoutMs - (monotonicMilliseconds() - startedAt);
      if (remaining <= 0) throw new Error("Pi agent-directory preparation lock acquisition timed out");
      await waitForDelay(Math.min(PREPARATION_LOCK_POLL_MS, remaining), signal);
      continue;
    }
    if (observation.state === "stale") {
      if (await reclaimStalePreparationLock(layout, path.basename(layout.runRoot), requestFingerprint, observation, staleMs, options.preparationCaptureBarrier, limits, signal)) continue;
      const remaining = timeoutMs - (monotonicMilliseconds() - startedAt);
      if (remaining <= 0) throw new Error("Pi agent-directory preparation lock acquisition timed out");
      await waitForDelay(Math.min(PREPARATION_LOCK_POLL_MS, remaining), signal);
      continue;
    }
    if (await hasCompletedMaterialization(layout)) return undefined;
    let created: PreparationLock | undefined;
    try { created = await tryCreatePreparationLock(layout, requestFingerprint, staleMs, options.preparationCaptureBarrier, limits, signal); }
    catch (error) {
      if (error instanceof PreparationLockRace) throw error;
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
  captureBarrier: PreparationCaptureBarrier | undefined,
  limits: RetentionLimits,
  signal?: AbortSignal,
): Promise<PreparationLock | undefined> {
  throwIfAborted(signal);
  if (await hasPreparationQuarantine(layout)) return undefined;
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
    await removeNewPreparationLock(directory, directoryIdentity, undefined, limits, captureBarrier);
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
    await writePrivateFileAtomically(path.join(directory, PREPARATION_LOCK_OWNER_FILE), serializePreparationOwner(owner), 0o600, path.dirname(directory), limits);
    await writePrivateFileAtomically(path.join(directory, PREPARATION_LOCK_HEARTBEAT_FILE), Buffer.from("heartbeat\n", "utf8"), 0o600, path.dirname(directory), limits);
    lock = new PreparationLock(directory, owner, path.join(directory, PREPARATION_LOCK_HEARTBEAT_FILE), directoryIdentity!, staleMs, captureBarrier, limits);
    await lock.assertHealthy();
    return lock;
  } catch (error) {
    if (lock) await lock.release();
    else await removeNewPreparationLock(directory, directoryIdentity, owner, limits, captureBarrier);
    if (isTransientLockRace(error)) return undefined;
    throw error;
  }
}

async function hasPreparationQuarantineRoot(runRoot: string): Promise<boolean> {
  const entries = await readdir(runRoot, { withFileTypes: true });
  let found = false;
  for (const entry of entries) {
    if (!entry.name.startsWith(PREPARATION_QUARANTINE_PREFIX)) continue;
    if (!PREPARATION_QUARANTINE.test(entry.name)) throw new Error("Pi agent-directory quarantine has an invalid name");
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Pi agent-directory quarantine is not a private directory");
    const quarantine = path.join(runRoot, entry.name);
    let info: Awaited<ReturnType<typeof lstat>>;
    try { info = await lstatRequired(quarantine, "Pi agent-directory quarantine"); }
    catch (error) {
      if (isTransientLockRace(error) || isNotFound(error)) continue;
      throw error;
    }
    assertPrivateDirectory(info, "Pi agent-directory quarantine");
    const captured = await findRetainedRecordForQuarantine(runRoot, quarantine);
    if (captured.record.objectKind !== "directory") throw new Error("Pi agent-directory quarantine metadata has an invalid object kind");
    if (captured.record.state !== "fence" && !sameIdentityRecord(captured.record.capturedIdentity, directoryIdentityOf(info))) {
      throw new PreparationLockRace("Pi agent-directory quarantine was replaced");
    }
    await verifyFenceMetadata(quarantine, captured.record);
    found = true;
  }
  return found;
}

async function hasPreparationQuarantine(layout: MaterializationLayout): Promise<boolean> {
  return hasPreparationQuarantineRoot(layout.runRoot);
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
  if (await hasPreparationQuarantine(layout)) return { state: "capturing" };
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
  captureBarrier: PreparationCaptureBarrier | undefined,
  limits: RetentionLimits,
  signal?: AbortSignal,
): Promise<boolean> {
  const lockDirectory = path.join(layout.runRoot, PREPARATION_LOCK_DIRECTORY);
  const reclaimDirectory = path.join(lockDirectory, PREPARATION_LOCK_RECLAIM_DIRECTORY);
  let reclaimOwner: PreparationReclaimOwner | undefined;
  let reclaimOwnerWritten = false;
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
    await writePrivateFileAtomically(path.join(reclaimDirectory, PREPARATION_LOCK_RECLAIM_OWNER_FILE), serializeReclaimOwner(reclaimOwner), 0o600, path.resolve(reclaimDirectory, "..", ".."), limits);
    reclaimOwnerWritten = true;
  } catch (error) {
    if (claimed && reclaimIdentity) {
      await captureAndRetainDirectory(
        reclaimDirectory,
        path.resolve(reclaimDirectory, "..", ".."),
        reclaimIdentity,
        "Pi agent-directory lock reclaim marker",
        quarantine => verifyCapturedReclaimMarker(
          quarantine,
          reclaimIdentity!,
          reclaimOwnerWritten ? reclaimOwner : undefined,
        ),
        captureBarrier,
        limits,
        "reclaim-marker",
      );
    }
    if (error instanceof PreparationLockRace) throw error;
    if (isTransientLockRace(error)) return false;
    if (claimed || !isAlreadyExists(error)) throw error;
    try { await reclaimStaleReclaimMarker(reclaimDirectory, staleMs, captureBarrier, limits); }
    catch (race) {
      if (race instanceof PreparationLockRace) throw race;
      if (!isTransientLockRace(race)) throw race;
    }
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
    const captured = await captureAndRetainDirectory(
      lockDirectory,
      layout.runRoot,
      latest.directoryIdentity,
      "Pi agent-directory preparation lock",
      quarantine => verifyCapturedPreparationLock(
        quarantine,
        latest.directoryIdentity!,
        latest.owner,
        reclaimOwner,
        reclaimIdentity,
      ),
      captureBarrier,
      limits,
      "preparation-lock",
    );
    return captured;
  } catch (error) {
    if (error instanceof PreparationLockRace) throw error;
    if (isTransientLockRace(error)) return false;
    throw error;
  } finally {
    try {
      if (await pathKind(lockDirectory) === "directory") {
        await releaseReclaimMarker(reclaimDirectory, reclaimOwner, reclaimIdentity, captureBarrier, limits);
      }
    } catch (error) {
      if (error instanceof PreparationLockRace) throw error;
      if (!isTransientLockRace(error)) throw error;
    }
  }
}

async function reclaimStaleReclaimMarker(
  directory: string,
  staleMs: number,
  captureBarrier: PreparationCaptureBarrier | undefined,
  limits: RetentionLimits,
): Promise<void> {
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
    await captureAndRetainDirectory(
      directory,
      path.resolve(directory, "..", ".."),
      identity,
      "Pi agent-directory lock reclaim marker",
      quarantine => verifyCapturedReclaimMarker(quarantine, identity),
      captureBarrier,
      limits,
      "reclaim-marker",
    );
    return;
  }
  if (ownerKind !== "file") throw new Error("Pi agent-directory lock reclaim owner is not a regular file");
  const ownerInfo = await lstatRequired(ownerPath, "Pi agent-directory lock reclaim owner");
  assertPrivateFile(ownerInfo, "Pi agent-directory lock reclaim owner");
  const owner = await readReclaimOwner(ownerPath);
  await assertReclaimMarkerOwnership(directory, owner, identity);
  if (!isStale(mtimeMilliseconds(ownerInfo), staleMs) || isProcessAlive(owner.pid)) return;
  await captureAndRetainDirectory(
    directory,
    path.resolve(directory, "..", ".."),
    identity,
    "Pi agent-directory lock reclaim marker",
    quarantine => verifyCapturedReclaimMarker(quarantine, identity, owner),
    captureBarrier,
    limits,
    "reclaim-marker",
  );
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
  expectedIdentity: DirectoryIdentity | undefined,
  captureBarrier: PreparationCaptureBarrier | undefined,
  limits: RetentionLimits,
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
      const captured = await captureAndRetainDirectory(
        directory,
        path.resolve(directory, "..", ".."),
        identity,
        "Pi agent-directory lock reclaim marker",
        quarantine => assertReclaimMarkerOwnership(quarantine, owner, identity),
        captureBarrier,
        limits,
        "reclaim-marker",
      );
      if (captured) return;
      return;
    } catch (error) {
      if (error instanceof PreparationLockRace) throw error;
      if (!isTransientLockRace(error)) throw error;
      lastRace = error;
      if (await pathKind(directory) === "missing") return;
      if (attempt + 1 < PREPARATION_LOCK_RACE_RETRIES) await waitForDelay(PREPARATION_LOCK_RACE_DELAY_MS);
    }
  }
  throw lastRace instanceof Error ? lastRace : new Error("Pi agent-directory lock reclaim release raced with replacement");
}

type CapturedDirectoryVerifier = (directory: string) => Promise<void>;

function retentionLimits(options: PiAgentDirectoryMaterializerOptions): RetentionLimits {
  return {
    perRun: positiveInteger(options.maxRetainedCapturesPerRun ?? PREPARATION_RETAINED_PER_RUN_LIMIT, "maximum retained captures per run"),
    global: positiveInteger(options.maxRetainedCapturesGlobal ?? PREPARATION_RETAINED_GLOBAL_LIMIT, "maximum retained captures globally"),
  };
}

async function ensureCaptureAuthKey(retainedRoot: string): Promise<Buffer> {
  const keyPath = path.join(retainedRoot, PREPARATION_RETAINED_AUTH_FILE);
  try {
    await writeFile(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  let lastError: unknown;
  // O_EXCL prevents two controllers from selecting different keys, but the
  // winning write is still visible while its bytes/mode are being published.
  // Treat that narrow handoff as a bounded race; a persistent invalid key is
  // still rejected and cannot be replaced by a reader.
  for (let attempt = 0; attempt < PREPARATION_LOCK_RACE_RETRIES; attempt += 1) {
    try {
      const info = await lstatRequired(keyPath, "Pi agent-directory retained capture authentication key");
      assertPrivateFile(info, "Pi agent-directory retained capture authentication key");
      const key = await readStableFile(keyPath, "Pi agent-directory retained capture authentication key");
      if (key.byteLength !== 32) throw new Error("Pi agent-directory retained capture authentication key is invalid");
      return key;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < PREPARATION_LOCK_RACE_RETRIES) await waitForDelay(PREPARATION_LOCK_RACE_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Pi agent-directory retained capture authentication key is invalid");
}

function serializeRetentionAllocationOwner(owner: RetentionAllocationOwner): Buffer {
  return Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
}

function isRetentionAllocationOwner(value: unknown): value is RetentionAllocationOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const expected = ["createdAt", "kind", "pid", "runId", "schemaVersion", "state", "token"].sort();
  return Object.keys(candidate).sort().join("\\0") === expected.join("\\0")
    && candidate["schemaVersion"] === 1
    && candidate["kind"] === PREPARATION_RETAINED_ALLOCATION_KIND
    && (candidate["state"] === "free" || candidate["state"] === "held")
    && typeof candidate["runId"] === "string" && RUN_ID.test(candidate["runId"])
    && typeof candidate["token"] === "string" && UUID.test(candidate["token"])
    && typeof candidate["pid"] === "number" && Number.isInteger(candidate["pid"]) && candidate["pid"] > 0
    && typeof candidate["createdAt"] === "number" && Number.isSafeInteger(candidate["createdAt"]) && candidate["createdAt"] > 0;
}

async function readRetentionAllocationOwner(directory: string): Promise<RetentionAllocationOwner | undefined> {
  const ownerPath = path.join(directory, PREPARATION_RETAINED_ALLOCATION_OWNER_FILE);
  let lastError: unknown;
  for (let attempt = 0; attempt < PREPARATION_LOCK_RACE_RETRIES; attempt += 1) {
    try {
      if (await pathKind(ownerPath) === "missing") return undefined;
      const info = await lstatRequired(ownerPath, "Pi agent-directory retained allocation lock owner");
      assertPrivateFile(info, "Pi agent-directory retained allocation lock owner");
      const bytes = await readStableFile(ownerPath, "Pi agent-directory retained allocation lock owner");
      let value: unknown;
      try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Pi agent-directory retained allocation lock owner is not valid JSON"); }
      if (!isRetentionAllocationOwner(value)) throw new Error("Pi agent-directory retained allocation lock owner is invalid");
      return value;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < PREPARATION_LOCK_RACE_RETRIES) await waitForDelay(PREPARATION_LOCK_RACE_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Pi agent-directory retained allocation lock owner is unreadable");
}

async function assertRetentionAllocationRootMarker(markerPath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PREPARATION_LOCK_RACE_RETRIES; attempt += 1) {
    try {
      const markerInfo = await lstatRequired(markerPath, "Pi agent-directory retained allocation root marker");
      assertPrivateFile(markerInfo, "Pi agent-directory retained allocation root marker");
      const marker = await readStableFile(markerPath, "Pi agent-directory retained allocation root marker");
      if (!marker.equals(PREPARATION_RETAINED_ALLOCATION_ROOT_MARKER_BYTES)) throw new Error("Pi agent-directory retained allocation root marker is invalid");
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < PREPARATION_LOCK_RACE_RETRIES) await waitForDelay(PREPARATION_LOCK_RACE_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Pi agent-directory retained allocation root marker is invalid");
}

async function ensureRetentionAllocationRoot(retainedRoot: string): Promise<void> {
  const entries = await readdir(retainedRoot, { withFileTypes: true });
  let freeLock = false;
  let heldLock = false;
  let rootMarker = false;
  let rootMarkerCreated = false;
  for (const entry of entries) {
    if (entry.name === PREPARATION_RETAINED_AUTH_FILE) continue;
    if (entry.name === PREPARATION_RETAINED_ALLOCATION_ROOT_MARKER) {
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Pi agent-directory retained allocation root marker is invalid");
      await assertRetentionAllocationRootMarker(path.join(retainedRoot, entry.name));
      rootMarker = true;
      continue;
    }
    if (entry.name === PREPARATION_RETAINED_ALLOCATION_LOCK) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Pi agent-directory retained allocation lock is not a private directory");
      try {
        const info = await lstatRequired(path.join(retainedRoot, entry.name), "Pi agent-directory retained allocation lock");
        assertPrivateDirectory(info, "Pi agent-directory retained allocation lock");
        freeLock = true;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      continue;
    }
    if (PREPARATION_RETAINED_ALLOCATION_HELD.test(entry.name)) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Pi agent-directory retained allocation lock is not a private directory");
      try {
        const info = await lstatRequired(path.join(retainedRoot, entry.name), "Pi agent-directory retained allocation lock");
        assertPrivateDirectory(info, "Pi agent-directory retained allocation lock");
        if (heldLock) throw new Error("Pi agent-directory retained allocation lock has multiple holders");
        heldLock = true;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      continue;
    }
    if (PREPARATION_RETAINED_RUN.test(entry.name)) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Pi agent-directory retained quarantine run is not a private directory");
      continue;
    }
    throw new Error("Pi agent-directory retained quarantine has unexpected content");
  }
  // A directory snapshot can straddle the atomic rename between the free and
  // held names. Acquisition rechecks the live paths before claiming anything;
  // do not turn that short observation window into a permanent wedge.
  if (!rootMarker) {
    const markerPath = path.join(retainedRoot, PREPARATION_RETAINED_ALLOCATION_ROOT_MARKER);
    try {
      await writeFile(markerPath, PREPARATION_RETAINED_ALLOCATION_ROOT_MARKER_BYTES, { flag: "wx", mode: 0o600 });
      rootMarkerCreated = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await assertRetentionAllocationRootMarker(markerPath);
  }
  // The marker makes the canonical/held rename a known initialized state. A
  // later observer must never recreate the canonical path while another
  // process may hold the directory under its `.held-*` name.
  if (!freeLock && !heldLock && rootMarkerCreated) {
    try { await mkdir(path.join(retainedRoot, PREPARATION_RETAINED_ALLOCATION_LOCK), { recursive: false, mode: 0o700 }); }
    catch (error) { if (!isAlreadyExists(error)) throw error; }
  }
}

async function ensureRetentionLocation(runRoot: string): Promise<RetainedCaptureLocation> {
  const resolvedRunRoot = path.resolve(runRoot);
  const runtimeRoot = path.dirname(resolvedRunRoot);
  const runId = path.basename(resolvedRunRoot);
  assertRunId(runId);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o755 });
  await ensureSecureDirectory(runtimeRoot, "runtime root", false);
  const retainedRoot = path.join(runtimeRoot, PREPARATION_RETAINED_DIRECTORY);
  await ensurePrivateDirectory(retainedRoot, "Pi agent-directory retained quarantine root");
  await ensureCaptureAuthKey(retainedRoot);
  await ensureRetentionAllocationRoot(retainedRoot);
  const retainedRun = path.join(retainedRoot, runId);
  await ensurePrivateDirectory(retainedRun, "Pi agent-directory retained quarantine run");
  return { runtimeRoot, retainedRoot, retainedRun };
}

function retentionAllocationOwnerPath(directory: string): string {
  return path.join(directory, PREPARATION_RETAINED_ALLOCATION_OWNER_FILE);
}

async function writeFreeRetentionAllocationOwner(directory: string, runId: string, overwrite = false): Promise<void> {
  const owner: RetentionAllocationOwner = {
    schemaVersion: 1,
    kind: PREPARATION_RETAINED_ALLOCATION_KIND,
    state: "free",
    runId,
    token: randomUUID(),
    pid: process.pid,
    createdAt: Date.now(),
  };
  const ownerPath = retentionAllocationOwnerPath(directory);
  try { await writeFile(ownerPath, serializeRetentionAllocationOwner(owner), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (!isAlreadyExists(error)) throw error;
    if (!overwrite) throw new PreparationLockRace("Pi agent-directory retained allocation lock owner appeared during initialization", error);
    await writeFile(ownerPath, serializeRetentionAllocationOwner(owner), { mode: 0o600 });
  }
  const info = await lstatRequired(ownerPath, "Pi agent-directory retained allocation lock owner");
  assertPrivateFile(info, "Pi agent-directory retained allocation lock owner");
  await chmod(ownerPath, 0o600);
}

async function writeHeldRetentionAllocationOwner(directory: string, runId: string): Promise<RetentionAllocationOwner> {
  const owner: RetentionAllocationOwner = {
    schemaVersion: 1,
    kind: PREPARATION_RETAINED_ALLOCATION_KIND,
    state: "held",
    runId,
    token: randomUUID(),
    pid: process.pid,
    createdAt: Date.now(),
  };
  const ownerPath = retentionAllocationOwnerPath(directory);
  await writeFile(ownerPath, serializeRetentionAllocationOwner(owner), { mode: 0o600 });
  const info = await lstatRequired(ownerPath, "Pi agent-directory retained allocation lock owner");
  assertPrivateFile(info, "Pi agent-directory retained allocation lock owner");
  await chmod(ownerPath, 0o600);
  return owner;
}

async function allocationLockHeldPath(retainedRoot: string): Promise<string | undefined> {
  const entries = await readdir(retainedRoot, { withFileTypes: true });
  const held = entries.filter(entry => PREPARATION_RETAINED_ALLOCATION_HELD.test(entry.name));
  if (held.length > 1) throw new Error("Pi agent-directory retained allocation lock has multiple holders");
  if (held.length === 0) return undefined;
  const entry = held[0]!;
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Pi agent-directory retained allocation lock is not a private directory");
  const directory = path.join(retainedRoot, entry.name);
  const info = await lstatRequired(directory, "Pi agent-directory retained allocation lock");
  assertPrivateDirectory(info, "Pi agent-directory retained allocation lock");
  return directory;
}

async function recoverStaleRetentionAllocationLock(retainedRoot: string, runId: string, force = false): Promise<boolean> {
  const heldPath = await allocationLockHeldPath(retainedRoot);
  if (!heldPath) return false;
  const info = await lstatRequired(heldPath, "Pi agent-directory retained allocation lock");
  assertPrivateDirectory(info, "Pi agent-directory retained allocation lock");
  let owner: RetentionAllocationOwner | undefined;
  try { owner = await readRetentionAllocationOwner(heldPath); }
  catch (error) {
    if (!isTransientLockRace(error)) throw error;
  }
  const stale = force || (owner
    ? owner.state === "free" || (isStale(owner.createdAt, PREPARATION_LOCK_STALE_MS) && !isProcessAlive(owner.pid))
    : isStale(mtimeMilliseconds(info), PREPARATION_LOCK_STALE_MS));
  if (!stale) return false;
  const before = await lstatRequired(heldPath, "Pi agent-directory retained allocation lock before recovery");
  assertPrivateDirectory(before, "Pi agent-directory retained allocation lock before recovery");
  if (!sameDirectoryIdentity(directoryIdentityOf(info), directoryIdentityOf(before))) throw new PreparationLockRace("Pi agent-directory retained allocation lock changed during recovery");
  await writeFreeRetentionAllocationOwner(heldPath, owner?.runId ?? runId, true);
  const canonical = path.join(retainedRoot, PREPARATION_RETAINED_ALLOCATION_LOCK);
  if (await pathKind(canonical) !== "missing") return false;
  try { await rename(heldPath, canonical); }
  catch (error) {
    if (isNotFound(error) || isAlreadyExists(error)) return false;
    throw error;
  }
  return true;
}

async function acquireRetentionAllocationLock(
  retainedRoot: string,
  runId: string,
  signal?: AbortSignal,
  force = false,
): Promise<RetentionAllocationLease> {
  const startedAt = monotonicMilliseconds();
  const timeoutMs = PREPARATION_LOCK_TIMEOUT_MS;
  for (;;) {
    throwIfAborted(signal);
    await ensureRetentionAllocationRoot(retainedRoot);
    const canonical = path.join(retainedRoot, PREPARATION_RETAINED_ALLOCATION_LOCK);
    const canonicalKind = await pathKind(canonical);
    if (canonicalKind === "directory") {
      if (await allocationLockHeldPath(retainedRoot)) {
        const elapsed = monotonicMilliseconds() - startedAt;
        if (elapsed >= timeoutMs) throw new Error("Pi agent-directory retained allocation lock acquisition timed out; trusted teardown is required");
        await waitForDelay(Math.min(PREPARATION_LOCK_POLL_MS, timeoutMs - elapsed), signal);
        continue;
      }
      const info = await lstatRequired(canonical, "Pi agent-directory retained allocation lock");
      assertPrivateDirectory(info, "Pi agent-directory retained allocation lock");
      let owner: RetentionAllocationOwner | undefined;
      try { owner = await readRetentionAllocationOwner(canonical); }
      catch (error) {
        if (!isTransientLockRace(error)) throw error;
      }
      if (!owner) {
        try { await writeFreeRetentionAllocationOwner(canonical, runId); }
        catch (error) {
          if (error instanceof PreparationLockRace) continue;
          throw error;
        }
        continue;
      }
      if (owner.state !== "free") {
        // Ordinary materialization never reclaims an allocation lease by PID
        // and age: it may be in the final publication handoff. Only a caller
        // that has already passed the trusted quiescence guard may force that
        // state transition; otherwise bounded waiting fails closed to teardown.
        if (force) {
          await writeFreeRetentionAllocationOwner(canonical, owner.runId, true);
          continue;
        }
        const elapsed = monotonicMilliseconds() - startedAt;
        if (elapsed >= timeoutMs) throw new Error("Pi agent-directory retained allocation lock acquisition timed out; trusted teardown is required");
        await waitForDelay(Math.min(PREPARATION_LOCK_POLL_MS, timeoutMs - elapsed), signal);
        continue;
      }
      // Publish the held owner before moving the directory. Moving a free
      // owner and rewriting it afterwards would let a contender observe the
      // old `free` bytes in the held pathname and reclaim a live lease.
      const activeOwner = await writeHeldRetentionAllocationOwner(canonical, runId);
      const claimedInfo = await lstatRequired(canonical, "Pi agent-directory retained allocation lock after claim");
      assertPrivateDirectory(claimedInfo, "Pi agent-directory retained allocation lock after claim");
      if (!sameDirectoryIdentity(directoryIdentityOf(info), directoryIdentityOf(claimedInfo))) throw new PreparationLockRace("Pi agent-directory retained allocation lock changed during acquisition");
      const claimedOwner = await readRetentionAllocationOwner(canonical);
      if (!claimedOwner || claimedOwner.state !== "held" || claimedOwner.token !== activeOwner.token || claimedOwner.runId !== runId) throw new PreparationLockRace("Pi agent-directory retained allocation lock owner changed during acquisition");
      const heldPath = path.join(retainedRoot, `${PREPARATION_RETAINED_ALLOCATION_LOCK}-held-${randomUUID()}`);
      try {
        await rename(canonical, heldPath);
      } catch (error) {
        if (isNotFound(error) || isAlreadyExists(error)) throw new PreparationLockRace("Pi agent-directory retained allocation lock changed during acquisition", error);
        throw error;
      }
      const heldInfo = await lstatRequired(heldPath, "Pi agent-directory retained allocation lock");
      assertPrivateDirectory(heldInfo, "Pi agent-directory retained allocation lock");
      if (!sameDirectoryIdentity(directoryIdentityOf(info), directoryIdentityOf(heldInfo))) throw new PreparationLockRace("Pi agent-directory retained allocation lock changed during acquisition");
      return { heldPath, directoryIdentity: directoryIdentityOf(heldInfo), owner: activeOwner };
    }
    if (canonicalKind !== "missing") throw new Error("Pi agent-directory retained allocation lock is not a directory");
    const recovered = force ? await recoverStaleRetentionAllocationLock(retainedRoot, runId, true) : false;
    if (recovered) continue;
    const heldPath = await allocationLockHeldPath(retainedRoot);
    if (!heldPath) {
      // Once the root marker exists, a missing canonical path is an
      // interrupted handoff, not an invitation to create a second mutex.
      // Force mode is used only after the trusted teardown guard and may
      // restore a missing initialized lock.
      if (force) {
        try { await mkdir(canonical, { recursive: false, mode: 0o700 }); }
        catch (error) { if (!isAlreadyExists(error)) throw error; }
        continue;
      }
    }
    const elapsed = monotonicMilliseconds() - startedAt;
    if (elapsed >= timeoutMs) throw new Error("Pi agent-directory retained allocation lock acquisition timed out; trusted teardown is required");
    await waitForDelay(Math.min(PREPARATION_LOCK_POLL_MS, timeoutMs - elapsed), signal);
  }
}

async function releaseRetentionAllocationLock(lease: RetentionAllocationLease): Promise<void> {
  const info = await lstatRequired(lease.heldPath, "Pi agent-directory retained allocation lock before release");
  assertPrivateDirectory(info, "Pi agent-directory retained allocation lock before release");
  if (!sameDirectoryIdentity(directoryIdentityOf(info), lease.directoryIdentity)) throw new PreparationLockRace("Pi agent-directory retained allocation lock changed before release");
  const owner = await readRetentionAllocationOwner(lease.heldPath);
  if (!owner || owner.state !== "held" || owner.token !== lease.owner.token || owner.runId !== lease.owner.runId) throw new Error("Pi agent-directory retained allocation lock ownership changed");
  const canonical = path.join(path.dirname(lease.heldPath), PREPARATION_RETAINED_ALLOCATION_LOCK);
  const canonicalKind = await pathKind(canonical);
  if (canonicalKind !== "missing") throw new PreparationLockRace("Pi agent-directory retained allocation lock was replaced before release");
  const before = await lstatRequired(lease.heldPath, "Pi agent-directory retained allocation lock before release");
  assertPrivateDirectory(before, "Pi agent-directory retained allocation lock before release");
  if (!sameDirectoryIdentity(directoryIdentityOf(before), lease.directoryIdentity)) throw new PreparationLockRace("Pi agent-directory retained allocation lock changed before release");
  await rename(lease.heldPath, canonical);
  const final = await lstatRequired(canonical, "Pi agent-directory retained allocation lock after release");
  assertPrivateDirectory(final, "Pi agent-directory retained allocation lock after release");
  if (!sameDirectoryIdentity(directoryIdentityOf(final), lease.directoryIdentity)) throw new PreparationLockRace("Pi agent-directory retained allocation lock changed after release");
  // Publish the free marker only after the owned directory is back at its
  // canonical path. A crash between these two operations leaves an
  // authenticated held marker that a later owner can recover after staleness.
  await writeFreeRetentionAllocationOwner(canonical, lease.owner.runId, true);
}

function identityRecord(identity: DirectoryIdentity): { dev: string; ino: string } {
  return { dev: String(identity.dev), ino: String(identity.ino) };
}

function sameIdentityRecord(left: { dev: string; ino: string }, right: DirectoryIdentity): boolean {
  return left.dev === String(right.dev) && left.ino === String(right.ino);
}

function serializeRetainedCapturePayload(payload: RetainedCaptureRecordPayload): Buffer {
  return Buffer.from(JSON.stringify(payload), "utf8");
}

async function serializeRetainedCaptureRecord(payload: RetainedCaptureRecordPayload, retainedRoot: string): Promise<Buffer> {
  const key = await ensureCaptureAuthKey(retainedRoot);
  const auth = createHmac("sha256", key).update(serializeRetainedCapturePayload(payload)).digest("hex");
  return Buffer.from(`${JSON.stringify({ ...payload, auth })}\n`, "utf8");
}

async function serializeRetainedFenceMetadata(
  record: RetainedCaptureRecord,
  fenceIdentity: DirectoryIdentity,
  retainedRoot: string,
): Promise<Buffer> {
  const payload = { ...recordWithoutAuth(record), fenceIdentity: identityRecord(fenceIdentity) };
  const key = await ensureCaptureAuthKey(retainedRoot);
  const auth = createHmac("sha256", key).update(Buffer.from(JSON.stringify(payload), "utf8")).digest("hex");
  return Buffer.from(`${JSON.stringify({ ...payload, auth })}\n`, "utf8");
}

async function writeRetainedCaptureRecord(
  recordPath: string,
  payload: RetainedCaptureRecordPayload,
  retainedRoot: string,
): Promise<Buffer> {
  const bytes = await serializeRetainedCaptureRecord(payload, retainedRoot);
  await writeFile(recordPath, bytes, { flag: "wx", mode: 0o600 });
  const info = await lstatRequired(recordPath, "Pi agent-directory retained capture record");
  assertPrivateFile(info, "Pi agent-directory retained capture record");
  await chmod(recordPath, 0o600);
  return bytes;
}

function isIdentityRecord(value: unknown): value is { dev: string; ino: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).sort().join("\\0") === "dev\\0ino"
    && typeof candidate["dev"] === "string" && /^\d+$/u.test(candidate["dev"])
    && typeof candidate["ino"] === "string" && /^\d+$/u.test(candidate["ino"]);
}

function isRetainedCaptureRecord(value: unknown): value is RetainedCaptureRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const expected = ["auth", "captureId", "capturedIdentity", "createdAt", "identity", "kind", "objectKind", "ownerPid", "quarantinePath", "retainedPath", "runId", "schemaVersion", "source", "state", "type"].sort();
  if (Object.keys(candidate).sort().join("\\0") !== expected.join("\\0")) return false;
  return candidate["schemaVersion"] === PREPARATION_RETAINED_SCHEMA_VERSION
    && candidate["kind"] === PREPARATION_RETAINED_RECORD_KIND
    && typeof candidate["runId"] === "string" && RUN_ID.test(candidate["runId"])
    && typeof candidate["captureId"] === "string" && UUID.test(candidate["captureId"])
    && typeof candidate["source"] === "string" && path.isAbsolute(candidate["source"]) && !candidate["source"].includes("\u0000")
    && typeof candidate["type"] === "string" && PREPARATION_CAPTURE_TYPE.has(candidate["type"])
    && (candidate["objectKind"] === "directory" || candidate["objectKind"] === "file")
    && isIdentityRecord(candidate["identity"])
    && isIdentityRecord(candidate["capturedIdentity"])
    && typeof candidate["quarantinePath"] === "string" && path.isAbsolute(candidate["quarantinePath"])
    && typeof candidate["retainedPath"] === "string" && path.isAbsolute(candidate["retainedPath"])
    && typeof candidate["ownerPid"] === "number" && Number.isInteger(candidate["ownerPid"]) && candidate["ownerPid"] > 0
    && typeof candidate["createdAt"] === "number" && Number.isSafeInteger(candidate["createdAt"]) && candidate["createdAt"] > 0
    && (candidate["state"] === "retained" || candidate["state"] === "fence")
    && typeof candidate["auth"] === "string" && SHA256_HMAC.test(candidate["auth"]);
}

function isRetainedFenceMetadata(value: unknown): value is RetainedFenceMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(candidate, "fenceIdentity")) return false;
  const recordCandidate = { ...candidate };
  delete recordCandidate["fenceIdentity"];
  return isRetainedCaptureRecord(recordCandidate) && isIdentityRecord(candidate["fenceIdentity"]);
}

async function readRetainedCaptureRecord(recordPath: string, runtimeRoot: string): Promise<RetainedCaptureRecord> {
  const retainedRoot = path.join(runtimeRoot, PREPARATION_RETAINED_DIRECTORY);
  const key = await ensureCaptureAuthKey(retainedRoot);
  let lastError: unknown;
  // A record is published with wx and may be observed by another controller
  // while the write is still being flushed. Bounded retries preserve the
  // handoff rather than treating that ordinary cross-process observation as a
  // tamper event; a persistent malformed/auth-invalid record still fails
  // closed.
  for (let attempt = 0; attempt < PREPARATION_LOCK_RACE_RETRIES; attempt += 1) {
    try {
      const info = await lstatRequired(recordPath, "Pi agent-directory retained capture record");
      assertPrivateFile(info, "Pi agent-directory retained capture record");
      const bytes = await readStableFile(recordPath, "Pi agent-directory retained capture record");
      let value: unknown;
      try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Pi agent-directory retained capture record is not valid JSON"); }
      if (!isRetainedCaptureRecord(value)) throw new Error("Pi agent-directory retained capture record is invalid");
      const payload = { ...value } as Record<string, unknown>;
      delete payload["auth"];
      const expectedAuth = createHmac("sha256", key).update(Buffer.from(JSON.stringify(payload), "utf8")).digest("hex");
      if (value.auth !== expectedAuth) throw new Error("Pi agent-directory retained capture record authentication failed");
      return value;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < PREPARATION_LOCK_RACE_RETRIES) await waitForDelay(PREPARATION_LOCK_RACE_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Pi agent-directory retained capture record is unreadable");
}

function retainedRecordPath(location: RetainedCaptureLocation, captureId: string): string {
  return path.join(location.retainedRun, `${PREPARATION_RETAINED_PREFIX}${captureId}${PREPARATION_RETAINED_RECORD_SUFFIX}`);
}

function retainedObjectPath(location: RetainedCaptureLocation, captureId: string): string {
  return path.join(location.retainedRun, `${PREPARATION_RETAINED_PREFIX}${captureId}`);
}

function validateRetainedRecordPaths(
  record: RetainedCaptureRecord,
  recordPath: string,
  location: RetainedCaptureLocation,
): void {
  const runRoot = path.join(location.runtimeRoot, record.runId);
  if (record.runId !== path.basename(location.retainedRun)
    || path.resolve(recordPath) !== retainedRecordPath(location, record.captureId)
    || path.resolve(record.retainedPath) !== retainedObjectPath(location, record.captureId)
    || !isWithin(runRoot, path.resolve(record.quarantinePath))
    || !isWithin(runRoot, path.resolve(record.source))
    || record.type === "quarantine-fence" && record.objectKind !== "directory") {
    throw new Error("Pi agent-directory retained capture record path or type is invalid");
  }
}

async function readRetainedRecordsForRun(
  location: RetainedCaptureLocation,
): Promise<Array<{ record: RetainedCaptureRecord; recordPath: string }>> {
  const entries = await readdir(location.retainedRun, { withFileTypes: true });
  const records: Array<{ record: RetainedCaptureRecord; recordPath: string }> = [];
  const expectedObjects = new Set<string>();
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("Pi agent-directory retained quarantine contains a symlink");
    const absolute = path.join(location.retainedRun, entry.name);
    if (PREPARATION_RETAINED_RECORD.test(entry.name)) {
      if (!entry.isFile()) throw new Error("Pi agent-directory retained capture record is not a regular file");
      const record = await readRetainedCaptureRecord(absolute, location.runtimeRoot);
      validateRetainedRecordPaths(record, absolute, location);
      records.push({ record, recordPath: absolute });
      expectedObjects.add(path.basename(record.retainedPath));
      continue;
    }
    if (PREPARATION_RETAINED_CAPTURE.test(entry.name)) {
      if (!entry.isDirectory() && !entry.isFile()) throw new Error("Pi agent-directory retained capture is not regular content");
      expectedObjects.add(entry.name);
      continue;
    }
    throw new Error("Pi agent-directory retained quarantine contains unexpected content");
  }
  const recordsByObject = new Map(records.map(item => [path.basename(item.record.retainedPath), item.record]));
  for (const object of expectedObjects) {
    if (!recordsByObject.has(object)) throw new Error("Pi agent-directory retained capture has no authenticated record");
  }
  for (const item of records) {
    const kind = await pathKind(item.record.retainedPath);
    if (kind === "missing") continue;
    const expectedKind = item.record.objectKind;
    if (kind !== expectedKind) throw new Error("Pi agent-directory retained capture kind changed");
    const info = await lstatRequired(item.record.retainedPath, "Pi agent-directory retained capture");
    if (expectedKind === "directory") assertPrivateDirectory(info, "Pi agent-directory retained capture");
    else assertPrivateFile(info, "Pi agent-directory retained capture");
    if (item.record.state !== "fence" && !sameIdentityRecord(item.record.capturedIdentity, directoryIdentityOf(info))) {
      throw new Error("Pi agent-directory retained capture identity changed");
    }
    if (item.record.state === "fence") await verifyFenceMetadata(item.record.retainedPath, item.record);
  }
  return records;
}

async function reconcileRetainedCaptures(
  runtimeRoot: string,
  runId: string,
  limits: RetentionLimits,
  signal?: AbortSignal,
): Promise<Array<{ record: RetainedCaptureRecord; recordPath: string }>> {
  throwIfAborted(signal);
  const location = await ensureRetentionLocation(path.join(runtimeRoot, runId));
  const rootEntries = await readdir(location.retainedRoot, { withFileTypes: true });
  let globalCount = 0;
  for (const entry of rootEntries) {
    if (entry.name === PREPARATION_RETAINED_AUTH_FILE) {
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Pi agent-directory retained capture authentication key is invalid");
      continue;
    }
    if (entry.name === PREPARATION_RETAINED_ALLOCATION_ROOT_MARKER) {
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Pi agent-directory retained allocation root marker is invalid");
      await assertRetentionAllocationRootMarker(path.join(location.retainedRoot, entry.name));
      continue;
    }
    if (entry.name === PREPARATION_RETAINED_ALLOCATION_LOCK || PREPARATION_RETAINED_ALLOCATION_HELD.test(entry.name)) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Pi agent-directory retained allocation lock is not a private directory");
      try {
        const lockInfo = await lstatRequired(path.join(location.retainedRoot, entry.name), "Pi agent-directory retained allocation lock");
        assertPrivateDirectory(lockInfo, "Pi agent-directory retained allocation lock");
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory() || !PREPARATION_RETAINED_RUN.test(entry.name)) {
      throw new Error("Pi agent-directory retained quarantine has unexpected content");
    }
    const itemLocation = { ...location, retainedRun: path.join(location.retainedRoot, entry.name) };
    const records = await readRetainedRecordsForRun(itemLocation);
    globalCount += records.length;
    if (entry.name === runId && records.length > limits.perRun) {
      throw new Error("Pi agent-directory retained capture per-run bound has been exceeded; trusted teardown is required");
    }
  }
  if (globalCount > limits.global) throw new Error("Pi agent-directory retained capture global bound has been exceeded; trusted teardown is required");
  // A completed materialization may still be reused at the bound. Allocation
  // itself performs the final per-run/global check before publishing another
  // authenticated record, so the ledger never grows past either limit.
  return readRetainedRecordsForRun(location);
}

async function findRetainedRecordForQuarantine(
  runRoot: string,
  quarantine: string,
): Promise<{ record: RetainedCaptureRecord; recordPath: string; location: RetainedCaptureLocation }> {
  const location = await ensureRetentionLocation(runRoot);
  const records = await readRetainedRecordsForRun(location);
  const matches = records.filter(item => path.resolve(item.record.quarantinePath) === path.resolve(quarantine));
  if (matches.length !== 1) throw new Error("Pi agent-directory quarantine has no authenticated capture metadata");
  return { ...matches[0]!, location };
}

async function verifyFenceMetadata(
  quarantine: string,
  record: RetainedCaptureRecord,
): Promise<void> {
  if (record.state !== "fence") return;
  const entries = await readdir(quarantine, { withFileTypes: true });
  if (entries.length !== 1 || entries[0]!.name !== PREPARATION_CAPTURE_METADATA_FILE || !entries[0]!.isFile() || entries[0]!.isSymbolicLink()) {
    throw new Error("Pi agent-directory quarantine fence contains unexpected content");
  }
  const metadataPath = path.join(quarantine, PREPARATION_CAPTURE_METADATA_FILE);
  const metadataInfo = await lstatRequired(metadataPath, "Pi agent-directory quarantine metadata");
  assertPrivateFile(metadataInfo, "Pi agent-directory quarantine metadata");
  const metadata = await readStableFile(metadataPath, "Pi agent-directory quarantine metadata");
  let value: unknown;
  try { value = JSON.parse(metadata.toString("utf8")); } catch { throw new Error("Pi agent-directory quarantine metadata is not valid JSON"); }
  if (!isRetainedFenceMetadata(value)) throw new Error("Pi agent-directory quarantine metadata is invalid");
  const candidateRecord = { ...value } as Record<string, unknown>;
  delete candidateRecord["fenceIdentity"];
  const payload = { ...candidateRecord };
  delete payload["auth"];
  const retainedRoot = path.dirname(path.dirname(record.retainedPath));
  const key = await ensureCaptureAuthKey(retainedRoot);
  const expectedAuth = createHmac("sha256", key).update(Buffer.from(JSON.stringify({ ...payload, fenceIdentity: value.fenceIdentity }), "utf8")).digest("hex");
  if (value.auth !== expectedAuth || JSON.stringify(payload) !== JSON.stringify(recordWithoutAuth(record))) {
    throw new Error("Pi agent-directory quarantine metadata does not match its authenticated capture record");
  }
  const fenceInfo = await lstatRequired(quarantine, "Pi agent-directory quarantine fence");
  assertPrivateDirectory(fenceInfo, "Pi agent-directory quarantine fence");
  if (!sameIdentityRecord(value.fenceIdentity, fenceInfo)) throw new Error("Pi agent-directory quarantine fence identity changed");
}

function recordWithoutAuth(record: RetainedCaptureRecord): RetainedCaptureRecordPayload {
  const { auth: _auth, ...payload } = record;
  return payload;
}

async function reconcileQuarantineFences(
  runRoot: string,
  limits: RetentionLimits,
  staleMs: number,
  signal?: AbortSignal,
  force = false,
): Promise<number> {
  const kind = await pathKind(runRoot);
  if (kind === "missing") return 0;
  if (kind !== "directory") throw new Error("run runtime path is not a directory");
  const entries = await readdir(runRoot, { withFileTypes: true });
  let reconciled = 0;
  for (const entry of entries) {
    if (!entry.name.startsWith(PREPARATION_QUARANTINE_PREFIX)) continue;
    if (!PREPARATION_QUARANTINE.test(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error("Pi agent-directory quarantine is not a private directory");
    }
    const quarantine = path.join(runRoot, entry.name);
    if (await pathKind(quarantine) === "missing") continue;
    let found: { record: RetainedCaptureRecord; recordPath: string; location: RetainedCaptureLocation };
    try { found = await findRetainedRecordForQuarantine(runRoot, quarantine); }
    catch (error) {
      if (isTransientLockRace(error) || isNotFound(error)) continue;
      throw error;
    }
    let info: Awaited<ReturnType<typeof lstat>>;
    try { info = await lstatRequired(quarantine, "Pi agent-directory quarantine"); }
    catch (error) {
      if (isTransientLockRace(error) || isNotFound(error)) continue;
      throw error;
    }
    assertPrivateDirectory(info, "Pi agent-directory quarantine");
    if (found.record.state !== "fence" && !sameIdentityRecord(found.record.capturedIdentity, directoryIdentityOf(info))) {
      throw new PreparationLockRace("Pi agent-directory quarantine was replaced during reconciliation");
    }
    await verifyFenceMetadata(quarantine, found.record);
    const stale = force || (isStale(found.record.createdAt, staleMs) && !isProcessAlive(found.record.ownerPid));
    if (!stale) continue;
    throwIfAborted(signal);
    const retainedKind = await pathKind(found.record.retainedPath);
    if (retainedKind !== "missing") throw new PreparationLockRace("Pi agent-directory quarantine has a conflicting retained destination");
    const before = await lstatRequired(quarantine, "Pi agent-directory quarantine before reconciliation");
    assertPrivateDirectory(before, "Pi agent-directory quarantine before reconciliation");
    if (!sameDirectoryIdentity(directoryIdentityOf(before), directoryIdentityOf(info))) {
      throw new PreparationLockRace("Pi agent-directory quarantine changed during reconciliation");
    }
    await rename(quarantine, found.record.retainedPath);
    const retainedInfo = await lstatRequired(found.record.retainedPath, "Pi agent-directory retained quarantine");
    assertPrivateDirectory(retainedInfo, "Pi agent-directory retained quarantine");
    reconciled += 1;
  }
  await reconcileRetainedCaptures(path.dirname(runRoot), path.basename(runRoot), limits, signal);
  return reconciled;
}

async function reconcilePreparationLifecycle(
  runRoot: string,
  limits: RetentionLimits,
  staleMs: number,
  signal?: AbortSignal,
  force = false,
): Promise<number> {
  const runtimeRoot = path.dirname(runRoot);
  await reconcileRetainedCaptures(runtimeRoot, path.basename(runRoot), limits, signal);
  return reconcileQuarantineFences(runRoot, limits, staleMs, signal, force);
}

async function assertNoLivePreparationState(runRoot: string): Promise<void> {
  const kind = await pathKind(runRoot);
  if (kind === "missing") return;
  if (kind !== "directory") throw new Error("run runtime path is not a directory");
  const entries = await readdir(runRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === PREPARATION_LOCK_DIRECTORY || entry.name.startsWith(PREPARATION_QUARANTINE_PREFIX)) {
      throw new Error("Pi agent-directory teardown found live preparation state");
    }
  }
}

async function removeLivePreparationLockAfterQuiescence(
  runRoot: string,
  runId: string,
  signal: AbortSignal | undefined,
  guard: PiAgentDirectoryTeardownGuard,
): Promise<void> {
  const lockPath = path.join(runRoot, PREPARATION_LOCK_DIRECTORY);
  const kind = await pathKind(lockPath);
  if (kind === "missing") return;
  if (kind !== "directory") throw new Error("Pi agent-directory preparation lock is not a private directory");
  const info = await lstatRequired(lockPath, "Pi agent-directory preparation lock before teardown");
  assertPrivateDirectory(info, "Pi agent-directory preparation lock before teardown");
  await guard(runId, signal);
  const before = await lstatRequired(lockPath, "Pi agent-directory preparation lock before teardown");
  assertPrivateDirectory(before, "Pi agent-directory preparation lock before teardown");
  if (!sameDirectoryIdentity(directoryIdentityOf(info), directoryIdentityOf(before))) {
    throw new PreparationLockRace("Pi agent-directory preparation lock changed during teardown");
  }
  await rm(lockPath, { recursive: true, force: false });
}

async function removeRetainedCapturesAfterQuiescence(
  runtimeRoot: string,
  runId: string,
  limits: RetentionLimits,
  signal: AbortSignal | undefined,
  guard: PiAgentDirectoryTeardownGuard,
): Promise<number> {
  const location = await ensureRetentionLocation(path.join(runtimeRoot, runId));
  await guard(runId, signal);
  const allocationLock = await acquireRetentionAllocationLock(location.retainedRoot, runId, signal, true);
  try {
    const records = await reconcileRetainedCaptures(runtimeRoot, runId, limits, signal);
    await guard(runId, signal);
    let removed = 0;
    for (const item of records) {
      throwIfAborted(signal);
      const current = await readRetainedCaptureRecord(item.recordPath, runtimeRoot);
      if (current.auth !== item.record.auth) throw new Error("Pi agent-directory retained capture changed during teardown");
      const objectKind = current.objectKind;
      const object = await pathKind(current.retainedPath);
      if (object !== "missing") {
        const info = await lstatRequired(current.retainedPath, "Pi agent-directory retained capture before teardown");
        if (objectKind === "directory") assertPrivateDirectory(info, "Pi agent-directory retained capture before teardown");
        else assertPrivateFile(info, "Pi agent-directory retained capture before teardown");
        if (current.state !== "fence" && !sameIdentityRecord(current.capturedIdentity, directoryIdentityOf(info))) {
          throw new Error("Pi agent-directory retained capture identity changed during teardown");
        }
        if (current.state === "fence") await verifyFenceMetadata(current.retainedPath, current);
        await guard(runId, signal);
        const afterInfo = await lstatRequired(current.retainedPath, "Pi agent-directory retained capture after teardown guard");
        if (objectKind === "directory") assertPrivateDirectory(afterInfo, "Pi agent-directory retained capture after teardown guard");
        else assertPrivateFile(afterInfo, "Pi agent-directory retained capture after teardown guard");
        if (current.state !== "fence" && !sameIdentityRecord(current.capturedIdentity, directoryIdentityOf(afterInfo))) {
          throw new Error("Pi agent-directory retained capture identity changed during teardown");
        }
        if (current.state === "fence") await verifyFenceMetadata(current.retainedPath, current);
        await rm(current.retainedPath, { recursive: objectKind === "directory", force: false });
      }
      const recordInfo = await lstatRequired(item.recordPath, "Pi agent-directory retained capture record before teardown");
      assertPrivateFile(recordInfo, "Pi agent-directory retained capture record before teardown");
      await guard(runId, signal);
      const finalRecord = await readRetainedCaptureRecord(item.recordPath, runtimeRoot);
      if (finalRecord.auth !== current.auth) throw new Error("Pi agent-directory retained capture changed during teardown");
      const finalRecordInfo = await lstatRequired(item.recordPath, "Pi agent-directory retained capture record after teardown guard");
      assertPrivateFile(finalRecordInfo, "Pi agent-directory retained capture record after teardown guard");
      if (!sameFileStat(recordInfo, finalRecordInfo)) throw new Error("Pi agent-directory retained capture record changed during teardown");
      await rm(item.recordPath, { recursive: false, force: false });
      removed += 1;
    }
    const remaining = await readdir(location.retainedRun, { withFileTypes: true });
    if (remaining.length !== 0) throw new Error("Pi agent-directory retained quarantine contains unexpected content after teardown");
    const runInfo = await lstatRequired(location.retainedRun, "Pi agent-directory retained quarantine run");
    assertPrivateDirectory(runInfo, "Pi agent-directory retained quarantine run");
    await guard(runId, signal);
    const finalRunInfo = await lstatRequired(location.retainedRun, "Pi agent-directory retained quarantine run after teardown guard");
    assertPrivateDirectory(finalRunInfo, "Pi agent-directory retained quarantine run after teardown guard");
    if (!sameDirectoryIdentity(directoryIdentityOf(runInfo), directoryIdentityOf(finalRunInfo))) throw new PreparationLockRace("Pi agent-directory retained quarantine run changed during teardown");
    await rmdir(location.retainedRun);
    return removed;
  } finally {
    await releaseRetentionAllocationLock(allocationLock);
  }
}

async function freshRetainedPath(
  runRoot: string,
  name: string,
  limits: RetentionLimits,
  type: RetainedCaptureType,
  source: string,
  expectedIdentity: DirectoryIdentity,
  objectKind: "directory" | "file",
  quarantinePath: string,
  state: "retained" | "fence" = "retained",
): Promise<RetainedCaptureAllocation> {
  const location = await ensureRetentionLocation(runRoot);
  if (!path.isAbsolute(source) || !path.isAbsolute(quarantinePath)) throw new Error(`${name} retained capture paths must be absolute`);
  const allocationLock = await acquireRetentionAllocationLock(location.retainedRoot, path.basename(runRoot));
  try {
    // Both bounds are checked while the process-independent allocation mutex is
    // held. This closes the last race where two run controllers observed the
    // same count and each appended a capture.
    const current = await reconcileRetainedCaptures(location.runtimeRoot, path.basename(runRoot), limits);
    const global = await countRetainedCaptures(location.runtimeRoot);
    if (current.length >= limits.perRun) throw new Error(`${name} retained capture per-run bound reached; trusted teardown is required`);
    if (global >= limits.global) throw new Error(`${name} retained capture global bound reached; trusted teardown is required`);
    for (let attempt = 0; attempt < PREPARATION_LOCK_RACE_RETRIES; attempt += 1) {
      const captureId = randomUUID();
      const retainedPath = retainedObjectPath(location, captureId);
      const recordPath = retainedRecordPath(location, captureId);
      if (await pathKind(retainedPath) !== "missing" || await pathKind(recordPath) !== "missing") continue;
      const payload: RetainedCaptureRecordPayload = {
        schemaVersion: PREPARATION_RETAINED_SCHEMA_VERSION,
        kind: PREPARATION_RETAINED_RECORD_KIND,
        runId: path.basename(runRoot),
        captureId,
        source: path.resolve(source),
        type,
        objectKind,
        identity: identityRecord(expectedIdentity),
        capturedIdentity: identityRecord(expectedIdentity),
        quarantinePath: path.resolve(quarantinePath),
        retainedPath,
        ownerPid: process.pid,
        createdAt: Date.now(),
        state,
      };
      await writeRetainedCaptureRecord(recordPath, payload, location.retainedRoot);
      return { captureId, retainedPath, recordPath };
    }
    throw new Error(`${name} retained quarantine name could not be allocated`);
  } finally {
    await releaseRetentionAllocationLock(allocationLock);
  }
}

async function countRetainedCaptures(runtimeRoot: string): Promise<number> {
  const retainedRoot = path.join(runtimeRoot, PREPARATION_RETAINED_DIRECTORY);
  const rootKind = await pathKind(retainedRoot);
  if (rootKind === "missing") return 0;
  if (rootKind !== "directory") throw new Error("Pi agent-directory retained quarantine root is not a directory");
  const entries = await readdir(retainedRoot, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    if (entry.name === PREPARATION_RETAINED_AUTH_FILE || entry.name === PREPARATION_RETAINED_ALLOCATION_ROOT_MARKER || entry.name === PREPARATION_RETAINED_ALLOCATION_LOCK || PREPARATION_RETAINED_ALLOCATION_HELD.test(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory() || !PREPARATION_RETAINED_RUN.test(entry.name)) throw new Error("Pi agent-directory retained quarantine has unexpected content");
    const location: RetainedCaptureLocation = { runtimeRoot, retainedRoot, retainedRun: path.join(retainedRoot, entry.name) };
    total += (await readRetainedRecordsForRun(location)).length;
  }
  return total;
}

async function freshQuarantinePath(runRoot: string, name: string): Promise<string> {
  await ensureSecureDirectory(runRoot, "run runtime directory", true);
  for (let attempt = 0; attempt < PREPARATION_LOCK_RACE_RETRIES; attempt += 1) {
    const candidate = path.join(runRoot, `${PREPARATION_QUARANTINE_PREFIX}${randomUUID()}`);
    if (await pathKind(candidate) === "missing") return candidate;
  }
  throw new Error(`${name} quarantine name could not be allocated`);
}

async function createQuarantineFence(
  runRoot: string,
  name: string,
  source: string,
  expectedIdentity: DirectoryIdentity,
  limits: RetentionLimits,
): Promise<void> {
  const candidate = await freshQuarantinePath(runRoot, name);
  const allocation = await freshRetainedPath(
    runRoot,
    name,
    limits,
    "quarantine-fence",
    source,
    expectedIdentity,
    "directory",
    candidate,
    "fence",
  );
  const location = await ensureRetentionLocation(runRoot);
  const record = await readRetainedCaptureRecord(allocation.recordPath, location.runtimeRoot);
  try {
    await mkdir(candidate, { recursive: false, mode: 0o700 });
    await chmod(candidate, 0o700);
    await ensureSecureDirectory(candidate, "Pi agent-directory quarantine fence", true);
    const fenceInfo = await lstatRequired(candidate, "Pi agent-directory quarantine fence");
    assertPrivateDirectory(fenceInfo, "Pi agent-directory quarantine fence");
    const metadata = await serializeRetainedFenceMetadata(record, directoryIdentityOf(fenceInfo), location.retainedRoot);
    const metadataPath = path.join(candidate, PREPARATION_CAPTURE_METADATA_FILE);
    await writeFile(metadataPath, metadata, { flag: "wx", mode: 0o600 });
    const metadataInfo = await lstatRequired(metadataPath, "Pi agent-directory quarantine metadata");
    assertPrivateFile(metadataInfo, "Pi agent-directory quarantine metadata");
    await chmod(metadataPath, 0o600);
    const afterFenceInfo = await lstatRequired(candidate, "Pi agent-directory quarantine fence after metadata");
    assertPrivateDirectory(afterFenceInfo, "Pi agent-directory quarantine fence after metadata");
    if (!sameDirectoryIdentity(directoryIdentityOf(afterFenceInfo), directoryIdentityOf(fenceInfo))) {
      throw new PreparationLockRace(`${name} quarantine fence was replaced before publication`);
    }
  } catch (error) {
    if (isAlreadyExists(error)) throw new PreparationLockRace(`${name} quarantine fence was replaced`, error);
    throw error;
  }
}

/**
 * Cleanup never recursively removes a pathname that another same-UID actor
 * can replace. The live directory is atomically captured, verified, and then
 * handed to a bounded, authenticated retained-quarantine namespace. Destructive
 * cleanup is reserved for the explicit quiescent teardown API.
 */
async function captureAndRetainDirectory(
  source: string,
  runRoot: string,
  expectedIdentity: DirectoryIdentity,
  name: string,
  verify: CapturedDirectoryVerifier,
  captureBarrier: PreparationCaptureBarrier | undefined,
  limits: RetentionLimits,
  type: RetainedCaptureType,
): Promise<boolean> {
  if (await pathKind(source) === "missing") return false;
  const quarantine = await freshQuarantinePath(runRoot, name);
  const retained = await freshRetainedPath(runRoot, name, limits, type, source, expectedIdentity, "directory", quarantine);
  try {
    await rename(source, quarantine);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  try {
    const capturedInfo = await lstatRequired(quarantine, `${name} captured directory`);
    assertPrivateDirectory(capturedInfo, `${name} captured directory`);
    const capturedIdentity = directoryIdentityOf(capturedInfo);
    if (!sameDirectoryIdentity(capturedIdentity, expectedIdentity)) {
      throw new PreparationLockRace(`${name} replacement was captured instead of the expected directory`);
    }
    await verify(quarantine);
    await captureBarrier?.({ source, quarantine, name });

    // Revalidate after the synchronization boundary. If the quarantine was
    // moved aside and replaced, leave both objects untouched at their current
    // paths; in particular, never hand the replacement to recursive cleanup.
    const afterBarrierInfo = await lstatRequired(quarantine, `${name} captured directory after verification`);
    assertPrivateDirectory(afterBarrierInfo, `${name} captured directory after verification`);
    if (!sameDirectoryIdentity(directoryIdentityOf(afterBarrierInfo), expectedIdentity)) {
      throw new PreparationLockRace(`${name} quarantine was replaced after verification`);
    }
    await verify(quarantine);

    const beforeHandoffInfo = await lstatRequired(quarantine, `${name} captured directory before retention`);
    assertPrivateDirectory(beforeHandoffInfo, `${name} captured directory before retention`);
    if (!sameDirectoryIdentity(directoryIdentityOf(beforeHandoffInfo), expectedIdentity)) {
      throw new PreparationLockRace(`${name} quarantine was replaced before retention`);
    }
    try { await rename(quarantine, retained.retainedPath); }
    catch (error) {
      if (isNotFound(error)) throw new PreparationLockRace(`${name} captured directory disappeared before retention`, error);
      throw error;
    }
    const retainedInfo = await lstatRequired(retained.retainedPath, `${name} retained directory`);
    assertPrivateDirectory(retainedInfo, `${name} retained directory`);
    if (!sameDirectoryIdentity(directoryIdentityOf(retainedInfo), expectedIdentity)) {
      throw new PreparationLockRace(`${name} retained directory was replaced before verification`);
    }
    await verify(retained.retainedPath);
    return true;
  } catch (error) {
    // If the captured pathname disappeared during the handoff, retain a
    // metadata-bearing fence in the run root. This blocks a new owner while
    // bounded stale reconciliation locates the retained capture, without
    // deleting any replacement.
    if (await pathKind(quarantine) === "missing") await createQuarantineFence(runRoot, name, source, expectedIdentity, limits);
    if (isNotFound(error)) throw new PreparationLockRace(`${name} captured directory disappeared before retention`, error);
    throw error;
  }
}

async function verifyCapturedStagingDirectory(
  directory: string,
  expectedIdentity: DirectoryIdentity,
  expectedEntries: readonly FileSystemEntry[],
): Promise<void> {
  const info = await lstatRequired(directory, "captured Pi agent preparation staging directory");
  assertPrivateDirectory(info, "captured Pi agent preparation staging directory");
  if (!sameDirectoryIdentity(directoryIdentityOf(info), expectedIdentity)) {
    throw new PreparationLockRace("captured Pi agent preparation staging directory identity changed");
  }
  const expectedFiles = new Map(expectedEntries.map(entry => [entry.path, entry.bytes]));
  const expectedDirectories = new Set<string>();
  for (const file of expectedFiles.keys()) {
    let parent = path.posix.dirname(file);
    while (parent !== ".") {
      expectedDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const actual = await listRelativeEntries(directory);
  if (actual.files.some(file => !expectedFiles.has(file)) || actual.directories.some(name => !expectedDirectories.has(name))) {
    throw new Error("captured Pi agent preparation staging directory contains unexpected content");
  }
  for (const name of actual.directories) {
    const directoryInfo = await lstatRequired(path.join(directory, name), `captured Pi agent preparation staging directory entry: ${name}`);
    assertPrivateDirectory(directoryInfo, `captured Pi agent preparation staging directory entry: ${name}`);
  }
  for (const name of actual.files) {
    const fileInfo = await lstatRequired(path.join(directory, name), `captured Pi agent preparation staging file: ${name}`);
    assertPrivateFile(fileInfo, `captured Pi agent preparation staging file: ${name}`);
    const bytes = await readStableFile(path.join(directory, name), `captured Pi agent preparation staging file: ${name}`);
    if (!bytes.equals(expectedFiles.get(name)!)) throw new Error(`captured Pi agent preparation staging file changed: ${name}`);
  }
  await assertStableDirectoryIdentity(directory, expectedIdentity, "captured Pi agent preparation staging directory");
}

async function verifyCapturedPreparationLock(
  directory: string,
  expectedIdentity: DirectoryIdentity,
  expectedOwner?: PreparationLockOwner,
  expectedReclaimOwner?: PreparationReclaimOwner,
  expectedReclaimIdentity?: DirectoryIdentity,
  requireHeartbeatAbsent = false,
): Promise<void> {
  const info = await lstatRequired(directory, "captured Pi agent-directory preparation lock");
  assertPrivateDirectory(info, "captured Pi agent-directory preparation lock");
  if (!sameDirectoryIdentity(directoryIdentityOf(info), expectedIdentity)) {
    throw new PreparationLockRace("captured Pi agent-directory preparation lock identity changed");
  }
  const ownerPath = path.join(directory, PREPARATION_LOCK_OWNER_FILE);
  const ownerKind = await pathKind(ownerPath);
  if (expectedOwner) {
    if (ownerKind !== "file") throw new PreparationLockRace("captured Pi agent-directory preparation lock owner changed");
    const owner = await readPreparationLockOwner(ownerPath);
    if (!samePreparationLockOwner(owner, expectedOwner)) throw new PreparationLockRace("captured Pi agent-directory preparation lock owner changed");
  } else if (ownerKind !== "missing") {
    throw new PreparationLockRace("captured Pi agent-directory preparation lock unexpectedly has an owner");
  }
  await verifyPreparationLockEntries(directory, expectedOwner !== undefined, expectedIdentity);
  if (requireHeartbeatAbsent || !expectedOwner) {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some(entry => PREPARATION_LOCK_OWNER_TEMP.test(entry.name) || PREPARATION_LOCK_HEARTBEAT_TEMP.test(entry.name))) {
      throw new PreparationLockRace("captured Pi agent-directory preparation lock has unexpected temporary metadata");
    }
  }
  const heartbeatPath = path.join(directory, PREPARATION_LOCK_HEARTBEAT_FILE);
  const heartbeatKind = await pathKind(heartbeatPath);
  if (requireHeartbeatAbsent && heartbeatKind !== "missing") {
    throw new PreparationLockRace("captured Pi agent-directory preparation lock has unexpected heartbeat state");
  }
  if (heartbeatKind !== "missing") {
    if (heartbeatKind !== "file") throw new Error("captured Pi agent-directory preparation lock heartbeat is not a regular file");
    const heartbeatInfo = await lstatRequired(heartbeatPath, "captured Pi agent-directory preparation lock heartbeat");
    assertPrivateFile(heartbeatInfo, "captured Pi agent-directory preparation lock heartbeat");
  }
  const reclaimPath = path.join(directory, PREPARATION_LOCK_RECLAIM_DIRECTORY);
  const reclaimKind = await pathKind(reclaimPath);
  if (expectedReclaimOwner) {
    if (reclaimKind !== "directory") throw new PreparationLockRace("captured Pi agent-directory reclaim marker changed");
    const reclaimInfo = await lstatRequired(reclaimPath, "captured Pi agent-directory lock reclaim marker");
    assertPrivateDirectory(reclaimInfo, "captured Pi agent-directory lock reclaim marker");
    const reclaimIdentity = directoryIdentityOf(reclaimInfo);
    if (expectedReclaimIdentity && !sameDirectoryIdentity(reclaimIdentity, expectedReclaimIdentity)) {
      throw new PreparationLockRace("captured Pi agent-directory reclaim marker identity changed");
    }
    await assertReclaimMarkerOwnership(reclaimPath, expectedReclaimOwner, reclaimIdentity);
  } else if (reclaimKind !== "missing") {
    throw new PreparationLockRace("captured Pi agent-directory preparation lock has an unexpected reclaim marker");
  }
  const finalOwnerKind = await pathKind(ownerPath);
  if (expectedOwner) {
    if (finalOwnerKind !== "file") throw new PreparationLockRace("captured Pi agent-directory preparation lock owner changed");
    const finalOwner = await readPreparationLockOwner(ownerPath);
    if (!samePreparationLockOwner(finalOwner, expectedOwner)) throw new PreparationLockRace("captured Pi agent-directory preparation lock owner changed");
  } else if (finalOwnerKind !== "missing") {
    throw new PreparationLockRace("captured Pi agent-directory preparation lock unexpectedly has an owner");
  }
  await assertStableDirectoryIdentity(directory, expectedIdentity, "captured Pi agent-directory preparation lock");
}

async function verifyCapturedReclaimMarker(
  directory: string,
  expectedIdentity: DirectoryIdentity,
  expectedOwner?: PreparationReclaimOwner,
): Promise<void> {
  if (expectedOwner) {
    await assertReclaimMarkerOwnership(directory, expectedOwner, expectedIdentity);
    return;
  }
  const info = await lstatRequired(directory, "captured Pi agent-directory lock reclaim marker");
  assertPrivateDirectory(info, "captured Pi agent-directory lock reclaim marker");
  if (!sameDirectoryIdentity(directoryIdentityOf(info), expectedIdentity)) {
    throw new PreparationLockRace("captured Pi agent-directory lock reclaim marker identity changed");
  }
  await verifyReclaimMarkerEntries(directory, false, expectedIdentity);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some(entry => PREPARATION_RECLAIM_OWNER_TEMP.test(entry.name))) {
    throw new PreparationLockRace("captured Pi agent-directory lock reclaim marker has unexpected temporary metadata");
  }
  if (await pathKind(path.join(directory, PREPARATION_LOCK_RECLAIM_OWNER_FILE)) !== "missing") {
    throw new PreparationLockRace("captured Pi agent-directory lock reclaim owner unexpectedly exists");
  }
  await assertStableDirectoryIdentity(directory, expectedIdentity, "captured Pi agent-directory lock reclaim marker");
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
  if (await hasPreparationQuarantine(layout)) {
    throw new PreparationCaptureInProgress("Pi agent-directory preparation capture is in progress");
  }
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
  if (await hasPreparationQuarantine(layout)) {
    throw new PreparationCaptureInProgress("Pi agent-directory preparation capture is in progress");
  }
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
    if (entry.name.startsWith(PREPARATION_QUARANTINE_PREFIX)) {
      if (!PREPARATION_QUARANTINE.test(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error("Pi agent-directory quarantine is not a private directory");
      }
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstatRequired(path.join(layout.runRoot, entry.name), "Pi agent-directory quarantine");
      } catch (error) {
        if (isNotFound(error)) throw new PreparationCaptureInProgress("Pi agent-directory preparation capture is in progress");
        throw error;
      }
      assertPrivateDirectory(info, "Pi agent-directory quarantine");
      throw new PreparationCaptureInProgress("Pi agent-directory preparation capture is in progress");
    }
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

async function writePrivateFileAtomically(target: string, bytes: Buffer, mode: number, runRoot: string, limits: RetentionLimits): Promise<void> {
  const temporary = `${target}.tmp-${randomUUID()}`;
  let temporaryIdentity: DirectoryIdentity | undefined;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode });
    const temporaryInfo = await lstatRequired(temporary, "Pi agent-directory private temporary file");
    assertPrivateFile(temporaryInfo, "Pi agent-directory private temporary file");
    temporaryIdentity = directoryIdentityOf(temporaryInfo);
    await chmod(temporary, mode);
    await rename(temporary, target);
  } finally {
    if (temporaryIdentity) await captureAndRetainPrivateTemporaryFile(temporary, temporaryIdentity, bytes, runRoot, limits);
  }
}

async function captureAndRetainPrivateTemporaryFile(
  source: string,
  expectedIdentity: DirectoryIdentity,
  expectedBytes: Buffer,
  runRoot: string,
  limits: RetentionLimits,
): Promise<void> {
  const quarantine = `${source}.cleanup-${randomUUID()}`;
  const name = "Pi agent-directory private temporary file";
  try {
    await rename(source, quarantine);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  try {
    const info = await lstatRequired(quarantine, `${name} quarantine`);
    assertPrivateFile(info, `${name} quarantine`);
    if (!sameDirectoryIdentity(directoryIdentityOf(info), expectedIdentity)) {
      throw new PreparationLockRace(`${name} was replaced`);
    }
    const actualBytes = await readStableFile(quarantine, `${name} quarantine`);
    if (!actualBytes.equals(expectedBytes)) throw new PreparationLockRace(`${name} contents changed`);

    const retained = await freshRetainedPath(runRoot, name, limits, "private-temporary-file", source, expectedIdentity, "file", quarantine);
    const beforeHandoffInfo = await lstatRequired(quarantine, `${name} before retention`);
    assertPrivateFile(beforeHandoffInfo, `${name} before retention`);
    if (!sameDirectoryIdentity(directoryIdentityOf(beforeHandoffInfo), expectedIdentity)) {
      throw new PreparationLockRace(`${name} was replaced before retention`);
    }
    try { await rename(quarantine, retained.retainedPath); }
    catch (error) {
      if (isNotFound(error)) throw new PreparationLockRace(`${name} disappeared before retention`, error);
      throw error;
    }
    const retainedInfo = await lstatRequired(retained.retainedPath, `${name} retained file`);
    assertPrivateFile(retainedInfo, `${name} retained file`);
    if (!sameDirectoryIdentity(directoryIdentityOf(retainedInfo), expectedIdentity)) {
      throw new PreparationLockRace(`${name} retained file was replaced before verification`);
    }
    const retainedBytes = await readStableFile(retained.retainedPath, `${name} retained file`);
    if (!retainedBytes.equals(expectedBytes)) throw new PreparationLockRace(`${name} retained file contents changed`);
  } catch (error) {
    // A missing cleanup pathname can mean that a replacement won the final
    // atomic handoff. Keep the run fenced while trusted cleanup investigates;
    // never unlink the path by name.
    if (await pathKind(quarantine) === "missing") await createQuarantineFence(runRoot, name, source, expectedIdentity, limits);
    if (isNotFound(error)) throw new PreparationLockRace(`${name} disappeared before retention`, error);
    throw error;
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

async function removeNewPreparationLock(
  directory: string,
  expectedIdentity: DirectoryIdentity | undefined,
  expectedOwner: PreparationLockOwner | undefined,
  limits: RetentionLimits,
  captureBarrier: PreparationCaptureBarrier | undefined,
): Promise<void> {
  if (!expectedIdentity) return;
  await captureAndRetainDirectory(
    directory,
    path.dirname(directory),
    expectedIdentity,
    "Pi agent-directory preparation lock",
    quarantine => verifyCapturedPreparationLock(quarantine, expectedIdentity, expectedOwner, undefined, undefined, true),
    captureBarrier,
    limits,
    "preparation-lock",
  );
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
