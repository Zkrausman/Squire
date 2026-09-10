import { PERSONAL_PHASES, type PersonalPhase, type PersonalRunState, type RunStatePort } from "./types.js";

const TICKET_PATTERN = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u;
const RUN_PATTERN = /^[a-z][a-z0-9]+-[a-z0-9][a-z0-9-]{7,127}$/u;

export type StatusLookupErrorCode = "malformed" | "missing" | "ambiguous";

export class StatusLookupError extends Error {
  readonly code: StatusLookupErrorCode;

  constructor(code: StatusLookupErrorCode, message: string) {
    super(sanitizeTerminalText(message));
    this.name = "StatusLookupError";
    this.code = code;
  }
}

/** Validate a status selector without contacting Linear, Git, or Docker. */
export function validateStatusSelector(value: string): string {
  if (TICKET_PATTERN.test(value) || RUN_PATTERN.test(value)) return value;
  throw new StatusLookupError("malformed", `malformed ticket or run ID: ${value}`);
}

/**
 * Read a persisted state by exact run ID or ticket. Active states win; when a
 * ticket has no active state the newest state is chosen deterministically.
 */
export async function findRunState(states: RunStatePort, selector: string): Promise<PersonalRunState> {
  validateStatusSelector(selector);
  if (RUN_PATTERN.test(selector)) {
    const state = states.read ? await states.read(selector) : undefined;
    if (!state) throw new StatusLookupError("missing", `no persisted run found for ${selector}`);
    // An exact run ID identifies one persisted record. A terminal historical
    // record remains readable when its ticket has since been reserved by a
    // different, readable active run; the ticket selector will still return
    // that replacement. Do not apply that exception to a second running
    // record or to an owner that cannot be proved active and on this ticket.
    let owner: string | undefined;
    try {
      owner = states.reservationOwner ? await states.reservationOwner(state.ticketId) : undefined;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new StatusLookupError("ambiguous", `run reservation is unreadable for ${state.ticketId}: ${detail}`);
    }
    if (state.status === "running") {
      if (owner !== state.runId) {
        throw new StatusLookupError("ambiguous", `run reservation does not match active run ${state.runId}: ${owner ?? "absent"}`);
      }
    } else if (owner === state.runId) {
      throw new StatusLookupError("ambiguous", `run reservation does not match terminal run ${state.runId}`);
    } else if (owner) {
      let replacement: PersonalRunState | undefined;
      try {
        replacement = states.read ? await states.read(owner) : undefined;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new StatusLookupError("ambiguous", `replacement run is unreadable for ${state.ticketId}: ${detail}`);
      }
      if (!replacement || replacement.ticketId !== state.ticketId || replacement.status !== "running") {
        throw new StatusLookupError("ambiguous", `run reservation does not match a readable active run for ${state.ticketId}: ${owner}`);
      }
    }
    return state;
  }

  const candidates = states.findByTicket
    ? [...await states.findByTicket(selector)]
    : await fallbackTicketStates(states, selector);
  let owner: string | undefined;
  try {
    owner = states.reservationOwner ? await states.reservationOwner(selector) : undefined;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new StatusLookupError("ambiguous", `run reservation is unreadable for ${selector}: ${detail}`);
  }
  if (candidates.length === 0) {
    if (owner) throw new StatusLookupError("ambiguous", `run reservation exists without a readable state: ${owner}`);
    throw new StatusLookupError("missing", `no persisted run found for ${selector}`);
  }
  const active = candidates.filter(state => state.status === "running");
  if (active.length > 1) throw new StatusLookupError("ambiguous", `multiple active runs found for ${selector}`);
  // A lock is meaningful even when an older terminal state exists, and an
  // active state is authoritative only while its exact reservation remains.
  // Every other combination is ambiguous and must not be hidden.
  if (active.length === 1 && owner !== active[0]!.runId) {
    throw new StatusLookupError("ambiguous", `run reservation does not match a readable active state: ${owner ?? "absent"}`);
  }
  if (owner && active.length === 0) {
    throw new StatusLookupError("ambiguous", `run reservation does not match a readable active state: ${owner}`);
  }
  return [...(active.length === 1 ? active : candidates)].sort(compareStates)[0]!;
}

/** Render status solely from the persisted state. No live process or Git read is performed. */
export function formatRunStatus(state: PersonalRunState, now: Date = new Date()): string {
  const phase = phaseForStatus(state.step);
  const attempt = phase ? state.attempts[phase] : 0;
  const profile = profileForStatus(state, phase);
  const lines = [
    "Squire status",
    `Ticket: ${display(state.ticketId)}`,
    `Title: ${display(state.ticketTitle)}`,
    `Run ID: ${display(state.runId)}`,
    `Status: ${display(state.status)}`,
    `Lifecycle: ${display(state.lifecycle ?? state.step)}`,
    `Phase: ${display(state.step)}`,
    `Attempt: ${attempt}`,
    `Provider: ${display(profile?.provider ?? "unavailable")}`,
    `Model: ${display(profile?.model ?? "unavailable")}`,
    `Thinking: ${display(profile?.thinking ?? "unavailable")}`,
    `Resolved profiles: ${display(state.profiles ? PERSONAL_PHASES.map(phaseName => `${phaseName}=${state.profiles![phaseName].provider}/${state.profiles![phaseName].model}@${state.profiles![phaseName].thinking}`).join(", ") : "unavailable")}`,
    `Elapsed: ${display(formatElapsed(state, now))}`,
    `Current HEAD: ${display(state.head ?? "unavailable")}`,
    `Terminal error: ${display(state.lastError ?? "unavailable")}`,
    `PR URL: ${display(state.prUrl ?? "unavailable")}`,
    `Stdout log: ${display(state.stdoutPath ?? "unavailable")}`,
    `Stderr log: ${display(state.stderrPath ?? "unavailable")}`,
  ];
  if (state.executionMode) lines.push(`Execution mode: ${display(state.executionMode)}`);
  if (state.controllerPid !== undefined && state.controllerPid !== null) lines.push(`Controller PID: ${state.controllerPid}`);
  return `${lines.join("\n")}\n`;
}

export function formatElapsed(state: PersonalRunState, now: Date = new Date()): string {
  // Do not infer a historical start time for old v1 records. The explicit
  // unavailable value is more honest than turning updatedAt into fake timing
  // evidence.
  if (!state.startedAt) return "unavailable";
  const started = Date.parse(state.startedAt);
  if (!Number.isFinite(started)) return "unavailable";
  if (state.status !== "running" && !state.endedAt) return "unavailable";
  const terminal = state.status !== "running" ? Date.parse(state.endedAt!) : now.valueOf();
  if (!Number.isFinite(terminal)) return "unavailable";
  const milliseconds = Math.max(0, terminal - started);
  return `${formatDuration(milliseconds)} (${milliseconds} ms)`;
}

/** Escape untrusted text before putting it on a human-readable terminal line. */
export function sanitizeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, character => {
    if (character === "\r") return "\\r";
    if (character === "\n") return "\\n";
    const code = character.codePointAt(0)!;
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`;
  });
}

function display(value: string): string {
  return sanitizeTerminalText(value);
}

function formatDuration(milliseconds: number): string {
  let seconds = Math.floor(milliseconds / 1_000);
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function phaseForStatus(step: PersonalRunState["step"]): PersonalPhase | undefined {
  return PERSONAL_PHASES.includes(step as PersonalPhase) ? step as PersonalPhase : undefined;
}

function profileForStatus(state: PersonalRunState, phase: PersonalPhase | undefined) {
  if (phase && state.profiles?.[phase]) return state.profiles[phase];
  // During launch/preparation there is no current phase yet, but the selected
  // Plan profile is already durable and is the most useful resolved model to
  // show. Legacy files deliberately remain unavailable.
  return state.profiles?.plan;
}

function compareStates(left: PersonalRunState, right: PersonalRunState): number {
  const leftTime = Date.parse(left.startedAt ?? left.updatedAt);
  const rightTime = Date.parse(right.startedAt ?? right.updatedAt);
  if (leftTime !== rightTime) return rightTime - leftTime;
  if (left.version !== right.version) return right.version - left.version;
  return right.runId.localeCompare(left.runId);
}

async function fallbackTicketStates(states: RunStatePort, ticketId: string): Promise<PersonalRunState[]> {
  // A minimal custom port can still support status for the active run. The
  // production JSON store exposes findByTicket and never enters this branch.
  const active = await states.findActive(ticketId);
  return active ? [active] : [];
}
