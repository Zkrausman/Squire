import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmod, link, lstat, lutimes, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeWikiProfile, type PiModelProfile, type PiWikiProfileInput } from "./pi-configuration.js";
import type { RunPreparationLease, RunTerminalFence, RuntimeModelCapability, RuntimeResolution } from "../control/domain.js";
import type { RunQuiescenceAuthority } from "../control/workflow-store.js";
import { buildTrustedWikiFooterExtensionSource } from "./wiki-footer.js";
import { buildTrustedPlanExtensionSource } from "../plan/plan-extension.js";
import { PLAN_EXTENSION_RELATIVE_PATH } from "../plan/domain.js";

const AGENT_DIRECTORY_KIND = "squire-pi-agent-directory";
const AGENT_DIRECTORY_SCHEMA_VERSION = 1;
const WIKI_PACKAGE_NAME = "@zosmaai/pi-llm-wiki";
const FOOTER_FILE = "extensions/squire-trusted-wiki-footer.mjs";
const PLAN_FILE = PLAN_EXTENSION_RELATIVE_PATH;
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
const ACTIVE_PREPARATION_RUNS = new Map<string, number>();
const PREPARATION_QUARANTINE_PREFIX = ".pi-agent-quarantine-";
const PREPARATION_RETAINED_DIRECTORY = ".pi-agent-quarantine-retained";
const PREPARATION_RETAINED_DISPOSAL_DIRECTORY = ".disposal";
const PREPARATION_RETAINED_PREFIX = "capture-";
const PREPARATION_RETAINED_RECORD_SUFFIX = ".json";
const PREPARATION_RETAINED_AUTH_FILE = ".capture-auth-key";
const PREPARATION_RETAINED_AUTH_TEMP = /^\.capture-auth-key\.tmp-[0-9a-f-]{36}$/u;
const PREPARATION_RETAINED_ALLOCATION_LOCK = ".allocation-lock";
const PREPARATION_RETAINED_ALLOCATION_HELD = /^\.allocation-lock-held-[0-9a-f-]{36}$/u;
const PREPARATION_RETAINED_ALLOCATION_OWNER_FILE = "owner.json";
const PREPARATION_RETAINED_ALLOCATION_CLAIM_FILE = ".claim";
const PREPARATION_RETAINED_ALLOCATION_ROOT_MARKER = ".allocation-lock-root";
const PREPARATION_RETAINED_ALLOCATION_ROOT_MARKER_BYTES = Buffer.from("squire-pi-agent-retention-root-v1\n", "utf8");
const PREPARATION_TERMINAL_FENCE_ROOT = ".pi-agent-terminal-fences";
const PREPARATION_TERMINAL_DISPOSAL_DIRECTORY = ".sandbox-disposal";
const PREPARATION_TERMINAL_FENCE_FILE = "fence.json";
const PREPARATION_TERMINAL_FENCE_TEMP = /^\.terminal-fence-[A-Za-z0-9._-]+-[0-9a-f-]{36}$/u;
const PREPARATION_TERMINAL_FENCE_KIND = "squire-pi-agent-terminal-fence";
const PREPARATION_TERMINAL_FENCE_SCHEMA_VERSION = 1;
const PREPARATION_RETAINED_ALLOCATION_KIND = "squire-pi-agent-retention-allocation-lock";
const PREPARATION_CAPTURE_METADATA_FILE = "capture.json";
const PREPARATION_CAPTURE_METADATA_TEMP = /^\.capture\.json\.tmp-[0-9a-f-]{36}$/u;
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
const AUTHORITY_DEFAULT_MATERIALIZERS = new WeakMap<RunQuiescenceAuthority, Map<string, PiAgentDirectoryMaterializer>>();
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
const PREPARATION_RETAINED_RECORD_TEMP = /^\.capture-([0-9a-f-]{36})\.json\.tmp-[0-9a-f-]{36}$/u;
const PREPARATION_RETAINED_DISPOSAL = /^\.teardown-(run_[A-Za-z0-9][A-Za-z0-9._-]{0,127})-[0-9a-f-]{36}-(?:capture-[0-9a-f-]{36}(?:\.json)?|run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}|\..+)$/u;
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
  /** Ordered trusted extension paths for role-specific launches. */
  trustedExtensionPathsByRole?: Readonly<Partial<Record<"plan" | "implement" | "review" | "test" | "orchestrator", readonly string[]>>>;
  /** The Plan submission extension is loaded only for the Plan role. */
  planExtensionPath?: string;
  planExtensionDigest?: string;
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

/** Internal seam used to synchronize a deterministic competing reclaim-marker
 * replacement immediately after the current marker identity is observed. */
export type PreparationReclaimObservationBarrier = (event: {
  stage: "after-marker-created";
  directory: string;
}) => void | Promise<void>;

export type PreparationReclaimReleaseBarrier = (event: {
  stage: "after-identity-observation";
  directory: string;
}) => void | Promise<void>;

/** Barrier placed immediately after the final no-terminal-fence observation. */
export type PreparationFenceBarrier = (event: {
  runId: string;
  operation: "materialize" | "verify";
  stage: "after-no-fence-observation";
}) => void | Promise<void>;

export type RetainedCaptureType = (typeof PREPARATION_CAPTURE_TYPES)[number];

/** A trusted controller callback. It must prove that every role process and
 * every controller that can touch this run has quiesced before teardown. */
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
  /** Internal deterministic reclaim-marker observation seam; omitted in production. */
  preparationReclaimObservationBarrier?: PreparationReclaimObservationBarrier;
  /** Internal deterministic reclaim-marker replacement seam; omitted in production. */
  preparationReclaimReleaseBarrier?: PreparationReclaimReleaseBarrier;
  /** Internal cross-process race seam immediately after the final fence observation. */
  preparationFenceBarrier?: PreparationFenceBarrier;
  /** Durable workflow authority required before materialize/verify and for teardown. */
  runLifecycleAuthority: RunQuiescenceAuthority;
  /** Internal deterministic publication crash seam; omitted in production. */
  retentionPublicationBarrier?: RetentionPublicationBarrier;
  /** Internal deterministic auth-key handoff seam; omitted in production. */
  retentionAuthCleanupBarrier?: RetentionAuthCleanupBarrier;
  /** Internal deterministic retained-allocation claim seam; omitted in production. */
  retentionAllocationClaimBarrier?: RetentionAllocationClaimBarrier;
  /** Maximum retained capture records for one run. */
  maxRetainedCapturesPerRun?: number;
  /** Maximum retained capture records across this runtime root. */
  maxRetainedCapturesGlobal?: number;
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
    planExtension: { path: typeof PLAN_FILE; sha256: string };
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
  trustedExtensionSets: {
    readonly default: readonly [string, string];
    readonly plan: readonly [string, string, string];
  };
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
  planDigest: string;
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
  runId?: string;
  requestFingerprint?: string;
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
  publicationBarrier: RetentionPublicationBarrier | undefined;
  authCleanupBarrier: RetentionAuthCleanupBarrier | undefined;
  allocationClaimBarrier: RetentionAllocationClaimBarrier | undefined;
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

type TerminalFenceSandboxIdentity = { dev: string; ino: string } | null;
interface TerminalFencePayload extends RunTerminalFence {
  schemaVersion: typeof PREPARATION_TERMINAL_FENCE_SCHEMA_VERSION;
  kind: typeof PREPARATION_TERMINAL_FENCE_KIND;
  sandboxIdentity: TerminalFenceSandboxIdentity;
  auth: string;
}
interface TerminalFenceRecord extends RunTerminalFence {
  sandboxIdentity: TerminalFenceSandboxIdentity;
}

export type RetentionPublicationKind = "auth-key" | "capture-record" | "terminal-fence" | "fence-metadata";
export type RetentionPublicationStage = "temporary-written" | "before-temporary-read" | "before-final-publication" | "final-published";
export type RetentionPublicationBarrier = (event: {
  kind: RetentionPublicationKind;
  stage: RetentionPublicationStage;
  temporaryPath: string;
  finalPath: string;
}) => void | Promise<void>;

/** Internal seam used to place a deterministic handoff between an observer's
 * auth-key temporary scan and its identity-checked cleanup. */
export type RetentionAuthCleanupBarrier = (event: {
  stage: "after-observation-before-cleanup";
  temporaryPath: string;
  finalPath: string;
}) => void | Promise<void>;

/** Internal seam used to synchronize same-run retained-allocation contenders. */
export type RetentionAllocationClaimBarrier = (event: {
  stage: "before-claim";
  directory: string;
}) => void | Promise<void>;

type TeardownAuthorityGuard = () => Promise<void>;

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

/** A fully authenticated capture record exists, but its fence metadata has
 * not reached a final name yet. Normal owners leave this state alone; a
 * trusted teardown may discard it after proving quiescence. */
class IncompleteQuarantineFence extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteQuarantineFence";
  }
}

/** A record construction pathname was interrupted before a complete
 * authenticated record reached its final name. */
class IncompleteRetainedRecordPublication extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteRetainedRecordPublication";
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
    await assertNoTerminalFence(path.dirname(this.directory));
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

  constructor(options: PiAgentDirectoryMaterializerOptions) {
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
    const activeKey = path.resolve(this.#options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, request.runId);
    markActivePreparation(activeKey);
    const promise = this.#materialize(request, profile);
    this.#inFlight.set(request.runId, { fingerprint, promise });
    void promise.then(
      () => {
        const current = this.#inFlight.get(request.runId);
        if (current?.promise === promise) this.#inFlight.delete(request.runId);
        unmarkActivePreparation(activeKey);
      },
      () => {
        const current = this.#inFlight.get(request.runId);
        if (current?.promise === promise) this.#inFlight.delete(request.runId);
        unmarkActivePreparation(activeKey);
      },
    );
    return promise;
  }

  /** Alias for callers that name the port `prepare`. */
  prepare(request: PiAgentDirectoryRequest): Promise<MaterializedPiAgentDirectory> {
    return this.materialize(request);
  }

  /**
   * Acquire the durable workflow fence first, then publish the matching
   * filesystem fence before any cleanup. The workflow authority keeps this
   * run blocked across controller restarts; the filesystem fence blocks
   * materializers that do not share the controller instance.
   */
  async teardown(runId: string, signal?: AbortSignal): Promise<PiAgentDirectoryTeardownResult> {
    assertRunId(runId);
    throwIfAborted(signal);
    if (this.#inFlight.has(runId)) throw new Error("Pi agent-directory teardown cannot run during materialization");
    const activeKey = path.resolve(this.#options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, runId);
    if (ACTIVE_PREPARATION_RUNS.has(activeKey)) throw new Error("Pi agent-directory teardown found a live preparation controller");
    const authority = this.#options.runLifecycleAuthority;
    if (!authority) throw new Error("durable workflow quiescence authority is required for Pi agent-directory teardown");
    const runtimeRoot = absoluteDirectory(this.#options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, "runtime root");
    const runRoot = path.resolve(runtimeRoot, runId);
    await rejectSymlinkedAncestors(runtimeRoot, "runtime root");
    const fence = await authority.acquireRunTerminalFence(runId, `pi-teardown-${randomUUID()}`, Date.now());
    const assertTrustedTeardown: TeardownAuthorityGuard = () => authority.assertRunTeardownQuiescent(runId, fence, Date.now());
    // Never release this fence. A failed teardown remains retryable only by a
    // trusted controller and continues to reject every new role/controller.
    const terminalFenceRoot = path.join(runtimeRoot, PREPARATION_TERMINAL_FENCE_ROOT);
    const publishedFencePath = path.join(terminalFenceRoot, runId);
    const runKind = await pathKind(runRoot);
    if (runKind === "missing" && await pathKind(publishedFencePath) === "directory") {
      // Finish any concurrent/previous terminal-fence construction handoff
      // before the retry path asks assertTerminalFence to authorize cleanup.
      await publishTerminalFence(runRoot, runtimeRoot, fence, this.#retentionLimits.publicationBarrier, assertTrustedTeardown, this.#retentionLimits.authCleanupBarrier);
      const published = await readTerminalFenceDirectory(publishedFencePath, runtimeRoot);
      if (published.runId !== fence.runId || published.owner !== fence.owner || published.fencingToken !== fence.fencingToken) throw new PreparationLockRace("Pi agent-directory terminal fence ownership changed during retry");
      const capturesRemoved = await removeRetainedCapturesAfterQuiescence(runtimeRoot, runId, this.#retentionLimits, signal, assertTrustedTeardown);
      await removeTerminalSandboxDisposals(runtimeRoot, runRoot, published, signal, assertTrustedTeardown);
      await authority.completeRunTeardown(runId, fence, Date.now());
      return { runId, capturesRemoved, fencesRemoved: 0 };
    }
    await ensureBaseRunLayout({
      runtimeRoot,
      workspace: absoluteDirectory(this.#options.workspace ?? DEFAULT_WORKSPACE, "workspace"),
      runRoot,
      agentDir: path.join(runRoot, "pi-agent"),
      homeDir: path.join(runRoot, "home"),
      wikiHomeDir: path.join(runRoot, "wiki-home"),
    });
    await publishTerminalFence(runRoot, runtimeRoot, fence, this.#retentionLimits.publicationBarrier, assertTrustedTeardown, this.#retentionLimits.authCleanupBarrier);
    const staleMs = positiveInteger(this.#options.preparationLockStaleMs ?? PREPARATION_LOCK_STALE_MS, "preparation lock stale timeout");
    await assertPreparationLifecycleQuiescent(runRoot, staleMs, assertTrustedTeardown);
    // A crash can leave a complete or partial retained-record construction
    // pathname. Once the durable/filesystem fences and quiescence proof are
    // held, construction-only names are safe to discard before the strict
    // authenticated ledger scan; final records are never touched here.
    const retentionLocation = await ensureRetentionLocation(runRoot, this.#retentionLimits.publicationBarrier, false, undefined, this.#retentionLimits.authCleanupBarrier);
    // Recover a prior teardown's private disposal objects before scanning the
    // ledger. This keeps an interrupted destructive handoff retryable without
    // ever treating its temporary pathname as a new capture.
    await clearRetainedDisposalEntries(retentionLocation.retainedRoot, runId, assertTrustedTeardown);
    // First resume complete authenticated record temporaries. Only
    // construction names that cannot be resumed are discarded under the
    // already-held teardown fence.
    await reconcileRetainedCaptures(runtimeRoot, runId, this.#retentionLimits, signal, true, assertTrustedTeardown);
    await clearRetainedConstructionEntries(
      retentionLocation.retainedRun,
      path.join(retentionLocation.retainedRoot, PREPARATION_RETAINED_DISPOSAL_DIRECTORY),
      runId,
      assertTrustedTeardown,
    );
    const fencesRemoved = await reconcilePreparationLifecycle(runRoot, this.#retentionLimits, staleMs, signal, true, assertTrustedTeardown);
    await removeLivePreparationLockAfterQuiescence(runRoot, runId, signal, assertTrustedTeardown);
    await assertNoLivePreparationState(runRoot);
    const capturesRemoved = await removeRetainedCapturesAfterQuiescence(runtimeRoot, runId, this.#retentionLimits, signal, assertTrustedTeardown);
    await assertNoLivePreparationState(runRoot);
    await removeRunSandboxAfterTerminalFence(runtimeRoot, runRoot, signal, assertTrustedTeardown);
    await authority.completeRunTeardown(runId, fence, Date.now());
    return { runId, capturesRemoved, fencesRemoved };
  }

  async #materialize(request: PiAgentDirectoryRequest, profile: PiModelProfile): Promise<MaterializedPiAgentDirectory> {
    throwIfAborted(request.signal);
    const lease = await this.#acquirePreparationLease(request.runId);
    try {
      return await this.#materializeUnderLease(request, profile);
    } finally {
      await this.#releasePreparationLease(request.runId, lease);
    }
  }

  async #materializeUnderLease(request: PiAgentDirectoryRequest, profile: PiModelProfile): Promise<MaterializedPiAgentDirectory> {
    await this.#assertRunStartAllowed(request.runId);
    const prepared = await this.#prepare(request, profile);
    await this.#assertRunStartAllowed(request.runId);
    await reconcilePreparationLifecycle(
      prepared.layout.runRoot,
      this.#retentionLimits,
      positiveInteger(this.#options.preparationLockStaleMs ?? PREPARATION_LOCK_STALE_MS, "preparation lock stale timeout"),
      request.signal,
    );
    const requestFingerprint = materializationFingerprint(prepared);
    await assertNoTerminalFence(prepared.layout.runRoot);
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
          await assertNoTerminalFence(prepared.layout.runRoot);
          await verifyCompletedMaterializationLock(prepared.layout, request.runId, requestFingerprint, this.#options, this.#retentionLimits, request.signal);
          await verifyRunLayout(prepared.layout, true, "optional");
          await verifyAgentDirectory(prepared.layout.agentDir, prepared.expected, prepared.entries.map(entry => entry.path));
          await assertNoTerminalFence(prepared.layout.runRoot);
          await this.#afterPreparationFenceObservation(request.runId, "materialize");
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
        await assertNoTerminalFence(prepared.layout.runRoot);
        await this.#afterPreparationFenceObservation(request.runId, "materialize");
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
    const activeKey = path.resolve(this.#options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, request.runId);
    markActivePreparation(activeKey);
    try {
      await this.#verify(request, materialized);
    } finally {
      unmarkActivePreparation(activeKey);
    }
  }

  async #verify(request: PiAgentDirectoryRequest, materialized: MaterializedPiAgentDirectory): Promise<void> {
    throwIfAborted(request.signal);
    const lease = await this.#acquirePreparationLease(request.runId);
    try {
      await this.#verifyUnderLease(request, materialized);
    } finally {
      await this.#releasePreparationLease(request.runId, lease);
    }
  }

  async #verifyUnderLease(request: PiAgentDirectoryRequest, materialized: MaterializedPiAgentDirectory): Promise<void> {
    assertRunId(request.runId);
    await this.#assertRunStartAllowed(request.runId);
    const profile = normalizeWikiProfile(request.wikiProfile);
    const prepared = await this.#prepare(request, profile);
    await this.#assertRunStartAllowed(request.runId);
    await reconcilePreparationLifecycle(
      prepared.layout.runRoot,
      this.#retentionLimits,
      positiveInteger(this.#options.preparationLockStaleMs ?? PREPARATION_LOCK_STALE_MS, "preparation lock stale timeout"),
      request.signal,
    );
    const requestFingerprint = materializationFingerprint(prepared);
    await assertNoTerminalFence(prepared.layout.runRoot);
    const lock = await acquirePreparationLock(
      prepared.layout,
      requestFingerprint,
      this.#options,
      this.#retentionLimits,
      request.signal,
    );
    const expected = materializedResult(request.runId, prepared);
    if (!lock) {
      await assertNoTerminalFence(prepared.layout.runRoot);
      await verifyCompletedMaterializationLock(prepared.layout, request.runId, requestFingerprint, this.#options, this.#retentionLimits, request.signal);
      await ensureProjectWikiOverrideIsNotConflicting(prepared.layout.workspace, profile, request.signal);
      if (!sameMaterializedResult(materialized, expected)) throw new Error("materialized Pi agent-directory result changed during verification");
      await verifyRunLayout(prepared.layout, true, "optional");
      await verifyAgentDirectory(prepared.layout.agentDir, prepared.expected, prepared.entries.map(entry => entry.path));
      await assertNoTerminalFence(prepared.layout.runRoot);
      await this.#afterPreparationFenceObservation(request.runId, "verify");
      return;
    }
    try {
      await lock.assertHealthy();
      await ensureProjectWikiOverrideIsNotConflicting(prepared.layout.workspace, profile, request.signal);
      if (!sameMaterializedResult(materialized, expected)) throw new Error("materialized Pi agent-directory result changed during verification");
      await verifyRunLayout(prepared.layout, true, true);
      await verifyAgentDirectory(prepared.layout.agentDir, prepared.expected, prepared.entries.map(entry => entry.path));
      await assertNoTerminalFence(prepared.layout.runRoot);
      await this.#afterPreparationFenceObservation(request.runId, "verify");
    } finally {
      await lock.release();
    }
  }

  async #afterPreparationFenceObservation(runId: string, operation: "materialize" | "verify"): Promise<void> {
    await this.#options.preparationFenceBarrier?.({ runId, operation, stage: "after-no-fence-observation" });
  }

  async #acquirePreparationLease(runId: string): Promise<RunPreparationLease> {
    const authority = this.#options.runLifecycleAuthority;
    if (!authority) throw new Error("durable workflow lifecycle authority is required for Pi agent-directory preparation");
    return authority.acquireRunPreparationLease(runId, `pi-preparation-${randomUUID()}`, Date.now());
  }

  async #releasePreparationLease(runId: string, lease: RunPreparationLease): Promise<void> {
    const authority = this.#options.runLifecycleAuthority;
    if (!authority) throw new Error("durable workflow lifecycle authority disappeared during Pi agent-directory preparation");
    await authority.releaseRunPreparationLease(runId, lease, Date.now());
  }

  async #assertRunStartAllowed(runId: string): Promise<void> {
    const runtimeRoot = absoluteDirectory(this.#options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, "runtime root");
    const runRoot = path.resolve(runtimeRoot, runId);
    await assertNoTerminalFence(runRoot);
    await this.#options.runLifecycleAuthority.assertRunStartAllowed(runId, Date.now());
    await assertNoTerminalFence(runRoot);
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
    const planSource = Buffer.from(buildTrustedPlanExtensionSource(), "utf8");
    const planDigest = sha256(planSource);
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
        planExtension: { path: PLAN_FILE, sha256: planDigest },
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
      trustedExtensionSets: {
        default: [wikiExtension, footerPath(layout.agentDir)],
        plan: [wikiExtension, path.join(layout.agentDir, PLAN_FILE), footerPath(layout.agentDir)],
      },
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const authFile = authEntry ? { path: path.resolve(layout.agentDir, authEntry.relativePath), bytes: authEntry.bytes, mode: 0o600 } : undefined;
    const entries: FileSystemEntry[] = [
      { path: SETTINGS_FILE, bytes: settingsBytes, mode: 0o600 },
      { path: FOOTER_FILE, bytes: footerSource, mode: 0o600 },
      { path: PLAN_FILE, bytes: planSource, mode: 0o600 },
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
      planDigest,
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
    if ([SETTINGS_FILE, FOOTER_FILE, PLAN_FILE, MANIFEST_FILE, PI_MODELS_STORE_FILE].includes(relativePath)) {
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
  workspace: string | undefined,
  runLifecycleAuthority: RunQuiescenceAuthority,
  runtimeRoot?: string,
): PiAgentDirectoryMaterializer {
  const key = `${path.resolve(runtimeRoot ?? DEFAULT_RUNTIME_ROOT)}\u0000${path.resolve(workspace ?? DEFAULT_WORKSPACE)}`;
  const registry = AUTHORITY_DEFAULT_MATERIALIZERS.get(runLifecycleAuthority) ?? new Map<string, PiAgentDirectoryMaterializer>();
  const existing = registry.get(key);
  if (existing) return existing;
  const created = new PiAgentDirectoryMaterializer({
    ...(workspace ? { workspace } : {}),
    ...(runtimeRoot ? { runtimeRoot } : {}),
    runLifecycleAuthority,
  });
  registry.set(key, created);
  if (!AUTHORITY_DEFAULT_MATERIALIZERS.has(runLifecycleAuthority)) {
    AUTHORITY_DEFAULT_MATERIALIZERS.set(runLifecycleAuthority, registry);
  }
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
  const planBytes = await readStableFile(path.join(agentDir, expected.files.planExtension.path), "trusted Plan extension");
  if (sha256(planBytes) !== expected.files.planExtension.sha256) throw new Error("trusted Plan extension digest mismatch");
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
      if (await reclaimStalePreparationLock(layout, runId, requestFingerprint, observation, staleMs, options.preparationCaptureBarrier, options.preparationReclaimObservationBarrier, options.preparationReclaimReleaseBarrier, limits, signal)) continue;
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
    await assertNoTerminalFence(layout.runRoot);
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
      if (await reclaimStalePreparationLock(layout, path.basename(layout.runRoot), requestFingerprint, observation, staleMs, options.preparationCaptureBarrier, options.preparationReclaimObservationBarrier, options.preparationReclaimReleaseBarrier, limits, signal)) continue;
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
  await assertNoTerminalFence(layout.runRoot);
  if (await hasPreparationQuarantine(layout)) return undefined;
  await assertNoTerminalFence(layout.runRoot);
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
    const captured = await findRetainedRecordForQuarantine(runRoot, quarantine, true);
    if (captured.record.objectKind !== "directory") throw new Error("Pi agent-directory quarantine metadata has an invalid object kind");
    if (captured.record.state !== "fence" && !sameIdentityRecord(captured.record.capturedIdentity, directoryIdentityOf(info))) {
      throw new PreparationLockRace("Pi agent-directory quarantine was replaced");
    }
    try { await verifyFenceMetadata(quarantine, captured.record); }
    catch (error) {
      if (!(error instanceof IncompleteQuarantineFence)) throw error;
    }
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
  observationBarrier: PreparationReclaimObservationBarrier | undefined,
  releaseBarrier: PreparationReclaimReleaseBarrier | undefined,
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
      runId,
      requestFingerprint,
      token: randomUUID(),
      pid: process.pid,
      createdAt: Date.now(),
    };
    await writePrivateFileAtomically(path.join(reclaimDirectory, PREPARATION_LOCK_RECLAIM_OWNER_FILE), serializeReclaimOwner(reclaimOwner), 0o600, path.resolve(reclaimDirectory, "..", ".."), limits);
    reclaimOwnerWritten = true;
    await observationBarrier?.({ stage: "after-marker-created", directory: reclaimDirectory });
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
    if (error instanceof PreparationLockRace && reclaimOwner) {
      const replacement = await classifyReclaimMarkerReplacement(reclaimDirectory, reclaimOwner);
      if (replacement === "missing" || replacement === "legitimate" || replacement === "retry") return false;
    }
    if (error instanceof PreparationLockRace) throw error;
    if (isTransientLockRace(error)) return false;
    throw error;
  } finally {
    try {
      if (await pathKind(lockDirectory) === "directory") {
        await releaseReclaimMarker(reclaimDirectory, reclaimOwner, reclaimIdentity, releaseBarrier, captureBarrier, limits);
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

type ReclaimMarkerReplacement = "missing" | "legitimate" | "retry" | "conflict";

async function classifyReclaimMarkerReplacement(directory: string, expected: PreparationReclaimOwner): Promise<ReclaimMarkerReplacement> {
  let kind: Awaited<ReturnType<typeof pathKind>>;
  try { kind = await pathKind(directory); }
  catch (error) {
    return isTransientLockRace(error) ? "retry" : "conflict";
  }
  if (kind === "missing") return "missing";
  if (kind !== "directory") return "conflict";
  try {
    const info = await lstatRequired(directory, "Pi agent-directory lock reclaim marker");
    assertPrivateDirectory(info, "Pi agent-directory lock reclaim marker");
    const identity = directoryIdentityOf(info);
    await verifyReclaimMarkerEntries(directory, true, identity);
    const actual = await readReclaimOwner(path.join(directory, PREPARATION_LOCK_RECLAIM_OWNER_FILE));
    if (actual.runId !== expected.runId || actual.requestFingerprint !== expected.requestFingerprint) return "conflict";
    // A replacement must be a later, independently-created marker for the
    // same authenticated request. Same-identity/content changes and a
    // conflicting request are never treated as a convergence winner; a
    // completed winner may already have exited before its stale marker is
    // reconciled.
    if (sameReclaimOwner(actual, expected) || actual.createdAt < expected.createdAt) return "conflict";
    await assertStableDirectoryIdentity(directory, identity, "Pi agent-directory lock reclaim marker");
    return "legitimate";
  } catch (error) {
    return isTransientLockRace(error) ? "retry" : "conflict";
  }
}

async function releaseReclaimMarker(
  directory: string,
  owner: PreparationReclaimOwner | undefined,
  expectedIdentity: DirectoryIdentity | undefined,
  releaseBarrier: PreparationReclaimReleaseBarrier | undefined,
  captureBarrier: PreparationCaptureBarrier | undefined,
  limits: RetentionLimits,
): Promise<void> {
  if (!owner) return;
  let lastRace: unknown;
  for (let attempt = 0; attempt < PREPARATION_LOCK_RACE_RETRIES; attempt += 1) {
    try {
      const kind = await pathKind(directory);
      if (kind === "missing") return;
      if (kind !== "directory") throw new PreparationLockRace("Pi agent-directory lock reclaim marker was replaced");
      const info = await lstatRequired(directory, "Pi agent-directory lock reclaim marker");
      assertPrivateDirectory(info, "Pi agent-directory lock reclaim marker");
      const identity = directoryIdentityOf(info);
      if (expectedIdentity && !sameDirectoryIdentity(identity, expectedIdentity)) {
        const replacement = await classifyReclaimMarkerReplacement(directory, owner);
        if (replacement === "missing" || replacement === "legitimate") return;
        if (replacement === "retry") throw new PreparationLockRace("Pi agent-directory lock reclaim marker replacement is still changing");
        throw new PreparationLockRace("Pi agent-directory lock reclaim marker was replaced");
      }
      await releaseBarrier?.({ stage: "after-identity-observation", directory });
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
      if (error instanceof PreparationLockRace) {
        const replacement = await classifyReclaimMarkerReplacement(directory, owner);
        if (replacement === "missing" || replacement === "legitimate") return;
        if (replacement === "retry") {
          lastRace = error;
          if (attempt + 1 < PREPARATION_LOCK_RACE_RETRIES) await waitForDelay(PREPARATION_LOCK_RACE_DELAY_MS);
          continue;
        }
        throw error;
      }
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
    publicationBarrier: options.retentionPublicationBarrier,
    authCleanupBarrier: options.retentionAuthCleanupBarrier,
    allocationClaimBarrier: options.retentionAllocationClaimBarrier,
  };
}

/** Identity-check construction-file cleanup. Teardown callers pass the same
 * persisted quiescence guard that brackets their destructive operation;
 * ordinary publication cleanup remains owned by its active preparation lease. */
async function removeConstructionFile(filePath: string, expected: Awaited<ReturnType<typeof lstat>>, teardownAuthority?: TeardownAuthorityGuard): Promise<void> {
  const before = await lstat(filePath);
  if (before.dev !== expected.dev || before.ino !== expected.ino) throw new PreparationLockRace("private publication temporary file changed before cleanup");
  await teardownAuthority?.();
  const final = await lstat(filePath);
  if (final.dev !== expected.dev || final.ino !== expected.ino) throw new PreparationLockRace("private publication temporary file changed before cleanup");
  await teardownAuthority?.();
  await rm(filePath, { recursive: false, force: false });
  await teardownAuthority?.();
}

/** Move an identity-checked object out of its shared pathname before the only
 * recursive removal. A compliant controller cannot recreate the source after
 * the terminal fence; if an untrusted actor did replace it before the move,
 * the identity check fails and the moved replacement is restored rather than
 * being destructively removed. Every ordinary recursive removal is bracketed
 * by the persisted teardown proof immediately before and after `rm`. */
async function removeOwnedPathAfterQuiescence(
  target: string,
  expectedIdentity: DirectoryIdentity,
  recursive: boolean,
  name: string,
  teardownAuthority: TeardownAuthorityGuard,
  disposalDirectory = path.dirname(target),
  disposalRunId?: string,
): Promise<void> {
  if (!teardownAuthority) throw new Error("trusted teardown authority is required for destructive disposal");
  const kind = await pathKind(target);
  if (kind === "missing") return;
  const before = await lstatRequired(target, `${name} before disposal`);
  if (recursive) assertPrivateDirectory(before, `${name} before disposal`);
  else assertPrivateFile(before, `${name} before disposal`);
  if (!sameDirectoryIdentity(directoryIdentityOf(before), expectedIdentity)) {
    throw new PreparationLockRace(`${name} changed before disposal`);
  }
  const disposalName = disposalRunId
    ? `.teardown-${disposalRunId}-${randomUUID()}-${path.basename(target)}`
    : `.${path.basename(target)}.teardown-${randomUUID()}`;
  const disposal = path.join(disposalDirectory, disposalName);
  if (await pathKind(disposal) !== "missing") throw new PreparationLockRace(`${name} disposal path already exists`);
  await teardownAuthority();
  try { await rename(target, disposal); }
  catch (error) {
    if (isNotFound(error)) throw new PreparationLockRace(`${name} disappeared before disposal`, error);
    throw error;
  }
  try {
    const moved = await lstatRequired(disposal, `${name} disposal`);
    if (recursive) assertPrivateDirectory(moved, `${name} disposal`);
    else assertPrivateFile(moved, `${name} disposal`);
    if (!sameDirectoryIdentity(directoryIdentityOf(moved), expectedIdentity)) {
      throw new PreparationLockRace(`${name} was replaced before disposal`);
    }
    await teardownAuthority();
    const final = await lstatRequired(disposal, `${name} disposal before removal`);
    if (recursive) assertPrivateDirectory(final, `${name} disposal before removal`);
    else assertPrivateFile(final, `${name} disposal before removal`);
    if (!sameDirectoryIdentity(directoryIdentityOf(final), expectedIdentity)) {
      throw new PreparationLockRace(`${name} changed before removal`);
    }
    await teardownAuthority();
    await rm(disposal, { recursive, force: false });
    await teardownAuthority();
  } catch (error) {
    if (await pathKind(disposal) !== "missing" && await pathKind(target) === "missing") {
      try { await rename(disposal, target); } catch { /* preserve the object and fail closed */ }
    }
    throw error;
  }
}

function isPublicationReadRace(error: unknown): boolean {
  return isNotFound(error)
    || error instanceof Error && /changed while it was being read/iu.test(error.message)
    || error instanceof PreparationLockRace && /did not stabilize after publication/iu.test(error.message);
}

async function recoverPrivatePublicationHandoff(
  temporaryPath: string,
  temporaryInfo: Awaited<ReturnType<typeof lstat>>,
  finalPath: string,
  expectedBytes: Buffer,
  initialError: unknown,
): Promise<void> {
  let lastError: unknown = initialError;
  for (let attempt = 0; attempt < PREPARATION_LOCK_RACE_RETRIES; attempt += 1) {
    try {
      const temporaryKind = await pathKind(temporaryPath);
      let currentTemporaryInfo: Awaited<ReturnType<typeof lstat>> | undefined;
      if (temporaryKind === "file") {
        currentTemporaryInfo = await lstatRequired(temporaryPath, "private publication temporary file during handoff");
        assertPrivateFile(currentTemporaryInfo, "private publication temporary file during handoff");
        if (currentTemporaryInfo.dev !== temporaryInfo.dev || currentTemporaryInfo.ino !== temporaryInfo.ino) {
          throw new PreparationLockRace("private publication temporary file identity changed during handoff");
        }
      } else if (temporaryKind !== "missing") {
        throw new PreparationLockRace("private publication temporary path was replaced during handoff");
      }

      const finalInfo = await lstatRequired(finalPath, "private publication recovered final file");
      assertPrivateFile(finalInfo, "private publication recovered final file");
      const finalBytes = await readStablePublicationFile(finalPath, "private publication recovered final file");
      if (!finalBytes.equals(expectedBytes)) {
        throw new PreparationLockRace("private publication recovered final file contains conflicting bytes");
      }

      if (temporaryKind === "file") {
        if (!currentTemporaryInfo) throw new PreparationLockRace("private publication temporary file identity was lost during handoff");
        if (currentTemporaryInfo.dev !== finalInfo.dev || currentTemporaryInfo.ino !== finalInfo.ino) {
          const currentBytes = await readStableFile(temporaryPath, "private publication alternate temporary file");
          if (!currentBytes.equals(expectedBytes)) {
            throw new PreparationLockRace("private publication alternate temporary file contains conflicting bytes");
          }
        }
        try { await removeConstructionFile(temporaryPath, temporaryInfo); }
        catch (error) { if (!isNotFound(error)) throw error; }
      }
      return;
    } catch (error) {
      if (!isPublicationReadRace(error)) throw error;
      lastError = error;
      if (attempt + 1 < PREPARATION_LOCK_RACE_RETRIES) await waitForDelay(PREPARATION_LOCK_RACE_DELAY_MS);
    }
  }
  throw new PreparationLockRace("private publication authenticated final handoff did not stabilize", lastError);
}

async function publishPrivateFile(
  finalPath: string,
  bytes: Buffer,
  mode: number,
  temporaryDirectory: string,
  kind: RetentionPublicationKind,
  barrier?: RetentionPublicationBarrier,
  allowExisting = false,
  teardownAuthority?: TeardownAuthorityGuard,
): Promise<boolean> {
  const finalName = path.basename(finalPath);
  const temporaryPath = path.join(temporaryDirectory, `${finalName.startsWith(".") ? finalName : `.${finalName}`}.tmp-${randomUUID()}`);
  let temporaryInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  const existingTemporary = await pathKind(temporaryPath);
  if (existingTemporary !== "missing" && existingTemporary !== "file") throw new Error("private publication temporary path is not a regular file");
  if (existingTemporary === "missing") {
    try { await writeFile(temporaryPath, bytes, { flag: "wx", mode }); }
    catch (error) {
      if (!isAlreadyExists(error)) throw error;
      // A concurrent publisher may have created the fixed construction name;
      // the identity/byte checks below will adopt only that exact object.
    }
  }
  temporaryInfo = await lstatRequired(temporaryPath, "private publication temporary file");
  assertPrivateFile(temporaryInfo, "private publication temporary file");
  await chmod(temporaryPath, mode);
  temporaryInfo = await lstatRequired(temporaryPath, "private publication temporary file");
  assertPrivateFile(temporaryInfo, "private publication temporary file");
  let temporaryBytes: Buffer;
  try {
    temporaryBytes = await readStableFile(
      temporaryPath,
      "private publication temporary file",
      () => barrier?.({ kind, stage: "before-temporary-read", temporaryPath, finalPath }),
    );
  } catch (error) {
    // A retained-record observer can complete this exact construction handoff
    // and change the temporary inode's ctime or remove its construction name
    // while this publisher is doing its stable read. Reuse only an exact,
    // authenticated final handoff; identity changes and conflicting bytes fail
    // closed instead of being hidden behind a retry.
    if (isPublicationReadRace(error)) {
      await recoverPrivatePublicationHandoff(temporaryPath, temporaryInfo, finalPath, bytes, error);
      return false;
    }
    throw new PreparationLockRace("private publication temporary file changed while being read", error);
  }
  if (!temporaryBytes.equals(bytes)) throw new PreparationLockRace("private publication temporary file contains conflicting bytes");
  await barrier?.({ kind, stage: "temporary-written", temporaryPath, finalPath });
  await barrier?.({ kind, stage: "before-final-publication", temporaryPath, finalPath });
  try {
    await link(temporaryPath, finalPath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    // A recovery observer may have completed the same hard-link handoff
    // between this publisher's temporary write and link call. Accept that
    // only after reading the final bytes; a conflicting object remains a
    // fail-closed publication error even when this call normally disallows
    // pre-existing finals.
    let existingInfo: Awaited<ReturnType<typeof lstat>>;
    try { existingInfo = await lstatRequired(finalPath, "private publication existing final file"); }
    catch (existingError) { if (isNotFound(existingError)) throw error; throw existingError; }
    assertPrivateFile(existingInfo, "private publication existing final file");
    const existingBytes = await readStablePublicationFile(finalPath, "private publication existing final file");
    if (!existingBytes.equals(bytes)) throw new PreparationLockRace("private publication final file contains conflicting bytes");
    try { await removeConstructionFile(temporaryPath, temporaryInfo, teardownAuthority); }
    catch (cleanupError) {
      if (!isNotFound(cleanupError)) throw cleanupError;
    }
    return false;
  }
  const finalInfo = await lstatRequired(finalPath, "private publication final file");
  assertPrivateFile(finalInfo, "private publication final file");
  const finalBytes = await readStablePublicationFile(finalPath, "private publication final file");
  if (!finalBytes.equals(bytes)) throw new PreparationLockRace("private publication final file contains conflicting bytes");
  const publishedTemporaryInfo = await lstatRequired(temporaryPath, "private publication temporary file after publication");
  assertPrivateFile(publishedTemporaryInfo, "private publication temporary file after publication");
  if (publishedTemporaryInfo.dev !== temporaryInfo.dev || publishedTemporaryInfo.ino !== temporaryInfo.ino) throw new PreparationLockRace("private publication temporary file changed during publication");
  try { await removeConstructionFile(temporaryPath, publishedTemporaryInfo, teardownAuthority); }
  catch (error) {
    // A concurrent retained-record recovery may have linked and removed this
    // construction pathname after the final was verified. Confirm that the
    // final object still contains these exact bytes before accepting the
    // benign handoff race.
    if (!isNotFound(error)) throw error;
    const recoveredFinalInfo = await lstatRequired(finalPath, "private publication recovered final file");
    assertPrivateFile(recoveredFinalInfo, "private publication recovered final file");
    const recoveredFinalBytes = await readStablePublicationFile(finalPath, "private publication recovered final file");
    if (!recoveredFinalBytes.equals(bytes)) throw new PreparationLockRace("private publication recovered final file contains conflicting bytes");
  }
  await barrier?.({ kind, stage: "final-published", temporaryPath, finalPath });
  return true;
}

async function readExistingCaptureAuthKey(retainedRoot: string): Promise<Buffer> {
  const keyPath = path.join(retainedRoot, PREPARATION_RETAINED_AUTH_FILE);
  let lastError: unknown;
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

async function ensureCaptureAuthKey(
  retainedRoot: string,
  barrier?: RetentionPublicationBarrier,
  forceIncomplete = false,
  teardownAuthority?: TeardownAuthorityGuard,
  authCleanupBarrier?: RetentionAuthCleanupBarrier,
): Promise<Buffer> {
  const keyPath = path.join(retainedRoot, PREPARATION_RETAINED_AUTH_FILE);
  let lastError: unknown;
  for (let attempt = 0; attempt < PREPARATION_LOCK_RACE_RETRIES; attempt += 1) {
    try {
      const keyKind = await pathKind(keyPath);
      if (keyKind === "file") {
        const key = await readExistingCaptureAuthKey(retainedRoot);
        await removeStaleCaptureAuthTemporaries(retainedRoot, key, forceIncomplete, teardownAuthority, authCleanupBarrier);
        return key;
      }
      if (keyKind !== "missing") throw new Error("Pi agent-directory retained capture authentication key is not a regular file");
      const candidates = await readCaptureAuthTemporaries(retainedRoot);
      if (candidates.incomplete.length > 0 && !forceIncomplete) {
        throw new PreparationLockRace("Pi agent-directory retained capture authentication key publication is incomplete");
      }
      for (const incomplete of candidates.incomplete) await removeConstructionFile(incomplete.path, incomplete.info, teardownAuthority);
      const key = candidates.valid[0]?.bytes ?? randomBytes(32);
      await publishPrivateFile(keyPath, key, 0o600, retainedRoot, "auth-key", barrier, true, teardownAuthority);
      const published = await readExistingCaptureAuthKey(retainedRoot);
      await removeStaleCaptureAuthTemporaries(retainedRoot, published, false, teardownAuthority, authCleanupBarrier);
      return published;
    } catch (error) {
      lastError = error;
      if (!isTransientLockRace(error) && !isAlreadyExists(error)) throw error;
      if (attempt + 1 < PREPARATION_LOCK_RACE_RETRIES) await waitForDelay(PREPARATION_LOCK_RACE_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Pi agent-directory retained capture authentication key publication raced");
}

interface CaptureAuthTemporary {
  path: string;
  info: Awaited<ReturnType<typeof lstat>>;
  bytes: Buffer;
}
interface IncompleteCaptureAuthTemporary {
  path: string;
  info: Awaited<ReturnType<typeof lstat>>;
}
async function readCaptureAuthTemporaries(retainedRoot: string): Promise<{ valid: CaptureAuthTemporary[]; incomplete: IncompleteCaptureAuthTemporary[] }> {
  const entries = await readdir(retainedRoot, { withFileTypes: true });
  const valid: CaptureAuthTemporary[] = [];
  const incomplete: IncompleteCaptureAuthTemporary[] = [];
  for (const entry of entries) {
    if (!PREPARATION_RETAINED_AUTH_TEMP.test(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Pi agent-directory retained capture authentication temporary file is invalid");
    const temporary = path.join(retainedRoot, entry.name);
    const info = await lstatRequired(temporary, "Pi agent-directory retained capture authentication temporary file");
    assertPrivateFile(info, "Pi agent-directory retained capture authentication temporary file");
    let bytes: Buffer;
    try { bytes = await readStableFile(temporary, "Pi agent-directory retained capture authentication temporary file"); }
    catch (error) { throw new PreparationLockRace("Pi agent-directory retained capture authentication temporary file changed while being read", error); }
    if (bytes.byteLength !== 32) incomplete.push({ path: temporary, info });
    else valid.push({ path: temporary, info, bytes });
  }
  return { valid, incomplete };
}

async function removeStaleCaptureAuthTemporaries(
  retainedRoot: string,
  published: Buffer,
  forceIncomplete = false,
  teardownAuthority?: TeardownAuthorityGuard,
  authCleanupBarrier?: RetentionAuthCleanupBarrier,
): Promise<void> {
  const entries = await readdir(retainedRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!PREPARATION_RETAINED_AUTH_TEMP.test(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Pi agent-directory retained capture authentication temporary file is invalid");
    const temporary = path.join(retainedRoot, entry.name);
    const info = await lstatRequired(temporary, "Pi agent-directory retained capture authentication temporary file");
    assertPrivateFile(info, "Pi agent-directory retained capture authentication temporary file");
    let bytes: Buffer;
    try { bytes = await readStableFile(temporary, "Pi agent-directory retained capture authentication temporary file"); }
    catch (error) { throw new PreparationLockRace("Pi agent-directory retained capture authentication temporary file changed while being read", error); }
    if (bytes.byteLength !== 32) {
      if (!forceIncomplete) throw new PreparationLockRace("Pi agent-directory retained capture authentication key publication is incomplete");
      // A trusted teardown may discard a stable partial construction file once
      // the durable lifecycle fence is held. Ordinary preparation never
      // removes an object that could still belong to another publisher.
      await removeConstructionFile(temporary, info, teardownAuthority);
      continue;
    }
    // Once the authenticated final key exists, every construction candidate is
    // disposable. Its bytes are intentionally checked before identity-checked
    // removal so a tampered construction path fails closed.
    if (published.byteLength !== 32) throw new Error("Pi agent-directory retained capture authentication key is invalid");
    const finalPath = path.join(retainedRoot, PREPARATION_RETAINED_AUTH_FILE);
    await authCleanupBarrier?.({ stage: "after-observation-before-cleanup", temporaryPath: temporary, finalPath });
    await removeObservedAuthTemporaryAfterHandoff(temporary, info, finalPath, published, teardownAuthority);
  }
}

function terminalFenceWithoutAuth(fence: RunTerminalFence, sandboxIdentity: TerminalFenceSandboxIdentity): Omit<TerminalFencePayload, "auth"> {
  return {
    schemaVersion: PREPARATION_TERMINAL_FENCE_SCHEMA_VERSION,
    kind: PREPARATION_TERMINAL_FENCE_KIND,
    runId: fence.runId,
    owner: fence.owner,
    fencingToken: fence.fencingToken,
    acquiredAt: fence.acquiredAt,
    state: "held",
    sandboxIdentity,
  };
}

function isTerminalFencePayload(value: unknown): value is TerminalFencePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const expected = ["acquiredAt", "auth", "fencingToken", "kind", "owner", "runId", "sandboxIdentity", "schemaVersion", "state"].sort();
  return Object.keys(candidate).sort().join("\\0") === expected.join("\\0")
    && candidate["schemaVersion"] === PREPARATION_TERMINAL_FENCE_SCHEMA_VERSION
    && candidate["kind"] === PREPARATION_TERMINAL_FENCE_KIND
    && typeof candidate["runId"] === "string" && RUN_ID.test(candidate["runId"])
    && typeof candidate["owner"] === "string" && candidate["owner"].length > 0
    && typeof candidate["fencingToken"] === "number" && Number.isSafeInteger(candidate["fencingToken"]) && candidate["fencingToken"] > 0
    && typeof candidate["acquiredAt"] === "string" && candidate["acquiredAt"].length > 0
    && (candidate["sandboxIdentity"] === null || isIdentityRecord(candidate["sandboxIdentity"]))
    && candidate["state"] === "held"
    && typeof candidate["auth"] === "string" && SHA256_HMAC.test(candidate["auth"]);
}

async function readTerminalFenceSandboxIdentity(runRoot: string): Promise<TerminalFenceSandboxIdentity> {
  const kind = await pathKind(runRoot);
  if (kind === "missing") return null;
  if (kind !== "directory") throw new Error("Pi agent-directory run sandbox is not a private directory");
  const info = await lstatRequired(runRoot, "Pi agent-directory run sandbox for terminal fence");
  assertPrivateDirectory(info, "Pi agent-directory run sandbox for terminal fence");
  return identityRecord(directoryIdentityOf(info));
}

async function readTerminalFenceDirectory(directory: string, runtimeRoot: string): Promise<TerminalFenceRecord> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== 1 || entries[0]!.name !== PREPARATION_TERMINAL_FENCE_FILE || entries[0]!.isSymbolicLink() || !entries[0]!.isFile()) {
    throw new Error("Pi agent-directory terminal fence is incomplete");
  }
  const metadataPath = path.join(directory, PREPARATION_TERMINAL_FENCE_FILE);
  const metadataInfo = await lstatRequired(metadataPath, "Pi agent-directory terminal fence metadata");
  assertPrivateFile(metadataInfo, "Pi agent-directory terminal fence metadata");
  const bytes = await readStableFile(metadataPath, "Pi agent-directory terminal fence metadata");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Pi agent-directory terminal fence metadata is not valid JSON"); }
  if (!isTerminalFencePayload(value)) throw new Error("Pi agent-directory terminal fence metadata is invalid");
  const key = await readExistingCaptureAuthKey(path.join(runtimeRoot, PREPARATION_RETAINED_DIRECTORY));
  const payload = { ...value } as Record<string, unknown>;
  delete payload["auth"];
  const expectedAuth = createHmac("sha256", key).update(Buffer.from(JSON.stringify(payload), "utf8")).digest("hex");
  if (value.auth !== expectedAuth) throw new Error("Pi agent-directory terminal fence authentication failed");
  return {
    runId: value.runId,
    owner: value.owner,
    fencingToken: value.fencingToken,
    acquiredAt: value.acquiredAt,
    state: "held",
    sandboxIdentity: value.sandboxIdentity,
  };
}

async function assertNoTerminalFence(runRoot: string): Promise<void> {
  const runtimeRoot = path.dirname(runRoot);
  const runId = path.basename(runRoot);
  const fenceRoot = path.join(runtimeRoot, PREPARATION_TERMINAL_FENCE_ROOT);
  const rootKind = await pathKind(fenceRoot);
  if (rootKind === "missing") return;
  if (rootKind !== "directory") throw new Error("Pi agent-directory terminal fence root is not a private directory");
  const rootInfo = await lstatRequired(fenceRoot, "Pi agent-directory terminal fence root");
  assertPrivateDirectory(rootInfo, "Pi agent-directory terminal fence root");
  const entries = await readdir(fenceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === PREPARATION_TERMINAL_DISPOSAL_DIRECTORY) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Pi agent-directory terminal sandbox disposal is invalid");
      const disposalInfo = await lstatRequired(path.join(fenceRoot, entry.name), "Pi agent-directory terminal sandbox disposal");
      assertPrivateDirectory(disposalInfo, "Pi agent-directory terminal sandbox disposal");
      const disposalEntries = await readdir(path.join(fenceRoot, entry.name), { withFileTypes: true });
      for (const disposalEntry of disposalEntries) {
        const disposalMatch = PREPARATION_RETAINED_DISPOSAL.exec(disposalEntry.name);
        if (!disposalMatch || disposalEntry.isSymbolicLink() || !disposalEntry.isDirectory()) {
          throw new Error("Pi agent-directory terminal sandbox disposal contains invalid content");
        }
        if (disposalMatch[1] === runId) throw new Error("Pi agent-directory terminal sandbox disposal is in progress");
      }
      continue;
    }
    if (!PREPARATION_TERMINAL_FENCE_TEMP.test(entry.name) || !entry.name.startsWith(`.terminal-fence-${runId}-`)) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Pi agent-directory terminal fence construction is invalid");
    throw new Error("Pi agent-directory terminal fence publication is in progress");
  }
  const finalPath = path.join(fenceRoot, runId);
  const finalKind = await pathKind(finalPath);
  if (finalKind === "missing") return;
  if (finalKind !== "directory") throw new Error("Pi agent-directory terminal fence is not a private directory");
  const info = await lstatRequired(finalPath, "Pi agent-directory terminal fence");
  assertPrivateDirectory(info, "Pi agent-directory terminal fence");
  const fence = await readTerminalFenceDirectory(finalPath, runtimeRoot);
  if (fence.runId !== runId) throw new Error("Pi agent-directory terminal fence belongs to a different run");
  throw new Error("Pi agent-directory run has a permanent terminal fence for teardown");
}

async function assertTerminalFence(runRoot: string): Promise<TerminalFenceRecord> {
  const runtimeRoot = path.dirname(runRoot);
  const runId = path.basename(runRoot);
  const fenceRoot = path.join(runtimeRoot, PREPARATION_TERMINAL_FENCE_ROOT);
  const rootInfo = await lstatRequired(fenceRoot, "Pi agent-directory terminal fence root");
  assertPrivateDirectory(rootInfo, "Pi agent-directory terminal fence root");
  const entries = await readdir(fenceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === PREPARATION_TERMINAL_DISPOSAL_DIRECTORY) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Pi agent-directory terminal sandbox disposal is invalid");
      const disposalInfo = await lstatRequired(path.join(fenceRoot, entry.name), "Pi agent-directory terminal sandbox disposal");
      assertPrivateDirectory(disposalInfo, "Pi agent-directory terminal sandbox disposal");
      continue;
    }
    if (!PREPARATION_TERMINAL_FENCE_TEMP.test(entry.name) || !entry.name.startsWith(`.terminal-fence-${runId}-`)) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Pi agent-directory terminal fence construction is invalid");
    throw new Error("Pi agent-directory terminal fence publication is in progress");
  }
  const finalPath = path.join(fenceRoot, runId);
  const finalInfo = await lstatRequired(finalPath, "Pi agent-directory terminal fence");
  assertPrivateDirectory(finalInfo, "Pi agent-directory terminal fence");
  const fence = await readTerminalFenceDirectory(finalPath, runtimeRoot);
  if (fence.runId !== runId) throw new Error("Pi agent-directory terminal fence belongs to a different run");
  return fence;
}

async function removeUnpublishedTerminalFence(directory: string, retainedRoot: string, runId: string, teardownAuthority: TeardownAuthorityGuard): Promise<void> {
  const info = await lstatRequired(directory, "Pi agent-directory terminal fence construction");
  assertPrivateDirectory(info, "Pi agent-directory terminal fence construction");
  await removeOwnedPathAfterQuiescence(
    directory,
    directoryIdentityOf(info),
    true,
    "Pi agent-directory terminal fence construction",
    teardownAuthority,
    path.join(retainedRoot, PREPARATION_RETAINED_DISPOSAL_DIRECTORY),
    runId,
  );
}

function isIncompleteTerminalFenceError(error: unknown): boolean {
  return error instanceof Error && /terminal fence (?:is incomplete|metadata is not valid JSON|metadata is invalid)/iu.test(error.message);
}

async function clearTerminalFenceTemporaryEntries(
  fenceRoot: string,
  runtimeRoot: string,
  retainedRoot: string,
  fence: RunTerminalFence,
  teardownAuthority: TeardownAuthorityGuard,
): Promise<void> {
  const entries = await readdir(fenceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(`.terminal-fence-${fence.runId}-`)) continue;
    if (!PREPARATION_TERMINAL_FENCE_TEMP.test(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error("Pi agent-directory terminal fence construction is invalid");
    }
    const temporary = path.join(fenceRoot, entry.name);
    try {
      const complete = await readTerminalFenceDirectory(temporary, runtimeRoot);
      if (complete.runId !== fence.runId || complete.owner !== fence.owner || complete.fencingToken !== fence.fencingToken) {
        throw new PreparationLockRace("Pi agent-directory terminal fence construction belongs to a different teardown");
      }
    } catch (error) {
      if (!isIncompleteTerminalFenceError(error)) {
        if (isNotFound(error)) continue;
        throw error;
      }
    }
    await removeUnpublishedTerminalFence(temporary, retainedRoot, fence.runId, teardownAuthority);
  }
}

async function publishTerminalFence(
  runRoot: string,
  runtimeRoot: string,
  fence: RunTerminalFence,
  barrier: RetentionPublicationBarrier | undefined,
  teardownAuthority: TeardownAuthorityGuard,
  authCleanupBarrier?: RetentionAuthCleanupBarrier,
): Promise<void> {
  if (fence.state !== "held") throw new Error("Pi agent-directory terminal fence is not held");
  const location = await ensureRetentionLocation(runRoot, barrier, true, teardownAuthority, authCleanupBarrier);
  const fenceRoot = path.join(runtimeRoot, PREPARATION_TERMINAL_FENCE_ROOT);
  await mkdir(fenceRoot, { recursive: true, mode: 0o700 });
  await ensureSecureDirectory(fenceRoot, "Pi agent-directory terminal fence root", true);
  const sandboxDisposal = path.join(fenceRoot, PREPARATION_TERMINAL_DISPOSAL_DIRECTORY);
  await ensurePrivateDirectory(sandboxDisposal, "Pi agent-directory terminal sandbox disposal");
  // A prior crash may have left an identity-checked retained object in the
  // private disposal namespace. The workflow fence makes it safe to finish
  // that disposal before examining the new publication. Sandbox disposals are
  // separate because a run-root replacement must never be hidden by cleanup.
  await clearRetainedDisposalEntries(location.retainedRoot, fence.runId, teardownAuthority);
  const finalPath = path.join(fenceRoot, fence.runId);
  const finalKind = await pathKind(finalPath);
  if (finalKind !== "missing") {
    if (finalKind !== "directory") throw new Error("Pi agent-directory terminal fence is not a private directory");
    const existing = await readTerminalFenceDirectory(finalPath, runtimeRoot);
    if (existing.runId !== fence.runId || existing.owner !== fence.owner || existing.fencingToken !== fence.fencingToken) throw new PreparationLockRace("Pi agent-directory terminal fence belongs to a different teardown");
    await clearTerminalFenceTemporaryEntries(fenceRoot, runtimeRoot, location.retainedRoot, fence, teardownAuthority);
    await clearRetainedDisposalEntries(location.retainedRoot, fence.runId, teardownAuthority);
    return;
  }
  const entries = await readdir(fenceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!PREPARATION_TERMINAL_FENCE_TEMP.test(entry.name) || !entry.name.startsWith(`.terminal-fence-${fence.runId}-`)) continue;
    const temporary = path.join(fenceRoot, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Pi agent-directory terminal fence construction is invalid");
    let complete: TerminalFenceRecord | undefined;
    try { complete = await readTerminalFenceDirectory(temporary, runtimeRoot); }
    catch (error) {
      if (!(error instanceof Error) || !/incomplete|not valid JSON|invalid/iu.test(error.message)) throw error;
    }
    if (complete) {
      if (complete.runId !== fence.runId || complete.owner !== fence.owner || complete.fencingToken !== fence.fencingToken) throw new PreparationLockRace("Pi agent-directory terminal fence construction belongs to a different teardown");
      try { await rename(temporary, finalPath); }
      catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      const published = await readTerminalFenceDirectory(finalPath, runtimeRoot);
      if (published.runId !== fence.runId || published.owner !== fence.owner || published.fencingToken !== fence.fencingToken) throw new PreparationLockRace("Pi agent-directory terminal fence was replaced during publication");
      if (await pathKind(temporary) !== "missing") await removeUnpublishedTerminalFence(temporary, location.retainedRoot, fence.runId, teardownAuthority);
      return;
    }
    await removeUnpublishedTerminalFence(temporary, location.retainedRoot, fence.runId, teardownAuthority);
  }
  const sandboxIdentity = await readTerminalFenceSandboxIdentity(runRoot);
  const temporary = path.join(fenceRoot, `.terminal-fence-${fence.runId}-${randomUUID()}`);
  await mkdir(temporary, { recursive: false, mode: 0o700 });
  const temporaryInfo = await lstatRequired(temporary, "Pi agent-directory terminal fence construction");
  assertPrivateDirectory(temporaryInfo, "Pi agent-directory terminal fence construction");
  await barrier?.({ kind: "terminal-fence", stage: "temporary-written", temporaryPath: temporary, finalPath });
  const payload = terminalFenceWithoutAuth(fence, sandboxIdentity);
  const key = await ensureCaptureAuthKey(location.retainedRoot, barrier, false, teardownAuthority, authCleanupBarrier);
  const auth = createHmac("sha256", key).update(Buffer.from(JSON.stringify(payload), "utf8")).digest("hex");
  const metadata = Buffer.from(`${JSON.stringify({ ...payload, auth })}\n`, "utf8");
  await publishPrivateFile(path.join(temporary, PREPARATION_TERMINAL_FENCE_FILE), metadata, 0o600, temporary, "fence-metadata", barrier, false, teardownAuthority);
  const built = await readTerminalFenceDirectory(temporary, runtimeRoot);
  if (built.runId !== fence.runId || built.owner !== fence.owner || built.fencingToken !== fence.fencingToken) throw new PreparationLockRace("Pi agent-directory terminal fence changed during construction");
  await barrier?.({ kind: "terminal-fence", stage: "before-final-publication", temporaryPath: temporary, finalPath });
  try { await rename(temporary, finalPath); }
  catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const published = await readTerminalFenceDirectory(finalPath, runtimeRoot);
    if (published.runId !== fence.runId || published.owner !== fence.owner || published.fencingToken !== fence.fencingToken) throw new PreparationLockRace("Pi agent-directory terminal fence was replaced during publication");
    if (await pathKind(temporary) !== "missing") await removeUnpublishedTerminalFence(temporary, location.retainedRoot, fence.runId, teardownAuthority);
    return;
  }
  const published = await readTerminalFenceDirectory(finalPath, runtimeRoot);
  if (published.runId !== fence.runId || published.owner !== fence.owner || published.fencingToken !== fence.fencingToken) throw new PreparationLockRace("Pi agent-directory terminal fence was replaced after publication");
  await barrier?.({ kind: "terminal-fence", stage: "final-published", temporaryPath: temporary, finalPath });
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

async function readRetentionAllocationOwnerFile(ownerPath: string, name: string): Promise<RetentionAllocationOwner | undefined> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PREPARATION_LOCK_RACE_RETRIES; attempt += 1) {
    try {
      if (await pathKind(ownerPath) === "missing") return undefined;
      const info = await lstatRequired(ownerPath, name);
      assertPrivateFile(info, name);
      const bytes = await readStableFile(ownerPath, name);
      let value: unknown;
      try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${name} is not valid JSON`); }
      if (!isRetentionAllocationOwner(value)) throw new Error(`${name} is invalid`);
      return value;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < PREPARATION_LOCK_RACE_RETRIES) await waitForDelay(PREPARATION_LOCK_RACE_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${name} is unreadable`);
}

async function readRetentionAllocationOwner(directory: string): Promise<RetentionAllocationOwner | undefined> {
  return readRetentionAllocationOwnerFile(
    path.join(directory, PREPARATION_RETAINED_ALLOCATION_OWNER_FILE),
    "Pi agent-directory retained allocation lock owner",
  );
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

async function removeObservedAuthTemporaryAfterHandoff(
  temporaryPath: string,
  temporaryInfo: Awaited<ReturnType<typeof lstat>>,
  finalPath: string,
  expectedBytes: Buffer,
  teardownAuthority?: TeardownAuthorityGuard,
): Promise<void> {
  try {
    await removeConstructionFile(temporaryPath, temporaryInfo, teardownAuthority);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    // The publisher may have completed the exact hard-link handoff and
    // removed this construction pathname after the observer's scan. Accept
    // that one missing-path interleaving only after rechecking the authenticated
    // final key and its bytes; replacement or conflicting bytes still fail
    // closed.
    const finalInfo = await lstatRequired(finalPath, "Pi agent-directory retained capture authentication key after temporary handoff");
    assertPrivateFile(finalInfo, "Pi agent-directory retained capture authentication key after temporary handoff");
    const finalBytes = await readStablePublicationFile(finalPath, "Pi agent-directory retained capture authentication key after temporary handoff");
    if (!finalBytes.equals(expectedBytes)) {
      throw new PreparationLockRace("Pi agent-directory retained capture authentication key final bytes conflict with its temporary handoff");
    }
  }
}

async function ensureRetentionAllocationRoot(
  retainedRoot: string,
  teardownAuthority?: TeardownAuthorityGuard,
  authCleanupBarrier?: RetentionAuthCleanupBarrier,
): Promise<void> {
  const entries = await readdir(retainedRoot, { withFileTypes: true });
  let freeLock = false;
  let heldLock = false;
  let rootMarker = false;
  let rootMarkerCreated = false;
  for (const entry of entries) {
    if (entry.name === PREPARATION_RETAINED_AUTH_FILE) continue;
    if (entry.name === PREPARATION_RETAINED_DISPOSAL_DIRECTORY) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Pi agent-directory retained disposal root is invalid");
      const disposalInfo = await lstatRequired(path.join(retainedRoot, entry.name), "Pi agent-directory retained disposal root");
      assertPrivateDirectory(disposalInfo, "Pi agent-directory retained disposal root");
      continue;
    }
    if (PREPARATION_RETAINED_AUTH_TEMP.test(entry.name)) {
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Pi agent-directory retained capture authentication temporary file is invalid");
      const temporaryPath = path.join(retainedRoot, entry.name);
      let temporaryInfo: Awaited<ReturnType<typeof lstat>>;
      try { temporaryInfo = await lstatRequired(temporaryPath, "Pi agent-directory retained capture authentication temporary file"); }
      catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      assertPrivateFile(temporaryInfo, "Pi agent-directory retained capture authentication temporary file");
      let temporary: Buffer;
      try { temporary = await readStableFile(temporaryPath, "Pi agent-directory retained capture authentication temporary file"); }
      catch (error) {
        // Final-key publication links/unlinks this construction inode, which
        // can change ctime between the stable-read probes. Re-scan instead of
        // treating that ordinary handoff as tampering.
        if (isNotFound(error) || error instanceof Error && /changed while it was being read/iu.test(error.message)) continue;
        throw error;
      }
      if (temporary.byteLength !== 32) throw new PreparationLockRace("Pi agent-directory retained capture authentication key publication is incomplete");
      const finalPath = path.join(retainedRoot, PREPARATION_RETAINED_AUTH_FILE);
      const finalInfo = await lstatRequired(finalPath, "Pi agent-directory retained capture authentication key");
      assertPrivateFile(finalInfo, "Pi agent-directory retained capture authentication key");
      await authCleanupBarrier?.({ stage: "after-observation-before-cleanup", temporaryPath, finalPath });
      await removeObservedAuthTemporaryAfterHandoff(temporaryPath, temporaryInfo, finalPath, temporary, teardownAuthority);
      continue;
    }
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

async function ensureRetentionLocation(
  runRoot: string,
  publicationBarrier?: RetentionPublicationBarrier,
  forceIncompleteAuth = false,
  teardownAuthority?: TeardownAuthorityGuard,
  authCleanupBarrier?: RetentionAuthCleanupBarrier,
): Promise<RetainedCaptureLocation> {
  const resolvedRunRoot = path.resolve(runRoot);
  const runtimeRoot = path.dirname(resolvedRunRoot);
  const runId = path.basename(resolvedRunRoot);
  assertRunId(runId);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o755 });
  await ensureSecureDirectory(runtimeRoot, "runtime root", false);
  const retainedRoot = path.join(runtimeRoot, PREPARATION_RETAINED_DIRECTORY);
  await ensurePrivateDirectory(retainedRoot, "Pi agent-directory retained quarantine root");
  await ensurePrivateDirectory(path.join(retainedRoot, PREPARATION_RETAINED_DISPOSAL_DIRECTORY), "Pi agent-directory retained disposal root");
  await ensureCaptureAuthKey(retainedRoot, publicationBarrier, forceIncompleteAuth, teardownAuthority, authCleanupBarrier);
  await ensureRetentionAllocationRoot(retainedRoot, teardownAuthority, authCleanupBarrier);
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

function retentionAllocationClaimPath(directory: string): string {
  return path.join(directory, PREPARATION_RETAINED_ALLOCATION_CLAIM_FILE);
}

async function recoverStaleRetentionAllocationClaim(directory: string, force = false): Promise<boolean> {
  const claimPath = retentionAllocationClaimPath(directory);
  if (await pathKind(claimPath) === "missing") return false;
  const claimInfo = await lstatRequired(claimPath, "Pi agent-directory retained allocation claim");
  assertPrivateFile(claimInfo, "Pi agent-directory retained allocation claim");
  const owner = await readRetentionAllocationOwnerFile(claimPath, "Pi agent-directory retained allocation claim");
  if (!owner || owner.state !== "held") throw new PreparationLockRace("Pi agent-directory retained allocation claim is invalid");
  if (!force && (!isStale(owner.createdAt, PREPARATION_LOCK_STALE_MS) || isProcessAlive(owner.pid))) return false;
  const before = await lstatRequired(claimPath, "Pi agent-directory retained allocation claim before recovery");
  assertPrivateFile(before, "Pi agent-directory retained allocation claim before recovery");
  if (!sameFileStat(claimInfo, before)) throw new PreparationLockRace("Pi agent-directory retained allocation claim changed during recovery");
  await rm(claimPath, { force: false });
  return true;
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
  teardownAuthority?: TeardownAuthorityGuard,
  authCleanupBarrier?: RetentionAuthCleanupBarrier,
  allocationClaimBarrier?: RetentionAllocationClaimBarrier,
): Promise<RetentionAllocationLease> {
  const startedAt = monotonicMilliseconds();
  const timeoutMs = PREPARATION_LOCK_TIMEOUT_MS;
  for (;;) {
    throwIfAborted(signal);
    await ensureRetentionAllocationRoot(retainedRoot, teardownAuthority, authCleanupBarrier);
    const canonical = path.join(retainedRoot, PREPARATION_RETAINED_ALLOCATION_LOCK);
    const canonicalKind = await pathKind(canonical);
    if (canonicalKind === "directory") {
      const claimPath = retentionAllocationClaimPath(canonical);
      const claimKind = await pathKind(claimPath);
      if (claimKind !== "missing") {
        if (claimKind !== "file") throw new PreparationLockRace("Pi agent-directory retained allocation claim was replaced");
        try {
          if (await recoverStaleRetentionAllocationClaim(canonical, force)) continue;
        } catch (error) {
          if (!isTransientLockRace(error)) throw error;
        }
        const elapsed = monotonicMilliseconds() - startedAt;
        if (elapsed >= timeoutMs) throw new Error("Pi agent-directory retained allocation lock acquisition timed out; trusted teardown is required");
        await waitForDelay(Math.min(PREPARATION_LOCK_POLL_MS, timeoutMs - elapsed), signal);
        continue;
      }
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
      const activeOwner: RetentionAllocationOwner = {
        schemaVersion: 1,
        kind: PREPARATION_RETAINED_ALLOCATION_KIND,
        state: "held",
        runId,
        token: randomUUID(),
        pid: process.pid,
        createdAt: Date.now(),
      };
      await allocationClaimBarrier?.({ stage: "before-claim", directory: canonical });
      try {
        await writeFile(claimPath, serializeRetentionAllocationOwner(activeOwner), { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (isAlreadyExists(error)) continue;
        throw error;
      }
      let claimInfo: Awaited<ReturnType<typeof lstat>> | undefined;
      try {
        claimInfo = await lstatRequired(claimPath, "Pi agent-directory retained allocation claim");
        assertPrivateFile(claimInfo, "Pi agent-directory retained allocation claim");
        const claimedInfo = await lstatRequired(canonical, "Pi agent-directory retained allocation lock after claim");
        assertPrivateDirectory(claimedInfo, "Pi agent-directory retained allocation lock after claim");
        if (!sameDirectoryIdentity(directoryIdentityOf(info), directoryIdentityOf(claimedInfo))) throw new PreparationLockRace("Pi agent-directory retained allocation lock changed during acquisition");
        const claimedOwner = await readRetentionAllocationOwner(canonical);
        if (!claimedOwner || claimedOwner.state !== "free" || claimedOwner.token !== owner.token) throw new PreparationLockRace("Pi agent-directory retained allocation lock owner changed during acquisition");
        await rename(claimPath, retentionAllocationOwnerPath(canonical));
        const heldOwner = await readRetentionAllocationOwner(canonical);
        if (!heldOwner || heldOwner.state !== "held" || heldOwner.token !== activeOwner.token || heldOwner.runId !== runId) throw new PreparationLockRace("Pi agent-directory retained allocation lock owner changed during acquisition");
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
      } catch (error) {
        const remainingClaim = await pathKind(claimPath);
        if (remainingClaim === "file") {
          const remainingInfo = await lstatRequired(claimPath, "Pi agent-directory retained allocation claim cleanup");
          assertPrivateFile(remainingInfo, "Pi agent-directory retained allocation claim cleanup");
          if (!claimInfo || !sameFileStat(claimInfo, remainingInfo)) throw new PreparationLockRace("Pi agent-directory retained allocation claim changed during cleanup");
          await rm(claimPath, { force: false });
        } else if (remainingClaim !== "missing") {
          throw new PreparationLockRace("Pi agent-directory retained allocation claim was replaced");
        }
        throw error;
      }
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

async function serializeRetainedCaptureRecord(payload: RetainedCaptureRecordPayload, retainedRoot: string, barrier?: RetentionPublicationBarrier): Promise<Buffer> {
  const key = await ensureCaptureAuthKey(retainedRoot, barrier);
  const auth = createHmac("sha256", key).update(serializeRetainedCapturePayload(payload)).digest("hex");
  return Buffer.from(`${JSON.stringify({ ...payload, auth })}\n`, "utf8");
}

async function serializeRetainedFenceMetadata(
  record: RetainedCaptureRecord,
  fenceIdentity: DirectoryIdentity,
  retainedRoot: string,
  barrier?: RetentionPublicationBarrier,
): Promise<Buffer> {
  const payload = { ...recordWithoutAuth(record), fenceIdentity: identityRecord(fenceIdentity) };
  const key = await ensureCaptureAuthKey(retainedRoot, barrier);
  const auth = createHmac("sha256", key).update(Buffer.from(JSON.stringify(payload), "utf8")).digest("hex");
  return Buffer.from(`${JSON.stringify({ ...payload, auth })}\n`, "utf8");
}

async function writeRetainedCaptureRecord(
  recordPath: string,
  payload: RetainedCaptureRecordPayload,
  retainedRoot: string,
  temporaryDirectory: string,
  barrier?: RetentionPublicationBarrier,
): Promise<Buffer> {
  const bytes = await serializeRetainedCaptureRecord(payload, retainedRoot, barrier);
  await publishPrivateFile(recordPath, bytes, 0o600, temporaryDirectory, "capture-record", barrier);
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

function parseRetainedCaptureRecord(bytes: Buffer, key: Buffer): RetainedCaptureRecord {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Pi agent-directory retained capture record is not valid JSON"); }
  if (!isRetainedCaptureRecord(value)) throw new Error("Pi agent-directory retained capture record is invalid");
  const payload = { ...value } as Record<string, unknown>;
  delete payload["auth"];
  const expectedAuth = createHmac("sha256", key).update(Buffer.from(JSON.stringify(payload), "utf8")).digest("hex");
  if (value.auth !== expectedAuth) throw new Error("Pi agent-directory retained capture record authentication failed");
  return value;
}

async function readRetainedCaptureRecord(recordPath: string, runtimeRoot: string, teardownAuthority?: TeardownAuthorityGuard): Promise<RetainedCaptureRecord> {
  const retainedRoot = path.join(runtimeRoot, PREPARATION_RETAINED_DIRECTORY);
  const key = await ensureCaptureAuthKey(retainedRoot, undefined, false, teardownAuthority);
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
      return parseRetainedCaptureRecord(bytes, key);
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
  allowIncompleteFences = false,
  allowIncompleteRecords = false,
  teardownAuthority?: TeardownAuthorityGuard,
): Promise<Array<{ record: RetainedCaptureRecord; recordPath: string }>> {
  const entries = await readdir(location.retainedRun, { withFileTypes: true });
  const records: Array<{ record: RetainedCaptureRecord; recordPath: string }> = [];
  const recordPaths = new Set<string>();
  const expectedObjects = new Set<string>();
  const addRecord = (record: RetainedCaptureRecord, recordPath: string): void => {
    if (recordPaths.has(recordPath)) return;
    recordPaths.add(recordPath);
    records.push({ record, recordPath });
    expectedObjects.add(path.basename(record.retainedPath));
  };
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("Pi agent-directory retained quarantine contains a symlink");
    const absolute = path.join(location.retainedRun, entry.name);
    if (PREPARATION_RETAINED_RECORD_TEMP.test(entry.name)) {
      try {
        const recovered = await recoverRetainedRecordTemporary(absolute, location, teardownAuthority);
        addRecord(recovered.record, recovered.recordPath);
      } catch (error) {
        // A publisher may have completed the hard-link handoff and removed
        // this construction pathname after this directory snapshot. The next
        // stable scan will observe the final record; do not turn that benign
        // cross-process handoff into a corruption report.
        if (allowIncompleteRecords && error instanceof IncompleteRetainedRecordPublication) continue;
        if (!isTransientLockRace(error)) throw error;
      }
      continue;
    }
    if (PREPARATION_RETAINED_RECORD.test(entry.name)) {
      if (!entry.isFile()) throw new Error("Pi agent-directory retained capture record is not a regular file");
      const record = await readRetainedCaptureRecord(absolute, location.runtimeRoot, teardownAuthority);
      validateRetainedRecordPaths(record, absolute, location);
      addRecord(record, absolute);
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
    if (item.record.state === "fence") {
      try { await verifyFenceMetadata(item.record.retainedPath, item.record, teardownAuthority); }
      catch (error) {
        if (!allowIncompleteFences || !(error instanceof IncompleteQuarantineFence)) throw error;
      }
    }
  }
  return records;
}

async function recoverRetainedRecordTemporary(
  temporaryPath: string,
  location: RetainedCaptureLocation,
  teardownAuthority?: TeardownAuthorityGuard,
): Promise<{ record: RetainedCaptureRecord; recordPath: string }> {
  const name = path.basename(temporaryPath);
  const match = PREPARATION_RETAINED_RECORD_TEMP.exec(name);
  if (!match) throw new Error("Pi agent-directory retained capture record temporary name is invalid");
  const recordPath = path.join(location.retainedRun, `capture-${match[1]}.json`);
  let temporaryInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  let temporaryBytes: Buffer | undefined;
  let temporaryRecord: RetainedCaptureRecord | undefined;
  let lastIncomplete: unknown;
  for (let attempt = 0; attempt < PREPARATION_LOCK_RACE_RETRIES; attempt += 1) {
    const finalKindBefore = await pathKind(recordPath);
    if (finalKindBefore !== "missing" && finalKindBefore !== "file") throw new Error("Pi agent-directory retained capture record final path is not a regular file");
    try {
      const info = await lstatRequired(temporaryPath, "Pi agent-directory retained capture record temporary file");
      assertPrivateFile(info, "Pi agent-directory retained capture record temporary file");
      const bytes = await readStableFile(temporaryPath, "Pi agent-directory retained capture record temporary file");
      const key = await ensureCaptureAuthKey(location.retainedRoot, undefined, false, teardownAuthority);
      const parsed = parseRetainedCaptureRecord(bytes, key);
      validateRetainedRecordPaths(parsed, recordPath, location);
      temporaryInfo = info;
      temporaryBytes = bytes;
      temporaryRecord = parsed;
      break;
    } catch (error) {
      if (isNotFound(error)) throw error;
      // A final hard-link may be published or the construction link may be
      // removed while this observer is reading. Treat that ctime race as a
      // retryable handoff; the next stable scan will consume the final name.
      if (finalKindBefore !== "missing") throw new PreparationLockRace("Pi agent-directory retained capture record publication raced with its final handoff", error);
      lastIncomplete = error;
      if (attempt + 1 < PREPARATION_LOCK_RACE_RETRIES) await waitForDelay(PREPARATION_LOCK_RACE_DELAY_MS);
    }
  }
  if (!temporaryInfo || !temporaryBytes || !temporaryRecord) {
    throw new IncompleteRetainedRecordPublication(
      `Pi agent-directory retained capture record temporary publication is incomplete${lastIncomplete instanceof Error ? `: ${lastIncomplete.message}` : ""}`,
    );
  }
  try { await link(temporaryPath, recordPath); }
  catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  let record: RetainedCaptureRecord | undefined;
  let lastFinalRace: unknown;
  for (let attempt = 0; attempt < PREPARATION_LOCK_RACE_RETRIES; attempt += 1) {
    try {
      const finalInfo = await lstatRequired(recordPath, "Pi agent-directory retained capture record");
      assertPrivateFile(finalInfo, "Pi agent-directory retained capture record");
      const finalBytes = await readStableFile(recordPath, "Pi agent-directory retained capture record");
      if (!finalBytes.equals(temporaryBytes)) throw new PreparationLockRace("Pi agent-directory retained capture record final bytes conflict with its temporary publication");
      record = await readRetainedCaptureRecord(recordPath, location.runtimeRoot, teardownAuthority);
      validateRetainedRecordPaths(record, recordPath, location);
      break;
    } catch (error) {
      if (isNotFound(error)) throw error;
      // Linking the temporary name changes the inode ctime, and unlinking it
      // after publication changes it again. An observer can therefore race a
      // perfectly valid final handoff; retry only that stable-read condition.
      if (!(error instanceof Error) || !/changed while it was being read/iu.test(error.message)) throw error;
      lastFinalRace = error;
      if (attempt + 1 < PREPARATION_LOCK_RACE_RETRIES) await waitForDelay(PREPARATION_LOCK_RACE_DELAY_MS);
    }
  }
  if (!record) throw new PreparationLockRace("Pi agent-directory retained capture record final publication did not stabilize", lastFinalRace);
  await removeConstructionFile(temporaryPath, temporaryInfo, teardownAuthority);
  return { record, recordPath };
}

async function reconcileRetainedCaptures(
  runtimeRoot: string,
  runId: string,
  limits: RetentionLimits,
  signal?: AbortSignal,
  allowIncompleteRecords = false,
  teardownAuthority?: TeardownAuthorityGuard,
): Promise<Array<{ record: RetainedCaptureRecord; recordPath: string }>> {
  throwIfAborted(signal);
  const location = await ensureRetentionLocation(path.join(runtimeRoot, runId), limits.publicationBarrier, false, teardownAuthority, limits.authCleanupBarrier);
  const rootEntries = await readdir(location.retainedRoot, { withFileTypes: true });
  let globalCount = 0;
  for (const entry of rootEntries) {
    if (entry.name === PREPARATION_RETAINED_AUTH_FILE) {
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Pi agent-directory retained capture authentication key is invalid");
      continue;
    }
    if (entry.name === PREPARATION_RETAINED_DISPOSAL_DIRECTORY) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Pi agent-directory retained disposal root is invalid");
      const disposalInfo = await lstatRequired(path.join(location.retainedRoot, entry.name), "Pi agent-directory retained disposal root");
      assertPrivateDirectory(disposalInfo, "Pi agent-directory retained disposal root");
      continue;
    }
    if (PREPARATION_RETAINED_AUTH_TEMP.test(entry.name)) {
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Pi agent-directory retained capture authentication temporary file is invalid");
      try {
        const temporaryInfo = await lstatRequired(path.join(location.retainedRoot, entry.name), "Pi agent-directory retained capture authentication temporary file");
        assertPrivateFile(temporaryInfo, "Pi agent-directory retained capture authentication temporary file");
      } catch (error) {
        if (!isTransientLockRace(error)) throw error;
      }
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
    const records = await readRetainedRecordsForRun(itemLocation, true, allowIncompleteRecords, teardownAuthority);
    globalCount += records.length;
    if (entry.name === runId && records.length > limits.perRun) {
      throw new Error("Pi agent-directory retained capture per-run bound has been exceeded; trusted teardown is required");
    }
  }
  if (globalCount > limits.global) throw new Error("Pi agent-directory retained capture global bound has been exceeded; trusted teardown is required");
  // A completed materialization may still be reused at the bound. Allocation
  // itself performs the final per-run/global check before publishing another
  // authenticated record, so the ledger never grows past either limit.
  return readRetainedRecordsForRun(location, true, allowIncompleteRecords, teardownAuthority);
}

async function findRetainedRecordForQuarantine(
  runRoot: string,
  quarantine: string,
  allowIncompleteFences = false,
  teardownAuthority?: TeardownAuthorityGuard,
): Promise<{ record: RetainedCaptureRecord; recordPath: string; location: RetainedCaptureLocation }> {
  const location = await ensureRetentionLocation(runRoot, undefined, false, teardownAuthority);
  const records = await readRetainedRecordsForRun(location, allowIncompleteFences, true, teardownAuthority);
  const matches = records.filter(item => path.resolve(item.record.quarantinePath) === path.resolve(quarantine));
  if (matches.length !== 1) throw new Error("Pi agent-directory quarantine has no authenticated capture metadata");
  return { ...matches[0]!, location };
}

function parseRetainedFenceMetadata(
  metadata: Buffer,
  record: RetainedCaptureRecord,
  fenceInfo: Awaited<ReturnType<typeof lstat>>,
  key: Buffer,
): RetainedFenceMetadata {
  let value: unknown;
  try { value = JSON.parse(metadata.toString("utf8")); } catch { throw new Error("Pi agent-directory quarantine metadata is not valid JSON"); }
  if (!isRetainedFenceMetadata(value)) throw new Error("Pi agent-directory quarantine metadata is invalid");
  const candidateRecord = { ...value } as Record<string, unknown>;
  delete candidateRecord["fenceIdentity"];
  const payload = { ...candidateRecord };
  delete payload["auth"];
  const expectedAuth = createHmac("sha256", key).update(Buffer.from(JSON.stringify({ ...payload, fenceIdentity: value.fenceIdentity }), "utf8")).digest("hex");
  if (value.auth !== expectedAuth || JSON.stringify(payload) !== JSON.stringify(recordWithoutAuth(record))) {
    throw new Error("Pi agent-directory quarantine metadata does not match its authenticated capture record");
  }
  if (!sameIdentityRecord(value.fenceIdentity, directoryIdentityOf(fenceInfo))) throw new Error("Pi agent-directory quarantine fence identity changed");
  return value;
}

async function verifyFenceMetadata(
  quarantine: string,
  record: RetainedCaptureRecord,
  teardownAuthority?: TeardownAuthorityGuard,
): Promise<void> {
  if (record.state !== "fence") return;
  const fenceInfo = await lstatRequired(quarantine, "Pi agent-directory quarantine fence");
  assertPrivateDirectory(fenceInfo, "Pi agent-directory quarantine fence");
  const entries = await readdir(quarantine, { withFileTypes: true });
  const metadataEntry = entries.find(entry => entry.name === PREPARATION_CAPTURE_METADATA_FILE);
  const temporaryEntries = entries.filter(entry => PREPARATION_CAPTURE_METADATA_TEMP.test(entry.name));
  const unexpected = entries.filter(entry => entry.name !== PREPARATION_CAPTURE_METADATA_FILE && !PREPARATION_CAPTURE_METADATA_TEMP.test(entry.name));
  if (unexpected.length > 0 || temporaryEntries.length > 1 || metadataEntry && (!metadataEntry.isFile() || metadataEntry.isSymbolicLink()) || temporaryEntries.some(entry => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Pi agent-directory quarantine fence contains unexpected content");
  }
  if (!metadataEntry && temporaryEntries.length === 0) {
    throw new IncompleteQuarantineFence("Pi agent-directory quarantine fence metadata publication is incomplete");
  }
  const retainedRoot = path.dirname(path.dirname(record.retainedPath));
  const key = await ensureCaptureAuthKey(retainedRoot, undefined, false, teardownAuthority);
  let temporaryInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  let temporaryBytes: Buffer | undefined;
  if (temporaryEntries.length === 1) {
    const temporaryPath = path.join(quarantine, temporaryEntries[0]!.name);
    temporaryInfo = await lstatRequired(temporaryPath, "Pi agent-directory quarantine metadata temporary file");
    assertPrivateFile(temporaryInfo, "Pi agent-directory quarantine metadata temporary file");
    try { temporaryBytes = await readStableFile(temporaryPath, "Pi agent-directory quarantine metadata temporary file"); }
    catch (error) {
      if (!metadataEntry) throw new IncompleteQuarantineFence("Pi agent-directory quarantine fence metadata publication is incomplete");
      throw new PreparationLockRace("Pi agent-directory quarantine metadata temporary file changed while being read", error);
    }
    try { parseRetainedFenceMetadata(temporaryBytes, record, fenceInfo, key); }
    catch (error) {
      if (!metadataEntry) throw new IncompleteQuarantineFence("Pi agent-directory quarantine fence metadata publication is incomplete");
      throw error;
    }
    if (!metadataEntry) {
      const metadataPath = path.join(quarantine, PREPARATION_CAPTURE_METADATA_FILE);
      try { await link(temporaryPath, metadataPath); }
      catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    }
  }
  const metadataPath = path.join(quarantine, PREPARATION_CAPTURE_METADATA_FILE);
  const metadataInfo = await lstatRequired(metadataPath, "Pi agent-directory quarantine metadata");
  assertPrivateFile(metadataInfo, "Pi agent-directory quarantine metadata");
  const metadata = await readStablePublicationFile(metadataPath, "Pi agent-directory quarantine metadata");
  parseRetainedFenceMetadata(metadata, record, fenceInfo, key);
  if (temporaryBytes) {
    if (!metadata.equals(temporaryBytes)) throw new PreparationLockRace("Pi agent-directory quarantine metadata final bytes conflict with its temporary publication");
    await removeConstructionFile(path.join(quarantine, temporaryEntries[0]!.name), temporaryInfo!, teardownAuthority);
  }
}

async function assertIncompleteQuarantineFenceConstruction(quarantine: string): Promise<void> {
  const info = await lstatRequired(quarantine, "Pi agent-directory quarantine fence construction");
  assertPrivateDirectory(info, "Pi agent-directory quarantine fence construction");
  const entries = await readdir(quarantine, { withFileTypes: true });
  if (entries.length === 0) return;
  if (entries.length !== 1 || !PREPARATION_CAPTURE_METADATA_TEMP.test(entries[0]!.name) || entries[0]!.isSymbolicLink() || !entries[0]!.isFile()) {
    throw new Error("Pi agent-directory quarantine fence contains unexpected content");
  }
  const temporaryInfo = await lstatRequired(path.join(quarantine, entries[0]!.name), "Pi agent-directory quarantine metadata temporary file");
  assertPrivateFile(temporaryInfo, "Pi agent-directory quarantine metadata temporary file");
}

async function discardIncompleteQuarantineFence(
  quarantine: string,
  observedInfo: Awaited<ReturnType<typeof lstat>>,
  found: { record: RetainedCaptureRecord; recordPath: string },
  signal: AbortSignal | undefined,
  teardownAuthority: TeardownAuthorityGuard,
): Promise<void> {
  throwIfAborted(signal);
  await assertIncompleteQuarantineFenceConstruction(quarantine);
  if (await pathKind(found.record.retainedPath) !== "missing") {
    throw new PreparationLockRace("Pi agent-directory quarantine has a conflicting retained destination");
  }
  await removeOwnedPathAfterQuiescence(
    quarantine,
    directoryIdentityOf(observedInfo),
    true,
    "Pi agent-directory quarantine fence",
    teardownAuthority,
    undefined,
    undefined,
  );
  const recordInfo = await lstatRequired(found.recordPath, "Pi agent-directory retained capture record before fence discard");
  assertPrivateFile(recordInfo, "Pi agent-directory retained capture record before fence discard");
  const current = await readRetainedCaptureRecord(found.recordPath, path.dirname(path.dirname(path.dirname(found.recordPath))), teardownAuthority);
  if (current.auth !== found.record.auth) throw new PreparationLockRace("Pi agent-directory retained capture record changed during fence discard");
  await removeOwnedPathAfterQuiescence(
    found.recordPath,
    directoryIdentityOf(recordInfo),
    false,
    "Pi agent-directory retained capture record",
    teardownAuthority,
    undefined,
    undefined,
  );
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
  teardownAuthority?: TeardownAuthorityGuard,
): Promise<number> {
  if (force && !teardownAuthority) throw new Error("trusted teardown authority is required for destructive reconciliation");
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
    try { found = await findRetainedRecordForQuarantine(runRoot, quarantine, true, teardownAuthority); }
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
    try { await verifyFenceMetadata(quarantine, found.record, teardownAuthority); }
    catch (error) {
      if (!(error instanceof IncompleteQuarantineFence)) throw error;
      if (!force) continue;
      if (!teardownAuthority) throw new Error("trusted teardown authority is required for incomplete quarantine disposal");
      await discardIncompleteQuarantineFence(quarantine, info, found, signal, teardownAuthority);
      reconciled += 1;
      continue;
    }
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
  await reconcileRetainedCaptures(path.dirname(runRoot), path.basename(runRoot), limits, signal, true, teardownAuthority);
  return reconciled;
}

async function reconcilePreparationLifecycle(
  runRoot: string,
  limits: RetentionLimits,
  staleMs: number,
  signal?: AbortSignal,
  force = false,
  teardownAuthority?: TeardownAuthorityGuard,
): Promise<number> {
  const runtimeRoot = path.dirname(runRoot);
  await reconcileRetainedCaptures(runtimeRoot, path.basename(runRoot), limits, signal, true, teardownAuthority);
  return reconcileQuarantineFences(runRoot, limits, staleMs, signal, force, teardownAuthority);
}

async function assertPreparationLifecycleQuiescent(runRoot: string, staleMs: number, teardownAuthority?: TeardownAuthorityGuard): Promise<void> {
  if (ACTIVE_PREPARATION_RUNS.has(path.resolve(runRoot))) throw new Error("Pi agent-directory teardown found a live preparation controller");
  const lockPath = path.join(runRoot, PREPARATION_LOCK_DIRECTORY);
  const lockKind = await pathKind(lockPath);
  if (lockKind !== "missing") {
    if (lockKind !== "directory") throw new Error("Pi agent-directory preparation lock is not a private directory");
    const lockInfo = await lstatRequired(lockPath, "Pi agent-directory preparation lock during teardown");
    assertPrivateDirectory(lockInfo, "Pi agent-directory preparation lock during teardown");
    const ownerPath = path.join(lockPath, PREPARATION_LOCK_OWNER_FILE);
    const ownerKind = await pathKind(ownerPath);
    if (ownerKind === "file") {
      const owner = await readPreparationLockOwner(ownerPath);
      if (isProcessAlive(owner.pid) && (owner.pid !== process.pid || ACTIVE_PREPARATION_RUNS.has(path.resolve(runRoot)))) throw new Error("Pi agent-directory teardown found a live preparation controller");
    } else if (ownerKind === "missing") {
      if (!isStale(mtimeMilliseconds(lockInfo), staleMs)) throw new Error("Pi agent-directory teardown found an active preparation controller");
    } else {
      throw new Error("Pi agent-directory preparation lock owner is not a regular file");
    }
  }
  const entries = await readdir(runRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(PREPARATION_QUARANTINE_PREFIX)) continue;
    if (!PREPARATION_QUARANTINE.test(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Pi agent-directory quarantine is not a private directory");
    const quarantine = path.join(runRoot, entry.name);
    const found = await findRetainedRecordForQuarantine(runRoot, quarantine, true, teardownAuthority);
    if (found.record.state === "fence" && isProcessAlive(found.record.ownerPid) && (found.record.ownerPid !== process.pid || ACTIVE_PREPARATION_RUNS.has(path.resolve(runRoot)))) throw new Error("Pi agent-directory teardown found a live preparation controller");
    try { await verifyFenceMetadata(quarantine, found.record, teardownAuthority); }
    catch (error) {
      if (!(error instanceof IncompleteQuarantineFence)) throw error;
      await assertIncompleteQuarantineFenceConstruction(quarantine);
    }
  }
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
  teardownAuthority: TeardownAuthorityGuard,
): Promise<void> {
  throwIfAborted(signal);
  await assertTerminalFence(runRoot);
  const lockPath = path.join(runRoot, PREPARATION_LOCK_DIRECTORY);
  const kind = await pathKind(lockPath);
  if (kind === "missing") return;
  if (kind !== "directory") throw new Error("Pi agent-directory preparation lock is not a private directory");
  const info = await lstatRequired(lockPath, "Pi agent-directory preparation lock before teardown");
  assertPrivateDirectory(info, "Pi agent-directory preparation lock before teardown");
  const before = await lstatRequired(lockPath, "Pi agent-directory preparation lock before teardown");
  assertPrivateDirectory(before, "Pi agent-directory preparation lock before teardown");
  if (!sameDirectoryIdentity(directoryIdentityOf(info), directoryIdentityOf(before))) throw new PreparationLockRace("Pi agent-directory preparation lock changed during teardown");
  const ownerPath = path.join(lockPath, PREPARATION_LOCK_OWNER_FILE);
  if (await pathKind(ownerPath) === "file") await readPreparationLockOwner(ownerPath);
  await assertTerminalFence(runRoot);
  await teardownAuthority?.();
  if (runId !== path.basename(runRoot)) throw new PreparationLockRace("Pi agent-directory preparation lock run identity changed");
  // A terminal fence is the trusted quiescence authority for this one
  // disposable lock. Move the owned object out of the shared pathname before
  // disposal so a replacement at .pi-agent-lock cannot be removed by name.
  await removeOwnedPathAfterQuiescence(lockPath, directoryIdentityOf(info), true, "Pi agent-directory preparation lock", teardownAuthority, undefined, undefined);
}

async function removeRetainedCapturesAfterQuiescence(
  runtimeRoot: string,
  runId: string,
  limits: RetentionLimits,
  signal: AbortSignal | undefined,
  teardownAuthority: TeardownAuthorityGuard,
): Promise<number> {
  const runRoot = path.join(runtimeRoot, runId);
  const location = await ensureRetentionLocation(runRoot, limits.publicationBarrier, false, teardownAuthority, limits.authCleanupBarrier);
  await assertTerminalFence(runRoot);
  await teardownAuthority?.();
  const allocationLock = await acquireRetentionAllocationLock(location.retainedRoot, runId, signal, true, teardownAuthority, limits.authCleanupBarrier, limits.allocationClaimBarrier);
  try {
    await clearRetainedDisposalEntries(location.retainedRoot, runId, teardownAuthority);
    await clearRetainedConstructionEntries(
      location.retainedRun,
      path.join(location.retainedRoot, PREPARATION_RETAINED_DISPOSAL_DIRECTORY),
      runId,
      teardownAuthority,
    );
    const records = await reconcileRetainedCaptures(runtimeRoot, runId, limits, signal, true, teardownAuthority);
    let removed = 0;
    for (const item of records) {
      throwIfAborted(signal);
      await assertTerminalFence(runRoot);
      await teardownAuthority?.();
      const current = await readRetainedCaptureRecord(item.recordPath, runtimeRoot, teardownAuthority);
      if (current.auth !== item.record.auth) throw new Error("Pi agent-directory retained capture changed during teardown");
      const objectKind = current.objectKind;
      const object = await pathKind(current.retainedPath);
      if (object !== "missing") {
        const info = await lstatRequired(current.retainedPath, "Pi agent-directory retained capture before teardown");
        if (objectKind === "directory") assertPrivateDirectory(info, "Pi agent-directory retained capture before teardown");
        else assertPrivateFile(info, "Pi agent-directory retained capture before teardown");
        if (current.state !== "fence" && !sameIdentityRecord(current.capturedIdentity, directoryIdentityOf(info))) throw new Error("Pi agent-directory retained capture identity changed during teardown");
        if (current.state === "fence") await verifyFenceMetadata(current.retainedPath, current, teardownAuthority);
        const afterInfo = await lstatRequired(current.retainedPath, "Pi agent-directory retained capture after teardown fence");
        if (objectKind === "directory") assertPrivateDirectory(afterInfo, "Pi agent-directory retained capture after teardown fence");
        else assertPrivateFile(afterInfo, "Pi agent-directory retained capture after teardown fence");
        if (current.state !== "fence" && !sameIdentityRecord(current.capturedIdentity, directoryIdentityOf(afterInfo))) throw new Error("Pi agent-directory retained capture identity changed during teardown");
        if (current.state === "fence") await verifyFenceMetadata(current.retainedPath, current, teardownAuthority);
        await assertTerminalFence(runRoot);
        // The permanent workflow/filesystem fence excludes every compliant
        // controller. Move the verified object away from its shared ledger
        // pathname before disposal so a later replacement cannot be removed
        // by that pathname.
        await removeOwnedPathAfterQuiescence(
          current.retainedPath,
          directoryIdentityOf(afterInfo),
          objectKind === "directory",
          "Pi agent-directory retained capture",
          teardownAuthority,
          path.join(location.retainedRoot, PREPARATION_RETAINED_DISPOSAL_DIRECTORY),
          runId,
        );
      }
      const recordInfo = await lstatRequired(item.recordPath, "Pi agent-directory retained capture record before teardown");
      assertPrivateFile(recordInfo, "Pi agent-directory retained capture record before teardown");
      const finalRecord = await readRetainedCaptureRecord(item.recordPath, runtimeRoot, teardownAuthority);
      if (finalRecord.auth !== current.auth) throw new Error("Pi agent-directory retained capture changed during teardown");
      const finalRecordInfo = await lstatRequired(item.recordPath, "Pi agent-directory retained capture record after teardown fence");
      assertPrivateFile(finalRecordInfo, "Pi agent-directory retained capture record after teardown fence");
      if (!sameFileStat(recordInfo, finalRecordInfo)) throw new Error("Pi agent-directory retained capture record changed during teardown");
      await assertTerminalFence(runRoot);
      await teardownAuthority?.();
      await removeOwnedPathAfterQuiescence(
        item.recordPath,
        directoryIdentityOf(finalRecordInfo),
        false,
        "Pi agent-directory retained capture record",
        teardownAuthority,
        path.join(location.retainedRoot, PREPARATION_RETAINED_DISPOSAL_DIRECTORY),
        runId,
      );
      removed += 1;
    }
    const remaining = await readdir(location.retainedRun, { withFileTypes: true });
    if (remaining.length !== 0) throw new Error("Pi agent-directory retained quarantine contains unexpected content after teardown");
    const runInfo = await lstatRequired(location.retainedRun, "Pi agent-directory retained quarantine run");
    assertPrivateDirectory(runInfo, "Pi agent-directory retained quarantine run");
    await assertTerminalFence(runRoot);
    await teardownAuthority?.();
    const finalRunInfo = await lstatRequired(location.retainedRun, "Pi agent-directory retained quarantine run after teardown fence");
    assertPrivateDirectory(finalRunInfo, "Pi agent-directory retained quarantine run after teardown fence");
    if (!sameDirectoryIdentity(directoryIdentityOf(runInfo), directoryIdentityOf(finalRunInfo))) throw new PreparationLockRace("Pi agent-directory retained quarantine run changed during teardown");
    await removeOwnedPathAfterQuiescence(
      location.retainedRun,
      directoryIdentityOf(finalRunInfo),
      true,
      "Pi agent-directory retained quarantine run",
      teardownAuthority,
      path.join(location.retainedRoot, PREPARATION_RETAINED_DISPOSAL_DIRECTORY),
      runId,
    );
    return removed;
  } finally {
    await releaseRetentionAllocationLock(allocationLock);
  }
}

async function clearRetainedDisposalEntries(retainedRoot: string, runId: string, teardownAuthority: TeardownAuthorityGuard): Promise<void> {
  const directory = path.join(retainedRoot, PREPARATION_RETAINED_DISPOSAL_DIRECTORY);
  const kind = await pathKind(directory);
  if (kind === "missing") return;
  if (kind !== "directory") throw new Error("Pi agent-directory retained disposal root is invalid");
  const rootInfo = await lstatRequired(directory, "Pi agent-directory retained disposal root");
  assertPrivateDirectory(rootInfo, "Pi agent-directory retained disposal root");
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const match = PREPARATION_RETAINED_DISPOSAL.exec(entry.name);
    if (!match) throw new Error("Pi agent-directory retained disposal contains unexpected content");
    if (match[1] !== runId) continue;
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error("Pi agent-directory retained disposal contains invalid content");
    const target = path.join(directory, entry.name);
    const info = await lstatRequired(target, "Pi agent-directory retained disposal");
    if (entry.isDirectory()) assertPrivateDirectory(info, "Pi agent-directory retained disposal");
    else assertPrivateFile(info, "Pi agent-directory retained disposal");
    await removeOwnedPathAfterQuiescence(target, directoryIdentityOf(info), entry.isDirectory(), "Pi agent-directory retained disposal", teardownAuthority, directory, runId);
  }
}

async function clearRetainedConstructionEntries(directory: string, disposalDirectory: string, disposalRunId: string | undefined, teardownAuthority: TeardownAuthorityGuard): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(".capture-") && !entry.name.startsWith(".fence-")) continue;
    const target = path.join(directory, entry.name);
    const info = await lstatRequired(target, "Pi agent-directory retained construction");
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error("Pi agent-directory retained construction is invalid");
    if (entry.isDirectory()) assertPrivateDirectory(info, "Pi agent-directory retained construction");
    else assertPrivateFile(info, "Pi agent-directory retained construction");
    const before = await lstatRequired(target, "Pi agent-directory retained construction");
    if (!sameFileStat(info, before)) throw new PreparationLockRace("Pi agent-directory retained construction changed");
    await removeOwnedPathAfterQuiescence(
      target,
      directoryIdentityOf(before),
      entry.isDirectory(),
      "Pi agent-directory retained construction",
      teardownAuthority,
      disposalDirectory,
      disposalRunId,
    );
  }
}

async function removeTerminalSandboxDisposals(
  runtimeRoot: string,
  runRoot: string,
  fence: TerminalFenceRecord,
  signal: AbortSignal | undefined,
  teardownAuthority: TeardownAuthorityGuard,
): Promise<void> {
  throwIfAborted(signal);
  const directory = path.join(runtimeRoot, PREPARATION_TERMINAL_FENCE_ROOT, PREPARATION_TERMINAL_DISPOSAL_DIRECTORY);
  const kind = await pathKind(directory);
  if (kind === "missing") return;
  if (kind !== "directory") throw new Error("Pi agent-directory terminal sandbox disposal is not a private directory");
  const rootInfo = await lstatRequired(directory, "Pi agent-directory terminal sandbox disposal");
  assertPrivateDirectory(rootInfo, "Pi agent-directory terminal sandbox disposal");
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const match = PREPARATION_RETAINED_DISPOSAL.exec(entry.name);
    if (!match) throw new Error("Pi agent-directory terminal sandbox disposal contains unexpected content");
    if (match[1] !== fence.runId) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Pi agent-directory terminal sandbox disposal contains invalid content");
    if (await pathKind(runRoot) !== "missing") throw new PreparationLockRace("Pi agent-directory run sandbox was replaced during teardown");
    if (!fence.sandboxIdentity) throw new PreparationLockRace("Pi agent-directory terminal fence has an unexpected sandbox disposal");
    const target = path.join(directory, entry.name);
    const info = await lstatRequired(target, "Pi agent-directory terminal sandbox disposal entry");
    assertPrivateDirectory(info, "Pi agent-directory terminal sandbox disposal entry");
    if (!sameIdentityRecord(fence.sandboxIdentity, directoryIdentityOf(info))) throw new PreparationLockRace("Pi agent-directory terminal sandbox disposal identity changed");
    await teardownAuthority?.();
    await removeOwnedPathAfterQuiescence(
      target,
      directoryIdentityOf(info),
      true,
      "Pi agent-directory terminal sandbox disposal entry",
      teardownAuthority,
      directory,
      fence.runId,
    );
  }
}

async function removeRunSandboxAfterTerminalFence(runtimeRoot: string, runRoot: string, signal: AbortSignal | undefined, teardownAuthority: TeardownAuthorityGuard): Promise<void> {
  const fence = await assertTerminalFence(runRoot);
  await removeTerminalSandboxDisposals(runtimeRoot, runRoot, fence, signal, teardownAuthority);
  const info = await lstatRequired(runRoot, "Pi agent-directory run sandbox before removal");
  assertPrivateDirectory(info, "Pi agent-directory run sandbox before removal");
  await assertTerminalFence(runRoot);
  const before = await lstatRequired(runRoot, "Pi agent-directory run sandbox before removal");
  assertPrivateDirectory(before, "Pi agent-directory run sandbox before removal");
  if (!sameDirectoryIdentity(directoryIdentityOf(info), directoryIdentityOf(before))) throw new PreparationLockRace("Pi agent-directory run sandbox changed during removal");
  if (!fence.sandboxIdentity || !sameIdentityRecord(fence.sandboxIdentity, directoryIdentityOf(before))) {
    throw new PreparationLockRace("Pi agent-directory run sandbox identity changed during teardown");
  }
  await teardownAuthority?.();
  // The durable workflow fence has already stopped every compliant
  // controller and role. Move the verified sandbox away from the shared run
  // pathname before recursive disposal; a replacement run root can then only
  // survive, never be removed by this cleanup. The separate terminal disposal
  // namespace lets a retry distinguish the original object from a replacement.
  const disposal = path.join(runtimeRoot, PREPARATION_TERMINAL_FENCE_ROOT, PREPARATION_TERMINAL_DISPOSAL_DIRECTORY);
  await removeOwnedPathAfterQuiescence(runRoot, directoryIdentityOf(before), true, "Pi agent-directory run sandbox", teardownAuthority, disposal, fence.runId);
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
  const location = await ensureRetentionLocation(runRoot, limits.publicationBarrier, false, undefined, limits.authCleanupBarrier);
  if (!path.isAbsolute(source) || !path.isAbsolute(quarantinePath)) throw new Error(`${name} retained capture paths must be absolute`);
  const allocationLock = await acquireRetentionAllocationLock(location.retainedRoot, path.basename(runRoot), undefined, false, undefined, limits.authCleanupBarrier, limits.allocationClaimBarrier);
  try {
    // Both bounds are checked while the process-independent allocation mutex is
    // held. This closes the last race where two run controllers observed the
    // same count and each appended a capture.
    const current = await reconcileRetainedCaptures(location.runtimeRoot, path.basename(runRoot), limits, undefined, true);
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
      // Keep the private construction pathname beside its authenticated final
      // record. A restart can therefore link a complete temporary record to
      // the final name before any allocation is attempted again.
      await writeRetainedCaptureRecord(recordPath, payload, location.retainedRoot, location.retainedRun, limits.publicationBarrier);
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
    if (entry.name === PREPARATION_RETAINED_AUTH_FILE || entry.name === PREPARATION_RETAINED_ALLOCATION_ROOT_MARKER || entry.name === PREPARATION_RETAINED_DISPOSAL_DIRECTORY || entry.name === PREPARATION_RETAINED_ALLOCATION_LOCK || PREPARATION_RETAINED_ALLOCATION_HELD.test(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory() || !PREPARATION_RETAINED_RUN.test(entry.name)) throw new Error("Pi agent-directory retained quarantine has unexpected content");
    const location: RetainedCaptureLocation = { runtimeRoot, retainedRoot, retainedRun: path.join(retainedRoot, entry.name) };
    total += (await readRetainedRecordsForRun(location, true)).length;
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
  const location = await ensureRetentionLocation(runRoot, limits.publicationBarrier, false, undefined, limits.authCleanupBarrier);
  const record = await readRetainedCaptureRecord(allocation.recordPath, location.runtimeRoot);
  try {
    await mkdir(candidate, { recursive: false, mode: 0o700 });
    await chmod(candidate, 0o700);
    await ensureSecureDirectory(candidate, "Pi agent-directory quarantine fence", true);
    const fenceInfo = await lstatRequired(candidate, "Pi agent-directory quarantine fence");
    assertPrivateDirectory(fenceInfo, "Pi agent-directory quarantine fence");
    const metadata = await serializeRetainedFenceMetadata(record, directoryIdentityOf(fenceInfo), location.retainedRoot, limits.publicationBarrier);
    const metadataPath = path.join(candidate, PREPARATION_CAPTURE_METADATA_FILE);
    // The fence directory may be observed by a restarted controller. Publish
    // its authenticated metadata through a private construction name so the
    // final capture.json is either absent or complete and resumable.
    await publishPrivateFile(metadataPath, metadata, 0o600, candidate, "fence-metadata", limits.publicationBarrier);
    const metadataInfo = await lstatRequired(metadataPath, "Pi agent-directory quarantine metadata");
    assertPrivateFile(metadataInfo, "Pi agent-directory quarantine metadata");
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
  const legacyKeys = ["createdAt", "kind", "pid", "schemaVersion", "token"].join("\\0");
  const authenticatedKeys = ["createdAt", "kind", "pid", "requestFingerprint", "runId", "schemaVersion", "token"].join("\\0");
  if (keys.join("\\0") !== legacyKeys && keys.join("\\0") !== authenticatedKeys) return false;
  const baseValid = candidate["schemaVersion"] === PREPARATION_LOCK_SCHEMA_VERSION
    && candidate["kind"] === PREPARATION_RECLAIM_KIND
    && typeof candidate["token"] === "string" && UUID.test(candidate["token"])
    && typeof candidate["pid"] === "number" && Number.isInteger(candidate["pid"]) && candidate["pid"] > 0
    && typeof candidate["createdAt"] === "number" && Number.isSafeInteger(candidate["createdAt"]) && candidate["createdAt"] > 0;
  if (!baseValid) return false;
  return keys.join("\\0") === legacyKeys
    || (typeof candidate["runId"] === "string" && RUN_ID.test(candidate["runId"])
      && typeof candidate["requestFingerprint"] === "string" && SHA256.test(candidate["requestFingerprint"]));
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
    && left.runId === right.runId
    && left.requestFingerprint === right.requestFingerprint
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
    trustedExtensionPathsByRole: {
      plan: [prepared.wikiExtension, path.join(layout.agentDir, PLAN_FILE), footerPath(layout.agentDir)],
      implement: [prepared.wikiExtension, footerPath(layout.agentDir)],
      review: [prepared.wikiExtension, footerPath(layout.agentDir)],
      test: [prepared.wikiExtension, footerPath(layout.agentDir)],
      orchestrator: [prepared.wikiExtension, footerPath(layout.agentDir)],
    },
    planExtensionPath: path.join(layout.agentDir, PLAN_FILE),
    planExtensionDigest: prepared.planDigest,
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

async function readStableFile(value: string, name: string, beforeRead?: () => void | Promise<void>): Promise<Buffer> {
  const before = await lstatRequired(value, name);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${name} is not a regular file`);
  await beforeRead?.();
  const bytes = await readFile(value);
  const after = await lstatRequired(value, name);
  if (!sameFileStat(before, after)) throw new Error(`${name} changed while it was being read`);
  return bytes;
}

async function readStablePublicationFile(value: string, name: string): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PREPARATION_LOCK_RACE_RETRIES; attempt += 1) {
    try { return await readStableFile(value, name); }
    catch (error) {
      if (!(error instanceof Error) || !/changed while it was being read/iu.test(error.message)) throw error;
      lastError = error;
      if (attempt + 1 < PREPARATION_LOCK_RACE_RETRIES) await waitForDelay(PREPARATION_LOCK_RACE_DELAY_MS);
    }
  }
  throw new PreparationLockRace(`${name} did not stabilize after publication`, lastError);
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
function markActivePreparation(key: string): void {
  ACTIVE_PREPARATION_RUNS.set(key, (ACTIVE_PREPARATION_RUNS.get(key) ?? 0) + 1);
}
function unmarkActivePreparation(key: string): void {
  const count = ACTIVE_PREPARATION_RUNS.get(key) ?? 0;
  if (count <= 1) ACTIVE_PREPARATION_RUNS.delete(key);
  else ACTIVE_PREPARATION_RUNS.set(key, count - 1);
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
