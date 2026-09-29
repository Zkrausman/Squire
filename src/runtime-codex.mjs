import path from 'node:path';
import os from 'node:os';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { Blocker, VERSION, planSchema, reviewSchema } from './contracts.mjs';
import { runProcess } from './process.mjs';
import { readCatalog } from './codex-catalog.mjs';

export const subscriptionEnvironment = () => ({ OPENAI_API_KEY: null, CODEX_API_KEY: null, CODEX_ACCESS_TOKEN: null, GH_TOKEN: null, GITHUB_TOKEN: null });
const authArgs = ['-c', 'forced_login_method="chatgpt"'];

export class CodexRuntime {
  version = VERSION;
  capabilities = { roles: ['plan', 'implement', 'review'], freshSession: true, artifacts: 'workspace', resume: false, subscription: true };
  constructor(config, root) { this.config = config; this.root = root; }
  async settings() {
    // Carry only the owner's model preference into a clean job configuration;
    // unrelated MCP servers, hooks and plugins must not enter delivery jobs.
    const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8').catch(() => '');
    const preferred = this.config.model ?? /^model\s*=\s*"([\w.-]+)"\s*$/m.exec(content)?.[1];
    const available = this.catalog.models;
    const selected = available.find(m => m.model === preferred) ?? (this.config.model ? null : available.find(m => m.isDefault) ?? available[0]);
    if (!selected) throw new Blocker('runtime_model', 'Pinned project model is unavailable for this Codex subscription', { requested: preferred, available: available.map(m => m.model) });
    const requestedEffort = this.config.reasoning ?? /^model_reasoning_effort\s*=\s*"(low|medium|high|xhigh)"\s*$/m.exec(content)?.[1];
    if (this.config.reasoning && selected.supportedReasoningEfforts?.length && !selected.supportedReasoningEfforts.includes(this.config.reasoning)) throw new Blocker('runtime_model', 'Pinned reasoning effort is unsupported by selected model');
    const reasoning = selected.supportedReasoningEfforts?.includes(requestedEffort) ? requestedEffort : selected.defaultReasoningEffort;
    return { model: selected.model, reasoning, inheritedPreferenceUnavailable: preferred !== undefined && selected.model !== preferred };
  }
  async command() {
    if (this.config.command) return this.config.command;
    const adjacent = path.join(path.dirname(process.execPath), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    try { await access(adjacent); return [process.execPath, adjacent]; } catch {}
    if (process.platform === 'win32') throw new Blocker('runtime_unavailable', 'Install Codex CLI beside Node or configure runtime.command with a native executable/Node CLI entrypoint.');
    return ['codex'];
  }
  async preflight(signal) {
    const command = await this.command();
    const result = await runProcess({ argv: [...command, ...authArgs, 'login', 'status'], cwd: this.root, directory: path.join(this.root, 'auth-checks'), timeoutSeconds: 30, env: subscriptionEnvironment(), signal });
    if (result.exitCode !== 0 || !/logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`)) throw new Blocker('authentication', 'Codex must be signed in with ChatGPT subscription. Run codex login; API-key fallback is disabled.');
    this.catalog ??= await readCatalog(command, this.root, signal);
    if (this.catalog.authentication !== 'chatgpt' || !this.catalog.models?.length) throw new Blocker('runtime_catalog', 'Subscription model catalog unavailable');
    return { authentication: 'chatgpt', command, ...await this.settings() };
  }
  async execute(job) {
    await this.preflight(job.signal);
    await mkdir(job.directory, { recursive: true, mode: 0o700 });
    const output = path.join(job.directory, 'result.txt');
    const argv = [...await this.command(), ...authArgs, 'exec', '--ignore-user-config', '--json', '--ephemeral', '--color', 'never', '-C', job.workspace,
      '--sandbox', job.role === 'implement' ? 'workspace-write' : 'read-only', '-c', 'approval_policy="never"', '-o', output];
    if (process.platform === 'win32') argv.push('-c', 'windows.sandbox="elevated"');
    const settings = await this.settings();
    if (settings.model) argv.push('-m', settings.model);
    if (settings.reasoning) argv.push('-c', `model_reasoning_effort="${settings.reasoning}"`);
    if (job.role !== 'implement') {
      const schema = path.join(job.directory, 'schema.json');
      await writeFile(schema, JSON.stringify(job.role === 'plan' ? planSchema : reviewSchema), { mode: 0o600 });
      argv.push('--output-schema', schema);
    }
    argv.push('-');
    await writeFile(path.join(job.directory, 'prompt.txt'), job.instructions, { mode: 0o600 });
    let sessionRef, usage, completed = false, errorMessage = '';
    const receipt = await runProcess({ argv, cwd: job.workspace, directory: job.directory, timeoutSeconds: job.timeoutSeconds, input: job.instructions,
      env: subscriptionEnvironment(), signal: job.signal, onLine: line => {
        let event; try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'thread.started') sessionRef = event.thread_id;
        if (event.type === 'turn.completed') { completed = true; usage = event.usage; }
        if (event.type === 'turn.failed' || event.type === 'error') errorMessage += ` ${event.error?.message ?? event.message ?? JSON.stringify(event.error ?? '')}`;
        job.onEvent?.({ version: VERSION, jobId: job.id, type: event.type, sessionRef, usage });
      } });
    const failure = `${errorMessage}\n${receipt.stderr}`;
    if (!completed || receipt.exitCode !== 0 || receipt.stopped || receipt.outputExceeded) {
      if (/usage limit|rate.?limit|quota exceeded|too many requests|429/i.test(failure)) return { outcome: 'waiting_capacity', sessionRef, usage, receipt, retryAt: Date.now() + job.backoffSeconds * 1000, detail: failure.slice(-2000) };
      if (/authentication|unauthorized|please log in|401|token expired/i.test(failure)) throw new Blocker('authentication', 'Codex subscription sign-in requires attention', { receipt: { ...receipt, stdout: undefined, stderr: undefined } });
      throw new Blocker('runtime_failed', 'Codex job did not complete successfully', { receipt: { ...receipt, stdout: undefined, stderr: undefined }, detail: failure.slice(-2000) });
    }
    const text = await readFile(output, 'utf8').catch(() => '');
    if (!text.trim() || text.length > 128 * 1024 || !sessionRef) throw new Blocker('runtime_result', 'Codex completion lacks a bounded result/session identity');
    let result = text;
    if (job.role !== 'implement') { try { result = JSON.parse(text); } catch { throw new Blocker('runtime_result', 'Structured agent result is not JSON'); } }
    return { outcome: 'completed', sessionRef, usage, result, receipt: { ...receipt, stdout: undefined, stderr: undefined } };
  }
}
