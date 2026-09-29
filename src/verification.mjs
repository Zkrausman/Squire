import path from 'node:path';
import { runProcess } from './process.mjs';
import { Blocker } from './contracts.mjs';

export class VerificationRunner {
  constructor(root) { this.root = root; }
  async run(workspace, checks, label, signal) {
    const results = [];
    for (const check of checks) {
      const result = await runProcess({ argv: check.argv, cwd: workspace, directory: path.join(this.root, 'checks', label, check.name), timeoutSeconds: check.timeoutSeconds, signal,
        // Credentials used by the controller/runtime never reach test processes.
        env: { OPENAI_API_KEY: null, CODEX_API_KEY: null, CODEX_ACCESS_TOKEN: null, GH_TOKEN: null, GITHUB_TOKEN: null } });
      const passed = result.exitCode === 0 && !result.stopped && !result.timedOut && !result.outputExceeded && !result.launchError;
      results.push({ name: check.name, passed, ...result, stdout: undefined, stderr: undefined, failureTail: passed ? undefined : `${result.stdout}\n${result.stderr}`.slice(-6000) });
      if (!passed) break;
    }
    return { passed: results.length === checks.length && results.every(r => r.passed), results };
  }
  async setup(workspace, commands, label, signal) {
    const result = await this.run(workspace, commands ?? [], `setup-${label}`, signal);
    if (!result.passed) throw new Blocker('setup_failed', 'Trusted setup command failed', result);
    return result;
  }
}
