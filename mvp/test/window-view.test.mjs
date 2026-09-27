import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDashboard, REPORT_STALE_MS, restoreSelection } from '../window-view.mjs';

const now = 2_000_000;
const first = 'squire-1790368585736-119d4f40d2';
const second = 'squire-1790368206187-0234ba2f1c';

function row(runId, overrides = {}) {
  return {
    runId, ticketId:'AIDEV-339', ticketName:'Focused dashboard', phase:'implement',
    processStartMs:1_000_000, updatedAtMs:now, report:null, reportUnavailable:false,
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    phase:'implement', status:'complete', number:1, finishedAtMs:now - 10_000,
    currentAction:'Reading focused dashboard tests', evidence:['A bounded report was provided'],
    risks:[], stalls:[], confidence:'medium', ...overrides,
  };
}

test('projects zero, one, and two active runs without combining concurrent same-ticket runs', () => {
  assert.deepEqual(projectDashboard([], now), {rows:[],invalidRows:0});
  const oneRun = projectDashboard([row(first)], now);
  assert.equal(oneRun.rows.length,1);
  assert.equal(oneRun.rows[0].runId,first);
  const twoRuns = projectDashboard([row(first),row(second,{ticketName:'Another same-ticket run'})],now);
  assert.equal(twoRuns.rows.length,2);
  assert.deepEqual(twoRuns.rows.map(item=>item.runId),[first,second]);
  assert.deepEqual(twoRuns.rows.map(item=>item.ticketId),['AIDEV-339','AIDEV-339']);
});

test('missing, malformed, unavailable, future, and stale reports are not presented as fresh work', () => {
  const missing = projectDashboard([row(first)],now).rows[0];
  assert.equal(missing.reportState,'not-reported');
  assert.equal(missing.report,null);

  const malformed = projectDashboard([row(first,{report:{currentAction:'unsafe partial report'}})],now).rows[0];
  assert.equal(malformed.reportState,'unavailable');
  assert.equal(malformed.report,null);

  const backendUnavailable = projectDashboard([row(first,{reportUnavailable:true})],now).rows[0];
  assert.equal(backendUnavailable.reportState,'unavailable');

  const unavailable = projectDashboard([row(first,{report:report({status:'unavailable'})})],now).rows[0];
  assert.equal(unavailable.reportState,'unavailable');
  assert.equal(unavailable.report,null);

  const future = projectDashboard([row(first,{report:report({finishedAtMs:now + 10_000})})],now).rows[0];
  assert.equal(future.reportState,'unavailable');

  const stale = projectDashboard([row(first,{report:report({finishedAtMs:now - REPORT_STALE_MS - 1})})],now).rows[0];
  assert.equal(stale.reportState,'stale');
  assert.equal(stale.report.ageMs,REPORT_STALE_MS + 1);
  assert.equal(stale.report.currentAction,'Reading focused dashboard tests');
});

test('validates runner timestamps and drops malformed rows rather than rendering them', () => {
  const result = projectDashboard([
    row(first),
    row(first,{ticketName:'Duplicate run ID'}),
    row(second,{processStartMs:0}),
    row('not-a-run-id'),
  ],now);
  assert.equal(result.rows.length,1);
  assert.equal(result.invalidRows,3);
  assert.throws(()=>projectDashboard({rows:[]},now),/Invalid status snapshot/);
});

test('runner heartbeat and actual process start are explicit and age-qualified', () => {
  const fresh = projectDashboard([row(first)],now).rows[0];
  assert.equal(fresh.processStartMs,1_000_000);
  assert.equal(fresh.heartbeatState,'available');
  const stale = projectDashboard([row(first,{updatedAtMs:now - 20_000})],now).rows[0];
  assert.equal(stale.heartbeatState,'stale');
  const future = projectDashboard([row(first,{updatedAtMs:now + 10_000})],now).rows[0];
  assert.equal(future.heartbeatState,'unavailable');
});

test('selected run is restored only while active, with deterministic safe fallback', () => {
  const rows = projectDashboard([row(first),row(second)],now).rows;
  assert.equal(restoreSelection(rows,second),second);
  assert.equal(restoreSelection(rows,'invalid'),first);
  assert.equal(restoreSelection(rows,'squire-1790368585736-0000000000'),first);
  assert.equal(restoreSelection([],second),null);
});
