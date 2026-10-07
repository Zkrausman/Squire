import { createHash } from 'node:crypto';
import path from 'node:path';
import { withInspectionSnapshot, inspectionError, inspectionLimits as limits } from './inspection-snapshot.mjs';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v) ? v : null;
const identifier = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v) ? v : null;
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : null;
const timestamp = v => Number.isSafeInteger(v) && v > 0 ? v : null;
const parse = v => { try { const value = JSON.parse(v); return object(value) ? value : null; } catch { return null; } };
const phases = ['registered', 'supervisor', 'target'];
const statuses = ['queued', 'running', 'completed', 'blocked', 'dependency_blocked', 'implementing', 'reviewing', 'verifying',
  'recovering', 'shipped', 'waiting', 'publishing', 'waiting_capacity', 'postmerge', 'waiting_ci', 'merging', 'preparing',
  'prepared', 'repairing', 'review_ready', 'continuing', 'recovering_partial', 'recovering_candidate'];
const projectLanes = ['project:preflight', 'project:plan', 'project:acceptance', 'project:agent', 'project:doctor', 'project:configure-runtime'];
const lane = v => projectLanes.includes(v) || (typeof v === 'string' && v.startsWith('ticket:') && identifier(v.slice(7))) ? v : null;
const hash = v => createHash('sha256').update(v).digest('hex');

/** A bounded local diagnostic projection, not an authorization or liveness API.
 * Raw configuration, prompts, errors, argv, tokens, owners and paths never leave
 * this reader. Artifact handles describe protocol slots; files are never opened. */
export function inspectProducers({ id, stateDir }) {
  if (!identifier(id) || typeof stateDir !== 'string') throw inspectionError('inspection_input');
  return withInspectionSnapshot(stateDir, (db, capture) => {
    const issues = new Set();
    const issue = code => issues.add(code);
    const status = value => { if (statuses.includes(value)) return value; issue('unknown_durable_status'); return 'unknown'; };
    const tables = {
      project: ['id', 'state'], events: ['cursor'],
      producer_scopes: ['id', 'project', 'lane', 'created_at', 'outcome', 'closed_at'],
      producer_resources: ['scope_id', 'resource'], producer_calls: ['job_id', 'scope_id'],
      process_operations: ['id', 'scope_id', 'job_id', 'directory', 'request_digest', 'phase', 'terminal']
    };
    const available = {};
    for (const [name, columns] of Object.entries(tables)) {
      const schema = db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(name);
      const found = schema?.type === 'table' && typeof schema.sql === 'string' && !/^\s*CREATE\s+VIRTUAL\b/i.test(schema.sql) &&
        columns.every(column => db.prepare(`PRAGMA table_info(${name})`).all().some(row => row.name === column));
      available[name] = Boolean(found);
      if (!found) issue(`missing_or_legacy_${name}`);
    }
    const rows = (sql, ...args) => {
      const result = db.prepare(`${sql} LIMIT ${limits.rows + 1}`).all(...args);
      if (result.length > limits.rows) throw inspectionError('inspection_limit');
      for (const row of result) if (Object.entries(row).some(([key, value]) => key.endsWith('_oversize') && value)) issue('oversize_record_field');
      return result;
    };
    // All names below are static, never supplied by stored data or CLI input.
    const fields = (names, max = limits.fieldBytes) => names.map(name =>
      `CASE WHEN length(CAST(${name} AS BLOB))<=${max} THEN ${name} ELSE NULL END AS ${name},
      CASE WHEN length(CAST(${name} AS BLOB))>${max} THEN 1 ELSE 0 END AS ${name}_oversize`).join(',');
    let state = null;
    if (available.project) {
      const row = db.prepare(`SELECT ${fields(['state'], limits.stateBytes)} FROM project WHERE id=?`).get(id);
      if (!row) throw inspectionError('inspection_project');
      state = parse(row.state);
      if (!state || state.id !== id) { state = null; issue('malformed_or_oversize_project_state'); }
    }
    const references = new Set(), holds = [];
    const addReference = value => {
      const ref = uuid(value);
      if (ref) references.add(ref); else issue('malformed_scope_reference');
      if (references.size > limits.rows) throw inspectionError('inspection_limit');
    };
    const blocker = value => {
      if (value?.code !== 'producer_unresolved') return;
      if (value.detail?.scopeId !== undefined) addReference(value.detail.scopeId);
      if (Array.isArray(value.detail?.scopes)) {
        if (value.detail.scopes.length > limits.rows) throw inspectionError('inspection_limit');
        for (const scope of value.detail.scopes) addReference(scope?.id);
      }
    };
    blocker(state?.blocker);
    if (state && !Array.isArray(state.tickets)) issue('malformed_ticket_state');
    if (Array.isArray(state?.tickets)) {
      if (state.tickets.length > limits.rows) throw inspectionError('inspection_limit');
      for (const ticket of state.tickets) {
        blocker(ticket?.blocker);
        if (!ticket?.producerHold) continue;
        addReference(ticket.producerHold.scopeId);
        const ticketId = identifier(ticket.spec?.id);
        if (!ticketId) issue('malformed_ticket_identity');
        holds.push({ ticketId, scopeId: uuid(ticket.producerHold.scopeId), durableStatus: status(ticket.status),
          priorStatus: status(ticket.producerHold.status), source: 'project.state.tickets.producerHold' });
      }
    }
    const highWater = available.events ? db.prepare('SELECT MAX(cursor) AS cursor FROM events').get().cursor ?? 0 : null;
    if (highWater !== null && (!Number.isSafeInteger(highWater) || highWater < 0)) throw inspectionError('inspection_unavailable');
    const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='immutable_process_terminal'").get()?.sql;
    const normalize = s => s?.replace(/\s+/g, ' ').trim().replace(/;$/, '');
    const immutableGuard = normalize(trigger) === "CREATE TRIGGER immutable_process_terminal BEFORE UPDATE ON process_operations WHEN OLD.terminal IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable process terminal'); END";
    if (available.process_operations && !immutableGuard) issue('terminal_immutability_guard_unrecognized');
    const scopes = [];
    if (available.producer_scopes) {
      const selected = rows(`SELECT ${fields(tables.producer_scopes)} FROM producer_scopes WHERE project=? AND closed_at IS NULL ORDER BY id`, id);
      for (const ref of references) {
        if (selected.some(s => s.id === ref)) continue;
        if (selected.length + scopes.length >= limits.rows) throw inspectionError('inspection_limit');
        const record = db.prepare(`SELECT ${fields(tables.producer_scopes)} FROM producer_scopes WHERE id=?`).get(ref);
        if (record) {
          if (Object.entries(record).some(([key, value]) => key.endsWith('_oversize') && value)) issue('oversize_record_field');
          selected.push(record);
        }
        else { issue('referenced_scope_missing'); scopes.push({ scopeId: ref, evidence: 'missing', source: 'project.state' }); }
      }
      if (selected.length + scopes.length > limits.rows) throw inspectionError('inspection_limit');
      let remaining = limits.rows;
      for (const s of selected) {
        const scopeId = uuid(s.id), projectId = identifier(s.project), scopeLane = lane(s.lane);
        if (!scopeId || !projectId || !scopeLane || !timestamp(s.created_at)) issue('malformed_scope_identity');
        // Invalid keys must not be used to traverse other records.
        const resources = scopeId && available.producer_resources ? rows(`SELECT ${fields(['resource'])} FROM producer_resources WHERE scope_id=? ORDER BY resource`, s.id) : null;
        const calls = scopeId && available.producer_calls ? rows(`SELECT ${fields(['job_id'])} FROM producer_calls WHERE scope_id=? ORDER BY job_id`, s.id) : null;
        const operations = scopeId && available.process_operations ? rows(`SELECT ${fields(tables.process_operations)} FROM process_operations WHERE scope_id=? ORDER BY id`, s.id) : null;
        remaining -= (resources?.length ?? 0) + (calls?.length ?? 0) + (operations?.length ?? 0);
        if (remaining < 0) throw inspectionError('inspection_limit');
        const reservations = calls?.map(c => {
          if (!uuid(c.job_id)) issue('malformed_reservation_identity');
          return { jobId: uuid(c.job_id), source: 'producer_calls', operationIds: operations?.filter(o => o.job_id === c.job_id).map(o => uuid(o.id)) ?? null };
        }) ?? null;
        const projectedOperations = operations?.map(o => {
          const operationId = uuid(o.id), phase = phases.includes(o.phase) ? o.phase : 'unknown';
          if (!operationId || phase === 'unknown' || !digest(o.request_digest)) issue('malformed_operation_identity');
          const receipt = parse(o.terminal);
          const validTerminal = receipt && ['terminal', 'not_started'].includes(receipt.kind) && timestamp(receipt.endedAt) &&
            (receipt.exitCode === null || Number.isInteger(receipt.exitCode)) && digest(receipt.receiptDigest) &&
            (phase === 'target' || (phase === 'registered' && receipt.kind === 'not_started'));
          // NULL can also mean an oversized field, so never assert absence as
          // proof of no execution. Both cases leave the outcome unknown.
          if (o.terminal !== null && !validTerminal) issue('malformed_terminal');
          const jobId = uuid(o.job_id);
          const linkage = o.job_id === null && !o.job_id_oversize ? 'not_recorded' : jobId && calls?.some(c => c.job_id === jobId) ? 'linked' : 'missing_or_malformed';
          if (linkage === 'missing_or_malformed') issue('reservation_link_missing_or_malformed');
          const directory = typeof o.directory === 'string' && !o.directory.includes('\0') &&
            (path.posix.isAbsolute(o.directory) || path.win32.isAbsolute(o.directory)) ? o.directory : null;
          if (!directory) issue('artifact_directory_missing_malformed_or_oversize');
          return { operationId, source: 'process_operations', phase, launch: phase === 'target' ? 'target_grant_consumed_spawn_unconfirmed' :
            phase === 'supervisor' ? 'supervisor_grant_consumed_target_unconfirmed' : phase === 'registered' ? 'registered_launch_unconfirmed' : 'unknown',
          liveness: 'unknown', reservation: { jobId, linkage }, requestDigest: digest(o.request_digest),
          terminal: validTerminal ? { evidence: 'recorded', kind: receipt.kind, exitCode: receipt.exitCode, endedAt: receipt.endedAt,
            receiptDigest: receipt.receiptDigest, immutableGuard: immutableGuard ? 'recognized' : 'unrecognized', artifactVerified: false } :
            { evidence: o.terminal_oversize ? 'oversize' : o.terminal === null ? 'missing' : 'malformed', outcome: 'unknown' },
          artifacts: { operationId, directoryDigest: directory ? hash(directory) : null, presence: 'not_checked',
            slots: ['request.json', 'receipt.json', 'active.json', 'stdout.log', 'stderr.log'] } };
        }) ?? null;
        const outcome = parse(s.outcome);
        const closure = s.closed_at === null && s.outcome === null && !s.outcome_oversize && !s.closed_at_oversize ? 'open' : timestamp(s.closed_at) && outcome?.version === 1 && digest(outcome.stateDigest) ? 'recorded_closed' : 'unknown';
        if (closure === 'unknown') issue('malformed_scope_outcome');
        const allTerminal = projectedOperations?.length > 0 && projectedOperations.every(o => o.terminal.evidence === 'recorded');
        const explanation = closure === 'recorded_closed' ? 'producer_outcome_recorded' : closure === 'unknown' ? 'scope_outcome_unknown' :
          allTerminal ? 'terminal_records_present_scope_outcome_unprojected' : projectedOperations?.length ? 'operation_outcome_unknown_scope_open' : 'scope_open_no_operation_evidence';
        scopes.push({ scopeId, projectId, lane: scopeLane, source: 'producer_scopes', createdAt: timestamp(s.created_at), closure,
          closedAt: timestamp(s.closed_at), outcomeStateDigest: closure === 'recorded_closed' ? outcome.stateDigest : null,
          explanation, replacementFence: closure === 'open' ? 'retained' : 'not_assessed',
          resources: resources?.map(r => { if (!digest(r.resource)) issue('malformed_resource_identity'); return { resourceId: digest(r.resource), source: 'producer_resources' }; }) ?? null,
          reservations, operations: projectedOperations });
      }
    }
    if (state?.processProtocol !== 1) issue('legacy_or_unknown_process_protocol');
    const durableStatus = status(state?.status);
    return { type: 'squire.producer-inspection', version: 1, projectId: id,
      evidence: issues.size ? 'partial' : 'complete_for_selected_records', issues: [...issues].sort(),
      snapshot: { ...capture, eventHighWater: highWater, eventHistory: 'not_replayed' },
      durableStatus, updatedAt: timestamp(state?.updatedAt),
      controllerLiveness: 'unknown', usefulProgress: 'not_assessed', holds, scopes,
      selection: 'open_project_scopes_and_snapshot_hold_references',
      summary: scopes.length ? 'Producer records explain retained fences; no settlement or restart authority is inferred.' :
        'No selected scope records; this does not establish idle, stopped or settled work.',
      limits };
  });
}
