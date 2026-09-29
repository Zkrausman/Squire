// Subscription metadata only: no threads/turns are started by this helper.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Blocker } from './contracts.mjs';
import { runProcess } from './process.mjs';

export async function readCatalog(command, root, signal) {
  const receipt = await runProcess({ argv: [process.execPath, fileURLToPath(import.meta.url), '--read', JSON.stringify(command)], cwd: root,
    directory: `${root}/catalog`, timeoutSeconds: 30, signal,
    env: { OPENAI_API_KEY: null, CODEX_API_KEY: null, CODEX_ACCESS_TOKEN: null, GH_TOKEN: null, GITHUB_TOKEN: null } });
  if (receipt.exitCode !== 0 || receipt.stopped) throw new Blocker('runtime_catalog', 'Unable to query subscription account/model catalog', { stderr: receipt.stderr.slice(-2000) });
  try { return JSON.parse(receipt.stdout); } catch { throw new Blocker('runtime_catalog', 'Invalid subscription catalog response'); }
}

async function query(command) {
  const child = spawn(command[0], [...command.slice(1), '-c', 'forced_login_method="chatgpt"', 'app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map(); let id = 0;
  const lines = createInterface({ input: child.stdout });
  const fail = error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); };
  child.on('error', fail); child.on('close', () => fail(new Error('Codex catalog process closed')));
  child.stderr.on('data', () => {}); child.stdin.on('error', fail);
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message.id); if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Catalog request ${method} timed out`)); }, 10000);
    pending.set(requestId, { resolve, reject, timer }); child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
  });
  try {
    await request('initialize', { clientInfo: { name: 'squire', version: '0.3.0' }, capabilities: {} });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const account = await request('account/read', { refreshToken: false });
    if (account.account?.type !== 'chatgpt') throw new Error('Subscription authentication is required');
    const models = []; let cursor;
    do {
      const result = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data) || models.length > 200) throw new Error('Invalid model catalog');
      models.push(...result.data); cursor = result.nextCursor;
    } while (cursor);
    let rateLimits;
    try { rateLimits = await request('account/rateLimits/read', {}); } catch { /* Metadata is optional; actual quota failures remain authoritative. */ }
    return { authentication: 'chatgpt', planType: account.account.planType, models: models.filter(m => !m.hidden).map(m => ({ model: m.model ?? m.id, isDefault: m.isDefault === true,
      defaultReasoningEffort: m.defaultReasoningEffort, supportedReasoningEfforts: m.supportedReasoningEfforts?.map(r => r.reasoningEffort) })), rateLimits };
  } finally { child.stdin.end(); child.kill(); }
}
if (process.argv[2] === '--read') query(JSON.parse(process.argv[3])).then(result => { process.stdout.write(JSON.stringify(result)); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); });
