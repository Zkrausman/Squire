import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ownDir = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = /^squire-[0-9]{10,16}-[a-f0-9]{10}$/;
const TICKET_ID = /^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,8}$/;
const PHASES = new Set(['starting', 'preflight', 'clone', 'plan', 'implement', 'artifact']);
const HEARTBEAT_MS = 4_000;
const STALE_MS = 16_000;
const START_TOLERANCE_MS = 2;
const MAX_FILES = 128;
const MAX_RECORD_BYTES = 12_288;

function projectReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['plan', 'implement'].includes(value.phase)
    || !['complete', 'unavailable'].includes(value.status)
    || !Number.isSafeInteger(value.number) || value.number < 1
    || !Number.isSafeInteger(value.finishedAtMs) || value.finishedAtMs <= 0
    || value.finishedAtMs > 4_102_444_800_000) return null;
  const source = value.report === undefined ? value : value.report;
  const text = (item, max) => typeof item === 'string' && item.length > 0 && item.length <= max
    && !/[\u0000-\u001f\u007f-\u009f]/.test(item) ? item : null;
  const list = field => Array.isArray(source?.[field]) && source[field].length <= 4
    ? source[field].map(item => text(item, 200)) : null;
  const currentAction = text(source?.currentAction, 240);
  const evidence = list('evidence');
  const risks = list('risks');
  const stalls = list('stalls');
  if (!currentAction || !evidence || !risks || !stalls
    || evidence.includes(null) || risks.includes(null) || stalls.includes(null)
    || !['low', 'medium', 'high', 'unknown'].includes(source.confidence)) return null;
  return { phase: value.phase, status: value.status, number: value.number,
    finishedAtMs: value.finishedAtMs, currentAction, evidence, risks, stalls,
    confidence: source.confidence };
}

export function validateWindowConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['ticketId', 'ticketName'].includes(key))
    || !TICKET_ID.test(value.ticketId)
    || typeof value.ticketName !== 'string' || !value.ticketName.trim()
    || value.ticketName.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(value.ticketName)) {
    throw new Error('window requires a bounded ticketId and ticketName');
  }
  return { ticketId: value.ticketId, ticketName: value.ticketName.trim() };
}

export function defaultWindowRoot() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Squire', 'active-window-v1');
}

function filename(root, runId) {
  if (!RUN_ID.test(runId)) throw new Error('Invalid run ID');
  return path.join(root, `${runId}.json`);
}

export class WindowPresence {
  constructor({ root, runId, ticketId, ticketName, phase }) {
    this.root = root;
    this.file = filename(root, runId);
    this.record = { version: 1, runId, ticketId, ticketName, pid: process.pid,
      processStartMs: Math.round(Date.now() - process.uptime() * 1000), phase, updatedAtMs: 0, report: null };
    this.timer = null;
    this.pending = Promise.resolve();
    this.stopped = false;
  }

  async write() {
    if (this.stopped) return;
    this.record.updatedAtMs = Date.now();
    if (Buffer.byteLength(JSON.stringify(this.record), 'utf8') > MAX_RECORD_BYTES) this.record.report = null;
    const temporary = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(this.record)}\n`, { flag: 'wx', mode: 0o600 });
      // Windows readers can briefly hold the destination open. Retry a bounded number of times.
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, this.file); break; }
        catch (error) {
          if (attempt === 2 || !['EPERM', 'EACCES'].includes(error.code)) throw error;
          await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
        }
      }
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  queue(phase) {
    if (this.stopped) return this.pending;
    if (phase && phase !== this.record.phase) {
      this.record.phase = phase;
      this.record.report = null;
    }
    this.pending = this.pending.catch(() => {}).then(() => this.write());
    return this.pending;
  }

  setReport(value) {
    if (this.stopped || value.phase !== this.record.phase) return this.pending;
    const report = projectReport(value);
    if (!report) return this.pending;
    this.record.report = report;
    return this.queue();
  }

  async start() {
    const starts = await windowsProcessStarts([process.pid]);
    if (!starts.has(process.pid)) throw new Error('Cannot confirm runner process identity');
    this.record.processStartMs = starts.get(process.pid);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.queue();
    this.timer = setInterval(() => { void this.queue().catch(() => {}); }, HEARTBEAT_MS);
    this.timer.unref();
    try {
      const child = spawn(process.execPath, [path.join(ownDir, 'window-web.mjs'), '--serve', this.root],
        { stdio: 'ignore', detached: true, windowsHide: true });
      child.on('error', () => {}); // The display is optional; no effect on the primary run.
      child.unref();
    } catch { /* Display launch is best-effort. */ }
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending.catch(() => {});
    await rm(this.file, { force: true }).catch(() => {});
  }
}

export async function readWindowRecords(root) {
  let names;
  try { names = await readdir(root); } catch { return []; }
  const records = [];
  for (const name of names.filter(name => RUN_ID.test(name.slice(0, -5)) && name.endsWith('.json'))
    .sort().reverse()) {
    try {
      const file = path.join(root, name);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) continue;
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (value.runId !== name.slice(0, -5) || value.version !== 1 || !RUN_ID.test(value.runId)
        || !PHASES.has(value.phase) || !TICKET_ID.test(value.ticketId)
        || typeof value.ticketName !== 'string' || !value.ticketName.trim()
        || value.ticketName.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(value.ticketName)
        || !Number.isSafeInteger(value.pid) || value.pid <= 0
        || !Number.isSafeInteger(value.processStartMs) || !Number.isSafeInteger(value.updatedAtMs)) continue;
      value.report = value.report === null ? null : projectReport(value.report);
      if (value.report?.phase !== value.phase) value.report = null;
      records.push(value);
    } catch { /* Ignore malformed or racing records. */ }
  }
  return records;
}

export function selectActive(records, starts, now = Date.now()) {
  const rows = [];
  const seen = new Set();
  for (const record of records) {
    const actualStart = starts.get(record.pid);
    if (!Number.isFinite(actualStart) || Math.abs(actualStart - record.processStartMs) > START_TOLERANCE_MS
      || record.updatedAtMs > now + 2_000 || now - record.updatedAtMs > STALE_MS || seen.has(record.runId)) continue;
    seen.add(record.runId);
    rows.push({ ticketId: record.ticketId, ticketName: record.ticketName, phase: record.phase,
      runId: record.runId, updatedAtMs: record.updatedAtMs, report: record.report });
  }
  return rows.sort((a, b) => a.ticketId.localeCompare(b.ticketId) || a.runId.localeCompare(b.runId));
}

export async function windowsProcessStarts(ids) {
  if (process.platform !== 'win32' || ids.length > MAX_FILES
    || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return new Map();
  // No shell interpolation of disk content: PowerShell receives only validated numeric PIDs.
  const script = '$ids=@(' + ids.join(',') + '); @($ids | ForEach-Object { try { $p=Get-Process -Id $_ -ErrorAction Stop; @{ pid=[int]$p.Id; startMs=[long]([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() } } catch {} }) | ConvertTo-Json -Compress';
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 6_000, maxBuffer: 32_768, windowsHide: true });
    const parsed = JSON.parse(stdout);
    return new Map((Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map(item => [item.pid, item.startMs]));
  } catch { return new Map(); }
}

export async function snapshot(root) {
  const now = Date.now();
  const records = (await readWindowRecords(root))
    .filter(item => item.updatedAtMs <= now + 2_000 && now - item.updatedAtMs <= STALE_MS)
    .slice(0, MAX_FILES);
  if (!records.length) return [];
  const starts = await windowsProcessStarts([...new Set(records.map(item => item.pid))]);
  return selectActive(records, starts, now);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--snapshot' || !path.isAbsolute(process.argv[3])) process.exitCode = 2;
  else console.log(JSON.stringify(await snapshot(process.argv[3])));
}
