import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProcess } from './process.mjs';
import { Blocker, digest } from './contracts.mjs';
import { createDiagnosticFeedbackV1 } from './verification-feedback.mjs';

const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const hash = value => digest(value);

export class VerificationRunner {
  constructor(root, { processRunner = runProcess } = {}) { this.root = root; this.processRunner = processRunner; }
  async #run(workspace, checks, label, signal, retainEvidence, binding = null) {
    const results = [];
    const feedbackResults = binding ? [] : null;
    const notRun = [];
    const evidenceChecks = [];
    let evidenceBytes = 0, evidenceLimited = false;
    for (const check of checks) {
      const result = await this.processRunner({ argv: check.argv, cwd: workspace, directory: path.join(this.root, 'checks', label, check.name), timeoutSeconds: check.timeoutSeconds, signal,
        // Credentials used by the controller/runtime never reach test processes.
        env: { OPENAI_API_KEY: null, CODEX_API_KEY: null, CODEX_ACCESS_TOKEN: null, GH_TOKEN: null, GITHUB_TOKEN: null } });
      const passed = result.exitCode === 0 && !result.stopped && !result.timedOut && !result.outputExceeded && !result.launchError;
      if (feedbackResults) {
        if (passed) feedbackResults.push({ name: check.name, passed });
        else {
          const disclosure = check.diagnosticDisclosureV1;
          const includeStdout = disclosure?.version === 1 && disclosure.stdout === 'approved';
          const includeStderr = disclosure?.version === 1 && disclosure.stderr === 'approved';
          feedbackResults.push({ name: check.name, passed, exitCode: result.exitCode, stopped: result.stopped,
            timedOut: result.timedOut, outputExceeded: result.outputExceeded, launchError: result.launchError,
            ...(includeStdout ? { stdout: result.stdout } : {}), ...(includeStderr ? { stderr: result.stderr } : {}) });
        }
      }
      results.push({ name: check.name, passed, ...result, stdout: undefined, stderr: undefined, failureTail: passed ? undefined : `${result.stdout}\n${result.stderr}`.slice(-6000) });
      if (retainEvidence) {
        const stdout = typeof result.stdout === 'string' ? result.stdout : '';
        const stderr = typeof result.stderr === 'string' ? result.stderr : '';
        const stdoutBytes = Buffer.byteLength(stdout), stderrBytes = Buffer.byteLength(stderr);
        const fits = !evidenceLimited && evidenceBytes + stdoutBytes + stderrBytes <= MAX_EVIDENCE_BYTES;
        if (fits) evidenceBytes += stdoutBytes + stderrBytes;
        else evidenceLimited = true;
        evidenceChecks.push({
          index: evidenceChecks.length, name: check.name, definitionSha256: hash(check),
          state: passed ? 'passed' : 'failed', operationId: result.operationId ?? null,
          argvSha256: Array.isArray(result.argv) ? hash(result.argv) : null,
          startedAt: Number.isSafeInteger(result.startedAt) ? result.startedAt : null,
          endedAt: Number.isSafeInteger(result.endedAt) ? result.endedAt : null,
          exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
          stopped: result.stopped === true, timedOut: result.timedOut === true,
          outputExceeded: result.outputExceeded === true, launchError: Boolean(result.launchError),
          output: fits ? { state: 'retained', stdout, stderr } : { state: 'omitted_run_limit', stdoutBytes, stderrBytes }
        });
      }
      if (!passed) {
        notRun.push(...checks.slice(results.length).map(({ name }) => ({ name, status: 'NOTRUN' })));
        break;
      }
    }
    const passed = results.length === checks.length && results.every(r => r.passed);
    if (retainEvidence) {
      for (let index = evidenceChecks.length; index < checks.length; index++) {
        evidenceChecks.push({ index, name: checks[index].name, definitionSha256: hash(checks[index]), state: 'not_run', operationId: null,
          argvSha256: null, startedAt: null, endedAt: null, exitCode: null, stopped: false, timedOut: false,
          outputExceeded: false, launchError: false, output: { state: 'not_run' } });
      }
    }
    const normalized = { passed, results, notRun };
    if (!passed && feedbackResults) normalized.diagnosticFeedbackV1 = createDiagnosticFeedbackV1(checks, feedbackResults, binding);
    return { result: normalized, evidenceChecks };
  }
  async run(workspace, checks, label, signal) {
    return (await this.#run(workspace, checks, label, signal, false)).result;
  }
  async runForCandidate(workspace, checks, label, signal, binding) {
    const { result, evidenceChecks } = await this.#run(workspace, checks, label, signal, true, binding);
    return { ...result, evidenceDraft: { version: 1, id: randomUUID(), policyDigest: hash(checks), passed: result.passed, binding, checks: evidenceChecks } };
  }
  async setup(workspace, commands, label, signal) {
    const result = await this.run(workspace, commands ?? [], `setup-${label}`, signal);
    if (!result.passed) throw new Blocker('setup_failed', 'Trusted setup command failed', result);
    return result;
  }
}
