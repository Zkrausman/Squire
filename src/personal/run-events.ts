import { validatePhaseProfile } from "./model-policy.js";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PERSONAL_PHASES, type PersonalPhase, type PersonalRunState } from "./types.js";
import { renameOverExistingWithRetry, type RenameRetryOptions } from "./atomic-rename.js";

/** The persisted event contract is intentionally closed and additive. */
export const RUN_EVENT_SCHEMA_VERSION = 2 as const;
export const MAX_RUN_EVENT_COUNT = 256;
export const MAX_RUN_EVENT_BYTES = 64 * 1024;

export const RUN_EVENT_TYPES = [
  "launch_reserved", "launch_dispatched", "launch_failed", "launch_returned", "launch_retrying",
  "run_reserved",
  "run_started",
  "phase_started",
  "phase_completed",
  "publication_started",
  "publication_completed",
  "terminal_succeeded",
  "terminal_failed",
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const RUN_EVENT_OUTCOMES = [
  "passed",
  "failed",
  "completed",
  "interrupted",
] as const;
export type RunEventOutcome = (typeof RUN_EVENT_OUTCOMES)[number];

/**
 * A deliberately bounded event. There is no title, diagnostic, prompt,
 * transcript, log path, URL, or arbitrary extension field in this contract.
 * The authoritative state file remains the source of truth.
 */
export interface RunEvent {
  readonly schemaVersion: typeof RUN_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly runId: string;
  readonly ticketId: string;
  readonly stateRevision: number;
  readonly timestamp: string;
  readonly type: RunEventType;
  readonly phase?: PersonalPhase;
  readonly attempt?: number;
  readonly outcome?: RunEventOutcome;
  readonly generation?: 0 | 1;
}

interface EventFields {
  readonly runId: string;
  readonly ticketId: string;
  readonly stateRevision: number;
  readonly timestamp: string;
  readonly type: RunEventType;
  readonly phase?: PersonalPhase;
  readonly attempt?: number;
  readonly outcome?: RunEventOutcome;
  readonly generation?: 0 | 1;
}

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,127}$/u;
const TICKET_ID_PATTERN = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EVENT_KEY_PATTERN = /^[a-z0-9:_|.-]{1,512}$/u;

/** Create a deterministic event whose identity survives outbox replay/reconciliation. */
export function createRunEvent(fields: EventFields): RunEvent {
  const event: RunEvent = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    eventId: eventIdFor(fields),
    runId: fields.runId,
    ticketId: fields.ticketId,
    stateRevision: fields.stateRevision,
    timestamp: fields.timestamp,
    type: fields.type,
    ...(fields.phase === undefined ? {} : { phase: fields.phase }),
    ...(fields.attempt === undefined ? {} : { attempt: fields.attempt }),
    ...(fields.outcome === undefined ? {} : { outcome: fields.outcome }),
    ...(fields.generation === undefined ? {} : { generation: fields.generation }),
  };
  validateRunEvent(event);
  return event;
}

/**
 * The event ID is semantic rather than revision-bound. If an atomic state
 * replacement is committed but its outbox publication is missed, a consumer
 * can synthesize the same ID from current state and deduplicate it.
 */
export function eventIdFor(fields: Pick<EventFields, "runId" | "ticketId" | "type"> & Partial<Pick<EventFields, "phase" | "attempt" | "outcome" | "generation">>): string {
  const key = [
    fields.runId,
    fields.ticketId,
    fields.type,
    fields.phase ?? "",
    fields.attempt === undefined ? "" : String(fields.attempt),
    fields.outcome ?? "",
    ...(fields.generation === undefined ? [] : [String(fields.generation)]),
  ].join("|");
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function validateRunEvent(value: unknown): asserts value is RunEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("run event must be an object");
  const object = value as Record<string, unknown>;
  const allowed = ["schemaVersion", "eventId", "runId", "ticketId", "stateRevision", "timestamp", "type", "phase", "attempt", "outcome", "generation"];
  if (Object.keys(object).some(key => !allowed.includes(key))) throw new Error("run event fields are invalid");
  for (const key of ["schemaVersion", "eventId", "runId", "ticketId", "stateRevision", "timestamp", "type"] as const) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) throw new Error("run event fields are incomplete");
  }
  if (object["schemaVersion"] !== RUN_EVENT_SCHEMA_VERSION) throw new Error("unsupported run event schema version");
  if (typeof object["eventId"] !== "string" || !SHA256_PATTERN.test(object["eventId"])) throw new Error("run event ID is invalid");
  if (typeof object["runId"] !== "string" || !RUN_ID_PATTERN.test(object["runId"])) throw new Error("run event run ID is invalid");
  if (typeof object["ticketId"] !== "string" || !TICKET_ID_PATTERN.test(object["ticketId"]) || !object["runId"].startsWith(`${object["ticketId"].toLowerCase()}-`)) throw new Error("run event identity is invalid");
  if (!Number.isSafeInteger(object["stateRevision"]) || (object["stateRevision"] as number) < 1) throw new Error("run event state revision is invalid");
  if (typeof object["timestamp"] !== "string" || object["timestamp"].length > 64 || !validTimestamp(object["timestamp"])) throw new Error("run event timestamp is invalid");
  if (typeof object["type"] !== "string" || !RUN_EVENT_TYPES.includes(object["type"] as RunEventType)) throw new Error("run event type is invalid");
  if (object["phase"] !== undefined && (typeof object["phase"] !== "string" || !PERSONAL_PHASES.includes(object["phase"] as PersonalPhase))) throw new Error("run event phase is invalid");
  if (object["attempt"] !== undefined && (!Number.isSafeInteger(object["attempt"]) || (object["attempt"] as number) < 1 || (object["attempt"] as number) > 2)) throw new Error("run event attempt is invalid");
  if (object["outcome"] !== undefined && (typeof object["outcome"] !== "string" || !RUN_EVENT_OUTCOMES.includes(object["outcome"] as RunEventOutcome))) throw new Error("run event outcome is invalid");
  const typed = object["type"] as RunEventType;
  if (typed.startsWith("launch_")) {
    if (![0, 1].includes(object["generation"] as number) || object["phase"] === undefined || object["attempt"] === undefined) throw new Error("invalid launch event");
  } else if (object["generation"] !== undefined) throw new Error("unexpected launch generation");
  if (["phase_started", "phase_completed"].includes(typed) && object["phase"] === undefined) throw new Error("phase event requires a phase");
  if (["phase_started", "phase_completed"].includes(typed) && object["attempt"] === undefined) throw new Error("phase event requires an attempt");
  const expected = eventIdFor({
    runId: object["runId"],
    ticketId: object["ticketId"],
    type: object["type"] as RunEventType,
    ...(object["generation"] === undefined ? {} : { generation: object["generation"] as 0 | 1 }),
    ...(object["phase"] === undefined ? {} : { phase: object["phase"] as PersonalPhase }),
    ...(object["attempt"] === undefined ? {} : { attempt: object["attempt"] as number }),
    ...(object["outcome"] === undefined ? {} : { outcome: object["outcome"] as RunEventOutcome }),
  });
  if (object["eventId"] !== expected) throw new Error("run event ID does not match its transition identity");
}

/** Derive all meaningful events represented by one committed state transition. */
export function deriveRunEvents(previous: PersonalRunState | undefined, next: PersonalRunState): readonly RunEvent[] {
  const all = synthesizeCurrentRunEvents(next);
  const prior = new Set(previous ? synthesizeCurrentRunEvents(previous).map(e => e.eventId) : []);
  return all.filter(e => !prior.has(e.eventId));
}
export function synthesizeCurrentRunEvents(state: PersonalRunState): readonly RunEvent[] {
  const events: RunEvent[] = [...launchEvents(state,0)];
  const add = (type: RunEventType, extra: Partial<Pick<EventFields,"phase"|"attempt"|"outcome">> = {}) => events.push(createRunEvent({ runId: state.runId, ticketId: state.ticketId, stateRevision: state.version, timestamp: state.updatedAt, type, ...extra }));
  if(state.executionMode === "background") add("run_reserved");
  if(state.launchState === "started" || state.executionMode !== "background") add("run_started");
  for (const cycle of state.correction?.prior ?? []) {
    for (const result of [cycle.implement, cycle.verify]) {
      add("phase_started",{phase:result.phase,attempt:result.attempt});
      add("phase_completed",{phase:result.phase,attempt:result.attempt,outcome:result.status});
    }
  }
  for(const phase of PERSONAL_PHASES) {
    if(state.attempts[phase]) add("phase_started",{phase,attempt:state.attempts[phase]});
    const r=state.results[phase]; if(r) add("phase_completed",{phase,attempt:r.attempt,outcome:r.status});
  }
  if(state.publicationState !== "not_started") add("publication_started");
  if(state.publicationState === "published") add("publication_completed",{outcome:"completed"});
  if(state.status !== "running") add(state.status === "completed" ? "terminal_succeeded" : "terminal_failed",{outcome:state.status});
  return boundReconciledEvents(events);
}

function boundReconciledEvents(events: readonly RunEvent[]): readonly RunEvent[] {
  const unique = deduplicateEvents(events);
  if (unique.length <= MAX_RUN_EVENT_COUNT) return unique;

  // Recovery must remain bounded even if a corrupt-but-otherwise-readable
  // state contains an enormous attempt counter. Prefer the latest transitions,
  // while retaining lifecycle and terminal evidence for a useful reconciliation.
  const terminal = unique.filter(event => event.type === "terminal_succeeded" || event.type === "terminal_failed");
  const lifecycle = unique.filter(event => event.type === "run_reserved" || event.type === "run_started");
  const preserved = new Set([...terminal, ...lifecycle].map(event => event.eventId));
  const remaining = unique.filter(event => !preserved.has(event.eventId));
  const budget = Math.max(0, MAX_RUN_EVENT_COUNT - terminal.length - lifecycle.length);
  return deduplicateEvents([...lifecycle, ...remaining.slice(-budget), ...terminal]);
}

function samePhaseTransition(left: import("./types.js").PhaseResult, right: import("./types.js").PhaseResult): boolean {
  return left.phase === right.phase && left.attempt === right.attempt && left.sessionId === right.sessionId && left.status === right.status && left.outputHead === right.outputHead;
}

function deduplicateEvents(events: readonly RunEvent[]): readonly RunEvent[] {
  const seen = new Set<string>();
  return events.filter(event => {
    if (seen.has(event.eventId)) return false;
    seen.add(event.eventId);
    return true;
  });
}

/** A durable, bounded, atomically replaced per-run event outbox. */
export class JsonRunEventOutbox {
  readonly eventDirectory: string;
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly #renameRetry: RenameRetryOptions;

  constructor(readonly stateDirectory: string, options: { readonly eventDirectory?: string; readonly maxEvents?: number; readonly maxBytes?: number; readonly renameRetry?: RenameRetryOptions } = {}) {
    if (!stateDirectory || stateDirectory.includes("\0")) throw new Error("event state directory is invalid");
    this.eventDirectory = path.resolve(options.eventDirectory ?? path.join(stateDirectory, "events"));
    this.maxEvents = boundedNumber(options.maxEvents ?? MAX_RUN_EVENT_COUNT, 1, MAX_RUN_EVENT_COUNT);
    this.maxBytes = boundedNumber(options.maxBytes ?? MAX_RUN_EVENT_BYTES, 1, MAX_RUN_EVENT_BYTES);
    this.#renameRetry = options.renameRetry ?? {};
  }

  eventPath(runId: string): string {
    assertRunId(runId);
    return path.join(this.eventDirectory, `${runId}.json`);
  }

  async append(previous: PersonalRunState | undefined, next: PersonalRunState): Promise<readonly RunEvent[]> {
    const derived = deriveRunEvents(previous, next);
    if (derived.length === 0) return derived;
    await mkdir(this.eventDirectory, { recursive: true, mode: 0o700 });
    const existing = await this.read(next.runId);
    const byId = new Map<string, RunEvent>();
    for (const event of existing) byId.set(event.eventId, event);
    for (const event of derived) byId.set(event.eventId, event);
    const retained = retainEvents([...byId.values()], this.maxEvents, this.maxBytes);
    await this.#replace(next.runId, retained);
    return derived;
  }

  /** Malformed/missing outbox contents are treated as missed delivery. */
  async read(runId: string): Promise<readonly RunEvent[]> {
    const file = this.eventPath(runId);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (!metadata.isFile() || metadata.size > this.maxBytes) return [];
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (Buffer.byteLength(raw, "utf8") > this.maxBytes) return [];
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      // Accept a bounded JSONL recovery record as well. The producer always
      // writes an atomic JSON array, but this lets a consumer recover from an
      // interrupted/older outbox format without touching authoritative state.
      value = raw.split(/\r?\n/u).filter(line => line.trim().length > 0).map(line => {
        try { return JSON.parse(line) as unknown; }
        catch { return undefined; }
      });
    }
    const candidates = Array.isArray(value) ? value : [value];
    const valid: RunEvent[] = [];
    for (const candidate of candidates.slice(-this.maxEvents)) {
      try {
        validateRunEvent(candidate);
        if (candidate.runId === runId) valid.push(candidate);
      } catch {
        // A malformed record is not allowed to make authoritative state
        // unreadable. The next successful append replaces the bounded file.
      }
    }
    return sortEvents(deduplicateEvents(valid));
  }

  async #replace(runId: string, events: readonly RunEvent[]): Promise<void> {
    const target = this.eventPath(runId);
    const temporary = path.join(this.eventDirectory, `.${runId}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(encodeEvents(events), "utf8");
      await handle.sync();
      await handle.close();
      await renameOverExistingWithRetry(temporary, target, this.#renameRetry);
      await syncDirectory(this.eventDirectory);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/** Compatibility-friendly name for consumers that treat the outbox as a store. */
export class RunEventStore extends JsonRunEventOutbox {}
export const RunEventOutbox = JsonRunEventOutbox;

export function sortRunEvents(events: readonly RunEvent[]): readonly RunEvent[] {
  return sortEvents(events);
}

function sortEvents(events: readonly RunEvent[]): RunEvent[] {
  return [...events].sort((left, right) => left.stateRevision - right.stateRevision || Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.eventId.localeCompare(right.eventId));
}

function retainEvents(events: readonly RunEvent[], maxEvents: number, maxBytes: number): readonly RunEvent[] {
  let retained = sortEvents(events);
  if (retained.length > maxEvents) retained = retained.slice(retained.length - maxEvents);
  while (retained.length > 1 && Buffer.byteLength(encodeEvents(retained), "utf8") > maxBytes) retained = retained.slice(1);
  if (Buffer.byteLength(encodeEvents(retained), "utf8") > maxBytes) throw new Error("run event exceeds bounded outbox size");
  return retained;
}

function encodeEvents(events: readonly RunEvent[]): string {
  return `${JSON.stringify(events)}\n`;
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try { await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Directory fsync is unavailable on some Windows filesystems. The file
    // itself is still fsynced and the state-first contract remains intact.
    if (code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR" && code !== "ENOTSUP") throw error;
  }
}

function validTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function assertRunId(value: string): void {
  if (!RUN_ID_PATTERN.test(value)) throw new Error("invalid run event run ID");
}

function boundedNumber(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("run event outbox bound is invalid");
  return value;
}

// Keep this local guard useful to callers constructing an event identity from
// untrusted selector data without ever accepting arbitrary event-key strings.
export function validateEventKey(value: string): void {
  if (!EVENT_KEY_PATTERN.test(value)) throw new Error("run event key is invalid");
}

function launchEvents(state: PersonalRunState, offset: number): RunEvent[] {
  return (state.launchGenerations ?? []).slice(offset).map(r => createRunEvent({ runId: state.runId, ticketId: state.ticketId, stateRevision: state.version, timestamp: r.timestamp, type: `launch_${r.kind}`, phase: r.phase, attempt: r.attempt, generation: r.generation }));
}
