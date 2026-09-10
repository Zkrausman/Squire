import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deterministicFeatureBranch } from "./identity.js";
import { validatePhaseResultShape } from "./phase-result.js";
import { PERSONAL_PHASES, type PersonalPhase, type PersonalRunState, type RunStatePort } from "./types.js";

const STATE_KEYS = ["schemaVersion", "version", "runId", "ticketId", "ticketTitle", "status", "step", "sandbox", "repository", "baseBranch", "baseSha", "branch", "head", "sessions", "attempts", "results", "remediations", "prUrl", "lastError", "updatedAt"] as const;
const RUN_STATUSES = ["running", "completed", "failed", "interrupted"] as const;
const RUN_STEPS = ["preparing", ...PERSONAL_PHASES, "publishing", "complete"] as const;

export class JsonRunStateStore implements RunStatePort {
  constructor(readonly directory: string) {}

  async create(state: PersonalRunState): Promise<void> {
    validateState(state);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.#path(state.runId);
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(encode(state));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async save(state: PersonalRunState): Promise<void> {
    validateState(state);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.#path(state.runId);
    const current = await this.#read(target);
    if (!current) throw new Error(`run state does not exist: ${state.runId}`);
    if (state.version !== current.version + 1) throw new Error("run state version must advance by one");
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

  async findActive(ticketId: string): Promise<PersonalRunState | undefined> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = await readdir(this.directory);
    const matches: PersonalRunState[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const state = await this.#read(path.join(this.directory, file));
      if (state?.ticketId === ticketId && state.status === "running") matches.push(state);
    }
    if (matches.length > 1) throw new Error(`multiple active runs found for ${ticketId}`);
    return matches[0];
  }

  async read(runId: string): Promise<PersonalRunState | undefined> {
    return this.#read(this.#path(runId));
  }

  #path(runId: string): string {
    if (!/^[a-z0-9][a-z0-9-]{7,127}$/u.test(runId)) throw new Error("invalid run id");
    return path.join(this.directory, `${runId}.json`);
  }

  async #read(file: string): Promise<PersonalRunState | undefined> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    validateState(value);
    return value;
  }
}

function encode(state: PersonalRunState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function validateState(value: unknown): asserts value is PersonalRunState {
  const state = exactObject(value, STATE_KEYS, "run state");
  if (state["schemaVersion"] !== 1 || !integer(state["version"], 1)) throw new Error("invalid run state version");
  if (!text(state["runId"], 128) || !/^[a-z0-9][a-z0-9-]{7,127}$/u.test(state["runId"])) throw new Error("invalid run state runId");
  if (!text(state["ticketId"], 64) || !/^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u.test(state["ticketId"])) throw new Error("invalid run state ticketId");
  if (!state["runId"].startsWith(`${state["ticketId"].toLowerCase()}-`)) throw new Error("run state ticket/run identity mismatch");
  if (!text(state["ticketTitle"], 2_000)) throw new Error("invalid run state ticketTitle");
  if (typeof state["status"] !== "string" || !RUN_STATUSES.includes(state["status"] as (typeof RUN_STATUSES)[number])) throw new Error("invalid run state status");
  if (typeof state["step"] !== "string" || !RUN_STEPS.includes(state["step"] as (typeof RUN_STEPS)[number])) throw new Error("invalid run state step");
  if (state["sandbox"] !== `squire-${state["runId"]}`) throw new Error("run state sandbox identity mismatch");
  if (!text(state["repository"], 256) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(state["repository"])) throw new Error("invalid run state repository");
  if (!text(state["baseBranch"], 256) || !/^[A-Za-z0-9._/-]+$/u.test(state["baseBranch"]) || state["baseBranch"].includes("..")) throw new Error("invalid run state baseBranch");
  if (state["branch"] !== deterministicFeatureBranch(state["repository"], state["ticketId"])) throw new Error("run state branch identity mismatch");
  nullableSha(state["baseSha"], "baseSha");
  nullableSha(state["head"], "head");
  if ((state["baseSha"] === null) !== (state["head"] === null)) throw new Error("run state Git identity is incomplete");

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
    if (implementation.outputHead !== state["head"] || review.inputHead !== state["head"] || review.outputHead !== state["head"] || test.inputHead !== state["head"] || test.outputHead !== state["head"]) throw new Error("completed state has stale gates");
  } else if (state["step"] === "complete") {
    throw new Error("only completed state may use the complete step");
  }
  if (state["step"] !== "preparing" && state["baseSha"] === null) throw new Error("started run has no Git identity");
  if (PERSONAL_PHASES.includes(state["step"] as PersonalPhase) && (attempts[state["step"] as PersonalPhase] as number) < 1) throw new Error("active phase has no attempt");
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const object = subsetObject(value, keys, label);
  if (Object.keys(object).length !== keys.length) throw new Error(`${label} fields are invalid`);
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
