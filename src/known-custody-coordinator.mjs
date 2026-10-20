import {closed, fail} from './job-spec.mjs';
import {createManagerObservationBridge} from './manager-observation-bridge.mjs';
import {createManagerDeadlineDriver} from './manager-deadline-driver.mjs';

// Source-only composition AFTER custody acknowledgement. Never creates a session,
// calls start(), adopts a startup operation, emits a JobRecord or polls a source.
export function createKnownCustodyCoordinator(options) {
  closed(options, ['session', 'source', 'clock', 'read_timeout_ms'], [], 'known_custody_coordinator');
  const {session, source, clock, read_timeout_ms} = options;
  const bridge = createManagerObservationBridge({session, source, clock, read_timeout_ms});
  const driver = createManagerDeadlineDriver({session, clock});
  const snapshot = session.snapshot.bind(session), abortSession = session.abort.bind(session);
  let delivered = null, finishing = false, pendingRead = null, nextRead = 0;
  let complete;
  const result = new Promise(resolve => {complete = resolve;});
  function finish(response) {
    if (delivered || finishing) return;
    finishing = true;
    bridge.close(); // Stops only observation, never uses bridge.abort() for disposal.
    const state = snapshot();
    // Observer cancellation may itself reveal uncertainty or latch cancellation.
    const status = state.local_workspace_released ? 'RELEASED' :
      state.admission_quarantined || !state.custody_acknowledged ? 'FENCED' :
        state.canceled ? state.cancellation_reason === 'timeout' ? 'DEADLINE' : 'CANCELED' : response.status;
    delivered = Object.freeze({status, state, runtime_qualification: 'NOT_ESTABLISHED_BY_SOURCE'});
    finishing = false; complete(delivered);
  }
  // Driver reports only local response decisions; none is terminal job settlement.
  driver.result.then(finish);
  return Object.freeze({result, snapshot,
    readNext() {
      if (delivered || finishing) fail('coordinator_read', 'coordinator_returned');
      if (pendingRead !== null) fail('coordinator_read', 'observation_read_in_progress');
      const current = driver.reconcile();
      if (current) {finish(current); fail('coordinator_read', 'coordinator_returned');}
      const id = ++nextRead;
      pendingRead = id;
      try {
        return bridge.readNext().then(response => {
          if (pendingRead === id) pendingRead = null;
          const ending = driver.reconcile(); if (ending) finish(ending);
          return response;
        }, () => {
          if (pendingRead === id) pendingRead = null;
          // Bridge already consumes producer rejection. Unexpected composition
          // failure is local observation uncertainty, not a user cancellation.
          session.observationFailed();
          const ending = driver.reconcile(); if (ending) finish(ending);
          return Object.freeze({status: 'READ_FAILED', state: snapshot(), runtime_qualification: 'NOT_ESTABLISHED_BY_SOURCE'});
        });
      } catch (error) {pendingRead = null; throw error;}
    },
    abort() {
      if (!delivered) {
        abortSession(); // Preserve intent even if the driver committed before its Promise callback.
        // reconcile returns only a completed driver response, never abort()'s
        // provisional fallback during reentrant timer finalization.
        const response = driver.reconcile(); if (response) finish(response);
      }
      return delivered;
    },
    reconcile() {
      if (delivered) return delivered;
      const response = driver.reconcile(); if (response) finish(response);
      return delivered;
    }
  });
}
