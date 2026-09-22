import { validateEvidenceRef } from "./report-evidence.js";
import { validateLaunchRetryState, assertLaunchRetryUnchanged } from "./launch-retry.js";
import { observeOwnerFile, ownerProcessIdentity, parseOperation, type OperationEvidence } from "./owner-observation.js";
import { access, lstat, mkdir, open, readFile, readdir, rm, link, unlink, rmdir, writeFile, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateLaunchEvidence } from "./launch-material.js";
import { validateModelPolicy } from "./model-policy.js";
import { deterministicFeatureBranch } from "./identity.js";
import { renameOverExistingWithRetry, type RenameRetryOptions } from "./atomic-rename.js";
import { windowsLaunch } from "./windows-launch.js";
import { validatePhaseResultShape } from "./phase-result.js";
import { PERSONAL_PHASES, type PersonalPhase, type PersonalRunState, type RunStatePort, type PhaseProfile, type ResolvedPhaseProfiles, type RunExecutionMode, type RunLifecycle, type RunLaunchState, type RunPreparationState } from "./types.js";
import { JsonRunEventOutbox } from "./run-events.js";

const REQUIRED_STATE_KEYS = ["schemaVersion", "version", "runId", "ticketId", "ticketTitle", "status", "step", "sandbox", "repository", "baseBranch", "baseSha", "branch", "head", "sessions", "attempts", "results", "contract", "candidate", "verifyDisposition", "publicationState", "ciDisposition", "mergeDisposition", "terminalReason", "prUrl", "lastError", "updatedAt"] as const;
const OPTIONAL_STATE_KEYS = [
  "launchRetryPolicy", "launchGenerations", "reports",
  "profiles",
  "lifecycle",
  "launchState",
  "preparationState",
  "executionMode",
  "startedAt",
  "endedAt",
  "controllerPid",
  "stdoutPath",
  "stderrPath",
  "repositoryPath",
  "sourceRef",
  "sourceSha",
  "launchConfigPath",
  "launchConfigDigest",
  "launchEvidence",
  "reservationCleanupFailure",
] as const;
const RUN_STATUSES = ["running", "completed", "failed", "interrupted"] as const;
const RUN_STEPS = ["launching", "preparing", ...PERSONAL_PHASES, "publishing", "complete"] as const;
const RUN_LIFECYCLES = ["launching", "preparing", "running", "publishing", "completed", "failed", "interrupted"] as const;
const RUN_LAUNCH_STATES = ["reserved", "started", "failed"] as const;
const RUN_PREPARATION_STATES = ["pending", "started", "ready", "failed"] as const;
const EXECUTION_MODES = ["foreground", "background"] as const;
const REMEDIATION_ATTEMPT_LIMIT = 32;
const MAX_PHASE_ATTEMPT = 1_000_000;
const TICKET_ID_PATTERN = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,127}$/u;

export interface JsonRunStateStoreOptions {
  readonly eventDirectory?: string;
  readonly maxEvents?: number;
  readonly maxEventBytes?: number;
  /** Event publication is best-effort after state commit; diagnostics never roll state back. */
  readonly onEventPersistenceError?: (error: unknown) => void;
  /** Internal deterministic seam for Windows rename contention handling. */
  readonly renameRetry?: RenameRetryOptions;
}

export class JsonRunStateStore implements RunStatePort {
  readonly eventOutbox: JsonRunEventOutbox;
  readonly eventDirectory: string;
  readonly eventsDirectory: string;
  readonly #onEventPersistenceError: (error: unknown) => void;
  readonly #renameRetry: RenameRetryOptions;

  constructor(readonly directory: string, options: JsonRunStateStoreOptions = {}) {
    this.eventOutbox = new JsonRunEventOutbox(directory, {
      ...(options.eventDirectory === undefined ? {} : { eventDirectory: options.eventDirectory }),
      ...(options.maxEvents === undefined ? {} : { maxEvents: options.maxEvents }),
      ...(options.maxEventBytes === undefined ? {} : { maxBytes: options.maxEventBytes }),
      ...(options.renameRetry === undefined ? {} : { renameRetry: options.renameRetry }),
    });
    this.eventDirectory = this.eventOutbox.eventDirectory;
    this.eventsDirectory = this.eventDirectory;
    this.#onEventPersistenceError = options.onEventPersistenceError ?? (() => undefined);
    this.#renameRetry = options.renameRetry ?? {};
  }

  async create(state: PersonalRunState): Promise<void> {
    validateState(state);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.#path(state.runId);
    await atomicCreate(target, encode(state), this.directory, state.runId);
    await this.#publishTransition(undefined, state);
  }

  /**
   * Atomically reserve a ticket and publish its first state. The lock is a
   * short-lived ownership marker, not a lease: it is removed only after this
   * run has recorded a terminal state. An unknown lock is intentionally
   * treated as ambiguous and requires owner intervention.
   */
  async reserve(state: PersonalRunState): Promise<void> {
    validateState(state);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // The reservation pathname is held for the whole run, while this separate
    // short-lived boundary serializes reserve/release against one another.
    // Without it, an old releaser can read its owner, a replacement can be
    // installed, and the old releaser can unlink the replacement.
    return withTicketOperation(this.directory, state.ticketId, async (operation) => {
      const locks = path.join(this.directory, "locks");
      await mkdir(locks, { recursive: true, mode: 0o700 });
      const lockPath = path.join(locks, `${state.ticketId.toLowerCase()}.lock`);
      let lockHandle;
      let lockAcquired = false;
      try {
        lockHandle = await open(lockPath, "wx", 0o600);
        lockAcquired = true;
        await lockHandle.writeFile(`${state.runId}\n`, "utf8");
        await lockHandle.sync();
        await lockHandle.close();
        lockHandle = undefined;
      } catch (error) {
        await lockHandle?.close().catch(() => undefined);
        // A write/close failure is not permission to unlink whatever now
        // occupies the pathname. Leave a changed or malformed record visible
        // as ambiguity rather than allowing a failed reserver to delete a
        // replacement owner.
        if (lockAcquired) await removeReservationIfOwned(lockPath, state.runId).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Never reclaim here, even if the owner's state appears terminal. The
        // previous owner may be between its final ownership check and unlink;
        // deleting/recreating the pathname would let that release delete a new
        // owner's reservation. A terminal lock is conservatively ambiguous
        // until its exact owner completes release or an operator intervenes.
        throw new Error(`ticket already has an active or ambiguous reservation: ${state.ticketId}`);
      }

      try {
        // A manually removed/stale lock must not make an already-running state
        // invisible. The operation boundary serializes this scan against
        // reserve and release in every Squire process.
        const active = (await this.findByTicket(state.ticketId)).filter(candidate => candidate.status === "running");
        if (active.length > 0) throw new Error(`ticket already has an active run: ${state.ticketId}`);
        await this.#publishOwner(state, operation, "reserve");
        await atomicCreate(this.#path(state.runId), encode(state), this.directory, state.runId);
        await waitForTicketOperationBarrier("reserve-published");
        await this.#publishTransition(undefined, state);
      } catch (error) {
        // Only remove a reservation whose owner is still this run. If an
        // operator or a non-Squire process replaced it, fail closed and leave
        // the ambiguity visible rather than deleting another owner's lock.
        await waitForTicketOperationBarrier("reserve-before-failed-cleanup");
        await removeReservationIfOwned(lockPath, state.runId).catch(() => undefined);
        throw error;
      }
    });
  }

  async save(state: PersonalRunState): Promise<void> {
    validateState(state);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.#path(state.runId);
    // Source binding is a launch-ownership transition, not an ordinary
    // per-run update. Decide whether the proposed state needs that stronger
    // boundary from a snapshot, then recheck the authoritative state while the
    // ticket operation is held. The snapshot is only an optimization; it is
    // never used as the version or ownership decision.
    const observed = await this.#read(target, state.runId);
    const launchUpdate = (state.launchGenerations?.length ?? 0) > (observed?.launchGenerations?.length ?? 0);
    const sourceBinding = observed?.sourceSha === undefined && state.sourceSha !== undefined;
    const save = async (): Promise<void> => {
      const releaseUpdate = await acquireUpdateLock(this.directory, state.runId);
      try {
        // The version check and replacement are one serialized operation across
        // processes. A crashed writer leaves the update lock in place and
        // fails closed rather than allowing a stale writer to overwrite newer
        // truth.
        const current = await this.#read(target, state.runId);
        if (!current) throw new Error(`run state does not exist: ${state.runId}`);
        if (state.version !== current.version + 1) throw new Error("run state version must advance by one");
        if (launchUpdate && (current.status !== "running" || state.status !== "running" || current.controllerPid !== state.controllerPid || (current.controllerPid != null && current.controllerPid !== process.pid) || await readLock(this.#reservationPath(state.ticketId)) !== state.runId)) throw new Error("launch generation ownership mismatch");
        assertResolvedProfilesUnchanged(current, state);
        assertLaunchIdentityUnchanged(current, state);
        if (sourceBinding && (current.sourceSha === undefined || current.sourceSha !== state.sourceSha)) {
          if (!isReservedLaunch(current) || await readLock(this.#reservationPath(state.ticketId)) !== state.runId) {
            throw new Error(`reserved source binding does not belong to run: ${state.runId}`);
          }
        }
        await this.#replaceState(target, state);
        await this.#publishTransition(current, state);
      } finally {
        await releaseUpdate();
      }
    };
    if (sourceBinding || launchUpdate) return withTicketOperation(this.directory, state.ticketId, save);
    return save();
  }

  /**
   * Claim the reserved-to-started transition while holding both the existing
   * per-ticket operation boundary and the existing per-run version lock.
   */
  async claimReserved(state: PersonalRunState): Promise<void> {
    validateState(state);
    if (!isStartedChild(state)) throw new Error("reserved run claim target is invalid");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return withTicketOperation(this.directory, state.ticketId, async (operation) => {
      const lockPath = this.#reservationPath(state.ticketId);
      if (await readLock(lockPath) !== state.runId) throw new Error(`reserved run reservation ownership mismatch: ${state.runId}`);
      const releaseUpdate = await acquireUpdateLock(this.directory, state.runId);
      try {
        const target = this.#path(state.runId);
        const current = await this.#read(target, state.runId);
        if (!current) throw new Error(`run state does not exist: ${state.runId}`);
        if (!isReservedLaunch(current)) throw new Error(`reserved run claim is no longer available: ${state.runId}`);
        if (state.version !== current.version + 1) throw new Error("run state version must advance by one");
        assertExactStartedChildTarget(current, state);
        await this.#publishOwner(state, operation, "claim");
        await waitForTicketOperationBarrier("claim-before-state");
        await this.#replaceState(target, state);
        await waitForTicketOperationBarrier("claim-published");
        await this.#publishTransition(current, state);
      } finally {
        await releaseUpdate();
      }
    });
  }

  /**
   * Terminalize an unclaimed background launch and release its reservation
   * while holding the same ticket boundary and per-run version lock.
   */
  async failReserved(state: PersonalRunState): Promise<void> {
    validateState(state);
    if ((state.status !== "failed" && state.status !== "interrupted") || state.executionMode !== "background" || state.launchState !== "failed") throw new Error("reserved run failure target is invalid");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return withTicketOperation(this.directory, state.ticketId, async () => {
      const lockPath = this.#reservationPath(state.ticketId);
      if (await readLock(lockPath) !== state.runId) throw new Error(`reserved run reservation ownership mismatch: ${state.runId}`);
      const releaseUpdate = await acquireUpdateLock(this.directory, state.runId);
      try {
        const target = this.#path(state.runId);
        const current = await this.#read(target, state.runId);
        if (!current) throw new Error(`run state does not exist: ${state.runId}`);
        if (!isReservedLaunch(current)) throw new Error(`reserved run failure is no longer available: ${state.runId}`);
        if (state.version !== current.version + 1) throw new Error("run state version must advance by one");
        assertExactReservedFailureTarget(current, state);
        await this.#replaceState(target, state);
        await this.#publishTransition(current, state);
      } finally {
        await releaseUpdate();
      }
      await removeReservationIfOwned(lockPath, state.runId);
      await waitForTicketOperationBarrier("abandon-published");
    });
  }

  /** Bind the source commit before a detached child can claim the run. */
  async bindSource(state: PersonalRunState): Promise<void> {
    validateState(state);
    if (!isReservedLaunch(state) || state.sourceSha === undefined) throw new Error("reserved source binding target is invalid");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return withTicketOperation(this.directory, state.ticketId, async () => {
      const lockPath = this.#reservationPath(state.ticketId);
      if (await readLock(lockPath) !== state.runId) throw new Error(`reserved run reservation ownership mismatch: ${state.runId}`);
      const releaseUpdate = await acquireUpdateLock(this.directory, state.runId);
      try {
        const target = this.#path(state.runId);
        const current = await this.#read(target, state.runId);
        if (!current) throw new Error(`run state does not exist: ${state.runId}`);
        if (!isReservedLaunch(current) || current.sourceSha !== undefined) throw new Error(`reserved source binding is no longer available: ${state.runId}`);
        if (state.version !== current.version + 1) throw new Error("run state version must advance by one");
        assertExactSourceBindingTarget(current, state);
        await this.#replaceState(target, state);
        await this.#publishTransition(current, state);
      } finally {
        await releaseUpdate();
      }
    });
  }

  async findActive(ticketId: string): Promise<PersonalRunState | undefined> {
    const matches = (await this.findByTicket(ticketId)).filter(state => state.status === "running");
    if (matches.length > 1) throw new Error(`multiple active runs found for ${ticketId}`);
    return matches[0];
  }

  async findByTicket(ticketId: string): Promise<readonly PersonalRunState[]> {
    assertTicketId(ticketId);
    return (await this.list(ticketId)).filter(state => state.ticketId === ticketId);
  }

  async list(ticketId?: string): Promise<readonly PersonalRunState[]> {
    const files = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const matches: PersonalRunState[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      if (ticketId && !file.startsWith(ticketId.toLowerCase()+"-")) continue;
      const filenameRunId = file.slice(0, -".json".length);
      if (!RUN_ID_PATTERN.test(filenameRunId)) throw new Error(`invalid run state filename: ${file}`);
      const state = await this.#read(path.join(this.directory, file), filenameRunId, true);
      if (state) matches.push(state);
    }
    return matches.sort(compareStates);
  }

  async read(runId: string): Promise<PersonalRunState | undefined> {
    return this.#read(this.#path(runId), runId);
  }

  async #publishOwner(state: PersonalRunState, operation: OperationEvidence, stage: "reserve" | "claim"): Promise<void> {
    const reservation = await observeOwnerFile(this.#reservationPath(state.ticketId));
    if (!reservation || reservation.bytes !== `${state.runId}\n`) throw new Error("reservation changed before owner publication");
    const target = `${this.#reservationPath(state.ticketId)}.owner`;
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ ...operation, runId: state.runId, reservationIdentity: reservation.identity, stage }));
      await handle.sync();
      await handle.close();
      const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!existing) {
        await link(temporary, target); // exclusive initial proof publication
      } else {
        const options = process.platform === "win32" ? { rename: async (source: string, destination: string): Promise<void> => {
          windowsLaunch().replaceState(path.resolve(source), path.resolve(destination));
        } } : {};
        await renameOverExistingWithRetry(temporary, target, options);
      }
    } finally {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
    }
  }

  /** Owner-published proof is observational only, never permission to recover. */
  async observeReservation(ticketId: string): Promise<import("./types.js").ReservationObservation> {
    assertTicketId(ticketId);
    try {
      const operation = await observeOwnerFile(path.join(this.directory, "ticket-operations", `${ticketId.toLowerCase()}.lock`));
      let operationOwner: OperationEvidence | undefined;
      if (operation) {
        const owner = parseOperation(operation.bytes, ticketId);
        if (await ownerProcessIdentity(owner.pid) !== owner.processIdentity) throw new Error("operation process identity changed");
        operationOwner = owner;
      }
      const reservation = await observeOwnerFile(this.#reservationPath(ticketId));
      if (!reservation) return { kind: "absent", snapshot: JSON.stringify({ operation }) };
      const runId = reservation.bytes.endsWith("\n") ? reservation.bytes.slice(0, -1) : reservation.bytes;
      if (!RUN_ID_PATTERN.test(runId) || !runId.startsWith(`${ticketId.toLowerCase()}-`)) throw new Error("reservation identity inconsistent");
      const proof = await observeOwnerFile(`${this.#reservationPath(ticketId)}.owner`);
      if (!proof) throw new Error("owner evidence missing");
      const value = JSON.parse(proof.bytes) as OperationEvidence & { runId: string; reservationIdentity: string; stage: string };
      const { runId: proofRun, reservationIdentity, stage, ...identity } = value;
      const owner = parseOperation(JSON.stringify(identity), ticketId);
      if (proofRun !== runId || reservationIdentity !== reservation.identity || !["reserve", "claim"].includes(stage) ||
          await ownerProcessIdentity(owner.pid) !== owner.processIdentity) throw new Error("owner evidence inconsistent");
      if (operationOwner && (operationOwner.operationReservationIdentity !== null
        ? operationOwner.operationReservationIdentity !== reservation.identity
        : operationOwner.token !== owner.token)) throw new Error("operation fencing inconsistent");
      return { kind: "owner", runId, pid: owner.pid, stage: stage as "reserve" | "claim", transition: operationOwner?.token === owner.token && operationOwner.pid === owner.pid && operationOwner.processIdentity === owner.processIdentity, snapshot: JSON.stringify({ operation, reservation, proof }) };
    } catch {
      return { kind: "ambiguous", reason: "owner evidence unreadable or inconsistent" };
    }
  }

  async reservationOwner(ticketId: string): Promise<string | undefined> {
    assertTicketId(ticketId);
    return withTicketOperation(this.directory, ticketId, async () => readLock(this.#reservationPath(ticketId)));
  }

  async readEvents(runId: string): Promise<readonly import("./run-events.js").RunEvent[]> {
    return this.eventOutbox.read(runId);
  }

  async listEvents(runId: string): Promise<readonly import("./run-events.js").RunEvent[]> {
    return this.readEvents(runId);
  }

  eventPath(runId: string): string {
    return this.eventOutbox.eventPath(runId);
  }

  async release(ticketId: string, runId: string): Promise<void> {
    assertTicketId(ticketId);
    if (!RUN_ID_PATTERN.test(runId)) throw new Error("invalid run id");
    return withTicketOperation(this.directory, ticketId, async () => {
      const lockPath = this.#reservationPath(ticketId);
      const owner = await readLock(lockPath);
      if (owner === undefined) return;
      if (owner !== runId) throw new Error(`ticket reservation is owned by another run: ${ticketId}`);
      await waitForTicketOperationBarrier("release-after-owner-read");
      const state = await this.read(runId);
      if (!state) throw new Error(`cannot release an ambiguous ticket reservation: ${ticketId}`);
      if (state.ticketId !== ticketId) throw new Error(`ticket reservation identity mismatch: ${ticketId}`);
      if (state.status === "running") throw new Error(`cannot release an active ticket reservation: ${ticketId}`);
      await removeReservationIfOwned(lockPath, runId);
    });
  }

  async #publishTransition(previous: PersonalRunState | undefined, next: PersonalRunState): Promise<void> {
    try {
      // State replacement has already committed. Outbox failure is a missed
      // notification, never permission to roll back or misreport state.
      await this.eventOutbox.append(previous, next);
    } catch (error) {
      try { this.#onEventPersistenceError(error); } catch { /* diagnostics cannot alter state authority */ }
    }
  }

  async #replaceState(target: string, state: PersonalRunState): Promise<void> {
    const temporary = path.join(this.directory, `.${state.runId}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(encode(state));
      await handle.sync();
      await handle.close();
      // State files only. Outbox replacement deliberately retains its existing
      // best-effort semantics. Keep the test seam and bounded retry policy.
      const options = process.platform === "win32" && !this.#renameRetry?.rename
        ? { ...this.#renameRetry, rename: async (source: string, destination: string): Promise<void> => {
          try { windowsLaunch().replaceState(path.resolve(source), path.resolve(destination)); }
          catch (error) {
            if (error instanceof Error) Object.assign(error, { path: source, dest: destination });
            throw error;
          }
        } }
        : this.#renameRetry;
      await renameOverExistingWithRetry(temporary, target, options);
      await syncDirectory(this.directory);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  #path(runId: string): string {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error("invalid run id");
    return path.join(this.directory, `${runId}.json`);
  }

  #reservationPath(ticketId: string): string {
    return path.join(this.directory, "locks", `${ticketId.toLowerCase()}.lock`);
  }

  async #read(file: string, expectedRunId: string, skipHistorical = false): Promise<PersonalRunState | undefined> {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    // State reads must not follow a symlink into another run/data root. The
    // atomic publisher creates regular files and a replaced/non-regular path
    // is therefore an ambiguity that should stop status or a writer.
    if (!metadata.isFile()) throw new Error(`run state is not a regular file: ${file}`);

    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (skipHistorical && value && typeof value === "object" && (value as Record<string, unknown>)["schemaVersion"] === 1) {
      const historical = value as Record<string, unknown>;
      if (historical["runId"] !== expectedRunId || !TICKET_ID_PATTERN.test(String(historical["ticketId"]))) throw new Error("invalid historical identity");
      if (historical["status"] === "running") throw new Error("historical active state is ambiguous; owner investigation required");
      if (!["failed", "completed", "interrupted"].includes(String(historical["status"]))) throw new Error("invalid historical status");
      return undefined;
    }
    validateState(value);
    if (value.runId !== expectedRunId) throw new Error("run state filename/runId mismatch");
    return value;
  }
}

async function atomicCreate(target: string, contents: string, directory: string, identity: string): Promise<void> {
  const temporary = path.join(directory, `.${identity}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    try {
      // A hard-link publish is atomic and does not replace a pre-existing run
      // state, unlike rename on POSIX. The temporary name is removed below.
      await link(temporary, target);
    } finally {
      await rm(temporary, { force: true });
      await syncDirectory(directory);
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readLock(file: string): Promise<string | undefined> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // A reservation is a private regular-file record. Following a symlink here
  // would let an unrelated file impersonate ownership and could make status
  // authorize a run that has no real reservation in this data directory.
  if (!metadata.isFile()) throw new Error(`ambiguous ticket reservation record: ${file}`);

  let value: string;
  try {
    value = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // A reservation is an ownership record, not a best-effort hint. Empty,
  // multi-line, whitespace-padded, and invalid IDs are all ambiguous. In
  // particular, do not turn a malformed lock into "no reservation" while an
  // older terminal state is still readable.
  const owner = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (!RUN_ID_PATTERN.test(owner)) throw new Error(`ambiguous ticket reservation record: ${file}`);
  return owner;
}

async function removeReservationIfOwned(file: string, expectedOwner: string): Promise<void> {
  const owner = await readLock(file);
  if (owner === undefined) return;
  if (owner !== expectedOwner) throw new Error("ticket reservation ownership changed during release");
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeFileIfExactContents(file: string, expected: string): Promise<void> {
  let actual: string;
  try {
    actual = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("ownership boundary disappeared during release");
    throw error;
  }
  if (actual !== expected) throw new Error("ownership boundary changed during release");
  await unlink(file);
}

function isReservedLaunch(state: PersonalRunState): boolean {
  return state.status === "running"
    && state.executionMode === "background"
    && state.launchState === "reserved"
    && state.controllerPid === null
    && state.lifecycle === "launching"
    && state.step === "launching"
    && state.preparationState === "pending"
    && typeof state.startedAt === "string"
    && state.endedAt === null;
}

function isStartedChild(state: PersonalRunState): boolean {
  return state.status === "running"
    && state.executionMode === "background"
    && state.launchState === "started"
    && Number.isSafeInteger(state.controllerPid)
    && (state.controllerPid ?? 0) > 0
    && state.lifecycle === "preparing"
    && state.step === "preparing"
    && state.preparationState === "started"
    && typeof state.startedAt === "string"
    && state.endedAt === null
    && Date.parse(state.updatedAt) >= Date.parse(state.startedAt);
}

function assertExactStartedChildTarget(current: PersonalRunState, next: PersonalRunState): void {
  const controllerPid = next.controllerPid;
  if (!Number.isSafeInteger(controllerPid) || (controllerPid ?? 0) < 1) throw new Error("reserved run claim target is invalid");
  const expected: PersonalRunState = {
    ...current,
    version: current.version + 1,
    launchState: "started",
    controllerPid: controllerPid as number,
    lifecycle: "preparing",
    step: "preparing",
    preparationState: "started",
    updatedAt: next.updatedAt,
  };
  if (!isDeepStrictEqual(next, expected) || Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) {
    throw new Error("reserved run claim target must be the exact started child transition");
  }
}

function assertExactSourceBindingTarget(current: PersonalRunState, next: PersonalRunState): void {
  const sourceSha = next.sourceSha;
  if (sourceSha === undefined || !/^[a-f0-9]{40,64}$/u.test(sourceSha)) throw new Error("reserved source binding target is invalid");
  const expected: PersonalRunState = {
    ...current,
    version: current.version + 1,
    sourceSha,
    updatedAt: next.updatedAt,
  };
  if (!isDeepStrictEqual(next, expected) || Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) {
    throw new Error("reserved source binding target must be the exact source transition");
  }
}

function assertExactReservedFailureTarget(current: PersonalRunState, next: PersonalRunState): void {
  const terminalStatus = next.status;
  const endedAt = next.endedAt;
  if ((terminalStatus !== "failed" && terminalStatus !== "interrupted") || typeof endedAt !== "string" || typeof next.lastError !== "string" || next.lastError.trim().length === 0 || next.lastError.length > 2_000) {
    throw new Error("reserved run failure target is invalid");
  }
  const expected: PersonalRunState = {
    ...current,
    version: current.version + 1,
    status: terminalStatus,
    lifecycle: terminalStatus,
    launchState: "failed",
    preparationState: "failed",
    controllerPid: null,
    endedAt,
    lastError: next.lastError,
    terminalReason: next.lastError,
    updatedAt: next.updatedAt,
  };
  const startedTime = Date.parse(current.startedAt!);
  const currentTime = Date.parse(current.updatedAt);
  const endedTime = Date.parse(endedAt);
  const updatedTime = Date.parse(next.updatedAt);
  if (!isDeepStrictEqual(next, expected) || endedTime < startedTime || endedTime < currentTime || updatedTime < endedTime) {
    throw new Error("reserved run failure target must be the exact terminal launch transition");
  }
}

async function withTicketOperation<T>(directory: string, ticketId: string, operation: (evidence: OperationEvidence) => Promise<T>): Promise<T> {
  const lock = await acquireTicketOperation(directory, ticketId);
  try {
    return await operation(lock.evidence);
  } finally {
    await lock.release();
  }
}

async function acquireTicketOperation(directory: string, ticketId: string): Promise<{ evidence: OperationEvidence; release: () => Promise<void> }> {
  const processIdentity = await ownerProcessIdentity(process.pid);
  const operations = path.join(directory, "ticket-operations");
  await mkdir(operations, { recursive: true, mode: 0o700 });
  const lockPath = path.join(operations, `${ticketId.toLowerCase()}.lock`);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    let handle: FileHandle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A live reserve/release operation is normally only a few filesystem
      // calls. Waiting briefly makes overlapping operations serialize instead
      // of reporting a false ambiguity; a crashed operation remains stuck and
      // fails closed after the bounded wait.
      await new Promise(resolve => setTimeout(resolve, 5));
      continue;
    }

    let operationReservationIdentity: string | null;
    try {
      operationReservationIdentity = (await observeOwnerFile(path.join(directory, "locks", `${ticketId.toLowerCase()}.lock`)))?.identity ?? null;
    } catch (error) {
      await handle.close().catch(() => undefined);
      // No usable marker was published. Leave ambiguity, not an unverified unlink.
      throw error;
    }
    const evidence: OperationEvidence = {
      version: 1, ticketId, pid: process.pid, token: randomUUID(), processIdentity, operationReservationIdentity,
    };
    const owner = `${JSON.stringify(evidence)}\n`;
    try {
      await handle.writeFile(owner, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      // Never unconditionally unlink a path after an I/O failure. If the
      // pathname changed, preserving it is safer than deleting another
      // operation's boundary; status/retry will report the ambiguity.
      await removeFileIfExactContents(lockPath, owner).catch(() => undefined);
      throw error;
    }

    let released = false;
    return { evidence, release: async () => {
      if (released) return;
      released = true;
      await handle.close().catch(() => undefined);
      // Verify the ownership marker before removing the operation lock. This
      // keeps a delayed old process from deleting a replacement boundary.
      await removeFileIfExactContents(lockPath, owner);
    } };
  }
  throw new Error(`ticket operation is locked or ambiguous: ${ticketId}`);
}

async function waitForTicketOperationBarrier(stage: "reserve-before-failed-cleanup" | "release-after-owner-read" | "reserve-published" | "claim-before-state" | "claim-published" | "abandon-published"): Promise<void> {
  if (process.env["NODE_ENV"] !== "test" || process.env["SQUIRE_TEST_ONLY_TICKET_OPERATION_STAGE"] !== stage) return;
  const ready = testOnlyBarrierPath("SQUIRE_TEST_ONLY_TICKET_OPERATION_READY_PATH");
  const release = testOnlyBarrierPath("SQUIRE_TEST_ONLY_TICKET_OPERATION_RELEASE_PATH");
  if ((ready === undefined) !== (release === undefined)) throw new Error("ticket operation test-only barrier is incomplete");
  if (ready === undefined || release === undefined) return;
  await writeFile(ready, "ready\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  for (;;) {
    try {
      await access(release);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }
}

function testOnlyBarrierPath(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (!path.isAbsolute(value) || path.resolve(value) !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error(`unsafe ticket operation test-only barrier path: ${name}`);
  return value;
}

function assertTicketId(ticketId: string): void {
  if (!TICKET_ID_PATTERN.test(ticketId)) throw new Error("invalid Linear ticket identifier");
}

function compareStates(left: PersonalRunState, right: PersonalRunState): number {
  const leftTime = timestampForOrdering(left);
  const rightTime = timestampForOrdering(right);
  if (leftTime !== rightTime) return rightTime - leftTime;
  if (left.version !== right.version) return right.version - left.version;
  return right.runId.localeCompare(left.runId);
}

function timestampForOrdering(state: PersonalRunState): number {
  const candidate = state.startedAt ?? state.updatedAt;
  const value = Date.parse(candidate);
  return Number.isFinite(value) ? value : 0;
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try { await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR" && code !== "ENOTSUP") throw error;
  }
}

function encode(state: PersonalRunState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function validateState(value: unknown): asserts value is PersonalRunState {
  const v = exactObject(value, REQUIRED_STATE_KEYS, "run state", OPTIONAL_STATE_KEYS);
  if (v["schemaVersion"] !== 2) throw new Error("historical run state is read-only; start a new run");
  const s = v as unknown as PersonalRunState;
  if (!integer(s.version,1) || !RUN_ID_PATTERN.test(s.runId) || !TICKET_ID_PATTERN.test(s.ticketId) || !s.runId.startsWith(s.ticketId.toLowerCase()+"-") || s.sandbox !== `squire-${s.runId}` || !text(s.ticketTitle,2000)) throw new Error("invalid state identity");
  if (!RUN_STATUSES.includes(s.status) || !RUN_STEPS.includes(s.step) || !validTimestamp(s.updatedAt)) throw new Error("invalid state lifecycle");
  if (s.branch !== deterministicFeatureBranch(s.repository,s.ticketId)) throw new Error("invalid state branch");
  validateLifecycleMetadata(v); validateModelPolicy(s.profiles);
  for (const key of ["baseSha", "head", "candidate"] as const) nullableSha(s[key],key);
  if (s.contract !== null) {
    const c = exactObject(s.contract,["ticket","digest"],"contract");
    const t = exactObject(c["ticket"],["id","title","description"],"contract ticket",["url"]);
    if (t["id"] !== s.ticketId || !text(t["title"],2000) || typeof t["description"] !== "string" || Buffer.byteLength(JSON.stringify(t)) > 128*1024 || c["digest"] !== createHash("sha256").update(JSON.stringify(t)).digest("hex")) throw new Error("invalid immutable contract");
  }
  if (!["not_run","passed","failed"].includes(s.verifyDisposition) || !["not_started","publishing","published","failed"].includes(s.publicationState) || s.ciDisposition !== "pending" || s.mergeDisposition !== "not_merged") throw new Error("invalid independent dispositions");
  exactObject(s.attempts,PERSONAL_PHASES,"attempts"); subsetObject(s.results,PERSONAL_PHASES,"results"); subsetObject(s.sessions,PERSONAL_PHASES,"sessions");
  for(const phase of PERSONAL_PHASES) {
    if (![0,1].includes(s.attempts[phase])) throw new Error("one attempt per phase");
    const r=s.results[phase];
    if(r) {
      validatePhaseResultShape(r,phase);
      if(r.runId !== s.runId || s.attempts[phase] !== 1 || s.sessions[phase] !== r.sessionId || !isDeepStrictEqual(r.profile,s.profiles![phase])) throw new Error("result envelope mismatch");
      if (phase === "implement" ? r.outputHead !== s.candidate : r.inputHead !== s.candidate || r.outputHead !== s.candidate || s.verifyDisposition !== r.status) throw new Error("candidate evidence mismatch");
    }
  }
  if (s.attempts.verify && (!s.candidate || s.results.implement?.status !== "passed")) throw new Error("Verify requires accepted Implement candidate");
  if (s.candidate && s.head !== s.candidate) throw new Error("candidate identity changed");
  if (s.lastError !== null && !text(s.lastError,2000)) throw new Error("invalid terminal diagnostic");
  if (s.prUrl !== null && (!text(s.prUrl,2000) || !/^https:\/\/[^\s]+$/u.test(s.prUrl))) throw new Error("invalid publication URL");
  if (s.results.implement && s.results.implement.inputHead !== s.baseSha) throw new Error("Implement baseline mismatch");
  if (s.sessions.implement && s.sessions.implement === s.sessions.verify) throw new Error("sessions must be independent");
  if (s.status === "running" ? s.terminalReason !== null || s.lastError !== null : !text(s.terminalReason,2000)) throw new Error("invalid terminal reason");
  if (s.status === "completed" && (s.step !== "complete" || s.publicationState !== "published" || !s.prUrl || s.verifyDisposition !== "passed" || s.results.verify?.status !== "passed")) throw new Error("completion requires verified publication");
  if (s.publicationState === "publishing" || s.publicationState === "published") if(s.verifyDisposition !== "passed" || s.results.verify?.status !== "passed") throw new Error("publication requires Verify");
  if (s.reports) { subsetObject(s.reports, PERSONAL_PHASES, "reports"); for (const r of Object.values(s.reports)) validateEvidenceRef(r); }
  validateLaunchRetryState(s);
}

function exactObject(value: unknown, keys: readonly string[], label: string, optionalKeys: readonly string[] = []): Record<string, unknown> {
  const object = subsetObject(value, [...keys, ...optionalKeys], label);
  if (Object.keys(object).length < keys.length || Object.keys(object).some(key => !keys.includes(key) && !optionalKeys.includes(key))) throw new Error(`${label} fields are invalid`);
  if (keys.some(key => !Object.prototype.hasOwnProperty.call(object, key))) throw new Error(`${label} fields are invalid`);
  return object;
}

function subsetObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => !keys.includes(key))) throw new Error(`${label} fields are invalid`);
  return object;
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function integer(value: unknown, minimum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum;
}

function nullableSha(value: unknown, label: string): void {
  if (value !== null && (typeof value !== "string" || !/^[a-f0-9]{40,64}$/u.test(value))) throw new Error(`invalid run state ${label}`);
}

function validTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function validateLifecycleMetadata(state: Record<string, unknown>): void {
  if (state["launchEvidence"] !== undefined) validateLaunchEvidence(state["launchEvidence"]);
  const metadataKeys = ["lifecycle", "launchState", "preparationState", "executionMode", "startedAt", "endedAt", "controllerPid", "stdoutPath", "stderrPath", "repositoryPath", "sourceRef", "sourceSha", "launchConfigPath", "launchConfigDigest"];
  const hasMetadata = metadataKeys.some(key => Object.prototype.hasOwnProperty.call(state, key));
  if (!hasMetadata) return; // Published v1 state files did not have launch metadata.

  const lifecycle = state["lifecycle"];
  if (lifecycle !== undefined && (typeof lifecycle !== "string" || !RUN_LIFECYCLES.includes(lifecycle as RunLifecycle))) throw new Error("invalid run state lifecycle");
  const launchState = state["launchState"];
  if (launchState !== undefined && (typeof launchState !== "string" || !RUN_LAUNCH_STATES.includes(launchState as RunLaunchState))) throw new Error("invalid run state launch state");
  const preparationState = state["preparationState"];
  if (preparationState !== undefined && (typeof preparationState !== "string" || !RUN_PREPARATION_STATES.includes(preparationState as RunPreparationState))) throw new Error("invalid run state preparation state");
  const executionMode = state["executionMode"];
  if (executionMode !== undefined && (typeof executionMode !== "string" || !EXECUTION_MODES.includes(executionMode as RunExecutionMode))) throw new Error("invalid run state execution mode");
  const startedAt = state["startedAt"];
  if (startedAt !== undefined && (typeof startedAt !== "string" || !validTimestamp(startedAt))) throw new Error("invalid run state startedAt");
  const endedAt = state["endedAt"];
  if (endedAt !== undefined && endedAt !== null && (typeof endedAt !== "string" || !validTimestamp(endedAt))) throw new Error("invalid run state endedAt");
  const controllerPid = state["controllerPid"];
  if (controllerPid !== undefined && controllerPid !== null && (!Number.isSafeInteger(controllerPid) || (controllerPid as number) < 1)) throw new Error("invalid run state controller PID");
  for (const key of ["stdoutPath", "stderrPath", "repositoryPath", "launchConfigPath"] as const) {
    const value = state[key];
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length === 0 || value.length > 4_000 || (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)))) throw new Error(`invalid run state ${key}`);
  }
  if (state["sourceRef"] !== undefined && !text(state["sourceRef"], 1_000)) throw new Error("invalid run state sourceRef");
  if (state["sourceSha"] !== undefined && (typeof state["sourceSha"] !== "string" || !/^[a-f0-9]{40,64}$/u.test(state["sourceSha"]))) throw new Error("invalid run state source SHA");
  if (state["launchConfigDigest"] !== undefined && (typeof state["launchConfigDigest"] !== "string" || !/^[a-f0-9]{64}$/u.test(state["launchConfigDigest"]))) throw new Error("invalid run state launch config digest");

  const status = state["status"] as string;
  if (status === "running" && endedAt !== undefined && endedAt !== null) throw new Error("running state has an end timestamp");
  if ((status === "completed" || status === "failed" || status === "interrupted") && (endedAt === undefined || endedAt === null)) throw new Error("terminal state has no end timestamp");
  if (status === "completed" && lifecycle !== undefined && lifecycle !== "completed") throw new Error("completed state has an invalid lifecycle");
  if (status === "failed" && lifecycle !== undefined && lifecycle !== "failed") throw new Error("failed state has an invalid lifecycle");
  if (status === "interrupted" && lifecycle !== undefined && lifecycle !== "interrupted") throw new Error("interrupted state has an invalid lifecycle");
  if (status === "running" && lifecycle !== undefined && ["completed", "failed", "interrupted"].includes(lifecycle as string)) throw new Error("running state has a terminal lifecycle");
  if (launchState === "reserved" && executionMode !== undefined && executionMode !== "background") throw new Error("only background runs may be launch-reserved");
  if (launchState === "failed" && status === "running") throw new Error("running state has a failed launch");
  if (lifecycle === "launching" && state["step"] !== "launching") throw new Error("launching lifecycle has a different step");
  if (lifecycle === "completed" && state["step"] !== "complete") throw new Error("completed lifecycle has a different step");
}

function assertLaunchIdentityUnchanged(current: PersonalRunState, next: PersonalRunState): void {
  if (!isDeepStrictEqual(current.launchEvidence, next.launchEvidence)) throw new Error("launch evidence is immutable");
  for (const key of ["repository", "repositoryPath", "sourceRef", "baseBranch", "launchConfigPath", "launchConfigDigest", "executionMode", "stdoutPath", "stderrPath"] as const) {
    if (current[key] !== next[key]) throw new Error("background launch identity is immutable");
  }
  if (current.sourceSha !== next.sourceSha && !(current.sourceSha === undefined && next.sourceSha !== undefined && isReservedLaunch(current))) {
    throw new Error("background launch identity is immutable");
  }
}

async function acquireUpdateLock(directory: string, runId: string): Promise<() => Promise<void>> {
  const locks = path.join(directory, "update-locks");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const lock = path.join(locks, `${runId}.lock`);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise(resolve => setTimeout(resolve, 5));
      continue;
    }

    const owner = `${process.pid}-${randomUUID()}\n`;
    const marker = path.join(lock, "owner");
    try {
      await writeFile(marker, owner, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      // No ownership marker was published, so this process cannot safely
      // identify the directory after a pathname replacement. Leave the lock
      // in place and fail closed rather than removing a replacement boundary.
      throw error;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      // The marker turns directory-lock cleanup into an ownership-checked
      // operation. A delayed writer cannot remove a replacement update lock.
      await removeFileIfExactContents(marker, owner);
      await rmdir(lock);
    };
  }
  throw new Error(`run state update is locked or ambiguous: ${runId}`);
}

function assertResolvedProfilesUnchanged(current: PersonalRunState, next: PersonalRunState): void {
  if (current.schemaVersion !== 2 || current.status !== "running") throw new Error("terminal and historical state is immutable");
  assertLaunchRetryUnchanged(current,next);
  const order = ["launching","preparing","implement","verify","publishing","complete"];
  if (order.indexOf(next.step) < order.indexOf(current.step)) throw new Error("workflow cannot move backwards");
  if (current.head !== null && current.head !== next.head && (next.step !== "implement" || current.candidate !== null)) throw new Error("only Implement can bind candidate identity");
  for (const phase of PERSONAL_PHASES) if (next.attempts[phase] !== current.attempts[phase] && next.step !== phase) throw new Error("attempt must belong to active phase");
  if (current.publicationState !== next.publicationState && !({not_started:["publishing"],publishing:["published","failed"],published:[],failed:[]} as Record<string,string[]>)[current.publicationState]!.includes(next.publicationState)) throw new Error("publication cannot replay");

  for (const key of ["profiles","runId","ticketId","branch","sandbox"] as const) if(!isDeepStrictEqual(current[key],next[key])) throw new Error(`${key} is immutable`);
  for (const key of ["contract","baseSha","candidate"] as const) if(current[key] !== null && !isDeepStrictEqual(current[key],next[key])) throw new Error(`${key} is immutable`);
  for(const phase of PERSONAL_PHASES) {
    if(current.reports?.[phase] && !isDeepStrictEqual(current.reports[phase],next.reports?.[phase])) throw new Error("report identity immutable");
    if(current.results[phase] && !isDeepStrictEqual(current.results[phase],next.results[phase])) throw new Error("accepted evidence is immutable");
    if(next.attempts[phase] < current.attempts[phase]) throw new Error("attempt cannot replay");
  }
  if (current.verifyDisposition !== "not_run" && current.verifyDisposition !== next.verifyDisposition) throw new Error("Verify disposition immutable");
}
