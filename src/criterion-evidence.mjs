import path from 'node:path';
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Blocker, digest } from './contracts.mjs';
import { inspectChecks } from './inspect-checks.mjs';

const blocked = (code, message) => new Blocker(code, message);
const statKey = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(':');
const outside = (file, root) => file !== root && !file.startsWith(`${root}${path.sep}`);
function executionFor(ticket) {
  return ticket.correctionAdmission ? { ...ticket.spec.execution,
    checklist: [...ticket.spec.execution.checklist, ...ticket.correctionAdmission.checklist] } : ticket.spec.execution;
}
async function trustedBytes(file) {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 1024n * 1024n) throw Error('unsafe trusted file');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (statKey(await handle.stat({ bigint: true })) !== statKey(before)) throw Error('changed trusted file');
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw Error('short trusted file'); offset += bytesRead;
    }
    if (statKey(await handle.stat({ bigint: true })) !== statKey(before) || statKey(await lstat(file, { bigint: true })) !== statKey(before)) throw Error('changed trusted file');
    return bytes;
  } finally { await handle.close(); }
}

// These are owner-frozen check definitions, not a claim of hostile-code
// isolation or check quality. Candidate-controlled test scripts are ineligible.
export async function assertCriterionDefinitions(execution, service, projectRoot) {
  if (execution?.version !== 2) return;
  if (execution.checklist.some(item => item.evidenceKinds.length !== 1 || item.evidenceKinds[0] !== 'configured-check'))
    throw blocked('criterion_kind_unsupported', 'Required evidence kind has no compatible producer; commands and mocks cannot substitute');
  const root = await realpath(projectRoot).catch(() => path.resolve(projectRoot));
  for (const owner of execution.checkOwnership) {
    const check = service.checks.find(item => item.name === owner.check);
    if (!check || !['node', process.execPath].includes(check.argv[0])) throw blocked('criterion_oracle_unavailable', 'A frozen trusted Node check definition is required');
    if (owner.kind === 'trusted-inline-node') {
      const args = check.argv.slice(1);
      const inline = args.length === 2 && args[0] === '-e' || args.length === 3 && args[0] === '--input-type=module' && args[1] === '-e';
      if (!inline || owner.sha256 !== digest(check)) throw blocked('criterion_oracle_changed', 'Inline check definition differs from frozen owner policy');
    } else {
      try {
        const file = await realpath(owner.path);
        if (file !== path.resolve(owner.path) || !outside(file, root) || check.argv.length !== 2 || !path.isAbsolute(check.argv[1]) || path.resolve(check.argv[1]) !== file)
          throw Error('candidate-controlled or aliased check definition');
        if (createHash('sha256').update(await trustedBytes(file)).digest('hex') !== owner.sha256) throw Error('changed check definition');
      } catch (error) {
        if (['EACCES', 'EPERM'].includes(error.code)) throw blocked('criterion_oracle_denied', 'Trusted check definition read was denied; no weaker route is used');
        throw blocked('criterion_oracle_changed', 'Trusted check file must remain outside the managed project root at its frozen bytes');
      }
    }
  }
}

export async function resolveCriterionEvidence(store, projectId, ticketId, phase = 'candidate-verification') {
  const state = store.get(projectId), ticket = state.tickets.find(t => t.spec.id === ticketId);
  if (ticket?.spec.execution?.version !== 2) return null;
  const root = path.join(store.directory, 'projects', projectId), service = state.config.services[ticket.spec.service];
  const execution = executionFor(ticket);
  await assertCriterionDefinitions(execution, service, root);
  let report;
  try { report = inspectChecks({ id: projectId, stateDir: store.directory, ticketId, phase }); }
  catch { throw blocked('criterion_evidence_incomplete', 'Required immutable observations are missing, altered or incompatible'); }
  const selected = phase === 'postmerge-verification' ? ticket.postmerge : ticket.verification;
  const correction = ticket.correctionAdmission ? { admissionId: ticket.correctionAdmission.admissionId, digest: digest({ outcome: ticket.correctionAdmission.outcome, instructions: ticket.correctionAdmission.instructions, checklist: ticket.correctionAdmission.checklist }) } : null;
  if (report.binding !== 'candidate_contract_policy_bound' || report.artifactIntegrity !== 'verified' ||
      report.referenceId !== selected?.checkEvidence?.reference?.id || report.identity?.headSha !== selected?.headSha ||
      report.identity?.treeSha !== ticket.treeSha || report.identity?.contractDigest !== digest(ticket.spec.execution) ||
      report.identity?.policyDigest !== digest(service.checks) || JSON.stringify(report.identity?.correctionAdmission) !== JSON.stringify(correction) ||
      report.issues.some(issue => !['candidate_checkpoint_stale', 'candidate_checkpoint_unresolved'].includes(issue)))
    throw blocked('criterion_evidence_incomplete', 'Current candidate/contract/policy/producer-bound observations are required');
  const criteria = execution.checklist.map(item => {
    const observations = item.checks.map(name => {
      const check = report.checks.find(row => row.name === name);
      if (!check || check.state !== 'passed' || check.outputState !== 'retained' || !check.operationId)
        throw blocked('criterion_evidence_incomplete', 'Failed, not-run, missing or incomplete evidence cannot satisfy a criterion');
      return `${report.referenceId}:${check.index}`;
    });
    return { id: item.id, kind: 'configured-check', checks: item.checks, observationIds: observations };
  });
  // A journal cross-link is a separate diagnostic. Current command identities,
  // bytes and process links are independently verified; no old row is adopted.
  return { version: 2, phase, headSha: selected.headSha, treeSha: selected.treeSha,
    contractDigest: report.identity.contractDigest, correctionAdmission: report.identity.correctionAdmission,
    policyDigest: report.identity.policyDigest, reference: selected.checkEvidence.reference, criteria,
    checkpointLink: report.checkpointLink, limitations: ['trusted owner-host checks; no hostile-code isolation or process-tree settlement', 'configured-command proof does not establish browser/native or human acceptance'] };
}
