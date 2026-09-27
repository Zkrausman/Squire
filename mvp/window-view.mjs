const RUN_ID = /^squire-[0-9]{10,16}-[a-f0-9]{10}$/;
const TICKET_ID = /^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,8}$/;
const PHASES = new Set(['starting', 'preflight', 'clone', 'plan', 'implement', 'artifact']);
const MAX_TIMESTAMP = 4_102_444_800_000;
const MAX_ROWS = 128;
const MAX_RECENT = 8;
const RECENT_MS = 24 * 60 * 60_000;
const NEXT_GATE = 'Independent review and external tests/CI required';
export const REPORT_STALE_MS = 5 * 60_000;
const HEARTBEAT_STALE_MS = 16_000;

function safeText(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMESTAMP;
}

function projectReport(value, phase, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.phase !== phase || !['complete', 'unavailable'].includes(value.status)
    || !Number.isSafeInteger(value.number) || value.number < 1
    || !safeTimestamp(value.finishedAtMs)
    || !safeText(value.currentAction, 240)
    || !['low', 'medium', 'high', 'unknown'].includes(value.confidence)) return null;
  const projectList = field => Array.isArray(value[field]) && value[field].length <= 4
    && value[field].every(item => safeText(item, 200)) ? [...value[field]] : null;
  const evidence = projectList('evidence');
  const risks = projectList('risks');
  const stalls = projectList('stalls');
  if (!evidence || !risks || !stalls) return null;
  return {
    phase: value.phase,
    status: value.status,
    number: value.number,
    finishedAtMs: value.finishedAtMs,
    currentAction: value.currentAction,
    evidence,
    risks,
    stalls,
    confidence: value.confidence,
    ageMs: Math.max(0, now - value.finishedAtMs),
  };
}

function projectRow(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !RUN_ID.test(value.runId) || !TICKET_ID.test(value.ticketId)
    || !safeText(value.ticketName, 100) || !PHASES.has(value.phase)
    || !safeTimestamp(value.processStartMs) || !safeTimestamp(value.updatedAtMs)) return null;

  const hasReport = Object.hasOwn(value, 'report');
  const report = value.report === null || value.report === undefined
    ? null : projectReport(value.report, value.phase, now);
  const reportUnavailable = value.reportUnavailable === true || !hasReport
    || value.report === undefined || (value.report !== null && !report);
  const reportFuture = report && report.finishedAtMs > now + 2_000;
  const reportState = reportUnavailable || reportFuture || report?.status === 'unavailable'
    ? 'unavailable'
    : !report ? 'not-reported'
      : report.ageMs > REPORT_STALE_MS ? 'stale' : 'available';
  const heartbeatAgeMs = now - value.updatedAtMs;
  const heartbeatState = value.updatedAtMs > now + 2_000 ? 'unavailable'
    : heartbeatAgeMs > HEARTBEAT_STALE_MS ? 'stale' : 'available';

  return {
    runId: value.runId,
    ticketId: value.ticketId,
    ticketName: value.ticketName.trim(),
    phase: value.phase,
    processStartMs: value.processStartMs,
    updatedAtMs: value.updatedAtMs,
    heartbeatAgeMs: Math.max(0, heartbeatAgeMs),
    heartbeatState,
    report: reportState === 'unavailable' ? null : report,
    reportState,
  };
}

export function projectDashboard(value, now = Date.now()) {
  if (!Array.isArray(value) || value.length > MAX_ROWS) throw new Error('Invalid status snapshot');
  const timestamp = Number.isFinite(now) ? now : Date.now();
  const rows = [];
  const seenRunIds = new Set();
  let invalidRows = 0;
  for (const item of value) {
    const row = projectRow(item, timestamp);
    if (!row || seenRunIds.has(row.runId)) {
      invalidRows++;
      continue;
    }
    seenRunIds.add(row.runId);
    rows.push(row);
  }
  return { rows, invalidRows };
}

// Terminal receipts are a separate, short-lived source. No result here is Verified,
// published, installed, or a completed Linear ticket.
export function projectRecentOutcomes(value, activeRunIds = [], now = Date.now()) {
  if (!Array.isArray(value) || value.length > MAX_RECENT) throw new Error('Invalid recent outcomes');
  const active = new Set(activeRunIds);
  const seen = new Set();
  const rows = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'completedAtMs,nextGate,runId,status,ticketId,ticketName'
      || !RUN_ID.test(item.runId) || !TICKET_ID.test(item.ticketId)
      || !safeText(item.ticketName, 100) || item.status !== 'UNVERIFIED'
      || item.nextGate !== NEXT_GATE || !safeTimestamp(item.completedAtMs)
      || item.completedAtMs > now + 2_000 || now-item.completedAtMs > RECENT_MS
      || active.has(item.runId) || seen.has(item.runId)) continue;
    seen.add(item.runId);
    rows.push({runId:item.runId,ticketId:item.ticketId,ticketName:item.ticketName,
      completedAtMs:item.completedAtMs,status:'UNVERIFIED',nextGate:NEXT_GATE});
  }
  return rows.sort((a,b)=>b.completedAtMs-a.completedAtMs || a.runId.localeCompare(b.runId));
}

export function restoreSelection(rows, requestedRunId) {
  if (typeof requestedRunId === 'string' && RUN_ID.test(requestedRunId)
    && rows.some(row => row.runId === requestedRunId)) return requestedRunId;
  return rows[0]?.runId ?? null;
}
