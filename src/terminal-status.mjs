import { inspectionLimits, withInspectionSnapshot } from './inspection-snapshot.mjs';
import path from 'node:path';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeIdentifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const safeTimestamp = value => Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;

const durableStatuses = new Set([
  'queued', 'running', 'completed', 'blocked', 'dependency_blocked', 'implementing', 'reviewing', 'verifying',
  'recovering', 'shipped', 'waiting', 'publishing', 'waiting_capacity', 'postmerge', 'waiting_ci', 'merging',
  'preparing', 'prepared', 'repairing', 'review_ready', 'continuing', 'recovering_partial', 'recovering_candidate'
]);
const projectStatuses = new Set(['queued', 'running', 'waiting', 'waiting_capacity', 'blocked', 'completed']);
const failures = new Set([
  'invalid_request', 'state_missing', 'state_unavailable', 'state_changed', 'state_limit', 'state_oversize',
  'state_malformed', 'project_missing', 'project_mismatch', 'state_stale', 'timestamp_missing', 'timestamp_invalid',
  'snapshot_invalid', 'unsupported_status', 'ticket_missing', 'ticket_malformed', 'no_selected_tickets', 'output_limit'
]);
const inspectionFailures = Object.freeze({
  inspection_input: 'invalid_request', inspection_missing: 'state_missing', inspection_path: 'state_unavailable',
  inspection_limit: 'state_limit', inspection_changed: 'state_changed', inspection_journal: 'state_unavailable',
  inspection_unavailable: 'state_unavailable', inspection_cleanup: 'state_unavailable', inspection_project: 'project_missing'
});

export const terminalStatusLimits = Object.freeze({
  maxSelectedTickets: inspectionLimits.rows,
  maxTicketsInState: inspectionLimits.rows,
  maxDurableAgeMs: 24 * 60 * 60 * 1000,
  futureTimestampSkewMs: 60 * 1000,
  stateBytes: inspectionLimits.stateBytes,
  outputBytes: inspectionLimits.outputBytes,
  minWatchSeconds: 1,
  maxWatchSeconds: 3600
});

function normalizedTicketIds(value) {
  if (!Array.isArray(value) || value.length > terminalStatusLimits.maxSelectedTickets * 4 ||
      value.some(id => !safeIdentifier(id))) return null;
  const ids = [...new Set(value)];
  return ids.length <= terminalStatusLimits.maxSelectedTickets ? ids : null;
}

function frame(value = {}) {
  const input = object(value) ? value : {};
  const tickets = Array.isArray(input.tickets) ? input.tickets : [];
  const projectId = input.projectId ?? null;
  const capturedAt = input.capturedAt ?? null;
  const durableUpdatedAt = input.durableUpdatedAt ?? null;
  const durableFreshness = input.durableFreshness ?? 'unknown';
  const availability = input.availability ?? 'unavailable';
  const failureCode = input.failureCode ?? null;
  const projectStatus = input.projectStatus ?? 'unknown';
  return {
    type: 'squire.terminal-status', version: 1,
    projectId: safeIdentifier(projectId) ? projectId : null,
    capturedAt: safeTimestamp(capturedAt) ? capturedAt : null,
    durableUpdatedAt: safeTimestamp(durableUpdatedAt) ? durableUpdatedAt : null,
    durableFreshness: ['fresh', 'stale', 'unknown'].includes(durableFreshness) ? durableFreshness : 'unknown',
    availability: ['available', 'unavailable', 'no_selection'].includes(availability) ? availability : 'unavailable',
    failureCode: failures.has(failureCode) ? failureCode : null,
    projectStatus: projectStatuses.has(projectStatus) ? projectStatus : 'unknown',
    tickets: tickets.slice(0, terminalStatusLimits.maxSelectedTickets).map(ticket => ({
      ticketId: safeIdentifier(ticket?.ticketId) ? ticket.ticketId : null,
      durableStatus: durableStatuses.has(ticket?.durableStatus) ? ticket.durableStatus : 'unknown',
      failureCode: failures.has(ticket?.failureCode) ? ticket.failureCode : null
    })),
    liveness: 'unknown'
  };
}

function unknownTickets(ids, failureCode) {
  return ids.map(ticketId => ({ ticketId, durableStatus: 'unknown', failureCode }));
}

function schemaHasProjectState(db) {
  const schema = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name='project'").get();
  return schema?.type === 'table' && typeof schema.sql === 'string' && !/^\s*CREATE\s+VIRTUAL\b/i.test(schema.sql) &&
    ['id', 'state'].every(column => db.prepare('PRAGMA table_info(project)').all().some(row => row.name === column));
}

function projectState(db, projectId, ticketIds, capture, now) {
  const capturedAt = safeTimestamp(capture?.capturedAt) && capture.capturedAt <= now + terminalStatusLimits.futureTimestampSkewMs
    ? capture.capturedAt : null;
  if (capturedAt === null) return { failureCode: 'snapshot_invalid', capturedAt: null };
  if (!schemaHasProjectState(db)) return { failureCode: 'state_malformed', capturedAt };

  // The state text is returned only for rows within the byte ceiling. Oversize
  // state is detected from the byte count without selecting its contents.
  const row = db.prepare(`SELECT CASE WHEN length(CAST(state AS BLOB))<=? THEN state ELSE NULL END AS state,
    length(CAST(state AS BLOB)) AS stateBytes FROM project WHERE id=?`).get(terminalStatusLimits.stateBytes, projectId);
  if (!row) return { failureCode: 'project_missing', capturedAt };
  if (!Number.isSafeInteger(row.stateBytes) || row.stateBytes < 0) return { failureCode: 'state_malformed', capturedAt };
  if (row.stateBytes > terminalStatusLimits.stateBytes) return { failureCode: 'state_oversize', capturedAt };

  let state;
  try { state = JSON.parse(row.state); } catch { return { failureCode: 'state_malformed', capturedAt }; }
  if (!object(state) || state.version !== 1 || typeof state.id !== 'string' || !safeIdentifier(state.id))
    return { failureCode: 'state_malformed', capturedAt };
  if (state.id !== projectId) return { failureCode: 'project_mismatch', capturedAt };
  if (!Array.isArray(state.tickets) || state.tickets.length > terminalStatusLimits.maxTicketsInState)
    return { failureCode: 'state_malformed', capturedAt };

  const seen = new Set();
  for (const ticket of state.tickets) {
    if (!object(ticket) || !object(ticket.spec) || !safeIdentifier(ticket.spec.id) || typeof ticket.status !== 'string' || seen.has(ticket.spec.id))
      return { failureCode: 'state_malformed', capturedAt };
    seen.add(ticket.spec.id);
  }

  if (!safeTimestamp(state.updatedAt)) {
    const failureCode = Object.hasOwn(state, 'updatedAt') ? 'timestamp_invalid' : 'timestamp_missing';
    return { failureCode, capturedAt };
  }
  if (state.updatedAt > now + terminalStatusLimits.futureTimestampSkewMs)
    return { failureCode: 'timestamp_invalid', capturedAt };
  if (now - state.updatedAt > terminalStatusLimits.maxDurableAgeMs) {
    return { failureCode: 'state_stale', capturedAt, durableUpdatedAt: state.updatedAt, durableFreshness: 'stale' };
  }

  const tickets = ticketIds.map(ticketId => {
    const saved = state.tickets.find(ticket => ticket.spec.id === ticketId);
    if (!saved) return { ticketId, durableStatus: 'unknown', failureCode: 'ticket_missing' };
    if (!durableStatuses.has(saved.status)) return { ticketId, durableStatus: 'unknown', failureCode: 'unsupported_status' };
    return { ticketId, durableStatus: saved.status, failureCode: null };
  });
  const knownProjectStatus = projectStatuses.has(state.status);
  return {
    capturedAt, durableUpdatedAt: state.updatedAt, durableFreshness: 'fresh', availability: 'available',
    failureCode: knownProjectStatus ? null : 'unsupported_status',
    projectStatus: knownProjectStatus ? state.status : 'unknown', tickets
  };
}

/**
 * Read a small, explicit projection from a private snapshot of one configured
 * project. This reports persisted facts only; current process liveness is not
 * available from the inspection contract.
 */
export function inspectTerminalStatus(request = {}, options = {}) {
  const input = object(request) ? request : {};
  const settings = object(options) ? options : {};
  const { id, stateDir, ticketIds } = input;
  const now = settings.now ?? Date.now;
  const snapshotReader = settings.snapshotReader ?? withInspectionSnapshot;
  const selected = normalizedTicketIds(ticketIds);
  const projectId = safeIdentifier(id) ? id : null;
  if (!projectId || typeof stateDir !== 'string' || stateDir.length > 4096 || !stateDir.length || stateDir.includes('\0') ||
      !path.isAbsolute(stateDir) || !selected)
    return frame({ projectId, failureCode: 'invalid_request' });
  if (selected.length === 0) return frame({ projectId, availability: 'no_selection', failureCode: 'no_selected_tickets' });
  let currentTime;
  try { currentTime = typeof now === 'function' ? now() : now; } catch { return frame({ projectId, tickets: unknownTickets(selected, 'invalid_request'), failureCode: 'invalid_request' }); }
  if (!safeTimestamp(currentTime)) return frame({ projectId, tickets: unknownTickets(selected, 'invalid_request'), failureCode: 'invalid_request' });

  try {
    const result = snapshotReader(stateDir, (db, capture) => projectState(db, projectId, selected, capture, currentTime));
    if (!object(result)) return frame({ projectId, tickets: unknownTickets(selected, 'state_unavailable'), failureCode: 'state_unavailable' });
    if (result.failureCode) return frame({ projectId, capturedAt: result.capturedAt, durableUpdatedAt: result.durableUpdatedAt,
      durableFreshness: result.durableFreshness, failureCode: result.failureCode,
      tickets: unknownTickets(selected, result.failureCode) });
    return frame({ projectId, ...result });
  } catch (error) {
    const failureCode = inspectionFailures[error?.code] ?? 'state_unavailable';
    return frame({ projectId, tickets: unknownTickets(selected, failureCode), failureCode });
  }
}

function timestampText(value) {
  if (!safeTimestamp(value)) return 'UNKNOWN';
  try { return new Date(value).toISOString(); } catch { return 'UNKNOWN'; }
}

/** Render a control-safe, bounded text frame. No stored free text is accepted. */
export function renderTerminalStatus(value) {
  const safe = frame(value);
  const projectId = safe.projectId ?? 'UNKNOWN';
  const durableStatus = safe.projectStatus.toUpperCase();
  const projectFailure = safe.failureCode ? ` [${safe.failureCode}]` : '';
  const lines = [
    'Squire durable terminal status',
    `Project ID: ${projectId}`,
    `Project durable status: ${durableStatus}${projectFailure}`,
    `Durable state freshness: ${safe.durableFreshness}`,
    `Durable updated at: ${timestampText(safe.durableUpdatedAt)}`,
    `Snapshot captured at: ${timestampText(safe.capturedAt)}`
  ];
  if (safe.availability === 'no_selection' || safe.tickets.length === 0) {
    lines.push(`Tickets: none selected${safe.failureCode ? ` [${safe.failureCode}]` : ''}`);
  } else {
    lines.push('Selected ticket durable statuses:');
    for (const ticket of safe.tickets) {
      const id = ticket.ticketId ?? 'UNKNOWN';
      const ticketFailure = ticket.failureCode ? ` [${ticket.failureCode}]` : '';
      lines.push(`- ${id}: ${ticket.durableStatus.toUpperCase()}${ticketFailure}`);
    }
  }
  lines.push('Liveness: UNKNOWN (no verified OS liveness evidence)');
  let output = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(output, 'utf8') > terminalStatusLimits.outputBytes)
    output = 'Squire durable terminal status\nProject durable status: UNKNOWN [output_limit]\nLiveness: UNKNOWN\n';
  return output;
}

const defaultSleep = (milliseconds, { signal } = {}) => new Promise(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const timer = setTimeout(done, milliseconds);
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); }
  signal?.addEventListener('abort', abort, { once: true });
});

/** Sequential bounded refresh helper used by the standalone CLI and tests. */
export async function* watchTerminalStatus(readFrame, seconds, { signal, sleep = defaultSleep } = {}) {
  if (typeof readFrame !== 'function' || !Number.isSafeInteger(seconds) || seconds < terminalStatusLimits.minWatchSeconds || seconds > terminalStatusLimits.maxWatchSeconds)
    throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
  while (!signal?.aborted) {
    yield await readFrame();
    if (signal?.aborted) return;
    await sleep(seconds * 1000, { signal });
  }
}

/** CLI refresh loop with an injectable writer for bounded shutdown behavior. */
export async function runTerminalStatusWatch(readFrame, writeFrame, seconds, options = {}) {
  if (typeof writeFrame !== 'function') throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
  const settings = object(options) ? options : {};
  for await (const value of watchTerminalStatus(readFrame, seconds, settings)) {
    if (await writeFrame(value) === false) return 'output_closed';
  }
  return settings.signal?.aborted ? 'stopped' : 'completed';
}

/** Render one frame and stop waiting for backpressure when shutdown or EPIPE occurs. */
export async function writeTerminalStatusFrame(stream, value, { signal } = {}) {
  if (!stream || typeof stream.write !== 'function' || signal?.aborted || stream.destroyed || stream.writableEnded)
    return false;
  let output;
  try { output = renderTerminalStatus(value); } catch { return false; }
  if (signal?.aborted || stream.destroyed || stream.writableEnded) return false;
  return new Promise(resolve => {
    let settled = false;
    const complete = (success) => {
      if (settled) return;
      settled = true;
      stream.removeListener('drain', drain);
      stream.removeListener('error', failure);
      stream.removeListener('close', failure);
      signal?.removeEventListener('abort', failure);
      resolve(success && !signal?.aborted);
    };
    if (typeof stream.on !== 'function' || typeof stream.removeListener !== 'function') {
      resolve(false);
      return;
    }
    const drain = () => complete(true);
    const failure = () => complete(false);
    stream.on('drain', drain);
    stream.on('error', failure);
    stream.on('close', failure);
    signal?.addEventListener('abort', failure, { once: true });
    if (signal?.aborted || stream.destroyed || stream.writableEnded) { complete(false); return; }
    try {
      const accepted = stream.write(output);
      if (settled) return;
      if (stream.destroyed || stream.writableEnded) complete(false);
      else if (accepted) complete(true);
    } catch { complete(false); }
  });
}

/** Parse the standalone CLI's small, explicit argument surface. */
export function parseTerminalStatusArgs(args) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) return { failureCode: 'invalid_request' };
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) return { help: true };
  if (!args.length || !args[0] || args[0].startsWith('-')) return { failureCode: 'invalid_request' };
  const ticketIds = [];
  let watchSeconds = null, watchSeen = false;
  for (const arg of args.slice(1)) {
    if (arg.startsWith('--watch=')) {
      if (watchSeen || !/^[0-9]+$/.test(arg.slice(8))) return { failureCode: 'invalid_request' };
      watchSeen = true;
      watchSeconds = Number(arg.slice(8));
      if (!Number.isSafeInteger(watchSeconds) || watchSeconds < terminalStatusLimits.minWatchSeconds ||
          watchSeconds > terminalStatusLimits.maxWatchSeconds) return { failureCode: 'invalid_request' };
    } else if (arg.startsWith('-') || !safeIdentifier(arg)) return { failureCode: 'invalid_request' };
    else ticketIds.push(arg);
  }
  if (ticketIds.length > terminalStatusLimits.maxSelectedTickets * 4) return { failureCode: 'invalid_request' };
  const selected = [...new Set(ticketIds)];
  if (selected.length > terminalStatusLimits.maxSelectedTickets) return { failureCode: 'invalid_request' };
  return { configPath: args[0], ticketIds: selected, watchSeconds };
}
