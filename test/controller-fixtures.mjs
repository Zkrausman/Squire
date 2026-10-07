import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Controller } from '../src/controller.mjs';
import { digest } from '../src/contracts.mjs';
import { checkpointFixtureCandidate, fixture, ticket, FixtureRuntime, statusUntil } from './support.mjs';

const correctiveExecution = {
  version: 1, outcome: 'Add the feature with stable numeric behavior.', ownedPaths: ['feature-a.mjs'], contextPaths: [],
  invariants: ['Keep the exported add function stable.'],
  checklist: [
    { id: 'base-one', assertion: 'Addition works.', steps: ['Run the behavior check.'], evidence: 'Passing assertion.' },
    { id: 'base-two', assertion: 'Negative values work.', steps: ['Run with a negative value.'], evidence: 'Observed expected value.' }
  ],
  stopWhen: 'Stop if the feature cannot be verified.', maxAttempts: 1
};
const correctiveTicket = () => ({ ...ticket('a'), execution: structuredClone(correctiveExecution) });
const correctiveAdmission = headSha => ({
  ticketId: 'a', expectedHeadSha: headSha, outcome: 'Handle the reviewed boundary case.',
  instructions: 'Keep the change within feature-a.mjs and add the boundary regression.',
  checklist: [{ id: 'corrective-one', assertion: 'The boundary case works.', steps: ['Run the boundary regression.'], evidence: 'Observed expected output.' }]
});
const interruptedCorrectionReceipt = workspace => ({
  code: 'runtime_failed', role: 'implement', message: 'The corrective implementation timed out during final verification.',
  detail: { receipt: { argv: ['codex', 'exec', '--ignore-user-config', '--json', '--ephemeral', '-C', workspace, '--sandbox', 'workspace-write'],
    startedAt: 10, endedAt: 20, exitCode: null, stopped: false, timedOut: true, outputExceeded: false, launchError: null } }
});
const interruptedCorrectionRequest = ticketState => ({ ticketId: ticketState.spec.id, expectedWorkspace: ticketState.workspace,
  expectedBaseSha: ticketState.baseSha, expectedBeforeAgentHead: ticketState.beforeAgentHead, expectedHeadSha: ticketState.headSha,
  expectedTreeSha: ticketState.treeSha, expectedCorrectionAdmissionId: ticketState.correctionAdmission.admissionId,
  expectedCorrectionDigest: digest(ticketState.correctionAdmission), expectedBlockerDigest: digest(ticketState.blocker),
  expectedProcessReceiptDigest: digest(ticketState.blocker.detail.receipt) });
async function reserveHistoricalTicketJob(f, controller, ticketId = 'a') {
  const jobId = randomUUID(), lease = f.store.lease(`controller:${f.config.id}`);
  try {
    const scopeId = f.store.beginProducer(f.config.id, `ticket:${ticketId}`, lease, controller.producerResources(`ticket:${ticketId}`));
    f.store.reserveProducerCall(scopeId, jobId);
    f.store.update(f.config.id, () => {}, 'producer.completed', { scopeId, lane: `ticket:${ticketId}` }, scopeId);
    return jobId;
  } finally { lease(); }
}
async function prepareInterruptedCorrection(t, partialSource) {
  const f = await fixture(t, [correctiveTicket()], { limits: { maxRepairs: 0 } });
  const runtime = new FixtureRuntime(), controller = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, controller, 'prepared');
  const prepared = f.store.get(f.config.id).tickets[0];
  await writeFile(path.join(prepared.workspace, 'feature-a.mjs'), 'export const add=(a,b)=>a+b;\n// previous verified candidate\n');
  const prior = await checkpointFixtureCandidate(f, controller.workspace, { ...prepared, beforeAgentHead: prepared.baseSha }, f.config.services.app);
  await writeFile(path.join(prepared.workspace, 'feature-a.mjs'), partialSource);
  const priorImplementation = { sessionRef: 'prior-completed-implementation', jobId: 'prior-implementation-job' };
  f.store.update(f.config.id, state => {
    const ticket = state.tickets[0];
    Object.assign(ticket, {
      status: 'blocked', attempts: 2, repairs: 1, rebases: 0, reviewAttempts: 1,
      beforeAgentHead: prior.headSha, headSha: prior.headSha, treeSha: prior.treeSha,
      implementation: priorImplementation, implementationSessions: [priorImplementation.sessionRef, 'timed-out-correction-session'],
      correctionAdmission: { admissionId: 'correction-385', outcome: 'Complete the already admitted fix.',
        instructions: 'Keep changes within the original owned paths.', checklist: structuredClone(correctiveAdmission(prior.headSha).checklist),
        ceilings: { implementAttempts: 2, repairs: 1 }, evidence: { original: true } },
      interruptedContinuation: { continuationId: 'continuation-385', status: 'completed', logicalAttempt: 1 },
      partialRecovery: { recoveryId: 'partial-recovery-385', status: 'completed' },
      blocker: interruptedCorrectionReceipt(prepared.workspace),
      review: { headSha: prior.headSha, verdict: 'fail', summary: 'Prior review.', findings: [] },
      verification: { passed: false, headSha: prior.headSha, treeSha: prior.treeSha, policyDigest: digest(f.config.services.app.checks), results: [] }
    });
    state.agentCalls = 7;
  });
  f.store.pause(f.config.id);
  const before = f.store.get(f.config.id), ticketBefore = before.tickets[0];
  return { f, runtime, controller, prepared, before, ticketBefore, request: interruptedCorrectionRequest(ticketBefore) };
}

export { correctiveExecution, correctiveTicket, correctiveAdmission, reserveHistoricalTicketJob, prepareInterruptedCorrection };
