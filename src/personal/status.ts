import { PERSONAL_PHASES, type PersonalPhase, type PersonalRunState, type RunStatePort } from "./types.js";
import type { RunEvent } from "./run-events.js";

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
  const exact = RUN_PATTERN.test(selector);
  let initial: PersonalRunState | undefined;
  try { initial = exact && states.read ? await states.read(selector) : undefined; }
  catch { throw new StatusLookupError("ambiguous", "run state is unreadable; retry status or inspect controller diagnostics"); }
  if (exact && !initial) throw new StatusLookupError("missing", `no persisted run found for ${selector}`);
  const ticket = initial?.ticketId ?? selector;
  const ambiguous = (detail: string): never => {
    throw new StatusLookupError("ambiguous", `run reservation is ambiguous for ${ticket}: ${detail}; retry status or inspect controller diagnostics; do not remove or reclaim ownership evidence`);
  };
  const observe = async () => {
    if (!states.observeReservation) return undefined;
    let value;
    try { value = await states.observeReservation(ticket); }
    catch { return ambiguous("owner evidence unreadable"); }
    if (!value || !["absent", "owner", "ambiguous"].includes(value.kind)) ambiguous("owner evidence unreadable");
    if (value.kind === "ambiguous") ambiguous(`owner evidence ${value.reason}`);
    return value;
  };
  // Never call reservationOwner: it is a mutation-authorization query and
  // acquires the ticket mutex. Ports without observation retain state-only use.
  const before = await observe();
  let candidates: PersonalRunState[];
  try {
    candidates = states.findByTicket ? [...await states.findByTicket(ticket)]
      : exact && !states.observeReservation ? [initial!] : await fallbackTicketStates(states, ticket);
  } catch { return ambiguous("state evidence unreadable"); }
  const selectedExact = exact ? (states.findByTicket ? candidates.find(s => s.runId === selector) : initial) : undefined;
  const active = candidates.filter(state => state.status === "running");
  if (active.length > 1) ambiguous("multiple active runs found");
  const after = await observe();
  if (JSON.stringify(before) !== JSON.stringify(after)) ambiguous("ownership changed during observation");
  if (after?.kind === "owner") {
    const running = active[0];
    if (!running || running.runId !== after.runId || (running.controllerPid != null && running.controllerPid !== after.pid) ||
        (after.role === "reserver" ? running.launchState !== "reserved" || running.controllerPid !== null : running.launchState === "reserved")) {
      ambiguous("verified live owner does not match a readable active state");
    }
    if (selectedExact?.status !== "running" && selectedExact?.runId === after.runId) ambiguous("terminal run retains reservation");
  } else if (after?.kind === "absent" && active.length > 0) {
    ambiguous("reservation absent for active run");
  }
  if (exact) {
    if (!selectedExact) ambiguous("selected state disappeared");
    return selectedExact!;
  }
  if (candidates.length === 0) throw new StatusLookupError("missing", `no persisted run found for ${selector}`);
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
    ...(state.reservationCleanupFailure ? [`Reservation cleanup: ${display(state.reservationCleanupFailure)}`] : []),
    `PR URL: ${display(state.prUrl ?? "unavailable")}`,
    `Stdout log: ${display(state.stdoutPath ?? "unavailable")}`,
    `Stderr log: ${display(state.stderrPath ?? "unavailable")}`,
  ];
  const staged = [...(state.stagedTransitions ?? [])].reverse().find(t => !phase || t.phase === phase);
  const selectionReason = [...(state.stagedTransitions ?? [])].reverse().find(t => t.kind === "reserved" && t.phase === staged?.phase && t.attempt === staged.attempt)?.reason;
  const correction = state.reportCorrections?.at(-1);
  if (state.reportCorrectionPolicy) lines.push(`Report correction: maximum=${state.reportCorrectionPolicy.maxAttempts} per phase attempt${correction ? ` phase=${correction.phase} attempt=${correction.attempt} used=${correction.used} remaining=${correction.remaining} status=${correction.kind}` : ` used=0 remaining=${state.reportCorrectionPolicy.maxAttempts}`}`);
  if (staged) lines.push(`Escalation: ${staged.phase} stage=${staged.stageIndex + 1}/${state.escalationPolicy![staged.phase]!.stages.length} stage-consumed=${staged.stageAttempt}/${staged.stageMaximum} consumed=${staged.consumed} remaining=${staged.remaining} reason=${staged.reason} selected-by=${selectionReason} classification=${staged.classification ?? "reserved"} policy=${staged.policyDigest}`);
  else if (state.escalationDigest) lines.push(`Escalation policy: ${state.escalationDigest} (no attempt reserved for current phase)`);
  if (state.step === "plan" && state.planProgress) lines.push(`Progress: Plan / ${state.planProgress.subphase === "requirements" ? "Requirements" : "Implementation Design"}`);
  const plan = state.results.plan?.phase === "plan" ? state.results.plan.details.supervision : undefined;
  if (plan?.outcome === "needs_clarification") lines.push(`Plan blocked: ${display(state.results.plan!.summary)}`);
  if (state.executionMode) lines.push(`Execution mode: ${display(state.executionMode)}`);
  if (state.controllerPid !== undefined && state.controllerPid !== null) lines.push(`Controller PID: ${state.controllerPid}`);
  return `${lines.join("\n")}\n`;
}

/** Render only bounded event fields; titles, diagnostics, prompts, and logs never enter watch output. */
export function formatRunEvent(event: RunEvent): string {
  const fields = [
    display(event.timestamp),
    `event=${display(event.type)}`,
    `ticket=${display(event.ticketId)}`,
    `run=${display(event.runId)}`,
    `revision=${event.stateRevision}`,
  ];
  if (event.phase !== undefined) fields.push(`phase=${display(event.phase)}`);
  if (event.attempt !== undefined) fields.push(`attempt=${event.attempt}`);
  if (event.outcome !== undefined) fields.push(`outcome=${display(event.outcome)}`);
  if (event.staged) {
    const t = event.staged;
    fields.push(`stage=${t.stageIndex + 1}`, `stage-consumed=${t.stageAttempt}/${t.stageMaximum}`, `consumed=${t.consumed}`, `remaining=${t.remaining}`, `profile=${display(`${t.profile.provider}/${t.profile.model}@${t.profile.thinking}`)}`, `reason=${t.reason}`, `classification=${t.classification ?? "reserved"}`, `policy=${t.policyDigest}`);
  }
  return `${fields.join(" ")}\n`;
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
  const staged = [...(state.stagedTransitions ?? [])].reverse().find(t => !phase || t.phase === phase);
  if (staged) return staged.profile;
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
