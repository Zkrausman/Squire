import path from 'node:path';
import os from 'node:os';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { Blocker, VERSION, planSchema, reviewSchema } from './contracts.mjs';
import { runProcess } from './process.mjs';
import { readCatalog } from './codex-catalog.mjs';

export const subscriptionEnvironment = () => ({ OPENAI_API_KEY: null, CODEX_API_KEY: null, CODEX_ACCESS_TOKEN: null, GH_TOKEN: null, GITHUB_TOKEN: null });
const authArgs = ['-c', 'forced_login_method="chatgpt"'];
const capacityText = /\b(?:usage\s+(?:limits?|capacity)|quotas?\s+(?:exceeded|reached|exhausted)|rate[- ]limits?(?:\s+(?:exceeded|reached))?|too many requests)\b/i;
const explicit429 = /\b(?:http(?:\/\d+(?:\.\d+)?)?\s+429|(?:http[_ -]?)?status(?:[_ -]?code)?(?:\s*[:=]\s*|\s+)429|response\s+status(?:\s+code)?\s*[:=]?\s*429)\b/i;
const statusKeys = new Set(['status', 'statuscode', 'status_code', 'httpstatus', 'http_status', 'code']);
function contains429Status(value) {
  if (Array.isArray(value)) return value.some(contains429Status);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    (statusKeys.has(key.toLowerCase()) && (child === 429 || child === '429')) || contains429Status(child));
}
function capacityFailure(events, stderr) {
  if (capacityText.test(stderr) || explicit429.test(stderr)) return true;
  return events.some(event => contains429Status(event.error) || capacityText.test(JSON.stringify(event.error ?? event.message ?? '')) ||
    explicit429.test(JSON.stringify(event.error ?? event.message ?? '')));
}

export class CodexRuntime {
  version = VERSION;
  capabilities = { roles: ['plan', 'implement', 'review'], freshSession: true, artifacts: 'workspace', resume: false, subscription: true };
  constructor(config, root) { this.config = config; this.root = root; }
  async settings(role) {
    // Carry only the owner's model preference into a clean job configuration;
    // unrelated MCP servers, hooks and plugins must not enter delivery jobs.
    const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const content = await readFile(path.join(codexHome, 'config.toml'), 'utf8').catch(() => '');
    const policy = { ...this.config, ...(this.config.roles?.[role] ?? {}) };
    const preferred = policy.model ?? /^model\s*=\s*"([\w.-]+)"\s*$/m.exec(content)?.[1];
    const available = this.catalog.models;
    const selected = available.find(m => m.model === preferred) ?? (policy.model ? null : available.find(m => m.isDefault) ?? available[0]);
    if (!selected) throw new Blocker('runtime_model', 'Pinned project model is unavailable for this Codex subscription', { requested: preferred, available: available.map(m => m.model) });
    const requestedEffort = policy.reasoning ?? /^model_reasoning_effort\s*=\s*"(low|medium|high|xhigh|max|ultra)"\s*$/m.exec(content)?.[1];
    if (policy.reasoning && selected.supportedReasoningEfforts?.length && !selected.supportedReasoningEfforts.includes(policy.reasoning)) throw new Blocker('runtime_model', 'Pinned reasoning effort is unsupported by selected model');
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
    const roles = {};
    for (const role of ['plan', 'implement', 'review']) roles[role] = await this.settings(role);
    return { authentication: 'chatgpt', command, ...await this.settings(), roles };
  }
  async execute(job) {
    const evidenceArtifacts = [];
    try { return { ...await this.executeJob(job, evidenceArtifacts), evidenceArtifacts }; }
    catch (error) { error.evidenceArtifacts = evidenceArtifacts; throw error; }
  }
  async executeJob(job, evidenceArtifacts) {
    await this.preflight(job.signal);
    await mkdir(job.directory, { recursive: true, mode: 0o700 });
    const output = path.join(job.directory, 'result.txt');
    const workerTemp = job.role === 'implement' ? path.join(job.directory, 'worker-temp') : null;
    if (workerTemp) await mkdir(workerTemp, { recursive: true, mode: 0o700 });
    const argv = [...await this.command(), ...authArgs, 'exec', '--ignore-user-config', '--json', '--ephemeral', '--color', 'never', '-C', job.workspace,
      '--sandbox', job.role === 'implement' ? 'workspace-write' : 'read-only', '-c', 'approval_policy="never"', '-o', output];
    if (workerTemp) argv.push('--add-dir', workerTemp);
    if (process.platform === 'win32') argv.push('-c', 'windows.sandbox="elevated"');
    const settings = await this.settings(job.role);
    if (settings.model) argv.push('-m', settings.model);
    if (settings.reasoning) argv.push('-c', `model_reasoning_effort="${settings.reasoning}"`);
    job.onEvent?.({ version: VERSION, jobId: job.id, type: 'runtime.configured', requestedModel: settings.model ?? null, requestedReasoning: settings.reasoning ?? null, reportedModel: null, reportedReasoning: null });
    if (job.role !== 'implement') {
      const schema = path.join(job.directory, 'schema.json');
      await writeFile(schema, JSON.stringify(job.role === 'plan' ? planSchema : reviewSchema), { mode: 0o600, flag: 'wx' });
      evidenceArtifacts.push('schema.json');
      argv.push('--output-schema', schema);
    }
    argv.push('-');
    // GUI acceptance belongs to the trusted controller host. Electron launches
    // inside Windows worker isolation can fail its runtime ACL checks and leave
    // native crash dialogs on the owner's desktop.
    const taskInstructions = workerTemp
      ? `${job.instructions}\n\nImplementation attempt semantics: One implementation attempt is this entire worker session, including reproducing defects, implementing the scoped changes, and fixing failing tests within that scope. A failing reproduction or intermediate test does not consume another attempt and does not mean stop before implementing. Unless the ticket explicitly asks for diagnosis only, continue within its ownership and acceptance until the requested change is implemented and verified, or a real dependency, scope boundary, or session limit prevents progress. Do not weaken acceptance to make tests pass. Controller repair/review budgets apply between completed sessions.\n\nImplementation test environment: Put temporary files created by tests under ${workerTemp}. Squire provides this task-owned directory as an additional writable location and sets TEMP, TMP, and TMPDIR to it. Run meaningful non-GUI tests using this directory instead of global system temp locations. Do not change filesystem ACLs or request broader writable access to make tests pass.\n`
      : job.instructions;
    const instructions = process.platform === 'win32'
      ? `${taskInstructions}\n\nWindows worker execution constraint: Do not launch electron.exe, Playwright _electron, or npm start for an Electron app inside this isolated worker. Prior launches failed runtime ACL checks and produced native crash dialogs. Implement and run non-GUI tests/builds here; report GUI validation as pending. Actual Electron/visual acceptance must run through the trusted owner-host controller or coordinator, with application sandboxing retained. Never change ACLs or disable sandboxing to work around this. This does not waive any GUI acceptance requirement.\n`
      : taskInstructions;
    await writeFile(path.join(job.directory, 'prompt.txt'), instructions, { mode: 0o600, flag: 'wx' });
    evidenceArtifacts.push('prompt.txt');
    // Reserve the CLI output path before launch; a reused artifact directory fails closed.
    await writeFile(output, '', { mode: 0o600, flag: 'wx' });
    evidenceArtifacts.push('result.txt');
    let sessionRef, usage, completed = false, errorMessage = '';
    const failureEvents = [];
    const env = workerTemp ? { ...subscriptionEnvironment(), TEMP: workerTemp, TMP: workerTemp, TMPDIR: workerTemp } : subscriptionEnvironment();
    const receipt = await runProcess({ argv, cwd: job.workspace, directory: job.directory, timeoutSeconds: job.timeoutSeconds, input: instructions,
      env, signal: job.signal, onLine: line => {
        let event; try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'thread.started') sessionRef = event.thread_id;
        if (event.type === 'turn.completed') { completed = true; usage = event.usage; }
        if (event.type === 'turn.failed' || event.type === 'error') {
          failureEvents.push(event);
          errorMessage += ` ${event.error?.message ?? event.message ?? JSON.stringify(event.error ?? '')}`;
        }
        job.onEvent?.({ version: VERSION, jobId: job.id, type: event.type, sessionRef, usage });
      } });
    const failure = `${errorMessage}\n${receipt.stderr}`;
    if (!completed || receipt.exitCode !== 0 || receipt.stopped || receipt.outputExceeded) {
      // A local timeout or cancellation is a failed job, even if incidental
      // output happens to contain capacity-like digits or messages.
      if (receipt.timedOut || receipt.stopped) throw new Blocker('runtime_failed', 'Codex job was stopped before it completed', { receipt: { ...receipt, stdout: undefined, stderr: undefined }, detail: failure.slice(-2000) });
      if (/invalid[^\n]*schema|schema[^\n]*required|invalid_json_schema/i.test(failure)) throw new Blocker('runtime_schema', 'Codex response schema was rejected before review; correct adapter infrastructure without repairing application source', { receipt: { ...receipt, stdout: undefined, stderr: undefined }, detail: failure.slice(-2000) });
      if (capacityFailure(failureEvents, receipt.stderr)) return { outcome: 'waiting_capacity', sessionRef, usage, receipt, retryAt: Date.now() + job.backoffSeconds * 1000, detail: failure.slice(-2000), requestedModel: settings.model ?? null, requestedReasoning: settings.reasoning ?? null, reportedModel: null, reportedReasoning: null };
      if (/authentication|unauthorized|please log in|401|token expired/i.test(failure)) throw new Blocker('authentication', 'Codex subscription sign-in requires attention', { receipt: { ...receipt, stdout: undefined, stderr: undefined } });
      throw new Blocker('runtime_failed', 'Codex job did not complete successfully', { receipt: { ...receipt, stdout: undefined, stderr: undefined }, detail: failure.slice(-2000) });
    }
    const text = await readFile(output, 'utf8').catch(() => '');
    if (!text.trim() || text.length > 128 * 1024 || !sessionRef) throw new Blocker('runtime_result', 'Codex completion lacks a bounded result/session identity', { receipt: { ...receipt, stdout: undefined, stderr: undefined } });
    let result = text;
    if (job.role !== 'implement') { try { result = JSON.parse(text); } catch { throw new Blocker('runtime_result', 'Structured agent result is not JSON', { receipt: { ...receipt, stdout: undefined, stderr: undefined } }); } }
    return { outcome: 'completed', sessionRef, usage, result, receipt: { ...receipt, stdout: undefined, stderr: undefined }, requestedModel: settings.model ?? null, requestedReasoning: settings.reasoning ?? null, reportedModel: null, reportedReasoning: null };
  }
}
