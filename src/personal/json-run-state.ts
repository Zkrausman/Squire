import { access, mkdir, open, readFile, readdir, rename, rm, link, unlink, rmdir, writeFile, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { deterministicFeatureBranch } from "./identity.js";
import { validatePhaseResultShape } from "./phase-result.js";
import { canonicalPlanIdentity, PLAN_SELECTION_VERSION, validatePhaseProfile } from "./model-policy.js";
import { PERSONAL_PHASES, type PersonalPhase, type PersonalRunState, type RunStatePort, type PhaseProfile, type PlanSelection, type ResolvedPhaseProfiles, type RunExecutionMode, type RunLifecycle, type RunLaunchState, type RunPreparationState } from "./types.js";

const REQUIRED_STATE_KEYS = ["schemaVersion", "version", "runId", "ticketId", "ticketTitle", "status", "step", "sandbox", "repository", "baseBranch", "baseSha", "branch", "head", "sessions", "attempts", "results", "remediations", "prUrl", "lastError", "updatedAt"] as const;
const OPTIONAL_STATE_KEYS = [
  "profiles",
  "planSelection",
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
  "launchConfigDigest",
] as const;
const RUN_STATUSES = ["running", "completed", "failed", "interrupted"] as const;
const RUN_STEPS = ["launching", "preparing", ...PERSONAL_PHASES, "publishing", "complete"] as const;
const RUN_LIFECYCLES = ["launching", "preparing", "running", "publishing", "completed", "failed", "interrupted"] as const;
const RUN_LAUNCH_STATES = ["reserved", "started", "failed"] as const;
const RUN_PREPARATION_STATES = ["pending", "started", "ready", "failed"] as const;
const EXECUTION_MODES = ["foreground", "background"] as const;
const TICKET_ID_PATTERN = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,127}$/u;

export class JsonRunStateStore implements RunStatePort {
  constructor(readonly directory: string) {}

  async create(state: PersonalRunState): Promise<void> {
    validateState(state);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.#path(state.runId);
    await atomicCreate(target, encode(state), this.directory, state.runId);
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
    return withTicketOperation(this.directory, state.ticketId, async () => {
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
        if (lockAcquired) await unlink(lockPath).catch(() => undefined);
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
        await atomicCreate(this.#path(state.runId), encode(state), this.directory, state.runId);
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
    const releaseUpdate = await acquireUpdateLock(this.directory, state.runId);
    try {
      // The version check and replacement are one serialized operation across
      // processes. A crashed writer leaves the update lock in place and fails
      // closed rather than allowing a stale writer to overwrite newer truth.
      const target = this.#path(state.runId);
      const current = await this.#read(target, state.runId);
      if (!current) throw new Error(`run state does not exist: ${state.runId}`);
      if (state.version !== current.version + 1) throw new Error("run state version must advance by one");
      assertResolvedProfilesUnchanged(current, state);
      assertLaunchIdentityUnchanged(current, state);
      await this.#replaceState(target, state);
    } finally {
      await releaseUpdate();
    }
  }

  /**
   * Claim the reserved-to-started transition while holding both the existing
   * per-ticket operation boundary and the existing per-run version lock.
   */
  async claimReserved(state: PersonalRunState): Promise<void> {
    validateState(state);
    if (!isStartedChild(state)) throw new Error("reserved run claim target is invalid");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return withTicketOperation(this.directory, state.ticketId, async () => {
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
        await this.#replaceState(target, state);
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
      } finally {
        await releaseUpdate();
      }
      await removeReservationIfOwned(lockPath, state.runId);
    });
  }

  async findActive(ticketId: string): Promise<PersonalRunState | undefined> {
    const matches = (await this.findByTicket(ticketId)).filter(state => state.status === "running");
    if (matches.length > 1) throw new Error(`multiple active runs found for ${ticketId}`);
    return matches[0];
  }

  async findByTicket(ticketId: string): Promise<readonly PersonalRunState[]> {
    assertTicketId(ticketId);
    return (await this.list()).filter(state => state.ticketId === ticketId);
  }

  async list(): Promise<readonly PersonalRunState[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = await readdir(this.directory);
    const matches: PersonalRunState[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filenameRunId = file.slice(0, -".json".length);
      if (!RUN_ID_PATTERN.test(filenameRunId)) throw new Error(`invalid run state filename: ${file}`);
      const state = await this.#read(path.join(this.directory, file), filenameRunId);
      if (state) matches.push(state);
    }
    return matches.sort(compareStates);
  }

  async read(runId: string): Promise<PersonalRunState | undefined> {
    return this.#read(this.#path(runId), runId);
  }

  async reservationOwner(ticketId: string): Promise<string | undefined> {
    assertTicketId(ticketId);
    return withTicketOperation(this.directory, ticketId, async () => readLock(this.#reservationPath(ticketId)));
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

  async #replaceState(target: string, state: PersonalRunState): Promise<void> {
    const temporary = path.join(this.directory, `.${state.runId}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(encode(state));
      await handle.sync();
      await handle.close();
      await rename(temporary, target);
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

  async #read(file: string, expectedRunId: string): Promise<PersonalRunState | undefined> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const value: unknown = JSON.parse(raw);
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
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readLock(file: string): Promise<string | undefined> {
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

async function withTicketOperation<T>(directory: string, ticketId: string, operation: () => Promise<T>): Promise<T> {
  const release = await acquireTicketOperation(directory, ticketId);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function acquireTicketOperation(directory: string, ticketId: string): Promise<() => Promise<void>> {
  const operations = path.join(directory, "ticket-operations");
  await mkdir(operations, { recursive: true, mode: 0o700 });
  const lockPath = path.join(operations, `${ticketId.toLowerCase()}.lock`);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    let handle: FileHandle;
    try {
      handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}-${randomUUID()}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      return async () => {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A live reserve/release operation is normally only a few filesystem
      // calls. Waiting briefly makes overlapping operations serialize instead
      // of reporting a false ambiguity; a crashed operation remains stuck and
      // fails closed after the bounded wait.
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  throw new Error(`ticket operation is locked or ambiguous: ${ticketId}`);
}

async function waitForTicketOperationBarrier(stage: "reserve-before-failed-cleanup" | "release-after-owner-read"): Promise<void> {
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

function encode(state: PersonalRunState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function validateState(value: unknown): asserts value is PersonalRunState {
  const state = exactObject(value, REQUIRED_STATE_KEYS, "run state", OPTIONAL_STATE_KEYS);
  if (state["schemaVersion"] !== 1 || !integer(state["version"], 1)) throw new Error("invalid run state version");
  if (!text(state["runId"], 128) || !/^[a-z0-9][a-z0-9-]{7,127}$/u.test(state["runId"])) throw new Error("invalid run state runId");
  if (!text(state["ticketId"], 64) || !/^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u.test(state["ticketId"])) throw new Error("invalid run state ticketId");
  if (!state["runId"].startsWith(`${state["ticketId"].toLowerCase()}-`)) throw new Error("run state ticket/run identity mismatch");
  if (!text(state["ticketTitle"], 2_000)) throw new Error("invalid run state ticketTitle");
  if (typeof state["status"] !== "string" || !RUN_STATUSES.includes(state["status"] as (typeof RUN_STATUSES)[number])) throw new Error("invalid run state status");
  if (typeof state["step"] !== "string" || !RUN_STEPS.includes(state["step"] as (typeof RUN_STEPS)[number])) throw new Error("invalid run state step");
  validateLifecycleMetadata(state);
  if (state["sandbox"] !== `squire-${state["runId"]}`) throw new Error("run state sandbox identity mismatch");
  if (!text(state["repository"], 256) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(state["repository"])) throw new Error("invalid run state repository");
  if (!text(state["baseBranch"], 256) || !/^[A-Za-z0-9._/-]+$/u.test(state["baseBranch"]) || state["baseBranch"].includes("..")) throw new Error("invalid run state baseBranch");
  if (state["branch"] !== deterministicFeatureBranch(state["repository"], state["ticketId"])) throw new Error("run state branch identity mismatch");
  nullableSha(state["baseSha"], "baseSha");
  nullableSha(state["head"], "head");
  if ((state["baseSha"] === null) !== (state["head"] === null)) throw new Error("run state Git identity is incomplete");
  validateResolvedProfiles(state);

  const attempts = exactObject(state["attempts"], PERSONAL_PHASES, "run state attempts");
  for (const phase of PERSONAL_PHASES) if (!integer(attempts[phase], 0)) throw new Error(`invalid run state ${phase} attempts`);
  const remediations = exactObject(state["remediations"], ["review", "test"], "run state remediations");
  for (const phase of ["review", "test"] as const) if (!integer(remediations[phase], 0) || (remediations[phase] as number) > 1) throw new Error(`invalid run state ${phase} remediations`);

  const sessions = subsetObject(state["sessions"], PERSONAL_PHASES, "run state sessions");
  for (const [phase, sessionId] of Object.entries(sessions)) {
    if (!text(sessionId, 128)) throw new Error(`invalid run state ${phase} session`);
  }
  const results = subsetObject(state["results"], PERSONAL_PHASES, "run state results");
  for (const [key, result] of Object.entries(results)) {
    const phase = key as PersonalPhase;
    validatePhaseResultShape(result, phase);
    if (result.runId !== state["runId"] || result.attempt > (attempts[phase] as number) || sessions[phase] !== result.sessionId || result.sessionFile !== `/ticket/sessions/${phase}/${result.attempt}.jsonl`) throw new Error(`run state ${phase} result identity mismatch`);
    const profiles = state["profiles"] as ResolvedPhaseProfiles | undefined;
    if (profiles) {
      if (!result.profile || !sameProfile(result.profile, profiles[phase])) throw new Error(`run state ${phase} profile evidence is missing or does not match the resolved profile`);
    }

  }

  if (state["prUrl"] !== null && (!text(state["prUrl"], 2_000) || !/^https:\/\/[^\s]+$/u.test(state["prUrl"]))) throw new Error("invalid run state prUrl");
  if (state["lastError"] !== null && !text(state["lastError"], 2_000)) throw new Error("invalid run state lastError");
  if (!text(state["updatedAt"], 64) || !validTimestamp(state["updatedAt"])) throw new Error("invalid run state updatedAt");

  if (state["status"] === "running" && (state["step"] === "complete" || state["lastError"] !== null || state["prUrl"] !== null)) throw new Error("running state has terminal fields");
  if ((state["status"] === "failed" || state["status"] === "interrupted") && state["lastError"] === null) throw new Error("stopped state requires lastError");
  if (state["status"] === "completed") {
    if (state["step"] !== "complete" || state["prUrl"] === null || state["lastError"] !== null || state["head"] === null) throw new Error("completed state is incomplete");
    for (const phase of PERSONAL_PHASES) {
      const result = results[phase] as import("./types.js").PhaseResult | undefined;
      if (!result || !sessions[phase] || result.status !== "passed" || result.attempt !== attempts[phase]) throw new Error("completed state is missing a latest passing phase");
    }
    const implementation = results["implement"] as import("./types.js").ImplementPhaseResult;
    const review = results["review"] as import("./types.js").ReviewPhaseResult;
    const test = results["test"] as import("./types.js").TestPhaseResult;
    const retro = results["retro"] as import("./types.js").RetroPhaseResult;
    if (implementation.outputHead !== state["head"] || review.inputHead !== state["head"] || review.outputHead !== state["head"] || test.inputHead !== state["head"] || test.outputHead !== state["head"] || retro.inputHead !== state["head"] || retro.outputHead !== state["head"]) throw new Error("completed state has stale gates");
  } else if (state["step"] === "complete") {
    throw new Error("only completed state may use the complete step");
  }
  if (state["step"] !== "preparing" && state["step"] !== "launching" && state["baseSha"] === null) throw new Error("started run has no Git identity");
  if (PERSONAL_PHASES.includes(state["step"] as PersonalPhase) && (attempts[state["step"] as PersonalPhase] as number) < 1) throw new Error("active phase has no attempt");
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
  const metadataKeys = ["lifecycle", "launchState", "preparationState", "executionMode", "startedAt", "endedAt", "controllerPid", "stdoutPath", "stderrPath"];
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
  for (const key of ["stdoutPath", "stderrPath", "repositoryPath"] as const) {
    const value = state[key];
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length === 0 || value.length > 4_000 || (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)))) throw new Error(`invalid run state ${key}`);
  }
  if (state["sourceRef"] !== undefined && !text(state["sourceRef"], 1_000)) throw new Error("invalid run state sourceRef");
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

function validateResolvedProfiles(state: Record<string, unknown>): void {
  const profilesValue = state["profiles"];
  const selectionValue = state["planSelection"];
  // Published v1 states predate model evidence. They remain readable, but
  // this branch intentionally does not invent profiles for their old results.
  if (profilesValue === undefined && selectionValue === undefined) return;
  if (profilesValue === undefined || selectionValue === undefined) throw new Error("run state resolved profiles and Plan selection must be persisted together");
  if (!profilesValue || typeof profilesValue !== "object" || Array.isArray(profilesValue)) throw new Error("run state profiles must be an object");
  const profiles = profilesValue as Record<string, unknown>;
  if (Object.keys(profiles).length !== PERSONAL_PHASES.length || Object.keys(profiles).some(key => !PERSONAL_PHASES.includes(key as PersonalPhase))) throw new Error("run state profiles fields are invalid");
  for (const phase of PERSONAL_PHASES) validatePhaseProfile(profiles[phase], `run state profiles.${phase}`);

  if (!selectionValue || typeof selectionValue !== "object" || Array.isArray(selectionValue)) throw new Error("run state Plan selection must be an object");
  const selection = selectionValue as Record<string, unknown>;
  const selectionKeys = ["version", "identity", "repository", "ticketId", "digest", "bucket", "profile"];
  if (Object.keys(selection).length !== selectionKeys.length || Object.keys(selection).some(key => !selectionKeys.includes(key))) throw new Error("run state Plan selection fields are invalid");
  if (selection["version"] !== PLAN_SELECTION_VERSION || typeof selection["identity"] !== "string" || !/^[a-f0-9]{64}$/u.test(String(selection["digest"]))) throw new Error("run state Plan selection version or digest is invalid");
  if (selection["bucket"] !== "a" && selection["bucket"] !== "b") throw new Error("run state Plan selection bucket is invalid");
  const identity = canonicalPlanIdentity(String(state["repository"]), String(state["ticketId"]));
  if (selection["identity"] !== identity.identity || selection["repository"] !== identity.repository || selection["ticketId"] !== identity.ticketId) throw new Error("run state Plan selection identity mismatch");
  const expectedDigest = createPlanDigest(identity.identity);
  if (selection["digest"] !== expectedDigest) throw new Error("run state Plan selection digest mismatch");
  const expectedBucket = (Number.parseInt(expectedDigest.slice(0, 2), 16) & 1) === 0 ? "a" : "b";
  if (selection["bucket"] !== expectedBucket || !sameProfile(selection["profile"], profiles["plan"])) throw new Error("run state Plan selection profile mismatch");
  validatePhaseProfile(selection["profile"], "run state Plan selection profile");
}

function assertLaunchIdentityUnchanged(current: PersonalRunState, next: PersonalRunState): void {
  for (const key of ["repository", "repositoryPath", "sourceRef", "baseBranch", "launchConfigDigest", "executionMode", "stdoutPath", "stderrPath"] as const) {
    if (current[key] !== next[key]) throw new Error("background launch identity is immutable");
  }
}

async function acquireUpdateLock(directory: string, runId: string): Promise<() => Promise<void>> {
  const locks = path.join(directory, "update-locks");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const lock = path.join(locks, `${runId}.lock`);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lock, { mode: 0o700 });
      return async () => { await rmdir(lock); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  throw new Error(`run state update is locked or ambiguous: ${runId}`);
}

function assertResolvedProfilesUnchanged(current: PersonalRunState, next: PersonalRunState): void {
  if (current.profiles) {
    if (!next.profiles || !next.planSelection || !current.planSelection || !sameProfiles(current.profiles, next.profiles) || !sameSelection(current.planSelection, next.planSelection)) throw new Error("resolved phase profiles are immutable");
    return;
  }
  if (next.profiles || next.planSelection) {
    if (Object.keys(current.results).length > 0) throw new Error("cannot add model evidence to a legacy run state with executed phases");
  }
}

function sameProfiles(left: ResolvedPhaseProfiles, right: ResolvedPhaseProfiles): boolean {
  return PERSONAL_PHASES.every(phase => sameProfile(left[phase], right[phase]));
}

function sameSelection(left: PlanSelection, right: PlanSelection): boolean {
  return left.version === right.version && left.identity === right.identity && left.repository === right.repository && left.ticketId === right.ticketId && left.digest === right.digest && left.bucket === right.bucket && sameProfile(left.profile, right.profile);
}

function sameProfile(left: PhaseProfile | unknown, right: PhaseProfile | unknown): boolean {
  if (!left || typeof left !== "object" || !right || typeof right !== "object") return false;
  const a = left as PhaseProfile;
  const b = right as PhaseProfile;
  return a.provider === b.provider && a.model === b.model && a.thinking === b.thinking;
}

function createPlanDigest(identity: string): string {
  // Kept local so state validation recomputes the persisted identity rather
  // than trusting a caller-provided digest.
  return createHash("sha256").update(identity, "utf8").digest("hex");
}
